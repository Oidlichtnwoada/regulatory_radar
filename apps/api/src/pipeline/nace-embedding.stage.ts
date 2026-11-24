import { Logger } from '@nestjs/common';
import { errorMessage, hashOf } from '../common/fp.js';
import type { PrismaService } from '../db/prisma.service.js';
import { type NaceTaxonomy, naceDocument } from '../domain/nace.js';
import type { EmbeddingProvider } from '../llm/providers.js';
import { fitEmbeddingInput } from './embedding.stage.js';

/** Logger of the stage. */
const log = new Logger('NaceEmbedding');

/** Codes per embedding request. */
const CHUNK = 64;

/** A NACE code's embedding input and its content hash. */
interface NaceDoc {
  /** NACE code. */
  readonly code: string;
  /** English title + explanatory notes. */
  readonly text: string;
  /** Hash of the text: changed notes are embedded again. */
  readonly hash: string;
}

/**
 * Stage 3c: embeds every NACE Rev. 2.1 code (English title + explanatory notes) once per embedding engine.
 * Codes already stored for this engine and content hash are skipped, so a restart with the same provider and
 * model makes no embedding call; another model or changed notes embed again. Returns the number of codes
 * embedded (0 offline). A failed request stops the stage; the rest is retried next cycle.
 */
export const runNaceEmbeddingStage = async (
  db: PrismaService,
  tax: NaceTaxonomy,
  provider: EmbeddingProvider | null,
  opts: { readonly engine: string },
): Promise<number> => {
  if (!provider) return 0;
  const done = new Set(
    (
      await db.$queryRaw<{ key: string }[]>`
        SELECT code || '|' || content_hash AS key FROM nace_embedding WHERE engine = ${opts.engine}`
    ).map((r) => r.key),
  );
  const pending = tax.nodes
    .map((n): NaceDoc => {
      const text = naceDocument(n);
      return { code: n.code, text, hash: hashOf(text) };
    })
    .filter((d) => !done.has(`${d.code}|${d.hash}`));
  const chunks = Array.from({ length: Math.ceil(pending.length / CHUNK) }, (_, i) =>
    pending.slice(i * CHUNK, (i + 1) * CHUNK),
  );
  // Sequential requests (rate limits); the running state stays inside this reduce.
  const result = await chunks.reduce<Promise<{ readonly embedded: number; readonly failed: boolean }>>(
    async (previous, chunk) => {
      const state = await previous;
      if (state.failed) return state;
      try {
        const inputs = await Promise.all(chunk.map((d) => fitEmbeddingInput(d.text, provider, null)));
        const vectors = await provider.embeddings.embedDocuments(inputs.map((i) => i.text));
        if (vectors.some((v) => v.length !== provider.dimensions)) throw new Error('unexpected vector size');
        await db.$executeRaw`
          INSERT INTO nace_embedding (code, engine, content_hash, dims, vector, compacted)
          SELECT u.code, ${opts.engine}::text, u.hash, ${provider.dimensions}::int, u.vec::vector, u.compacted
          FROM unnest(${chunk.map((d) => d.code)}::text[], ${chunk.map((d) => d.hash)}::text[],
                      ${vectors.map((v) => `[${v.join(',')}]`)}::text[], ${inputs.map((i) => i.compacted)}::boolean[])
            AS u(code, hash, vec, compacted)
          ON CONFLICT (engine, code, content_hash) DO NOTHING`;
        return { embedded: state.embedded + chunk.length, failed: false };
      } catch (e) {
        log.warn(`stopped after ${state.embedded} codes, retrying next cycle: ${errorMessage(e)}`);
        return { ...state, failed: true };
      }
    },
    Promise.resolve({ embedded: 0, failed: false }),
  );
  return result.embedded;
};
