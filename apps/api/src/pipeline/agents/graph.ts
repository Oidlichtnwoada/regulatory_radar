import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import type { z } from 'zod';

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
}

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
  const system = new SystemMessage(run.system);
  const aiTurns = (messages: readonly BaseMessage[]) =>
    messages.filter((m) => AIMessage.isInstance(m)).length;
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('agent', async (state) => ({ messages: [await bound.invoke([system, ...state.messages])] }))
    .addNode('tools', new ToolNode([...run.tools]))
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
    { recursionLimit: run.maxSteps * 2 + 4 },
  );
  const trace = toTrace(final.messages);
  // Research is passed as plain notes: providers reject tool results whose tool calls were removed.
  const structured = run.chat.withStructuredOutput(run.schema, { name: 'final_answer' });
  const request = [
    system,
    new HumanMessage(
      `${run.task}\n\nResearch notes (tool calls and results):\n${JSON.stringify(trace.slice(1))}\n\nGive your final answer now, using only these facts.`,
    ),
  ];
  const answerWithCorrections = async (
    messages: readonly BaseMessage[],
    round: number,
    corrections: readonly TraceStep[],
  ): Promise<{ answer: z.infer<S>; corrections: readonly TraceStep[] }> => {
    const answer = (await structured.invoke([...messages])) as z.infer<S>;
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
