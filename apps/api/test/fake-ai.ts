import { createHash } from 'node:crypto';
import { Embeddings } from '@langchain/core/embeddings';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { RunnableLambda } from '@langchain/core/runnables';
import { type AiProviders, type ChatProvider, EMBEDDING_MAX_INPUT_TOKENS } from '../src/llm/providers.js';
import { tokenBudget } from '../src/llm/tokens.js';

/** Vector size of the fake embeddings (text-embedding-3-large). */
const FAKE_DIMENSIONS = 3072;

/** Text of a prompt (string or message list). */
const textOf = (input: unknown): string =>
  typeof input === 'string' ? input : JSON.stringify((input as BaseMessage[]).map((m) => m.content));

/** A structured-output schema (zod): validates what a fake model answers, like the real providers do. */
type Parser = { readonly parse: (value: unknown) => unknown };

/** Scripted translation of a translator prompt: prefixes title and summary (if any) with "EN". */
const scriptedTranslation = (prompt: string) => {
  const summary = prompt.match(/Summary: (.*)/)?.[1] ?? '(none)';
  return {
    titleEn: `EN ${prompt.match(/Title: (.*)/)?.[1] ?? ''}`,
    summaryEn: summary === '(none)' ? null : `EN ${summary}`,
  };
};

/** Chat provider whose structured outputs come from `answer`, validated against the requested schema. */
export const structuredChat = (answer: (prompt: string) => unknown): ChatProvider => ({
  id: 'openai',
  model: 'structured',
  engine: 'openai:structured',
  chat: {
    withStructuredOutput: (schema: Parser) =>
      RunnableLambda.from(async (input: unknown) => schema.parse(answer(textOf(input)))),
  } as unknown as BaseChatModel,
  webSearch: async (query) => ({ answer: `no web in tests (${query})`, sources: [] }),
});

/**
 * Scripted chat model standing in for Mistral / OpenAI in tests: on the first agent turn it calls one
 * tool (nearest_findings for grouping, search_nace for classification), then stops; structured outputs
 * are derived from the prompt. Exercises the real LangGraph loop, tools and persistence.
 */
export class ScriptedChat extends BaseChatModel {
  /** Model type. */
  _llmType(): string {
    return 'scripted';
  }

  /** Tools are executed by the graph; the fake decides which one to call. */
  override bindTools(): this {
    return this;
  }

  /** One agent turn. */
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const text = textOf(messages);
    const toolUsed = messages.some((m) => m.type === 'tool');
    const id = text.match(/"id\\?":\\?"([0-9a-f-]{36})/)?.[1];
    const call = toolUsed
      ? []
      : text.includes('existing procedure group') && id
        ? [{ id: 'c1', name: 'nearest_findings', args: { findingId: id, k: 5 }, type: 'tool_call' as const }]
        : text.includes('Classify procedure group')
          ? [{ id: 'c2', name: 'search_nace', args: { query: 'basic metals' }, type: 'tool_call' as const }]
          : [];
    return {
      generations: [
        { text: 'ok', message: new AIMessage({ content: toolUsed ? 'done' : '', tool_calls: call }) },
      ],
    };
  }

  /** Structured answers by output name. */
  override withStructuredOutput(schema: unknown, config?: { name?: string }): never {
    return RunnableLambda.from(async (input: unknown) => {
      const text = textOf(input);
      if (config?.name === 'translation') return (schema as Parser).parse(scriptedTranslation(text));
      if (text.includes('existing procedure group'))
        return {
          decision: 'separate',
          targetGroupKey: null,
          confidence: 'high',
          evidence: 'scripted: no shared identifier',
          rationale: 'scripted: different act',
        };
      const metals = /steel|stahl|alumin|schrott|metal/i.test(text);
      return {
        whyRelevant: 'scripted agent classification',
        labels: metals
          ? [
              {
                naceCode: 'C24',
                naceTitle: 'Manufacture of basic metals',
                basis: 'named',
                verdict: 'relevant',
                countries: null,
                rationale: 'scripted: metals',
              },
            ]
          : [],
      };
    }) as never;
  }
}

/** Chat model of a provider that is down: every agent turn fails. */
export class FailingChat extends ScriptedChat {
  /** Fails like an unreachable provider. */
  override async _generate(): Promise<ChatResult> {
    throw new Error('provider down');
  }
}

/** Chat provider whose model is down. */
export const failingChat = (): ChatProvider => ({
  id: 'openai',
  model: 'down',
  engine: 'openai:down',
  chat: new FailingChat({}),
  webSearch: async () => {
    throw new Error('provider down');
  },
});

/** Deterministic 1024-dimensional embeddings from a hash of the text. */
export class HashEmbeddings extends Embeddings {
  /** Creates the embeddings. */
  constructor() {
    super({});
  }

  /** Embeds many texts. */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const seed = createHash('sha256').update(t).digest();
      return Array.from({ length: FAKE_DIMENSIONS }, (_, i) => ((seed[i % 32] ?? 0) - 128) / 128);
    });
  }

  /** Embeds one text. */
  async embedQuery(text: string): Promise<number[]> {
    return (await this.embedDocuments([text]))[0] ?? [];
  }
}

/** Fake providers with engine ids like the real ones (OpenAI-sized vectors: exercises the halfvec index). */
export const fakeAi = (): AiProviders => ({
  chat: {
    id: 'openai',
    model: 'scripted',
    engine: 'openai:scripted',
    chat: new ScriptedChat({}),
    webSearch: async (query) => ({ answer: `no web in tests (${query})`, sources: [] }),
  },
  embedding: {
    engine: 'openai:hash',
    model: 'hash',
    dimensions: FAKE_DIMENSIONS,
    tokens: tokenBudget(EMBEDDING_MAX_INPUT_TOKENS),
    embeddings: new HashEmbeddings(),
  },
});
