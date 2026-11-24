/** data/eval/labels.json. */
export interface EvalLabels {
  /** Reference date of the labels. */
  readonly as_of: string;
  /** Label group id -> item ids. */
  readonly procedure_groups: Readonly<Record<string, readonly string[]>>;
  /** Profile id -> label lists. */
  readonly profiles: Readonly<
    Record<
      string,
      {
        readonly relevant: readonly string[];
        readonly borderline: readonly string[];
        readonly not_relevant: readonly string[];
      }
    >
  >;
}

/** One radar entry as the evaluation sees it. */
export interface ShownGroup {
  /** Our group key. */
  readonly groupKey: string;
  /** Seed item ids of the members. */
  readonly externalIds: readonly string[];
}

/** Precision/recall of one profile. */
export interface EvalMetrics {
  /** Profile id. */
  readonly profile: string;
  /** Relevant label groups shown / relevant label groups. */
  readonly recall: number;
  /** Shown label groups that are relevant / shown label groups that are relevant or not_relevant. */
  readonly precision: number;
  /** Relevant label groups shown. */
  readonly truePositives: number;
  /** not_relevant label groups shown. */
  readonly falsePositives: number;
  /** Relevant label groups not shown. */
  readonly falseNegatives: number;
  /** Label groups that we split over more than one radar entry. */
  readonly splitGroups: readonly string[];
  /** Missed relevant label groups. */
  readonly missed: readonly string[];
  /** Shown not_relevant label groups. */
  readonly falseAlarms: readonly string[];
}

/** a / b rounded to 3 decimals; an empty denominator counts as perfect (nothing to miss, nothing wrong shown). */
const ratio = (a: number, b: number): number => (b === 0 ? 1 : Math.round((a / b) * 1000) / 1000);

/** The label lists of a profile (fails fast when the file does not label it). */
const labelsOf = (labels: EvalLabels, profile: string) => {
  const lists = labels.profiles[profile];
  if (!lists) throw new Error(`no labels for profile ${profile}`);
  return lists;
};

/** Label groups a radar entry covers: an item in a labelled procedure group counts as that group. */
const labelGroupsOfEntry = (labels: EvalLabels) => {
  const groupOfItem = new Map(
    Object.entries(labels.procedure_groups).flatMap(([group, items]) =>
      items.map((i) => [i, group] as const),
    ),
  );
  return (s: ShownGroup): readonly string[] => [
    ...new Set(s.externalIds.map((id) => groupOfItem.get(id) ?? id)),
  ];
};

/** The three label tiers, weakest first. */
const TIERS = ['not_relevant', 'borderline', 'relevant'] as const;

/** Exact three-tier agreement of one profile (borderline included, unlike precision/recall). */
export interface TierAgreement {
  /** Label groups whose tier we reproduce / labelled groups. */
  readonly agreement: number;
  /** Label groups whose tier differs: label tier and ours. */
  readonly mismatches: readonly { readonly group: string; readonly label: string; readonly ours: string }[];
}

/**
 * Compares every labelled group's tier with ours: relevant when a strict (relevant) entry covers it,
 * borderline when only a shown (relevant + borderline) entry does, otherwise not_relevant.
 */
export const evaluateTiers = (
  labels: EvalLabels,
  profile: string,
  shown: readonly ShownGroup[],
  strict: readonly ShownGroup[],
): TierAgreement => {
  const lists = labelsOf(labels, profile);
  const labelGroupsOf = labelGroupsOfEntry(labels);
  const covered = (entries: readonly ShownGroup[]) => new Set(entries.flatMap(labelGroupsOf));
  const [inShown, inStrict] = [covered(shown), covered(strict)];
  const ours = (g: string) => (inStrict.has(g) ? 'relevant' : inShown.has(g) ? 'borderline' : 'not_relevant');
  const all = TIERS.flatMap((tier) =>
    lists[tier].map((group) => ({ group, label: tier, ours: ours(group) })),
  );
  const mismatches = all.filter((m) => m.label !== m.ours);
  return { agreement: ratio(all.length - mismatches.length, all.length), mismatches };
};

/**
 * Scores shown radar entries against the labels. Rules (documented in the README): borderline label
 * groups are ignored; a label group counts as shown once even if we split it over several entries
 * (reported as splitGroups); an entry that covers several label groups shows each of them.
 */
export const evaluate = (labels: EvalLabels, profile: string, shown: readonly ShownGroup[]): EvalMetrics => {
  const lists = labelsOf(labels, profile);
  const labelGroupsOf = labelGroupsOfEntry(labels);
  const shownCount = Map.groupBy(
    shown.flatMap((s) => labelGroupsOf(s).map((g) => [g, s.groupKey] as const)),
    ([g]) => g,
  );
  const isShown = (g: string) => shownCount.has(g);
  const tp = lists.relevant.filter(isShown);
  const fp = lists.not_relevant.filter(isShown);
  const missed = lists.relevant.filter((g) => !isShown(g));
  return {
    profile,
    recall: ratio(tp.length, lists.relevant.length),
    precision: ratio(tp.length, tp.length + fp.length),
    truePositives: tp.length,
    falsePositives: fp.length,
    falseNegatives: missed.length,
    splitGroups: [...shownCount.entries()]
      .filter(([, v]) => new Set(v.map(([, k]) => k)).size > 1)
      .map(([g]) => g),
    missed,
    falseAlarms: fp,
  };
};

/** Pairwise co-membership quality of our grouping against the labelled procedure groups. */
export interface GroupingMetrics {
  /** Pairs we grouped that the labels also group / pairs we grouped. */
  readonly pairPrecision: number;
  /** Labelled pairs we grouped / labelled pairs. */
  readonly pairRecall: number;
  /** Labelled multi-item groups reproduced exactly / labelled multi-item groups. */
  readonly exactGroups: number;
  /** Labelled multi-item groups reproduced exactly AND under the same name / labelled multi-item groups. */
  readonly sameNames: number;
}

/** Unordered pairs of a list of ids. */
const pairs = (ids: readonly string[]): readonly string[] =>
  ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b].sort().join('|')));

/** Compares our groups (key -> seed item ids) with labels.procedure_groups, restricted to labelled items. */
export const evaluateGrouping = (
  labels: EvalLabels,
  oursByKey: ReadonlyMap<string, readonly string[]>,
): GroupingMetrics => {
  const ours = [...oursByKey.values()];
  const labelled = Object.values(labels.procedure_groups);
  const known = new Set(
    Object.values(labels.profiles).flatMap((p) => [...p.relevant, ...p.borderline, ...p.not_relevant]),
  );
  const inScope = (ids: readonly string[]) =>
    ids.filter((id) => known.has(id) || labelled.some((g) => g.includes(id)));
  const truth = new Set(labelled.flatMap((g) => pairs([...g])));
  const predicted = new Set(ours.flatMap((g) => pairs(inScope(g))));
  const hits = [...predicted].filter((p) => truth.has(p)).length;
  const ourSets = ours.map((g) => [...inScope(g)].sort().join('|'));
  return {
    pairPrecision: ratio(hits, predicted.size),
    pairRecall: ratio(hits, truth.size),
    exactGroups: ratio(
      labelled.filter((g) => ourSets.includes([...g].sort().join('|'))).length,
      labelled.length,
    ),
    sameNames: ratio(
      Object.entries(labels.procedure_groups).filter(
        ([name, g]) => [...inScope(oursByKey.get(name) ?? [])].sort().join('|') === [...g].sort().join('|'),
      ).length,
      labelled.length,
    ),
  };
};

/** F-beta score (beta 2 weighs recall higher: a missed rule costs more than a false alarm). */
export const fBeta = (precision: number, recall: number, beta = 2): number =>
  precision + recall === 0
    ? 0
    : Math.round((((1 + beta ** 2) * precision * recall) / (beta ** 2 * precision + recall)) * 1000) / 1000;
