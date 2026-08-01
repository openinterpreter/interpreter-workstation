import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import type { AgentPermissionOwnerReference } from '../../../../shared/types/approval';
import type { AgentModelConfig } from '../../../../shared/types/model';
import { overlaySessionManager } from '../../../overlaySessionManager';
import type { OverlaySessionDebugSnapshot } from '../../../overlaySessionManager';
import { prefixToolName } from '../../../../shared/utils/mcpToolName';
import {
  AGENT_WINDOW_TOOL_NAMES,
  AGENT_WINDOW_TOOL_SERVER_ID,
  CUA_DRIVER_TOOL_SERVER_ID,
  HIDDEN_AGENT_OVERLAY_TOOL_NAMES,
  INTERPRETER_TOOL_SERVER_ID,
  INTERPRETER_OVERLAY_TOOL_SERVER_ID,
  OVERLAY_CUA_TOOL_NAMES,
  OVERLAY_INTERPRETER_TOOL_NAMES,
  OVERLAY_SELECTION_TOOL_NAMES,
  SELECTION_TOOL_SERVER_ID,
} from '../../../../shared/types/overlayToolCatalog';

const OVERLAY_HIDDEN_AGENT_ALLOWED_TOOL_NAMES = [
  ...HIDDEN_AGENT_OVERLAY_TOOL_NAMES.map((toolName) =>
    prefixToolName(INTERPRETER_OVERLAY_TOOL_SERVER_ID, toolName),
  ),
  ...OVERLAY_CUA_TOOL_NAMES.map((toolName) =>
    prefixToolName(CUA_DRIVER_TOOL_SERVER_ID, toolName),
  ),
  ...OVERLAY_SELECTION_TOOL_NAMES.map((toolName) =>
    prefixToolName(SELECTION_TOOL_SERVER_ID, toolName),
  ),
  ...OVERLAY_INTERPRETER_TOOL_NAMES.map((toolName) =>
    prefixToolName(INTERPRETER_TOOL_SERVER_ID, toolName),
  ),
  ...AGENT_WINDOW_TOOL_NAMES.map((toolName) =>
    prefixToolName(AGENT_WINDOW_TOOL_SERVER_ID, toolName),
  ),
];

export function overlayHiddenAgentAllowedToolNamesForTest(): string[] {
  return [...OVERLAY_HIDDEN_AGENT_ALLOWED_TOOL_NAMES];
}

type ParentOwnerBindingSource = {
  agentId: string;
  threadId?: string;
  windowSessionKey?: string | null;
  workspacePath?: string;
  toolProfileId?: string;
};

type HiddenAgentSession = {
  service: any;
  profile: any;
  agentId: string;
  callerToken: string;
  allowedToolNames?: string[];
  modelConfig: AgentModelConfig;
  parentOwner?: AgentPermissionOwnerReference;
  dispose: () => void;
};

type CreateHiddenAgentSession = (options: {
  modelConfig: AgentModelConfig;
  allowedToolNames?: string[];
  parentOwner?: AgentPermissionOwnerReference;
}) => Promise<HiddenAgentSession>;

type RunHiddenAgent = (options: {
  message: string;
  system?: string;
  modelConfig: AgentModelConfig;
  timeoutMs: number;
  workspace?: string;
  allowedToolNames?: string[];
  parentOwner?: AgentPermissionOwnerReference;
  session: HiddenAgentSession;
  abortSignal?: AbortSignal;
}) => Promise<any>;

type CloseHiddenAgentSession = (session: HiddenAgentSession | null | undefined) => void;

function requiredStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string.`);
  }
  return value;
}

function optionalPositiveIntegerArg(args: Record<string, unknown>, key: string, defaultValue: number): number {
  const value = args[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return value;
}

function optionalStringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value;
}

function optionalRecordArg(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function buildHiddenAgentMessage(input: {
  message: string;
  conversationContext?: string;
  selectedContext?: Record<string, unknown>;
  targetRefs?: string[];
}): string {
  const handoff: Record<string, unknown> = {};
  if (input.conversationContext?.trim()) {
    handoff.conversation_context = input.conversationContext.trim();
  }
  if (input.selectedContext) {
    handoff.selected_context = input.selectedContext;
  }
  if (input.targetRefs && input.targetRefs.length > 0) {
    handoff.target_refs = input.targetRefs;
  }
  if (Object.keys(handoff).length === 0) {
    return input.message;
  }
  return [
    'Hidden agent handoff context:',
    JSON.stringify(handoff, null, 2),
    '',
    'Task:',
    input.message,
  ].join('\n');
}

function latestAssistantText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    const text = parts
      .map((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) {
          return '';
        }
        const record = part as Record<string, unknown>;
        return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
      })
      .join('')
      .trim();
    if (text) {
      return text;
    }
  }
  return null;
}

function buildHiddenAgentSystem(system: string | undefined, hasOverlaySession: boolean): string {
  const lines = [
    'You are a hidden Interpreter delegate called by the overlay controller.',
    'Use only the allowed Interpreter tools for this task. They are Interpreter CLI tools, not native function tools: run each one with `interpreter-app tools <server_id> <tool_name> --json \'<arguments>\'` directly in the command tool. Do NOT wrap them in `/bin/zsh -lc`, `bash -lc`, or another nested shell, and do NOT call them as functions.',
    `Allowed tools (listed as <server_id>__<tool_name>): ${OVERLAY_HIDDEN_AGENT_ALLOWED_TOOL_NAMES.join(', ')}`,
    hasOverlaySession
      ? [
          'The same live overlay session is attached to you. Read the current selected-screen context first with `interpreter-app tools builtin-interpreter-overlay overlay_read_context --json \'{}\'` before acting on UI refs.',
          'For actions inside the selected screen target, use `interpreter-app tools builtin-interpreter-overlay computer_batch` with actions shaped as { seq, tool: { name: "click"|"type"|"hotkey"|"scroll", params } }. The batch shows the Interpreter review UI and executes only after the user approves; the result reports the touched-window diff. Do not use builtin-cua-driver element-control tools such as click, type_text, set_value, select_option, scroll, press_key, or drag for selected-target work.',
          'For computer_batch with more than two actions or any long text value, write the args file with Node `fs.writeFileSync("/tmp/interpreter-overlay-computer-batch.json", JSON.stringify({ actions }))`, then call `interpreter-app tools builtin-interpreter-overlay computer_batch --json-file /tmp/interpreter-overlay-computer-batch.json`.',
          'To set or replace a text field, use one type action on that field with clear_first true. For a standard dropdown, use one type action on the dropdown control with the exact desired option text. For checkboxes, radios, and buttons, use click actions.',
        ].join('\n')
      : 'No live overlay session is attached. Use non-overlay tools only when the user task and permissions allow it.',
    'Treat element_id values as snapshot-scoped. If target identity or selected context generation changes, reread context and use current refs.',
    'When the task involves reading a document, file, or other source content, report every field and value the source provides, not only the values named in the task. The caller cannot see the source; omitting values loses them. Do not filter or judge which reported values the caller will use; include every value in the structured report itself.',
    'Perform only the delegated task and finish promptly with your report. If the task is to read, extract, or summarize, do not act on the screen or fill anything yourself; the caller stages its own reviewed screen actions from your report.',
    'If the task is to fill or operate the selected screen target yourself, do that work with the allowed overlay tools: read current refs with overlay_read_context, stage the actions with computer_batch, check the touched-window diff, then report the outcome.',
    'The caller owns the live overlay session. Do not try to detach or complete it; when the delegated work is done, finish with your report instead.',
  ];
  const trimmedSystem = system?.trim();
  if (trimmedSystem) {
    lines.push(trimmedSystem);
  }
  return lines.join('\n');
}

async function buildParentOwner(
  context: BuiltinToolContext,
  getAgentBindingForAgentId: (agentId: string) => ParentOwnerBindingSource | undefined | Promise<ParentOwnerBindingSource | undefined>,
): Promise<AgentPermissionOwnerReference> {
  const binding = context.agentId
    ? await getAgentBindingForAgentId(context.agentId)
    : undefined;
  const threadId = context.threadId ?? binding?.threadId;
  return {
    approvalOwnerKind: 'overlay-agent',
    agentId: binding?.agentId ?? context.agentId ?? null,
    ...(threadId ? { threadId } : {}),
    windowSessionKey: binding?.windowSessionKey ?? null,
    workspacePath: binding?.workspacePath ?? context.workspace ?? null,
    ...(binding?.toolProfileId ? { toolProfileId: binding.toolProfileId } : {}),
  };
}

export interface CallHiddenAgentToolDeps {
  createSession: CreateHiddenAgentSession;
  runSubagent: RunHiddenAgent;
  closeSession: CloseHiddenAgentSession;
  getOverlaySessionSnapshot: (agentId: string | undefined) => OverlaySessionDebugSnapshot | null;
  attachToOverlaySession: (sourceAgentId: string | undefined, delegatedAgentId: string) => void;
  releaseOverlaySession: (delegatedAgentId: string) => void;
  getAgentBindingForAgentId: (agentId: string) => ParentOwnerBindingSource | undefined | Promise<ParentOwnerBindingSource | undefined>;
}

const defaultDeps: CallHiddenAgentToolDeps = {
  createSession: async (options) => {
    const { createCodexSubagentSession } = await import('../agents/codexSubagentRunnerBridge');
    return createCodexSubagentSession(options);
  },
  runSubagent: async (options) => {
    const { runCodexSubagent } = await import('../agents/codexSubagentRunnerBridge');
    return runCodexSubagent(options);
  },
  closeSession: (session) => {
    session?.dispose();
  },
  getOverlaySessionSnapshot: overlaySessionManager.getDebugSnapshotForAgent.bind(overlaySessionManager),
  attachToOverlaySession: overlaySessionManager.attachAgentToExistingSession.bind(overlaySessionManager),
  releaseOverlaySession: overlaySessionManager.releaseDelegatedAgentSession.bind(overlaySessionManager),
  getAgentBindingForAgentId: async (agentId: string) => {
    const { agentTabManager } = await import('../../../agentTabManager');
    return agentTabManager.getBindingForAgentId(agentId);
  },
};

export function createCallHiddenAgentTool(deps: CallHiddenAgentToolDeps = defaultDeps): BuiltinToolDefinition {
  return {
    name: 'call_hidden_agent',
    description:
      'Delegate a bounded task to a hidden Interpreter agent using the current overlay model, workspace, and overlay tool scope. Pass the relevant selected-screen/context details in the message.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Task and compact context to send to the hidden agent.',
        },
        system: {
          type: 'string',
          description: 'Optional additional system guidance for the hidden agent.',
        },
        conversation_context: {
          type: 'string',
          description: 'Optional compact conversation context to pass with the task.',
        },
        selected_context: {
          type: 'object',
          description: 'Optional selected-context envelope, target identity, refs, or attachment context needed by the hidden agent.',
        },
        target_refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional snapshot-scoped target refs that the hidden agent should consider.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in milliseconds. Defaults to 300000. Delegated screen work includes waiting for user review approval, so keep this generous.',
          default: 300000,
        },
      },
      required: ['message'],
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
    },
    handler: async (args, context?: BuiltinToolContext) => {
      let session: HiddenAgentSession | null = null;
      let attachedOverlaySession = false;
      try {
        if (!context?.agentId) {
          throw new Error('call_hidden_agent requires an overlay agent context.');
        }
        if (!context.modelConfig) {
          throw new Error('call_hidden_agent requires the caller model configuration.');
        }

        const message = requiredStringArg(args, 'message');
        const system = optionalStringArg(args, 'system');
        const conversationContext = optionalStringArg(args, 'conversation_context');
        const selectedContext = optionalRecordArg(args, 'selected_context');
        const targetRefs = optionalStringArrayArg(args, 'target_refs');
        const timeoutMs = optionalPositiveIntegerArg(args, 'timeout_ms', 300000);
        const parentOwner = await buildParentOwner(context, deps.getAgentBindingForAgentId);
        session = await deps.createSession({
          modelConfig: context.modelConfig,
          allowedToolNames: OVERLAY_HIDDEN_AGENT_ALLOWED_TOOL_NAMES,
          parentOwner,
        });

        if (deps.getOverlaySessionSnapshot(context.agentId)) {
          deps.attachToOverlaySession(context.agentId, session.agentId);
          attachedOverlaySession = true;
        }

        const result = await deps.runSubagent({
          message: buildHiddenAgentMessage({
            message,
            conversationContext,
            selectedContext,
            targetRefs,
          }),
          system: buildHiddenAgentSystem(system, attachedOverlaySession),
          modelConfig: context.modelConfig,
          timeoutMs,
          workspace: context.workspace,
          allowedToolNames: OVERLAY_HIDDEN_AGENT_ALLOWED_TOOL_NAMES,
          parentOwner,
          session,
          abortSignal: context.abortSignal,
        });
        const messages = Array.isArray(result.messages) ? result.messages : [];
        const completed = result.completed === true;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: completed,
              agent_id: result.agentId ?? session.agentId,
              thread_id: result.threadId ?? null,
              completed,
              message_count: messages.length,
              assistant_text: latestAssistantText(messages),
              error: typeof result.error === 'string' ? result.error : null,
            }, null, 2),
          }],
          isError: !completed,
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          }],
          isError: true,
        };
      } finally {
        if (attachedOverlaySession && session) {
          deps.releaseOverlaySession(session.agentId);
        }
        if (session) {
          deps.closeSession(session);
        }
      }
    },
  };
}

export const callHiddenAgentTool = createCallHiddenAgentTool();
