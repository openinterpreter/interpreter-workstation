import { callTool as callInterpreterTool } from '../../../server/handlers/toolServers';
import type { AgentModelConfig } from '../../../shared/types/model';
import type { OverlayContextItem, OverlayRegionContextItem } from '../shared/ipc.js';
import type {
  OverlayTextControllerDirectCommand,
  OverlayTextControllerManagedToolCall,
} from '../shared/text-controller.js';
import { buildOverlaySelectedContextToolArgs } from './overlay-selected-context-tool-args.js';
import { buildOverlayToolManagerIdentity } from './overlay-tool-identity.js';

export interface OverlayTextDirectCommandExecutionContext {
  agentId: string;
  workspacePath: string | null;
  profileId: string | null;
  modelConfig?: AgentModelConfig;
  targetWindowSessionKey?: string | null;
  targetContext?: OverlayRegionContextItem | null;
  contextItems?: OverlayContextItem[];
  conversationContext?: string | null;
}

export type OverlayTextDirectCommandCallTool = (
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  saveToDisk: boolean | undefined,
  toolContext: {
    callerTabId: string;
    workspace?: string;
    profileId?: string;
  },
  options?: {
    includeHiddenBuiltins?: boolean;
  },
) => Promise<unknown>;

export interface OverlayTextDirectCommandExecutionResult {
  text: string;
  toolCall: OverlayTextControllerManagedToolCall;
}

export class OverlayTextDirectCommandExecutionError extends Error {
  readonly toolCall: OverlayTextControllerManagedToolCall;

  constructor(message: string, toolCall: OverlayTextControllerManagedToolCall) {
    super(message);
    this.name = 'OverlayTextDirectCommandExecutionError';
    this.toolCall = toolCall;
  }
}

function toolResultText(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return String(result ?? '');
  }

  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
          return (item as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) {
      return text;
    }
  }

  return JSON.stringify(result);
}

function permissionResultTextFromToolError(text: string): string | null {
  return /\b(?:permission|denied|approval)\b/i.test(text) ? text : null;
}

function parseJsonToolText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function listWindowsFromToolText(text: string): Array<Record<string, unknown>> {
  const parsed = parseJsonToolText(text);
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  }
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.windows)) {
      return record.windows.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
    }
  }
  return [];
}

function normalizeAppName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function windowTargetIdentity(window: Record<string, unknown>): Record<string, unknown> | null {
  const targetIdentity = window.target_identity;
  if (
    targetIdentity
    && typeof targetIdentity === 'object'
    && (targetIdentity as Record<string, unknown>).kind === 'app-window'
  ) {
    return targetIdentity as Record<string, unknown>;
  }
  return null;
}

function windowAppName(window: Record<string, unknown>): string {
  const targetIdentity = windowTargetIdentity(window);
  const targetApp = targetIdentity?.app;
  const targetAppName = targetApp && typeof targetApp === 'object'
    ? (targetApp as Record<string, unknown>).name
    : null;
  for (const value of [targetAppName, window.app_name, window.owner, window.name]) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
}

function windowScoreForClose(window: Record<string, unknown>, requestedApp: string): number {
  if (window.is_on_screen !== true && window.isOnScreen !== true) return -1;
  const appName = normalizeAppName(windowAppName(window));
  const requested = normalizeAppName(requestedApp);
  if (!appName || !requested) return -1;
  const matches = appName === requested || appName.includes(requested) || requested.includes(appName);
  if (!matches) return -1;
  let score = appName === requested ? 100 : 50;
  if (window.on_current_space === true || window.onCurrentSpace === true) score += 20;
  if (window.is_on_screen === true || window.isOnScreen === true) score += 10;
  if (typeof window.z_index === 'number') score += Math.min(Math.max(window.z_index, 0), 1000) / 1000;
  return score;
}

function chooseCloseWindowTarget(windows: Array<Record<string, unknown>>, requestedApp: string): Record<string, unknown> | null {
  return windows
    .map((window) => ({
      window,
      targetIdentity: windowTargetIdentity(window),
      score: windowScoreForClose(window, requestedApp),
    }))
    .filter((candidate): candidate is { window: Record<string, unknown>; targetIdentity: Record<string, unknown>; score: number } => (
      !!candidate.targetIdentity && candidate.score >= 0
    ))
    .sort((left, right) => right.score - left.score)[0]?.targetIdentity ?? null;
}

function buildDirectCommandArgs(
  command: OverlayTextControllerDirectCommand,
  context: OverlayTextDirectCommandExecutionContext,
): Record<string, unknown> {
  if (command.toolName === 'call_hidden_agent') {
    return {
      ...command.args,
      ...(context.conversationContext?.trim() ? { conversation_context: context.conversationContext.trim() } : {}),
      ...buildOverlaySelectedContextToolArgs(context.targetContext, context.contextItems),
    };
  }

  if (command.toolName === 'send_agent_window_message') {
    return {
      ...command.args,
      workspace_path: context.workspacePath,
    };
  }

  if (command.toolName !== 'launch_agent_window') {
    return command.args;
  }

  return {
    ...command.args,
    workspace_path: context.workspacePath,
    target_window_session_key: context.targetWindowSessionKey ?? null,
    ...(context.conversationContext?.trim() ? { conversation_context: context.conversationContext.trim() } : {}),
    ...buildOverlaySelectedContextToolArgs(context.targetContext, context.contextItems),
  };
}

async function executeCloseWindowDirectCommand(
  command: Extract<OverlayTextControllerDirectCommand, { serverId: 'builtin-cua-driver'; toolName: 'close_window' }>,
  context: OverlayTextDirectCommandExecutionContext,
  callTool: OverlayTextDirectCommandCallTool,
): Promise<OverlayTextDirectCommandExecutionResult> {
  const toolContext = buildOverlayToolManagerIdentity({
    agentId: context.agentId,
    workspacePath: context.workspacePath,
    profileId: context.profileId,
    modelConfig: context.modelConfig,
  });
  const listResult = await callTool(
    'builtin-cua-driver',
    'list_windows',
    {},
    undefined,
    toolContext,
    undefined,
  );
  const listText = toolResultText(listResult);
  const listCall: OverlayTextControllerManagedToolCall = {
    serverId: 'builtin-cua-driver',
    toolName: 'list_windows',
    args: {},
    resultText: listText,
    permissionResultText: listResult && typeof listResult === 'object' && (listResult as { isError?: unknown }).isError === true
      ? permissionResultTextFromToolError(listText)
      : null,
  };
  if (listResult && typeof listResult === 'object' && (listResult as { isError?: unknown }).isError === true) {
    throw new OverlayTextDirectCommandExecutionError(listText, listCall);
  }

  const targetIdentity = chooseCloseWindowTarget(listWindowsFromToolText(listText), command.args.app);
  if (!targetIdentity) {
    throw new OverlayTextDirectCommandExecutionError(
      `No visible app window matched "${command.args.app}".`,
      {
        serverId: 'builtin-cua-driver',
        toolName: 'close_window',
        args: { app: command.args.app },
        resultText: `No visible app window matched "${command.args.app}".`,
        permissionResultText: null,
      },
    );
  }

  const closeArgs = { target_identity: targetIdentity };
  const closeResult = await callTool(
    'builtin-cua-driver',
    'close_window',
    closeArgs,
    undefined,
    toolContext,
    undefined,
  );
  const closeText = toolResultText(closeResult);
  const closeCall: OverlayTextControllerManagedToolCall = {
    serverId: 'builtin-cua-driver',
    toolName: 'close_window',
    args: closeArgs,
    resultText: closeText,
    permissionResultText: closeResult && typeof closeResult === 'object' && (closeResult as { isError?: unknown }).isError === true
      ? permissionResultTextFromToolError(closeText)
      : null,
  };
  if (closeResult && typeof closeResult === 'object' && (closeResult as { isError?: unknown }).isError === true) {
    throw new OverlayTextDirectCommandExecutionError(closeText, closeCall);
  }
  return { text: closeText, toolCall: closeCall };
}

export async function executeOverlayTextControllerDirectCommand(
  command: OverlayTextControllerDirectCommand,
  context: OverlayTextDirectCommandExecutionContext,
  callTool: OverlayTextDirectCommandCallTool = callInterpreterTool,
): Promise<OverlayTextDirectCommandExecutionResult> {
  if (command.serverId === 'builtin-cua-driver' && command.toolName === 'close_window') {
    return executeCloseWindowDirectCommand(command, context, callTool);
  }

  const includeHiddenBuiltins = (
    command.serverId === 'builtin-agent-windows'
    || command.serverId === 'builtin-interpreter-overlay'
  );
  const args = buildDirectCommandArgs(command, context);
  const result = await callTool(
    command.serverId,
    command.toolName,
    args,
    undefined,
    buildOverlayToolManagerIdentity({
      agentId: context.agentId,
      workspacePath: context.workspacePath,
      profileId: context.profileId,
      modelConfig: context.modelConfig,
    }),
    includeHiddenBuiltins ? { includeHiddenBuiltins: true } : undefined,
  );

  const text = toolResultText(result);
  const isError = result && typeof result === 'object' && (result as { isError?: unknown }).isError === true;
  const toolCall: OverlayTextControllerManagedToolCall = {
    serverId: command.serverId,
    toolName: command.toolName,
    args,
    resultText: text,
    permissionResultText: isError ? permissionResultTextFromToolError(text) : null,
  };
  if (isError) {
    throw new OverlayTextDirectCommandExecutionError(text, toolCall);
  }

  return { text, toolCall };
}
