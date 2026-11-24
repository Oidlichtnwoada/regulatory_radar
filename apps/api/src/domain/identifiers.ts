/** One procedure or act identifier scheme found in regulatory texts. */
interface IdentifierScheme {
  /** Scheme name (shown to the grouping agent as evidence). */
  readonly scheme: string;
  /** Pattern (global). */
  readonly pattern: RegExp;
}

/** Identifier schemes that tie items of one procedure together across channels and languages. */
const SCHEMES: readonly IdentifierScheme[] = [
  { scheme: 'procedure', pattern: /\b\d{4}\/\d{4}\((?:COD|CNS|APP|NLE|INI|BUD|DEL|RSP|RPS|AVC|SYN)\)/g },
  { scheme: 'celex', pattern: /\b[0-9][12]\d{3}[A-Z]{1,2}\d{4}\b/g },
  { scheme: 'com', pattern: /\b(?:COM|SWD|C)\(\d{4}\)\s?\d+/g },
  { scheme: 'ares', pattern: /\bAres\(\d{4}\)\d{5,}/gi },
  { scheme: 'tris', pattern: /\b\d{4}\/\d{4}\/[A-Z]{2}\b/g },
  { scheme: 'eli', pattern: /\beli\/[\w/.-]+/gi },
  { scheme: 'boe', pattern: /\bBOE-[A-Z]-\d{4}-\d+/g },
];

/** A found identifier. */
export interface Identifier {
  /** Scheme name. */
  readonly scheme: string;
  /** Identifier as written. */
  readonly value: string;
}

/** Procedure/act identifiers in the given texts (deduplicated, in scheme order). Pure. */
export const identifiersIn = (texts: readonly (string | null | undefined)[]): readonly Identifier[] => {
  const text = texts.filter(Boolean).join('\n');
  return SCHEMES.flatMap(({ scheme, pattern }) =>
    [...new Set([...text.matchAll(pattern)].map((m) => m[0].replace(/\s+/g, '')))].map((value) => ({
      scheme,
      value,
    })),
  );
};
