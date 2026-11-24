import { FakeListChatModel } from '@langchain/core/utils/testing';
import { describe, expect, it } from 'vitest';
import type { ChatProvider } from '../llm/providers.js';
import { tokenBudget } from '../llm/tokens.js';
import { embedAll, fitEmbeddingInput } from './embedding.stage.js';

const budget = { tokens: tokenBudget(8192) };
const long = 'The regulation lays down obligations for steel producers. '.repeat(2000);
const chatAnswering = (answer: string): ChatProvider => ({
  id: 'openai',
  model: 'fake',
  engine: 'openai:fake',
  chat: new FakeListChatModel({ responses: [answer] }),
  webSearch: async () => ({ answer: '', sources: [] }),
});

describe('embedding input limit (8192 tokens)', () => {
  it('embeds texts within the limit unchanged', async () => {
    expect(await fitEmbeddingInput('Short title', budget, null)).toEqual({
      text: 'Short title',
      compacted: false,
    });
  });

  it('compacts an over-long text once with the chat model', async () => {
    const input = await fitEmbeddingInput(long, budget, chatAnswering('Steel producers: new obligations.'));
    expect(input).toEqual({ text: 'Steel producers: new obligations.', compacted: true });
  });

  it('cuts at the limit when the compaction is still too long', async () => {
    const tooLong = await fitEmbeddingInput(long, budget, chatAnswering(long));
    expect(tooLong.compacted).toBe(true);
    expect(budget.tokens.count(tooLong.text)).toBeLessThanOrEqual(8192);
  });

  it('cuts the original and does not claim compaction without a usable compaction', async () => {
    const failing = { ...chatAnswering(''), chat: { invoke: () => Promise.reject(new Error('down')) } };
    const inputs = await Promise.all([
      fitEmbeddingInput(long, budget, null),
      fitEmbeddingInput(long, budget, chatAnswering('  ')),
      fitEmbeddingInput(long, budget, failing as unknown as ChatProvider),
    ]);
    for (const input of inputs) {
      expect(input.compacted).toBe(false);
      expect(input.text.startsWith('The regulation lays down')).toBe(true);
      expect(budget.tokens.count(input.text)).toBeLessThanOrEqual(8192);
    }
  });

  it('counts Mistral tokens with a safety margin', () => {
    expect(tokenBudget(8192, 1.3).count(long)).toBeGreaterThan(tokenBudget(8192).count(long));
  });
});

/** Fake embeddings of size 3: rejects batches containing 'bad', answers 'short' with a 2-dim vector. */
const fakeEmbeddings = (calls: string[][]) => ({
  dimensions: 3,
  embeddings: {
    embedDocuments: async (texts: string[]) => {
      calls.push(texts);
      if (texts.includes('bad')) throw new Error('input rejected');
      return texts.map((t) => (t === 'short' ? [1, 2] : [1, 2, 3]));
    },
    embedQuery: async () => [1, 2, 3],
  },
});

describe('embedding a batch', () => {
  it('embeds all texts in one request when it succeeds', async () => {
    const calls: string[][] = [];
    expect(await embedAll(fakeEmbeddings(calls), ['a', 'b'], 2)).toEqual([
      { vector: [1, 2, 3] },
      { vector: [1, 2, 3] },
    ]);
    expect(calls).toEqual([['a', 'b']]);
  });

  it('fails only the bad item when the batch request fails', async () => {
    const calls: string[][] = [];
    const out = await embedAll(fakeEmbeddings(calls), ['a', 'bad', 'c'], 2);
    expect(out).toEqual([{ vector: [1, 2, 3] }, { error: 'input rejected' }, { vector: [1, 2, 3] }]);
    expect(calls).toHaveLength(4); // the batch, then one request per text
  });

  it('rejects a vector of the wrong size instead of storing it', async () => {
    expect(await embedAll(fakeEmbeddings([]), ['a', 'short'], 2)).toEqual([
      { vector: [1, 2, 3] },
      { error: 'expected a 3-dim vector, got 2' },
    ]);
  });
});
