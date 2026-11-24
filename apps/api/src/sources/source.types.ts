import type { Json } from '../common/fp.js';
import type { FindingDraft } from '../domain/finding.js';

/** One item exactly as delivered by a source. */
export interface SourceRecord {
  /** Item id inside the source. */
  readonly externalId: string;
  /** Raw payload (stored verbatim as JSONB, hashed for deduplication). */
  readonly payload: Json;
}

/** A batch of records plus the point in time up to which the source is complete after this batch. */
export interface SourceBatch {
  /** Records of this batch. */
  readonly records: readonly SourceRecord[];
  /** Streaming is complete up to here once the batch is stored. */
  readonly watermark: Date;
  /** Partial failures that make the run degraded (e.g. one day of a gazette did not answer). */
  readonly problems?: readonly string[];
}

/** Static description of a configured source (shown on the status page). */
export interface SourceDescriptor {
  /** Stable id (stored with every record). */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Adapter kind. */
  readonly kind: 'file' | 'eurlex_cellar' | 'es_boe';
  /** eu or national. */
  readonly level: 'eu' | 'national';
  /** Country of a national source. */
  readonly country: string | null;
  /** Whether the source needs internet access. */
  readonly requiresNetwork: boolean;
  /** Pause between two streaming passes. */
  readonly pollSeconds: number;
  /** Effective filters (for display; the adapter applies them). */
  readonly filters: { readonly [key: string]: Json };
}

/**
 * The seam every source implements (seed file and live adapters alike). `fetch` streams one pass
 * starting at `since` (inclusive; overlap is harmless thanks to content-hash deduplication);
 * `normalize` maps a raw record onto the common schema deterministically.
 */
export interface SourceAdapter {
  /** Description and effective filters. */
  readonly descriptor: SourceDescriptor;
  /** Streams batches from `since` (null = from the configured start). */
  fetch(since: Date | null, signal: AbortSignal): AsyncIterable<SourceBatch>;
  /** Pure mapping of one raw record to the common schema. */
  normalize(record: SourceRecord): FindingDraft;
}

/** Latest of the configured start and the stored watermark (both optional). */
export const effectiveSince = (configured: Date | null, watermark: Date | null): Date | null =>
  configured && watermark ? (configured > watermark ? configured : watermark) : (configured ?? watermark);
