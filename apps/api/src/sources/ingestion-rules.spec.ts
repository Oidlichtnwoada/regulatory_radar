import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatedDraft } from '../domain/finding.js';
import { loadTaxonomy } from '../domain/nace.js';
import { eurlexStart } from './eurlex.source.js';
import { fileSource } from './file.source.js';

const DATA = join(import.meta.dirname, '../../../../data');
const tax = loadTaxonomy(join(DATA, 'nace_rev2_1.csv'));
const seed = JSON.parse(readFileSync(join(DATA, 'items.json'), 'utf8')) as Record<string, unknown>[];
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const signal = new AbortController().signal;

/** A file source over a temporary copy of the given items. */
const sourceOver = (items: readonly unknown[]) => {
  const path = join(mkdtempSync(join(tmpdir(), 'radar-')), 'items.json');
  writeFileSync(path, JSON.stringify(items));
  return fileSource(tax, { path, since: null, pollSeconds: 1, batchSize: 10 });
};

describe('normalisation into the common schema', () => {
  const source = sourceOver(seed);
  const draftOf = (patch: Record<string, unknown>) =>
    source.normalize({ externalId: 'x', payload: { ...seed[0], ...patch } as never });

  it('accepts every seed item unchanged', () => {
    for (const item of seed) {
      const draft = source.normalize({ externalId: String(item.id), payload: item as never });
      expect(validatedDraft(draft)).toEqual(draft);
    }
  });

  it('normalises country and language codes to ISO 3166-1 and ISO 639-1', () => {
    expect(validatedDraft(draftOf({ jurisdiction: 'el', language: 'EL' }))).toMatchObject({
      jurisdiction: 'GR',
      language: 'el',
    });
  });

  it('rejects drafts outside the common schema with every reason', () => {
    expect(() =>
      validatedDraft(draftOf({ jurisdiction: 'XX', language: 'klingon', published: '2026-02-30' })),
    ).toThrow(/jurisdiction "XX".*language "klingon".*publishedOn "2026-02-30"/);
    expect(() => validatedDraft(draftOf({ title: ' ', deadline: '30.11.2026' }))).toThrow(
      /title is empty.*deadline/,
    );
  });
});

describe('file source', () => {
  it('streams the whole file on every pass, so an edited item dated before the watermark still arrives', async () => {
    const batches = await Array.fromAsync(sourceOver(seed).fetch(day('2026-11-15'), signal));
    expect(batches.flatMap((b) => b.records)).toHaveLength(seed.length);
    expect(batches.at(-1)?.watermark.toISOString().slice(0, 10)).toBe('2026-11-15');
  });

  it('reports items without an id as a problem instead of failing the pass', async () => {
    const batches = await Array.fromAsync(
      sourceOver([seed[0], { title: 'no id' }, null]).fetch(null, signal),
    );
    expect(batches.flatMap((b) => b.records.map((r) => r.externalId))).toEqual([seed[0]?.id]);
    expect(batches[0]?.problems).toEqual(['item 2 has no id', 'item 3 has no id']);
  });
});

describe('EUR-Lex pass start', () => {
  const opts = { since: null, lookbackDays: 14, rescanDays: 7 };
  const now = day('2026-11-24');

  it('re-scans days before the watermark, because CELLAR indexes some acts late', () => {
    expect(eurlexStart(opts, day('2026-11-20'), now)).toEqual(day('2026-11-13'));
  });

  it('never starts before the configured start, and uses the lookback without a watermark', () => {
    expect(eurlexStart({ ...opts, since: day('2026-11-18') }, day('2026-11-20'), now)).toEqual(
      day('2026-11-18'),
    );
    expect(eurlexStart(opts, null, now)).toEqual(day('2026-11-10'));
  });
});
