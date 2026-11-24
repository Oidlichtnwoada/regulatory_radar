import { compareBy, foldText, uniqBy } from '../common/fp.js';
import { countriesInScope } from './countries.js';
import type { GroupMember } from './grouping.js';
import { CONCEPTS, type Concept, NO_DUTY_SIGNALS } from './lexicon.js';
import { HORIZONTAL, type NaceTaxonomy, naceLineage } from './nace.js';

/** Relevance verdicts, weakest first. */
export const VERDICTS = ['not_relevant', 'borderline', 'relevant'] as const;
/** A relevance verdict. */
export type Verdict = (typeof VERDICTS)[number];

/** A sector-level verdict before it is expanded to countries. */
export interface SectorLabel {
  /** NACE Rev. 2.1 code or '*'. */
  readonly naceCode: string;
  /** Verdict. */
  readonly verdict: Verdict;
  /** Confidence or match score, if any. */
  readonly score: number | null;
  /** Short human-readable reason. */
  readonly rationale: string;
  /** Optional subset of countries (defaults to the jurisdiction scope). */
  readonly countries?: readonly string[];
}

/** A stored (country x NACE) verdict. */
export interface CountryLabel {
  /** ISO country code. */
  readonly country: string;
  /** NACE Rev. 2.1 code or '*'. */
  readonly naceCode: string;
  /** Verdict. */
  readonly verdict: Verdict;
  /** Score, if any. */
  readonly score: number | null;
  /** Reason. */
  readonly rationale: string;
}

/** Result of classifying a group. */
export interface ClassificationResult {
  /** Short "why relevant" text for the whole group. */
  readonly whyRelevant: string;
  /** Labels per country and NACE code. */
  readonly labels: readonly CountryLabel[];
}

/** The group facts a classifier needs. */
export interface ClassifierInput {
  /** Jurisdiction of the group. */
  readonly jurisdiction: string;
  /** Members (all languages, reactions included). */
  readonly members: readonly GroupMember[];
}

/** Numeric strength of a verdict. */
export const verdictRank = (v: Verdict): number => VERDICTS.indexOf(v);

/** Expands sector labels to country labels (EU -> all member states) and keeps the strongest per pair. */
export const expandLabels = (
  jurisdiction: string,
  labels: readonly SectorLabel[],
): readonly CountryLabel[] => {
  const scope = new Set(countriesInScope(jurisdiction));
  const expanded = labels.flatMap((l) =>
    (l.countries?.filter((c) => scope.has(c)) ?? [...scope]).map(
      (country): CountryLabel => ({
        country,
        naceCode: l.naceCode,
        verdict: l.verdict,
        score: l.score,
        rationale: l.rationale,
      }),
    ),
  );
  return strongestPerPair(expanded);
};

/** Keeps one label per (country, NACE) pair: the strongest verdict, then the highest score. */
const strongestPerPair = (labels: readonly CountryLabel[]): readonly CountryLabel[] =>
  uniqBy(
    labels.toSorted(
      compareBy(
        (l) => `${l.country}|${l.naceCode}`,
        (l) => -verdictRank(l.verdict),
        (l) => -(l.score ?? 0),
      ),
    ),
    (l) => `${l.country}|${l.naceCode}`,
  );

/**
 * "Stays tracked": a pair that was relevant or borderline before never drops below that verdict in a
 * later classification (a later step whose title no longer names the sector keeps its group tracked).
 * A pair the new classification explicitly rejects (`rejected`: not_relevant on the code or an ancestor, e.g. a
 * keyword trap the agent caught) is not carried. Only relevant and borderline labels are returned.
 */
export const keepTracked = (
  previous: readonly CountryLabel[],
  next: readonly CountryLabel[],
  rejected: readonly CountryLabel[] = [],
): readonly CountryLabel[] => {
  const nextByPair = new Map(next.map((l) => [`${l.country}|${l.naceCode}`, l]));
  const isRejected = (p: CountryLabel) =>
    rejected.some(
      (r) =>
        r.verdict === 'not_relevant' &&
        r.country === p.country &&
        r.naceCode !== HORIZONTAL &&
        naceLineage(p.naceCode).includes(r.naceCode),
    );
  const carried = previous
    .filter((p) => p.verdict !== 'not_relevant' && !isRejected(p))
    .filter(
      (p) =>
        verdictRank(nextByPair.get(`${p.country}|${p.naceCode}`)?.verdict ?? 'not_relevant') <
        verdictRank(p.verdict),
    )
    .map((p) => ({
      ...p,
      rationale: `Kept tracked from an earlier step: ${p.rationale.replace(/^Kept tracked from an earlier step: /, '')}`,
    }));
  return strongestPerPair([...next, ...carried]).filter((l) => l.verdict !== 'not_relevant');
};

/** Highest score of the keyword rules (title weight 2 + 1 for several terms): stated tags get it, so they win ties. */
const STATED_SCORE = 3;

/** Labels for NACE codes the channel stated itself (facts, used by every engine). */
export const statedLabels = (tax: NaceTaxonomy, members: readonly GroupMember[]): readonly SectorLabel[] =>
  [...new Set(members.flatMap((m) => m.naceTags))].sort().map((code) => ({
    naceCode: code,
    verdict: 'relevant',
    score: STATED_SCORE,
    rationale: `The channel tags this procedure with NACE ${code} (${tax.byCode.get(code)?.title ?? 'unknown'}).`,
  }));

/** Folded text of a member's title (weight 2) and summary/topics (weight 1). */
const textsOf = (m: GroupMember): readonly (readonly [string, number])[] => [
  [` ${foldText([m.title, m.titleEn].filter(Boolean).join(' | '))} `, 2],
  [` ${foldText([m.summary, m.summaryEn, ...m.topics].filter(Boolean).join(' | '))} `, 1],
];

/** The texts without the concept's misleading phrases. */
const textsFor = (concept: Concept, texts: readonly (readonly [string, number])[]) =>
  texts.map(([t, w]) => [(concept.exclude ?? []).reduce((acc, p) => acc.replaceAll(p, ' '), t), w] as const);

/** True when a folded stem starts a word in the folded text. */
const hasTerm = (text: string, term: string): boolean => new RegExp(`(^|[^\\p{L}])${term}`, 'u').test(text);

/** Verdict from a score: 2+ relevant, 1 borderline; capped groups and concepts stop at borderline. */
const verdictOf = (score: number, capped: boolean): Verdict =>
  score >= 2 && !capped ? 'relevant' : score >= 1 ? 'borderline' : 'not_relevant';

/** Concept matches of a group with their sector labels (the deterministic rules, before country expansion). */
export const ruleMatches = (input: ClassifierInput) => {
  const allTexts = input.members.flatMap(textsOf);
  // Information-only items and groups without any duty (classification acts, voluntary schemes) stay borderline.
  const caps = [
    ...(input.members.every((m) => m.stage === 'information') ? ['information only'] : []),
    ...NO_DUTY_SIGNALS.filter((s) => s.terms.some((t) => allTexts.some(([text]) => hasTerm(text, t)))).map(
      (s) => s.label,
    ),
  ];
  const conceptHits = CONCEPTS.map((concept) => {
    const texts = textsFor(concept, allTexts);
    const matched = concept.terms.filter((t) => texts.some(([text]) => hasTerm(text, t)));
    const score = Math.max(
      0,
      ...texts.map(([text, w]) => (concept.terms.some((t) => hasTerm(text, t)) ? w : 0)),
    );
    const total = score + (matched.length > 1 ? 1 : 0);
    return { concept, matched, score: total };
  }).filter((h) => h.score > 0);
  const conceptLabels: readonly SectorLabel[] = conceptHits.flatMap(({ concept, matched, score }) =>
    concept.nace.map((naceCode) => {
      const capped = caps.length > 0 || concept.cap === 'borderline';
      const why = score >= 2 && capped ? ` Capped at borderline: ${caps.join('; ') || 'marginal link'}.` : '';
      return {
        naceCode,
        verdict: verdictOf(score, capped),
        score,
        rationale: `Mentions ${concept.label} (${matched.slice(0, 3).join(', ')}) → ${naceCode === HORIZONTAL ? 'every sector' : `NACE ${naceCode}`}.${why}`,
      };
    }),
  );
  return { conceptHits, conceptLabels };
};

/**
 * Recall safety net for the agent: every sector the deterministic rules rate relevant or borderline that the
 * agent did not decide on (no label on the code, an ancestor, a descendant or '*') is added as borderline.
 * An explicit agent label, also not_relevant for a keyword trap, counts as a decision and is respected; a '*' label
 * covers every sector only when it is relevant or borderline (a '*' not_relevant does not switch the net off). Pure.
 */
export const safetyNet = (
  agent: readonly SectorLabel[],
  rules: readonly SectorLabel[],
): readonly SectorLabel[] => {
  const decided = (code: string) =>
    agent.some(
      (a) =>
        (a.naceCode === HORIZONTAL && a.verdict !== 'not_relevant') ||
        naceLineage(code).includes(a.naceCode) ||
        naceLineage(a.naceCode).includes(code),
    );
  return uniqBy(
    rules.filter((r) => r.verdict !== 'not_relevant' && r.naceCode !== HORIZONTAL && !decided(r.naceCode)),
    (r) => r.naceCode,
  ).map((r) => ({
    naceCode: r.naceCode,
    verdict: 'borderline' as const,
    score: r.score,
    rationale: `Safety net, not covered by the agent: ${r.rationale}`,
  }));
};

/**
 * Deterministic best-effort classifier (offline fallback): stated NACE tags, plus multilingual concept
 * matches on titles (weight 2) and summaries/topics (weight 1). Same input, same output.
 */
export const classifyDeterministic = (tax: NaceTaxonomy, input: ClassifierInput): ClassificationResult => {
  const { conceptHits, conceptLabels } = ruleMatches(input);
  const labels = expandLabels(input.jurisdiction, [...statedLabels(tax, input.members), ...conceptLabels]);
  const best = conceptHits.toSorted(
    compareBy(
      (h) => -h.score,
      (h) => h.concept.label,
    ),
  );
  const stated = [...new Set(input.members.flatMap((m) => m.naceTags))];
  const whyRelevant =
    [
      stated.length ? `Channel tags NACE ${stated.join(', ')}.` : '',
      best.length ? `Text concerns ${best.map((h) => h.concept.label).join('; ')}.` : '',
    ]
      .filter(Boolean)
      .join(' ') || 'No sector signal found by the deterministic rules.';
  return { whyRelevant: `${whyRelevant} (deterministic offline rules)`, labels };
};
