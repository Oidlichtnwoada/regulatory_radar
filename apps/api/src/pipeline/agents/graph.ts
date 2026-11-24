import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import type { z } from 'zod';
import { errorMessage } from '../../common/fp.js';

/** Tool calls executed per model turn; further calls of the same turn are answered with an error. */
export const MAX_TOOL_CALLS_PER_TURN = 4;

/** Default limit of one whole agent run (all turns, tools and the final answer). */
const DEFAULT_RUN_TIMEOUT_MS = 600_000;

/** Largest research-notes text sent with the final structured request (characters). */
const MAX_NOTES_CHARS = 60_000;

/** Compact trace entry stored with agent results (introspection in the UI / API). */
export interface TraceStep {
  /** Message type (ai, tool, human, system). */
  readonly type: string;
  /** Truncated content. */
  readonly content: string;
  /** Tool calls requested by the model. */
  readonly toolCalls?: readonly { readonly name: string; readonly args: unknown }[];
}

/** Input of a tool-using agent run. */
export interface AgentRun<S extends z.ZodType> {
  /** Chat model (temperature 0). */
  readonly chat: BaseChatModel;
  /** Tools the agent may call. */
  readonly tools: readonly StructuredToolInterface[];
  /** System prompt. */
  readonly system: string;
  /** The task. */
  readonly task: string;
  /** Schema of the final answer. */
  readonly schema: S;
  /** Maximum agent <-> tool round trips. */
  readonly maxSteps: number;
  /** Optional check of the final answer; its problems are sent back for correction (empty = valid). */
  readonly validate?: (answer: z.infer<S>) => readonly string[];
  /** Correction rounds after a failed validation (default 2). */
  readonly maxCorrections?: number;
  /** Aborts the run (e.g. shutdown); combined with the run timeout. */
  readonly signal?: AbortSignal;
  /** Limit of the whole run in ms (default 10 minutes). */
  readonly timeoutMs?: number;
}

/** A tool call of a model turn. */
type ToolCall = NonNullable<AIMessage['tool_calls']>[number];

/**
 * Executes the first MAX_TOOL_CALLS_PER_TURN tool calls of a turn (in parallel) and answers the rest with an error,
 * so a model cannot blow up the context with dozens of calls per turn. Every call gets a result message, as the
 * providers require. Tool errors become results, never exceptions.
 */
export const runToolCalls = async (
  tools: readonly StructuredToolInterface[],
  calls: readonly ToolCall[],
): Promise<readonly ToolMessage[]> =>
  Promise.all(
    calls.map(async (call, i) => {
      const reply = (content: string) =>
        new ToolMessage({ tool_call_id: call.id ?? '', name: call.name, content });
      if (i >= MAX_TOOL_CALLS_PER_TURN)
        return reply(
          `error: at most ${MAX_TOOL_CALLS_PER_TURN} tool calls per turn; repeat this call in the next turn if you still need it`,
        );
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) return reply(`error: unknown tool ${call.name}`);
      return tool.invoke(call.args).then(
        (r: unknown) => reply(typeof r === 'string' ? r : JSON.stringify(r)),
        (e: unknown) => reply(`error: ${errorMessage(e)}`),
      );
    }),
  );

/** Converts messages to a compact, storable trace. */
const toTrace = (messages: readonly BaseMessage[]): readonly TraceStep[] =>
  messages.map((m) => ({
    type: m.type,
    // The task (human message) is kept in full for introspection; model and tool messages are shortened.
    content: (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(
      0,
      m.type === 'human' ? 20_000 : 1500,
    ),
    ...(AIMessage.isInstance(m) && m.tool_calls?.length
      ? { toolCalls: m.tool_calls.map((c) => ({ name: c.name, args: c.args })) }
      : {}),
  }));

/**
 * LangGraph ReAct loop shared by all agents: `agent` (model with tools bound) <-> `tools` until the
 * model stops calling tools or the step budget is used, then a structured final answer.
 */
export const runAgent = async <S extends z.ZodType>(
  run: AgentRun<S>,
): Promise<{ readonly answer: z.infer<S>; readonly trace: readonly TraceStep[] }> => {
  const bound = run.chat.bindTools?.([...run.tools]);
  if (!bound) throw new Error('chat model does not support tool calling');
  const signal = AbortSignal.any([
    AbortSignal.timeout(run.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS),
    ...(run.signal ? [run.signal] : []),
  ]);
  const system = new SystemMessage(run.system);
  const aiTurns = (messages: readonly BaseMessage[]) =>
    messages.filter((m) => AIMessage.isInstance(m)).length;
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('agent', async (state) => ({
      messages: [await bound.invoke([system, ...state.messages], { signal })],
    }))
    .addNode('tools', async (state) => {
      const last = state.messages.at(-1);
      const calls = last && AIMessage.isInstance(last) ? (last.tool_calls ?? []) : [];
      return { messages: [...(await runToolCalls(run.tools, calls))] };
    })
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', (state) => {
      const last = state.messages.at(-1);
      const wantsTools = last && AIMessage.isInstance(last) && (last.tool_calls?.length ?? 0) > 0;
      return wantsTools && aiTurns(state.messages) < run.maxSteps ? 'tools' : END;
    })
    .addEdge('tools', 'agent')
    .compile();
  const final = await graph.invoke(
    { messages: [new HumanMessage(run.task)] },
    { recursionLimit: run.maxSteps * 2 + 4, signal },
  );
  const trace = toTrace(final.messages);
  // Research is passed as plain notes: providers reject tool results whose tool calls were removed.
  const structured = run.chat.withStructuredOutput(run.schema, { name: 'final_answer' });
  const request = [
    system,
    new HumanMessage(
      `${run.task}\n\nResearch notes (tool calls and results):\n${JSON.stringify(trace.slice(1)).slice(0, MAX_NOTES_CHARS)}\n\nGive your final answer now, using only these facts.`,
    ),
  ];
  const answerWithCorrections = async (
    messages: readonly BaseMessage[],
    round: number,
    corrections: readonly TraceStep[],
  ): Promise<{ answer: z.infer<S>; corrections: readonly TraceStep[] }> => {
    const answer = (await structured.invoke([...messages], { signal })) as z.infer<S>;
    const problems = run.validate?.(answer) ?? [];
    if (problems.length === 0 || round >= (run.maxCorrections ?? 2)) return { answer, corrections };
    const feedback = `Your answer has these problems:\n- ${problems.join('\n- ')}\nCorrect them and give the complete answer again.`;
    return answerWithCorrections(
      [...messages, new AIMessage(JSON.stringify(answer)), new HumanMessage(feedback)],
      round + 1,
      [...corrections, { type: 'validation', content: feedback.slice(0, 1500) }],
    );
  };
  const { answer, corrections } = await answerWithCorrections(request, 0, []);
  return { answer, trace: [...trace, ...corrections] };
};
