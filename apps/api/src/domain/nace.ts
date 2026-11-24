import { existsSync, readFileSync } from 'node:fs';
import { foldText } from '../common/fp.js';
import { loadRev2Correspondence, type Rev2Correspondence } from './nace-rev2.js';

/** Pseudo NACE code for "every sector" (horizontal rules). */
export const HORIZONTAL = '*';

/** NACE revision used throughout the service. */
export const NACE_REVISION = 'NACE Rev. 2.1';

/** One node of the NACE Rev. 2.1 taxonomy. */
export interface NaceNode {
  /** Code in dotted notation: C, C24, C24.4, C24.42. */
  readonly code: string;
  /** Hierarchy level. */
  readonly level: 'section' | 'division' | 'group' | 'class';
  /** English title. */
  readonly title: string;
  /** Parent code, null for sections. */
  readonly parent: string | null;
  /** 0 = section ... 3 = class. */
  readonly depth: number;
  /** Eurostat explanatory notes (English), where published. */
  readonly notes?: NaceNotes;
}

/** Eurostat explanatory notes of a NACE Rev. 2.1 code. */
export interface NaceNotes {
  /** "This class includes: ..." */
  readonly includes?: string;
  /** "This class also includes: ..." */
  readonly includesAlso?: string;
  /** "This class excludes: ..." */
  readonly excludes?: string;
}

/** Taxonomy with lookup indexes. */
export interface NaceTaxonomy {
  /** All nodes in hierarchical (file) order. */
  readonly nodes: readonly NaceNode[];
  /** Node by code. */
  readonly byCode: ReadonlyMap<string, NaceNode>;
  /** Rev. 2.1 code by its digits (division numbers are unique across sections). */
  readonly byDigits: ReadonlyMap<string, string>;
  /** Official correspondence from NACE Rev. 2 (nace_rev2_to_rev2_1.csv next to the taxonomy), if present. */
  readonly rev2?: Rev2Correspondence;
}

/** Parent of a NACE code: C24.42 -> C24.4 -> C24 -> C -> null. */
export const naceParent = (code: string): string | null =>
  ({ 1: null, 3: code.slice(0, 1), 5: code.slice(0, 3) })[code.length] ??
  (code.length > 5 ? code.slice(0, 5) : null);

/** The code followed by all its ancestors up to the section. */
export const naceLineage = (code: string): readonly string[] => {
  const parent = naceParent(code);
  return parent ? [code, ...naceLineage(parent)] : [code];
};

/** ltree path of a code: C24.4 -> NACE.C.C24.C24_4; the horizontal code is the root NACE. */
export const nacePath = (code: string): string =>
  code === HORIZONTAL
    ? 'NACE'
    : [
        'NACE',
        ...naceLineage(code)
          .toReversed()
          .map((c: string) => c.replace('.', '_')),
      ].join('.');

/**
 * lquery patterns that match every label relevant to a selection: the selected code and its
 * descendants (C24.*), plus its exact ancestors and the horizontal root (C, NACE).
 */
export const naceSelectionQueries = (codes: readonly string[]): readonly string[] => [
  ...new Set(
    codes.flatMap((code) => [
      `${nacePath(code)}.*`,
      'NACE',
      ...naceLineage(code)
        .slice(1)
        .map((c) => nacePath(c)),
    ]),
  ),
];

/** In-memory counterpart of naceSelectionQueries: does a label on `code` belong to the selection? */
export const naceSelectionMatches = (codes: readonly string[], code: string): boolean =>
  code === HORIZONTAL || codes.some((n) => naceLineage(code).includes(n) || naceLineage(n).includes(code));

/** Minimal CSV line parser supporting double-quoted fields. */
const parseCsvLine = (line: string): readonly string[] =>
  [...line.matchAll(/("([^"]*(?:""[^"]*)*)"|[^,]*)(,|$)/g)]
    .filter((m) => m.index < line.length || m[1] !== '')
    .map((m) => (m[2] !== undefined ? m[2].replace(/""/g, '"') : (m[1] ?? '')));

/** Builds the taxonomy indexes from nodes. */
export const buildTaxonomy = (nodes: readonly NaceNode[]): NaceTaxonomy => ({
  nodes,
  byCode: new Map(nodes.map((n) => [n.code, n])),
  byDigits: new Map(nodes.filter((n) => n.depth > 0).map((n) => [n.code.slice(1), n.code])),
});

/** Loads data/nace_rev2_1.csv (code,level,title_en) plus the explanatory notes next to it (nace_rev2_1_notes.json). */
export const loadTaxonomy = (csvPath: string): NaceTaxonomy => {
  const depthOf = { section: 0, division: 1, group: 2, class: 3 } as const;
  const notesPath = csvPath.replace(/\.csv$/, '_notes.json');
  const notes: Readonly<Record<string, NaceNotes>> = existsSync(notesPath)
    ? (JSON.parse(readFileSync(notesPath, 'utf8')) as { notes: Record<string, NaceNotes> }).notes
    : {};
  const nodes = readFileSync(csvPath, 'utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map(parseCsvLine)
    .map(([code = '', level = '', title = '']): NaceNode => {
      const lvl = level as NaceNode['level'];
      return {
        code,
        level: lvl,
        title,
        parent: naceParent(code),
        depth: depthOf[lvl],
        ...(notes[code] ? { notes: notes[code] } : {}),
      };
    });
  const taxonomy = buildTaxonomy(nodes);
  const rev2Path = csvPath.replace(/nace_rev2_1\.csv$/, 'nace_rev2_to_rev2_1.csv');
  return rev2Path !== csvPath && existsSync(rev2Path)
    ? { ...taxonomy, rev2: loadRev2Correspondence(rev2Path, taxonomy) }
    : taxonomy;
};

/** English text of a code that is embedded and searched: code, title and explanatory notes. Pure. */
export const naceDocument = (n: NaceNode): string =>
  [`${n.code} ${n.title}`, n.notes?.includes, n.notes?.includesAlso, n.notes?.excludes]
    .filter(Boolean)
    .join('\n');

/**
 * Text search over titles (weight 3) and explanatory notes (weight 1) for the agents and offline use:
 * every query word that starts a word adds its weight; exclusion notes do not count. Best first. Pure.
 */
export const searchNaceText = (tax: NaceTaxonomy, query: string, limit: number): readonly NaceNode[] => {
  const words = foldText(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
  const exact = tax.byCode.get(query.trim().toUpperCase());
  const hits = (text: string) =>
    words.filter((w) => new RegExp(`(^|[^\\p{L}])${w}`, 'u').test(foldText(text))).length;
  const scored = tax.nodes
    .map((n) => ({
      n,
      score: hits(n.title) * 3 + hits([n.notes?.includes, n.notes?.includesAlso].filter(Boolean).join(' ')),
    }))
    .filter((x) => x.score > 0)
    .toSorted((a, b) => b.score - a.score || a.n.depth - b.n.depth);
  return [...(exact ? [exact] : []), ...scored.map((x) => x.n).filter((n) => n !== exact)].slice(0, limit);
};
