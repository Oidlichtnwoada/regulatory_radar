import { describe, expect, it } from 'vitest';
import { tokenBudget } from './tokens.js';

describe('token budget', () => {
  it('counts special-token strings in source text as plain text instead of throwing', () => {
    const budget = tokenBudget(8192);
    expect(budget.count('a <|endoftext|> b')).toBeGreaterThan(3);
    expect(budget.truncate('x <|endoftext|> '.repeat(10), 5)).not.toBe('');
  });
});
