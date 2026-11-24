import { HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmSettings, loadEnv } from '../config/env.js';
import { createAiProviders, engines } from './providers.js';

describe('one ML/AI provider behind LangChain interfaces', () => {
  it.each([
    ['mistral', { MISTRAL_API_KEY: 'k' }, 'mistral:mistral-small-2603', 'mistral:mistral-embed'],
    ['openai', { OPENAI_API_KEY: 'k' }, 'openai:gpt-6-luna', 'openai:text-embedding-3-large'],
  ])('%s serves tool-calling chat and embeddings from one key', (provider, keys, chat, embedding) => {
    const ai = createAiProviders(loadEnv({ LLM_PROVIDER: provider, ...keys }));
    expect(typeof ai.chat?.chat.bindTools).toBe('function');
    expect(typeof ai.embedding?.embeddings.embedDocuments).toBe('function');
    expect(engines(ai)).toEqual({
      translation: chat,
      embedding,
      grouping: `agent:${chat}`,
      classification: `agent:${chat}`,
    });
  });

  it.each([
    ['mistral', { MISTRAL_API_KEY: 'k', MISTRAL_EMBED_MODEL: 'codestral-embed' }],
    ['openai', { OPENAI_API_KEY: 'k', OPENAI_EMBED_MODEL: 'text-embedding-3-small' }],
  ])('refuses a %s embedding model without an indexed vector size', (provider, env) => {
    expect(() => createAiProviders(loadEnv({ LLM_PROVIDER: provider, ...env }))).toThrow(/not supported/);
  });

  it('calls OpenAI through the Responses API (reasoning models refuse tools on chat completions)', () => {
    const chat = createAiProviders(loadEnv({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'k' })).chat?.chat;
    expect(chat).toBeInstanceOf(ChatOpenAI);
    expect((chat as ChatOpenAI).useResponsesApi).toBe(true);
  });

  it('falls back to offline when the selected provider has no key', () => {
    const ai = createAiProviders(loadEnv({ LLM_PROVIDER: 'openai', MISTRAL_API_KEY: 'k' }));
    expect(ai).toEqual({ chat: null, embedding: null });
    expect(engines(ai).classification).toBe('deterministic');
  });
});

describe('Mistral endpoints: global (default, with web search) and EU regional', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Hosts of the requests a call makes (the network is stubbed: every request gets a 400, which is not retried). */
  const hostsOf = async (call: () => Promise<unknown>): Promise<readonly string[]> => {
    const hosts: string[] = [];
    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      hosts.push(new URL(input instanceof Request ? input.url : String(input)).hostname);
      return Promise.resolve(
        new Response('{"message":"test"}', { status: 400, headers: { 'content-type': 'application/json' } }),
      );
    });
    await call().catch(() => undefined);
    return hosts;
  };

  /** Mistral configured for EU regional inference. */
  const eu = {
    LLM_PROVIDER: 'mistral',
    MISTRAL_API_KEY: 'k',
    MISTRAL_SERVER_URL: 'https://api.eu.mistral.ai',
  };

  it('sends chat and embedding requests to api.eu.mistral.ai when configured', async () => {
    const ai = createAiProviders(loadEnv(eu));
    const chat = await hostsOf(() => ai.chat?.chat.invoke([new HumanMessage('hi')]) ?? Promise.resolve());
    const embed = await hostsOf(() => ai.embedding?.embeddings.embedDocuments(['hi']) ?? Promise.resolve());
    expect([...new Set([...chat, ...embed])]).toEqual(['api.eu.mistral.ai']);
  });

  it('has no built-in web search in the region and says so', () => {
    const env = loadEnv(eu);
    expect(createAiProviders(env).chat?.webSearch).toBeNull();
    expect(llmSettings(env).warnings.join(' ')).toMatch(/api\.eu\.mistral\.ai.*web search/);
  });

  it('uses the global endpoint with the built-in web search by default', async () => {
    const env = loadEnv({ LLM_PROVIDER: 'mistral', MISTRAL_API_KEY: 'k' });
    const ai = createAiProviders(env);
    expect(typeof ai.chat?.webSearch).toBe('function');
    expect(llmSettings(env).warnings).toEqual([]);
    const hosts = await hostsOf(() => ai.chat?.webSearch?.('CELEX 32026R0001') ?? Promise.resolve());
    expect(hosts).toEqual(['api.mistral.ai']);
  });
});
