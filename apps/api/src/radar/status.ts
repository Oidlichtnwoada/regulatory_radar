import { isoDay } from '../common/fp.js';
import { type Env, llmSettings } from '../config/env.js';
import type { PrismaService } from '../db/prisma.service.js';
import { NACE_REVISION, type NaceTaxonomy } from '../domain/nace.js';
import type { components } from '../generated/openapi.js';
import { type AiProviders, engines } from '../llm/providers.js';
import { classificationEngine } from '../pipeline/classification.stage.js';
import type { ConfiguredSource } from '../sources/registry.js';

/** API schema types. */
type S = components['schemas'];

/** Today's calendar day in UTC (the services run in Etc/UTC), as a UTC-midnight date like every stored day. */
const today = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Reference date: the override, RADAR_AS_OF or today (UTC). */
export const asOfDate = (env: Env, override?: string | null, now: Date = new Date()): Date =>
  override ? new Date(`${override}T00:00:00Z`) : (env.RADAR_AS_OF ?? today(now));

/** System status: mode, providers and warnings. */
export const systemStatus = (env: Env, ai: AiProviders): S['SystemStatus'] => {
  const settings = llmSettings(env);
  return {
    mode: settings.mode,
    llm: { provider: env.LLM_PROVIDER, model: ai.chat?.model ?? null, configured: ai.chat !== null },
    embeddings: {
      provider: env.LLM_PROVIDER,
      model: ai.embedding?.model ?? null,
      configured: ai.embedding !== null,
    },
    agentInternetAccess: env.AGENT_INTERNET_ACCESS && ai.chat !== null,
    warnings: [...settings.warnings],
    asOf: asOfDate(env).toISOString().slice(0, 10),
    naceRevision: NACE_REVISION,
  };
};

/** Health from the latest event kind. */
const HEALTH: Readonly<Record<string, S['SourceHealth']>> = {
  started: 'running',
  completed: 'ok',
  degraded: 'degraded',
  failed: 'failed',
};

/** Per-source status from the append-only event and checkpoint logs. */
export const sourceStatuses = async (
  db: PrismaService,
  sources: readonly ConfiguredSource[],
): Promise<readonly S['SourceStatus'][]> => {
  type Row = {
    source_id: string;
    kind: string | null;
    created_at: Date | null;
    fetched: number | null;
    inserted: number | null;
    duplicates: number | null;
    duration_ms: number | null;
    message: string | null;
    last_success: Date | null;
    watermark: Date | null;
    records: bigint;
  };
  const ids = sources.map((s) => s.adapter.descriptor.id);
  const rows = await db.$queryRaw<Row[]>`
    SELECT s.source_id, e.kind::text, e.created_at, r.fetched, r.inserted, r.duplicates, r.duration_ms, r.message,
           (SELECT max(created_at) FROM source_event WHERE source_id = s.source_id AND kind = 'completed') AS last_success,
           (SELECT watermark FROM source_checkpoint WHERE source_id = s.source_id ORDER BY created_at DESC LIMIT 1) AS watermark,
           (SELECT count(*) FROM raw_record WHERE source_id = s.source_id) AS records
    FROM unnest(${ids}::text[]) AS s(source_id)
    LEFT JOIN LATERAL (SELECT kind, created_at FROM source_event WHERE source_id = s.source_id
                       ORDER BY created_at DESC LIMIT 1) e ON true
    LEFT JOIN LATERAL (SELECT * FROM source_event WHERE source_id = s.source_id AND kind <> 'started'
                       ORDER BY created_at DESC LIMIT 1) r ON true`;
  const byId = new Map(rows.map((r) => [r.source_id, r]));
  return sources.map(({ adapter: { descriptor: d }, enabled }) => {
    const r = byId.get(d.id);
    const lastRun =
      r?.fetched !== null && r?.fetched !== undefined
        ? {
            at: (r.created_at ?? new Date()).toISOString(),
            health: HEALTH[r.kind === 'started' ? 'completed' : (r.kind ?? '')] ?? 'idle',
            fetched: r.fetched,
            inserted: r.inserted ?? 0,
            duplicates: r.duplicates ?? 0,
            durationMs: r.duration_ms,
            message: r.message,
          }
        : null;
    return {
      id: d.id,
      name: d.name,
      kind: d.kind,
      level: d.level,
      country: d.country,
      enabled,
      requiresNetwork: d.requiresNetwork,
      health: enabled ? (HEALTH[r?.kind ?? ''] ?? 'idle') : 'disabled',
      recordCount: Number(r?.records ?? 0),
      watermark: r?.watermark ? isoDay(r.watermark) : null,
      lastRun,
      lastSuccessAt: r?.last_success?.toISOString() ?? null,
      filters: d.filters as Record<string, unknown>,
    };
  });
};

/** Counters per pipeline stage for the engines in effect. */
export const pipelineStatus = async (
  db: PrismaService,
  ai: AiProviders,
  tax: NaceTaxonomy,
): Promise<S['PipelineStatus']> => {
  // The classification engine id carries the rules/prompt version: groups count as classified for the current one.
  const e = { ...engines(ai), classification: classificationEngine(engines(ai).classification) };
  type Row = {
    findings: bigint;
    groups: bigint;
    classified: bigint;
    nace: bigint;
    last_cycle: Date | null;
  } & Record<`${'t' | 'e'}_${'done' | 'skipped' | 'failed'}`, bigint>;
  const [r] = await db.$queryRaw<Row[]>`
    WITH t AS (SELECT DISTINCT ON (finding_id) finding_id, status FROM translation WHERE engine = ${e.translation}
               AND finding_id IN (SELECT id FROM finding_current) ORDER BY finding_id, created_at DESC),
         m AS (SELECT DISTINCT ON (finding_id) finding_id, status FROM embedding WHERE engine = ${e.embedding}
               AND finding_id IN (SELECT id FROM finding_current) ORDER BY finding_id, created_at DESC)
    SELECT (SELECT count(*) FROM finding_current) AS findings,
           (SELECT count(*) FROM t WHERE status IN ('identity', 'translated')) AS t_done,
           (SELECT count(*) FROM t WHERE status = 'skipped') AS t_skipped,
           (SELECT count(*) FROM t WHERE status = 'failed') AS t_failed,
           (SELECT count(*) FROM m WHERE status = 'embedded') AS e_done,
           (SELECT count(*) FROM m WHERE status = 'skipped') AS e_skipped,
           (SELECT count(*) FROM m WHERE status = 'failed') AS e_failed,
           (SELECT count(*) FROM radar_group_current) AS groups,
           (SELECT count(*) FROM radar_group_current WHERE classification_engine = ${e.classification}) AS classified,
           (SELECT count(DISTINCT code) FROM nace_embedding WHERE engine = ${e.embedding}) AS nace,
           (SELECT max(finished_at) FROM pipeline_cycle) AS last_cycle`;
  const n = (v: bigint | undefined) => Number(v ?? 0);
  const counts = (p: 't' | 'e') => {
    const [done, skipped, failed] = [n(r?.[`${p}_done`]), n(r?.[`${p}_skipped`]), n(r?.[`${p}_failed`])];
    return { done, skipped, failed, pending: Math.max(0, n(r?.findings) - done - skipped - failed) };
  };
  return {
    findings: n(r?.findings),
    translations: counts('t'),
    embeddings: counts('e'),
    naceEmbeddings: { embedded: n(r?.nace), total: tax.nodes.length },
    groups: n(r?.groups),
    classifiedGroups: n(r?.classified),
    lastCycleAt: r?.last_cycle?.toISOString() ?? null,
    engines: e,
  };
};
