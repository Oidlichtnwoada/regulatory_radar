import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import { createAiProviders, engines } from './providers.js';

describe('one ML/AI provider behind LangChain interfaces', () => {
  it.each([
    ['mistral', { MISTRAL_API_KEY: 'k' }, 'mistral:mistral-medium-latest', 'mistral:mistral-embed'],
    ['openai', { OPENAI_API_KEY: 'k' }, 'openai:gpt-6.2-sol', 'openai:text-embedding-3-large'],
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

  it('falls back to offline when the selected provider has no key', () => {
    const ai = createAiProviders(loadEnv({ LLM_PROVIDER: 'openai', MISTRAL_API_KEY: 'k' }));
    expect(ai).toEqual({ chat: null, embedding: null });
    expect(engines(ai).classification).toBe('deterministic');
  });
});
