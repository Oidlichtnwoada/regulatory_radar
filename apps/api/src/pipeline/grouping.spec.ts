import { describe, expect, it } from 'vitest';
import type { GroupMember } from '../domain/grouping.js';
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
