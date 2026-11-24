import { isoDay } from '../common/fp.js';
import type { PrismaService } from '../db/prisma.service.js';
import type { CountryLabel } from '../domain/classifier.js';
import type { ActionPoint, Stage } from '../domain/finding.js';
import type { GroupMember } from '../domain/grouping.js';
import { nacePath } from '../domain/nace.js';
import { Prisma } from '../generated/prisma/client.js';

/** Row shape of current findings joined with their best translation. */
type MemberRow = {
  readonly id: string;
  readonly source_id: string;
  readonly external_id: string;
  readonly channel: string;
  readonly jurisdiction: string;
  readonly language: string;
  readonly doc_type: string;
  readonly stage: string;
  readonly title: string;
  readonly summary: string | null;
  readonly published_on: Date;
  readonly deadline: Date | null;
  readonly deadline_kind: string | null;
  readonly event_date: Date | null;
  readonly ref: string | null;
  readonly ref_key: string | null;
  readonly related_to: string | null;
  readonly nace_tags_stated: boolean;
  readonly nace_tags: string[];
  readonly topics: string[];
  readonly url: string | null;
  readonly action_points: ActionPoint[];
  readonly attributes: Record<string, never>;
  readonly title_en: string | null;
  readonly summary_en: string | null;
  readonly stream_seq: bigint;
};

/** A stored raw record that has no finding yet. */
export interface UnnormalisedRecord {
  /** Raw record id. */
  readonly id: string;
  /** Item id inside the source. */
  readonly externalId: string;
  /** Payload as stored. */
  readonly payload: Prisma.JsonValue;
}

/**
 * Raw records of a source that were rejected by the normaliser and are still the latest version of their item
 * (an older version must never become current again by being normalised late), in stream order.
 */
export const unnormalisedRecords = (db: PrismaService, sourceId: string): Promise<UnnormalisedRecord[]> =>
  db.$queryRaw<UnnormalisedRecord[]>`
    SELECT r.id, r.external_id AS "externalId", r.payload FROM raw_record r
    WHERE r.source_id = ${sourceId}
      AND NOT EXISTS (SELECT 1 FROM finding f WHERE f.raw_record_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM raw_record n
                      WHERE n.source_id = r.source_id AND n.external_id = r.external_id AND n.stream_seq > r.stream_seq)
    ORDER BY r.stream_seq`;

/** SQL fragment: current findings with the latest usable English text (any engine). */
const membersSql = (where: Prisma.Sql) => Prisma.sql`
  SELECT f.*, t.title_en, t.summary_en,
         (SELECT min(r.stream_seq) FROM raw_record r
          WHERE r.source_id = f.source_id AND r.external_id = f.external_id) AS stream_seq
  FROM finding_current fc JOIN finding f ON f.id = fc.id
  LEFT JOIN LATERAL (
    SELECT title_en, summary_en FROM translation
    WHERE finding_id = f.id AND status IN ('identity', 'translated')
    ORDER BY created_at DESC LIMIT 1) t ON true
  ${where}
  ORDER BY stream_seq, f.source_id, f.external_id`;

/** Maps a row onto the domain member. */
const toMember = (r: MemberRow): GroupMember => ({
  id: r.id,
  sourceId: r.source_id,
  externalId: r.external_id,
  streamSeq: Number(r.stream_seq),
  channel: r.channel,
  jurisdiction: r.jurisdiction,
  language: r.language,
  docType: r.doc_type,
  stage: r.stage as Stage,
  title: r.title,
  summary: r.summary,
  publishedOn: isoDay(r.published_on),
  deadline: r.deadline ? isoDay(r.deadline) : null,
  deadlineKind: r.deadline_kind,
  eventDate: r.event_date ? isoDay(r.event_date) : null,
  ref: r.ref,
  refKey: r.ref_key,
  relatedTo: r.related_to,
  naceTagsStated: r.nace_tags_stated,
  naceTags: r.nace_tags,
  topics: r.topics,
  url: r.url,
  actionPoints: r.action_points,
  attributes: r.attributes,
  titleEn: r.title_en,
  summaryEn: r.summary_en,
});

/** All current findings as group members. */
export const currentMembers = async (db: PrismaService): Promise<readonly GroupMember[]> =>
  (await db.$queryRaw<MemberRow[]>(membersSql(Prisma.empty))).map(toMember);

/** Current findings with the given ids. */
export const membersByIds = async (
  db: PrismaService,
  ids: readonly string[],
): Promise<readonly GroupMember[]> =>
  ids.length === 0
    ? []
    : (await db.$queryRaw<MemberRow[]>(membersSql(Prisma.sql`WHERE f.id = ANY(${[...ids]}::uuid[])`))).map(
        toMember,
      );

/** Failed attempts of one engine on one item after which a stage gives up on it. */
export const MAX_ATTEMPTS = 3;

/**
 * SQL condition: an item with `failures` failed attempts, the last at `lastFailure`, may be tried (again).
 * The wait after the n-th failure is retryAfterSeconds x 4^(n-1), so a provider outage does not use up
 * the attempts within a few cycles. Evaluated in the database, so only its clock counts.
 */
const retryDue = (failures: Prisma.Sql, lastFailure: Prisma.Sql, retryAfterSeconds: number): Prisma.Sql =>
  Prisma.sql`(${failures} = 0 OR (${failures} < ${MAX_ATTEMPTS}
    AND ${lastFailure} <= now() - make_interval(secs => ${retryAfterSeconds}::float8 * power(4, ${failures} - 1))))`;

/** Which findings a stage picks up. */
export interface PendingOptions {
  /** Maximum number of findings. */
  readonly limit: number;
  /** Wait before the first retry; every further retry waits four times longer. */
  readonly retryAfterSeconds: number;
  /** Translation engine to wait for (embedding only): it must have a result or have given up. */
  readonly afterTranslation?: string;
}

/**
 * Current findings without a finished result of `engine` in a stage table (translation or embedding).
 * Failed findings are retried with backoff (see retryDue) and given up after MAX_ATTEMPTS failures.
 */
export const pendingFor = async (
  db: PrismaService,
  table: 'translation' | 'embedding',
  engine: string,
  opts: PendingOptions,
): Promise<readonly GroupMember[]> => {
  const t = Prisma.raw(table);
  const tr = opts.afterTranslation;
  const translated =
    tr === undefined
      ? Prisma.sql`true`
      : Prisma.sql`(EXISTS (SELECT 1 FROM translation x WHERE x.finding_id = fc.id AND x.engine = ${tr} AND x.status <> 'failed')
           OR (SELECT count(*) FROM translation x WHERE x.finding_id = fc.id AND x.engine = ${tr} AND x.status = 'failed') >= ${MAX_ATTEMPTS})`;
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT fc.id FROM finding_current fc
    CROSS JOIN LATERAL (SELECT count(*) AS failures, max(x.created_at) AS last_failure FROM ${t} x
                        WHERE x.finding_id = fc.id AND x.engine = ${engine} AND x.status = 'failed') f
    WHERE NOT EXISTS (SELECT 1 FROM ${t} x WHERE x.finding_id = fc.id AND x.engine = ${engine} AND x.status <> 'failed')
      AND ${retryDue(Prisma.sql`f.failures`, Prisma.sql`f.last_failure`, opts.retryAfterSeconds)}
      AND ${translated}
    ORDER BY fc.published_on DESC, fc.id LIMIT ${opts.limit}`;
  return membersByIds(
    db,
    ids.map((r) => r.id),
  );
};

/** pgvector type of a size: halfvec above pgvector's 2000-dimension index limit (matches the partial HNSW indexes). */
const vectorType = (dims: number): Prisma.Sql => {
  if (!Number.isInteger(dims) || dims <= 0) throw new Error(`invalid embedding size ${dims}`);
  return Prisma.raw(`${dims > 2000 ? 'halfvec' : 'vector'}(${dims})`);
};

/**
 * Runs a nearest-neighbour query with pgvector's iterative index scan: the HNSW index returns candidates until
 * enough rows pass the filters (engine, current version, jurisdiction) instead of stopping after ef_search
 * candidates. Results may come slightly out of order, so callers re-sort by distance.
 */
const withIterativeScan = <T>(db: PrismaService, query: Prisma.Sql): Promise<T[]> =>
  db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)`;
    return tx.$queryRaw<T[]>(query);
  });

/** Filters of a nearest-neighbour search. */
export interface NearestOptions {
  /** Only findings of this jurisdiction (EU or a country code). */
  readonly jurisdiction?: string;
}

/**
 * Nearest current findings by cosine distance of their latest embedding of `engine`, optionally of one
 * jurisdiction. The query vector is passed as a constant so the partial HNSW index of `dims` serves the ORDER BY.
 */
export const nearestFindings = async (
  db: PrismaService,
  findingId: string,
  engine: string,
  dims: number,
  k: number,
  opts: NearestOptions = {},
): Promise<readonly { readonly id: string; readonly distance: number }[]> => {
  const type = vectorType(dims);
  const [me] = await db.$queryRaw<{ v: string }[]>`
    SELECT vector::text AS v FROM embedding
    WHERE finding_id = ${findingId}::uuid AND engine = ${engine} AND dims = ${dims}
    ORDER BY created_at DESC LIMIT 1`;
  if (!me) return [];
  const inJurisdiction = opts.jurisdiction
    ? Prisma.sql`AND fc.jurisdiction = ${opts.jurisdiction}`
    : Prisma.empty;
  return withIterativeScan(
    db,
    Prisma.sql`
      SELECT id, distance FROM (
        SELECT e.finding_id AS id, ((e.vector::${type}) <=> ${me.v}::${type})::float AS distance
        FROM embedding e JOIN finding_current fc ON fc.id = e.finding_id
        WHERE e.dims = ${dims} AND e.engine = ${engine} AND e.finding_id <> ${findingId}::uuid ${inJurisdiction}
        ORDER BY (e.vector::${type}) <=> ${me.v}::${type} LIMIT ${k}) n
      ORDER BY distance, id`,
  );
};

/**
 * For many findings at once (one round trip): their `k` nearest current findings of the same jurisdiction
 * (latest embedding of `engine`). Used to tell whether new neighbours arrived since a grouping decision.
 */
export const nearestOfMany = async (
  db: PrismaService,
  findingIds: readonly string[],
  engine: string,
  dims: number,
  k: number,
): Promise<ReadonlyMap<string, readonly string[]>> => {
  if (findingIds.length === 0) return new Map();
  const type = vectorType(dims);
  const rows = await withIterativeScan<{ of: string; id: string }>(
    db,
    Prisma.sql`
      SELECT q.id AS of, n.id FROM unnest(${[...findingIds]}::uuid[]) AS q(id)
      JOIN finding_current qf ON qf.id = q.id
      CROSS JOIN LATERAL (SELECT vector FROM embedding
                          WHERE finding_id = q.id AND engine = ${engine} AND dims = ${dims}
                          ORDER BY created_at DESC LIMIT 1) me
      CROSS JOIN LATERAL (
        SELECT e.finding_id AS id FROM embedding e JOIN finding_current fc ON fc.id = e.finding_id
        WHERE e.dims = ${dims} AND e.engine = ${engine} AND e.finding_id <> q.id AND fc.jurisdiction = qf.jurisdiction
        ORDER BY (e.vector::${type}) <=> (me.vector::${type}) LIMIT ${k}) n`,
  );
  return new Map([...Map.groupBy(rows, (r) => r.of)].map(([of, rs]) => [of, rs.map((r) => r.id)] as const));
};

/** Rationale prefix of a grouping decision whose agent run failed (stored as "separate"). */
export const GROUPING_FAILED_PREFIX = 'agent failed: ';

/**
 * Latest grouping decision of an engine per item (`source:id`, so a decision on an older version of the item still
 * counts): whether that run failed, and if so, whether a retry is due (backoff per retryDue) or the stage gave up
 * (MAX_ATTEMPTS failed runs since the last successful decision; then only new evidence brings the group back).
 */
export const latestGroupDecisions = async (
  db: PrismaService,
  engine: string,
  retryAfterSeconds: number,
): Promise<
  ReadonlyMap<
    string,
    {
      readonly decision: string;
      readonly decidedAt: Date;
      readonly failed: boolean;
      readonly retryDue: boolean;
      readonly gaveUp: boolean;
    }
  >
> =>
  new Map(
    (
      await db.$queryRaw<
        {
          finding_id: string;
          decision: string;
          created_at: Date;
          failed: boolean;
          retry_due: boolean;
          gave_up: boolean;
        }[]
      >`
        WITH l AS (
          SELECT g.id, g.decision, g.created_at, f.source_id || ':' || f.external_id AS item,
                 starts_with(g.rationale, ${GROUPING_FAILED_PREFIX}) AS failed
          FROM group_link g JOIN finding f ON f.id = g.finding_id WHERE g.engine = ${engine}
        ), counted AS (
          SELECT l.*, count(*) FILTER (WHERE l.failed AND l.created_at > coalesce(ok.at, '-infinity'))
                        OVER (PARTITION BY l.item) AS failures
          FROM l LEFT JOIN (SELECT item, max(created_at) AS at FROM l WHERE NOT failed GROUP BY item) ok USING (item)
        )
        SELECT item AS finding_id, decision, created_at, failed,
               ${retryDue(Prisma.sql`failures`, Prisma.sql`created_at`, retryAfterSeconds)} AS retry_due,
               failures >= ${MAX_ATTEMPTS} AS gave_up
        FROM (SELECT DISTINCT ON (item) * FROM counted ORDER BY item, created_at DESC, id DESC) d`
    ).map((r) => [
      r.finding_id,
      {
        decision: r.decision,
        decidedAt: r.created_at,
        failed: r.failed,
        retryDue: r.failed && r.retry_due,
        gaveUp: r.failed && r.gave_up,
      },
    ]),
  );

/** whyRelevant prefix of a classification whose agent run failed (the deterministic fallback was stored). */
export const CLASSIFICATION_FAILED_PREFIX = 'Agent failed (';

/** Latest snapshot of a group that still needs a classification of the engine. */
export interface PendingSnapshot {
  /** Snapshot id. */
  readonly id: string;
  /** Group key. */
  readonly group_key: string;
  /** Jurisdiction of the group. */
  readonly jurisdiction: string;
  /** Member finding ids. */
  readonly member_ids: string[];
}

/**
 * Latest non-retired snapshots without a classification of `engine`, newest first. A snapshot whose
 * agent run failed keeps its fallback classification and is retried with backoff (see retryDue), at
 * most MAX_ATTEMPTS times.
 */
export const pendingClassifications = async (
  db: PrismaService,
  engine: string,
  opts: { readonly limit: number; readonly retryAfterSeconds: number },
): Promise<readonly PendingSnapshot[]> =>
  db.$queryRaw<PendingSnapshot[]>`
    SELECT s.id, s.group_key, s.jurisdiction, s.member_ids FROM (
      SELECT DISTINCT ON (group_key) * FROM group_snapshot ORDER BY group_key, created_at DESC, id DESC) s
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE NOT starts_with(c.why_relevant, ${CLASSIFICATION_FAILED_PREFIX})) AS done,
             count(*) FILTER (WHERE starts_with(c.why_relevant, ${CLASSIFICATION_FAILED_PREFIX})) AS failures,
             max(c.created_at) AS last_failure
      FROM classification c WHERE c.snapshot_id = s.id AND c.engine = ${engine}) c
    WHERE NOT s.retired AND c.done = 0
      AND ${retryDue(Prisma.sql`c.failures`, Prisma.sql`c.last_failure`, opts.retryAfterSeconds)}
    ORDER BY s.latest_published DESC, s.group_key LIMIT ${opts.limit}`;

/** When each current finding was stored (to tell whether new evidence arrived after a decision). */
export const findingTimes = async (db: PrismaService): Promise<ReadonlyMap<string, Date>> =>
  new Map(
    (await db.$queryRaw<{ id: string; created_at: Date }[]>`SELECT id, created_at FROM finding_current`).map(
      (r) => [r.id, r.created_at],
    ),
  );

/** Current findings (outside `exclude`) whose title, summary or reference mentions one of the identifiers. */
export const findingsMentioning = async (
  db: PrismaService,
  identifiers: readonly string[],
  exclude: readonly string[],
  limit: number,
): Promise<readonly string[]> => {
  if (identifiers.length === 0) return [];
  const patterns = identifiers.map((v) => `%${v.replace(/[%_\\]/g, '')}%`);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT f.id FROM finding_current fc JOIN finding f ON f.id = fc.id
    WHERE (f.title ILIKE ANY(${patterns}::text[]) OR f.summary ILIKE ANY(${patterns}::text[])
           OR f.ref ILIKE ANY(${patterns}::text[]))
      AND NOT f.id = ANY(${[...exclude]}::uuid[])
    ORDER BY f.published_on DESC, f.id LIMIT ${limit}`;
  return rows.map((r) => r.id);
};

/**
 * Already classified current groups that contain one of the findings, with their labels (precedents). Groups that
 * share a member with the group being classified (`ownMemberIds`, e.g. its own earlier snapshot under another key
 * before the read models are refreshed after a merge) are left out, so the agent never copies its own old verdict.
 */
export const classifiedGroupsContaining = async (
  db: PrismaService,
  findingIds: readonly string[],
  excludeKey: string,
  ownMemberIds: readonly string[] = [],
): Promise<
  readonly {
    readonly group_key: string;
    readonly title: string;
    readonly why_relevant: string | null;
    readonly member_ids: string[];
    readonly labels: { naceCode: string; verdict: string }[];
  }[]
> =>
  findingIds.length === 0
    ? []
    : db.$queryRaw`
        SELECT g.group_key, g.title, g.why_relevant, g.member_ids,
               coalesce((SELECT jsonb_agg(x ORDER BY x."naceCode") FROM (
                 SELECT DISTINCT l.nace_code AS "naceCode", l.verdict::text AS verdict
                 FROM radar_label_current l WHERE l.group_key = g.group_key) x), '[]'::jsonb) AS labels
        FROM radar_group_current g
        WHERE g.member_ids && ${[...findingIds]}::uuid[] AND g.group_key <> ${excludeKey}
          AND NOT g.member_ids && ${[...ownMemberIds]}::uuid[]
          AND g.classification_id IS NOT NULL`;

/**
 * NACE codes closest to a query vector (semantic code search over title + explanatory notes). Only the latest
 * embedding of each code counts, so a code whose notes changed is neither listed twice nor ranked by stale notes.
 * The table is small (one row per code and notes version), so it is scanned exactly instead of via the index.
 */
export const nearestNaceCodes = async (
  db: PrismaService,
  vector: readonly number[],
  engine: string,
  k: number,
): Promise<readonly { readonly code: string; readonly distance: number }[]> => {
  const type = vectorType(vector.length);
  const literal = `[${vector.join(',')}]`;
  return db.$queryRaw`
    SELECT code, ((vector::${type}) <=> ${literal}::${type})::float AS distance FROM (
      SELECT DISTINCT ON (code) code, vector FROM nace_embedding
      WHERE engine = ${engine} AND dims = ${vector.length}
      ORDER BY code, created_at DESC, id DESC) n
    ORDER BY distance, code LIMIT ${k}`;
};

/** Latest snapshot hash and retired flag per group key. */
export const latestSnapshotHashes = async (
  db: PrismaService,
): Promise<ReadonlyMap<string, { hash: string; retired: boolean }>> =>
  new Map(
    (
      await db.$queryRaw<{ group_key: string; content_hash: string; retired: boolean }[]>`
        SELECT DISTINCT ON (group_key) group_key, content_hash, retired FROM group_snapshot
        ORDER BY group_key, created_at DESC, id DESC`
    ).map((r) => [r.group_key, { hash: r.content_hash, retired: r.retired }]),
  );

/**
 * Latest labels of the same engine for every group that last contained one of these findings. Used to keep
 * previously relevant pairs tracked, also when groups merged and the merged group got another name. Fallback
 * results of failed agent runs and results of other engines (or older rule versions) are not carried over.
 */
export const previousLabels = async (
  db: PrismaService,
  memberIds: readonly string[],
  engine: string,
): Promise<readonly CountryLabel[]> =>
  db.$queryRaw<CountryLabel[]>`
    WITH prior AS (
      SELECT DISTINCT ON (group_key) group_key, member_ids FROM group_snapshot
      WHERE NOT retired ORDER BY group_key, created_at DESC, id DESC)
    SELECT l.country, l.nace_code AS "naceCode", l.verdict::text AS verdict, l.score, l.rationale
    FROM prior p
    JOIN LATERAL (SELECT id FROM classification c
                  WHERE c.group_key = p.group_key AND c.engine = ${engine}
                    AND NOT starts_with(c.why_relevant, ${CLASSIFICATION_FAILED_PREFIX})
                  ORDER BY c.created_at DESC, c.id DESC LIMIT 1) c ON true
    JOIN relevance_label l ON l.classification_id = c.id
    WHERE p.member_ids && ${[...memberIds]}::uuid[]`;

/** Stores one classification and its labels (ltree paths computed here) in one transaction. */
export const insertClassification = async (
  db: PrismaService,
  c: {
    readonly snapshotId: string;
    readonly groupKey: string;
    readonly engine: string;
    readonly whyRelevant: string;
    readonly trace: unknown;
    readonly labels: readonly CountryLabel[];
  },
): Promise<void> => {
  await db.$transaction(async (tx) => {
    const { id } = await tx.classification.create({
      data: {
        snapshotId: c.snapshotId,
        groupKey: c.groupKey,
        engine: c.engine,
        whyRelevant: c.whyRelevant,
        trace: c.trace as Prisma.InputJsonValue,
      },
    });
    if (c.labels.length === 0) return;
    await tx.$executeRaw`
      INSERT INTO relevance_label (id, classification_id, country, nace_code, nace_path, verdict, score, rationale)
      SELECT uuidv7(), ${id}::uuid, u.country, u.nace_code, u.nace_path::ltree, u.verdict::"Verdict", u.score, u.rationale
      FROM unnest(${c.labels.map((l) => l.country)}::text[], ${c.labels.map((l) => l.naceCode)}::text[],
                  ${c.labels.map((l) => nacePath(l.naceCode))}::text[], ${c.labels.map((l) => l.verdict)}::text[],
                  ${c.labels.map((l) => l.score ?? null)}::float8[], ${c.labels.map((l) => l.rationale)}::text[])
        AS u(country, nace_code, nace_path, verdict, score, rationale)`;
  });
};
