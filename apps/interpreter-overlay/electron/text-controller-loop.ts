import {
  buildOverlayTextControllerLoopFunctionTools,
  type OverlayTextControllerLoopFunctionTool,
} from './text-controller-tool-catalog.js';
import {
  buildOverlayControllerTextPromptText,
  OVERLAY_CONTROLLER_HANDOFF_PREFIX,
} from './overlay-controller-prompt.js';
import { OverlayTargetWindowClosedError } from '../shared/tool-results.js';

/**
 * Typed fast controller loop: the realtime advanced-voice control loop, in
 * text, against an OpenAI-compatible chat.completions endpoint. The model
 * receives the same context packet and the same bridge tools as the
 * GPT-realtime voice bridge, makes tool calls, receives tool results
 * including the touched-window diff for reviewed batches, and iterates until
 * it answers in plain text.
 */

export const OVERLAY_TEXT_CONTROLLER_LOOP_MAX_LAPS = 6;
/**
 * Wall-clock budget for controller time only: model laps and loop overhead.
 * Time spent awaiting tool executors (reviewed batch approval/execution,
 * delegated hidden-agent runtime, attachment queries) is excluded, because
 * those waits are legitimate external work, not controller stalls.
 */
export const OVERLAY_TEXT_CONTROLLER_LOOP_MAX_WALL_MS = 60000;

const HANDOFF_PREFIX = OVERLAY_CONTROLLER_HANDOFF_PREFIX;

export interface OverlayTextControllerLoopToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type OverlayTextControllerLoopMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OverlayTextControllerLoopToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface OverlayTextControllerLoopAssistantTurn {
  text: string;
  toolCalls: Array<{ id: string; name: string; argumentsJson: string }>;
}

export type OverlayTextControllerLoopTransport = (request: {
  messages: OverlayTextControllerLoopMessage[];
  tools: OverlayTextControllerLoopFunctionTool[];
  signal: AbortSignal;
}) => Promise<OverlayTextControllerLoopAssistantTurn>;

export interface OverlayTextControllerLoopInput {
  contextPacketText: string;
  userText: string;
  transport: OverlayTextControllerLoopTransport;
  executeComputerBatch: (argumentsJson: string) => Promise<string>;
  executeCallHiddenAgent: (argumentsJson: string) => Promise<string>;
  executeQueryAttachments: (argumentsJson: string) => Promise<string>;
  executeReadAgentAssistantMessages: (argumentsJson: string) => Promise<string>;
  /**
   * Dead-target observation already delivered in the lap-1 user content: the
   * committed target window was gone at submit. The loop still runs; the
   * model receives the observation as data and decides the outcome. Its
   * plain-text answer ends the loop as done even with no executed work.
   */
  targetWindowClosedMessage?: string | null;
  maxLaps?: number;
  maxWallMs?: number;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export type OverlayTextControllerLoopResult =
  | {
      kind: 'done';
      summary: string;
      laps: number;
      executedBatchCount: number;
      delegatedToHiddenAgent: boolean;
      targetWindowClosedObserved: boolean;
    }
  | {
      kind: 'handoff';
      reason: string;
      conversationSummary: string;
      laps: number;
      executedBatchCount: number;
    };

export function buildOverlayTextControllerLoopSystemPrompt(): string {
  return buildOverlayControllerTextPromptText();
}

export function buildOverlayTextControllerLoopUserMessage(
  contextPacketText: string,
  userText: string,
  targetWindowClosedMessage?: string | null,
): string {
  return [
    contextPacketText.trim(),
    targetWindowClosedMessage
      ? `<target_window_closed>\n${targetWindowClosedMessage.trim()}\n</target_window_closed>`
      : '',
    `<user_request>\n${userText.trim()}\n</user_request>`,
  ].filter(Boolean).join('\n\n');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function countBatchActions(argumentsJson: string): number | null {
  try {
    const parsed = JSON.parse(argumentsJson) as { actions?: unknown };
    return Array.isArray(parsed.actions) ? parsed.actions.length : null;
  } catch {
    return null;
  }
}

function readBridgeOutput(output: string): { status: string | null; message: string | null } {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return {
      status: typeof parsed.status === 'string' ? parsed.status : null,
      message: typeof parsed.message === 'string' ? parsed.message : null,
    };
  } catch {
    return { status: null, message: null };
  }
}

function countMessageChars(messages: OverlayTextControllerLoopMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') {
      total += message.content.length;
    }
    if (message.role === 'assistant' && message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        total += toolCall.function.name.length + toolCall.function.arguments.length;
      }
    }
  }
  return total;
}

export function summarizeOverlayTextControllerLoopConversation(
  messages: OverlayTextControllerLoopMessage[],
): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = message.content?.trim();
      if (text) {
        lines.push(`fast-controller assistant: ${text.slice(0, 400)}`);
      }
      for (const toolCall of message.tool_calls ?? []) {
        lines.push(`fast-controller tool_call ${toolCall.function.name}: ${toolCall.function.arguments.slice(0, 400)}`);
      }
    } else if (message.role === 'tool') {
      lines.push(`fast-controller tool_result: ${message.content.slice(0, 400)}`);
    }
  }
  return lines.join('\n').slice(0, 6000);
}

export async function runOverlayTextControllerLoop(
  input: OverlayTextControllerLoopInput,
): Promise<OverlayTextControllerLoopResult> {
  const now = input.now ?? Date.now;
  const maxLaps = input.maxLaps ?? OVERLAY_TEXT_CONTROLLER_LOOP_MAX_LAPS;
  const maxWallMs = input.maxWallMs ?? OVERLAY_TEXT_CONTROLLER_LOOP_MAX_WALL_MS;
  const log = input.log ?? (() => {});
  const tools = buildOverlayTextControllerLoopFunctionTools();
  const startedAt = now();

  const messages: OverlayTextControllerLoopMessage[] = [
    { role: 'system', content: buildOverlayTextControllerLoopSystemPrompt() },
    {
      role: 'user',
      content: buildOverlayTextControllerLoopUserMessage(
        input.contextPacketText,
        input.userText,
        input.targetWindowClosedMessage ?? null,
      ),
    },
  ];

  let laps = 0;
  let executedBatchCount = 0;
  let delegatedToHiddenAgent = false;
  // The dead-target observation the model has received, either in the lap-1
  // user content (dead at submit) or as a target_window_closed tool result
  // (died mid-loop). Once set, the model owns the outcome.
  let targetWindowClosedMessage: string | null = input.targetWindowClosedMessage ?? null;
  let executorMs = 0;
  const runExecutor = async <T>(execute: () => Promise<T>): Promise<T> => {
    const executorStartedAt = now();
    try {
      return await execute();
    } finally {
      executorMs += now() - executorStartedAt;
    }
  };

  const handoff = (reason: string): OverlayTextControllerLoopResult => ({
    kind: 'handoff',
    reason,
    conversationSummary: summarizeOverlayTextControllerLoopConversation(messages),
    laps,
    executedBatchCount,
  });

  while (true) {
    if (laps >= maxLaps) {
      return handoff(`lap limit reached (${maxLaps} laps)`);
    }
    const elapsedMs = now() - startedAt - executorMs;
    if (elapsedMs >= maxWallMs) {
      return handoff(`wall-clock limit reached (${elapsedMs}ms controller time of ${maxWallMs}ms; ${executorMs}ms in tool executors)`);
    }

    laps += 1;
    log(`lap-${laps} request`, { promptChars: countMessageChars(messages) });

    let turn: OverlayTextControllerLoopAssistantTurn;
    try {
      turn = await input.transport({
        messages,
        tools,
        signal: AbortSignal.timeout(Math.max(1, maxWallMs - elapsedMs)),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      // Completion semantics, not a fallback: when at least one reviewed
      // batch already executed to completion (status 'completed' includes the
      // observed touched-window diff), a later-lap 400 tool_use_failed means
      // the model emitted a malformed follow-up tool call after the work
      // landed. Handing off would restage completed work; end as done and
      // log the rejected generation loudly instead.
      if (
        executedBatchCount > 0
        && message.includes('(400)')
        && message.includes('tool_use_failed')
      ) {
        log(`lap-${laps} transport 400 tool_use_failed after completed work; ending loop as done`, {
          executedBatchCount,
          error: message.slice(0, 1200),
        });
        return {
          kind: 'done',
          summary: `Completed ${executedBatchCount} reviewed batch${executedBatchCount === 1 ? '' : 'es'} on the selected target. A later malformed model tool call was rejected by the transport (400 tool_use_failed) and discarded.`,
          laps,
          executedBatchCount,
          delegatedToHiddenAgent,
          targetWindowClosedObserved: targetWindowClosedMessage !== null,
        };
      }
      return handoff(`transport failed on lap ${laps}: ${message}`);
    }

    messages.push({
      role: 'assistant',
      content: turn.text || null,
      ...(turn.toolCalls.length > 0
        ? {
            tool_calls: turn.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: 'function' as const,
              function: { name: toolCall.name, arguments: toolCall.argumentsJson },
            })),
          }
        : {}),
    });

    if (turn.toolCalls.length === 0) {
      const text = turn.text.trim();
      if (text.toUpperCase().startsWith(HANDOFF_PREFIX)) {
        return handoff(`model requested handoff: ${text.slice(HANDOFF_PREFIX.length).trim()}`);
      }
      if (executedBatchCount === 0 && !delegatedToHiddenAgent) {
        if (targetWindowClosedMessage === null) {
          return handoff(
            text
              ? `model finished without acting: ${text.slice(0, 400)}`
              : 'model returned an empty response with no tool calls',
          );
        }
        if (!text) {
          // The model received the dead-target observation and gave up
          // without any user-visible text: fail loudly with the dead target.
          throw new OverlayTargetWindowClosedError(targetWindowClosedMessage);
        }
        // The model received the dead-target observation and decided the
        // outcome in plain text: that text is the run's user-visible result.
      }
      return {
        kind: 'done',
        summary: text || `Completed ${executedBatchCount} reviewed batch${executedBatchCount === 1 ? '' : 'es'} on the selected target.`,
        laps,
        executedBatchCount,
        delegatedToHiddenAgent,
        targetWindowClosedObserved: targetWindowClosedMessage !== null,
      };
    }

    for (const toolCall of turn.toolCalls) {
      if (toolCall.name === 'computer_batch') {
        log(`lap-${laps} tool-call received`, {
          tool: toolCall.name,
          actionCount: countBatchActions(toolCall.argumentsJson),
        });
        let output: string;
        try {
          output = await runExecutor(() => input.executeComputerBatch(toolCall.argumentsJson));
        } catch (error) {
          if (executedBatchCount === 0 && !delegatedToHiddenAgent) {
            return handoff(`computer_batch execution failed before any reviewed work: ${getErrorMessage(error)}`);
          }
          throw error;
        }
        const { status, message } = readBridgeOutput(output);
        if (status === 'invalid_arguments') {
          return handoff(`computer_batch arguments were invalid and the repair model rejected them: ${output.slice(0, 400)}`);
        }
        if (status === 'completed') {
          executedBatchCount += 1;
        }
        if (status === 'target_window_closed') {
          // The committed target window is gone: the tool result carries the
          // observation instead of executing, and the model decides next.
          targetWindowClosedMessage = message ?? 'Target window closed: the committed target window is no longer on screen.';
        }
        log(`lap-${laps} executed`, { tool: toolCall.name, status });
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
        continue;
      }

      if (toolCall.name === 'call_hidden_agent') {
        log(`lap-${laps} tool-call received`, { tool: toolCall.name, actionCount: null });
        let output: string;
        try {
          output = await runExecutor(() => input.executeCallHiddenAgent(toolCall.argumentsJson));
        } catch (error) {
          if (executedBatchCount === 0 && !delegatedToHiddenAgent) {
            return handoff(`call_hidden_agent failed before any reviewed work: ${getErrorMessage(error)}`);
          }
          throw error;
        }
        const { status, message } = readBridgeOutput(output);
        if (status === 'target_window_closed') {
          // No dispatch happened: a delegated agent must not inherit a dead
          // target silently. The observation goes back to the model instead.
          targetWindowClosedMessage = message ?? 'Target window closed: the committed target window is no longer on screen.';
        } else {
          delegatedToHiddenAgent = true;
        }
        log(`lap-${laps} executed`, { tool: toolCall.name, status: status ?? 'completed' });
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
        continue;
      }

      if (toolCall.name === 'query_attachments' || toolCall.name === 'read_agent_assistant_messages') {
        log(`lap-${laps} tool-call received`, { tool: toolCall.name, actionCount: null });
        const execute = toolCall.name === 'query_attachments'
          ? input.executeQueryAttachments
          : input.executeReadAgentAssistantMessages;
        let output: string;
        try {
          output = await runExecutor(() => execute(toolCall.argumentsJson));
        } catch (error) {
          if (executedBatchCount === 0 && !delegatedToHiddenAgent) {
            return handoff(`${toolCall.name} failed before any reviewed work: ${getErrorMessage(error)}`);
          }
          throw error;
        }
        log(`lap-${laps} executed`, { tool: toolCall.name, status: 'completed' });
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
        continue;
      }

      return handoff(`model called unsupported tool "${toolCall.name}"`);
    }
  }
}
