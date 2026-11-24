import { Logger } from '@nestjs/common';
import { hashOf } from '../common/fp.js';
import type { PrismaService } from '../db/prisma.service.js';
import { type NaceTaxonomy, naceDocument } from '../domain/nace.js';
import type { EmbeddingProvider } from '../llm/providers.js';
import { embedAll, fitEmbeddingInput } from './embedding.stage.js';

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
 * embedded (0 offline). A failed chunk is embedded code by code, so one code the model refuses only skips
 * itself (logged, retried next cycle) instead of blocking every code after it.
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
  // Sequential requests (rate limits); the running count stays inside this reduce.
  return chunks.reduce<Promise<number>>(async (previous, chunk) => {
    const embedded = await previous;
    const inputs = await Promise.all(chunk.map((d) => fitEmbeddingInput(d.text, provider, null)));
    const results = await embedAll(
      provider,
      inputs.map((i) => i.text),
      1,
    );
    const ok = chunk.flatMap((d, i) => {
      const r = results[i];
      return r && 'vector' in r ? [{ ...d, vector: r.vector, compacted: inputs[i]?.compacted ?? false }] : [];
    });
    const failed = chunk.filter((_, i) => {
      const r = results[i];
      return !(r && 'vector' in r);
    });
    if (failed.length > 0) {
      const first = results.find((r): r is { readonly error: string } => 'error' in r);
      log.warn(`${failed.length} codes not embedded, retried next cycle: ${first?.error ?? 'unknown error'}`);
    }
    if (ok.length === 0) return embedded;
    await db.$executeRaw`
      INSERT INTO nace_embedding (code, engine, content_hash, dims, vector, compacted)
      SELECT u.code, ${opts.engine}::text, u.hash, ${provider.dimensions}::int, u.vec::vector, u.compacted
      FROM unnest(${ok.map((d) => d.code)}::text[], ${ok.map((d) => d.hash)}::text[],
                  ${ok.map((d) => `[${d.vector.join(',')}]`)}::text[], ${ok.map((d) => d.compacted)}::boolean[])
        AS u(code, hash, vec, compacted)
      ON CONFLICT (engine, code, content_hash) DO NOTHING`;
    return embedded + ok.length;
  }, Promise.resolve(0));
};
