import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { type StructuredToolInterface, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { errorMessage } from '../../common/fp.js';
import { AGENT_SQL_MAX_ROWS, type SqlReader } from '../../db/agent-reader.js';
import type { PrismaService } from '../../db/prisma.service.js';
import type { GroupMember } from '../../domain/grouping.js';
import { type NaceTaxonomy, searchNaceText } from '../../domain/nace.js';
import type { ChatProvider } from '../../llm/providers.js';
import { membersByIds, nearestFindings, nearestNaceCodes } from '../repository.js';
import { fetchPublic } from './public-fetch.js';

/** Options shared by the agent stages (grouping and classification). */
export interface AgentOptions {
  /** Engine id of the stage (deterministic or agent:...). */
  readonly engine: string;
  /** Embedding engine whose vectors nearest_findings searches. */
  readonly embeddingEngine: string;
  /** Vector size of that engine. */
  readonly embeddingDimensions: number;
  /** Agent step budget. */
  readonly maxSteps: number;
  /** Max agent runs per cycle. */
  readonly batchSize: number;
  /** Parallel agent runs. */
  readonly concurrency: number;
  /** Wait before retrying a failed agent run; every further retry waits four times longer. */
  readonly retryAfterSeconds: number;
  /** Whether fetch_url and web_search may use the internet. */
  readonly internet: boolean;
  /** Embeddings for semantic NACE search (null offline). */
  readonly queryEmbeddings: EmbeddingsInterface | null;
  /** Backend of sql_query (its own read-only login role); without it the tool answers with an error. */
  readonly sqlReader?: SqlReader | null;
  /** Aborts running agent calls (shutdown). */
  readonly signal?: AbortSignal;
}

/** What the tools can see. */
export interface ToolContext {
  /** Database. */
  readonly db: PrismaService;
  /** NACE taxonomy. */
  readonly tax: NaceTaxonomy;
  /** Embedding engine whose vectors are searched. */
  readonly embeddingEngine: string;
  /** Vector size of that engine. */
  readonly embeddingDimensions: number;
  /** Whether fetch_url and web_search may access the internet. */
  readonly internet: boolean;
  /** Provider-native web search, if a provider is configured. */
  readonly webSearch: ChatProvider['webSearch'] | null;
  /** Embeddings for semantic NACE search (null offline). */
  readonly queryEmbeddings: EmbeddingsInterface | null;
  /** Backend of sql_query, or null when it is unavailable. */
  readonly sql: SqlReader | null;
  /** Current group key of a finding. */
  readonly groupKeyOf: (findingId: string) => string | undefined;
  /** Current member ids of a group. */
  readonly membersOf: (groupKey: string) => readonly string[];
}

/** Tool context of an agent stage: everything from the options plus the group lookups of the run. */
export const toolContext = (
  db: PrismaService,
  tax: NaceTaxonomy,
  opts: AgentOptions,
  chat: ChatProvider,
  groupKeyOf: ToolContext['groupKeyOf'],
  membersOf: ToolContext['membersOf'],
): ToolContext => ({
  db,
  tax,
  embeddingEngine: opts.embeddingEngine,
  embeddingDimensions: opts.embeddingDimensions,
  internet: opts.internet,
  webSearch: chat.webSearch,
  queryEmbeddings: opts.queryEmbeddings,
  sql: opts.sqlReader ?? null,
  groupKeyOf,
  membersOf,
});

/** Compact, model-friendly view of a finding. */
export const compact = (ctx: ToolContext) => (m: GroupMember) => ({
  id: m.id,
  externalId: m.externalId,
  source: m.sourceId,
  channel: m.channel,
  jurisdiction: m.jurisdiction,
  language: m.language,
  docType: m.docType,
  stage: m.stage,
  title: m.title,
  titleEn: m.titleEn,
  summary: m.summaryEn ?? m.summary,
  publishedOn: m.publishedOn,
  ref: m.ref,
  relatedTo: m.relatedTo,
  naceTags: m.naceTags,
  topics: m.topics,
  url: m.url,
  groupKey: ctx.groupKeyOf(m.id) ?? null,
});

/** Largest tool result handed back to the model (characters). */
const MAX_TOOL_RESULT = 20_000;

/** JSON with bigint support (COUNT results), capped at MAX_TOOL_RESULT characters. */
const toJson = (value: unknown): string =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? Number(v) : v)).slice(0, MAX_TOOL_RESULT);

/** Wraps a tool body so that errors become a readable tool result instead of aborting the agent. */
const safe =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<string> =>
    fn(args).then(toJson, (e: unknown) => toJson({ error: errorMessage(e) }));

/** Tables and views the sql_query tool may read (described for the model). */
const SQL_SCHEMA = `Read-only PostgreSQL 19 (pgvector, ltree, pg_trgm). Useful relations:
finding_current(id, source_id, external_id, jurisdiction, published_on) - current version of each item; join finding ON id
finding(id, source_id, external_id, channel, level, jurisdiction, language, doc_type, stage, title, summary, published_on,
  deadline, deadline_kind, event_date, ref, ref_key, related_to, nace_tags text[], topics, url, action_points jsonb)
translation(finding_id, engine, status, title_en, summary_en, created_at)
embedding(finding_id, engine, status, dims, vector, compacted) - cast vector::vector(1024) or vector::halfvec(3072) for <=> (cosine distance)
radar_group_current(group_key, title, title_original, language, jurisdiction, level, stage, member_ids uuid[], member_count,
  nace_tags, action_points, source_trail, latest_published, why_relevant) - current procedure groups
group_link(finding_id, engine, decision, target_group_key, rationale) - agent grouping decisions
radar_label_current(group_key, country, nace_code, nace_path ltree, verdict, score, rationale) - current relevance labels
Full-text: to_tsvector('simple', title || ' ' || coalesce(summary, '')) @@ websearch_to_tsquery('simple', '...').`;

/** Largest page body fetch_url reads (bytes). */
const MAX_PAGE_BYTES = 2_000_000;

/** Strips HTML to readable text (for fetch_url). */
const htmlToText = (html: string): string =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Tools shared by the grouping and classification agents. */
export const agentTools = (ctx: ToolContext): readonly StructuredToolInterface[] => {
  const view = compact(ctx);
  return [
    tool(
      safe(async ({ ids }: { ids: string[] }) => (await membersByIds(ctx.db, ids)).map(view)),
      {
        name: 'get_findings',
        description: 'Load findings (regulatory items, original texts plus English translation) by id.',
        schema: z.object({ ids: z.array(z.string().uuid()).min(1).max(20) }),
      },
    ),
    tool(
      safe(async ({ findingId, k }: { findingId: string; k: number }) => {
        const near = await nearestFindings(
          ctx.db,
          findingId,
          ctx.embeddingEngine,
          ctx.embeddingDimensions,
          k,
        );
        const members = new Map(
          (
            await membersByIds(
              ctx.db,
              near.map((n) => n.id),
            )
          ).map((m) => [m.id, view(m)]),
        );
        return near.map((n) => ({ distance: Math.round(n.distance * 1000) / 1000, ...members.get(n.id) }));
      }),
      {
        name: 'nearest_findings',
        description:
          'The k findings closest to a finding by multilingual embedding (cosine distance; < 0.2 is very similar). Choose k yourself (e.g. 4, 5 or 10).',
        schema: z.object({ findingId: z.string().uuid(), k: z.number().int().min(1).max(25) }),
      },
    ),
    tool(
      safe(async ({ groupKey }: { groupKey: string }) =>
        (await membersByIds(ctx.db, ctx.membersOf(groupKey))).map(view),
      ),
      {
        name: 'get_group',
        description: 'All current member findings of a procedure group.',
        schema: z.object({ groupKey: z.string() }),
      },
    ),
    tool(
      safe(async ({ query, limit }: { query: string; limit: number }) => {
        const rows = await ctx.db.$queryRaw<{ id: string; rank: number }[]>`
          WITH q AS (SELECT websearch_to_tsquery('simple', ${query}) AS q)
          SELECT fc.id, max(greatest(
                   ts_rank(to_tsvector('simple', coalesce(f.title, '') || ' ' || coalesce(f.summary, '') || ' ' || coalesce(f.ref, '')), q.q),
                   coalesce(ts_rank(to_tsvector('simple', coalesce(t.title_en, '') || ' ' || coalesce(t.summary_en, '')), q.q), 0)))::float AS rank
          FROM q, finding_current fc JOIN finding f ON f.id = fc.id LEFT JOIN translation t ON t.finding_id = f.id
          WHERE to_tsvector('simple', coalesce(f.title, '') || ' ' || coalesce(f.summary, '') || ' ' || coalesce(f.ref, '')) @@ q.q
             OR to_tsvector('simple', coalesce(t.title_en, '') || ' ' || coalesce(t.summary_en, '')) @@ q.q
          GROUP BY fc.id ORDER BY rank DESC, fc.id LIMIT ${limit}`;
        const members = new Map(
          (
            await membersByIds(
              ctx.db,
              rows.map((r) => r.id),
            )
          ).map((m) => [m.id, view(m)]),
        );
        return rows.map((r) => ({ rank: Math.round(r.rank * 1000) / 1000, ...members.get(r.id) }));
      }),
      {
        name: 'search_findings',
        description:
          'Full-text search (any language, web-search syntax: words, "exact phrase", OR, -excluded) over original and English titles, summaries and references, best matches first. Exact word forms (no stemming): add inflections with OR.',
        schema: z.object({ query: z.string().min(2).max(200), limit: z.number().int().min(1).max(20) }),
      },
    ),
    tool(
      safe(async ({ sql }: { sql: string }) => {
        if (!ctx.sql) return { error: 'sql_query is unavailable' };
        return ctx.sql(sql);
      }),
      {
        name: 'sql_query',
        description: `Run one read-only SQL SELECT against the radar database (max ${AGENT_SQL_MAX_ROWS} rows, 5 s, long rows are cut). ${SQL_SCHEMA}`,
        schema: z.object({ sql: z.string().min(8).max(4000) }),
      },
    ),
    tool(
      safe(async ({ query }: { query: string }) => {
        if (!ctx.internet)
          return { error: 'web search is disabled (offline or AGENT_INTERNET_ACCESS=false)' };
        if (!ctx.webSearch)
          return {
            error:
              "the provider's web search is not available with EU regional inference; use fetch_url on a known public URL instead",
          };
        return ctx.webSearch(query);
      }),
      {
        name: 'web_search',
        description:
          "Search the web with the model provider's built-in web search (e.g. a procedure number, CELEX number or act title) and get a grounded answer with source URLs.",
        schema: z.object({ query: z.string().min(3).max(300) }),
      },
    ),
    tool(
      safe(async ({ query }: { query: string }) => {
        const text = searchNaceText(ctx.tax, query, 15).map((n) => n.code);
        const meaning = ctx.queryEmbeddings
          ? (
              await nearestNaceCodes(
                ctx.db,
                await ctx.queryEmbeddings.embedQuery(query),
                ctx.embeddingEngine,
                15,
              )
            ).map((r) => r.code)
          : [];
        // Reciprocal rank fusion of the text and the embedding ranking.
        const score = (code: string) =>
          [text, meaning].reduce(
            (sum, list) => sum + (list.includes(code) ? 1 / (10 + list.indexOf(code)) : 0),
            0,
          );
        return [...new Set([...text, ...meaning])]
          .toSorted((a, b) => score(b) - score(a))
          .slice(0, 15)
          .flatMap((code) => {
            const n = ctx.tax.byCode.get(code);
            if (!n) return [];
            const matchedBy = [text.includes(code) && 'words', meaning.includes(code) && 'meaning'].filter(
              Boolean,
            );
            return [{ code, level: n.level, title: n.title, matchedBy }];
          });
      }),
      {
        name: 'search_nace',
        description:
          'Find NACE Rev. 2.1 codes for an activity, product or business type (any wording, e.g. "steelworks", "supermarkets", "bakeries"): matches words in titles and Eurostat explanatory notes plus semantic similarity. Confirm a code with nace_notes.',
        schema: z.object({ query: z.string().min(1).max(200) }),
      },
    ),
    tool(
      safe(async ({ code }: { code: string }) => {
        const n = ctx.tax.byCode.get(code.trim().toUpperCase());
        if (!n) return { error: `${code} is not a NACE Rev. 2.1 code; use search_nace` };
        const parent = n.parent ? ctx.tax.byCode.get(n.parent) : undefined;
        return {
          code: n.code,
          level: n.level,
          title: n.title,
          parent: parent ? { code: parent.code, title: parent.title } : null,
          notes: n.notes ?? null,
          children: ctx.tax.nodes
            .filter((c) => c.parent === n.code)
            .map((c) => ({ code: c.code, title: c.title })),
        };
      }),
      {
        name: 'nace_notes',
        description:
          'Title, parent, children and the Eurostat explanatory notes (includes / also includes / excludes) of a NACE Rev. 2.1 code.',
        schema: z.object({ code: z.string().min(1).max(10) }),
      },
    ),
    tool(
      safe(async ({ url }: { url: string }) => {
        if (!ctx.internet) return { error: 'internet access is disabled (AGENT_INTERNET_ACCESS=false)' };
        const res = await fetchPublic(url, { timeoutMs: 20_000, maxBytes: MAX_PAGE_BYTES });
        return { status: res.status, url: res.url, text: htmlToText(res.text).slice(0, 6000) };
      }),
      {
        name: 'fetch_url',
        description:
          'HTTP GET a public web page (e.g. the item URL on EUR-Lex or a national gazette) and return its text.',
        schema: z.object({ url: z.string().url() }),
      },
    ),
  ];
};
