import { getValue, type Translation } from '@jsverse/transloco';
import enUS from '../../i18n/en-US.json';
import { ActionTier, type NaceCode, NaceCodeLevelEnum } from '../api-client';
import {
  ENUM_LABELS,
  filterEntries,
  HEALTH_CHIPS,
  humanise,
  type LabelGroup,
  labelKey,
  listQuery,
  searchNace,
  TIER_CHIPS,
  VERDICT_CHIPS,
} from './labels';

const nace = (code: string, title: string, depth: number): NaceCode => ({
  code,
  title,
  depth,
  level: [
    NaceCodeLevelEnum.section,
    NaceCodeLevelEnum.division,
    NaceCodeLevelEnum.group,
    NaceCodeLevelEnum.class,
  ][depth],
});

const taxonomy: NaceCode[] = [
  nace('C', 'Manufacturing', 0),
  nace('C24', 'Manufacture of basic metals', 1),
  nace('C24.4', 'Manufacture of basic precious and other non-ferrous metals', 2),
  nace('G', 'Wholesale and retail trade', 0),
  nace('G47', 'Retail trade', 1),
];

describe('searchNace', () => {
  it('lists every code without a query, minus the selected codes', () => {
    expect(searchNace(taxonomy, '', ['C']).map((c) => c.code)).toEqual(['C24', 'C24.4', 'G', 'G47']);
  });

  it('filters by code prefix when the query starts any code, even if titles contain it', () => {
    expect(searchNace(taxonomy, 'c24', []).map((c) => c.code)).toEqual(['C24', 'C24.4']);
    expect(searchNace(taxonomy, 'g', []).map((c) => c.code)).toEqual(['G', 'G47']);
  });

  it('otherwise searches the titles, case-insensitively, in taxonomy order', () => {
    expect(searchNace(taxonomy, 'RETAIL', []).map((c) => c.code)).toEqual(['G', 'G47']);
    expect(searchNace(taxonomy, 'metals', []).map((c) => c.code)).toEqual(['C24', 'C24.4']);
    expect(searchNace(taxonomy, '4', []).map((c) => c.code)).toEqual([]);
  });
});

describe('listQuery', () => {
  it('joins list values with commas, encodes them and drops empty lists', () => {
    expect(listQuery({ countries: ['AT', 'ES'], naceCodes: [], q: ['a b'] })).toBe('countries=AT,ES&q=a%20b');
  });
});

describe('TIER_CHIPS', () => {
  it('has a label for every tier the API can return', () => {
    expect(Object.keys(TIER_CHIPS).sort()).toEqual(Object.values(ActionTier).sort());
  });
});

describe('chip label keys', () => {
  it('exist in en-US.json for every tier, verdict and health state', () => {
    const keys = [TIER_CHIPS, VERDICT_CHIPS, HEALTH_CHIPS].flatMap((chips) =>
      Object.values(chips).map((c) => c.labelKey),
    );
    expect(keys.filter((key) => typeof getValue<Translation>(enUS, key) !== 'string')).toEqual([]);
  });
});

describe('enum labels', () => {
  it('exist in en-US.json for every value of every API enum shown as text', () => {
    const keys = Object.entries(ENUM_LABELS).flatMap(([group, values]) =>
      values.map((value) => labelKey(group as LabelGroup, value)),
    );
    expect(keys.filter((key) => typeof getValue<Translation>(enUS, key) !== 'string')).toEqual([]);
  });

  it('humanises values of open sets that have no key', () => {
    expect(humanise('royal_decree_law')).toBe('Royal decree law');
    expect(humanise('notice')).toBe('Notice');
  });
});

describe('filterEntries', () => {
  it('renders lists comma-separated and unset values as empty text', () => {
    expect(filterEntries({ since: null, lookbackDays: 7, sections: ['1', '2'], departments: [] })).toEqual([
      { key: 'since', value: '' },
      { key: 'lookbackDays', value: '7' },
      { key: 'sections', value: '1, 2' },
      { key: 'departments', value: '' },
    ]);
  });
});
