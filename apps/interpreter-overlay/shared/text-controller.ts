import type {
  OverlayContextItem,
  OverlayRegionContextItem,
  OverlayUserAttachment,
} from './ipc.js';
import type { Bounds } from './types.js';
import { buildOverlayContextPacketText } from './context-packet.js';
import type { BrowserControlStatus } from '../../../shared/types/browserControl';

export type OverlayTextControllerInputMethod = 'text' | 'voice';

export interface BuildOverlayTextControllerRequestInput {
  text: string;
  serviceContextItems: OverlayContextItem[];
  submittedContextItems?: OverlayContextItem[];
  attachments?: OverlayUserAttachment[];
  workspacePath: string | null;
  targetWindowSessionKey: string | null;
  profileId: string;
  renderedProfileId: string | null;
  inputMethod: OverlayTextControllerInputMethod;
  managedContext?: OverlayTextControllerManagedContext | null;
  now?: number;
  managedContextMaxAgeMs?: number;
}

export interface OverlayWholeComputerWindowState {
  kind: 'interpreter-window' | 'agent-window';
  windowSessionKey: string | null;
  workspacePath: string | null;
  windowId?: number | null;
  agentId?: string | null;
  threadId?: string | null;
  activityLabel?: string | null;
  isRunning?: boolean | null;
  lastMessagePreview?: string | null;
}

export interface OverlayWholeComputerTargetState {
  label: string | null;
  targetKind: string;
  targetIdentityId: string;
  coordinateSpace: 'screen-dip';
  displayId: string | number | null;
  scaleFactor: number | null;
  bounds: Bounds;
  capturedAt: number;
  appName: string | null;
  appPid: number | null;
  appBundlePath: string | null;
  nativeWindowId: string | number | null;
}

export interface OverlayWholeComputerBrowserProfileState {
  browserProfileId: string;
  browserProfilePolicyId: string | null;
  browserName: string | null;
  browserChannel: string | null;
  profileName: string;
  profilePath: string | null;
  extensionStableKey: string | null;
  extensionInstallState: 'detected' | 'connected';
  activeSessionCount: number;
  windowCount: number;
  tabCount: number;
}

export interface OverlayWholeComputerBrowserTabState {
  tabRef: string;
  chromeTabId: number;
  browserWindowId: number;
  browserWindowFocused: boolean;
  browserWindowState: string;
  browserWindowType: string;
  browserProfileId: string;
  browserProfilePolicyId: string;
  browserProfileName: string | null;
  browserName: string | null;
  browserChannel: string | null;
  extensionStableKey: string | null;
  active: boolean;
  highlighted: boolean;
  pinned: boolean;
  title: string;
  url: string;
  origin: string | null;
  status: string;
  controlState: 'observable' | 'controllable';
  targetId: string | null;
}

export interface OverlayWholeComputerBrowserControlState {
  relayReachable: boolean;
  relayPhase: string;
  connectedBrowserCount: number;
  activeSessionCount: number;
  profiles: OverlayWholeComputerBrowserProfileState[];
  totalTabCount: number;
  returnedTabCount: number;
  truncatedTabCount: number;
  tabs: OverlayWholeComputerBrowserTabState[];
}

export interface OverlayWholeComputerState {
  workspacePath: string | null;
  targetWindowSessionKey: string | null;
  targetContextLabel: string | null;
  targetIdentityId: string | null;
  overlayTarget: OverlayWholeComputerTargetState | null;
  contextItemCount: number;
  referenceContextCount: number;
  windows: OverlayWholeComputerWindowState[];
  browserControl: OverlayWholeComputerBrowserControlState | null;
}

export interface OverlayTextControllerRequest {
  text: string;
  contextItems: OverlayContextItem[];
  targetContext: OverlayRegionContextItem | null;
  attachments: OverlayUserAttachment[];
  workspacePath: string | null;
  targetWindowSessionKey: string | null;
  profileId: string;
  inputMethod: OverlayTextControllerInputMethod;
  directCommand: OverlayTextControllerDirectCommand | null;
  targetScopeKey: string;
  managedContext: OverlayTextControllerManagedContext | null;
  hasUserInput: boolean;
}

export type OverlayTextControllerDirectCommand =
  | {
    kind: 'tool';
    serverId: 'builtin-cua-driver';
    toolName: 'list_windows';
    args: { pid?: number };
  }
  | {
    kind: 'tool';
    serverId: 'builtin-cua-driver';
    toolName: 'close_window';
    args: {
      app: string;
    };
  }
  | {
    kind: 'tool';
    serverId: 'builtin-cua-driver';
    toolName: 'focus_window';
    args: {
      target_identity: {
        kind: 'app-window';
        app: { pid: number };
        window: { native_window_id: number };
      };
    };
  }
  | {
    kind: 'tool';
    serverId: 'builtin-cua-driver';
    toolName: 'set_window_bounds';
    args: {
      target_identity: {
        kind: 'app-window';
        app: { pid: number };
        window: { native_window_id: number };
      };
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }
  | {
    kind: 'tool';
    serverId: 'builtin-selection';
    toolName: 'read_current_selection';
    args: {};
  }
  | {
    kind: 'tool';
    serverId: 'builtin-interpreter';
    toolName: 'interpreter_whole_computer_state_get';
    args: {};
  }
  | {
    kind: 'tool';
    serverId: 'builtin-agent-windows';
    toolName: 'list_agent_windows';
    args: {};
  }
  | {
    kind: 'tool';
    serverId: 'builtin-agent-windows';
    toolName: 'launch_agent_window';
    args: {
      initial_message: string;
      activate: true;
      completion_disposition: 'keep_open';
    };
  }
  | {
    kind: 'tool';
    serverId: 'builtin-agent-windows';
    toolName: 'reveal_agent_window' | 'stop_agent_window' | 'close_agent_window' | 'await_agent_window';
    args: {
      agent_id: string;
    };
  }
  | {
    kind: 'tool';
    serverId: 'builtin-agent-windows';
    toolName: 'send_agent_window_message';
    args: {
      agent_id: string;
      message: string;
    };
  }
  | {
    kind: 'tool';
    serverId: 'builtin-interpreter-overlay';
    toolName: 'call_hidden_agent';
    args: {
      message: string;
    };
  };

export interface OverlayTextControllerManagedTurn {
  at: number;
  userText: string;
  controllerDecision: 'direct_command' | 'fast_model_agent';
  directCommand: OverlayTextControllerDirectCommand | null;
  toolCalls: OverlayTextControllerManagedToolCall[];
  toolResultText: string | null;
  permissionResultText: string | null;
  agentLaunch: {
    agentId: string;
    target: 'overlay_target' | 'workspace';
    profileId: string;
    workspacePath: string | null;
    targetWindowSessionKey: string | null;
    allowedToolCount: number;
    initialElementCount: number | null;
  } | null;
}

export interface OverlayTextControllerManagedToolCall {
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  resultText: string | null;
  permissionResultText: string | null;
}

type OverlayAgentWindowByIdToolName =
  | 'reveal_agent_window'
  | 'stop_agent_window'
  | 'close_agent_window'
  | 'await_agent_window';

export interface OverlayTextControllerManagedContext {
  targetScopeKey: string;
  updatedAt: number;
  turns: OverlayTextControllerManagedTurn[];
}

export interface BuildOverlayTextControllerContextPromptOptions {
  availableToolsText?: string | null;
  wholeComputerState?: OverlayWholeComputerState | null;
  customInstructions?: string | null;
}

const DEFAULT_MANAGED_CONTEXT_MAX_AGE_MS = 3 * 60 * 1000;
const MAX_MANAGED_CONTEXT_TURNS = 6;
const MAX_MANAGED_CONTEXT_TEXT_LENGTH = 4000;

export function getTargetContextItem(contextItems: OverlayContextItem[]): OverlayRegionContextItem | null {
  return contextItems.find(
    (item): item is OverlayRegionContextItem => item.kind === 'region' && item.role === 'target',
  ) ?? null;
}

export function mergeOverlayContextItems(
  serviceItems: OverlayContextItem[],
  submittedItems: OverlayContextItem[] | undefined,
): OverlayContextItem[] {
  const merged = new Map<string, OverlayContextItem>();
  for (const item of submittedItems ?? []) {
    merged.set(item.id, item);
  }
  for (const item of serviceItems) {
    merged.set(item.id, item);
  }
  return [...merged.values()];
}

function parseInteger(value: string): number | null {
  if (!/^-?\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseNamedInteger(text: string, names: string[]): number | null {
  for (const name of names) {
    const match = new RegExp(`\\b${name}\\s*(?:=|:)?\\s*(-?\\d+)\\b`, 'i').exec(text);
    if (match?.[1]) {
      return parseInteger(match[1]);
    }
  }
  return null;
}

function matchWindowedAgentHandoff(text: string): string | null {
  const trimmed = text.trim();
  const patterns = [
    /^(?:handoff|hand\s+off)\s+to\s+(?:a\s+)?(?:visible|windowed)\s+agent\s*:\s*(.+)$/i,
    /^(?:launch|open|start)\s+(?:a\s+)?(?:visible|windowed)\s+agent\s*:\s*(.+)$/i,
    /^(?:launch|open|start)\s+(?:an?\s+)?agent\s+window\s*:\s*(.+)$/i,
    /^ask\s+(?:a\s+)?(?:visible|windowed)\s+agent\s+to\s+(.+)$/i,
    /^ask\s+(?:an?\s+)?agent\s+window\s+to\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    const task = match?.[1]?.trim();
    if (task) {
      return task;
    }
  }
  return null;
}

function matchHiddenAgentHandoff(text: string): string | null {
  const trimmed = text.trim();
  const patterns = [
    /^(?:call|ask|use)\s+(?:a\s+)?hidden\s+agent\s*:\s*(.+)$/i,
    /^(?:delegate|handoff|hand\s+off)\s+to\s+(?:a\s+)?hidden\s+agent\s*:\s*(.+)$/i,
    /^ask\s+(?:a\s+)?hidden\s+agent\s+to\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    const task = match?.[1]?.trim();
    if (task) {
      return task;
    }
  }
  return null;
}

function matchAgentWindowCommand(text: string): OverlayTextControllerDirectCommand | null {
  const trimmed = text.trim();
  if (
    /^(?:list|show|get)\s+(?:all\s+)?(?:visible\s+)?agent\s+windows\??$/i.test(trimmed)
    || /^what\s+agent\s+windows\s+are\s+open\??$/i.test(trimmed)
  ) {
    return {
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'list_agent_windows',
      args: {},
    };
  }

  const sendMatch = new RegExp(
    String.raw`^(?:send|message)\s+(?:visible\s+)?agent\s+window\s+(?:(?:agent|agent_id)\s*(?:=|:)\s*)?([A-Za-z0-9._:-]+)\s*:\s*(.+)$`,
    'i',
  ).exec(trimmed);
  const sendAgentId = sendMatch?.[1]?.trim();
  const sendMessage = sendMatch?.[2]?.trim();
  if (sendAgentId && sendMessage) {
    return {
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'send_agent_window_message',
      args: {
        agent_id: sendAgentId,
        message: sendMessage,
      },
    };
  }

  const agentIdPart = String.raw`(?:(?:agent|agent_id)\s*(?:=|:)\s*)?([A-Za-z0-9._:-]+)`;
  const patterns: Array<{
    toolName: OverlayAgentWindowByIdToolName;
    pattern: RegExp;
  }> = [
    {
      toolName: 'reveal_agent_window',
      pattern: new RegExp(String.raw`^(?:reveal|focus|show)\s+(?:visible\s+)?agent\s+window\s+${agentIdPart}$`, 'i'),
    },
    {
      toolName: 'stop_agent_window',
      pattern: new RegExp(String.raw`^(?:stop|cancel)\s+(?:visible\s+)?agent\s+window\s+${agentIdPart}$`, 'i'),
    },
    {
      toolName: 'close_agent_window',
      pattern: new RegExp(String.raw`^close\s+(?:visible\s+)?agent\s+window\s+${agentIdPart}$`, 'i'),
    },
    {
      toolName: 'await_agent_window',
      pattern: new RegExp(String.raw`^(?:await|wait\s+for)\s+(?:visible\s+)?agent\s+window\s+${agentIdPart}$`, 'i'),
    },
  ];

  for (const { toolName, pattern } of patterns) {
    const match = pattern.exec(trimmed);
    const agentId = match?.[1]?.trim();
    if (agentId) {
      return {
        kind: 'tool',
        serverId: 'builtin-agent-windows',
        toolName,
        args: { agent_id: agentId },
      };
    }
  }

  return null;
}

function matchCloseAppCommand(text: string): OverlayTextControllerDirectCommand | null {
  const match = /^(?:close|quit)\s+(?:the\s+)?(?:app\s+)?([a-z0-9][a-z0-9 ._-]{1,80})$/i.exec(text.trim());
  const app = match?.[1]?.trim().replace(/\s+/g, ' ');
  if (!app) {
    return null;
  }
  if (
    /^(?:app|window|tab|this|it|current|current app|selected app)$/i.test(app)
    || /^agent\s+window$/i.test(app)
  ) {
    return null;
  }
  return {
    kind: 'tool',
    serverId: 'builtin-cua-driver',
    toolName: 'close_window',
    args: {
      app,
    },
  };
}

export function matchOverlayTextControllerDirectCommand(text: string): OverlayTextControllerDirectCommand | null {
  const agentWindowCommand = matchAgentWindowCommand(text);
  if (agentWindowCommand) {
    return agentWindowCommand;
  }

  const hiddenAgentTask = matchHiddenAgentHandoff(text);
  if (hiddenAgentTask) {
    return {
      kind: 'tool',
      serverId: 'builtin-interpreter-overlay',
      toolName: 'call_hidden_agent',
      args: {
        message: hiddenAgentTask,
      },
    };
  }

  const handoffTask = matchWindowedAgentHandoff(text);
  if (handoffTask) {
    return {
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'launch_agent_window',
      args: {
        initial_message: handoffTask,
        activate: true,
        completion_disposition: 'keep_open',
      },
    };
  }

  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) {
    return null;
  }

  if (
    /^(?:read|show|get)\s+(?:the\s+)?(?:current\s+)?selection\??$/.test(normalized)
    || /^what(?:'s| is)\s+selected\??$/.test(normalized)
    || /^what\s+text\s+is\s+selected\??$/.test(normalized)
  ) {
    return {
      kind: 'tool',
      serverId: 'builtin-selection',
      toolName: 'read_current_selection',
      args: {},
    };
  }

  if (
    /^(?:read|show|get)\s+(?:the\s+)?(?:current\s+)?(?:whole\s+)?computer\s+state\??$/.test(normalized)
    || /^(?:read|show|get)\s+(?:the\s+)?interpreter\s+state\??$/.test(normalized)
    || /^what(?:'s| is)\s+(?:the\s+)?(?:whole\s+)?computer\s+state\??$/.test(normalized)
  ) {
    return {
      kind: 'tool',
      serverId: 'builtin-interpreter',
      toolName: 'interpreter_whole_computer_state_get',
      args: {},
    };
  }

  if (
    /^(list|show|get)\s+(all\s+)?windows$/.test(normalized)
    || /^what windows are open\??$/.test(normalized)
  ) {
    return {
      kind: 'tool',
      serverId: 'builtin-cua-driver',
      toolName: 'list_windows',
      args: {},
    };
  }

  const listWindowsForPid = /^(list|show|get)\s+windows\s+(?:for\s+)?pid\s*(?:=|:)?\s*(-?\d+)$/.exec(normalized);
  if (listWindowsForPid?.[2]) {
    const pid = parseInteger(listWindowsForPid[2]);
    if (pid !== null) {
      return {
        kind: 'tool',
        serverId: 'builtin-cua-driver',
        toolName: 'list_windows',
        args: { pid },
      };
    }
  }

  const closeAppCommand = matchCloseAppCommand(text);
  if (closeAppCommand) {
    return closeAppCommand;
  }

  if (/\b(focus|reveal|activate|show)\b/.test(normalized) && /\b(window)\b/.test(normalized)) {
    const pid = parseNamedInteger(normalized, ['pid']);
    const windowId = parseNamedInteger(normalized, ['window_id', 'window id', 'window']);
    if (pid !== null && windowId !== null) {
      return {
        kind: 'tool',
        serverId: 'builtin-cua-driver',
        toolName: 'focus_window',
        args: {
          target_identity: {
            kind: 'app-window',
            app: { pid },
            window: { native_window_id: windowId },
          },
        },
      };
    }
  }

  if (!/\b(move|resize|position|set)\b/.test(normalized) || !/\b(window)\b/.test(normalized)) {
    return null;
  }

  const pid = parseNamedInteger(normalized, ['pid']);
  const windowId = parseNamedInteger(normalized, ['window_id', 'window id', 'window']);
  const x = parseNamedInteger(normalized, ['x']);
  const y = parseNamedInteger(normalized, ['y']);
  const width = parseNamedInteger(normalized, ['width', 'w']);
  const height = parseNamedInteger(normalized, ['height', 'h']);

  if (
    pid === null
    || windowId === null
    || x === null
    || y === null
    || width === null
    || height === null
  ) {
    return null;
  }

  return {
    kind: 'tool',
    serverId: 'builtin-cua-driver',
    toolName: 'set_window_bounds',
    args: {
      target_identity: {
        kind: 'app-window',
        app: { pid },
        window: { native_window_id: windowId },
      },
      x,
      y,
      width,
      height,
    },
  };
}

export function isExecutableOverlayTextControllerDirectCommand(
  command: OverlayTextControllerDirectCommand | null,
): command is OverlayTextControllerDirectCommand {
  return command !== null;
}

function boundsScopePart(targetContext: OverlayRegionContextItem): string {
  const { x, y, width, height } = targetContext.bounds;
  return `${x},${y},${width},${height}`;
}

export function buildOverlayTextControllerTargetScopeKey(input: {
  workspacePath: string | null;
  targetWindowSessionKey: string | null;
  targetContext: OverlayRegionContextItem | null;
  contextItems?: OverlayContextItem[];
}): string {
  const workspace = input.workspacePath ?? 'no-workspace';
  const windowSession = input.targetWindowSessionKey ?? 'no-window';
  if (!input.targetContext) {
    return `${workspace}|${windowSession}|no-target`;
  }
  const contextItemIds = (input.contextItems ?? [])
    .map((item) => item.id)
    .sort()
    .join(',');
  const contextScope = contextItemIds || input.targetContext.snapshot.contextItemIds.join(',');
  return [
    workspace,
    windowSession,
    input.targetContext.id,
    input.targetContext.snapshot.id,
    contextScope || 'no-context-items',
    input.targetContext.targetIdentity.id,
    input.targetContext.targetIdentity.generation,
    input.targetContext.targetIdentity.window.nativeWindowId ?? 'no-native-window',
    input.targetContext.targetIdentity.window.sessionKey ?? 'no-target-window-session',
    input.targetContext.targetIdentity.displayId ?? 'no-display',
    boundsScopePart(input.targetContext),
  ].join('|');
}

export function reusableOverlayTextControllerManagedContext(input: {
  managedContext: OverlayTextControllerManagedContext | null | undefined;
  targetScopeKey: string;
  now: number;
  maxAgeMs?: number;
}): OverlayTextControllerManagedContext | null {
  const managedContext = input.managedContext ?? null;
  if (!managedContext) {
    return null;
  }
  if (managedContext.targetScopeKey !== input.targetScopeKey) {
    return null;
  }
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_MANAGED_CONTEXT_MAX_AGE_MS;
  if (input.now - managedContext.updatedAt > maxAgeMs) {
    return null;
  }
  return managedContext;
}

function appendOverlayTextControllerManagedTurn(input: {
  managedContext: OverlayTextControllerManagedContext | null | undefined;
  request: OverlayTextControllerRequest;
  turn: OverlayTextControllerManagedTurn;
}): OverlayTextControllerManagedContext {
  const priorTurns = input.managedContext?.targetScopeKey === input.request.targetScopeKey
    ? input.managedContext.turns
    : [];
  return {
    targetScopeKey: input.request.targetScopeKey,
    updatedAt: input.turn.at,
    turns: [
      ...priorTurns,
      input.turn,
    ].slice(-MAX_MANAGED_CONTEXT_TURNS),
  };
}

export function recordOverlayTextControllerDirectCommandResult(input: {
  managedContext: OverlayTextControllerManagedContext | null | undefined;
  request: OverlayTextControllerRequest;
  toolResultText: string;
  toolCalls?: OverlayTextControllerManagedToolCall[];
  permissionResultText?: string | null;
  now: number;
}): OverlayTextControllerManagedContext {
  const permissionResultText = input.permissionResultText ?? null;
  const turn: OverlayTextControllerManagedTurn = {
    at: input.now,
    userText: input.request.text,
    controllerDecision: 'direct_command',
    directCommand: input.request.directCommand,
    toolCalls: input.toolCalls
      ?? (input.request.directCommand
      ? [{
          serverId: input.request.directCommand.serverId,
          toolName: input.request.directCommand.toolName,
          args: input.request.directCommand.args,
          resultText: input.toolResultText,
          permissionResultText,
        }]
      : []),
    toolResultText: input.toolResultText,
    permissionResultText,
    agentLaunch: null,
  };
  return appendOverlayTextControllerManagedTurn({ ...input, turn });
}

export function recordOverlayTextControllerAgentLaunchResult(input: {
  managedContext: OverlayTextControllerManagedContext | null | undefined;
  request: OverlayTextControllerRequest;
  launch: NonNullable<OverlayTextControllerManagedTurn['agentLaunch']>;
  toolCalls?: OverlayTextControllerManagedToolCall[];
  now: number;
}): OverlayTextControllerManagedContext {
  const turn: OverlayTextControllerManagedTurn = {
    at: input.now,
    userText: input.request.text,
    controllerDecision: 'fast_model_agent',
    directCommand: null,
    toolCalls: input.toolCalls ?? [],
    toolResultText: 'Started visible Interpreter agent.',
    permissionResultText: null,
    agentLaunch: input.launch,
  };
  return appendOverlayTextControllerManagedTurn({ ...input, turn });
}

export function recordOverlayTextControllerAgentFailureResult(input: {
  managedContext: OverlayTextControllerManagedContext | null | undefined;
  request: OverlayTextControllerRequest;
  toolResultText: string;
  toolCalls?: OverlayTextControllerManagedToolCall[];
  permissionResultText?: string | null;
  now: number;
}): OverlayTextControllerManagedContext {
  const turn: OverlayTextControllerManagedTurn = {
    at: input.now,
    userText: input.request.text,
    controllerDecision: 'fast_model_agent',
    directCommand: null,
    toolCalls: input.toolCalls ?? [],
    toolResultText: input.toolResultText,
    permissionResultText: input.permissionResultText ?? null,
    agentLaunch: null,
  };
  return appendOverlayTextControllerManagedTurn({ ...input, turn });
}

function compactControllerText(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= MAX_MANAGED_CONTEXT_TEXT_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_MANAGED_CONTEXT_TEXT_LENGTH)}...`;
}

function describeDirectCommand(command: OverlayTextControllerDirectCommand | null): string {
  if (!command) {
    return 'none';
  }
  return `${command.serverId}/${command.toolName} ${JSON.stringify(command.args)}`;
}

function describeManagedToolCall(call: OverlayTextControllerManagedToolCall): string {
  return JSON.stringify({
    server_id: call.serverId,
    tool_name: call.toolName,
    args: call.args,
    permission_result: call.permissionResultText,
    result: call.resultText,
  });
}

function describeAgentLaunch(launch: OverlayTextControllerManagedTurn['agentLaunch']): string {
  if (!launch) {
    return 'none';
  }
  return JSON.stringify({
    agent_id: launch.agentId,
    target: launch.target,
    profile_id: launch.profileId,
    workspace_path: launch.workspacePath,
    target_window_session_key: launch.targetWindowSessionKey,
    allowed_tool_count: launch.allowedToolCount,
    initial_element_count: launch.initialElementCount,
  });
}

function buildManagedContextText(managedContext: OverlayTextControllerManagedContext | null): string {
  if (!managedContext || managedContext.turns.length === 0) {
    return '';
  }

  return [
    `<overlay_recent_turns target_scope_key=${JSON.stringify(managedContext.targetScopeKey)}>`,
    ...managedContext.turns.map((turn, index) => [
      `<turn index="${index + 1}" at="${turn.at}">`,
      `user: ${compactControllerText(turn.userText)}`,
      `controller_decision: ${turn.controllerDecision}`,
      `direct_tool: ${describeDirectCommand(turn.directCommand)}`,
      turn.toolCalls.length === 0
        ? 'tool_calls: none'
        : `tool_calls: ${turn.toolCalls.map(describeManagedToolCall).join(' ')}`,
      `agent_launch: ${describeAgentLaunch(turn.agentLaunch)}`,
      turn.permissionResultText === null
        ? 'permission_result: none'
        : `permission_result: ${compactControllerText(turn.permissionResultText)}`,
      turn.toolResultText === null
        ? 'tool_result: none'
        : `tool_result: ${compactControllerText(turn.toolResultText)}`,
      '</turn>',
    ].join('\n')),
    '</overlay_recent_turns>',
  ].join('\n');
}

function compactWholeComputerValue(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? JSON.stringify(normalized.slice(0, MAX_MANAGED_CONTEXT_TEXT_LENGTH)) : 'null';
}

function compactWholeComputerScalar(value: string | number | null | undefined): string {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  return compactWholeComputerValue(value);
}

function compactWholeComputerBounds(bounds: Bounds): string {
  return `x=${bounds.x} y=${bounds.y} width=${bounds.width} height=${bounds.height}`;
}

function wholeComputerOriginFromUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function buildOverlayBrowserControlStateFromStatus(
  status: BrowserControlStatus,
  maxTabs = 30,
): OverlayWholeComputerBrowserControlState {
  const boundedMaxTabs = Math.max(0, Math.min(Math.trunc(maxTabs), 100));
  const profilesByPolicyId = new Map(
    status.profiles
      .filter((profile) => profile.policyProfileId)
      .map((profile) => [profile.policyProfileId!, profile]),
  );
  const tabs = status.connections.flatMap((connection) => {
    const profile = profilesByPolicyId.get(connection.profileId)
      ?? status.profiles.find((candidate) => candidate.profileId === connection.profileId)
      ?? null;
    const browserProfilePolicyId = profile?.policyProfileId ?? connection.profileId;
    return connection.browserWindows.flatMap((browserWindow) => browserWindow.tabs.map((tab) => ({
      tabRef: tab.tabRef,
      chromeTabId: tab.chromeTabId,
      browserWindowId: browserWindow.windowId,
      browserWindowFocused: browserWindow.focused,
      browserWindowState: browserWindow.state,
      browserWindowType: browserWindow.type,
      browserProfileId: profile?.profileId ?? connection.profileId,
      browserProfilePolicyId,
      browserProfileName: profile?.profileName ?? null,
      browserName: profile?.browserName ?? connection.browserName,
      browserChannel: profile?.browserChannel ?? null,
      extensionStableKey: connection.stableKey,
      active: tab.active,
      highlighted: tab.highlighted,
      pinned: tab.pinned,
      title: tab.title,
      url: tab.url,
      origin: wholeComputerOriginFromUrl(tab.url),
      status: tab.status,
      controlState: tab.controlState,
      targetId: tab.targetId ?? null,
    })));
  });

  return {
    relayReachable: status.relay.reachable,
    relayPhase: status.relay.phase,
    connectedBrowserCount: status.connectedBrowsers,
    activeSessionCount: status.activeSessions,
    profiles: status.profiles.map((profile) => ({
      browserProfileId: profile.profileId,
      browserProfilePolicyId: profile.policyProfileId,
      browserName: profile.browserName,
      browserChannel: profile.browserChannel,
      profileName: profile.profileName,
      profilePath: profile.profilePath || null,
      extensionStableKey: profile.stableKey,
      extensionInstallState: profile.connectionState,
      activeSessionCount: profile.activeSessions,
      windowCount: profile.windowCount,
      tabCount: profile.tabCount,
    })),
    totalTabCount: tabs.length,
    returnedTabCount: Math.min(tabs.length, boundedMaxTabs),
    truncatedTabCount: Math.max(0, tabs.length - boundedMaxTabs),
    tabs: tabs.slice(0, boundedMaxTabs),
  };
}

export function buildOverlayWholeComputerStateText(state: OverlayWholeComputerState | null | undefined): string {
  if (!state) {
    return '';
  }
  const lines = [
    '<overlay_whole_computer_state>',
    `workspace_path: ${compactWholeComputerValue(state.workspacePath)}`,
    `target_window_session_key: ${compactWholeComputerValue(state.targetWindowSessionKey)}`,
    `target_context_label: ${compactWholeComputerValue(state.targetContextLabel)}`,
    `target_identity_id: ${compactWholeComputerValue(state.targetIdentityId)}`,
    `context_item_count: ${state.contextItemCount}`,
    `reference_context_count: ${state.referenceContextCount}`,
  ];
  if (state.overlayTarget) {
    const target = state.overlayTarget;
    lines.push(
      '<overlay_target_state>',
      `label: ${compactWholeComputerValue(target.label)}`,
      `target_kind: ${compactWholeComputerValue(target.targetKind)}`,
      `target_identity_id: ${compactWholeComputerValue(target.targetIdentityId)}`,
      `app_name: ${compactWholeComputerValue(target.appName)}`,
      `app_pid: ${compactWholeComputerScalar(target.appPid)}`,
      `app_bundle_path: ${compactWholeComputerValue(target.appBundlePath)}`,
      `native_window_id: ${compactWholeComputerScalar(target.nativeWindowId)}`,
      `coordinate_space: ${compactWholeComputerValue(target.coordinateSpace)}`,
      `display_id: ${compactWholeComputerScalar(target.displayId)}`,
      `scale_factor: ${compactWholeComputerScalar(target.scaleFactor)}`,
      `bounds: ${compactWholeComputerBounds(target.bounds)}`,
      `captured_at: ${target.capturedAt}`,
      '</overlay_target_state>',
    );
  } else {
    lines.push('overlay_target_state: none');
  }
  lines.push(`<windows count="${state.windows.length}">`);
  for (const windowState of state.windows.slice(0, 40)) {
    const fields = [
      `kind=${JSON.stringify(windowState.kind)}`,
      `window_session_key=${compactWholeComputerValue(windowState.windowSessionKey)}`,
      `workspace_path=${compactWholeComputerValue(windowState.workspacePath)}`,
      windowState.windowId === undefined ? null : `window_id=${windowState.windowId ?? 'null'}`,
      windowState.agentId === undefined ? null : `agent_id=${compactWholeComputerValue(windowState.agentId)}`,
      windowState.threadId === undefined ? null : `thread_id=${compactWholeComputerValue(windowState.threadId)}`,
      windowState.activityLabel === undefined ? null : `activity_label=${compactWholeComputerValue(windowState.activityLabel)}`,
      windowState.isRunning === undefined ? null : `is_running=${windowState.isRunning === null ? 'null' : String(windowState.isRunning)}`,
      windowState.lastMessagePreview === undefined ? null : `last_message_preview=${compactWholeComputerValue(windowState.lastMessagePreview)}`,
    ].filter(Boolean);
    lines.push(`window ${fields.join(' ')}`);
  }
  if (state.windows.length > 40) {
    lines.push(`truncated_window_count: ${state.windows.length - 40}`);
  }
  lines.push('</windows>');
  if (state.browserControl) {
    const browserControl = state.browserControl;
    lines.push(
      `<browser_control relay_reachable="${browserControl.relayReachable}" relay_phase=${JSON.stringify(browserControl.relayPhase)} connected_browser_count="${browserControl.connectedBrowserCount}" active_session_count="${browserControl.activeSessionCount}" total_tab_count="${browserControl.totalTabCount}" returned_tab_count="${browserControl.returnedTabCount}" truncated_tab_count="${browserControl.truncatedTabCount}">`,
      `<browser_profiles count="${browserControl.profiles.length}">`,
    );
    for (const profile of browserControl.profiles.slice(0, 20)) {
      const fields = [
        `browser_profile_id=${compactWholeComputerValue(profile.browserProfileId)}`,
        `browser_profile_policy_id=${compactWholeComputerValue(profile.browserProfilePolicyId)}`,
        `browser_name=${compactWholeComputerValue(profile.browserName)}`,
        `browser_channel=${compactWholeComputerValue(profile.browserChannel)}`,
        `profile_name=${compactWholeComputerValue(profile.profileName)}`,
        `profile_path=${compactWholeComputerValue(profile.profilePath)}`,
        `extension_stable_key=${compactWholeComputerValue(profile.extensionStableKey)}`,
        `extension_install_state=${JSON.stringify(profile.extensionInstallState)}`,
        `active_session_count=${profile.activeSessionCount}`,
        `window_count=${profile.windowCount}`,
        `tab_count=${profile.tabCount}`,
      ];
      lines.push(`browser_profile ${fields.join(' ')}`);
    }
    if (browserControl.profiles.length > 20) {
      lines.push(`truncated_browser_profile_count: ${browserControl.profiles.length - 20}`);
    }
    lines.push('</browser_profiles>', `<browser_tabs count="${browserControl.returnedTabCount}">`);
    for (const tab of browserControl.tabs) {
      const fields = [
        `tab_ref=${compactWholeComputerValue(tab.tabRef)}`,
        `chrome_tab_id=${tab.chromeTabId}`,
        `browser_window_id=${tab.browserWindowId}`,
        `browser_window_focused=${String(tab.browserWindowFocused)}`,
        `browser_window_state=${compactWholeComputerValue(tab.browserWindowState)}`,
        `browser_window_type=${compactWholeComputerValue(tab.browserWindowType)}`,
        `browser_profile_id=${compactWholeComputerValue(tab.browserProfileId)}`,
        `browser_profile_policy_id=${compactWholeComputerValue(tab.browserProfilePolicyId)}`,
        `browser_profile_name=${compactWholeComputerValue(tab.browserProfileName)}`,
        `browser_name=${compactWholeComputerValue(tab.browserName)}`,
        `browser_channel=${compactWholeComputerValue(tab.browserChannel)}`,
        `extension_stable_key=${compactWholeComputerValue(tab.extensionStableKey)}`,
        `active=${String(tab.active)}`,
        `highlighted=${String(tab.highlighted)}`,
        `pinned=${String(tab.pinned)}`,
        `control_state=${JSON.stringify(tab.controlState)}`,
        `target_id=${compactWholeComputerValue(tab.targetId)}`,
        `origin=${compactWholeComputerValue(tab.origin)}`,
        `status=${compactWholeComputerValue(tab.status)}`,
        `title=${compactWholeComputerValue(tab.title)}`,
        `url=${compactWholeComputerValue(tab.url)}`,
      ];
      lines.push(`browser_tab ${fields.join(' ')}`);
    }
    lines.push('</browser_tabs>', '</browser_control>');
  } else {
    lines.push('browser_control: none');
  }
  lines.push('</overlay_whole_computer_state>');
  return lines.join('\n');
}

export function buildOverlayWorkingPreferencesText(customInstructions: string | null | undefined): string {
  const trimmed = typeof customInstructions === 'string' ? customInstructions.trim() : '';
  if (!trimmed) {
    return '';
  }
  return [
    '<overlay_working_preferences source="saved_custom_instructions">',
    'These are the saved Interpreter working preferences for how the user likes work handled. Follow them unless the current user message overrides them.',
    trimmed.slice(0, 12_000),
    '</overlay_working_preferences>',
  ].join('\n');
}

export function buildOverlayTextControllerContextPrompt(
  request: OverlayTextControllerRequest,
  options: BuildOverlayTextControllerContextPromptOptions = {},
): string {
  const contextPacket = buildOverlayContextPacketText(request.contextItems).trim();
  const wholeComputerStateText = buildOverlayWholeComputerStateText(options.wholeComputerState).trim();
  const workingPreferencesText = buildOverlayWorkingPreferencesText(options.customInstructions).trim();
  const managedContextText = buildManagedContextText(request.managedContext).trim();
  const availableToolsText = options.availableToolsText?.trim() ?? '';
  const userText = request.text.trim();
  return [contextPacket, wholeComputerStateText, workingPreferencesText, managedContextText, availableToolsText, userText]
    .filter(Boolean)
    .join('\n\n');
}

export function buildOverlayTextControllerRequest(
  input: BuildOverlayTextControllerRequestInput,
): OverlayTextControllerRequest {
  const text = input.text.trim();
  const contextItems = mergeOverlayContextItems(
    input.serviceContextItems,
    input.submittedContextItems,
  );
  const attachments = input.attachments ?? [];
  const targetContext = getTargetContextItem(contextItems);
  const targetScopeKey = buildOverlayTextControllerTargetScopeKey({
    workspacePath: input.workspacePath,
    targetWindowSessionKey: input.targetWindowSessionKey,
    targetContext,
    contextItems,
  });
  const now = input.now ?? Date.now();

  return {
    text,
    contextItems,
    targetContext,
    attachments,
    workspacePath: input.workspacePath,
    targetWindowSessionKey: input.targetWindowSessionKey,
    profileId: input.renderedProfileId ?? input.profileId,
    inputMethod: input.inputMethod,
    directCommand: matchOverlayTextControllerDirectCommand(text),
    targetScopeKey,
    managedContext: reusableOverlayTextControllerManagedContext({
      managedContext: input.managedContext,
      targetScopeKey,
      now,
      maxAgeMs: input.managedContextMaxAgeMs,
    }),
    hasUserInput: text.length > 0 || attachments.length > 0 || contextItems.length > 0,
  };
}
