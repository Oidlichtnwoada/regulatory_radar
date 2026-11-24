import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatMistralAI, MistralAIEmbeddings } from '@langchain/mistralai';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { type Env, type LlmProviderId, llmSettings } from '../config/env.js';
import { type TokenBudget, tokenBudget } from './tokens.js';

/** Maximum input tokens of both embedding models (mistral-embed and text-embedding-3-large). */
export const EMBEDDING_MAX_INPUT_TOKENS = 8192;

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
  /** Web search executed by the provider's own built-in tool. */
  readonly webSearch: (query: string) => Promise<WebSearchResult>;
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
  /** Provider-native web search. */
  readonly webSearch: (query: string) => Promise<WebSearchResult>;
  /** Embedding model, size, input budget and LangChain embeddings. */
  readonly embedding: Omit<EmbeddingProvider, 'engine'>;
}

/** POSTs JSON with a bearer key and returns the parsed body (throws on HTTP errors). */
const postJson = async (url: string, apiKey: string, body: unknown): Promise<unknown> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
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
  (env: Env) =>
  async (query: string): Promise<WebSearchResult> => {
    const body = (await postJson(`${env.OPENAI_BASE_URL}/responses`, env.OPENAI_API_KEY, {
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
  (env: Env) =>
  async (query: string): Promise<WebSearchResult> => {
    const body = (await postJson(`${env.MISTRAL_SERVER_URL}/v1/conversations`, env.MISTRAL_API_KEY, {
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

/** One factory per provider: adding a provider is one entry here plus its env variables. */
const FACTORIES: Readonly<Record<LlmProviderId, (env: Env) => ProviderParts>> = {
  mistral: (env) => ({
    chatModel: env.MISTRAL_CHAT_MODEL,
    chat: new ChatMistralAI({
      model: env.MISTRAL_CHAT_MODEL,
      apiKey: env.MISTRAL_API_KEY,
      serverURL: env.MISTRAL_SERVER_URL,
      temperature: 0,
      maxRetries: 3,
    }),
    webSearch: mistralWebSearch(env),
    embedding: {
      model: env.MISTRAL_EMBED_MODEL,
      dimensions: 1024,
      // No JS tokenizer for Mistral: cl100k count scaled by 1.3 as a safe over-estimate.
      tokens: tokenBudget(EMBEDDING_MAX_INPUT_TOKENS, 1.3),
      embeddings: new MistralAIEmbeddings({
        model: env.MISTRAL_EMBED_MODEL,
        // Mistral limits tokens per request; NACE notes are long.
        batchSize: 32,
        apiKey: env.MISTRAL_API_KEY,
        serverURL: env.MISTRAL_SERVER_URL,
        maxRetries: 3,
      }),
    },
  }),
  openai: (env) => ({
    chatModel: env.OPENAI_CHAT_MODEL,
    // No temperature: current OpenAI reasoning models do not document it; reproducibility comes from stored results.
    chat: new ChatOpenAI({
      model: env.OPENAI_CHAT_MODEL,
      apiKey: env.OPENAI_API_KEY,
      configuration: { baseURL: env.OPENAI_BASE_URL },
      maxRetries: 3,
    }),
    webSearch: openAiWebSearch(env),
    embedding: {
      model: env.OPENAI_EMBED_MODEL,
      dimensions: 3072,
      tokens: tokenBudget(EMBEDDING_MAX_INPUT_TOKENS),
      embeddings: new OpenAIEmbeddings({
        model: env.OPENAI_EMBED_MODEL,
        apiKey: env.OPENAI_API_KEY,
        configuration: { baseURL: env.OPENAI_BASE_URL },
        dimensions: 3072,
        maxRetries: 3,
      }),
    },
  }),
};

/** Builds chat + embeddings of the single configured provider, or none in offline mode. */
export const createAiProviders = (env: Env): AiProviders => {
  const { provider } = llmSettings(env);
  if (provider === 'none') return { chat: null, embedding: null };
  const parts = FACTORIES[provider](env);
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
