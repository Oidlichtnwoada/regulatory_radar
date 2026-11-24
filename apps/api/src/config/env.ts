import { z } from 'zod';

/** Comma-separated env value parsed into a trimmed, non-empty string list. */
const csv = (fallback = '') =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    );
/** Boolean env value ("true"/"1"/"yes"). */
const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === '' ? fallback : ['true', '1', 'yes'].includes(v.toLowerCase()),
    );
/** Optional ISO date env value. */
const isoDate = z
  .string()
  .optional()
  .transform((v) => (v ? new Date(`${v}T00:00:00Z`) : null));
/** Positive integer env value with a default. */
const int = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/** The supported ML/AI providers: chat with tool calling and multilingual embeddings both come from the one selected. */
export const LLM_PROVIDERS = ['mistral', 'openai'] as const;
/** Id of a supported provider. */
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];

/** Schema of every environment variable the service reads (documented in .env.example). */
const envSchema = z.object({
  DATABASE_URL: z.string().default('postgresql://radar:radar@localhost:5432/radar'),
  API_PORT: int(3000),
  DATA_DIR: z.string().default('../../data'),
  RADAR_AS_OF: isoDate,
  LLM_PROVIDER: z.enum(['none', ...LLM_PROVIDERS]).default('none'),
  MISTRAL_API_KEY: z.string().default(''),
  MISTRAL_CHAT_MODEL: z.string().default('mistral-large-4'),
  MISTRAL_EMBED_MODEL: z.string().default('mistral-embed'),
  /**
   * Mistral's global endpoint by default: it has the built-in web search the agents use. https://api.eu.mistral.ai
   * keeps inference in EU/EFTA data centres but supports function calling only (no web search).
   */
  MISTRAL_SERVER_URL: z.string().default('https://api.mistral.ai'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_CHAT_MODEL: z.string().default('gpt-6-luna'),
  OPENAI_EMBED_MODEL: z.string().default('text-embedding-3-large'),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  AGENT_INTERNET_ACCESS: bool(true),
  AGENT_MAX_STEPS: int(12),
  LLM_CONCURRENCY: int(3),
  PIPELINE_INTERVAL_SECONDS: int(15),
  PIPELINE_BATCH_SIZE: int(25),
  PIPELINE_RETRY_SECONDS: int(300),
  SOURCE_FILE_ENABLED: bool(true),
  SOURCE_FILE_PATH: z.string().default('items.json'),
  SOURCE_FILE_SINCE: isoDate,
  SOURCE_FILE_POLL_SECONDS: int(10),
  SOURCE_FILE_BATCH_SIZE: int(10),
  SOURCE_EURLEX_ENABLED: bool(false),
  SOURCE_EURLEX_SINCE: isoDate,
  SOURCE_EURLEX_LOOKBACK_DAYS: int(14),
  SOURCE_EURLEX_RESCAN_DAYS: z.coerce.number().int().nonnegative().default(7),
  SOURCE_EURLEX_CELEX_PATTERN: z.string().default('^(3[0-9]{4}[RLD]|5[0-9]{4}PC)'),
  SOURCE_EURLEX_POLL_SECONDS: int(1800),
  SOURCE_EURLEX_PAGE_SIZE: int(200),
  SOURCE_BOE_ENABLED: bool(false),
  SOURCE_BOE_SINCE: isoDate,
  SOURCE_BOE_LOOKBACK_DAYS: int(7),
  SOURCE_BOE_SECTIONS: csv('1'),
  SOURCE_BOE_DEPARTMENTS: csv(),
  SOURCE_BOE_POLL_SECONDS: int(3600),
  SOURCE_HTTP_TIMEOUT_SECONDS: int(60),
});

/** Parsed, immutable runtime configuration. */
export type Env = Readonly<z.infer<typeof envSchema>>;

/** Parses the given environment (default: process.env) into a frozen configuration object; empty values count as unset. */
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env =>
  Object.freeze(envSchema.parse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''))));

/** Effective mode and provider derived from the configuration. */
export interface LlmSettings {
  /** offline = no provider (deterministic pipeline), online = one provider with its API key. */
  readonly mode: 'offline' | 'online';
  /** Provider in effect for chat AND embeddings, or none. */
  readonly provider: 'none' | LlmProviderId;
  /** Human-readable warnings for the UI and the logs. */
  readonly warnings: readonly string[];
}

/**
 * True when Mistral is called through a regional endpoint (api.eu.mistral.ai, api.us.mistral.ai). Regional
 * inference supports function calling only: the built-in web_search tool (Conversations API) is global-only. Pure.
 */
export const mistralRegional = (env: Pick<Env, 'MISTRAL_SERVER_URL'>): boolean =>
  new URL(env.MISTRAL_SERVER_URL).hostname !== 'api.mistral.ai';

/** API key of each provider. */
const apiKeyOf = (env: Env): Readonly<Record<LlmProviderId, string>> => ({
  mistral: env.MISTRAL_API_KEY,
  openai: env.OPENAI_API_KEY,
});

/**
 * Two modes only: online when LLM_PROVIDER names a provider whose API key is set, otherwise offline.
 * Each mode has its own database (see databaseUrlFor), so their states never mix. Pure.
 */
export const llmSettings = (env: Env): LlmSettings => {
  const provider = env.LLM_PROVIDER !== 'none' && apiKeyOf(env)[env.LLM_PROVIDER] ? env.LLM_PROVIDER : 'none';
  const warnings =
    provider !== 'none'
      ? provider === 'mistral' && mistralRegional(env) && env.AGENT_INTERNET_ACCESS
        ? [
            `Mistral regional inference (${new URL(env.MISTRAL_SERVER_URL).hostname}): the provider's built-in web search is not available in the region, so agents use fetch_url for public pages only.`,
          ]
        : []
      : [
          env.LLM_PROVIDER === 'none'
            ? 'Offline mode (no LLM provider): no translations and no embeddings are produced; grouping and relevance use deterministic best-effort rules.'
            : `Offline mode: LLM_PROVIDER=${env.LLM_PROVIDER} but ${env.LLM_PROVIDER.toUpperCase()}_API_KEY is missing. No translations or embeddings; deterministic best-effort grouping and relevance.`,
        ];
  return { mode: provider === 'none' ? 'offline' : 'online', provider, warnings };
};

/** Database of the mode: the database name of DATABASE_URL suffixed with _offline or _online. */
export const databaseUrlFor = (env: Env): string => {
  const url = new URL(env.DATABASE_URL);
  url.pathname = `${url.pathname.replace(/^\//, '') || 'radar'}_${llmSettings(env).mode}`;
  return url.toString();
};
