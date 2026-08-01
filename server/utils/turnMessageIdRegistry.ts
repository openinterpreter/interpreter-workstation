// NOTE(victor): This module tracks which turn message ID is "active" so
// downstream code can associate tool execution with the correct turn without
// threading messageId through every call signature.
//
// Uses a hybrid of AsyncLocalStorage + global fallback:
// - ALS provides isolation between concurrent /chat/stream requests (each Express
//   handler runs in a separate async context, so enterWith scopes to that request).
// - Global fallback allows cross-context reads: Codex tool calls arrive via MCP
//   JSON-RPC messages in a DIFFERENT async context than the /chat/stream handler
//   that set the ID.

import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<string | null>();
let globalFallback: string | null = null;

export function setCurrentTurnMessageId(id: string | null): void {
  als.enterWith(id);
  globalFallback = id;
}

export function getCurrentTurnMessageId(): string | null {
  // NOTE(victor): als.getStore() returns undefined when called outside any ALS
  // context (e.g. MCP tools/call handler). In that case, fall back to the global.
  // When called inside an ALS context, getStore() returns string|null (never
  // undefined), so the ALS value takes precedence.
  const alsValue = als.getStore();
  if (alsValue !== undefined) return alsValue;
  return globalFallback;
}

// NOTE(victor): Creates an isolated async context for request-scoped turn tracking.
// Express HTTP handlers get separate async contexts automatically (each incoming
// request is a new async resource in Node's event loop), but this function is
// needed for: (1) tests that simulate concurrent requests, (2) any non-HTTP
// caller that needs explicit isolation. Wraps AsyncLocalStorage.run() so that
// set/get calls inside fn are scoped to this context and don't leak.
export function runInTurnContext<T>(id: string | null, fn: () => T): T {
  return als.run(id, fn);
}

// NOTE(victor): Runs fn outside any ALS context, simulating code paths that
// are not descendants of a setCurrentTurnMessageId call (e.g. MCP tools/call
// handlers that arrive on a separate transport). getCurrentTurnMessageId()
// inside fn will fall through to the global fallback. Exported for tests.
export function exitTurnContext<T>(fn: () => T): T {
  return als.exit(fn);
}
