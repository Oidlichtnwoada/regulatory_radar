import {
  ActionPointKind,
  ActionTier,
  EmbeddingStatus,
  GroupingDecisionDecisionEnum,
  Level,
  type NaceCode,
  SourceHealth,
  SourceStatusKindEnum,
  SourceTrailEntryRoleEnum,
  Stage,
  SystemStatusModeEnum,
  TranslationStatus,
  Verdict,
} from '../api-client';

/** Visual tone of a status chip; maps to the `.tone-*` classes in styles.scss. */
export type Tone = 'urgent' | 'high' | 'medium' | 'ok' | 'info' | 'neutral';

/** A chip's text (as translation key) and tone. */
export interface ChipSpec {
  /** Translation key of the chip text (see `src/i18n`). */
  readonly labelKey: string;
  /** Colour tone of the chip. */
  readonly tone: Tone;
}

/** Label keys and tones for every actionability tier, most urgent first (same order as the API ranking). */
export const TIER_CHIPS: Readonly<Record<ActionTier, ChipSpec>> = {
  [ActionTier.open_window]: { labelKey: 'labels.tier.open_window', tone: 'urgent' },
  [ActionTier.upcoming_vote]: { labelKey: 'labels.tier.upcoming_vote', tone: 'high' },
  [ActionTier.standstill]: { labelKey: 'labels.tier.standstill', tone: 'medium' },
  [ActionTier.in_procedure]: { labelKey: 'labels.tier.in_procedure', tone: 'info' },
  [ActionTier.adopted]: { labelKey: 'labels.tier.adopted', tone: 'neutral' },
  [ActionTier.information]: { labelKey: 'labels.tier.information', tone: 'neutral' },
};

/** Label keys and tones for relevance verdicts. */
export const VERDICT_CHIPS: Readonly<Record<Verdict, ChipSpec>> = {
  [Verdict.relevant]: { labelKey: 'labels.verdict.relevant', tone: 'ok' },
  [Verdict.borderline]: { labelKey: 'labels.verdict.borderline', tone: 'medium' },
  [Verdict.not_relevant]: { labelKey: 'labels.verdict.not_relevant', tone: 'neutral' },
};

/** Label keys and tones for source health. */
export const HEALTH_CHIPS: Readonly<Record<SourceHealth, ChipSpec>> = {
  [SourceHealth.ok]: { labelKey: 'labels.health.ok', tone: 'ok' },
  [SourceHealth.degraded]: { labelKey: 'labels.health.degraded', tone: 'medium' },
  [SourceHealth.failed]: { labelKey: 'labels.health.failed', tone: 'urgent' },
  [SourceHealth.running]: { labelKey: 'labels.health.running', tone: 'info' },
  [SourceHealth.idle]: { labelKey: 'labels.health.idle', tone: 'neutral' },
  [SourceHealth.disabled]: { labelKey: 'labels.health.disabled', tone: 'neutral' },
};

/** All verdicts in display order. */
export const ALL_VERDICTS: readonly Verdict[] = [Verdict.relevant, Verdict.borderline, Verdict.not_relevant];

/**
 * Case-insensitive NACE search on code and title, excluding already selected codes.
 * Keeps taxonomy order so the hierarchy stays readable; returns at most `limit` codes.
 */
export const searchNace = (
  codes: readonly NaceCode[],
  query: string,
  exclude: readonly string[],
  limit = 80,
): NaceCode[] => {
  const needle = query.trim().toLowerCase();
  const excluded = new Set(exclude);
  return codes
    .filter(
      (c) =>
        !excluded.has(c.code) &&
        (needle === '' || c.code.toLowerCase().startsWith(needle) || c.title.toLowerCase().includes(needle)),
    )
    .slice(0, limit);
};

/** Builds a URL query string from list parameters, omitting empty lists (comma-separated, as in the OpenAPI spec). */
export const listQuery = (params: Readonly<Record<string, readonly string[]>>): string =>
  Object.entries(params)
    .filter(([, values]) => values.length > 0)
    .map(([key, values]) => `${encodeURIComponent(key)}=${values.map(encodeURIComponent).join(',')}`)
    .join('&');

/**
 * Chip for an actionability tier.
 * @param tier Actionability tier.
 */
export const tierChip = (tier: ActionTier): ChipSpec => TIER_CHIPS[tier];

/**
 * Chip for a relevance verdict.
 * @param verdict Relevance verdict.
 */
export const verdictChip = (verdict: Verdict): ChipSpec => VERDICT_CHIPS[verdict];

/**
 * Chip for a source health state.
 * @param health Source health.
 */
export const healthChip = (health: SourceHealth): ChipSpec => HEALTH_CHIPS[health];

/** Every closed API enum shown as text, by label group; each value has a key `labels.<group>.<value>`. */
export const ENUM_LABELS = {
  stage: Object.values(Stage),
  actionPoint: Object.values(ActionPointKind),
  role: Object.values(SourceTrailEntryRoleEnum),
  sourceKind: Object.values(SourceStatusKindEnum),
  level: Object.values(Level),
  translation: Object.values(TranslationStatus),
  embedding: Object.values(EmbeddingStatus),
  decision: Object.values(GroupingDecisionDecisionEnum),
  verdict: Object.values(Verdict),
  mode: Object.values(SystemStatusModeEnum),
} as const;

/** Label group of an enum value; `docType` and `deadlineKind` are open sets (known values have a key, others are humanised). */
export type LabelGroup = keyof typeof ENUM_LABELS | 'docType' | 'deadlineKind';

/**
 * Translation key of an enum value.
 * @param group Label group.
 * @param value Raw API value.
 */
export const labelKey = (group: LabelGroup, value: string): string => `labels.${group}.${value}`;

/**
 * Readable fallback for an untranslated value: underscores become spaces, first letter upper case.
 * @param value Raw API value, e.g. `royal_decree_law`.
 */
export const humanise = (value: string): string => {
  const text = value.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** One source filter as display text. */
export interface FilterEntry {
  /** Filter name as configured. */
  readonly key: string;
  /** Value as text; empty for unset filters (`null` or empty list). */
  readonly value: string;
}

/**
 * Source filters as key/value text, e.g. `{ sections: ['1'] }` → `sections: 1`.
 * @param filters Effective filters of a source.
 */
export const filterEntries = (filters: Readonly<Record<string, unknown>>): FilterEntry[] =>
  Object.entries(filters).map(([key, value]) => ({
    key,
    value: Array.isArray(value) ? value.join(', ') : value === null ? '' : String(value),
  }));
