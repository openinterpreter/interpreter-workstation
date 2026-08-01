import { agentTabManager, type AgentTabCompletionEvent } from '../../../agentTabManager';
import { getWindowSessionByKey } from '../../../utils/windowSessions';
import type { BuiltinServerDefinition, BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import type { AgentPermissionOwnerReference } from '../../../../shared/types/approval';

function optionalStringArg(args: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in args)) {
    return undefined;
  }
  const value = args[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string or null.`);
  }
  return value;
}

function requiredStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function optionalPositiveIntegerArg(args: Record<string, unknown>, key: string, defaultValue: number): number {
  if (!(key in args)) {
    return defaultValue;
  }
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return value;
}

function optionalBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  if (!(key in args)) {
    return undefined;
  }
  const value = args[key];
  if (typeof value !== 'boolean') {
    throw new Error(`${key} must be a boolean.`);
  }
  return value;
}

function optionalStringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
  if (!(key in args)) {
    return undefined;
  }
  const value = args[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value;
}

function optionalJsonObjectArg(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (!(key in args)) {
    return undefined;
  }
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalCompletionDispositionArg(args: Record<string, unknown>): 'keep_open' | 'close_tab' | undefined {
  if (!('completion_disposition' in args)) {
    return undefined;
  }
  const value = args.completion_disposition;
  if (value !== 'keep_open' && value !== 'close_tab') {
    throw new Error('completion_disposition must be "keep_open" or "close_tab".');
  }
  return value;
}

function buildParentOwner(context?: BuiltinToolContext): AgentPermissionOwnerReference | undefined {
  if (!context?.agentId) {
    return undefined;
  }
  const binding = agentTabManager.getBindingForAgentId(context.agentId);
  const threadId = context.threadId ?? binding?.threadId;
  return {
    approvalOwnerKind: context.agentId.startsWith('overlay-agent-') ? 'overlay-agent' : 'normal-agent',
    agentId: binding?.agentId ?? context.agentId,
    ...(threadId ? { threadId } : {}),
    windowSessionKey: binding?.windowSessionKey ?? null,
    workspacePath: binding?.workspacePath ?? context.workspace ?? null,
    ...(binding?.toolProfileId ? { toolProfileId: binding.toolProfileId } : {}),
  };
}

function buildLaunchMessage(input: {
  initialMessage: string;
  conversationContext?: string;
  selectedContext?: Record<string, unknown>;
  targetRefs?: string[];
  inheritedAllowedToolNames?: string[];
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
  if (input.inheritedAllowedToolNames && input.inheritedAllowedToolNames.length > 0) {
    handoff.allowed_tool_names = input.inheritedAllowedToolNames;
  }
  if (Object.keys(handoff).length === 0) {
    return input.initialMessage;
  }
  return `${input.initialMessage}\n\nWindowed agent handoff context:\n${JSON.stringify(handoff, null, 2)}`;
}

function latestAssistantText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role !== 'assistant' || typeof record.content !== 'string') {
      continue;
    }
    return record.content;
  }
  return null;
}

function waitForAgentCompletion(input: {
  agentId: string;
  threadId?: string | null;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<AgentTabCompletionEvent> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cleanup = () => {};
    const finish = (result: { event?: AgentTabCompletionEvent; error?: Error }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      input.abortSignal?.removeEventListener('abort', abort);
      cleanup();
      if (result.error) {
        reject(result.error);
      } else {
        resolve(result.event!);
      }
    };
    const abort = () => {
      finish({ error: new Error('Awaiting agent window completion was aborted.') });
    };
    const timeout = setTimeout(() => {
      finish({ error: new Error(`Timed out waiting for agent window completion after ${input.timeoutMs}ms.`) });
    }, input.timeoutMs);

    cleanup = agentTabManager.onCompletion((event) => {
      if (event.agentId !== input.agentId) {
        return;
      }
      if (input.threadId && event.threadId !== input.threadId) {
        return;
      }
      finish({ event });
    });

    if (input.abortSignal?.aborted) {
      abort();
      return;
    }
    input.abortSignal?.addEventListener('abort', abort, { once: true });
  });
}

export const listAgentWindowsTool: BuiltinToolDefinition = {
  name: 'list_agent_windows',
  description:
    'List Interpreter-owned agent windows and safe thread/status metadata. This read-only tool never returns caller tokens, startup messages, system prompts, attachments, or API keys.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_path: {
        type: ['string', 'null'],
        description: 'Optional exact workspace path filter.',
      },
      window_session_key: {
        type: ['string', 'null'],
        description: 'Optional exact Interpreter window session key filter.',
      },
    },
    required: [],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
  },
  handler: async (args) => {
    try {
      const workspacePath = optionalStringArg(args, 'workspace_path');
      const windowSessionKey = optionalStringArg(args, 'window_session_key');
      const bindings = agentTabManager.listAgentWindowBindings({
        ...(workspacePath !== undefined ? { workspacePath } : {}),
        ...(windowSessionKey !== undefined ? { windowSessionKey } : {}),
      });

      const agents = bindings.map((binding) => {
        const windowSession = getWindowSessionByKey(binding.windowSessionKey);
        return {
          agent_id: binding.agentId,
          thread_id: binding.threadId ?? null,
          window_session_key: binding.windowSessionKey ?? null,
          workspace_path: binding.workspacePath ?? null,
          tool_profile_id: binding.toolProfileId ?? null,
          allowed_tool_names: binding.allowedToolNames ?? [],
          model: binding.model ?? null,
          activity: binding.activity
            ? {
                label: binding.activity.label,
                is_running: binding.activity.isRunning,
                message_count: binding.activity.messageCount,
                unread_count: binding.activity.unreadCount,
                last_message_preview: binding.activity.lastMessagePreview,
                updated_at: binding.activity.updatedAt,
              }
            : null,
          window: windowSession
            ? {
                window_id: windowSession.windowId,
                workspace_path: windowSession.workspacePath,
                created_at: windowSession.createdAt,
              }
            : null,
        };
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ agents }, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  },
};

export const launchAgentWindowTool: BuiltinToolDefinition = {
  name: 'launch_agent_window',
  description:
    'Launch a normal visible Interpreter agent window and send it an initial message. Returns public agent/window ids only; use await_agent_window to wait for completion.',
  inputSchema: {
    type: 'object',
    properties: {
      initial_message: {
        type: 'string',
        description: 'Message to send to the launched visible agent.',
      },
      workspace_path: {
        type: ['string', 'null'],
        description: 'Optional workspace path for the launched agent.',
      },
      target_window_session_key: {
        type: ['string', 'null'],
        description: 'Optional Interpreter window session key to launch into.',
      },
      activate: {
        type: 'boolean',
        description: 'Whether the visible agent should activate when opened.',
      },
      completion_disposition: {
        type: 'string',
        enum: ['keep_open', 'close_tab'],
        description: 'Whether to keep the tab open or close it after startup completion. Defaults to keep_open.',
      },
      conversation_context: {
        type: 'string',
        description: 'Optional compact recent conversation context to include in the launched agent startup message.',
      },
      selected_context: {
        type: 'object',
        description: 'Optional selected context envelope, including selected files/text, target identity, snapshot id, and refs when available.',
      },
      target_refs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional target or UI refs from the current selected context. Refs remain snapshot-scoped.',
      },
    },
    required: ['initial_message'],
  },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
  },
  handler: async (args, context) => {
    try {
      const initialMessage = requiredStringArg(args, 'initial_message');
      const workspacePath = optionalStringArg(args, 'workspace_path');
      const targetWindowSessionKey = optionalStringArg(args, 'target_window_session_key');
      const activate = optionalBooleanArg(args, 'activate');
      const completionDisposition = optionalCompletionDispositionArg(args);
      const conversationContext = optionalStringArg(args, 'conversation_context');
      const selectedContext = optionalJsonObjectArg(args, 'selected_context');
      const targetRefs = optionalStringArrayArg(args, 'target_refs');
      const callerBinding = context?.agentId
        ? agentTabManager.getBindingForAgentId(context.agentId)
        : undefined;
      const inheritedAllowedToolNames = callerBinding?.allowedToolNames
        ? [...callerBinding.allowedToolNames]
        : undefined;
      const parentOwner = buildParentOwner(context);
      const startupMessage = buildLaunchMessage({
        initialMessage,
        ...(conversationContext ? { conversationContext } : {}),
        ...(selectedContext ? { selectedContext } : {}),
        ...(targetRefs ? { targetRefs } : {}),
        ...(inheritedAllowedToolNames ? { inheritedAllowedToolNames } : {}),
      });
      const result = agentTabManager.requestAgentTask({
        initialMessage: startupMessage,
        ...(workspacePath ? { workspacePath } : {}),
        ...(targetWindowSessionKey ? { targetWindowSessionKey } : {}),
        ...(activate !== undefined ? { activate } : {}),
        ...(completionDisposition ? { completionDisposition } : {}),
        ...(inheritedAllowedToolNames ? { allowedToolNames: inheritedAllowedToolNames } : {}),
        ...(parentOwner ? { parentOwner } : {}),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'launch_requested',
              agent_id: result.agentId,
              request_id: result.requestId ?? null,
              startup_id: result.startupId ?? null,
              thread_id: result.threadId ?? null,
              workspace_path: workspacePath ?? null,
              target_window_session_key: targetWindowSessionKey ?? null,
              inherited_allowed_tool_names: inheritedAllowedToolNames ?? [],
            }, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  },
};

export const sendAgentWindowMessageTool: BuiltinToolDefinition = {
  name: 'send_agent_window_message',
  description:
    'Send a follow-up message to an existing visible Interpreter agent window. If that agent is running, the existing agent UI queues the message for the next safe turn.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'Agent id from list_agent_windows.',
      },
      message: {
        type: 'string',
        description: 'Follow-up message to send to the agent window.',
      },
      thread_id: {
        type: ['string', 'null'],
        description: 'Optional thread id guard for the target agent.',
      },
      workspace_path: {
        type: ['string', 'null'],
        description: 'Optional workspace path to attach to the sent message. Defaults to the registered agent workspace.',
      },
    },
    required: ['agent_id', 'message'],
  },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
  },
  handler: async (args) => {
    try {
      const agentId = requiredStringArg(args, 'agent_id');
      const message = requiredStringArg(args, 'message');
      const threadId = optionalStringArg(args, 'thread_id');
      const workspacePath = optionalStringArg(args, 'workspace_path');
      const binding = agentTabManager.requestAgentWindowMessage({
        agentId,
        ...(threadId ? { threadId } : {}),
        message,
        ...(workspacePath !== undefined ? { workspacePath } : {}),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'send_requested',
              agent_id: binding.agentId,
              thread_id: binding.threadId ?? null,
              window_session_key: binding.windowSessionKey ?? null,
              workspace_path: workspacePath ?? binding.workspacePath ?? null,
            }, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  },
};

export const revealAgentWindowTool: BuiltinToolDefinition = {
  name: 'reveal_agent_window',
  description:
    'Reveal and focus an existing visible Interpreter agent window/tab by agent id.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'Agent id from list_agent_windows.',
      },
    },
    required: ['agent_id'],
  },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
  },
  handler: async (args) => {
    try {
      const agentId = requiredStringArg(args, 'agent_id');
      const binding = agentTabManager.requestAgentWindowReveal(agentId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'reveal_requested',
              agent_id: binding.agentId,
              thread_id: binding.threadId ?? null,
              window_session_key: binding.windowSessionKey ?? null,
              workspace_path: binding.workspacePath ?? null,
            }, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  },
};

export const stopAgentWindowTool: BuiltinToolDefinition = {
  name: 'stop_agent_window',
  description:
    'Request cancellation of a running visible Interpreter agent window through the existing agent UI stop path.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'Agent id from list_agent_windows.',
      },
    },
    required: ['agent_id'],
  },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
  },
  handler: async (args) => {
    try {
      const agentId = requiredStringArg(args, 'agent_id');
      const binding = agentTabManager.requestAgentWindowStop(agentId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'stop_requested',
              agent_id: binding.agentId,
              thread_id: binding.threadId ?? null,
              window_session_key: binding.windowSessionKey ?? null,
              workspace_path: binding.workspacePath ?? null,
            }, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  },
};

export const closeAgentWindowTool: BuiltinToolDefinition = {
  name: 'close_agent_window',
  description:
    'Close an existing visible Interpreter agent window/tab through the existing app tab close path.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'Agent id from list_agent_windows.',
      },
    },
    required: ['agent_id'],
  },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
  },
  handler: async (args) => {
    try {
      const agentId = requiredStringArg(args, 'agent_id');
      const binding = agentTabManager.requestAgentWindowClose(agentId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'close_requested',
              agent_id: binding.agentId,
              thread_id: binding.threadId ?? null,
              window_session_key: binding.windowSessionKey ?? null,
              workspace_path: binding.workspacePath ?? null,
            }, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  },
};

export const awaitAgentWindowTool: BuiltinToolDefinition = {
  name: 'await_agent_window',
  description:
    'Wait for an Interpreter-owned agent window to finish its current task and return safe completion metadata. This does not expose caller tokens or full message history.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'Agent id from list_agent_windows.',
      },
      thread_id: {
        type: ['string', 'null'],
        description: 'Optional thread id filter for the awaited completion.',
      },
      timeout_ms: {
        type: 'integer',
        description: 'Positive timeout in milliseconds. Defaults to 120000.',
      },
    },
    required: ['agent_id'],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: false,
    destructiveHint: false,
  },
  handler: async (args, context?: BuiltinToolContext) => {
    try {
      const agentId = requiredStringArg(args, 'agent_id');
      const threadId = optionalStringArg(args, 'thread_id');
      const timeoutMs = optionalPositiveIntegerArg(args, 'timeout_ms', 120_000);
      const binding = agentTabManager.getBindingForAgentId(agentId);
      if (!binding) {
        throw new Error(`No Interpreter agent window is registered for agent_id=${JSON.stringify(agentId)}.`);
      }
      if (threadId && binding.threadId && binding.threadId !== threadId) {
        throw new Error(`Agent ${agentId} is bound to thread ${binding.threadId}, not ${threadId}.`);
      }

      const completion = await waitForAgentCompletion({
        agentId,
        threadId,
        timeoutMs,
        abortSignal: context?.abortSignal,
      });
      const payload = {
        agent_id: completion.agentId,
        thread_id: completion.threadId ?? null,
        request_id: completion.requestId ?? null,
        startup_id: completion.startupId ?? null,
        status: completion.error ? 'error' : 'completed',
        error: completion.error ?? null,
        message_count: completion.messages.length,
        latest_assistant_text: latestAssistantText(completion.messages),
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
        isError: Boolean(completion.error),
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  },
};

export const agentWindowsServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-agent-windows',
  name: 'Agent Windows',
  description: 'Read Interpreter-owned agent window and thread metadata',
  isBuiltin: true,
  tools: [
    listAgentWindowsTool,
    launchAgentWindowTool,
    sendAgentWindowMessageTool,
    revealAgentWindowTool,
    stopAgentWindowTool,
    closeAgentWindowTool,
    awaitAgentWindowTool,
  ],
  resources: [],
  prompts: [],
};
