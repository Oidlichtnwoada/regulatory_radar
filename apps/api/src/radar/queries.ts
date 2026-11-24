import { isoDay } from '../common/fp.js';
import type { PrismaService } from '../db/prisma.service.js';
import { EU_COUNTRY_CODES } from '../domain/countries.js';
import { naceSelectionQueries } from '../domain/nace.js';
import type { components } from '../generated/openapi.js';
import { Prisma } from '../generated/prisma/client.js';

/** API schema types (generated from openapi/openapi.yaml). */
type S = components['schemas'];
/** A radar entry of the API. */
export type RadarEntry = S['RadarEntry'];
/** A finding of the API. */
export type ApiFinding = S['Finding'];
/** A verdict of the API. */
export type ApiVerdict = S['Verdict'];

/** Verdict names by rank. */
const VERDICT_BY_RANK: readonly ApiVerdict[] = ['not_relevant', 'borderline', 'relevant'];

/** A radar selection (countries and NACE codes default to everything when empty). */
export interface RadarQuery {
  /** EU member states. */
  readonly countries: readonly string[];
  /** NACE codes at any level. */
  readonly naceCodes: readonly string[];
  /** Verdicts to return. */
  readonly verdicts: readonly ApiVerdict[];
  /** Reference date. */
  readonly asOf: Date;
  /** Page size. */
  readonly limit: number;
  /** Page offset. */
  readonly offset: number;
  /** Entries first seen after this are new. */
  readonly acknowledgedAt: Date | null;
  /** Restrict to these group keys (group detail). */
  readonly groupKeys?: readonly string[];
}

/** Row of the ranked radar query. */
type RadarRow = {
  readonly group_key: string;
  readonly title: string;
  readonly title_original: string | null;
  readonly language: string;
  readonly jurisdiction: string;
  readonly level: 'eu' | 'national';
  readonly stage: S['Stage'];
  readonly action_points: S['ActionPoint'][];
  readonly source_trail: S['SourceTrailEntry'][];
  readonly member_count: number;
  readonly first_seen_at: Date;
  readonly classification_engine: string | null;
  readonly why_relevant: string | null;
  readonly verdict_rank: number;
  readonly labels: S['RelevanceLabel'][];
  readonly rank: number;
  readonly tier: S['ActionTier'];
  readonly action_date: Date | null;
  readonly action_kind: S['ActionPointKind'] | null;
  readonly total: bigint;
  readonly groups_checked: bigint;
  readonly findings_checked: bigint;
};

/** Ranked radar result with the denominator. */
export interface RadarPage {
  /** Entries in rank order. */
  readonly entries: readonly RadarEntry[];
  /** Matching groups. */
  readonly total: number;
  /** Groups in jurisdiction scope. */
  readonly groupsChecked: number;
  /** Findings behind those groups. */
  readonly findingsChecked: number;
}

/**
 * The radar: groups in jurisdiction scope (EU level + selected countries), verdict = strongest label
 * matching the selection hierarchically (GiST on (country, nace_path) with lquery), ranked by the SQL
 * function radar_actionability and deterministic tie-breakers.
 */
export const queryRadar = async (db: PrismaService, q: RadarQuery): Promise<RadarPage> => {
  const countries = q.countries.length ? [...q.countries] : [...EU_COUNTRY_CODES];
  const lqueries = q.naceCodes.length ? [...naceSelectionQueries(q.naceCodes)] : ['NACE.*'];
  const ranks = q.verdicts.map((v) => VERDICT_BY_RANK.indexOf(v));
  // Asking for given groups (the detail page) finds them in any jurisdiction; the selection still decides the verdict.
  const scopeFilter = q.groupKeys
    ? Prisma.sql`g.group_key = ANY(${[...q.groupKeys]}::text[])`
    : Prisma.sql`(g.level = 'eu' OR g.jurisdiction = ANY(${countries}::text[]))`;
  const rows = await db.$queryRaw<RadarRow[]>`
    WITH scope AS (
      SELECT g.* FROM radar_group_current g
      WHERE ${scopeFilter}
    ), hits AS (
      SELECT l.group_key, max(l.verdict_rank) AS verdict_rank,
             jsonb_agg(jsonb_build_object('country', l.country, 'naceCode', l.nace_code, 'verdict', l.verdict,
                       'score', l.score, 'rationale', l.rationale)
                       ORDER BY l.verdict_rank DESC, l.nace_code, l.country) AS labels
      FROM radar_label_current l
      WHERE l.country = ANY(${countries}::text[]) AND l.nace_path ? ${lqueries}::lquery[]
        AND l.group_key IN (SELECT group_key FROM scope)
      GROUP BY l.group_key
    ), ranked AS (
      SELECT s.*, coalesce(h.verdict_rank, 0) AS verdict_rank, coalesce(h.labels, '[]'::jsonb) AS labels, a.*
      FROM scope s LEFT JOIN hits h USING (group_key)
      CROSS JOIN LATERAL radar_actionability(s.action_points, s.stage, ${isoDay(q.asOf)}::date) a
      WHERE coalesce(h.verdict_rank, 0) = ANY(${ranks}::int[])
    )
    SELECT r.*, count(*) OVER () AS total,
           (SELECT count(*) FROM scope) AS groups_checked,
           (SELECT coalesce(sum(member_count), 0) FROM scope) AS findings_checked
    FROM ranked r
    ORDER BY r.rank, r.action_date NULLS LAST, r.verdict_rank DESC, r.latest_published DESC, r.group_key
    LIMIT ${q.limit} OFFSET ${q.offset}`;
  // count(*) OVER () only exists on returned rows: past the last page, count with the first row instead.
  if (rows.length === 0 && q.offset > 0) {
    const head = await queryRadar(db, { ...q, limit: 1, offset: 0 });
    return { ...head, entries: [] };
  }
  const [first] = rows;
  const counts = first
    ? first
    : (
        await db.$queryRaw<{ groups_checked: bigint; findings_checked: bigint }[]>`
          SELECT count(*) AS groups_checked, coalesce(sum(member_count), 0) AS findings_checked
          FROM radar_group_current g WHERE g.level = 'eu' OR g.jurisdiction = ANY(${countries}::text[])`
      )[0];
  return {
    entries: rows.map((r) => toEntry(r, q.acknowledgedAt)),
    total: Number(first?.total ?? 0),
    groupsChecked: Number(counts?.groups_checked ?? 0),
    findingsChecked: Number(counts?.findings_checked ?? 0),
  };
};

/** Maps a radar row onto the API entry. */
const toEntry = (r: RadarRow, acknowledgedAt: Date | null): RadarEntry => {
  const verdict = VERDICT_BY_RANK[r.verdict_rank] ?? 'not_relevant';
  const top = r.labels[0];
  return {
    groupKey: r.group_key,
    title: r.title,
    titleOriginal: r.title_original,
    language: r.language,
    jurisdiction: r.jurisdiction,
    level: r.level,
    stage: r.stage,
    actionability: {
      tier: r.tier,
      rank: r.rank,
      date: r.action_date ? isoDay(r.action_date) : null,
      kind: r.action_kind,
    },
    actionPoints: r.action_points,
    verdict,
    // Agents write a policy-officer summary; deterministic rules explain best through the matched label.
    whyRelevant:
      r.classification_engine?.startsWith('agent:') || verdict === 'not_relevant' || !top
        ? (r.why_relevant ?? 'Not classified yet.')
        : `${top.rationale} (deterministic rules)`,
    matchedLabels: r.labels,
    sourceTrail: r.source_trail,
    firstSeenAt: r.first_seen_at.toISOString(),
    isNew: !acknowledgedAt || r.first_seen_at > acknowledgedAt,
    memberCount: r.member_count,
    classificationEngine: r.classification_engine ?? 'pending',
  };
};

/** Row of the findings list. */
type FindingRow = {
  readonly id: string;
  readonly source_id: string;
  readonly external_id: string;
  readonly channel: string;
  readonly level: 'eu' | 'national';
  readonly jurisdiction: string;
  readonly language: string;
  readonly doc_type: string;
  readonly stage: S['Stage'];
  readonly title: string;
  readonly summary: string | null;
  readonly published_on: Date;
  readonly deadline: Date | null;
  readonly deadline_kind: string | null;
  readonly event_date: Date | null;
  readonly ref: string | null;
  readonly related_to: string | null;
  readonly nace_tags_stated: boolean;
  readonly nace_tags: string[];
  readonly topics: string[];
  readonly url: string | null;
  readonly action_points: S['ActionPoint'][];
  readonly created_at: Date;
  readonly group_key: string | null;
  readonly t_status: S['TranslationStatus'] | null;
  readonly t_engine: string | null;
  readonly title_en: string | null;
  readonly summary_en: string | null;
  readonly total: bigint;
};

/**
 * SQL adding the latest translation and the current group key to a set of finding ids (`picked`: columns id and
 * total). The lookups run only for the picked rows, so a page costs the same however many findings exist.
 */
const findingDetailsSql = (picked: Prisma.Sql) => Prisma.sql`
  SELECT f.*, g.group_key, t.status::text AS t_status, t.engine AS t_engine, t.title_en, t.summary_en, p.total
  FROM (${picked}) p JOIN finding f ON f.id = p.id
  LEFT JOIN LATERAL (SELECT status, engine, title_en, summary_en FROM translation WHERE finding_id = f.id
                     ORDER BY (status IN ('identity', 'translated')) DESC, created_at DESC LIMIT 1) t ON true
  LEFT JOIN LATERAL (SELECT group_key FROM radar_group_current WHERE member_ids @> ARRAY[f.id] LIMIT 1) g ON true
  ORDER BY f.published_on DESC, f.external_id, f.id`;

/** Maps a finding row onto the API finding. */
export const toApiFinding = (r: FindingRow): ApiFinding => ({
  id: r.id,
  sourceId: r.source_id,
  externalId: r.external_id,
  channel: r.channel,
  level: r.level,
  jurisdiction: r.jurisdiction,
  language: r.language,
  docType: r.doc_type,
  stage: r.stage,
  title: r.title,
  summary: r.summary,
  publishedOn: isoDay(r.published_on),
  deadline: r.deadline ? isoDay(r.deadline) : null,
  deadlineKind: r.deadline_kind,
  eventDate: r.event_date ? isoDay(r.event_date) : null,
  ref: r.ref,
  relatedTo: r.related_to,
  naceTagsStated: r.nace_tags_stated,
  naceTags: r.nace_tags,
  topics: r.topics,
  url: r.url,
  actionPoints: r.action_points,
  ingestedAt: r.created_at.toISOString(),
  groupKey: r.group_key,
  translation: {
    status: r.t_status ?? 'pending',
    engine: r.t_engine,
    titleEn: r.title_en,
    summaryEn: r.summary_en,
  },
});

/** Paged findings list (raw imports in the common schema). */
export const queryFindings = async (
  db: PrismaService,
  q: {
    countries: readonly string[];
    sourceIds: readonly string[];
    q: string | null;
    limit: number;
    offset: number;
  },
): Promise<{ items: readonly ApiFinding[]; total: number }> => {
  const pattern = q.q ? `%${q.q.replace(/[%_]/g, '')}%` : null;
  const rows = await db.$queryRaw<FindingRow[]>(
    findingDetailsSql(Prisma.sql`
      SELECT fc.id, count(*) OVER () AS total
      FROM finding_current fc JOIN finding f ON f.id = fc.id
      WHERE (cardinality(${[...q.countries]}::text[]) = 0 OR fc.jurisdiction = ANY(${[...q.countries]}::text[]))
        AND (cardinality(${[...q.sourceIds]}::text[]) = 0 OR fc.source_id = ANY(${[...q.sourceIds]}::text[]))
        AND (${pattern}::text IS NULL OR f.title ILIKE ${pattern}
             OR EXISTS (SELECT 1 FROM translation t WHERE t.finding_id = f.id AND t.title_en ILIKE ${pattern}))
      ORDER BY fc.published_on DESC, f.external_id, f.id
      LIMIT ${q.limit} OFFSET ${q.offset}`),
  );
  // count(*) OVER () only exists on returned rows: past the last page, count with the first row instead.
  if (rows.length === 0 && q.offset > 0) {
    const head = await queryFindings(db, { ...q, limit: 1, offset: 0 });
    return { items: [], total: head.total };
  }
  return { items: rows.map(toApiFinding), total: Number(rows[0]?.total ?? 0) };
};

/** Findings by id (any version), in the API shape. */
export const findingsByIds = async (
  db: PrismaService,
  ids: readonly string[],
): Promise<readonly ApiFinding[]> =>
  ids.length === 0
    ? []
    : (
        await db.$queryRaw<FindingRow[]>(
          // Any version: superseded findings that a group still lists are shown too.
          findingDetailsSql(
            Prisma.sql`SELECT id, 0::bigint AS total FROM finding WHERE id = ANY(${[...ids]}::uuid[])`,
          ),
        )
      ).map(toApiFinding);
