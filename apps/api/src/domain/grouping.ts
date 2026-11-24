import { compareBy, uniqBy } from '../common/fp.js';
import { type ActionPoint, type FindingDraft, isReaction, levelOf, type Stage } from './finding.js';

/** A current finding as seen by grouping and snapshotting (common schema plus ids and translation). */
export interface GroupMember extends FindingDraft {
  /** Finding id. */
  readonly id: string;
  /** Source id. */
  readonly sourceId: string;
  /** Item id in the source. */
  readonly externalId: string;
  /** Normalised procedure reference. */
  readonly refKey: string | null;
  /** Derived action points. */
  readonly actionPoints: readonly ActionPoint[];
  /** English title, if translated. */
  readonly titleEn: string | null;
  /** English summary, if translated. */
  readonly summaryEn: string | null;
  /** Position in the global ingestion stream when the item was first streamed (file order for the seed). */
  readonly streamSeq: number;
}

/** An agent decision that a finding belongs to an existing group. */
export interface AgentJoin {
  /** The finding that joins. */
  readonly findingId: string;
  /** The group it joins. */
  readonly targetGroupKey: string;
}

/** Union-find node of an item (internal; group keys are item ids, see computeGroups). */
const itemKey = (m: Pick<GroupMember, 'sourceId' | 'externalId'>): string =>
  `item:${m.sourceId}:${m.externalId}`;
/** Union-find node of a procedure reference (internal). */
const refNode = (ref: string): string => `ref:${ref}`;

/** The member that was streamed first (ties: source, then item id). */
export const firstStreamed = <M extends Pick<GroupMember, 'streamSeq' | 'sourceId' | 'externalId'>>(
  ms: readonly M[],
): M | undefined =>
  ms.toSorted(
    compareBy(
      (m) => m.streamSeq,
      (m) => m.sourceId,
      (m) => m.externalId,
    ),
  )[0];

/**
 * Deterministic procedure grouping: findings sharing a reference, reactions (related_to) and agent
 * joins are merged with union-find. A group is named after its member that was streamed first (the same
 * convention as data/eval/labels.json); later steps and reactions arrive later, so names stay stable while
 * groups grow. Should two sources use the same item id, the colliding names get a `source:` prefix.
 * Agent joins name their target by group key. Returns group key -> member ids (sorted).
 */
export const computeGroups = (
  members: readonly GroupMember[],
  joins: readonly AgentJoin[] = [],
): ReadonlyMap<string, readonly string[]> => {
  // Union-find needs a local mutable parent map; it never escapes this function.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const [ra, rb] = [find(a), find(b)].sort();
    if (ra !== undefined && rb !== undefined && ra !== rb) parent.set(rb, ra);
  };
  const nodeOf = new Map(members.map((m) => [m.id, itemKey(m)]));
  const byExternal = Map.groupBy(members, (m) => m.externalId);
  // A group key names an item: the plain item id, or source:id after a collision.
  const nodeOfKey = new Map(
    members.flatMap((m) => [
      [m.externalId, itemKey(m)],
      [`${m.sourceId}:${m.externalId}`, itemKey(m)],
    ]),
  );

  members.forEach((m) => {
    const node = itemKey(m);
    if (m.refKey) union(refNode(m.refKey), node);
    const target =
      m.relatedTo &&
      (byExternal.get(m.relatedTo)?.find((t) => t.sourceId === m.sourceId) ??
        byExternal.get(m.relatedTo)?.[0]);
    if (target) union(itemKey(target), node);
  });
  joins.forEach((j) => {
    const node = nodeOf.get(j.findingId);
    const target = nodeOfKey.get(j.targetGroupKey);
    if (node && target) union(target, node);
  });

  const components = [...Map.groupBy(members, (m) => find(itemKey(m))).values()];
  const firsts = components.map((ms) => firstStreamed(ms) as GroupMember);
  const taken = Map.groupBy(firsts, (m) => m.externalId);
  const keyOf = (m: GroupMember): string =>
    (taken.get(m.externalId)?.length ?? 0) > 1 ? `${m.sourceId}:${m.externalId}` : m.externalId;
  return new Map(
    components
      .map((ms, i) => [keyOf(firsts[i] as GroupMember), ms.map((m) => m.id).sort()] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
};

/**
 * Guard for agent joins: two groups may only merge when all their members share one jurisdiction
 * (an EU act with its EU-level steps; a national draft with its national steps, also when one of them came
 * via TRIS). Enforced in code, whatever the model answers. Pure.
 */
export const canJoin = (
  a: readonly Pick<GroupMember, 'jurisdiction'>[],
  b: readonly Pick<GroupMember, 'jurisdiction'>[],
): boolean => new Set([...a, ...b].map((m) => m.jurisdiction)).size === 1;

/** Role of a member inside its group, shown in the source trail. */
export type TrailRole =
  | 'primary'
  | 'later_step'
  | 'language_version'
  | 'duplicate'
  | 'reaction'
  | 'merged_by_agent';

/** One entry of a group's source trail. */
export interface TrailEntry {
  /** Finding id. */
  readonly findingId: string;
  /** Source id. */
  readonly sourceId: string;
  /** Channel. */
  readonly channel: string;
  /** Item id in the source. */
  readonly externalId: string;
  /** Role in the group. */
  readonly role: TrailRole;
  /** Original title. */
  readonly title: string;
  /** English title, if any. */
  readonly titleEn: string | null;
  /** Language of the original. */
  readonly language: string;
  /** Document type. */
  readonly docType: string;
  /** Stage. */
  readonly stage: Stage;
  /** Publication date. */
  readonly publishedOn: string;
  /** Link. */
  readonly url: string | null;
}

/** Content of a procedure group snapshot (hashed to detect changes). */
export interface SnapshotContent {
  /** Group key. */
  readonly groupKey: string;
  /** English title if available, else the original. */
  readonly title: string;
  /** Original title when it is not English. */
  readonly titleOriginal: string | null;
  /** Language of the primary member. */
  readonly language: string;
  /** Jurisdiction of the primary member. */
  readonly jurisdiction: string;
  /** eu or national. */
  readonly level: 'eu' | 'national';
  /** Most advanced stage of the procedure. */
  readonly stage: Stage;
  /** Member finding ids (sorted). */
  readonly memberIds: readonly string[];
  /** Union of stated NACE tags. */
  readonly naceTags: readonly string[];
  /** Union of action points (sorted). */
  readonly actionPoints: readonly ActionPoint[];
  /** Source trail ordered by publication. */
  readonly sourceTrail: readonly TrailEntry[];
  /** Latest publication date of a member. */
  readonly latestPublished: string;
}

/** Order of stages from least to most advanced. */
const STAGE_ORDER: readonly Stage[] = [
  'unknown',
  'information',
  'proposal',
  'consultation_open',
  'standstill',
  'in_procedure',
  'adopted',
];

/** Picks the primary member: latest non-reaction, English first on ties, then by external id. */
export const primaryOf = (members: readonly GroupMember[]): GroupMember | undefined =>
  [...members.filter((m) => !isReaction(m)), ...members.filter(isReaction)].sort(
    compareBy(
      (m) => (isReaction(m) ? 1 : 0),
      (m) => -Date.parse(m.publishedOn),
      (m) => (m.language === 'en' ? 0 : 1),
      (m) => m.externalId,
    ),
  )[0];

/** Role of a member relative to the primary. */
const roleOf = (m: GroupMember, primary: GroupMember, agentJoined: ReadonlySet<string>): TrailRole =>
  m.id === primary.id
    ? 'primary'
    : isReaction(m)
      ? 'reaction'
      : agentJoined.has(m.id)
        ? 'merged_by_agent'
        : m.docType === primary.docType && m.stage === primary.stage
          ? m.language === primary.language
            ? 'duplicate'
            : 'language_version'
          : 'later_step';

/** Builds the snapshot content of one group from its members; pure and order-independent. */
export const buildSnapshot = (
  groupKey: string,
  members: readonly GroupMember[],
  agentJoined: ReadonlySet<string> = new Set(),
): SnapshotContent => {
  const primary = primaryOf(members);
  if (!primary) throw new Error(`group ${groupKey} has no members`);
  const steps = members.filter((m) => !isReaction(m));
  const stage = (steps.length ? steps : members)
    .map((m) => m.stage)
    .reduce((a, b) => (STAGE_ORDER.indexOf(b) > STAGE_ORDER.indexOf(a) ? b : a), 'unknown' as Stage);
  return {
    groupKey,
    title: primary.titleEn ?? primary.title,
    titleOriginal: primary.language === 'en' ? null : primary.title,
    language: primary.language,
    jurisdiction: primary.jurisdiction,
    level: levelOf(primary.jurisdiction),
    stage,
    memberIds: members.map((m) => m.id).sort(),
    naceTags: [...new Set(members.flatMap((m) => m.naceTags))].sort(),
    actionPoints: uniqBy(
      members.flatMap((m) => m.actionPoints),
      (p) => `${p.kind}:${p.date}`,
    ).toSorted(
      compareBy(
        (p) => p.date,
        (p) => p.kind,
      ),
    ),
    sourceTrail: members
      .map(
        (m): TrailEntry => ({
          findingId: m.id,
          sourceId: m.sourceId,
          channel: m.channel,
          externalId: m.externalId,
          role: roleOf(m, primary, agentJoined),
          title: m.title,
          titleEn: m.titleEn,
          language: m.language,
          docType: m.docType,
          stage: m.stage,
          publishedOn: m.publishedOn,
          url: m.url,
        }),
      )
      .sort(
        compareBy(
          (t) => t.publishedOn,
          (t) => t.externalId,
        ),
      ),
    latestPublished:
      members
        .map((m) => m.publishedOn)
        .sort()
        .at(-1) ?? primary.publishedOn,
  };
};
