import { describe, expect, it } from 'vitest';
import { computeGroups, type GroupMember } from '../domain/grouping.js';
import { joinRejection } from './grouping.stage.js';

const member = (id: string, jurisdiction: string) => ({ id, jurisdiction }) as GroupMember;
const byId = new Map([
  ['eu1', member('eu1', 'EU')],
  ['eu2', member('eu2', 'EU')],
  ['at1', member('at1', 'AT')],
]);
const item = { key: 'EU-LEX-0011', members: [member('eu1', 'EU')] };
const join = (targetGroupKey: string, confidence: 'high' | 'medium' | 'low' = 'high') => ({
  decision: 'join' as const,
  targetGroupKey,
  confidence,
});

describe('grouping agent decisions are checked in code', () => {
  it('applies a confident join within one jurisdiction', () => {
    expect(joinRejection(join('EU-LEX-0015'), item, ['eu2'], byId)).toBeNull();
  });

  it('rejects cross-jurisdiction, unsure, unknown and self joins', () => {
    expect(joinRejection(join('AT-PAR-0016'), item, ['at1'], byId)).toBe('different jurisdictions');
    expect(joinRejection(join('EU-LEX-0015', 'medium'), item, ['eu2'], byId)).toBe('confidence medium');
    expect(joinRejection(join('NOPE'), item, null, byId)).toBe('unknown target group');
    expect(joinRejection(join('EU-LEX-0011'), item, ['eu1'], byId)).toBe('unknown target group');
  });

  it('never rejects a "separate" answer', () => {
    expect(
      joinRejection({ decision: 'separate', targetGroupKey: null, confidence: 'low' }, item, null, byId),
    ).toBeNull();
  });
});

describe('agent joins are resolved per item', () => {
  const item = (
    id: string,
    sourceId: string,
    externalId: string,
    streamSeq: number,
    extra: Partial<GroupMember> = {},
  ) =>
    ({
      id,
      sourceId,
      externalId,
      streamSeq,
      jurisdiction: 'EU',
      refKey: null,
      relatedTo: null,
      ...extra,
    }) as GroupMember;

  it('keeps a join after a new version of the joining item (new finding id)', () => {
    const join = { sourceId: 'file', externalId: 'B', targetGroupKey: 'file:A' };
    const v1 = computeGroups([item('a', 'file', 'A', 1), item('b1', 'file', 'B', 2)], [join]);
    const v2 = computeGroups([item('a', 'file', 'A', 1), item('b2', 'file', 'B', 2)], [join]);
    expect([...v1]).toEqual([['A', ['a', 'b1']]]);
    expect([...v2]).toEqual([['A', ['a', 'b2']]]);
  });

  it('resolves a plain target id only when it is unambiguous', () => {
    const members = [
      item('x1', 's1', 'X', 1),
      item('x2', 's2', 'X', 2, { jurisdiction: 'AT' }),
      item('y', 's2', 'Y', 3),
    ];
    const plain = computeGroups(members, [{ sourceId: 's2', externalId: 'Y', targetGroupKey: 'X' }]);
    expect(plain.size).toBe(3);
    const qualified = computeGroups(members, [{ sourceId: 's2', externalId: 'Y', targetGroupKey: 's1:X' }]);
    expect(qualified.get('s1:X')).toEqual(['x1', 'y']);
  });

  it('links shared references only within one jurisdiction', () => {
    const groups = computeGroups([
      item('at', 'file', 'AT-1', 1, { jurisdiction: 'AT', refKey: '2026/1' }),
      item('pl', 'file', 'PL-1', 2, { jurisdiction: 'PL', refKey: '2026/1' }),
      item('at2', 'file', 'AT-2', 3, { jurisdiction: 'AT', refKey: '2026/1' }),
    ]);
    expect([...groups]).toEqual([
      ['AT-1', ['at', 'at2']],
      ['PL-1', ['pl']],
    ]);
  });
});
