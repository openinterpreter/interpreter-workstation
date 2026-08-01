// NOTE(mcp-approval-correlation): This module bridges app-server stream item IDs to the MCP
// tool execution path, fixing tool approval correlation in the sidebar/thread view.
//
// Problem: When Codex calls an MCP tool, two disconnected things happen:
//
//   1. The Codex event stream emits `item/started` with
//      { type: "mcpToolCall", id: "item_abc", server: "builtin-fs", tool: "delete_file" }
//
//   2. A separate MCP `tools/call` JSON-RPC request arrives with
//      { name: "builtin-fs__delete_file", arguments: { path: "..." } }
//      -- but carries NO Codex item ID.
//
// Without this bridge, toolManager creates an approval with `toolCallId: undefined`,
// so the sidebar's ToolCallCard can't match it (`approval.toolCallId === tc.id` fails).
// The left panel (Approvals.tsx) still works because it fetches all approvals unfiltered.
//
// Fix: A FIFO queue keyed by (server, tool, arguments). When `item/started` arrives
// in agent.ts, we push the item ID. When `tools/call` arrives in mcp.ts, we pop it
// and forward it to toolManager.callTool as `externalToolCallId`.
//
// FIFO ordering is safe because Codex app-server processes MCP tools/call requests
// sequentially per-server -- it awaits each response before sending the next.
//
// In practice, the HTTP tools/call request can reach our MCP route a few milliseconds
// before the matching item/started notification is processed on the stream listener.
// We therefore keep the FIFO queue and briefly hold the tools/call request open for
// correlation. If no item arrives within that window, we proceed without an external
// tool call ID so generic MCP clients still complete normally.
// See: https://developers.openai.com/codex/app-server (Items / mcpToolCall lifecycle)
//
// Source trace: upstream stream item registration happens in
// `server/routes/agent.ts`; the matching `/mcp` tools/call request enters
// through `server/routes/mcp.ts`; `ToolManager.callTool()` receives the
// correlated item ID as `externalToolCallId`.

import type { ToolManager } from '../tools/toolManager';
import { agentTabManager, type AgentThreadBinding } from '../agentTabManager';
import { getToolManager } from '../tools/toolManagerAccessor';
import { runWithWindowSessionOverride } from './windowSessions';
import { runWithWorkspaceOverride } from './workspace';

// --- Types ---

export interface CodexToolCallParams {
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  callerTabId?: string;
  profileId?: string;
  signal?: AbortSignal;
}

export interface CodexToolCallMetadata {
  threadId?: string;
}

type PendingToolCall = {
  itemId: string;
  metadata?: CodexToolCallMetadata;
};

type CodexMcpAgentBinding = Pick<
  AgentThreadBinding,
  | 'agentId'
  | 'callerToken'
  | 'threadId'
  | 'windowSessionKey'
  | 'workspacePath'
  | 'allowedToolNames'
  | 'modelConfig'
  | 'toolProfileId'
>;

// --- FIFO Registry ---

// Map keyed by "server::tool::arguments", values are queued Codex item IDs plus
// metadata that should follow the correlated tool call (for example threadId).
// Each entry represents an in-flight mcpToolCall whose item/started notification
// arrived but whose tools/call request hasn't been processed yet.
const pendingToolCalls = new Map<string, PendingToolCall[]>();
const waitingConsumers = new Map<string, Array<{
  resolve: (item: PendingToolCall | undefined) => void;
  reject: (error: Error) => void;
}>>();
type LateRegistrationGuard = {
  releaseTimer: ReturnType<typeof setTimeout> | null;
};
const lateRegistrationGuards = new Map<string, LateRegistrationGuard[]>();
const resolvedToolCallMetadata = new Map<string, CodexToolCallMetadata>();

let ttlMs = 60_000;
let waitForRegistrationMs = 100;
let lateRegistrationGraceMs = 100;
let resolvedToolCallMetadataTtlMs = 60 * 60 * 1000;
const MAIN_AGENT_WAIT_FOR_REGISTRATION_MS = 750;

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`);
  return `{${entries.join(',')}}`;
}

function makeKey(server: string, tool: string, args?: unknown): string {
  return `${server}::${tool}::${stableSerialize(args ?? {})}`;
}

function createAbortError(): Error {
  const error = new Error('Codex MCP tool call was cancelled before item correlation completed');
  error.name = 'AbortError';
  return error;
}

function addLateRegistrationGuard(key: string): LateRegistrationGuard {
  const guard: LateRegistrationGuard = { releaseTimer: null };
  const current = lateRegistrationGuards.get(key) ?? [];
  current.push(guard);
  lateRegistrationGuards.set(key, current);
  return guard;
}

function consumeLateRegistrationGuard(key: string): boolean {
  const current = lateRegistrationGuards.get(key);
  if (!current || current.length === 0) {
    return false;
  }
  const guard = current.shift()!;
  if (guard.releaseTimer) {
    clearTimeout(guard.releaseTimer);
  }
  if (current.length > 0) {
    lateRegistrationGuards.set(key, current);
    return true;
  }
  lateRegistrationGuards.delete(key);
  return true;
}

function releaseLateRegistrationGuard(key: string, guard: LateRegistrationGuard): void {
  const current = lateRegistrationGuards.get(key);
  if (!current) return;

  const idx = current.indexOf(guard);
  if (idx === -1) return;

  current.splice(idx, 1);
  if (current.length > 0) {
    lateRegistrationGuards.set(key, current);
    return;
  }
  lateRegistrationGuards.delete(key);
}

function scheduleLateRegistrationGuardRelease(key: string, guard: LateRegistrationGuard): void {
  if (guard.releaseTimer) {
    clearTimeout(guard.releaseTimer);
  }
  guard.releaseTimer = setTimeout(() => {
    releaseLateRegistrationGuard(key, guard);
  }, lateRegistrationGraceMs);
}

export function registerPendingToolCall(
  server: string,
  tool: string,
  itemId: string,
  args?: unknown,
  metadata?: CodexToolCallMetadata,
): void {
  const key = makeKey(server, tool, args);
  if (consumeLateRegistrationGuard(key)) {
    return;
  }

  const pendingToolCall: PendingToolCall = { itemId, metadata };

  const waiters = waitingConsumers.get(key);
  if (waiters && waiters.length > 0) {
    const waiter = waiters.shift()!;
    if (waiters.length === 0) {
      waitingConsumers.delete(key);
    }
    waiter.resolve(pendingToolCall);
    return;
  }

  if (!pendingToolCalls.has(key)) {
    pendingToolCalls.set(key, []);
  }
  pendingToolCalls.get(key)!.push(pendingToolCall);

  // TTL prevents unbounded memory growth if a tools/call never arrives
  // for a registered item (e.g. Codex cancels the item mid-flight). The timeout is
  // a harmless no-op if the item was already consumed via consumePendingToolCall.
  setTimeout(() => {
    const queue = pendingToolCalls.get(key);
    if (queue) {
      const idx = queue.findIndex((entry) => entry.itemId === itemId);
      if (idx !== -1) queue.splice(idx, 1);
      if (queue.length === 0) pendingToolCalls.delete(key);
    }
  }, ttlMs);
}

function consumePendingToolRegistration(
  server: string,
  tool: string,
  args?: unknown,
): PendingToolCall | undefined {
  const key = makeKey(server, tool, args);
  const queue = pendingToolCalls.get(key);
  if (!queue || queue.length === 0) return undefined;
  const item = queue.shift()!;
  if (queue.length === 0) pendingToolCalls.delete(key);
  return item;
}

export function consumePendingToolCall(server: string, tool: string, args?: unknown): string | undefined {
  return consumePendingToolRegistration(server, tool, args)?.itemId;
}

async function awaitPendingToolRegistration(
  server: string,
  tool: string,
  args?: unknown,
  signal?: AbortSignal,
  waitMs: number = waitForRegistrationMs,
): Promise<PendingToolCall | undefined> {
  const immediate = consumePendingToolRegistration(server, tool, args);
  if (immediate) {
    return immediate;
  }

  const key = makeKey(server, tool, args);
  return await new Promise<PendingToolCall | undefined>((resolve, reject) => {
    if (!waitingConsumers.has(key)) {
      waitingConsumers.set(key, []);
    }

    const removeWaiter = () => {
      const currentWaiters = waitingConsumers.get(key);
      if (!currentWaiters) return;
      const idx = currentWaiters.indexOf(waiter);
      if (idx !== -1) {
        currentWaiters.splice(idx, 1);
      }
      if (currentWaiters.length === 0) {
        waitingConsumers.delete(key);
      }
    };

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const waiter: {
      resolve: (item: PendingToolCall | undefined) => void;
      reject: (error: Error) => void;
    } = {
      resolve: (item) => {
        if (settled) return;
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        removeWaiter();
        signal?.removeEventListener('abort', onAbort);
        resolve(item);
      },
      reject: (error: Error) => {
        if (settled) return;
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        removeWaiter();
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    };

    const onAbort = () => {
      waiter.reject(createAbortError());
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    waitingConsumers.get(key)!.push(waiter);
    timeoutId = setTimeout(() => {
      waiter.resolve(undefined);
    }, waitMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function awaitPendingToolCall(
  server: string,
  tool: string,
  args?: unknown,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return (await awaitPendingToolRegistration(server, tool, args, signal))?.itemId;
}

export function rememberToolCallMetadata(toolCallId: string, metadata: CodexToolCallMetadata): void {
  if (!toolCallId) return;
  if (!metadata.threadId) return;

  resolvedToolCallMetadata.set(toolCallId, metadata);
  setTimeout(() => {
    const current = resolvedToolCallMetadata.get(toolCallId);
    if (current === metadata) {
      resolvedToolCallMetadata.delete(toolCallId);
    }
  }, resolvedToolCallMetadataTtlMs);
}

export function getToolCallMetadata(toolCallId?: string): CodexToolCallMetadata | undefined {
  if (!toolCallId) return undefined;
  return resolvedToolCallMetadata.get(toolCallId);
}

export function clearPendingToolCalls(): void {
  pendingToolCalls.clear();
  resolvedToolCallMetadata.clear();
  for (const guards of lateRegistrationGuards.values()) {
    for (const guard of guards) {
      if (guard.releaseTimer) {
        clearTimeout(guard.releaseTimer);
      }
    }
  }
  lateRegistrationGuards.clear();
  const allWaiters = [...waitingConsumers.values()].flatMap((waiters) => [...waiters]);
  waitingConsumers.clear();
  for (const waiter of allWaiters) {
    waiter.reject(new Error('Pending tool calls cleared during cleanup'));
  }
}

// Exported for tests only. Allows TTL tests to use short timeouts
// instead of waiting 60 seconds.
export function _setTtlForTest(ms: number): void {
  ttlMs = ms;
}

export function _setWaitForRegistrationMsForTest(ms: number): void {
  waitForRegistrationMs = ms;
}

export function _setLateRegistrationGraceMsForTest(ms: number): void {
  lateRegistrationGraceMs = ms;
}

export function _setResolvedToolCallMetadataTtlMsForTest(ms: number): void {
  resolvedToolCallMetadataTtlMs = ms;
}

// --- Middleware ---

/**
 * NOTE(interpreter-cli-mcp): This bridge converts a scoped `/mcp` tools/call into the
 * same owner context that `interpreter-app tools ...` already has: caller tab,
 * thread, workspace, model config, tool profile, and window session. That owner
 * context is required because `ApprovalManager` scopes broadcasts from the
 * current async window/workspace context when `ToolManager.callTool()` creates
 * the MCP approval.
 *
 * If a non-builtin scoped MCP call has no thread owner, fail closed. Otherwise
 * the approval would either be invisible or execute through an unowned app-server
 * tool thread.
 *
 * Trail: [scoped route](../routes/mcp.ts) ->
 * [CLI-owned path](../handlers/interpreterCli.ts) ->
 * [approval gate](../tools/toolManager.ts) ->
 * [owner capture](../approvalManager.ts).
 */
// The `deps` parameter defaults to the real getToolManager accessor.
// Tests pass a mock to verify callTool arguments without module-level mocking,
// consistent with this codebase's test style (no mock/spyOn usage).
export async function resolveAndExecuteCodexTool(
  params: CodexToolCallParams,
  deps: {
    getToolManager: () => Pick<ToolManager, 'callTool'>;
    getAgentBindingForAgentId?: (agentId: string) => CodexMcpAgentBinding | undefined;
    isBuiltinTool?: (serverId: string, toolName: string) => boolean;
  } = {
    getToolManager,
    getAgentBindingForAgentId: (agentId) => agentTabManager.getBindingForAgentId(agentId),
  },
): Promise<any> {
  const { serverId, toolName, args, callerTabId, profileId, signal } = params;

  const key = makeKey(serverId, toolName, args);
  const registrationWaitMs = profileId === 'main-agent'
    ? MAIN_AGENT_WAIT_FOR_REGISTRATION_MS
    : waitForRegistrationMs;

  const registration = await awaitPendingToolRegistration(
    serverId,
    toolName,
    args,
    signal,
    registrationWaitMs,
  );
  const codexItemId = registration?.itemId;
  const shouldDropOneLateRegistration = codexItemId === undefined;
  const lateRegistrationGuard = shouldDropOneLateRegistration
    ? addLateRegistrationGuard(key)
    : undefined;

  const toolManager = deps.getToolManager();
  const binding = callerTabId
    ? deps.getAgentBindingForAgentId?.(callerTabId)
    : undefined;
  const workspace = binding?.workspacePath;
  const effectiveProfileId = binding?.toolProfileId ?? profileId;
  const threadId = binding?.threadId ?? registration?.metadata?.threadId;
  const isBuiltinTool = deps.isBuiltinTool?.(serverId, toolName)
    ?? ((await import('../tools/builtinTools')).getBuiltinToolHandler(serverId, toolName) !== undefined);
  const toolContext = {
    ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
    ...(binding?.modelConfig ? { modelConfig: binding.modelConfig } : {}),
    ...(threadId ? { threadId } : {}),
    ...(workspace ? { workspace } : {}),
  };
  try {
    if (codexItemId && registration?.metadata?.threadId) {
      rememberToolCallMetadata(codexItemId, registration.metadata);
    } else if (profileId === 'main-agent') {
      console.warn(
        '[Codex MCP bridge] Correlation miss for main-agent tool call:',
        serverId,
        toolName,
      );
    }
    if (!isBuiltinTool && profileId && !threadId) {
      return {
        content: [{
          type: 'text',
          text: 'MCP tool calls require an active Interpreter thread before approval can be shown.',
        }],
        isError: true,
      };
    }

    return await runWithWindowSessionOverride(binding?.windowSessionKey ?? null, async () => {
      return await runWithWorkspaceOverride(workspace ?? null, async () => {
        return await toolManager.callTool(
          serverId,
          toolName,
          args as Record<string, any>,
          undefined,    // saveToDisk
          callerTabId,
          Object.keys(toolContext).length > 0 ? toolContext : undefined,
          codexItemId,  // externalToolCallId -- bridges the Codex item ID to the approval
        );
      });
    });
  } finally {
    if (lateRegistrationGuard) {
      scheduleLateRegistrationGuardRelease(key, lateRegistrationGuard);
    }
  }
}
