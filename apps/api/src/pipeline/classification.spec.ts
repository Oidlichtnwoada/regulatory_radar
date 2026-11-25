import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CountryLabel,
  classifyDeterministic,
  consensusLabels,
  keepTracked,
  ruleMatches,
  runsAgree,
  type SectorLabel,
  safetyNet,
} from '../domain/classifier.js';
import type { GroupMember } from '../domain/grouping.js';
import { loadTaxonomy, naceDocument, searchNaceText } from '../domain/nace.js';
import { classificationEngine, naceLabelProblems, validLabels } from './classification.stage.js';

const tax = loadTaxonomy(join(import.meta.dirname, '../../../../data/nace_rev2_1.csv'));
const label = (naceCode: string, verdict: SectorLabel['verdict']): SectorLabel => ({
  naceCode,
  verdict,
  score: 1,
  rationale: `rule ${naceCode}`,
});

describe('NACE Rev. 2.1 codes of the classification agent', () => {
  it('accepts a code with its official title and the horizontal code', () => {
    expect(
      naceLabelProblems(tax, [
        { naceCode: 'C24', naceTitle: 'Manufacture of basic metals' },
        { naceCode: '*', naceTitle: 'every sector' },
      ]),
    ).toEqual([]);
  });

  it('sends Rev. 2 codes and mismatching titles back with a hint', () => {
    const [rev2, wrongTitle] = naceLabelProblems(tax, [
      { naceCode: 'L68', naceTitle: 'Real estate activities' },
      { naceCode: 'G47', naceTitle: 'Manufacture of basic metals' },
    ]);
    expect(rev2).toContain('As a Rev. 2 code it corresponds to');
    expect(rev2).toContain('M68.2 "Rental and operating of own or leased real estate"');
    expect(wrongTitle).toContain('G47 is "Retail trade"');
  });

  it('finds codes by words of the explanatory notes, not only titles', () => {
    expect(searchNaceText(tax, 'supermarkets', 5).map((n) => n.code)).toContain('G47.1');
    const precious = tax.byCode.get('C24.41');
    expect(precious && naceDocument(precious)).toContain('This class includes');
  });
});

describe('recall safety net', () => {
  it('adds rule sectors the agent left out as borderline, respecting its explicit decisions', () => {
    const agent = [label('C24', 'relevant'), label('G47', 'not_relevant')];
    const rules = [label('C24.4', 'relevant'), label('G47', 'borderline'), label('C10', 'relevant')];
    expect(safetyNet(agent, rules)).toEqual([
      {
        naceCode: 'C10',
        verdict: 'borderline',
        score: 1,
        rationale: 'Safety net, not covered by the agent: rule C10',
      },
    ]);
  });

  it('adds nothing when the agent labelled every business', () => {
    expect(safetyNet([label('*', 'relevant')], [label('C10', 'relevant')])).toEqual([]);
  });

  it('is not switched off by a not_relevant label on every sector', () => {
    expect(
      safetyNet([label('*', 'not_relevant')], [label('C10', 'relevant')]).map((l) => l.naceCode),
    ).toEqual(['C10']);
  });
});

describe("validation of the agent's labels", () => {
  const agent = (
    naceCode: string,
    naceTitle: string,
    verdict: SectorLabel['verdict'],
    countries: string[] | null,
    basis: 'named' | 'speculative' = 'named',
  ) => ({
    naceCode,
    naceTitle,
    basis,
    verdict,
    countries,
    rationale: `agent ${naceCode}`,
  });

  it('separates keyword traps, drops codes whose title still does not match, maps Rev. 2 codes, normalises countries', () => {
    const { kept, rejected, dropped } = validLabels(tax, 'EU', [
      agent('c24', 'Manufacture of basic metals', 'relevant', ['el', 'at', 'US']),
      agent('G47', 'Retail trade', 'not_relevant', null),
      agent('C33', 'Computer programming activities', 'relevant', null),
      agent('K64', 'Financial services', 'relevant', null),
    ]);
    expect(kept[0]).toEqual({
      naceCode: 'C24',
      verdict: 'relevant',
      score: null,
      rationale: 'agent c24',
      countries: ['GR', 'AT'],
    });
    expect(rejected.map((l) => l.naceCode)).toEqual(['G47']);
    // K64 is a Rev. 2 code the model kept: mapped with the official correspondence instead of losing the label.
    expect(kept.filter((l) => l.naceCode !== 'C24').map((l) => [l.naceCode, l.rationale])).toEqual([
      ['L64', 'agent K64 (mapped from NACE Rev. 2 K64)'],
    ]);
    expect(dropped).toHaveLength(1);
  });

  it('discards labels the agent marks as speculative, without counting them as invalid', () => {
    const { kept, rejected, dropped, speculative } = validLabels(tax, 'EU', [
      agent('C24', 'Manufacture of basic metals', 'relevant', null),
      agent('C10', 'Manufacture of food products', 'borderline', null, 'speculative'),
    ]);
    expect(kept.map((l) => l.naceCode)).toEqual(['C24']);
    expect([rejected, dropped, speculative]).toEqual([[], [], ['C10']]);
  });

  it('falls back to the whole scope when no given country is in it', () => {
    const { kept } = validLabels(tax, 'AT', [
      agent('C24', 'Manufacture of basic metals', 'relevant', ['DE']),
    ]);
    expect(kept[0]?.countries).toBeUndefined();
  });
});

describe('stays tracked', () => {
  const pair = (naceCode: string, verdict: CountryLabel['verdict']): CountryLabel => ({
    country: 'AT',
    naceCode,
    verdict,
    score: 2,
    rationale: naceCode,
  });

  it('does not carry a pair the new classification rejects as a keyword trap', () => {
    const previous = [pair('G47.1', 'borderline'), pair('C24', 'relevant')];
    const next = keepTracked(previous, [], [pair('G47', 'not_relevant')]);
    expect(next.map((l) => l.naceCode)).toEqual(['C24']);
  });

  it('never returns not_relevant labels', () => {
    expect(
      keepTracked([], [pair('G47', 'not_relevant'), pair('C24', 'relevant')]).map((l) => l.naceCode),
    ).toEqual(['C24']);
  });
});

describe('keyword rules', () => {
  const member = (title: string, naceTags: string[] = []): GroupMember =>
    ({
      title,
      titleEn: null,
      summary: null,
      summaryEn: null,
      topics: [],
      stage: 'proposal',
      naceTags,
    }) as unknown as GroupMember;
  const codes = (title: string) =>
    ruleMatches({ jurisdiction: 'EU', members: [member(title)] }).conceptLabels.map((l) => l.naceCode);

  it.each([
    ['Reglamento del transporte ferroviario de mercancías', 'C24.1'],
    ['Ustawa o stałych kosztach', 'C24.1'],
    ['Stale data in energy storage systems that are stored on site', 'G47'],
    ['Precios de la farmacia y productos farmacéuticos', 'A01'],
    ['Research and development tax credit for SMEs', 'L64'],
  ])('"%s" does not suggest %s', (title, code) => {
    expect(codes(title)).not.toContain(code);
  });

  it.each([
    ['Ferroalloys: safeguard measures', 'C24.1'],
    ['Wyroby ze stali i wyroby stalowe', 'C24.1'],
    ['Farm to fork: support for farmers', 'A01'],
    ['Consumer credit directive', 'L64'],
  ])('"%s" still suggests %s', (title, code) => {
    expect(codes(title)).toContain(code);
  });

  it('keeps the stated tag rationale when a keyword gives the same verdict', () => {
    const { labels } = classifyDeterministic(tax, {
      jurisdiction: 'AT',
      members: [member('Steel and iron: stahl emissions rules', ['C24.1'])],
    });
    expect(labels.find((l) => l.naceCode === 'C24.1')?.rationale).toMatch(/^The channel tags/);
  });
});

describe('classification engine id', () => {
  it('carries the rules version, so a rule or prompt change re-classifies', () => {
    expect(classificationEngine('deterministic')).toMatch(/^deterministic@[0-9a-f]{8}$/);
    expect(classificationEngine('agent:openai:x')).toMatch(/^agent:openai:x@[0-9a-f]{8}$/);
    expect(classificationEngine('agent:openai:x').split('@')[1]).not.toBe(
      classificationEngine('deterministic').split('@')[1],
    );
  });
});

describe('consensus of independent classification runs', () => {
  const show = (labels: readonly SectorLabel[]) => labels.map((l) => `${l.naceCode}:${l.verdict}`);

  it('two runs: keeps the sectors both cover (deeper code; * covers every code) with the lower verdict', () => {
    const runs = [
      [label('C24', 'relevant'), label('C10', 'borderline'), label('G47', 'relevant')],
      [label('C24.10', 'relevant'), label('*', 'borderline')],
    ];
    // Run 2's "* borderline" also covers C24: both agree on C24 borderline and on C24.10 relevant.
    expect(show(consensusLabels(runs))).toEqual([
      'C24.10:relevant',
      'C24:borderline',
      'C10:borderline',
      'G47:borderline',
    ]);
    expect(runsAgree(runs)).toBe(false);
    expect(runsAgree([[label('C24', 'relevant')], [label('C24', 'relevant')]])).toBe(true);
  });

  it('three runs: a majority decides the sector and the verdict (median)', () => {
    const runs = [
      [label('C24', 'relevant'), label('C10', 'borderline')],
      [label('C24', 'borderline')],
      [label('C24', 'relevant'), label('G47', 'relevant')],
    ];
    expect(show(consensusLabels(runs))).toEqual(['C24:relevant']);
  });

  it('a single run is unchanged and disjoint countries do not agree', () => {
    expect(show(consensusLabels([[label('C24', 'relevant')]]))).toEqual(['C24:relevant']);
    const at = { ...label('C24', 'relevant'), countries: ['AT'] };
    const pl = { ...label('C24', 'relevant'), countries: ['PL'] };
    expect(consensusLabels([[at], [pl]])).toEqual([]);
  });
});
