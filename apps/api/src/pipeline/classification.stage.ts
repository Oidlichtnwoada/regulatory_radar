import { z } from 'zod';
import { errorMessage, foldText, mapLimit } from '../common/fp.js';
import type { PrismaService } from '../db/prisma.service.js';
import {
  type ClassificationResult,
  classifyDeterministic,
  expandLabels,
  keepTracked,
  ruleMatches,
  type SectorLabel,
  safetyNet,
  statedLabels,
} from '../domain/classifier.js';
import { EU_COUNTRY_CODES } from '../domain/countries.js';
import { firstStreamed } from '../domain/grouping.js';
import { HORIZONTAL, type NaceTaxonomy } from '../domain/nace.js';
import { mapRev2Code } from '../domain/nace-rev2.js';
import type { ChatProvider } from '../llm/providers.js';
import { runAgent } from './agents/graph.js';
import { type AgentOptions, agentTools, compact, toolContext } from './agents/tools.js';
import {
  CLASSIFICATION_FAILED_PREFIX,
  classifiedGroupsContaining,
  insertClassification,
  membersByIds,
  nearestFindings,
  type PendingSnapshot,
  pendingClassifications,
  previousLabels,
} from './repository.js';

/** Final answer of the classification agent. */
const ClassificationSchema = z.object({
  whyRelevant: z
    .string()
    .describe('One or two sentences for a policy officer: who is affected, what to do, and by when'),
  labels: z
    .array(
      z.object({
        naceCode: z
          .string()
          .describe('NACE Rev. 2.1 code at any level (C, C24, C24.4, C24.42) or * for every sector'),
        naceTitle: z
          .string()
          .describe('The official Rev. 2.1 title of that code (as returned by search_nace / nace_notes)'),
        verdict: z.enum(['relevant', 'borderline', 'not_relevant']),
        countries: z
          .array(z.string())
          .nullable()
          .describe('Subset of EU member states if only some are affected, null = every country in scope'),
        rationale: z
          .string()
          .describe('Short reason for this sector: which obligation, cost, deadline or aid'),
      }),
    )
    .max(40),
});

/** One label of the agent's answer. */
type AgentLabel = z.infer<typeof ClassificationSchema>['labels'][number];

/** System prompt of the classification agent. */
const CLASSIFICATION_SYSTEM = `You label EU and national regulatory procedures for a regulatory radar used by chambers of commerce.
For the procedure group, decide which economic sectors (NACE Rev. 2.1, NOT Rev. 2) it concerns:
- relevant: companies of that sector must act or are directly affected: obligations, costs, bans, deadlines, reporting,
  aid or funding they can claim, or a consultation/vote on rules that will do so;
- borderline: indirectly affected, affected only above a size threshold that most firms of the sector do not reach,
  only in special cases, or the item is information only (study, briefing, report): information is at most borderline;
- not_relevant: write it only for a sector that an obvious keyword would wrongly suggest (keyword trap), with the reason.
Sectors you do not list count as not relevant.

How to work:
1. Read the group, its action points, the sector hints of the deterministic keyword rules (may be wrong or incomplete),
   the stated tags of the channels (always kept) and how similar procedures were labelled (precedents).
2. Follow the value chain: who carries the obligation or cost - producers, processors, importers, wholesalers,
   retailers, users, service providers? Label each affected link (e.g. a carbon border levy on steel imports hits
   importers and downstream metal users, not only steel producers; packaging rules hit packers and retailers).
3. Find codes with search_nace (any wording: products, activities, business types) and confirm each code with
   nace_notes (includes / excludes). Use the most specific codes that fit, several when needed, and * only for rules
   that hit every business (payment terms, invoicing, company reporting, general taxes). Give each code with its
   exact Rev. 2.1 title. Models often remember NACE Rev. 2 codes: Rev. 2.1 renumbered sections J-N (e.g. finance is
   L64-L66, real estate M68), so always check.
4. Use get_group, nearest_findings, search_findings, sql_query, web_search or fetch_url when the text is too short.
5. Rules about public administration, courts, schools or culture are not relevant to businesses unless they create
   obligations for them. A missed relevant sector costs more than a borderline one. Jurisdiction is handled outside:
   give countries only when just some EU member states are affected.

"why relevant": one or two plain sentences: who is affected, what changes, and the next deadline or vote if any.

Examples:
- "Carbon border adjustment: extension of scope to downstream steel and aluminium products" (consultation): relevant
  C24 Manufacture of basic metals and C25 Manufacture of fabricated metal products (importers and users of these
  products), borderline G46 Wholesale trade (importing traders).
- "Late payments in commercial transactions: maximum payment terms of 60 days": relevant * (every business).
- "Retail investment: a shorter key information document for retail investors": relevant L64/L66 finance; not_relevant
  G47 Retail trade (keyword trap: "retail" means private investors).
- "Energy prices for energy-intensive industries: state of play" (study): borderline C24 and other energy-intensive
  manufacturing - information only.`;

/** Folded words of a title (for comparing a model's title with the official one). */
const titleWords = (t: string) =>
  new Set(
    foldText(t)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );

/**
 * Problems of the agent's labels that are sent back for correction: codes that do not exist in NACE Rev. 2.1
 * (with the Rev. 2 -> 2.1 remapping as a hint) and codes whose given title does not match the official one.
 * Pure.
 */
export const naceLabelProblems = (
  tax: NaceTaxonomy,
  labels: readonly Pick<AgentLabel, 'naceCode' | 'naceTitle'>[],
) =>
  labels.flatMap((l): string[] => {
    const code = l.naceCode.trim().toUpperCase();
    if (code === HORIZONTAL) return [];
    const node = tax.byCode.get(code);
    if (!node) {
      const mapped = mapRev2Code(tax, code)?.codes ?? [];
      const hint = mapped.length
        ? ` As a Rev. 2 code it corresponds to ${mapped.map((c) => `${c} "${tax.byCode.get(c)?.title}"`).join(', ')}.`
        : '';
      return [
        `${code} is not a NACE Rev. 2.1 code (perhaps Rev. 2).${hint} Check with search_nace / nace_notes.`,
      ];
    }
    const given = titleWords(l.naceTitle);
    const official = titleWords(node.title);
    const overlap = [...given].filter((w) => official.has(w)).length;
    return given.size > 0 && overlap / given.size >= 0.5
      ? []
      : [`${code} is "${node.title}", not "${l.naceTitle}". Use the code that matches the sector you mean.`];
  });

/** Options of the classification stage. */
export type ClassificationOptions = AgentOptions;

/** Keeps only valid agent labels (known codes, EU countries). */
const validLabels = (
  tax: NaceTaxonomy,
  labels: z.infer<typeof ClassificationSchema>['labels'],
): readonly SectorLabel[] =>
  labels
    .map((l) => ({ ...l, naceCode: l.naceCode.trim().toUpperCase() }))
    .filter((l) => l.naceCode === HORIZONTAL || tax.byCode.has(l.naceCode))
    .map((l) => ({
      naceCode: l.naceCode,
      verdict: l.verdict,
      score: null,
      rationale: l.rationale,
      ...(l.countries?.length ? { countries: l.countries.filter((c) => EU_COUNTRY_CODES.has(c)) } : {}),
    }));

/**
 * Stage 4: relevance per (country x NACE) with a "why relevant". Online, the LangGraph agent labels the
 * group; stated NACE tags of the channels always count as relevant. Offline, the deterministic rules
 * are used. In both cases a pair that was relevant before stays tracked. When the agent fails, the
 * deterministic result is stored meanwhile and the agent is retried with backoff. Returns the number of
 * classifications written, failed agent runs not counted.
 */
export const runClassificationStage = async (
  db: PrismaService,
  tax: NaceTaxonomy,
  chat: ChatProvider | null,
  opts: ClassificationOptions,
): Promise<number> => {
  const pending = await pendingClassifications(db, opts.engine, {
    limit: opts.batchSize,
    retryAfterSeconds: opts.retryAfterSeconds,
  });
  const results = await mapLimit(pending, chat ? opts.concurrency : 1, async (s) => {
    const members = await membersByIds(db, s.member_ids);
    const input = { jurisdiction: s.jurisdiction, members };
    const fallback = (note: string) => {
      const d = classifyDeterministic(tax, input);
      return { result: { ...d, whyRelevant: `${note}${d.whyRelevant}` }, trace: [] as unknown };
    };
    const { result, trace, failed } = chat
      ? await classifyWithAgent(db, tax, chat, opts, s, members).then(
          (r) => ({ ...r, failed: false }),
          (e: unknown) => ({
            ...fallback(`${CLASSIFICATION_FAILED_PREFIX}${errorMessage(e).slice(0, 200)}); fallback: `),
            failed: true,
          }),
        )
      : { ...fallback(''), failed: false };
    const labels = keepTracked(await previousLabels(db, s.member_ids), result.labels);
    await insertClassification(db, {
      snapshotId: s.id,
      groupKey: s.group_key,
      engine: opts.engine,
      whyRelevant: result.whyRelevant,
      trace,
      labels,
    });
    return !failed;
  });
  return results.filter(Boolean).length;
};

/** The 5 most similar already-classified groups (by the embedding neighbours of the group's first member). */
const precedentsFor = async (
  db: PrismaService,
  opts: ClassificationOptions,
  s: PendingSnapshot,
  members: Awaited<ReturnType<typeof membersByIds>>,
) => {
  const rep = firstStreamed(members);
  if (!rep || !opts.embeddingDimensions) return [];
  const near = await nearestFindings(db, rep.id, opts.embeddingEngine, opts.embeddingDimensions, 15);
  const distance = new Map(near.map((n) => [n.id, n.distance]));
  const groups = await classifiedGroupsContaining(
    db,
    near.map((n) => n.id),
    s.group_key,
  );
  const closest = (ids: readonly string[]) => Math.min(...ids.map((id) => distance.get(id) ?? 2));
  return groups
    .toSorted((a, b) => closest(a.member_ids) - closest(b.member_ids))
    .slice(0, 5)
    .map((g) => ({
      groupKey: g.group_key,
      title: g.title,
      distance: Math.round(closest(g.member_ids) * 1000) / 1000,
      whyRelevant: g.why_relevant,
      labels: g.labels,
    }));
};

/** Runs the classification agent for one snapshot. */
const classifyWithAgent = async (
  db: PrismaService,
  tax: NaceTaxonomy,
  chat: ChatProvider,
  opts: ClassificationOptions,
  s: PendingSnapshot,
  members: Awaited<ReturnType<typeof membersByIds>>,
): Promise<{ result: ClassificationResult; trace: unknown }> => {
  const ctx = toolContext(
    db,
    tax,
    opts,
    chat,
    (id) => (s.member_ids.includes(id) ? s.group_key : undefined),
    (key) => (key === s.group_key ? s.member_ids : []),
  );
  const view = compact(ctx);
  const rules = ruleMatches({ jurisdiction: s.jurisdiction, members }).conceptLabels;
  const precedents = await precedentsFor(db, opts, s, members);
  const { answer, trace } = await runAgent({
    chat: chat.chat,
    tools: agentTools(ctx),
    system: CLASSIFICATION_SYSTEM,
    task: `Classify procedure group ${s.group_key} (jurisdiction ${s.jurisdiction}).
Members: ${JSON.stringify(members.map(view))}
Action points: ${JSON.stringify(members.flatMap((m) => m.actionPoints))}
Stated NACE tags of the channels (always kept): ${JSON.stringify(
      [...new Set(members.flatMap((m) => m.naceTags))].map((c) => ({
        code: c,
        title: tax.byCode.get(c)?.title,
      })),
    )}
Hints of the deterministic keyword rules: ${JSON.stringify(rules.map(({ naceCode, verdict, rationale }) => ({ naceCode, verdict, rationale })))}
Precedents (similar procedures already labelled): ${JSON.stringify(precedents)}`,
    schema: ClassificationSchema,
    maxSteps: opts.maxSteps,
    validate: (a) => naceLabelProblems(tax, a.labels),
  });
  const agentLabels = validLabels(tax, answer.labels);
  const labels = expandLabels(s.jurisdiction, [
    ...statedLabels(tax, members),
    ...agentLabels,
    ...safetyNet(agentLabels, rules),
  ]);
  return { result: { whyRelevant: answer.whyRelevant, labels }, trace };
};
