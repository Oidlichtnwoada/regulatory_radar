import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiModule } from '../src/app.module.js';
import { migrate } from '../src/cli/migrate.js';
import { type Env, loadEnv } from '../src/config/env.js';
import { AgentSqlReader } from '../src/db/agent-reader.js';
import { PrismaService } from '../src/db/prisma.service.js';
import { loadTaxonomy } from '../src/domain/nace.js';
import { ProblemFilter } from '../src/http/controllers.js';
import { IngestionService } from '../src/ingestion/ingestion.service.js';
import type { ChatProvider } from '../src/llm/providers.js';
import { agentTools } from '../src/pipeline/agents/tools.js';
import { runClassificationStage } from '../src/pipeline/classification.stage.js';
import { embeddingText, runEmbeddingStage } from '../src/pipeline/embedding.stage.js';
import { runGroupingStage } from '../src/pipeline/grouping.stage.js';
import { runNaceEmbeddingStage } from '../src/pipeline/nace-embedding.stage.js';
import { PipelineService } from '../src/pipeline/pipeline.service.js';
import {
  CLASSIFICATION_FAILED_PREFIX,
  currentMembers,
  GROUPING_FAILED_PREFIX,
} from '../src/pipeline/repository.js';
import { runTranslationStage } from '../src/pipeline/translation.stage.js';
import { fileSource } from '../src/sources/file.source.js';
import type { ConfiguredSource } from '../src/sources/registry.js';
import { AI, SOURCES } from '../src/tokens.js';
import { failingChat, fakeAi, HashEmbeddings, structuredChat } from './fake-ai.js';

const DATA_DIR = join(import.meta.dirname, '../../../data');

/** Boots the API for one mode on the shared container, with the seed ingested and the pipeline idle. */
const boot = async (container: StartedPostgreSqlContainer, overrides: Record<string, string>) => {
  const env: Env = loadEnv({
    DATABASE_URL: container.getConnectionUri(),
    DATA_DIR,
    LOG_FORMAT: 'text',
    ...overrides,
  });
  await migrate(env);
  const builder = Test.createTestingModule({ imports: [apiModule(env)] });
  const moduleRef = await (overrides.LLM_PROVIDER
    ? builder.overrideProvider(AI).useValue(fakeAi())
    : builder
  ).compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemFilter());
  await app.init();
  const [file] = app.get<readonly ConfiguredSource[]>(SOURCES);
  if (!file) throw new Error('no file source');
  const ingest = () => app.get(IngestionService).runPass(file.adapter, new AbortController().signal);
  await ingest();
  await app.get(PipelineService).runUntilIdle();
  return { app, db: app.get(PrismaService), ingest };
};

describe('pipeline + API on PostgreSQL 19 (offline mode)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:0.8.7-pg19-trixie').start();
    ctx = await boot(container, {});
    app = ctx.app;
  });
  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('stores every seed item once and skips identical payloads on the next pass', async () => {
    expect(await ctx.db.rawRecord.count()).toBe(53);
    const second = await ctx.ingest();
    expect(second.inserted).toBe(0);
    expect(await ctx.db.rawRecord.count()).toBe(53);
    const cp = await ctx.db.sourceCheckpoint.findFirst({ orderBy: { createdAt: 'desc' } });
    expect(cp?.watermark.toISOString().slice(0, 10)).toBe('2026-11-15'); // newest published date of the seed
  });

  it('writes empty translations and embeddings offline', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/system/pipeline').expect(200);
    expect(res.body.translations.pending).toBe(0);
    expect(res.body.embeddings).toMatchObject({ done: 0, skipped: 53, pending: 0 });
    expect(res.body.groups).toBe(res.body.classifiedGroups);
  });

  it('ranks the metals radar by actionability, deterministically, with jurisdiction logic', async () => {
    const url = '/api/v1/radar?countries=AT&naceCodes=C24.4&asOf=2026-11-16';
    const [a, b] = await Promise.all([
      request(app.getHttpServer()).get(url),
      request(app.getHttpServer()).get(url),
    ]);
    expect(a.body).toEqual(b.body);
    const ranks = a.body.entries.map((e: { actionability: { rank: number } }) => e.actionability.rank);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    expect(a.body.entries.every((e: { jurisdiction: string }) => ['EU', 'AT'].includes(e.jurisdiction))).toBe(
      true,
    );
    expect(a.body.entries.map((e: { groupKey: string }) => e.groupKey)).toContain('AT-GAZ-0037');
    expect(a.body.groupsChecked).toBeGreaterThan(a.body.total);
  });

  it('persists the operator profile and validates input as RFC 9457 problems', async () => {
    const server = app.getHttpServer();
    await request(server)
      .put('/api/v1/profile')
      .send({ countries: ['ES'], naceCodes: ['G47'] })
      .expect(200);
    expect((await request(server).get('/api/v1/profile')).body).toMatchObject({
      countries: ['ES'],
      naceCodes: ['G47'],
    });
    const bad = await request(server)
      .put('/api/v1/profile')
      .send({ countries: ['CH'], naceCodes: [] })
      .expect(400);
    expect(bad.headers['content-type']).toContain('application/problem+json');
    expect(bad.body).toEqual({
      type: 'about:blank',
      status: 400,
      title: 'Bad Request',
      detail: 'not EU member states: CH',
      instance: '/api/v1/profile',
    });
    const spec = await request(server).get('/api/v1/radar?limit=0&naceCodes=Z99').expect(400);
    expect(spec.body.detail).toContain('query.limit must be >= 1');
    const unknownNace = await request(server).get('/api/v1/radar?naceCodes=C99').expect(400);
    expect(unknownNace.body.detail).toBe('unknown NACE Rev. 2.1 codes: C99');
    const missing = await request(server)
      .get('/api/v1/findings/00000000-0000-7000-8000-000000000000')
      .expect(404);
    expect(missing.body).toMatchObject({
      status: 404,
      title: 'Not Found',
      instance: expect.stringContaining('/findings/'),
    });
  });

  it('renders the weekly digest as HTML', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/digest/weekly?countries=ES&naceCodes=G47&weekEnding=2026-11-16',
    );
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('procedure groups checked');
  });

  // Stage failure handling, on engines of their own next to the offline results (seed: 28 English items,
  // 25 others of which 8 have a summary).
  const failures = (engine: string) => ctx.db.translation.count({ where: { engine, status: 'failed' } });
  const stage = { batchSize: 100, concurrency: 5 };

  it('retries failed translations with backoff, gives up after 3 attempts, then embeds the original', async () => {
    const down = structuredChat(() => {
      throw new Error('provider down');
    });
    const translate = (retryAfterSeconds: number) =>
      runTranslationStage(ctx.db, down, { ...stage, engine: 'test:down', retryAfterSeconds });
    const embed = () =>
      runEmbeddingStage(ctx.db, fakeAi().embedding, null, {
        ...stage,
        engine: 'test:after-down',
        translationEngine: 'test:down',
        retryAfterSeconds: 0,
      });
    expect(await translate(3600)).toBe(28); // English identity rows; failures do not count as work
    expect(await failures('test:down')).toBe(25);
    expect(await translate(3600)).toBe(0); // within the backoff nothing is retried
    expect(await failures('test:down')).toBe(25);
    expect(await embed()).toBe(28); // the others wait: their translation may still succeed
    await translate(0);
    await translate(0);
    expect(await failures('test:down')).toBe(75);
    expect(await translate(0)).toBe(0); // given up after 3 attempts
    expect(await failures('test:down')).toBe(75);
    expect(await embed()).toBe(25); // given-up translations no longer block the embedding
  });

  it('fails only the bad items of an embedding batch and retries just those', async () => {
    const texts = (await currentMembers(ctx.db)).map(embeddingText);
    const [bad, short] = texts;
    const hash = new HashEmbeddings();
    const base = fakeAi().embedding;
    if (!base || !bad || !short) throw new Error('fixture');
    const flaky = {
      ...base,
      embeddings: {
        embedQuery: (t: string) => hash.embedQuery(t),
        embedDocuments: async (batch: string[]) => {
          if (batch.length > 1) throw new Error('too many tokens in one request');
          if (batch[0] === bad) throw new Error('input rejected');
          const vectors = await hash.embedDocuments(batch);
          return batch[0] === short ? vectors.map((v) => v.slice(0, 10)) : vectors;
        },
      },
    };
    const opts = { ...stage, engine: 'test:flaky', translationEngine: 'none', retryAfterSeconds: 3600 };
    expect(await runEmbeddingStage(ctx.db, flaky, null, opts)).toBe(51);
    const failed = await ctx.db.$queryRaw<{ error: string; has_vector: boolean }[]>`
      SELECT error, vector IS NOT NULL AS has_vector FROM embedding WHERE engine = 'test:flaky' AND status = 'failed'
      ORDER BY error`;
    expect(failed).toEqual([
      { error: 'expected a 3072-dim vector, got 10', has_vector: false },
      { error: 'input rejected', has_vector: false },
    ]);
    expect(await runEmbeddingStage(ctx.db, base, null, opts)).toBe(0); // still in backoff
    expect(await runEmbeddingStage(ctx.db, base, null, { ...opts, retryAfterSeconds: 0 })).toBe(2);
    const [done] = await ctx.db.$queryRaw<{ n: bigint; findings: bigint }[]>`
      SELECT count(*) AS n, count(DISTINCT finding_id) AS findings FROM embedding
      WHERE engine = 'test:flaky' AND status = 'embedded' AND vector IS NOT NULL AND dims = 3072`;
    expect(done).toEqual({ n: 53n, findings: 53n });
  });

  it('stores one result per finding and engine when two workers run at once', async () => {
    const chat = structuredChat((p) => ({
      titleEn: 'EN title',
      summaryEn: /Summary: \(none\)/.test(p) ? null : 'EN summary',
    }));
    const opts = { ...stage, engine: 'test:twice', retryAfterSeconds: 0 };
    await Promise.all([runTranslationStage(ctx.db, chat, opts), runTranslationStage(ctx.db, chat, opts)]);
    const embedOpts = { ...opts, translationEngine: 'test:twice' };
    await Promise.all([
      runEmbeddingStage(ctx.db, fakeAi().embedding, null, embedOpts),
      runEmbeddingStage(ctx.db, fakeAi().embedding, null, embedOpts),
    ]);
    expect(await ctx.db.translation.count({ where: { engine: 'test:twice' } })).toBe(53);
    expect(await ctx.db.embedding.count({ where: { engine: 'test:twice' } })).toBe(53);
  });

  it('fails a translation that leaves out the summary', async () => {
    const titleOnly = structuredChat(() => ({ titleEn: 'EN title', summaryEn: null }));
    await runTranslationStage(ctx.db, titleOnly, {
      ...stage,
      engine: 'test:no-summary',
      retryAfterSeconds: 3600,
    });
    const counts = await ctx.db.translation.groupBy({
      by: ['status'],
      where: { engine: 'test:no-summary' },
      _count: true,
    });
    expect(Object.fromEntries(counts.map((c) => [c.status, c._count]))).toEqual({
      identity: 28,
      translated: 17,
      failed: 8,
    });
  });

  it('stores a record the normaliser rejects without blocking the source, and normalises it once it can', async () => {
    const [seedItem] = JSON.parse(readFileSync(join(DATA_DIR, 'items.json'), 'utf8')) as Record<
      string,
      unknown
    >[];
    const path = join(mkdtempSync(join(tmpdir(), 'radar-')), 'items.json');
    writeFileSync(path, JSON.stringify([{ ...seedItem, id: 'BAD-1', jurisdiction: 'XX' }]));
    const base = fileSource(loadTaxonomy(join(DATA_DIR, 'nace_rev2_1.csv')), {
      path,
      since: null,
      pollSeconds: 1,
      batchSize: 10,
    });
    const sourceId = 'file_reject';
    const bad = { ...base, descriptor: { ...base.descriptor, id: sourceId } };
    const ingestion = app.get(IngestionService);
    const signal = new AbortController().signal;

    const first = await ingestion.runPass(bad, signal);
    expect(first).toMatchObject({ fetched: 1, inserted: 1 });
    expect(first.rejected).toEqual([expect.stringMatching(/^BAD-1: jurisdiction "XX"/)]);
    expect(await ctx.db.finding.count({ where: { sourceId } })).toBe(0);
    expect(await ctx.db.sourceCheckpoint.count({ where: { sourceId } })).toBe(1); // not blocked
    const event = await ctx.db.sourceEvent.findFirst({
      where: { sourceId, kind: { not: 'started' } },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).toMatchObject({ kind: 'degraded', message: expect.stringContaining('rejected BAD-1') });

    const fixed = {
      ...bad,
      normalize: (r: Parameters<typeof bad.normalize>[0]) => ({ ...bad.normalize(r), jurisdiction: 'AT' }),
    };
    const second = await ingestion.runPass(fixed, signal);
    expect(second).toMatchObject({ inserted: 0, rejected: [] });
    expect(await ctx.db.finding.findMany({ where: { sourceId }, select: { jurisdiction: true } })).toEqual([
      { jurisdiction: 'AT' },
    ]);
    expect(await ctx.db.sourceCheckpoint.count({ where: { sourceId } })).toBe(1); // watermark only moves forward
  });
});

describe('pipeline in online mode with scripted LLM providers', () => {
  let container: StartedPostgreSqlContainer;
  let ctx: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:0.8.7-pg19-trixie').start();
    ctx = await boot(container, { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' });
  });
  afterAll(async () => {
    await ctx?.app.close();
    await container?.stop();
  });

  it('uses its own database and runs translation, embeddings and both LangGraph agents', async () => {
    const [dbRow] = await ctx.db.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    expect(dbRow?.db).toMatch(/_online$/);
    expect(await ctx.db.translation.count({ where: { status: 'translated' } })).toBe(25);
    expect(await ctx.db.translation.count({ where: { status: 'identity' } })).toBe(28);
    const [vectors] = await ctx.db.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*) AS n FROM embedding WHERE vector IS NOT NULL`;
    expect(Number(vectors?.n)).toBe(53);
    const link = await ctx.db.groupLink.findFirst({ where: { engine: 'agent:openai:scripted' } });
    expect(JSON.stringify(link?.trace)).toContain('nearest_findings');
    expect(JSON.stringify(link?.trace)).toContain('Pre-computed candidate groups');
    expect(link?.rationale).toContain('Evidence:');
    const cls = await ctx.db.classification.findFirst({
      where: { engine: { startsWith: 'agent:openai:scripted@' }, groupKey: 'AT-GAZ-0037' },
    });
    expect(cls?.whyRelevant).toBe('scripted agent classification');
  });

  it('embeds the NACE taxonomy once per embedding model, also across restarts', async () => {
    const tax = loadTaxonomy(join(DATA_DIR, 'nace_rev2_1.csv'));
    const count = (engine: string) => ctx.db.naceEmbedding.count({ where: { engine } });
    expect(await count('openai:hash')).toBe(tax.nodes.length);
    // A restart builds new provider objects for the same model: nothing is embedded again.
    expect(await runNaceEmbeddingStage(ctx.db, tax, fakeAi().embedding, { engine: 'openai:hash' })).toBe(0);
    expect(await count('openai:hash')).toBe(tax.nodes.length);
    // Another model embeds the taxonomy again (stored next to the first one).
    expect(await runNaceEmbeddingStage(ctx.db, tax, fakeAi().embedding, { engine: 'openai:other' })).toBe(
      tax.nodes.length,
    );
  });

  it('gives the classification agent action points, rule hints and precedents up front', async () => {
    const cls = await ctx.db.classification.findFirst({
      where: { engine: { startsWith: 'agent:openai:scripted@' } }, // + rules version
    });
    const trace = JSON.stringify(cls?.trace);
    expect(trace).toContain('Hints of the deterministic keyword rules');
    expect(trace).toContain('Precedents');
    expect(trace).toContain('search_nace');
  });

  it('reviews multi-item groups too, and does not re-review without new evidence', async () => {
    const reviewed = await ctx.db.$queryRaw<{ external_id: string }[]>`
      SELECT f.external_id FROM group_link g JOIN finding f ON f.id = g.finding_id`;
    expect(reviewed.map((r) => r.external_id)).toContain('EU-LEX-0011');
    const before = await ctx.db.groupLink.count();
    await ctx.app.get(PipelineService).runCycle();
    expect(await ctx.db.groupLink.count()).toBe(before);
  });

  it('gives the agents full-text search, read-only SQL and 3072-dim neighbours', async () => {
    const tools = new Map(
      agentTools({
        db: ctx.db,
        tax: loadTaxonomy(join(import.meta.dirname, '../../../data/nace_rev2_1.csv')),
        embeddingEngine: 'openai:hash',
        embeddingDimensions: 3072,
        internet: false,
        webSearch: null,
        queryEmbeddings: null,
        sql: ctx.app.get(AgentSqlReader).query,
        groupKeyOf: () => undefined,
        membersOf: () => [],
      }).map((t) => [t.name, t]),
    );
    const call = async (name: string, args: object) =>
      JSON.parse(String(await tools.get(name)?.invoke(args)));
    const hits = await call('search_findings', { query: 'Antidumpingzolls OR anti-dumping', limit: 5 });
    expect(hits.map((h: { externalId: string }) => h.externalId).sort()).toEqual([
      'EU-LEX-0011',
      'EU-LEX-0015',
    ]);
    const [counted] = await call('sql_query', {
      sql: "SELECT count(*) AS n FROM finding WHERE jurisdiction = 'AT'",
    });
    expect(counted.n).toBeGreaterThan(0);
    expect((await call('sql_query', { sql: 'DELETE FROM finding RETURNING id' })).error).toBeDefined();
    expect((await call('sql_query', { sql: "SELECT pg_read_file('/etc/hostname')" })).error).toMatch(
      /denied/,
    );
    // Its own login role: no way back to the owner's (superuser) role, no second statement, at most 50 rows.
    const [ownerRow] = await ctx.db.$queryRaw<{ owner: string }[]>`SELECT current_user AS owner`;
    const owner = ownerRow?.owner ?? 'radar';
    const [who] = await call('sql_query', { sql: 'SELECT current_user AS u, session_user AS s' });
    expect(who).toEqual({ u: 'radar_agent_reader', s: 'radar_agent_reader' });
    expect(
      (await call('sql_query', { sql: `SELECT set_config('role', '${owner}', true) AS r` })).error,
    ).toMatch(/permission denied|must be member/);
    expect((await call('sql_query', { sql: 'SELECT 1; COMMIT' })).error).toBeDefined();
    expect((await call('sql_query', { sql: 'SELECT * FROM operator_profile' })).error).toMatch(/denied/);
    const many = await call('sql_query', {
      sql: 'SELECT f.id FROM finding f CROSS JOIN finding g) AS x --',
    });
    expect(Array.isArray(many) ? many.length : 0).toBeLessThanOrEqual(50);
    const capped = await call('sql_query', { sql: 'SELECT f.id FROM finding f CROSS JOIN finding g' });
    expect(capped).toHaveLength(50);
    const [any] = hits;
    const near = await call('nearest_findings', { findingId: any.id, k: 3 });
    expect(near).toHaveLength(3);
    expect((await call('web_search', { query: 'CELEX 32026R1234' })).error).toMatch(/disabled/);
  });

  it('keeps stated NACE tags relevant even when the agent gives no label', async () => {
    const res = await request(ctx.app.getHttpServer()).get(
      '/api/v1/radar?countries=ES&naceCodes=G47&asOf=2026-11-16',
    );
    expect(res.body.entries.map((e: { groupKey: string }) => e.groupKey)).toContain('EU-HYS-0012');
  });

  // Agent failure handling, on engines of their own next to the online results.
  const agentOpts = (engine: string, retryAfterSeconds: number) => ({
    engine,
    retryAfterSeconds,
    embeddingEngine: 'openai:hash',
    translationEngine: 'openai:scripted',
    embeddingDimensions: 3072,
    maxSteps: 4,
    batchSize: 100,
    concurrency: 5,
    internet: false,
    queryEmbeddings: null,
  });

  it('retries failed grouping runs with backoff and gives up after 3', async () => {
    const tax = loadTaxonomy(join(DATA_DIR, 'nace_rev2_1.csv'));
    const failed = () =>
      ctx.db.groupLink.count({
        where: { engine: 'test:group-down', rationale: { startsWith: GROUPING_FAILED_PREFIX } },
      });
    const group = (retryAfterSeconds: number) =>
      runGroupingStage(ctx.db, tax, failingChat(), agentOpts('test:group-down', retryAfterSeconds));
    await group(3600);
    const reviewed = await failed();
    expect(reviewed).toBeGreaterThan(0);
    expect(await group(3600)).toBe(0); // within the backoff nothing is retried; failures are no work
    expect(await failed()).toBe(reviewed);
    await group(0);
    await group(0);
    expect(await failed()).toBe(3 * reviewed);
    await group(0); // given up after 3 failed runs
    expect(await failed()).toBe(3 * reviewed);

    // New evidence brings a given-up group back for one more run: a copy of its item under a new id
    // (same text, so a newer member or nearest neighbour).
    const [given] = await ctx.db.$queryRaw<{ finding_id: string }[]>`
      SELECT finding_id FROM group_link WHERE engine = 'test:group-down' GROUP BY finding_id ORDER BY finding_id LIMIT 1`;
    if (!given) throw new Error('fixture');
    const runs = () =>
      ctx.db.groupLink.count({ where: { engine: 'test:group-down', findingId: given.finding_id } });
    expect(await runs()).toBe(3);
    const { rawRecord } = await ctx.db.finding.findUniqueOrThrow({
      where: { id: given.finding_id },
      include: { rawRecord: true },
    });
    const item = rawRecord.payload as Record<string, unknown>;
    const path = join(mkdtempSync(join(tmpdir(), 'radar-')), 'items.json');
    writeFileSync(path, JSON.stringify([{ ...item, id: `${String(item.id)}-COPY` }]));
    const copy = fileSource(tax, { path, since: null, pollSeconds: 1, batchSize: 10 });
    await ctx.app
      .get(IngestionService)
      .runPass(
        { ...copy, descriptor: { ...copy.descriptor, id: 'file_copy' } },
        new AbortController().signal,
      );
    const ai = fakeAi();
    const stageOpts = { batchSize: 100, concurrency: 5, retryAfterSeconds: 0 };
    await runTranslationStage(ctx.db, ai.chat, { ...stageOpts, engine: 'openai:scripted' });
    await runEmbeddingStage(ctx.db, ai.embedding, null, {
      ...stageOpts,
      engine: 'openai:hash',
      translationEngine: 'openai:scripted',
    });
    await group(3600); // re-reviewed even with a long backoff: new evidence, not a retry
    expect(await runs()).toBe(4);
    await group(0); // given up again until the next new evidence
    expect(await runs()).toBe(4);
  });

  it('keeps the fallback classification when the agent fails and retries the agent with backoff', async () => {
    const tax = loadTaxonomy(join(DATA_DIR, 'nace_rev2_1.csv'));
    const count = (engine: string, failed: boolean) =>
      ctx.db.classification.count({
        where: {
          engine: { startsWith: `${engine}@` }, // + rules version
          whyRelevant: failed
            ? { startsWith: CLASSIFICATION_FAILED_PREFIX }
            : { not: { startsWith: CLASSIFICATION_FAILED_PREFIX } },
        },
      });
    const classify = (chat: ChatProvider, engine: string, retryAfterSeconds: number) =>
      runClassificationStage(ctx.db, tax, chat, agentOpts(engine, retryAfterSeconds));
    const [row] = await ctx.db.$queryRaw<{ groups: bigint }[]>`
      SELECT count(*) AS groups FROM (SELECT DISTINCT ON (group_key) retired FROM group_snapshot
                                      ORDER BY group_key, created_at DESC, id DESC) s WHERE NOT retired`;
    const n = Number(row?.groups ?? 0);
    expect(n).toBeGreaterThan(0);
    expect(await classify(failingChat(), 'test:classify-down', 3600)).toBe(0); // fallbacks only
    expect(await count('test:classify-down', true)).toBe(n);
    expect(await classify(failingChat(), 'test:classify-down', 3600)).toBe(0); // in backoff
    expect(await count('test:classify-down', true)).toBe(n);
    await classify(failingChat(), 'test:classify-down', 0);
    await classify(failingChat(), 'test:classify-down', 0);
    await classify(failingChat(), 'test:classify-down', 0); // given up after 3 failed runs
    expect(await count('test:classify-down', true)).toBe(3 * n);

    // Once the provider is back, a due retry replaces the fallback, and nothing runs after that.
    await classify(failingChat(), 'test:classify-flaky', 0);
    expect(await classify(fakeAi().chat as ChatProvider, 'test:classify-flaky', 0)).toBe(n);
    expect(await classify(fakeAi().chat as ChatProvider, 'test:classify-flaky', 0)).toBe(0);
    expect(await count('test:classify-flaky', false)).toBe(n);
  });
});
