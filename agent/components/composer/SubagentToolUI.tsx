// agent/components/composer/SubagentToolUI.tsx
// Recursive tree rendering for nested subagent tool calls

import { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import type { SubagentToolCallEvent } from '../../../electron/ipc/registry';
import { SUBAGENT_TOOL_CONTAINER_ID, SUBAGENT_TOOL_ITEM_ID } from '../../../shared/element-ids';
import { SUBAGENT_TOOLS } from '../../../shared/toolMetadata';
import { subagentTools } from '@/ipc';
import { COLLAPSE_TRANSITION } from '@/lib/animationConfig';

interface SubagentToolUIProps {
  /** Tool call path for this level, e.g., ["explore-abc"] for top-level or ["explore-abc", "task-def"] for nested */
  toolCallPath: string[];
  /** Name of the tool (for display) */
  toolName: string;
  /** Whether the subagent is still running */
  isRunning: boolean;
  /** Pre-loaded tool calls from saved conversation */
  savedToolCalls?: SubagentToolCallEvent[];
}

/**
 * Check if an event is a direct child of the given path
 */
function isDirectChild(eventPath: string[] | undefined, parentPath: string[]): boolean {
  if (!eventPath) return false;
  if (eventPath.length !== parentPath.length + 1) return false;

  // Check that all parent path elements match
  for (let i = 0; i < parentPath.length; i++) {
    if (eventPath[i] !== parentPath[i]) return false;
  }
  return true;
}

/**
 * Check if an event is in the subtree of the given path
 */
function isInSubtree(eventPath: string[] | undefined, parentPath: string[]): boolean {
  if (!eventPath) return false;
  if (eventPath.length <= parentPath.length) return false;

  // Check that all parent path elements match
  for (let i = 0; i < parentPath.length; i++) {
    if (eventPath[i] !== parentPath[i]) return false;
  }
  return true;
}

export function SubagentToolUI({
  toolCallPath,
  toolName: _toolName,
  isRunning,
  savedToolCalls
}: SubagentToolUIProps) {
  const [toolCalls, setToolCalls] = useState<SubagentToolCallEvent[]>(savedToolCalls || []);
  // Start collapsed. Was previously open-by-default; tool cards now uniformly
  // start collapsed and the user expands if they want to see the nested tree.
  const [isExpanded, setIsExpanded] = useState(false);

  // Derive parentToolCallId for backwards compatibility with test IDs
  // Path elements are formatted as "toolName-toolCallId", extract just the toolCallId
  const pathElement = toolCallPath[toolCallPath.length - 1] || '';
  const parentToolCallId = pathElement.includes('-')
    ? pathElement.split('-').slice(1).join('-')  // Handle case where toolCallId contains dashes
    : pathElement;

  // Keep toolCallPath in a ref so the IPC subscription doesn't depend on array identity.
  // toolCallPath is created as a new array literal on every parent render, which would
  // cause the subscription effect to tear down and recreate on every render — missing
  // IPC events during the gap between unsubscribe and re-subscribe.
  const toolCallPathRef = useRef(toolCallPath);
  toolCallPathRef.current = toolCallPath;

  // Sync savedToolCalls prop to state when it arrives after mount
  useEffect(() => {
    if (savedToolCalls && savedToolCalls.length > 0) {
      setToolCalls(savedToolCalls);
    }
  }, [savedToolCalls]);

  // Subscribe to real-time subagent tool events.
  // Uses a ref for toolCallPath to avoid tearing down the subscription on every parent render.
  useEffect(() => {
    if (!isRunning) return;

    const unsubscribe = subagentTools.onToolCall((event: SubagentToolCallEvent) => {
      // Check if this event is in our subtree (could be direct child or deeper)
      if (!isInSubtree(event.toolCallPath, toolCallPathRef.current)) return;

      setToolCalls(prev => {
        const toolCallId = event.toolCall.toolCallId;
        const existingIdx = prev.findIndex(tc => tc.toolCall.toolCallId === toolCallId);

        if (event.result) {
          // This is a result event
          if (existingIdx >= 0) {
            // Merge result into existing call (immutable update)
            const updated = [...prev];
            updated[existingIdx] = { ...updated[existingIdx], result: event.result };
            return updated;
          }
          // Orphaned result - store it, call will merge later when it arrives
          return [...prev, event];
        }

        // This is a call event
        if (existingIdx >= 0) {
          // Already have this toolCallId (maybe as orphaned result) - merge args into it
          const updated = [...prev];
          updated[existingIdx] = { ...event, result: updated[existingIdx].result };
          return updated;
        }

        // New call
        return [...prev, event];
      });
    });

    return unsubscribe;
  }, [isRunning]);

  // Auto-collapse when done
  useEffect(() => {
    if (!isRunning && toolCalls.length > 0) {
      // Keep expanded for 1 second after completion, then collapse
      const timer = setTimeout(() => setIsExpanded(false), 1000);
      return () => clearTimeout(timer);
    }
  }, [isRunning, toolCalls.length]);

  // Get direct children of this path
  const directChildren = useMemo(() => {
    return toolCalls.filter(tc => isDirectChild(tc.toolCallPath, toolCallPathRef.current));
  }, [toolCalls]);

  // Don't hide if we have savedToolCalls prop (even if not yet in state)
  if (directChildren.length === 0 && !isRunning && !savedToolCalls?.length) {
    return null; // Nothing to show
  }

  const completedCount = directChildren.filter(tc => tc.result).length;
  const hasErrors = directChildren.some(tc => tc.result?.isError);

  return (
    <div
      style={{
        borderLeft: '2px solid color-mix(in oklch, var(--muted-foreground) 30%, transparent)',
        marginTop: 'var(--unit-padding-small)',
        marginLeft: 'var(--unit-padding)',
        paddingLeft: 'var(--unit-padding)',
      }}
      data-testid={SUBAGENT_TOOL_CONTAINER_ID(parentToolCallId)}
    >
      {/* Header - click to expand/collapse */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center text-ui-sm text-muted-foreground hover:text-foreground w-full"
        style={{ gap: 'var(--unit-padding-small)' }}
      >
        {/* Status indicator */}
        <div
          className="flex-shrink-0 flex items-center justify-center"
          style={{ width: 'var(--icon-ui)', height: 'var(--icon-ui)' }}
        >
          {isRunning ? (
            <span
              className="rounded-full animate-blink"
              style={{
                width: '8px',
                height: '8px',
                backgroundColor: 'var(--foreground)',
              }}
            />
          ) : (
            <motion.span
              aria-hidden="true"
              className="text-muted-foreground inline-flex items-center justify-center"
              style={{ width: 'var(--icon-ui)', height: 'var(--icon-ui)' }}
              animate={{ rotate: isExpanded ? 90 : 0 }}
              transition={COLLAPSE_TRANSITION.height}
            >
              <ChevronRight
                style={{ width: 'var(--icon-ui)', height: 'var(--icon-ui)' }}
              />
            </motion.span>
          )}
        </div>

        {/* Summary text */}
        <span className={hasErrors ? 'text-destructive' : ''}>
          {isRunning
            ? `${directChildren.length} tool calls...`
            : `${completedCount} tool calls ${hasErrors ? '(with errors)' : 'completed'}`
          }
        </span>
      </button>

      {/* Tool call list with recursive nesting */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={COLLAPSE_TRANSITION}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-1">
              {directChildren.map((tc, i) => (
                <SubagentToolCallItem
                  key={tc.toolCall.toolCallId || i}
                  call={tc}
                  allCalls={toolCalls}
                  isActive={isRunning && !tc.result}
                  parentIsRunning={isRunning}
                  testId={SUBAGENT_TOOL_ITEM_ID(tc.toolCall.toolCallId || String(i))}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface SubagentToolCallItemProps {
  call: SubagentToolCallEvent;
  allCalls: SubagentToolCallEvent[];
  /** Whether this specific tool call is the actively executing one (controls blink) */
  isActive: boolean;
  /** Whether the parent subagent is still running (controls nested subagent state) */
  parentIsRunning: boolean;
  testId: string;
}

function SubagentToolCallItem({ call, allCalls, isActive, parentIsRunning, testId }: SubagentToolCallItemProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isComplete = !!call.result;
  const isError = call.result?.isError;

  // Check if this tool can have nested subagents
  const isSubagentTool = (SUBAGENT_TOOLS as readonly string[]).includes(call.toolCall.toolName);

  // Get children of this tool call (for recursive rendering)
  const children = useMemo(() => {
    if (!call.toolCallPath) return [];
    return allCalls.filter(tc => isDirectChild(tc.toolCallPath, call.toolCallPath));
  }, [allCalls, call.toolCallPath]);

  // Format tool name nicely
  const displayName = call.toolCall.toolName
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (l: string) => l.toUpperCase());

  // Get first arg value as preview
  const argPreview = (() => {
    const args = call.toolCall.args;
    if (!args) return '';
    const firstValue = Object.values(args)[0];
    if (typeof firstValue === 'string') {
      return firstValue.length > 30 ? firstValue.slice(0, 30) + '...' : firstValue;
    }
    return '';
  })();

  return (
    <div className="text-ui-sm" data-testid={testId}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center w-full text-left"
        style={{ gap: 'var(--unit-padding-small)' }}
      >
        {/* Status indicator */}
        <div
          className="flex-shrink-0 flex items-center justify-center"
          style={{ width: 'var(--icon-ui)', height: 'var(--icon-ui)' }}
        >
          {isComplete ? (
            isError ? (
              <span
                className="rounded-full"
                style={{ width: '8px', height: '8px', backgroundColor: 'var(--destructive)' }}
              />
            ) : (
              <span
                className="rounded-full"
                style={{ width: '8px', height: '8px', backgroundColor: 'var(--hover-bg)' }}
              />
            )
          ) : (
            <span
              className={`rounded-full ${isActive ? 'animate-blink' : ''}`}
              style={{ width: '8px', height: '8px', backgroundColor: isActive ? 'var(--foreground)' : 'var(--hover-bg)' }}
            />
          )}
        </div>

        {/* Tool name and preview */}
        <span className={isComplete ? 'text-muted-foreground' : 'text-foreground'}>
          {displayName}
        </span>
        {argPreview && (
          <span className="text-muted-foreground/60 truncate">
            ({argPreview})
          </span>
        )}

        {/* Nested children indicator */}
        {isSubagentTool && children.length > 0 && (
          <span className="text-muted-foreground/40 text-ui-xs">
            +{children.length} nested
          </span>
        )}
      </button>

      {/* Expanded details */}
      {isExpanded && (
        <div className="ml-4 mt-1 space-y-1">
          <pre className="text-muted-foreground/60 whitespace-pre-wrap break-all text-ui-xs">
            {JSON.stringify(call.toolCall.args, null, 2)}
          </pre>
          {call.result && (
            <pre className={`whitespace-pre-wrap break-all text-ui-xs ${isError ? 'text-destructive' : 'text-muted-foreground/60'}`}>
              {typeof call.result.output === 'string'
                ? call.result.output.slice(0, 500) + (call.result.output.length > 500 ? '...' : '')
                : (JSON.stringify(call.result.output, null, 2) || '').slice(0, 500)
              }
            </pre>
          )}
        </div>
      )}

      {/* Recursive nested subagent UI */}
      {isSubagentTool && call.toolCallPath && children.length > 0 && (
        <SubagentToolUI
          toolCallPath={call.toolCallPath}
          toolName={call.toolCall.toolName}
          isRunning={parentIsRunning && !call.result}
          savedToolCalls={allCalls.filter(tc => isInSubtree(tc.toolCallPath, call.toolCallPath!))}
        />
      )}
    </div>
  );
}
