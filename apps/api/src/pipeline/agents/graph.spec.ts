import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { OutputParserException } from '@langchain/core/output_parsers';
import { RunnableLambda } from '@langchain/core/runnables';
import { tool } from '@langchain/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAX_TOOL_CALLS_PER_TURN, runAgent, runToolCalls, unparsedOutput } from './graph.js';

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

describe('final answer of an agent run', () => {
  const schema = z.object({ answer: z.string() });
  /** Chat model that does no research and returns the given final answers in turn (a model may skip the tool). */
  const chatAnswering = (...finals: unknown[]): BaseChatModel =>
    ({
      bindTools: () => RunnableLambda.from(async () => new AIMessage('no tools needed')),
      withStructuredOutput: () => RunnableLambda.from(async () => finals.shift()),
    }) as unknown as BaseChatModel;
  const run = (chat: BaseChatModel) =>
    runAgent({ chat, tools: [], system: 's', task: 't', schema, maxSteps: 2, maxCorrections: 1 });

  it('asks again when the model gives no final answer, instead of passing undefined on', async () => {
    const { answer, trace } = await run(chatAnswering(undefined, { answer: 'ok' }));
    expect(answer).toEqual({ answer: 'ok' });
    expect(trace.at(-1)?.content).toMatch(/call the final_answer tool/);
  });

  it('names the exact schema problem when the provider parser rejects an answer (e.g. an omitted field)', async () => {
    const rejected = new OutputParserException('Failed to parse.', '{"other":1}');
    expect(unparsedOutput(rejected)).toEqual({ other: 1 });
    expect(() => unparsedOutput(new Error('429'))).toThrow('429');
    const { answer, trace } = await run(chatAnswering(unparsedOutput(rejected), { answer: 'ok' }));
    expect(answer).toEqual({ answer: 'ok' });
    expect(trace.at(-1)?.content).toMatch(/does not match the schema: answer: Invalid input/);
  });

  it('fails the run with a clear error when no valid answer comes', async () => {
    await expect(run(chatAnswering(undefined, { wrong: 1 }))).rejects.toThrow(
      /no valid final answer after 2 attempts/,
    );
  });
});
