import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage, hashOf, sleep } from '../common/fp.js';
import { PrismaService } from '../db/prisma.service.js';
import { actionPointsOf, levelOf, refKey, validatedDraft } from '../domain/finding.js';
import type { Prisma } from '../generated/prisma/client.js';
import { type UnnormalisedRecord, unnormalisedRecords } from '../pipeline/repository.js';
import type { ConfiguredSource } from '../sources/registry.js';
import type { SourceAdapter, SourceBatch } from '../sources/source.types.js';
import { SOURCES } from '../tokens.js';

/** Counters of one stored batch (or a whole pass). */
interface BatchResult {
  /** Records received. */
  readonly fetched: number;
  /** New raw records. */
  readonly inserted: number;
  /** Records the normaliser rejected (`externalId: reason`); stored raw, without a finding. */
  readonly rejected: readonly string[];
}

/** Findings ready to insert plus the records that could not be normalised. */
interface Normalised {
  /** Finding rows. */
  readonly rows: readonly Prisma.FindingCreateManyInput[];
  /** Rejected records (`externalId: reason`). */
  readonly rejected: readonly string[];
}

/** Messages shown on the sources page are capped, so one bad file cannot flood the event log. */
const MAX_LISTED = 10;

/** Joins messages for a status event, naming how many were left out. */
const summarise = (messages: readonly string[]): string | null =>
  messages.length === 0
    ? null
    : [
        ...messages.slice(0, MAX_LISTED),
        ...(messages.length > MAX_LISTED ? [`… ${messages.length - MAX_LISTED} more`] : []),
      ].join('; ');

/**
 * Normalises stored raw records into finding rows. A record whose payload the adapter cannot map, or whose draft
 * violates the common schema, is rejected instead of failing the batch, so one bad record never blocks a source.
 * Pure apart from calling the adapter's pure `normalize`.
 */
const toFindings = (adapter: SourceAdapter, raws: readonly UnnormalisedRecord[]): Normalised => {
  const sourceId = adapter.descriptor.id;
  const results = raws.map((raw): Prisma.FindingCreateManyInput | string => {
    try {
      const draft = validatedDraft(
        adapter.normalize({ externalId: raw.externalId, payload: raw.payload as never }),
      );
      const row: Prisma.FindingCreateManyInput = {
        ...draft,
        rawRecordId: raw.id,
        sourceId,
        externalId: raw.externalId,
        level: levelOf(draft.jurisdiction),
        refKey: refKey(draft.ref),
        publishedOn: new Date(draft.publishedOn),
        deadline: draft.deadline ? new Date(draft.deadline) : null,
        eventDate: draft.eventDate ? new Date(draft.eventDate) : null,
        naceTags: [...draft.naceTags],
        topics: [...draft.topics],
        actionPoints: actionPointsOf(draft) as unknown as Prisma.InputJsonValue,
        attributes: draft.attributes as Prisma.InputJsonValue,
      };
      return row;
    } catch (e) {
      return `${raw.externalId}: ${errorMessage(e)}`;
    }
  });
  return {
    rows: results.filter((r): r is Prisma.FindingCreateManyInput => typeof r !== 'string'),
    rejected: results.filter((r): r is string => typeof r === 'string'),
  };
};

/** A raw record ready to insert. */
interface RawDraft {
  /** Source id. */
  readonly sourceId: string;
  /** Id of the item in the source. */
  readonly externalId: string;
  /** Hash of source, id and payload. */
  readonly contentHash: string;
  /** Payload as received. */
  readonly payload: Prisma.InputJsonValue;
}

/**
 * The records that are new versions: a record is kept when its hash differs from the latest stored (or earlier in
 * this batch) version of the same item. Unlike a global hash check, an item that changes back to an earlier payload
 * (A -> B -> A) becomes current again. Pure.
 */
export const newVersions = <T extends Pick<RawDraft, 'externalId' | 'contentHash'>>(
  records: readonly T[],
  latest: ReadonlyMap<string, string>,
): readonly T[] =>
  records.reduce<{ readonly kept: readonly T[]; readonly last: ReadonlyMap<string, string> }>(
    (acc, r) =>
      acc.last.get(r.externalId) === r.contentHash
        ? acc
        : { kept: [...acc.kept, r], last: new Map(acc.last).set(r.externalId, r.contentHash) },
    { kept: [], last: latest },
  ).kept;

/**
 * Deterministic ingestion: streams every enabled source continuously (pass, pause, pass ...),
 * stores raw payloads deduplicated by content hash, normalises new ones into findings and checkpoints
 * after each batch, so a restart resumes from the stored watermark.
 */
@Injectable()
export class IngestionService {
  /** Logger. */
  private readonly log = new Logger('Ingestion');

  /** Injects the database and the configured sources. */
  constructor(
    private readonly db: PrismaService,
    @Inject(SOURCES) private readonly sources: readonly ConfiguredSource[],
  ) {}

  /** Runs all enabled sources until the signal aborts. */
  async runForever(signal: AbortSignal): Promise<void> {
    const enabled = this.sources.filter((s) => s.enabled).map((s) => s.adapter);
    this.log.log(`streaming sources: ${enabled.map((a) => a.descriptor.id).join(', ') || '(none)'}`);
    await Promise.all(enabled.map((a) => this.loop(a, signal)));
  }

  /** Repeats passes of one source with its poll pause; an unexpected error (e.g. the database is briefly down) is logged and the next pass retries, so one source never stops the worker. */
  private async loop(adapter: SourceAdapter, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.runPass(adapter, signal).catch((e: unknown) =>
        this.log.error(`${adapter.descriptor.id}: pass failed: ${errorMessage(e)}`),
      );
      await sleep(adapter.descriptor.pollSeconds * 1000, signal);
    }
  }

  /**
   * One streaming pass of one source: retries earlier rejected records, then stores each batch, checkpoints it and
   * refreshes the read models. Status events go out when the pass starts and ends. Returns the summary.
   */
  async runPass(adapter: SourceAdapter, signal: AbortSignal): Promise<BatchResult> {
    const sourceId = adapter.descriptor.id;
    const startedAt = Date.now();
    const stored = await this.watermarkOf(sourceId);
    await this.db.sourceEvent.create({
      data: { sourceId, kind: 'started', message: `since ${stored?.toISOString() ?? 'start'}` },
    });
    // Mutable pass state, local to this I/O loop.
    const totals = { fetched: 0, inserted: 0, rejected: [] as string[], problems: [] as string[] };
    let watermark = stored;
    try {
      totals.rejected.push(...(await this.retryRejected(adapter)));
      for await (const batch of adapter.fetch(stored, signal)) {
        const result = await this.storeBatch(adapter, batch);
        totals.fetched += result.fetched;
        totals.inserted += result.inserted;
        totals.rejected.push(...result.rejected);
        totals.problems.push(...(batch.problems ?? []));
        // After a fetch problem the watermark must not pass the gap, so the missing part is retried next pass.
        // Rejected records do not block it: they are stored raw and re-normalised at the start of every pass.
        // The watermark only moves forward (overlapping re-scans start before it).
        if (totals.problems.length === 0 && (!watermark || batch.watermark > watermark)) {
          await this.db.sourceCheckpoint.create({ data: { sourceId, watermark: batch.watermark } });
          watermark = batch.watermark;
        }
        if (result.inserted > 0) await this.db.refreshFindings();
      }
      const issues = [...totals.problems, ...totals.rejected.map((r) => `rejected ${r}`)];
      await this.event(
        adapter,
        issues.length ? 'degraded' : 'completed',
        totals,
        startedAt,
        summarise(issues),
      );
    } catch (e) {
      this.log.error(`${sourceId}: ${errorMessage(e)}`);
      await this.event(
        adapter,
        totals.fetched > 0 ? 'degraded' : 'failed',
        totals,
        startedAt,
        errorMessage(e),
      );
    }
    return totals;
  }

  /** Re-normalises this source's raw records that were rejected earlier (e.g. after a fixed adapter); returns what is still rejected. */
  private async retryRejected(adapter: SourceAdapter): Promise<readonly string[]> {
    const pending = await unnormalisedRecords(this.db, adapter.descriptor.id);
    if (pending.length === 0) return [];
    const { rows, rejected } = toFindings(adapter, pending);
    const failed = await this.insertFindings(rows);
    if (rows.length > failed.length) await this.db.refreshFindings();
    return [...rejected, ...failed];
  }

  /** Appends a status event with the pass counters. */
  private async event(
    adapter: SourceAdapter,
    kind: 'completed' | 'degraded' | 'failed',
    totals: BatchResult,
    startedAt: number,
    message: string | null,
  ): Promise<void> {
    const { id } = adapter.descriptor;
    this.log.log(
      `${id}: ${kind}, fetched ${totals.fetched}, new ${totals.inserted}${message ? ` (${message})` : ''}`,
    );
    await this.db.sourceEvent.create({
      data: {
        sourceId: id,
        kind,
        fetched: totals.fetched,
        inserted: totals.inserted,
        duplicates: totals.fetched - totals.inserted,
        durationMs: Date.now() - startedAt,
        message: message?.slice(0, 2000) ?? null,
      },
    });
  }

  /**
   * Inserts finding rows in one statement; if the database refuses it, row by row, so one bad row is reported as
   * rejected (its raw record stays and is retried every pass) instead of blocking the source.
   */
  private async insertFindings(rows: readonly Prisma.FindingCreateManyInput[]): Promise<readonly string[]> {
    if (rows.length === 0) return [];
    const all = await this.db.finding.createMany({ data: [...rows], skipDuplicates: true }).then(
      () => true,
      () => false,
    );
    if (all) return [];
    const results = await Promise.all(
      rows.map((row) =>
        this.db.finding.createMany({ data: [row], skipDuplicates: true }).then(
          () => null,
          (e: unknown) => `${row.externalId}: could not be stored: ${errorMessage(e).slice(0, 300)}`,
        ),
      ),
    );
    return results.filter((r): r is string => r !== null);
  }

  /** Highest stored watermark of a source (by value, so a slower concurrent pass can never move it back). */
  private async watermarkOf(sourceId: string): Promise<Date | null> {
    const cp = await this.db.sourceCheckpoint.findFirst({
      where: { sourceId },
      orderBy: { watermark: 'desc' },
    });
    return cp?.watermark ?? null;
  }

  /**
   * Stores one batch: the raw records that are new versions of their item (an advisory lock per source serialises
   * concurrent passes, so the latest-version check cannot race), then the findings of those that normalise. A crash
   * between the two leaves raw records without findings, which the next pass normalises.
   */
  private async storeBatch(adapter: SourceAdapter, batch: SourceBatch): Promise<BatchResult> {
    const sourceId = adapter.descriptor.id;
    const raws: readonly RawDraft[] = batch.records.map((r) => ({
      sourceId,
      externalId: r.externalId,
      contentHash: hashOf({ sourceId, externalId: r.externalId, payload: r.payload }),
      payload: r.payload as Prisma.InputJsonValue,
    }));
    if (raws.length === 0) return { fetched: 0, inserted: 0, rejected: [] };
    const created = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`raw_record:${sourceId}`}))`;
      const latest = await tx.$queryRaw<{ external_id: string; content_hash: string }[]>`
        SELECT DISTINCT ON (external_id) external_id, content_hash FROM raw_record
        WHERE source_id = ${sourceId} AND external_id = ANY(${[...new Set(raws.map((r) => r.externalId))]}::text[])
        ORDER BY external_id, stream_seq DESC`;
      const fresh = newVersions(raws, new Map(latest.map((l) => [l.external_id, l.content_hash])));
      return fresh.length > 0 ? tx.rawRecord.createManyAndReturn({ data: [...fresh] }) : [];
    });
    const { rows, rejected } = toFindings(adapter, created);
    const failed = await this.insertFindings(rows);
    return { fetched: raws.length, inserted: created.length, rejected: [...rejected, ...failed] };
  }
}
