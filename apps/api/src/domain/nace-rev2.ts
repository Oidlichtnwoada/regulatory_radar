import { readFileSync } from 'node:fs';
import type { NaceNode } from './nace.js';

/** A Rev. 2.1 code that only partly corresponds (it also receives activities from other Rev. 2 classes). */
export interface PartialTarget {
  /** Rev. 2.1 code. */
  readonly code: string;
  /** Rev. 2 classes outside the mapped code that also flow into it. */
  readonly alsoFrom: readonly string[];
}

/** Result of mapping one Rev. 2 code. */
export interface Rev2Mapping {
  /** The Rev. 2 code as given (e.g. G47). */
  readonly rev2: string;
  /** Minimal Rev. 2.1 selection covering every activity of the Rev. 2 code (whole groups/divisions where possible). */
  readonly codes: readonly string[];
  /** True when the selection covers exactly the same activities (nothing else flows in). */
  readonly exact: boolean;
  /** Selected Rev. 2.1 codes that also contain activities from other Rev. 2 codes. */
  readonly partial: readonly PartialTarget[];
}

/**
 * Eurostat's official correspondence NACE Rev. 2 -> Rev. 2.1 (data/nace_rev2_to_rev2_1.csv, from EU Vocabularies
 * NACE2_NACE2.1), precomputed at load time for every Rev. 2 division, group and class, so that mapping a code during
 * ingestion is a single map lookup.
 */
export interface Rev2Correspondence {
  /** Rev. 2 digits (24, 24.4, 24.41) -> mapping; the section letter is ignored because it changed between revisions. */
  readonly byDigits: ReadonlyMap<string, Omit<Rev2Mapping, 'rev2'>>;
}

/** What the correspondence needs from the Rev. 2.1 taxonomy. */
type TaxonomyParts = { readonly nodes: readonly NaceNode[]; readonly byDigits: ReadonlyMap<string, string> };

/**
 * The smallest set of Rev. 2.1 codes whose classes are exactly `classes`: a group or division replaces its classes
 * when all of them are included. `classesOf` gives the classes under every code. Pure.
 */
export const compressCodes = (
  nodes: readonly NaceNode[],
  classesOf: ReadonlyMap<string, readonly string[]>,
  classes: ReadonlySet<string>,
): readonly string[] => {
  const covered = (code: string) => {
    const under = classesOf.get(code) ?? [];
    return under.length > 0 && under.every((c) => classes.has(c));
  };
  return nodes.filter((n) => covered(n.code) && !(n.parent && covered(n.parent))).map((n) => n.code);
};

/** Loads the class-level correspondence and precomputes the mapping of every Rev. 2 division, group and class. */
export const loadRev2Correspondence = (csvPath: string, tax: TaxonomyParts): Rev2Correspondence => {
  const links = readFileSync(csvPath, 'utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .flatMap((line) => {
      const [rev2 = '', digits = ''] = line.split(',');
      const code = tax.byDigits.get(digits);
      return code ? [{ rev2, code }] : [];
    });
  const targetsOf = Map.groupBy(links, (l) => l.rev2);
  const sourcesOf = Map.groupBy(links, (l) => l.code);
  const classesOf = new Map(
    tax.nodes.map((n) => [
      n.code,
      tax.nodes.filter((c) => c.level === 'class' && c.code.startsWith(n.code)).map((c) => c.code),
    ]),
  );
  // Every Rev. 2 class belongs to its division (24), its group (24.4) and itself (24.41).
  const sourcesByPrefix = Map.groupBy(
    [...targetsOf.keys()].flatMap((cls) =>
      [cls.slice(0, 2), cls.slice(0, 4), cls].map((prefix) => ({ prefix, cls })),
    ),
    (x) => x.prefix,
  );
  const byDigits = new Map(
    [...sourcesByPrefix].map(([prefix, xs]) => {
      const sources = new Set(xs.map((x) => x.cls));
      const targets = new Set([...sources].flatMap((s) => (targetsOf.get(s) ?? []).map((l) => l.code)));
      const partial = [...targets]
        .sort()
        .map((code) => ({
          code,
          alsoFrom: [...new Set((sourcesOf.get(code) ?? []).map((l) => l.rev2))]
            .filter((s) => !sources.has(s))
            .sort(),
        }))
        .filter((p) => p.alsoFrom.length > 0);
      return [
        prefix,
        { codes: compressCodes(tax.nodes, classesOf, targets), exact: partial.length === 0, partial },
      ] as const;
    }),
  );
  return { byDigits };
};

/**
 * Maps a NACE Rev. 2 code (section letter + digits, division level or below) to Rev. 2.1 with the official
 * correspondence: all Rev. 2.1 classes its activities moved to (recall first: partly moved activities included),
 * compressed to whole groups/divisions. A lookup in the precomputed table. Null for unknown codes and bare sections.
 */
export const mapRev2Code = (tax: { readonly rev2?: Rev2Correspondence }, raw: string): Rev2Mapping | null => {
  const code = raw.trim().toUpperCase();
  const digits = /^[A-U](\d{2}(\.\d{1,2})?)$/.exec(code)?.[1];
  const found = digits ? tax.rev2?.byDigits.get(digits) : undefined;
  return found ? { rev2: code, ...found } : null;
};

/** Maps several Rev. 2 codes and returns the union of their Rev. 2.1 selections (unknown codes are dropped). */
export const mapRev2Codes = (
  tax: { readonly rev2?: Rev2Correspondence },
  codes: readonly string[],
): readonly string[] => [...new Set(codes.flatMap((c) => mapRev2Code(tax, c)?.codes ?? []))].sort();
