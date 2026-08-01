// server/utils/subagentToolStore.ts
// Stores subagent tool call events for real-time streaming and conversation persistence
// Supports path-based indexing for nested subagent tree queries

import type { SubagentToolCallEvent } from '../../electron/ipc/registry';

// Primary index: by toolCallId for O(1) lookup and merging
const eventsByToolCallId = new Map<string, SubagentToolCallEvent>();

// Secondary index: by root parent ID for backwards-compat getAllSubagentToolCalls()
// Maps rootToolCallId -> Set<toolCallId>
const eventsByRootParent = new Map<string, Set<string>>();

/**
 * Convert a path array to a string key for indexing
 */
function pathToKey(path: string[]): string {
  return path.join('/');
}

/**
 * Get the root parent ID from a path
 * Path elements are formatted as "toolName-toolCallId", extract just the toolCallId
 * Falls back to parentToolCallId for backwards compatibility
 */
function getRootParentId(event: SubagentToolCallEvent): string {
  const pathElement = event.toolCallPath?.[0];
  if (pathElement) {
    // Extract toolCallId from "toolName-toolCallId" format
    // Handle case where toolCallId contains dashes (e.g., "explore-fc_xxx-yyy")
    const parts = pathElement.split('-');
    if (parts.length >= 2) {
      return parts.slice(1).join('-'); // Everything after the first dash is the toolCallId
    }
    return pathElement;
  }
  return event.parentToolCallId;
}

/**
 * Add or merge a subagent tool call event
 * - If result arrives before call: stores as orphaned result
 * - If call arrives after result: merges result into call
 * - If call is duplicate: ignores it
 */
export function addSubagentToolCall(event: SubagentToolCallEvent) {
  const toolCallId = event.toolCall.toolCallId;
  const existing = eventsByToolCallId.get(toolCallId);

  if (existing && event.result) {
    // Merge result into existing call (immutable update)
    eventsByToolCallId.set(toolCallId, { ...existing, result: event.result });
  } else if (event.result && !existing) {
    // Orphaned result arrived before call - store it, call will merge later
    eventsByToolCallId.set(toolCallId, event);
    indexByRootParent(event);
  } else if (!existing) {
    // New call event
    eventsByToolCallId.set(toolCallId, event);
    indexByRootParent(event);
  }
  // If existing and !event.result, it's a duplicate call - ignore
}

/**
 * Index an event by its root parent for backwards-compat queries
 */
function indexByRootParent(event: SubagentToolCallEvent) {
  const rootId = getRootParentId(event);
  if (!eventsByRootParent.has(rootId)) {
    eventsByRootParent.set(rootId, new Set());
  }
  eventsByRootParent.get(rootId)!.add(event.toolCall.toolCallId);
}

/**
 * Get all events that are direct children of a given path
 * @param parentPath The path to the parent (e.g., ["explore-abc"])
 * @returns Events where toolCallPath.length === parentPath.length + 1 and path starts with parentPath
 */
export function getDirectChildren(parentPath: string[]): SubagentToolCallEvent[] {
  const parentKey = pathToKey(parentPath);
  const results: SubagentToolCallEvent[] = [];

  for (const event of eventsByToolCallId.values()) {
    // Must be direct child (one level deeper)
    if (event.toolCallPath?.length !== parentPath.length + 1) continue;

    // Must share the same path prefix
    const eventParentKey = pathToKey(event.toolCallPath.slice(0, parentPath.length));
    if (eventParentKey === parentKey) {
      results.push(event);
    }
  }

  return results;
}

/**
 * Get all events in the subtree under a given path (including the path itself)
 * @param parentPath The path to the parent (e.g., ["explore-abc"])
 * @returns All events where path starts with parentPath
 */
export function getSubtree(parentPath: string[]): SubagentToolCallEvent[] {
  const parentKey = pathToKey(parentPath);
  const results: SubagentToolCallEvent[] = [];

  for (const event of eventsByToolCallId.values()) {
    if (!event.toolCallPath) continue;

    // Check if event's path starts with parentPath
    if (event.toolCallPath.length >= parentPath.length) {
      const eventPrefixKey = pathToKey(event.toolCallPath.slice(0, parentPath.length));
      if (eventPrefixKey === parentKey) {
        results.push(event);
      }
    }
  }

  return results;
}

/**
 * @deprecated Use getDirectChildren or getSubtree instead
 * Get all tool calls for a given parent tool call ID (backwards-compat)
 */
export function getSubagentToolCalls(parentToolCallId: string): SubagentToolCallEvent[] {
  const toolCallIds = eventsByRootParent.get(parentToolCallId);
  if (!toolCallIds) return [];

  return Array.from(toolCallIds)
    .map(id => eventsByToolCallId.get(id))
    .filter((e): e is SubagentToolCallEvent => e !== undefined);
}

/**
 * Get all subagent tool calls grouped by root parent ID
 * Used for conversation persistence
 */
export function getAllSubagentToolCalls(): Record<string, SubagentToolCallEvent[]> {
  const result: Record<string, SubagentToolCallEvent[]> = {};

  for (const [rootId, toolCallIds] of eventsByRootParent.entries()) {
    result[rootId] = Array.from(toolCallIds)
      .map(id => eventsByToolCallId.get(id))
      .filter((e): e is SubagentToolCallEvent => e !== undefined);
  }

  return result;
}

/**
 * Clear all tool calls for a specific root parent
 */
export function clearSubagentToolCalls(parentToolCallId: string) {
  const toolCallIds = eventsByRootParent.get(parentToolCallId);
  if (toolCallIds) {
    for (const id of toolCallIds) {
      eventsByToolCallId.delete(id);
    }
    eventsByRootParent.delete(parentToolCallId);
  }
}

/**
 * Clear all stored subagent tool calls
 * Called after conversation is saved or agent run completes
 */
export function clearAllSubagentToolCalls() {
  eventsByToolCallId.clear();
  eventsByRootParent.clear();
}
