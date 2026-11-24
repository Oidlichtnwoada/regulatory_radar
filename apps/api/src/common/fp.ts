import { createHash } from 'node:crypto';

/** JSON value as stored in JSONB columns. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** Serialises a value with sorted object keys so that equal content always gives the same string. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

/** SHA-256 hex digest of the canonical JSON of a value. */
export const hashOf = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Removes duplicates by key, keeping the first occurrence and the input order. */
export const uniqBy = <T>(items: readonly T[], key: (item: T) => string): readonly T[] =>
  [...new Map(items.map((item) => [key(item), item] as const).reverse()).values()].reverse();

/** Stable comparison helper for sort(): compares by a list of key extractors in order. */
export const compareBy =
  <T>(...keys: readonly ((item: T) => string | number)[]) =>
  (a: T, b: T): number =>
    keys.reduce((acc, key) => {
      if (acc !== 0) return acc;
      const [x, y] = [key(a), key(b)];
      return x < y ? -1 : x > y ? 1 : 0;
    }, 0);

/** ISO date (YYYY-MM-DD) of a Date in UTC. */
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Parses an ISO date (YYYY-MM-DD) as UTC midnight; null/undefined/empty stay null. */
export const parseDay = (s: string | null | undefined): Date | null =>
  s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null;

/** Adds whole days to a date (returns a new Date). */
export const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * 86_400_000);

/** Resolves after the given milliseconds unless the signal aborts first. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Maps over items with at most `limit` promises in flight; results keep the input order. A pool, not
 * fixed chunks: a slow item does not hold back the next ones.
 */
export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<readonly R[]> => {
  // Contained local state: result slots and the shared cursor of the workers.
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
};

/** Lower-cases and strips diacritics so that multilingual matching is accent-insensitive. */
export const foldText = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ł/g, 'l')
    .replace(/ß/g, 'ss')
    .toLowerCase();

/** Formats an unknown error for logs and status rows. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
