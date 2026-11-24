import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { canonicalJson, hashOf } from '../common/fp.js';
import { fileSource, fileWatermarks } from '../sources/file.source.js';
import { classifyDeterministic, keepTracked } from './classifier.js';
import { type EvalLabels, evaluate, evaluateGrouping, evaluateTiers } from './eval.js';
import { actionPointsOf, levelOf, refKey, validatedDraft } from './finding.js';
import { buildSnapshot, canJoin, computeGroups, type GroupMember } from './grouping.js';
import { identifiersIn } from './identifiers.js';
import { loadTaxonomy, naceLineage, nacePath, naceSelectionMatches, naceSelectionQueries } from './nace.js';
import { mapRev2Code, mapRev2Codes } from './nace-rev2.js';
import { loadPresets, toPreset } from './presets.js';

const DATA = join(import.meta.dirname, '../../../../data');
const tax = loadTaxonomy(join(DATA, 'nace_rev2_1.csv'));
const readLabels = (f: string) => JSON.parse(readFileSync(join(DATA, 'eval', f), 'utf8')) as EvalLabels;
const labels = readLabels('labels.json');
const extended = readLabels('labels.extended.json');
/** An operator profile from data/examples. */
type Profile = {
  readonly profile_id: string;
  readonly country: string;
  readonly nace_codes: readonly string[];
};

/** Seed items normalised exactly like the ingestion does. */
const seedMembers = async (file: string): Promise<readonly GroupMember[]> => {
  const source = fileSource(tax, { path: join(DATA, file), since: null, pollSeconds: 1, batchSize: 10 });
  const batches = await Array.fromAsync(source.fetch(null, new AbortController().signal));
  return batches.flatMap((b, batch) =>
    b.records.map((r, i) => {
      const d = validatedDraft(source.normalize(r));
      return {
        ...d,
        id: r.externalId,
        sourceId: 'file',
        externalId: r.externalId,
        refKey: refKey(d.ref),
        actionPoints: actionPointsOf(d),
        titleEn: null,
        summaryEn: null,
        streamSeq: batch * 10 + i,
      };
    }),
  );
};

describe('NACE Rev. 2.1', () => {
  it('loads the complete taxonomy', () => {
    const count = (level: string) => tax.nodes.filter((n) => n.level === level).length;
    expect([count('section'), count('division'), count('group'), count('class')]).toEqual([22, 87, 287, 651]);
  });

  it('builds paths and hierarchical selection queries', () => {
    expect(naceLineage('C24.42')).toEqual(['C24.42', 'C24.4', 'C24', 'C']);
    expect(nacePath('C24.4')).toBe('NACE.C.C24.C24_4');
    expect(naceSelectionQueries(['C24.4'])).toEqual(['NACE.C.C24.C24_4.*', 'NACE', 'NACE.C.C24', 'NACE.C']);
  });

  it('maps Rev. 2 tags onto Rev. 2.1 (K64 became L64)', () => {
    expect(mapRev2Code(tax, 'K64')).toMatchObject({ codes: ['L64'], exact: true });
    expect(mapRev2Code(tax, 'C24.1')).toMatchObject({ codes: ['C24.1'], exact: true });
    expect(mapRev2Code(tax, 'Z99')).toBeNull();
  });

  it('maps Rev. 2 codes with the official correspondence and reports where it is not exact', () => {
    expect(mapRev2Code(tax, 'C24')).toMatchObject({ codes: ['C24'], exact: true });
    expect(mapRev2Code(tax, 'C25')).toMatchObject({ codes: ['C25', 'C28.21'], exact: false });
    expect(mapRev2Code(tax, 'C10')).toMatchObject({ codes: ['C10', 'C11.07'], exact: false });
    expect(mapRev2Code(tax, 'A01')?.partial).toEqual([{ code: 'A01.48', alsoFrom: ['03.22'] }]);
    // Rev. 2.1 G47 also covers motor vehicle retail (G47.8, formerly G45): not part of Rev. 2 G47.
    expect(mapRev2Code(tax, 'G47')?.codes).toEqual([
      'G47.1',
      'G47.2',
      'G47.3',
      'G47.4',
      'G47.5',
      'G47.6',
      'G47.7',
      'G47.9',
      'J60.39',
    ]);
  });

  it('builds the UI presets with the same mapping as the pipeline, from the example profiles', () => {
    const presets = loadPresets(join(DATA, 'profile_presets.json'), tax);
    const examples = readdirSync(join(DATA, 'examples')).map(
      (f) => parse(readFileSync(join(DATA, 'examples', f), 'utf8')) as Profile,
    );
    expect(presets.map((p) => p.id).sort()).toEqual(examples.map((e) => e.profile_id).sort());
    for (const e of examples) {
      const preset = presets.find((p) => p.id === e.profile_id);
      expect(preset?.countries).toEqual([e.country]);
      expect(preset?.naceCodesRev2).toEqual(e.nace_codes);
      expect(preset?.naceCodes).toEqual(mapRev2Codes(tax, e.nace_codes));
      expect(preset?.exact).toBe(false);
    }
  });

  it('rejects preset countries that are not EU ISO 3166-1 alpha-2 codes (Greece is GR, not EL)', () => {
    const preset = (countries: string[]) => () =>
      toPreset(tax, { id: 'x', label: 'x', countries, naceCodesRev2: ['C24'] });
    expect(preset(['GR'])).not.toThrow();
    expect(preset(['EL'])).toThrow(/EL is not an EU ISO 3166-1 alpha-2 code/);
    expect(preset(['UK'])).toThrow(/UK is not/);
  });
});

describe('common schema', () => {
  it('hashes canonical JSON independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
  });

  it('derives action points from deadlines, votes and adoption', async () => {
    const byId = new Map((await seedMembers('items.json')).map((m) => [m.id, m]));
    expect(byId.get('EU-EP-0001')?.actionPoints).toEqual([
      { kind: 'amendment_deadline', date: '2026-12-09' },
      { kind: 'vote', date: '2026-12-15' },
      { kind: 'publication', date: '2026-11-03' },
    ]);
    expect(byId.get('EU-TRIS-0030')?.actionPoints[0]).toEqual({ kind: 'standstill_end', date: '2027-01-21' });
    expect(levelOf(byId.get('EU-TRIS-0030')?.jurisdiction ?? '')).toBe('national');
  });
});

describe('deterministic grouping', () => {
  it('reproduces every labelled procedure group of the seed, named after its first streamed item', async () => {
    const groups = computeGroups(await seedMembers('items.json'));
    expect(evaluateGrouping(labels, groups)).toEqual({
      pairPrecision: 1,
      pairRecall: 1,
      exactGroups: 1,
      sameNames: 1,
    });
  });

  it('streams the file in file order with watermarks that are safe to resume from', () => {
    expect(fileWatermarks(['2026-11-03', '2026-06-18', '2026-11-10', '2026-11-01', '2026-11-12'], 2)).toEqual(
      ['2026-11-01', '2026-11-12', '2026-11-12'],
    );
  });

  it('keeps group keys stable when later steps and reactions arrive (items.next.json)', async () => {
    const before = computeGroups(await seedMembers('items.json'));
    const after = computeGroups(await seedMembers('items.next.json'));
    expect(after.get('AT-PAR-0016')).toEqual([...(before.get('AT-PAR-0016') ?? []), 'AT-PAR-0054'].sort());
    expect(after.get('EU-HYS-0012')).toContain('EU-HYS-0058');
    expect([...before.keys()].every((k) => after.has(k))).toBe(true);
  });

  it('finds procedure identifiers across schemes', () => {
    expect(
      identifiersIn([
        'Plenary vote 2026/9101(COD) on COM(2026) 412',
        'CELEX 32026R9071, Ares(2026)9003890, TRIS 2026/0412/AT, BOE-A-2026-12345',
      ]),
    ).toEqual([
      { scheme: 'procedure', value: '2026/9101(COD)' },
      { scheme: 'celex', value: '32026R9071' },
      { scheme: 'com', value: 'COM(2026)412' },
      { scheme: 'ares', value: 'Ares(2026)9003890' },
      { scheme: 'tris', value: '2026/0412/AT' },
      { scheme: 'boe', value: 'BOE-A-2026-12345' },
    ]);
  });

  it('never lets the agent join groups of different jurisdictions', () => {
    expect(canJoin([{ jurisdiction: 'EU' }], [{ jurisdiction: 'EU' }, { jurisdiction: 'EU' }])).toBe(true);
    expect(canJoin([{ jurisdiction: 'AT' }], [{ jurisdiction: 'AT' }])).toBe(true);
    expect(canJoin([{ jurisdiction: 'EU' }], [{ jurisdiction: 'AT' }])).toBe(false);
    expect(canJoin([{ jurisdiction: 'DE' }], [{ jurisdiction: 'AT' }])).toBe(false);
  });

  it('builds a source trail with roles and the English primary', async () => {
    const members = await seedMembers('items.json');
    const ids = computeGroups(members).get('EU-LEX-0032') ?? [];
    const snap = buildSnapshot(
      'EU-LEX-0032',
      members.filter((m) => ids.includes(m.id)),
    );
    expect(snap.language).toBe('en');
    expect(snap.sourceTrail.map((t) => t.role).sort()).toEqual(['language_version', 'primary']);
  });
});

describe('deterministic classifier against the eval sets', () => {
  // The example profiles are NACE Rev. 2: scored with their Rev. 2.1 selection (the presets), like the eval command.
  // The selection below mirrors queryRadar in memory (jurisdiction scope, country, NACE selection, strongest
  // verdict); the SQL itself is only exercised by scripts/eval.sh.
  const profiles = loadPresets(join(DATA, 'profile_presets.json'), tax).map(
    (p): Profile => ({ profile_id: p.id, country: p.countries[0] ?? '', nace_codes: p.naceCodes }),
  );
  /** Shown (relevant + borderline) and strict (relevant only) metrics of one profile on the seed. */
  const score = async (set: EvalLabels, p: Profile) => {
    const members = await seedMembers('items.json');
    const byId = new Map(members.map((m) => [m.id, m]));
    const verdicts = [...computeGroups(members)].flatMap(([groupKey, ids]) => {
      const ms = ids.flatMap((i) => byId.get(i) ?? []);
      const snap = buildSnapshot(groupKey, ms);
      if (snap.level !== 'eu' && snap.jurisdiction !== p.country) return [];
      const { labels: ls } = classifyDeterministic(tax, { jurisdiction: snap.jurisdiction, members: ms });
      const hits = ls.filter(
        (l) => l.country === p.country && naceSelectionMatches(p.nace_codes, l.naceCode),
      );
      return [{ groupKey, externalIds: ids, verdicts: new Set(hits.map((l) => l.verdict)) }];
    });
    const shownAs = (vs: readonly string[]) =>
      verdicts.filter((v) => vs.some((x) => v.verdicts.has(x as never)));
    return {
      shown: evaluate(set, p.profile_id, shownAs(['relevant', 'borderline'])),
      strict: evaluate(set, p.profile_id, shownAs(['relevant'])),
      tiers: evaluateTiers(set, p.profile_id, shownAs(['relevant', 'borderline']), shownAs(['relevant'])),
    };
  };

  it('scores every labelled profile (a profile without a preset would be skipped silently)', () => {
    const ids = profiles.map((p) => p.profile_id);
    expect(
      [...Object.keys(extended.profiles), ...Object.keys(labels.profiles)].filter((id) => !ids.includes(id)),
    ).toEqual([]);
  });

  it.each(profiles)(
    '$profile_id: no miss and no false alarm on labels.extended.json (shown and strict)',
    async (p) => {
      const { shown, strict } = await score(extended, p);
      expect({
        shown: [shown.missed, shown.falseAlarms],
        strict: [strict.missed, strict.falseAlarms],
      }).toEqual({
        shown: [[], []],
        strict: [[], []],
      });
    },
  );

  it.each(profiles)(
    '$profile_id: reproduces every tier of labels.extended.json, borderline included',
    async (p) => {
      expect((await score(extended, p)).tiers.mismatches).toEqual([]);
    },
  );

  it.each(profiles.filter((p) => labels.profiles[p.profile_id]))(
    '$profile_id: recall 1 on the standard labels.json',
    async (p) => {
      expect((await score(labels, p)).shown.missed).toEqual([]);
    },
  );

  it('keeps a relevant pair tracked when a later classification drops it', () => {
    const before = [
      { country: 'AT', naceCode: 'C24', verdict: 'relevant' as const, score: 2, rationale: 'steel' },
    ];
    const merged = keepTracked(before, []);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.rationale).toMatch(/^Kept tracked/);
  });
});
