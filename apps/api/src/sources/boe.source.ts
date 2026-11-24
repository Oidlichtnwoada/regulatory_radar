import type { Json } from '../common/fp.js';
import { addDays, errorMessage, isoDay, sleep } from '../common/fp.js';
import type { FindingDraft } from '../domain/finding.js';
import { politeGet } from './http.js';
import { effectiveSince, type SourceAdapter, type SourceBatch, type SourceRecord } from './source.types.js';

/** Options of the BOE adapter. */
export interface BoeOptions {
  /** Optional time filter (inclusive start day). */
  readonly since: Date | null;
  /** Start this many days back when neither `since` nor a watermark exist. */
  readonly lookbackDays: number;
  /** Section codes to keep (1 = Disposiciones generales). */
  readonly sections: readonly string[];
  /** Department names (substring, case-insensitive) to keep; empty = all. */
  readonly departments: readonly string[];
  /** Pause between passes. */
  readonly pollSeconds: number;
  /** Per-request timeout. */
  readonly timeoutMs: number;
}

/** Raw payload of one BOE item (flattened from the daily summary). */
type BoeItem = {
  readonly identificador: string;
  readonly titulo: string;
  readonly fecha: string;
  readonly seccion: string;
  readonly departamento: string;
  readonly epigrafe: string | null;
  readonly url_html: string | null;
};

/** A value that the BOE JSON gives either as one object or as a list. */
type OneOrMany<T> = T | readonly T[] | undefined;
/** Normalises OneOrMany to an array. */
const many = <T>(v: OneOrMany<T>): readonly T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v as T]);

/** Item node of the daily summary. */
type SummaryItem = {
  readonly identificador: string;
  readonly titulo: string;
  readonly url_html?: string;
};
/** Department node of the daily summary. */
type SummaryDepartment = {
  readonly nombre: string;
  readonly epigrafe?: OneOrMany<{ readonly nombre: string; readonly item?: OneOrMany<SummaryItem> }>;
  readonly item?: OneOrMany<SummaryItem>;
};

/** Flattens one daily summary into items, applying the section and department filters; pure. */
export const flattenSummary = (
  day: string,
  body: {
    data?: {
      sumario?: {
        diario?: OneOrMany<{
          seccion?: OneOrMany<{ codigo: string; departamento?: OneOrMany<SummaryDepartment> }>;
        }>;
      };
    };
  },
  sections: readonly string[],
  departments: readonly string[],
): readonly BoeItem[] =>
  many(body.data?.sumario?.diario)
    .flatMap((d) => many(d.seccion))
    .filter((s) => sections.length === 0 || sections.includes(s.codigo))
    .flatMap((s) =>
      many(s.departamento)
        .filter(
          (dep) =>
            departments.length === 0 ||
            departments.some((x) => dep.nombre.toLowerCase().includes(x.toLowerCase())),
        )
        .flatMap((dep) =>
          [
            ...many(dep.item).map((item) => ({ item, epigrafe: null as string | null })),
            ...many(dep.epigrafe).flatMap((e) => many(e.item).map((item) => ({ item, epigrafe: e.nombre }))),
          ].map(({ item, epigrafe }) => ({
            identificador: item.identificador,
            titulo: item.titulo,
            fecha: day,
            seccion: s.codigo,
            departamento: dep.nombre,
            epigrafe,
            url_html: item.url_html ?? null,
          })),
        ),
    );

/** Document type from the leading words of a BOE title. */
export const boeDocType = (title: string): string =>
  (
    [
      [/^real decreto-ley/i, 'royal_decree_law'],
      [/^real decreto legislativo/i, 'royal_legislative_decree'],
      [/^real decreto/i, 'royal_decree'],
      [/^ley org[aá]nica/i, 'organic_act'],
      [/^ley/i, 'act'],
      [/^orden/i, 'ministerial_order'],
      [/^resoluci[oó]n/i, 'resolution'],
      [/^circular/i, 'circular'],
      [/^instrumento de ratificaci[oó]n/i, 'ratification'],
      [/^acuerdo/i, 'agreement'],
    ] as const
  ).find(([re]) => re.test(title))?.[1] ?? 'notice';

/** Spain's Boletín Oficial del Estado open-data API (national, no key): one request per day. */
export const boeSource = (opts: BoeOptions): SourceAdapter => ({
  descriptor: {
    id: 'es_boe',
    name: 'Boletín Oficial del Estado (open data API)',
    kind: 'es_boe',
    level: 'national',
    country: 'ES',
    requiresNetwork: true,
    pollSeconds: opts.pollSeconds,
    filters: {
      since: opts.since ? isoDay(opts.since) : null,
      lookbackDays: opts.lookbackDays,
      sections: [...opts.sections],
      departments: [...opts.departments],
    },
  },
  async *fetch(since, signal) {
    const start = effectiveSince(opts.since, since) ?? addDays(new Date(), -opts.lookbackDays);
    const count = Math.max(0, Math.floor((Date.now() - start.getTime()) / 86_400_000)) + 1;
    for (const day of Array.from({ length: count }, (_, i) => isoDay(addDays(start, i)))) {
      if (signal.aborted) return;
      yield await fetchDay(day, opts, signal);
      await sleep(1000, signal);
    }
  },
  normalize: ({ payload }): FindingDraft => {
    const i = payload as unknown as BoeItem;
    return {
      channel: 'national_gazette',
      jurisdiction: 'ES',
      language: 'es',
      docType: boeDocType(i.titulo),
      stage: 'adopted',
      title: i.titulo,
      summary: null,
      publishedOn: i.fecha,
      deadline: null,
      deadlineKind: null,
      eventDate: null,
      ref: i.identificador,
      relatedTo: null,
      naceTagsStated: false,
      naceTags: [],
      topics: [i.departamento, ...(i.epigrafe ? [i.epigrafe] : [])],
      url: i.url_html,
      attributes: { section: i.seccion },
    };
  },
});

/** Fetches one day's summary; 404 means no issue that day, other failures degrade the run. */
const fetchDay = async (day: string, opts: BoeOptions, signal: AbortSignal): Promise<SourceBatch> => {
  const url = `https://www.boe.es/datosabiertos/api/boe/sumario/${day.replaceAll('-', '')}`;
  const watermark = new Date(`${day}T00:00:00Z`);
  try {
    const res = await politeGet(url, {
      timeoutMs: opts.timeoutMs,
      signal,
      headers: { Accept: 'application/json' },
    });
    if (res.status === 404) return { records: [], watermark };
    if (!res.ok)
      return { records: [], watermark: addDays(watermark, -1), problems: [`${day}: HTTP ${res.status}`] };
    const items = flattenSummary(
      day,
      (await res.json()) as Parameters<typeof flattenSummary>[1],
      opts.sections,
      opts.departments,
    );
    return {
      records: items.map(
        (i): SourceRecord => ({ externalId: i.identificador, payload: i as unknown as Json }),
      ),
      watermark,
    };
  } catch (e) {
    return { records: [], watermark: addDays(watermark, -1), problems: [`${day}: ${errorMessage(e)}`] };
  }
};
