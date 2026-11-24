import { readFileSync } from 'node:fs';
import { EU_COUNTRY_CODES } from './countries.js';
import type { NaceTaxonomy } from './nace.js';
import { mapRev2Code } from './nace-rev2.js';

/** An example operator profile as a NACE Rev. 2.1 selection. */
export interface ProfilePreset {
  /** Profile id of the example (data/examples/profile_<id>.yaml). */
  readonly id: string;
  /** Display label. */
  readonly label: string;
  /** ISO country codes. */
  readonly countries: readonly string[];
  /** NACE Rev. 2.1 selection, derived from the Rev. 2 codes. */
  readonly naceCodes: readonly string[];
  /** The example's original NACE Rev. 2 codes. */
  readonly naceCodesRev2: readonly string[];
  /** Whether Rev. 2 and Rev. 2.1 cover exactly the same activities. */
  readonly exact: boolean;
  /** What differs, per Rev. 2 code. */
  readonly mappingNote: string;
}

/** One preset as stored in data/profile_presets.json (Rev. 2 codes as in the examples). */
type StoredPreset = Pick<ProfilePreset, 'id' | 'label' | 'countries' | 'naceCodesRev2'>;

/**
 * Turns a stored preset into a Rev. 2.1 selection with the same mapping the pipeline applies to source tags
 * (mapRev2Code), and describes every deviation. Pure.
 */
export const toPreset = (tax: NaceTaxonomy, stored: StoredPreset): ProfilePreset => {
  const unknown = stored.countries.filter((c) => !EU_COUNTRY_CODES.has(c));
  if (unknown.length)
    throw new Error(`preset ${stored.id}: ${unknown.join(', ')} is not an EU ISO 3166-1 alpha-2 code`);
  const mappings = stored.naceCodesRev2.map((code) => {
    const m = mapRev2Code(tax, code);
    if (!m) throw new Error(`preset ${stored.id}: ${code} is not a NACE Rev. 2 code`);
    return m;
  });
  const note = mappings
    .map((m) =>
      m.exact
        ? `${m.rev2} → ${m.codes.join(', ')} (exact).`
        : `${m.rev2} → ${m.codes.join(', ')} (not exact: ${m.partial
            .map(
              (p) =>
                `${p.code} "${tax.byCode.get(p.code)?.title}" also contains Rev. 2 ${p.alsoFrom.join(', ')}`,
            )
            .join('; ')}).`,
    )
    .join(' ');
  return {
    ...stored,
    naceCodes: [...new Set(mappings.flatMap((m) => m.codes))].sort(),
    exact: mappings.every((m) => m.exact),
    mappingNote: note,
  };
};

/** Loads data/profile_presets.json and maps every preset to NACE Rev. 2.1 (fails fast on unknown country or NACE codes). */
export const loadPresets = (path: string, tax: NaceTaxonomy): readonly ProfilePreset[] =>
  (JSON.parse(readFileSync(path, 'utf8')) as { presets: StoredPreset[] }).presets.map((p) =>
    toPreset(tax, p),
  );
