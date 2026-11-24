import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Logger } from '@nestjs/common';
import { errorMessage, mapLimit } from '../common/fp.js';
import type { PrismaService } from '../db/prisma.service.js';
import type { GroupMember } from '../domain/grouping.js';
import type { ChatProvider, EmbeddingProvider } from '../llm/providers.js';
import { pendingFor } from './repository.js';

/** Text that is embedded: English when available, otherwise the original (the model is multilingual). */
export const embeddingText = (m: GroupMember): string =>
  [m.titleEn ?? m.title, m.summaryEn ?? m.summary, m.topics.join(', ')].filter(Boolean).join('\n');

/** Logger of the stage (errors that only degrade a result, such as a failed compaction, are logged here). */
const log = new Logger('Embedding');

/** Instruction for the one-time compaction of an over-long text. */
const COMPACT_SYSTEM = `You compact regulatory texts for a semantic search index. Keep the title, act numbers and
references, jurisdiction, affected sectors and activities, obligations, dates and deadlines. Drop boilerplate,
recitals and repetitions. Answer with the compacted text only.`;

/** Largest chat input sent for compaction (tokens). */
const COMPACT_INPUT_TOKENS = 100_000;

/** An embedding input within the model's limit and whether it had to be compacted. */
export interface EmbeddingInput {
  /** Text sent to the embedding model. */
  readonly text: string;
  /** True when the chat model compacted the text (it exceeded the input limit). */
  readonly compacted: boolean;
  /** Why no input could be prepared (the item then fails without an embedding call). */
  readonly error?: string;
}

/**
 * Fits a text into the embedding model's input limit: within the limit it is used as is; otherwise it is
 * compacted ONCE by the chat model (to about half the limit), and whatever still exceeds the limit is cut
 * at the limit. Without a chat model, or when compaction fails or answers nothing, the original is cut.
 */
export const fitEmbeddingInput = async (
  text: string,
  embedding: Pick<EmbeddingProvider, 'tokens'>,
  chat: ChatProvider | null,
): Promise<EmbeddingInput> => {
  const { tokens } = embedding;
  if (tokens.count(text) <= tokens.maxInputTokens) return { text, compacted: false };
  const words = Math.floor(tokens.maxInputTokens * 0.4);
  const compacted = chat
    ? await chat.chat
        .invoke([
          new SystemMessage(COMPACT_SYSTEM),
          new HumanMessage(
            `Compact to at most ${words} words:\n\n${tokens.truncate(text, COMPACT_INPUT_TOKENS)}`,
          ),
        ])
        .then(
          // The text parts only (reasoning models answer with content blocks).
          (r) => r.text,
          (e: unknown) => {
            log.warn(`compaction failed, the text is cut instead: ${errorMessage(e)}`);
            return '';
          },
        )
    : '';
  const ok = compacted.trim() !== '';
  return { text: tokens.truncate(ok ? compacted : text, tokens.maxInputTokens), compacted: ok };
};

/** Result of embedding one text: a vector of the model's size, or why there is none. */
export type Embedded = { readonly vector: readonly number[] } | { readonly error: string };

/** Accepts a vector only if it has the model's size and only finite numbers (pgvector rejects NaN/Infinity). */
const sized = (v: readonly number[] | undefined, dims: number): Embedded =>
  v?.length !== dims
    ? { error: `expected a ${dims}-dim vector, got ${v?.length ?? 'none'}` }
    : v.every(Number.isFinite)
      ? { vector: v }
      : { error: 'vector contains non-finite numbers' };

/**
 * Embeds all texts in one request. If that request fails, each text is embedded on its own, so one bad
 * input (or a per-request limit) only fails its own item instead of the whole batch.
 */
export const embedAll = async (
  provider: Pick<EmbeddingProvider, 'embeddings' | 'dimensions'>,
  texts: readonly string[],
  concurrency: number,
): Promise<readonly Embedded[]> => {
  const batch = await provider.embeddings.embedDocuments([...texts]).catch((e: unknown) => {
    log.warn(`batch of ${texts.length} failed, embedding one by one: ${errorMessage(e)}`);
    return null;
  });
  if (batch?.length === texts.length) return texts.map((_, i) => sized(batch[i], provider.dimensions));
  return mapLimit(texts, concurrency, (t) =>
    provider.embeddings.embedDocuments([t]).then(
      ([v]) => sized(v, provider.dimensions),
      (e: unknown) => ({ error: errorMessage(e) }),
    ),
  );
};

/**
 * Stage 3a: multilingual embeddings after translation (size depends on the provider). A finding waits for
 * the translation engine's result, or until it gave up (then the original text is embedded). Texts over
 * the model's input limit are compacted once first. Offline gives a skipped row with an empty vector.
 * Returns the number of finished (non-failed) rows written.
 */
export const runEmbeddingStage = async (
  db: PrismaService,
  provider: EmbeddingProvider | null,
  chat: ChatProvider | null,
  opts: {
    readonly engine: string;
    readonly translationEngine: string;
    readonly batchSize: number;
    readonly concurrency: number;
    readonly retryAfterSeconds: number;
  },
): Promise<number> => {
  const pending = await pendingFor(db, 'embedding', opts.engine, {
    limit: opts.batchSize,
    retryAfterSeconds: opts.retryAfterSeconds,
    afterTranslation: opts.translationEngine,
  });
  if (pending.length === 0) return 0;
  // A text that cannot even be measured fails its own row instead of the stage.
  const inputs = provider
    ? await mapLimit(pending, opts.concurrency, (m) =>
        fitEmbeddingInput(embeddingText(m), provider, chat).catch(
          (e: unknown): EmbeddingInput => ({ text: '', compacted: false, error: errorMessage(e) }),
        ),
      )
    : pending.map((): EmbeddingInput => ({ text: '', compacted: false }));
  const ready = inputs.flatMap((input, i) => (input.error === undefined ? [i] : []));
  const embedded = provider
    ? await embedAll(
        provider,
        ready.map((i) => inputs[i]?.text ?? ''),
        opts.concurrency,
      )
    : null;
  const results: readonly Embedded[] | null = embedded
    ? inputs.map((input, i) =>
        input.error !== undefined
          ? { error: input.error }
          : (embedded[ready.indexOf(i)] ?? { error: 'no embedding returned' }),
      )
    : null;
  const rows = pending.map((m, i) => {
    const r = results?.[i];
    const vector = r && 'vector' in r ? r.vector : null;
    return {
      id: m.id,
      status: !r ? 'skipped' : vector ? 'embedded' : 'failed',
      dims: vector ? vector.length : null,
      literal: vector ? `[${vector.join(',')}]` : null,
      compacted: inputs[i]?.compacted ?? false,
      error: r && 'error' in r ? r.error.slice(0, 1000) : null,
    };
  });
  // ON CONFLICT: another worker may have stored the same result meanwhile (partial unique index).
  await db.$executeRaw`
    INSERT INTO embedding (id, finding_id, engine, status, dims, vector, compacted, error)
    SELECT uuidv7(), u.finding_id, ${opts.engine}::text, u.status::"StageStatus", u.dims, u.vec::vector,
           u.compacted, u.error
    FROM unnest(${rows.map((r) => r.id)}::uuid[], ${rows.map((r) => r.status)}::text[],
                ${rows.map((r) => r.dims)}::int[], ${rows.map((r) => r.literal)}::text[],
                ${rows.map((r) => r.compacted)}::boolean[], ${rows.map((r) => r.error)}::text[])
      AS u(finding_id, status, dims, vec, compacted, error)
    ON CONFLICT DO NOTHING`;
  return rows.filter((r) => r.status !== 'failed').length;
};
