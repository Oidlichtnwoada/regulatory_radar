import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatMistralAI, MistralAIEmbeddings } from '@langchain/mistralai';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { HTTPClient } from '@mistralai/mistralai';
import { type Env, type LlmProviderId, llmSettings, mistralRegional } from '../config/env.js';
import { type TokenBudget, tokenBudget } from './tokens.js';

/** Maximum input tokens of both embedding models (mistral-embed and text-embedding-3-large). */
export const EMBEDDING_MAX_INPUT_TOKENS = 8192;

/** Limit of one provider HTTP request (chat, embeddings, web search); a stalled connection must not hang the worker. */
export const LLM_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Supported embedding models and their vector sizes: only these sizes have nearest-neighbour indexes
 * (vector(1024), halfvec(3072)), so another model is refused at startup instead of failing every item.
 */
export const EMBEDDING_MODELS: Readonly<Record<LlmProviderId, Readonly<Record<string, number>>>> = {
  mistral: { 'mistral-embed': 1024 },
  openai: { 'text-embedding-3-large': 3072 },
};

/** Vector size of a provider's embedding model; throws for a model without a known size. */
export const embeddingDimensions = (provider: LlmProviderId, model: string): number => {
  const dims = EMBEDDING_MODELS[provider][model];
  if (!dims)
    throw new Error(
      `${provider.toUpperCase()}_EMBED_MODEL=${model} is not supported; use ${Object.keys(EMBEDDING_MODELS[provider]).join(' or ')} (the vector indexes exist for those sizes only)`,
    );
  return dims;
};

/** Waits after 429 answers without Retry-After (ms); rejected requests are not billed, a lost agent run is. */
export const RATE_LIMIT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/** A fetch function (the shape the provider SDKs and postJson call). */
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Wait before the next attempt: the provider's Retry-After (seconds) when given, else the backoff step. Pure. */
export const retryDelayMs = (res: Pick<Response, 'headers'>, attempt: number): number => {
  const header = Number(res.headers.get('retry-after'));
  return Number.isFinite(header) && header > 0
    ? header * 1000
    : (RATE_LIMIT_BACKOFF_MS[attempt] ?? RATE_LIMIT_BACKOFF_MS.at(-1) ?? 0);
};

/**
 * Provider fetch that respects rate limits: requests leave at least `minIntervalMs` apart (one shared queue per
 * provider, so stages and agent runs running in parallel do not burst past a per-second limit), and a 429 is
 * retried here with backoff, so an agent run survives instead of being thrown away with the tokens it already used.
 * Each attempt times out after LLM_REQUEST_TIMEOUT_MS.
 */
export const rateLimitedFetch = (minIntervalMs: number, base: Fetch = (i, init) => fetch(i, init)): Fetch => {
  // Contained mutable state: the time slot of the last request, shared by every caller of this provider.
  let next = 0;
  const slot = async (): Promise<void> => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + minIntervalMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
  const attempt = async (
    input: string | URL | Request,
    init: RequestInit | undefined,
    n: number,
  ): Promise<Response> => {
    await slot();
    const res = await base(input instanceof Request ? input.clone() : input, {
      ...init,
      signal: AbortSignal.any([
        AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
        ...(init?.signal ? [init.signal] : []),
        ...(input instanceof Request ? [input.signal] : []),
      ]),
    });
    if (res.status !== 429 || n >= RATE_LIMIT_BACKOFF_MS.length) return res;
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, retryDelayMs(res, n)));
    return attempt(input, init, n + 1);
  };
  return (input, init) => attempt(input, init, 0);
};

/** HTTP client of the Mistral SDK on a rate-limited fetch (the LangChain Mistral classes have no timeout option). */
const mistralHttpClient = (fetcher: Fetch): HTTPClient => new HTTPClient({ fetcher });

/** One cited web page of a provider-native web search. */
export interface WebSource {
  /** Page URL. */
  readonly url: string;
  /** Page title, if given. */
  readonly title: string | null;
}

/** Answer of a provider-native web search (OpenAI Responses or Mistral Conversations `web_search`). */
export interface WebSearchResult {
  /** The model's answer, grounded in the search results. */
  readonly answer: string;
  /** Cited sources. */
  readonly sources: readonly WebSource[];
}

/** A chat model; the pipeline only programs against LangChain's BaseChatModel. */
export interface ChatProvider {
  /** Provider id. */
  readonly id: LlmProviderId;
  /** Model id. */
  readonly model: string;
  /** Engine id stored with every result (provider:model). */
  readonly engine: string;
  /** A LangChain chat model with tool calling. */
  readonly chat: BaseChatModel;
  /** Web search executed by the provider's own built-in tool; null where the endpoint has none (Mistral regional). */
  readonly webSearch: ((query: string) => Promise<WebSearchResult>) | null;
}

/** A multilingual embedding model; the pipeline only programs against LangChain's EmbeddingsInterface. */
export interface EmbeddingProvider {
  /** Engine id stored with every vector (provider:model). */
  readonly engine: string;
  /** Model id. */
  readonly model: string;
  /** Vector size. */
  readonly dimensions: number;
  /** Input limit of the model and how to count against it. */
  readonly tokens: TokenBudget;
  /** LangChain embeddings. */
  readonly embeddings: EmbeddingsInterface;
}

/** Chat and embeddings of ONE provider (both or neither); null means the deterministic offline fallback. */
export interface AiProviders {
  /** Chat provider or null. */
  readonly chat: ChatProvider | null;
  /** Embedding provider or null. */
  readonly embedding: EmbeddingProvider | null;
}

/** What a provider factory builds. */
interface ProviderParts {
  /** Chat model id. */
  readonly chatModel: string;
  /** LangChain chat model. */
  readonly chat: BaseChatModel;
  /** Provider-native web search, or null where the provider's endpoint has none (Mistral regional inference). */
  readonly webSearch: ((query: string) => Promise<WebSearchResult>) | null;
  /** Embedding model, size, input budget and LangChain embeddings. */
  readonly embedding: Omit<EmbeddingProvider, 'engine'>;
}

/** POSTs JSON with a bearer key and returns the parsed body (throws on HTTP errors). */
const postJson = async (send: Fetch, url: string, apiKey: string, body: unknown): Promise<unknown> => {
  const res = await send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
};

/** Loosely typed JSON node (provider responses are parsed defensively). */
type Json = { readonly [k: string]: unknown };
/** Array items of a JSON value that are objects. */
const objects = (v: unknown): readonly Json[] =>
  Array.isArray(v) ? v.filter((x): x is Json => typeof x === 'object' && x !== null) : [];
/** String value or null. */
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** Deduplicated web sources. */
const sourcesOf = (items: readonly Json[]): readonly WebSource[] => [
  ...new Map(
    items.flatMap((i) => (str(i.url) ? [[i.url, { url: String(i.url), title: str(i.title) }]] : [])),
  ).values(),
];

/** OpenAI Responses API with the built-in `web_search` tool: output_text plus url_citation annotations. */
const openAiWebSearch =
  (env: Env, send: Fetch) =>
  async (query: string): Promise<WebSearchResult> => {
    const body = (await postJson(send, `${env.OPENAI_BASE_URL}/responses`, env.OPENAI_API_KEY, {
      model: env.OPENAI_CHAT_MODEL,
      input: query,
      tools: [{ type: 'web_search' }],
    })) as Json;
    const parts = objects(body.output).flatMap((o) => objects(o.content));
    return {
      answer: parts.flatMap((p) => str(p.text) ?? []).join('\n'),
      sources: sourcesOf(parts.flatMap((p) => objects(p.annotations))),
    };
  };

/** Mistral Conversations API with the built-in `web_search` tool: text chunks plus tool_reference chunks. */
const mistralWebSearch =
  (env: Env, send: Fetch) =>
  async (query: string): Promise<WebSearchResult> => {
    const body = (await postJson(send, `${env.MISTRAL_SERVER_URL}/v1/conversations`, env.MISTRAL_API_KEY, {
      model: env.MISTRAL_CHAT_MODEL,
      inputs: query,
      tools: [{ type: 'web_search' }],
      store: false,
    })) as Json;
    const outputs = objects(body.outputs);
    const chunks = outputs.flatMap((o) => objects(o.content));
    return {
      answer: [
        ...outputs.flatMap((o) => str(o.content) ?? []),
        ...chunks.flatMap((c) => str(c.text) ?? []),
      ].join(''),
      sources: sourcesOf(chunks.filter((c) => c.type === 'tool_reference')),
    };
  };

/** One factory per provider: adding a provider is one entry here plus its env variables. `send` is the provider's rate-limited fetch. */
const FACTORIES: Readonly<Record<LlmProviderId, (env: Env, send: Fetch) => ProviderParts>> = {
  mistral: (env, send) => ({
    chatModel: env.MISTRAL_CHAT_MODEL,
    chat: new ChatMistralAI({
      model: env.MISTRAL_CHAT_MODEL,
      apiKey: env.MISTRAL_API_KEY,
      serverURL: env.MISTRAL_SERVER_URL,
      temperature: 0,
      maxRetries: 3,
      httpClient: mistralHttpClient(send),
    }),
    // The EU endpoint keeps inference in the EU; its only tool is function calling, so no built-in web search.
    webSearch: mistralRegional(env) ? null : mistralWebSearch(env, send),
    embedding: {
      model: env.MISTRAL_EMBED_MODEL,
      dimensions: embeddingDimensions('mistral', env.MISTRAL_EMBED_MODEL),
      // No JS tokenizer for Mistral: cl100k count scaled by 1.3 as a safe over-estimate.
      tokens: tokenBudget(EMBEDDING_MAX_INPUT_TOKENS, 1.3),
      embeddings: new MistralAIEmbeddings({
        model: env.MISTRAL_EMBED_MODEL,
        // Mistral limits tokens per request; NACE notes are long.
        batchSize: 32,
        apiKey: env.MISTRAL_API_KEY,
        serverURL: env.MISTRAL_SERVER_URL,
        maxRetries: 3,
        httpClient: mistralHttpClient(send),
      }),
    },
  }),
  // The OpenAI SDK paces and retries its own requests (Retry-After); `send` serves the web search only.
  openai: (env, send) => ({
    chatModel: env.OPENAI_CHAT_MODEL,
    // No temperature: current OpenAI reasoning models do not document it; reproducibility comes from stored results.
    // Responses API: reasoning models (e.g. gpt-6-luna) refuse function tools on /v1/chat/completions.
    chat: new ChatOpenAI({
      model: env.OPENAI_CHAT_MODEL,
      useResponsesApi: true,
      apiKey: env.OPENAI_API_KEY,
      configuration: { baseURL: env.OPENAI_BASE_URL },
      maxRetries: 3,
      timeout: LLM_REQUEST_TIMEOUT_MS,
    }),
    webSearch: openAiWebSearch(env, send),
    embedding: {
      model: env.OPENAI_EMBED_MODEL,
      dimensions: embeddingDimensions('openai', env.OPENAI_EMBED_MODEL),
      tokens: tokenBudget(EMBEDDING_MAX_INPUT_TOKENS),
      embeddings: new OpenAIEmbeddings({
        model: env.OPENAI_EMBED_MODEL,
        apiKey: env.OPENAI_API_KEY,
        configuration: { baseURL: env.OPENAI_BASE_URL },
        dimensions: embeddingDimensions('openai', env.OPENAI_EMBED_MODEL),
        maxRetries: 3,
        timeout: LLM_REQUEST_TIMEOUT_MS,
      }),
    },
  }),
};

/** Builds chat + embeddings of the single configured provider, or none in offline mode. */
export const createAiProviders = (env: Env): AiProviders => {
  const { provider } = llmSettings(env);
  if (provider === 'none') return { chat: null, embedding: null };
  const parts = FACTORIES[provider](env, rateLimitedFetch(env.LLM_MIN_REQUEST_INTERVAL_MS));
  return {
    chat: {
      id: provider,
      model: parts.chatModel,
      engine: `${provider}:${parts.chatModel}`,
      chat: parts.chat,
      webSearch: parts.webSearch,
    },
    embedding: { ...parts.embedding, engine: `${provider}:${parts.embedding.model}` },
  };
};

/** Engine ids of every stage for the given providers. */
export const engines = (ai: AiProviders) => ({
  translation: ai.chat?.engine ?? 'none',
  embedding: ai.embedding?.engine ?? 'none',
  grouping: ai.chat && ai.embedding ? `agent:${ai.chat.engine}` : 'deterministic',
  classification: ai.chat ? `agent:${ai.chat.engine}` : 'deterministic',
});
