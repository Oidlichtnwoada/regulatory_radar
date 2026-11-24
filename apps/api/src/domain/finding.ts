import { isoDay, type Json, parseDay } from '../common/fp.js';
import { normalizeJurisdiction, normalizeLanguage } from './countries.js';

/** Life-cycle stages of the common schema. */
export const STAGES = [
  'information',
  'proposal',
  'consultation_open',
  'standstill',
  'in_procedure',
  'adopted',
] as const;
/** A life-cycle stage, or unknown when the channel does not say. */
export type Stage = (typeof STAGES)[number] | 'unknown';

/** Kinds of dated points that can require action. */
export type ActionPointKind =
  | 'consultation_deadline'
  | 'feedback_deadline'
  | 'amendment_deadline'
  | 'vote'
  | 'standstill_end'
  | 'adoption'
  | 'publication';

/** A dated point of a finding (deadline, vote, standstill end, adoption, publication). */
export interface ActionPoint {
  /** What happens on that date. */
  readonly kind: ActionPointKind;
  /** ISO date. */
  readonly date: string;
}

/** A normalised item in the common schema, before it gets a database id. */
export interface FindingDraft {
  /** Channel inside the source (eu_eurlex, national_gazette, ...). */
  readonly channel: string;
  /** EU or the ISO code of the rule-maker. */
  readonly jurisdiction: string;
  /** ISO 639-1 language of title and summary. */
  readonly language: string;
  /** Document type as given by the channel (normalised to snake_case). */
  readonly docType: string;
  /** Life-cycle stage. */
  readonly stage: Stage;
  /** Title in `language`. */
  readonly title: string;
  /** Summary in `language`, if any. */
  readonly summary: string | null;
  /** Publication date (ISO). */
  readonly publishedOn: string;
  /** Last day to act (ISO), if any. */
  readonly deadline: string | null;
  /** What the deadline is for. */
  readonly deadlineKind: string | null;
  /** Scheduled event such as a plenary vote (ISO), if any. */
  readonly eventDate: string | null;
  /** Procedure / document reference. */
  readonly ref: string | null;
  /** External id of the item this one reacts to. */
  readonly relatedTo: string | null;
  /** False when the channel gives no sector information (null in the seed). */
  readonly naceTagsStated: boolean;
  /** NACE Rev. 2.1 codes stated by the channel. */
  readonly naceTags: readonly string[];
  /** Channel topics, in the channel's language. */
  readonly topics: readonly string[];
  /** Link to the item. */
  readonly url: string | null;
  /** Source-specific extras that do not fit the common schema. */
  readonly attributes: { readonly [key: string]: Json };
}

/** Level derived from jurisdiction. */
export const levelOf = (jurisdiction: string): 'eu' | 'national' =>
  jurisdiction === 'EU' ? 'eu' : 'national';

/** Maps a channel stage string onto the common stages. */
export const normalizeStage = (raw: string | null | undefined): Stage =>
  (STAGES as readonly string[]).includes(raw ?? '') ? (raw as Stage) : 'unknown';

/** Normalised reference used to link findings of the same procedure (case and whitespace insensitive). */
export const refKey = (ref: string | null): string | null =>
  ref ? ref.replace(/\s+/g, '').toUpperCase() : null;

/** Deadline kinds of the channels mapped onto action point kinds. */
const DEADLINE_KINDS: Readonly<Record<string, ActionPointKind>> = {
  feedback: 'feedback_deadline',
  consultation: 'consultation_deadline',
  amendments: 'amendment_deadline',
  standstill_end: 'standstill_end',
};

/** Derives the dated action points of a finding; deterministic. */
export const actionPointsOf = (f: FindingDraft): readonly ActionPoint[] =>
  [
    f.deadline && {
      kind:
        DEADLINE_KINDS[f.deadlineKind ?? ''] ??
        (f.stage === 'standstill' ? 'standstill_end' : 'consultation_deadline'),
      date: f.deadline,
    },
    f.eventDate && { kind: 'vote', date: f.eventDate },
    f.stage === 'adopted' && { kind: 'adoption', date: f.publishedOn },
    { kind: 'publication', date: f.publishedOn },
  ].filter((p): p is ActionPoint => Boolean(p));

/** True for a valid ISO 8601 calendar day (YYYY-MM-DD, no rollover such as 02-30). */
const isIsoDay = (s: unknown): boolean => {
  const day = typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? parseDay(s) : null;
  return day !== null && !Number.isNaN(day.getTime()) && isoDay(day) === s;
};

/** Formats a value for an error message. */
const shown = (v: unknown): string => JSON.stringify(v) ?? String(v);

/**
 * Checks an adapter's draft against the common schema and normalises its codes (ISO 3166-1 jurisdiction, EL -> GR;
 * lower-case ISO 639-1 language). Throws with every violation, so the ingestion can reject the record. Pure.
 */
export const validatedDraft = (d: FindingDraft): FindingDraft => {
  const jurisdiction = typeof d.jurisdiction === 'string' ? normalizeJurisdiction(d.jurisdiction) : null;
  const language = typeof d.language === 'string' ? normalizeLanguage(d.language) : null;
  const errors = [
    !jurisdiction && `jurisdiction ${shown(d.jurisdiction)} is neither EU nor an EU member state`,
    !language && `language ${shown(d.language)} is not an official EU language (ISO 639-1)`,
    !(typeof d.title === 'string' && d.title.trim()) && 'title is empty',
    !isIsoDay(d.publishedOn) && `publishedOn ${shown(d.publishedOn)} is not an ISO date`,
    d.deadline !== null && !isIsoDay(d.deadline) && `deadline ${shown(d.deadline)} is not an ISO date`,
    d.eventDate !== null && !isIsoDay(d.eventDate) && `eventDate ${shown(d.eventDate)} is not an ISO date`,
  ].filter((e): e is string => Boolean(e));
  if (errors.length > 0 || !jurisdiction || !language) throw new Error(errors.join('; '));
  return { ...d, jurisdiction, language };
};

/** True for reactions to another item (feedback, statements), which are not new procedures. */
export const isReaction = (f: Pick<FindingDraft, 'relatedTo' | 'docType'>): boolean =>
  Boolean(f.relatedTo) || f.docType === 'feedback_statement';
