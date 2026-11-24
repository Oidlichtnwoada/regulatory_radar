import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { canonicalJson, sleep } from '../common/fp.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../db/prisma.service.js';
import { type EvalLabels, evaluate, evaluateGrouping, evaluateTiers, fBeta } from '../domain/eval.js';
import type { ProfilePreset } from '../domain/presets.js';
import { engines } from '../llm/providers.js';
import { queryRadar, type RadarEntry } from '../radar/queries.js';
import { pipelineStatus } from '../radar/status.js';
import { AI, PRESETS, TAXONOMY } from '../tokens.js';

/** An operator profile as scored (NACE Rev. 2.1). */
type Profile = {
  readonly profile_id: string;
  readonly country: string;
  readonly nace_codes: readonly string[];
};

/** Reads `--name value` style options. */
const option = (args: readonly string[], name: string): readonly string[] =>
  args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1] ?? ''] : []));

/** Waits until every stage has caught up (nothing pending, every group classified, stable twice). */
const waitForPipeline = async (ctx: INestApplicationContext, timeoutSeconds: number): Promise<boolean> => {
  const db = ctx.get(PrismaService);
  const ai = ctx.get(AI);
  const deadline = Date.now() + timeoutSeconds * 1000;
  const idle = async () => {
    const s = await pipelineStatus(db, ai, ctx.get(TAXONOMY));
    return (
      s.findings > 0 &&
      s.translations.pending === 0 &&
      s.embeddings.pending === 0 &&
      (ai.embedding === null || s.naceEmbeddings.embedded === s.naceEmbeddings.total) &&
      s.groups > 0 &&
      s.classifiedGroups === s.groups
    );
  };
  while (Date.now() < deadline) {
    if (await idle()) {
      await sleep(5000);
      if (await idle()) return true;
    }
    await sleep(3000);
  }
  return false;
};

/** Strict (relevant only) and shown (relevant + borderline) metrics plus checks for one profile. */
const evalProfile = async (
  db: PrismaService,
  labels: EvalLabels,
  profile: Profile,
  externalIds: ReadonlyMap<string, string>,
) => {
  const query = (verdicts: ('relevant' | 'borderline')[]) =>
    queryRadar(db, {
      countries: [profile.country],
      naceCodes: profile.nace_codes,
      verdicts,
      asOf: new Date(`${labels.as_of}T00:00:00Z`),
      limit: 500,
      offset: 0,
      acknowledgedAt: null,
    });
  const shown = await query(['relevant', 'borderline']);
  const again = await query(['relevant', 'borderline']);
  const strict = await query(['relevant']);
  const asShown = (entries: readonly RadarEntry[]) =>
    entries.map((e) => ({
      groupKey: e.groupKey,
      externalIds: e.sourceTrail.map((t) => externalIds.get(t.findingId) ?? t.externalId),
    }));
  const m = evaluate(labels, profile.profile_id, asShown(shown.entries));
  const s = evaluate(labels, profile.profile_id, asShown(strict.entries));
  const tiers = evaluateTiers(labels, profile.profile_id, asShown(shown.entries), asShown(strict.entries));
  const ranks = shown.entries.map((e) => e.actionability.rank);
  return {
    profile: profile.profile_id,
    country: profile.country,
    naceCodes: profile.nace_codes,
    shown: { recall: m.recall, precision: m.precision, f2: fBeta(m.precision, m.recall) },
    strict: { recall: s.recall, precision: s.precision, f2: fBeta(s.precision, s.recall) },
    tiers,
    counts: {
      entries: shown.entries.length,
      tp: m.truePositives,
      fp: m.falsePositives,
      fn: m.falseNegatives,
      groupsChecked: shown.groupsChecked,
    },
    missed: m.missed,
    falseAlarms: m.falseAlarms,
    splitGroups: m.splitGroups,
    jurisdictionLeaks: shown.entries.filter(
      (e) => e.jurisdiction !== 'EU' && e.jurisdiction !== profile.country,
    ).length,
    whyRelevantCoverage: shown.entries.length
      ? shown.entries.filter((e) => e.whyRelevant.trim()).length / shown.entries.length
      : 1,
    rankingDeterministic: canonicalJson(shown.entries) === canonicalJson(again.entries),
    tiersOrdered: ranks.every((r, i) => i === 0 || (ranks[i - 1] ?? 0) <= r),
  };
};

/** One result line per label file and profile, for humans (stderr; stdout stays pure JSON). */
const summaryLines = (
  results: readonly {
    readonly labels: string;
    readonly grouping: { readonly pairPrecision: number; readonly pairRecall: number };
    readonly profiles: readonly Awaited<ReturnType<typeof evalProfile>>[];
  }[],
): readonly string[] =>
  results.flatMap((set) =>
    set.profiles.map((p) =>
      [
        `${set.labels.padEnd(26)} ${p.profile.padEnd(12)}`,
        `recall ${p.shown.recall} precision ${p.shown.precision} F2 ${p.shown.f2}`,
        `strict recall ${p.strict.recall} precision ${p.strict.precision}`,
        `tiers ${p.tiers.agreement}${p.tiers.mismatches.length ? ` (${p.tiers.mismatches.map((m) => `${m.group} ${m.label}->${m.ours}`).join(', ')})` : ''}`,
        `grouping pairs P ${set.grouping.pairPrecision} R ${set.grouping.pairRecall}`,
      ].join(' | '),
    ),
  );

/**
 * `eval [--labels file]... [--wait-seconds n]`: scores the radar stored in Postgres (whatever engine
 * produced it: deterministic offline or LLM online) against labelled profiles, by default both label files.
 * Prints JSON on stdout and one summary line per label file and profile on stderr.
 */
export const runEval = async (
  ctx: INestApplicationContext,
  env: Env,
  args: readonly string[],
): Promise<number> => {
  const db = ctx.get(PrismaService);
  const waitSeconds = Number(option(args, 'wait-seconds')[0] ?? 900);
  const files = option(args, 'labels');
  const labelFiles = files.length
    ? files
    : ['eval/labels.json', 'eval/labels.extended.json'].map((f) => join(env.DATA_DIR, f));
  const ready = await waitForPipeline(ctx, waitSeconds);
  // The example profiles are NACE Rev. 2; they are scored with their Rev. 2.1 selection (the UI presets).
  const profiles = ctx
    .get<readonly ProfilePreset[]>(PRESETS)
    .map((p): Profile => ({ profile_id: p.id, country: p.countries[0] ?? '', nace_codes: p.naceCodes }));
  const groups = await db.$queryRaw<{ key: string; ids: string[] }[]>`
    SELECT g.group_key AS key, array_agg(f.external_id ORDER BY f.external_id) AS ids
    FROM radar_group_current g, unnest(g.member_ids) m(id) JOIN finding f ON f.id = m.id
    WHERE f.source_id = 'file' GROUP BY g.group_key`;
  const externalIds = new Map(
    (await db.finding.findMany({ where: { sourceId: 'file' }, select: { id: true, externalId: true } })).map(
      (f) => [f.id, f.externalId],
    ),
  );
  const results = await Promise.all(
    labelFiles.map(async (file) => {
      const labels = JSON.parse(readFileSync(file, 'utf8')) as EvalLabels;
      return {
        labels: file.split('/').slice(-2).join('/'),
        asOf: labels.as_of,
        grouping: evaluateGrouping(labels, new Map(groups.map((g) => [g.key, g.ids]))),
        profiles: await Promise.all(
          profiles
            .filter((p) => labels.profiles[p.profile_id])
            .map((p) => evalProfile(db, labels, p, externalIds)),
        ),
      };
    }),
  );
  console.log(JSON.stringify({ engines: engines(ctx.get(AI)), pipelineCaughtUp: ready, results }, null, 2));
  if (!ready) console.error(`pipeline did not catch up within ${waitSeconds} s; scores are incomplete`);
  console.error(summaryLines(results).join('\n'));
  return ready ? 0 : 2;
};
