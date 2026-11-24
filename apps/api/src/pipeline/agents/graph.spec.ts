import { tool } from '@langchain/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAX_TOOL_CALLS_PER_TURN, runToolCalls } from './graph.js';

describe('agent tool calls', () => {
  const echo = tool(async ({ n }: { n: number }) => `ran ${n}`, {
    name: 'echo',
    description: 'echo',
    schema: z.object({ n: z.number() }),
  });

  it('runs at most MAX_TOOL_CALLS_PER_TURN calls per turn and answers every call', async () => {
    const calls = Array.from({ length: 7 }, (_, n) => ({ id: `c${n}`, name: 'echo', args: { n } }));
    const replies = await runToolCalls([echo], calls);
    expect(replies.map((r) => r.tool_call_id)).toEqual(calls.map((c) => c.id));
    expect(replies.filter((r) => String(r.content).startsWith('ran'))).toHaveLength(MAX_TOOL_CALLS_PER_TURN);
    expect(String(replies[6]?.content)).toMatch(/at most 4 tool calls/);
  });

  it('turns unknown tools and invalid arguments into error results', async () => {
    const replies = await runToolCalls(
      [echo],
      [
        { id: 'a', name: 'nope', args: {} },
        { id: 'b', name: 'echo', args: { n: 'x' } },
      ],
    );
    expect(String(replies[0]?.content)).toMatch(/unknown tool/);
    expect(String(replies[1]?.content)).toMatch(/^error:/);
  });
});
