import { z } from 'zod';
import { errorMessage, hashOf, mapLimit } from '../common/fp.js';
import type { PrismaService } from '../db/prisma.service.js';
import { isReaction } from '../domain/finding.js';
import {
  type AgentJoin,
  buildSnapshot,
  canJoin,
  computeGroups,
  firstStreamed,
  type GroupMember,
} from '../domain/grouping.js';
import { identifiersIn } from '../domain/identifiers.js';
import type { NaceTaxonomy } from '../domain/nace.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { ChatProvider } from '../llm/providers.js';
import { runAgent } from './agents/graph.js';
import { type AgentOptions, agentTools, compact, toolContext } from './agents/tools.js';
import {
  currentMembers,
  findingsMentioning,
  findingTimes,
  GROUPING_FAILED_PREFIX,
  latestGroupDecisions,
  latestSnapshotHashes,
  nearestFindings,
} from './repository.js';

/** Final answer of the grouping agent. */
const GroupingDecisionSchema = z.object({
  decision: z.enum(['join', 'separate']),
  targetGroupKey: z
    .string()
    .nullable()
    .describe(
      'Key of the candidate group to merge with (from the candidates or a tool result), null when separate',
    ),
  confidence: z
    .enum(['high', 'medium', 'low'])
    .describe('high only when an identifier or the official record proves it is the same procedure'),
  evidence: z
    .string()
    .describe('The decisive facts: shared identifiers, matching act titles, sources checked'),
  rationale: z.string().describe('One or two sentences: why this is (not) the same procedure'),
});

/** System prompt of the grouping agent: what "same procedure" means, how to check it, and examples. */
const GROUPING_SYSTEM = `You consolidate regulatory items into procedures for a regulatory radar used by chambers of commerce.
A procedure = one legislative or regulatory act through its life: initiative, consultation, proposal, votes, Council
positions, adoption, publication, corrigenda, plus every language version, channel copy and reaction to it.

SAME procedure (join):
- the same act in another language or channel (EUR-Lex in German and in English; a gazette entry and its TRIS notification);
- later steps of one file: a Commission proposal and the Parliament vote / Council position / adopted act of the same file;
- a call for evidence or consultation and the proposal it announced, when the identifiers or the official page link them;
- a corrigendum or correction of an act; feedback, statements and comments on an item.
NOT the same procedure (separate):
- different acts on a similar topic, even with near-identical wording ("steel recycling" in AT and in PL);
- an implementing or delegated act and its basic act (they are separate procedures);
- national transposition of an EU directive (different jurisdiction) - the code rejects cross-jurisdiction merges anyway;
- a study, briefing or press summary ABOUT an act is not a step of it unless it is the file's own document.

How to decide:
1. Read the item group and the pre-computed candidates (embedding neighbours with cosine distance and items sharing an
   identifier). Distances below ~0.15 suggest the same text in another language; 0.15-0.35 the same topic.
2. Compare identifiers, they decide: procedure numbers like 2026/9101(COD), CELEX (sector 5 = proposal, sector 3 = adopted
   act, same year and number = same act), COM/SWD numbers, Ares references, TRIS numbers like 2026/0412/AT, ELI URIs, gazette
   ids such as BOE-A-2026-123, national bill or draft numbers.
3. If identifiers are missing or differ in format, use the tools: search_findings (full text, exact word forms),
   nearest_findings (choose k), get_group, sql_query (read-only SQL), then web_search or fetch_url on the official page.
4. Answer "join" with confidence "high" only when an identifier or the official record proves it. Otherwise "separate":
   a wrong merge hides an item from the radar, a missed merge only shows it twice.

Examples:
- "Commission Implementing Regulation imposing a definitive anti-dumping duty ... steel" (EN) and "Durchführungsverordnung
  der Kommission zur Einführung eines endgültigen Antidumpingzolls ..." (DE), same CELEX: join (language versions).
- Parliament plenary vote "Protection of workers from carcinogens: nickel and cobalt" and the Council general approach
  on the same occupational exposure limits: join (steps of one file).
- An Austrian draft on scrap shipments and a Polish draft on steel scrap records: separate (different acts, jurisdictions).
- An EU study on energy prices and an EU state-aid consultation on indirect emission costs: separate (related topic only).`;

/** Inputs of the grouping stage. */
export type GroupingOptions = AgentOptions;

/** Latest agent join decisions of the engine. */
const agentJoins = async (db: PrismaService, engine: string): Promise<readonly AgentJoin[]> =>
  (
    await db.groupLink.findMany({
      where: { engine, decision: 'join', targetGroupKey: { not: null } },
      orderBy: { createdAt: 'asc' },
    })
  ).map((l) => ({ findingId: l.findingId, targetGroupKey: l.targetGroupKey ?? '' }));

/**
 * Stage 3b: procedure groups. Deterministic links (shared ref, related_to) always apply; when an agent
 * engine is configured, every group is reviewed by the LangGraph agent (again when new evidence arrives),
 * which may merge it with another group of the same jurisdiction (cross-language consolidation, later steps). Writes new snapshots only when a group's
 * content changed and tombstones for vanished keys. Returns the number of rows written.
 */
export const runGroupingStage = async (
  db: PrismaService,
  tax: NaceTaxonomy,
  chat: ChatProvider | null,
  opts: GroupingOptions,
): Promise<number> => {
  const members = await currentMembers(db);
  const decisions = chat ? await reviewGroups(db, tax, chat, members, opts) : 0;
  const joins = await agentJoins(db, opts.engine);
  const groups = computeGroups(members, joins);
  const byId = new Map(members.map((m) => [m.id, m]));
  const joined = new Set(joins.map((j) => j.findingId));
  const previous = await latestSnapshotHashes(db);
  const snapshots = [...groups].map(([key, ids]) => {
    const content = buildSnapshot(
      key,
      ids.flatMap((id) => byId.get(id) ?? []),
      joined,
    );
    return { content, hash: hashOf(content) };
  });
  const changed = snapshots.filter(
    (s) => previous.get(s.content.groupKey)?.hash !== s.hash || previous.get(s.content.groupKey)?.retired,
  );
  const retired = [...previous].filter(([key, p]) => !p.retired && !groups.has(key));
  const json = (v: unknown) => v as Prisma.InputJsonValue;
  await db.groupSnapshot.createMany({
    data: [
      ...changed.map(({ content: c, hash }) => ({
        groupKey: c.groupKey,
        contentHash: hash,
        engine: opts.engine,
        title: c.title,
        titleOriginal: c.titleOriginal,
        language: c.language,
        jurisdiction: c.jurisdiction,
        level: c.level,
        stage: c.stage,
        memberIds: [...c.memberIds],
        naceTags: [...c.naceTags],
        actionPoints: json(c.actionPoints),
        sourceTrail: json(c.sourceTrail),
        latestPublished: new Date(c.latestPublished),
      })),
      ...retired.map(([groupKey]) => ({
        groupKey,
        contentHash: 'retired',
        retired: true,
        engine: opts.engine,
        title: '',
        language: '',
        jurisdiction: '',
        level: '',
        stage: 'unknown',
        memberIds: [],
        naceTags: [],
        actionPoints: json([]),
        sourceTrail: json([]),
        latestPublished: new Date(0),
      })),
    ],
  });
  return decisions + changed.length + retired.length;
};

/**
 * Why an agent's join must not be applied (null = apply it): unknown target, the group itself, confidence
 * below high, or different jurisdictions. Pure; enforced whatever the model answers.
 */
export const joinRejection = (
  answer: Pick<z.infer<typeof GroupingDecisionSchema>, 'decision' | 'targetGroupKey' | 'confidence'>,
  item: { readonly key: string; readonly members: readonly GroupMember[] },
  target: readonly string[] | null,
  byId: ReadonlyMap<string, Pick<GroupMember, 'jurisdiction'>>,
): string | null =>
  answer.decision !== 'join'
    ? null
    : !target || answer.targetGroupKey === item.key
      ? 'unknown target group'
      : answer.confidence !== 'high'
        ? `confidence ${answer.confidence}`
        : !canJoin(
              item.members,
              target.flatMap((id) => byId.get(id) ?? []),
            )
          ? 'different jurisdictions'
          : null;

/** A group the agent should review, with its representative (first-streamed) member. */
interface ReviewItem {
  /** Group key. */
  readonly key: string;
  /** Members of the group. */
  readonly members: readonly GroupMember[];
  /** Representative member; the decision is stored for it. */
  readonly rep: GroupMember;
}

/**
 * Groups to (re)review: never decided ones first, then "separate" decisions for which new evidence
 * arrived afterwards (a newer member, or a newer item among the 5 nearest neighbours), and failed runs
 * whose retry is due (backoff, at most 3 failed runs). A group given up on gets one more run per new
 * evidence, like a "separate" decision. Joins are final.
 */
const reviewQueue = async (
  db: PrismaService,
  groups: ReadonlyMap<string, readonly string[]>,
  byId: ReadonlyMap<string, GroupMember>,
  opts: GroupingOptions,
): Promise<readonly ReviewItem[]> => {
  const [decisions, times, embedded] = await Promise.all([
    latestGroupDecisions(db, opts.engine, opts.retryAfterSeconds),
    findingTimes(db),
    db.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT finding_id AS id FROM embedding WHERE engine = ${opts.embeddingEngine} AND vector IS NOT NULL`,
  ]);
  const hasVector = new Set(embedded.map((r) => r.id));
  const newest = Math.max(0, ...[...times.values()].map((t) => t.getTime()));
  const items = [...groups].flatMap(([key, ids]): ReviewItem[] => {
    const members = ids.flatMap((id) => byId.get(id) ?? []);
    const rep = firstStreamed(members);
    return rep && hasVector.has(rep.id) && !(members.length === 1 && isReaction(rep))
      ? [{ key, members, rep }]
      : [];
  });
  const fresh = items.filter((i) => !decisions.has(i.rep.id));
  const stale = items.filter((i) => {
    const d = decisions.get(i.rep.id);
    if (d?.decision !== 'separate') return false;
    // A failed run waits for its retry; once given up, it is treated like "separate": new evidence only.
    return d.failed && !d.gaveUp ? d.retryDue : d.decidedAt.getTime() < newest;
  });
  const newEvidence = await mapLimit(stale.slice(0, opts.batchSize * 4), opts.concurrency, async (i) => {
    const d = decisions.get(i.rep.id);
    if (!d) return false;
    if (d.failed && !d.gaveUp) return true;
    const near = await nearestFindings(db, i.rep.id, opts.embeddingEngine, opts.embeddingDimensions, 5);
    return [...i.members.map((m) => m.id), ...near.map((n) => n.id)].some(
      (id) => (times.get(id)?.getTime() ?? 0) > d.decidedAt.getTime(),
    );
  });
  return [...fresh, ...stale.filter((_, n) => newEvidence[n])].slice(0, opts.batchSize);
};

/** Pre-computed candidate groups for one group: embedding neighbours and identifier matches, same jurisdiction only. */
const candidatesFor = async (
  db: PrismaService,
  item: ReviewItem,
  keyOf: ReadonlyMap<string, string>,
  groups: ReadonlyMap<string, readonly string[]>,
  byId: ReadonlyMap<string, GroupMember>,
  view: (m: GroupMember) => unknown,
  opts: GroupingOptions,
) => {
  const ids = item.members.map((m) => m.id);
  const identifiers = identifiersIn(item.members.flatMap((m) => [m.title, m.titleEn, m.summary, m.ref]));
  const [near, mentioning] = await Promise.all([
    nearestFindings(db, item.rep.id, opts.embeddingEngine, opts.embeddingDimensions, 8),
    findingsMentioning(
      db,
      identifiers.map((i) => i.value),
      ids,
      10,
    ),
  ]);
  const evidence = [
    ...near.map((n) => ({ id: n.id, why: `embedding distance ${Math.round(n.distance * 1000) / 1000}` })),
    ...mentioning.map((id) => ({ id, why: 'shares an identifier' })),
  ];
  const byGroup = Map.groupBy(
    evidence.filter((e) => !ids.includes(e.id) && keyOf.has(e.id)),
    (e) => keyOf.get(e.id) ?? '',
  );
  return {
    identifiers,
    candidates: [...byGroup].flatMap(([key, why]) => {
      const members = (groups.get(key) ?? []).flatMap((id) => byId.get(id) ?? []);
      return canJoin(item.members, members)
        ? [{ groupKey: key, evidence: [...new Set(why.map((w) => w.why))], members: members.map(view) }]
        : [];
    }),
  };
};

/** Lets the agent decide for each queued group whether it is the same procedure as another group. */
const reviewGroups = async (
  db: PrismaService,
  tax: NaceTaxonomy,
  chat: ChatProvider,
  members: readonly GroupMember[],
  opts: GroupingOptions,
): Promise<number> => {
  const groups = computeGroups(members, await agentJoins(db, opts.engine));
  const keyOf = new Map([...groups].flatMap(([key, ids]) => ids.map((id) => [id, key] as const)));
  const byId = new Map(members.map((m) => [m.id, m]));
  const queue = await reviewQueue(db, groups, byId, opts);
  const context = toolContext(
    db,
    tax,
    opts,
    chat,
    (id) => keyOf.get(id),
    (key) => groups.get(key) ?? [],
  );
  const tools = agentTools(context);
  const view = compact(context);
  const results = await mapLimit(queue, opts.concurrency, async (item) => {
    const base = { findingId: item.rep.id, engine: opts.engine };
    try {
      const { identifiers, candidates } = await candidatesFor(db, item, keyOf, groups, byId, view, opts);
      const { answer, trace } = await runAgent({
        chat: chat.chat,
        tools,
        system: GROUPING_SYSTEM,
        task: `Is procedure group ${item.key} the same procedure as an existing procedure group?
Group ${item.key} (jurisdiction ${item.rep.jurisdiction}): ${JSON.stringify(item.members.map(view))}
Identifiers found in it: ${JSON.stringify(identifiers)}
Pre-computed candidate groups (same jurisdiction only): ${JSON.stringify(candidates)}`,
        schema: GroupingDecisionSchema,
        maxSteps: opts.maxSteps,
      });
      const rejection = joinRejection(
        answer,
        item,
        answer.targetGroupKey ? (groups.get(answer.targetGroupKey) ?? null) : null,
        byId,
      );
      const joined = answer.decision === 'join' && rejection === null;
      return {
        ...base,
        decision: joined ? 'join' : 'separate',
        targetGroupKey: joined ? answer.targetGroupKey : null,
        rationale: [
          rejection ? `Join to ${answer.targetGroupKey} rejected (${rejection}).` : '',
          answer.rationale,
          `Evidence: ${answer.evidence}`,
        ]
          .filter(Boolean)
          .join(' ')
          .slice(0, 2000),
        trace: trace as unknown as Prisma.InputJsonValue,
        failed: false,
      };
    } catch (e) {
      return {
        ...base,
        decision: 'separate',
        targetGroupKey: null,
        rationale: `${GROUPING_FAILED_PREFIX}${errorMessage(e)}`.slice(0, 1000),
        failed: true,
      };
    }
  });
  await db.groupLink.createMany({ data: results.map(({ failed: _, ...row }) => row) });
  return results.filter((r) => !r.failed).length;
};
