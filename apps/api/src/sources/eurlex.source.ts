import type { Json } from '../common/fp.js';
import { addDays, errorMessage, isoDay, sleep } from '../common/fp.js';
import type { FindingDraft } from '../domain/finding.js';
import { politeGet } from './http.js';
import { effectiveSince, type SourceAdapter, type SourceBatch } from './source.types.js';

/** CELLAR SPARQL endpoint of the EU Publications Office. */
const ENDPOINT = 'https://publications.europa.eu/webapi/rdf/sparql';

/** Options of the EUR-Lex adapter. */
export interface EurlexOptions {
  /** Optional time filter (inclusive start day). */
  readonly since: Date | null;
  /** Start this many days back when neither `since` nor a watermark exist. */
  readonly lookbackDays: number;
  /** Re-scan this many days before the watermark: CELLAR adds acts days after their document date. */
  readonly rescanDays: number;
  /** Regex on the CELEX number (sector 3 = adopted acts, sector 5 PC = Commission proposals). */
  readonly celexPattern: string;
  /** Results per SPARQL page. */
  readonly pageSize: number;
  /** Pause between passes. */
  readonly pollSeconds: number;
  /** Per-request timeout. */
  readonly timeoutMs: number;
}

/** One row of the SPARQL result (raw payload of a record). */
type CellarRow = {
  readonly celex: string;
  readonly date: string;
  readonly title: string;
  readonly subjects: readonly string[];
};

/** SPARQL query for one day and one page; the CELEX regex is validated to contain no quotes. */
export const cellarQuery = (day: string, pattern: string, limit: number, offset: number): string => {
  if (/["\\]/.test(pattern))
    throw new Error('SOURCE_EURLEX_CELEX_PATTERN must not contain quotes or backslashes');
  return `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?celex ?date ?title (GROUP_CONCAT(DISTINCT ?subject; separator="|") AS ?subjects) WHERE {
  ?work cdm:resource_legal_id_celex ?celex ; cdm:work_date_document ?date .
  FILTER(?date = "${day}"^^xsd:date)
  FILTER(REGEX(STR(?celex), "${pattern}"))
  ?expr cdm:expression_belongs_to_work ?work ; cdm:expression_title ?title ;
        cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> .
  OPTIONAL { ?work cdm:work_is_about_concept_eurovoc ?c . ?c skos:prefLabel ?subject . FILTER(lang(?subject) = "en") }
} GROUP BY ?celex ?date ?title ORDER BY ?celex LIMIT ${limit} OFFSET ${offset}`;
};

/**
 * First day of a pass: the stored watermark minus the re-scan window (acts dated earlier can still be indexed late;
 * the overlap is harmless thanks to content-hash deduplication), never before the configured start; without a
 * watermark, the configured start or the lookback. Pure.
 */
export const eurlexStart = (
  opts: Pick<EurlexOptions, 'since' | 'lookbackDays' | 'rescanDays'>,
  watermark: Date | null,
  now: Date,
): Date =>
  effectiveSince(opts.since, watermark && addDays(watermark, -opts.rescanDays)) ??
  addDays(now, -opts.lookbackDays);

/** Document type from the CELEX number and title (delegated / implementing acts are named in the title). */
export const eurlexDocType = (celex: string, title: string): string => {
  const t = title.toLowerCase();
  if (celex.startsWith('5')) return 'legislative_proposal';
  if (t.includes('delegated')) return 'delegated_act';
  if (t.includes('implementing')) return 'implementing_act';
  return (
    ({ R: 'regulation', L: 'directive', D: 'decision' } as Record<string, string>)[celex.charAt(5)] ?? 'act'
  );
};

/**
 * EUR-Lex via CELLAR SPARQL (EU level, no key). Streams day by day from the watermark to today,
 * paging inside a day and re-scanning a few days before the watermark; the watermark advances after each completed
 * day, and a failed day is reported as a problem of its batch.
 */
export const eurlexSource = (opts: EurlexOptions): SourceAdapter => ({
  descriptor: {
    id: 'eurlex',
    name: 'EUR-Lex (Publications Office CELLAR SPARQL)',
    kind: 'eurlex_cellar',
    level: 'eu',
    country: null,
    requiresNetwork: true,
    pollSeconds: opts.pollSeconds,
    filters: {
      since: opts.since ? isoDay(opts.since) : null,
      lookbackDays: opts.lookbackDays,
      rescanDays: opts.rescanDays,
      celexPattern: opts.celexPattern,
      language: 'en',
    },
  },
  async *fetch(since, signal) {
    const start = eurlexStart(opts, since, new Date());
    const days = Array.from(
      { length: Math.max(0, Math.floor((Date.now() - start.getTime()) / 86_400_000)) + 1 },
      (_, i) => addDays(new Date(`${isoDay(start)}T00:00:00Z`), i),
    );
    for (const day of days) {
      if (signal.aborted) return;
      // A failed day becomes a batch problem (like BOE), so the pass goes on and the watermark stays before the gap.
      yield await fetchDay(isoDay(day), opts, signal).catch(
        (e: unknown): SourceBatch => ({
          records: [],
          watermark: addDays(day, -1),
          problems: [`${isoDay(day)}: ${errorMessage(e)}`],
        }),
      );
      await sleep(1000, signal);
    }
  },
  normalize: ({ payload }): FindingDraft => {
    const r = payload as unknown as CellarRow;
    return {
      channel: 'eu_eurlex',
      jurisdiction: 'EU',
      language: 'en',
      docType: eurlexDocType(r.celex, r.title),
      stage: r.celex.startsWith('5') ? 'proposal' : 'adopted',
      title: r.title,
      summary: null,
      publishedOn: r.date,
      deadline: null,
      deadlineKind: null,
      eventDate: null,
      ref: r.celex,
      relatedTo: null,
      naceTagsStated: false,
      naceTags: [],
      topics: r.subjects,
      url: `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${r.celex}`,
      attributes: {},
    };
  },
});

/** Fetches all pages of one day. */
const fetchDay = async (day: string, opts: EurlexOptions, signal: AbortSignal): Promise<SourceBatch> => {
  type Binding = Readonly<Record<string, { readonly value: string }>>;
  const page = async (offset: number): Promise<readonly CellarRow[]> => {
    const url = `${ENDPOINT}?query=${encodeURIComponent(cellarQuery(day, opts.celexPattern, opts.pageSize, offset))}`;
    const res = await politeGet(url, {
      timeoutMs: opts.timeoutMs,
      signal,
      headers: { Accept: 'application/sparql-results+json' },
    });
    if (!res.ok) throw new Error(`EUR-Lex SPARQL HTTP ${res.status}`);
    const body = (await res.json()) as { results: { bindings: readonly Binding[] } };
    const rows = body.results.bindings.map(
      (b): CellarRow => ({
        celex: b.celex?.value ?? '',
        date: b.date?.value ?? day,
        title: (b.title?.value ?? '').replace(/\s+/g, ' ').trim(),
        subjects: (b.subjects?.value ?? '').split('|').filter(Boolean).sort(),
      }),
    );
    return rows.length === opts.pageSize ? [...rows, ...(await page(offset + opts.pageSize))] : rows;
  };
  const rows = await page(0);
  return {
    records: rows.map((r) => ({ externalId: r.celex, payload: r as unknown as Json })),
    watermark: new Date(`${day}T00:00:00Z`),
  };
};
