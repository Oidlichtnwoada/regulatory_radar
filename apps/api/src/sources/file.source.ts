import { readFile } from 'node:fs/promises';
import type { Json } from '../common/fp.js';
import { isoDay, parseDay } from '../common/fp.js';
import { normalizeStage } from '../domain/finding.js';
import type { NaceTaxonomy } from '../domain/nace.js';
import { mapRev2Codes } from '../domain/nace-rev2.js';
import type { SourceAdapter, SourceBatch, SourceRecord } from './source.types.js';

/** Shape of one item of data/items.json (the seed / file source schema). */
type SeedItem = {
  readonly id: string;
  readonly channel: string;
  readonly jurisdiction: string;
  readonly language: string;
  readonly doc_type: string;
  readonly stage: string;
  readonly title: string;
  readonly summary: string | null;
  readonly published: string;
  readonly deadline: string | null;
  readonly deadline_kind: string | null;
  readonly event_date: string | null;
  readonly ref: string | null;
  readonly related_to: string | null;
  readonly nace_tags: readonly string[] | null;
  readonly topics: readonly string[] | null;
  readonly url?: string | null;
};

/** Options of the file source. */
export interface FileSourceOptions {
  /** Path of the JSON array file. */
  readonly path: string;
  /** Optional time filter: only items published on or after this day. */
  readonly since: Date | null;
  /** Pause between re-reads of the file. */
  readonly pollSeconds: number;
  /** Records per streamed batch. */
  readonly batchSize: number;
}

/**
 * Watermark after each batch of a file streamed in FILE order (dates are not sorted): the earliest date
 * still to come, so a restart from it (inclusive) misses nothing; after the last batch, the latest date.
 * Non-decreasing by construction. Pure.
 */
export const fileWatermarks = (published: readonly string[], batchSize: number): readonly string[] => {
  const batches = Math.ceil(published.length / batchSize);
  const latest = published.toSorted().at(-1) ?? '';
  return Array.from({ length: batches }, (_, b) => {
    const rest = published.slice((b + 1) * batchSize);
    return rest.length ? (rest.toSorted()[0] ?? latest) : latest;
  });
};

/** True for an array element that can be streamed (an object with a non-empty string id). */
const isSeedItem = (i: unknown): i is SeedItem =>
  typeof i === 'object' &&
  i !== null &&
  typeof (i as { id?: unknown }).id === 'string' &&
  (i as { id: string }).id !== '';

/** True for a YYYY-MM-DD string (used for watermarks; full validation happens in the normaliser). */
const isDayString = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * File source: streams a JSON array in the seed schema (data/items.json) in file order, in batches, and
 * re-reads it in full every poll, so edits or a replaced file (items.next.json) stream in. Needs no network.
 */
export const fileSource = (tax: NaceTaxonomy, opts: FileSourceOptions): SourceAdapter => ({
  descriptor: {
    id: 'file',
    name: `Seed file (${opts.path.split('/').at(-1)})`,
    kind: 'file',
    level: 'eu',
    country: null,
    requiresNetwork: false,
    pollSeconds: opts.pollSeconds,
    filters: { path: opts.path, since: opts.since ? isoDay(opts.since) : null, batchSize: opts.batchSize },
  },
  // The whole file streams on every pass, not from the stored watermark: it is local and cheap, deduplication skips
  // unchanged items, and an edited or added item dated before the watermark must still stream in.
  async *fetch() {
    const parsed: unknown = JSON.parse(await readFile(opts.path, 'utf8'));
    const all: readonly unknown[] = Array.isArray(parsed) ? parsed : [];
    const problems = [
      ...(Array.isArray(parsed) ? [] : [`${opts.path} is not a JSON array`]),
      ...all.flatMap((i, n) => (isSeedItem(i) ? [] : [`item ${n + 1} has no id`])),
    ];
    const since = opts.since ? isoDay(opts.since) : null;
    // Items with a malformed date are kept: the normaliser rejects them visibly instead of dropping them here.
    const selected = all
      .filter(isSeedItem)
      .filter((i) => !since || !isDayString(i.published) || i.published >= since);
    const watermarks = fileWatermarks(
      selected.map((i) => (isDayString(i.published) ? i.published : '')),
      opts.batchSize,
    );
    const batches = watermarks.map(
      (watermark, b): SourceBatch => ({
        records: selected
          .slice(b * opts.batchSize, (b + 1) * opts.batchSize)
          .map((i): SourceRecord => ({ externalId: i.id, payload: i as unknown as Json })),
        watermark: parseDay(watermark) ?? opts.since ?? new Date(0),
      }),
    );
    const [first = { records: [], watermark: opts.since ?? new Date(0) }, ...rest] = batches;
    yield* [{ ...first, ...(problems.length ? { problems } : {}) }, ...rest];
  },
  normalize: ({ payload }) => {
    const i = payload as unknown as SeedItem;
    const tags = i.nace_tags ?? [];
    return {
      channel: i.channel,
      jurisdiction: i.jurisdiction.toUpperCase(),
      language: i.language,
      docType: i.doc_type,
      stage: normalizeStage(i.stage),
      title: i.title,
      summary: i.summary,
      publishedOn: i.published,
      deadline: i.deadline,
      deadlineKind: i.deadline_kind,
      eventDate: i.event_date,
      ref: i.ref,
      relatedTo: i.related_to,
      naceTagsStated: i.nace_tags !== null,
      naceTags: [
        // Seed tags are NACE Rev. 2: mapped with Eurostat's correspondence (one tag may become several codes).
        ...mapRev2Codes(tax, tags),
      ],
      topics: i.topics ?? [],
      url: i.url ?? null,
      attributes: { naceTagsOriginal: tags as Json },
    };
  },
});
