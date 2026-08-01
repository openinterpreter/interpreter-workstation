/**
 * Per-item live snapshot store (Doc 05 §2 finish line).
 *
 * The current chat shape stores all messages in one React state array
 * inside useChat. During streaming, every delta produces a new draft
 * snapshot which propagates through React to every tool-call card in
 * the streaming message — even cards whose content didn't change.
 * `React.memo` helps but the parent still has to walk and diff.
 *
 * This module decouples streaming deltas from the parent tree:
 *   * useChat writes per-item snapshots to the store on every delta.
 *   * Tool-call card components subscribe by item id and read only
 *     their own slice.
 *
 * When an item's content changes, only the matching card re-renders.
 * Sibling cards do not.
 *
 * Convention: the store holds tool-call snapshots WHILE THE ITEM IS
 * STREAMING. Once a stream ends, useChat clears the store entries for
 * that turn; from then on the committed messages array is canonical.
 */

import type { ToolCallInfo } from '../hooks/use-chat';

type Listener = () => void;

const snapshots = new Map<string, ToolCallInfo>();
const listeners = new Map<string, Set<Listener>>();

function areSnapshotsEqualForRender(a: ToolCallInfo, b: ToolCallInfo): boolean {
  if (a === b) return true;
  if (a.state !== b.state) return false;
  if (a.output !== b.output) return false;
  if (a.details !== b.details) return false;
  if (a.label !== b.label) return false;
  if (a.type !== b.type) return false;
  if (a.backgroundState !== b.backgroundState) return false;
  if (a.filePath !== b.filePath) return false;
  if (a.target !== b.target) return false;
  // `item` is the underlying delta payload; reference compare is enough
  // because applyChatEvent constructs a new object only when the payload
  // genuinely changed.
  if (a.item !== b.item) return false;
  return true;
}

export function setLiveToolCall(itemId: string, snapshot: ToolCallInfo): void {
  if (!itemId) return;
  const existing = snapshots.get(itemId);
  if (existing && areSnapshotsEqualForRender(existing, snapshot)) {
    // The render-relevant fields didn't change. Keep listeners quiet so
    // sibling cards don't re-render for nothing.
    return;
  }
  snapshots.set(itemId, snapshot);
  const set = listeners.get(itemId);
  if (!set) return;
  for (const listener of set) listener();
}

export function clearLiveToolCall(itemId: string): void {
  if (!itemId) return;
  if (!snapshots.has(itemId)) return;
  snapshots.delete(itemId);
  const set = listeners.get(itemId);
  if (!set) return;
  for (const listener of set) listener();
}

/**
 * Bulk-clear: called when a stream ends so the next turn's draft can
 * start clean. Avoids unbounded growth across many sessions.
 */
export function clearLiveToolCallsForIds(itemIds: Iterable<string>): void {
  for (const id of itemIds) clearLiveToolCall(id);
}

export function getLiveToolCall(itemId: string): ToolCallInfo | null {
  return snapshots.get(itemId) ?? null;
}

export function subscribeLiveToolCall(itemId: string, listener: Listener): () => void {
  if (!itemId) return () => {};
  let set = listeners.get(itemId);
  if (!set) {
    set = new Set();
    listeners.set(itemId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) listeners.delete(itemId);
  };
}

// Test-only: reset all live entries and listeners. Not exported on the
// public store surface; tests import the module directly.
export function __resetLiveToolCallsForTests(): void {
  snapshots.clear();
  listeners.clear();
}
