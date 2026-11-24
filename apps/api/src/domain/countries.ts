/** The 27 EU member states (ISO 3166-1 alpha-2, Greece as GR). */
export const EU_COUNTRIES: readonly { readonly code: string; readonly name: string }[] = [
  ['AT', 'Austria'],
  ['BE', 'Belgium'],
  ['BG', 'Bulgaria'],
  ['HR', 'Croatia'],
  ['CY', 'Cyprus'],
  ['CZ', 'Czechia'],
  ['DK', 'Denmark'],
  ['EE', 'Estonia'],
  ['FI', 'Finland'],
  ['FR', 'France'],
  ['DE', 'Germany'],
  ['GR', 'Greece'],
  ['HU', 'Hungary'],
  ['IE', 'Ireland'],
  ['IT', 'Italy'],
  ['LV', 'Latvia'],
  ['LT', 'Lithuania'],
  ['LU', 'Luxembourg'],
  ['MT', 'Malta'],
  ['NL', 'Netherlands'],
  ['PL', 'Poland'],
  ['PT', 'Portugal'],
  ['RO', 'Romania'],
  ['SK', 'Slovakia'],
  ['SI', 'Slovenia'],
  ['ES', 'Spain'],
  ['SE', 'Sweden'],
].map(([code = '', name = '']) => ({ code, name }));

/** Set of EU member state codes. */
export const EU_COUNTRY_CODES: ReadonlySet<string> = new Set(EU_COUNTRIES.map((c) => c.code));

/** Countries a group applies to: all member states for EU-level items, otherwise the rule-maker's country. */
export const countriesInScope = (jurisdiction: string): readonly string[] =>
  jurisdiction === 'EU' ? [...EU_COUNTRY_CODES] : EU_COUNTRY_CODES.has(jurisdiction) ? [jurisdiction] : [];

/** ISO 639-1 codes of the 24 official EU languages. */
export const EU_LANGUAGE_CODES: ReadonlySet<string> = new Set(
  'bg cs da de el en es et fi fr ga hr hu it lt lv mt nl pl pt ro sk sl sv'.split(' '),
);

/** EU-internal country codes that differ from ISO 3166-1 (EU documents write Greece as EL). */
const ISO_COUNTRY_OF: Readonly<Record<string, string>> = { EL: 'GR' };

/** ISO 3166-1 code of a rule-maker (or EU); null when it is neither the EU nor a member state. Pure. */
export const normalizeJurisdiction = (raw: string): string | null => {
  const code = raw.trim().toUpperCase();
  const iso = ISO_COUNTRY_OF[code] ?? code;
  return iso === 'EU' || EU_COUNTRY_CODES.has(iso) ? iso : null;
};

/** Lower-case ISO 639-1 code of an official EU language; null for anything else. Pure. */
export const normalizeLanguage = (raw: string): string | null => {
  const code = raw.trim().toLowerCase();
  return EU_LANGUAGE_CODES.has(code) ? code : null;
};
