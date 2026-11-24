import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SectorLabel, safetyNet } from '../domain/classifier.js';
import { loadTaxonomy, naceDocument, searchNaceText } from '../domain/nace.js';
import { naceLabelProblems } from './classification.stage.js';

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
});
