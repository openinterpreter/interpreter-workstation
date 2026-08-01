import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import {
  overlaySessionManager,
  type OverlaySessionCapturedContext,
  type OverlayDrawingAnnotation,
} from '../../../overlaySessionManager';
import { formatTouchedWindowDiff } from '../../../../apps/interpreter-overlay/shared/touched-window-diff';
import {
  formatCurrentSelectionContext,
  formatTargetIdentity,
} from '../../../../apps/interpreter-overlay/shared/context-packet';
import type { ToolExecutionResult } from '../../../../apps/interpreter-overlay/shared/ports';
import { executeUnifiedComputerBatchToolCall } from './computerBatchExecutor';

function formatBounds(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
} | null | undefined): string {
  if (!bounds) {
    return 'unknown';
  }
  return `x=${Math.round(bounds.x)}, y=${Math.round(bounds.y)}, width=${Math.round(bounds.width)}, height=${Math.round(bounds.height)}`;
}

function sameBounds(
  left: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null | undefined,
  right: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function buildScreenshotFileMention(context: OverlaySessionCapturedContext): string | null {
  if (!context.screenshotPath) {
    return null;
  }
  const label = sameBounds(
    context.captureBoundsDIP ?? null,
    context.displayBoundsDIP ?? null,
  )
    ? 'Screen contents'
    : 'Screen region';
  const safePath = context.screenshotPath.replace(/>/g, '%3E');
  return `@[${label}](<${safePath}>)`;
}

export function buildContextText(context: OverlaySessionCapturedContext): string {
  const header = [
    'Interpreter Overlay live context',
    `Capture bounds: ${formatBounds(context.captureBoundsDIP ?? context.displayBoundsDIP ?? null)}`,
    `Element count: ${context.elementCount}`,
  ].join('\n');
  const screenshotMention = buildScreenshotFileMention(context);
  const selectedContextText = context.currentSelectionContext
    ? [
        ...formatTargetIdentity(context.currentSelectionContext.targetIdentity),
        ...formatCurrentSelectionContext(context.currentSelectionContext),
      ].join('\n')
    : null;

  const formattedText = context.formattedText.trim();
  if (!formattedText) {
    return [
      header,
      selectedContextText,
      screenshotMention,
      context.agentMode === 'vision'
        ? 'Vision mode is active. Use the screenshot file reference for the latest screen state.'
        : 'No accessibility text was available in the granted square.',
    ].filter(Boolean).join('\n\n');
  }

  return [
    header,
    selectedContextText,
    screenshotMention,
    formattedText,
  ].filter(Boolean).join('\n\n');
}

function buildComputerBatchResultText(
  result: ToolExecutionResult | undefined,
  actionCount: number,
): string {
  const timings = result?.debug?.actionTimings ?? [];
  const completedCount = timings.filter((timing) => timing.status === 'completed').length;
  const failed = timings.filter((timing) => timing.status === 'failed');
  const skipped = timings.filter((timing) => timing.status === 'skipped');
  const lines = [
    'computer_batch execution result',
    `requested_actions: ${actionCount}`,
    `completed_actions: ${timings.length > 0 ? completedCount : 'unknown'}`,
    `failed_actions: ${failed.length}`,
    `skipped_actions: ${skipped.length}`,
  ];

  if (typeof result?.debug?.durationMs === 'number') {
    lines.push(`duration_ms: ${Math.round(result.debug.durationMs)}`);
  }

  if (timings.length > 0) {
    lines.push('<action_timings>');
    for (const timing of timings) {
      lines.push([
        `seq=${timing.seq}`,
        `tool=${timing.tool}`,
        `status=${timing.status}`,
        `duration_ms=${Math.round(timing.durationMs)}`,
        timing.error ? `error=${JSON.stringify(timing.error)}` : null,
      ].filter(Boolean).join(' '));
    }
    lines.push('</action_timings>');
  }

  if (result?.kind === 'text' && result.text.trim()) {
    lines.push(`executor_text: ${result.text.trim()}`);
  } else if (result?.kind === 'structured-screen') {
    lines.push(`executor_refreshed_element_count: ${result.snapshot.elements.length}`);
  } else if (result?.kind === 'image') {
    lines.push(`executor_screenshot_id: ${result.screenshotId}`);
  }

  if (failed.length === 0) {
    lines.push('All approved computer_batch actions completed without executor errors.');
    lines.push('If this batch included the final requested Save, Submit, Send, Create, or Continue action and the touched-window diff shows no visible validation error or incorrect field, call overlay_complete next instead of searching outside the granted square.');
  }

  return lines.join('\n');
}

function overlayError(message: string) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function requireAgentId(context?: BuiltinToolContext): string {
  if (!context?.agentId) {
    throw new Error('Overlay tools require an Interpreter Overlay agent session.');
  }
  return context.agentId;
}

function requiredFiniteNumber(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}.${key} must be a finite number.`);
  }
  return value;
}

function parseOverlayDrawingAnnotations(args: Record<string, unknown>): OverlayDrawingAnnotation[] {
  if (!Array.isArray(args.annotations) || args.annotations.length === 0) {
    throw new Error('overlay_show_drawings requires a non-empty annotations array.');
  }

  return args.annotations.map((annotation, index) => {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) {
      throw new Error(`overlay_show_drawings annotations[${index}] must be an object.`);
    }
    const record = annotation as Record<string, unknown>;
    const label = `overlay_show_drawings annotations[${index}]`;
    const parsed: OverlayDrawingAnnotation = {
      bounds: {
        x: requiredFiniteNumber(record, 'x', label),
        y: requiredFiniteNumber(record, 'y', label),
        width: requiredFiniteNumber(record, 'width', label),
        height: requiredFiniteNumber(record, 'height', label),
      },
    };
    if (parsed.bounds.width <= 0 || parsed.bounds.height <= 0) {
      throw new Error(`${label}.width and ${label}.height must be greater than zero.`);
    }
    if (record.id !== undefined) {
      if (typeof record.id !== 'string' || !record.id.trim()) {
        throw new Error(`${label}.id must be a non-empty string.`);
      }
      parsed.id = record.id.trim();
    }
    if (record.label !== undefined) {
      if (typeof record.label !== 'string' || !record.label.trim()) {
        throw new Error(`${label}.label must be a non-empty string.`);
      }
      parsed.label = record.label.trim();
    }
    return parsed;
  });
}

export const overlayReadContextTool: BuiltinToolDefinition = {
  name: 'overlay_read_context',
  description: `Refresh the granted Interpreter Overlay square and return the latest saved screenshot file reference, plus structured accessibility text when available.

Use this after the underlying app changes, after you click/type/scroll, or before choosing an element_id to interact with.`,
  inputSchema: {
    type: 'object',
    properties: {},
  },
  annotations: {
    readOnlyHint: true,
  },
  handler: async (_args, context) => {
    try {
      const agentId = requireAgentId(context);
      const latestContext = await overlaySessionManager.readContext(agentId);
      return {
        content: [
          { type: 'text', text: buildContextText(latestContext) },
        ],
      };
    } catch (error) {
      return overlayError(error instanceof Error ? error.message : String(error));
    }
  },
};

export const overlayScreenshotTool: BuiltinToolDefinition = {
  name: 'overlay_screenshot',
  description: 'Capture a fresh screenshot of the granted Interpreter Overlay square without performing any interaction, and return its saved file reference.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    try {
      const agentId = requireAgentId(context);
      const latestContext = await overlaySessionManager.screenshot(agentId);
      const screenshotMention = buildScreenshotFileMention(latestContext);
      return {
        content: [
          {
            type: 'text',
            text: [
              'Captured a fresh screenshot of the granted square.',
              `Bounds: ${formatBounds(latestContext.captureBoundsDIP ?? latestContext.displayBoundsDIP ?? null)}`,
              screenshotMention ?? 'Screenshot file unavailable.',
            ].join('\n\n'),
          },
        ],
      };
    } catch (error) {
      return overlayError(error instanceof Error ? error.message : String(error));
    }
  },
};

export const overlayComputerBatchTool: BuiltinToolDefinition = {
  name: 'computer_batch',
  description: `Run one ordered batch through the unified Interpreter tool layer.

The complete batch is validated before its first action runs. A normal Interpreter action is { seq, server_id, tool_name, arguments } and enforces that tool's scoped permissions through ToolManager. A selected-target action is { seq, tool }, where tool is { name, params } and name is click, type, hotkey, or scroll; selected-target actions stage in the visible overlay review UI and execute only after review.
Use selected-target actions for stable multi-step interactions inside the granted square, such as filling several visible fields in one pass before a reread.
The type action means keyboard text entry and may omit target fields when the correct control is already focused.
The result is per-action outcomes plus the before/after DIFF of the windows the batch touched - changes only. For full current state, call overlay_read_context.`,
  inputSchema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              properties: {
                seq: { type: 'number' },
                server_id: {
                  type: 'string',
                  description: 'Exact realtime-compatible Interpreter builtin server id.',
                },
                tool_name: {
                  type: 'string',
                  description: 'Exact realtime-compatible Interpreter builtin tool name.',
                },
                arguments: {
                  type: 'object',
                  description: 'Arguments matching the selected builtin tool input schema.',
                  additionalProperties: true,
                },
              },
              required: ['seq', 'server_id', 'tool_name', 'arguments'],
            },
            {
              type: 'object',
              properties: {
                seq: { type: 'number' },
                tool: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', enum: ['click'] },
                    params: {
                      type: 'object',
                      properties: {
                        element_id: { type: 'string' },
                        element_description: { type: 'string' },
                        x: { type: 'number' },
                        y: { type: 'number' },
                      },
                    },
                  },
                  required: ['name', 'params'],
                },
              },
              required: ['seq', 'tool'],
            },
            {
              type: 'object',
              properties: {
                seq: { type: 'number' },
                tool: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', enum: ['type'] },
                    params: {
                      type: 'object',
                      properties: {
                        element_id: { type: 'string' },
                        element_description: { type: 'string' },
                        x: { type: 'number' },
                        y: { type: 'number' },
                        text: { type: 'string' },
                        clear_first: {
                          type: 'boolean',
                          description: 'Set true when replacing or setting the final value of a text field. Do not emulate replacement with separate click, cmd+a, Backspace/Delete, or targetless type actions.',
                        },
                      },
                      required: ['text'],
                    },
                  },
                  required: ['name', 'params'],
                },
              },
              required: ['seq', 'tool'],
            },
            {
              type: 'object',
              properties: {
                seq: { type: 'number' },
                tool: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', enum: ['hotkey'] },
                    params: {
                      type: 'object',
                      properties: {
                        hotkey: {
                          type: 'string',
                          description: 'Shortcut string such as Enter, Escape, Tab, ArrowLeft, cmd+c, or cmd+v. The property name is hotkey, not key.',
                        },
                      },
                      required: ['hotkey'],
                    },
                  },
                  required: ['name', 'params'],
                },
              },
              required: ['seq', 'tool'],
            },
            {
              type: 'object',
              properties: {
                seq: { type: 'number' },
                tool: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', enum: ['scroll'] },
                    params: {
                      type: 'object',
                      properties: {
                        element_id: { type: 'string' },
                        element_description: { type: 'string' },
                        x: { type: 'number' },
                        y: { type: 'number' },
                        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
                        amount: { type: 'number' },
                      },
                      required: ['direction'],
                    },
                  },
                  required: ['name', 'params'],
                },
              },
              required: ['seq', 'tool'],
            },
          ],
        },
      },
    },
    required: ['actions'],
  },
  handler: async (args, context) => {
    try {
      const agentId = requireAgentId(context);
      const [
        { getBuiltinToolHandlerIncludingHidden },
        { callTool: callInterpreterTool },
      ] = await Promise.all([
        import('../../builtinTools'),
        import('../../../handlers/toolServers'),
      ]);
      const resultText = await executeUnifiedComputerBatchToolCall({
        argumentsJson: JSON.stringify(args),
        getBuiltinTool: getBuiltinToolHandlerIncludingHidden,
        callTool: async (serverId, toolName, toolArgs) => await callInterpreterTool(
          serverId,
          toolName,
          toolArgs,
          false,
          {
            callerTabId: context?.callerTabId ?? agentId,
            workspace: context?.workspace,
            modelConfig: context?.modelConfig,
          },
          { includeHiddenBuiltins: true },
        ),
        callSelectedTargetBatch: async (params) => {
          const batchOutcome = await overlaySessionManager.computerBatch(agentId, params);
          return {
            content: [{
              type: 'text',
              text: [
                buildComputerBatchResultText(batchOutcome.result, params.actions.length),
                formatTouchedWindowDiff(batchOutcome.touchedWindowDiff),
              ].join('\n\n'),
            }],
          };
        },
      });
      return {
        content: [
          {
            type: 'text',
            text: resultText,
          },
        ],
      };
    } catch (error) {
      return overlayError(error instanceof Error ? error.message : String(error));
    }
  },
};

export const overlayShowDrawingsTool: BuiltinToolDefinition = {
  name: 'overlay_show_drawings',
  description: `Show visual-only rectangle annotations inside the granted Interpreter Overlay square.

This replaces any previous overlay drawings. Coordinates are screen DIP coordinates, matching bounds returned by overlay_read_context. This tool only draws; it must not click, type, read, retry, or execute user-level actions.`,
  inputSchema: {
    type: 'object',
    properties: {
      annotations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
        },
      },
    },
    required: ['annotations'],
  },
  handler: async (args, context) => {
    try {
      const agentId = requireAgentId(context);
      const annotations = parseOverlayDrawingAnnotations(args);
      await overlaySessionManager.showDrawings(agentId, { annotations });
      return {
        content: [{
          type: 'text',
          text: `Showing ${annotations.length} overlay drawing${annotations.length === 1 ? '' : 's'}.`,
        }],
      };
    } catch (error) {
      return overlayError(error instanceof Error ? error.message : String(error));
    }
  },
};

export const overlayClearDrawingsTool: BuiltinToolDefinition = {
  name: 'overlay_clear_drawings',
  description: 'Clear visual-only drawings from the granted Interpreter Overlay square without reading or interacting with the underlying app.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    try {
      const agentId = requireAgentId(context);
      await overlaySessionManager.clearDrawings(agentId);
      return {
        content: [{ type: 'text', text: 'Cleared overlay drawings.' }],
      };
    } catch (error) {
      return overlayError(error instanceof Error ? error.message : String(error));
    }
  },
};

export const overlayClickTool: BuiltinToolDefinition = {
  name: 'overlay_click',
  description: `Click inside the granted Interpreter Overlay square.

Prefer element_id from overlay_read_context. You may also use element_description or normalized x/y coordinates between 0 and 1 inside the granted square.`,
  inputSchema: {
    type: 'object',
    properties: {
      element_id: { type: 'string' },
      element_description: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
    },
  },
  handler: async (args, context) => {
    try {
      const agentId = requireAgentId(context);
      await overlaySessionManager.click(agentId, {
        element_id: typeof args.element_id === 'string' ? args.element_id : undefined,
        element_description: typeof args.element_description === 'string' ? args.element_description : undefined,
        x: typeof args.x === 'number' ? args.x : undefined,
        y: typeof args.y === 'number' ? args.y : undefined,
      });
      return {
        content: [{
          type: 'text',
          text: 'Clicked inside the granted square.',
        }],
      };
    } catch (error) {
      return overlayError(error instanceof Error ? error.message : String(error));
    }
  },
};

export const overlayTypeTool: BuiltinToolDefinition = {
  name: 'overlay_type',
  description: `Type into the granted Interpreter Overlay square.

If you provide element_id or element_description, the overlay will focus that target first. If you omit both, it types into the currently focused control inside the granted square.`,
  inputSchema: {
    type: 'object',
    properties: {
      element_id: { type: 'string' },
      element_description: { type: 'string' },
      text: { type: 'string' },
      clear_first: { type: 'boolean' },
    },
    required: ['text'],
  },
  handler: async (args, context) => {
    try {
      const agentId = requireAgentId(context);
      await overlaySessionManager.type(agentId, {
        element_id: typeof args.element_id === 'string' ? args.element_id : undefined,
        element_description: typeof args.element_description === 'string' ? args.element_description : undefined,
        text: typeof args.text === 'string' ? args.text : '',
        clear_first: args.clear_first === true,
      });
      return {
        content: [{
          type: 'text',
          text: 'Typed inside the granted square.',
        }],
      };
    } catch (error) {
      return overlayError(error instanceof Error ? error.message : String(error));
    }
  },
};

export const overlayHotkeyTool: BuiltinToolDefinition = {
  name: 'overlay_hotkey',
  description: 'Press a hotkey against the app inside the granted Interpreter Overlay square.',
  inputSchema: {
    type: 'object',
    properties: {
      hotkey: { type: 'string' },
    },
    required: ['hotkey'],
  },
  handler: async (args, context) => {
    try {
      const agentId = requireAgentId(context);
      await overlaySessionManager.hotkey(agentId, {
        hotkey: typeof args.hotkey === 'string' ? args.hotkey : '',
      });
      return {
        content: [{
          type: 'text',
          text: `Pressed hotkey "${args.hotkey}".`,
        }],
      };
    } catch (error) {
      return overlayError(error instanceof Error ? error.message : String(error));
    }
  },
};

export const overlayScrollTool: BuiltinToolDefinition = {
  name: 'overlay_scroll',
  description: `Scroll inside the granted Interpreter Overlay square.

Prefer element_id from overlay_read_context. You may also use element_description or normalized x/y coordinates between 0 and 1 inside the granted square.`,
  inputSchema: {
    type: 'object',
    properties: {
      element_id: { type: 'string' },
      element_description: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'number' },
    },
    required: ['direction'],
  },
  handler: async (args, context) => {
    try {
      const agentId = requireAgentId(context);
      await overlaySessionManager.scroll(agentId, {
        element_id: typeof args.element_id === 'string' ? args.element_id : undefined,
        element_description: typeof args.element_description === 'string' ? args.element_description : undefined,
        x: typeof args.x === 'number' ? args.x : undefined,
        y: typeof args.y === 'number' ? args.y : undefined,
        direction: args.direction,
        amount: typeof args.amount === 'number' ? args.amount : undefined,
      });
      return {
        content: [{
          type: 'text',
          text: `Scrolled ${args.direction} inside the granted square.`,
        }],
      };
    } catch (error) {
      return overlayError(error instanceof Error ? error.message : String(error));
    }
  },
};

export const overlayDetachTool: BuiltinToolDefinition = {
  name: 'overlay_detach',
  description: `Release the granted Interpreter Overlay square and remove the on-screen overlay box.

This is terminal for the live overlay session. After detaching, you no longer have live inspection or control of that granted square.
Do not use this until the live UI work in the square is actually finished, unless you intentionally plan to continue without any more live overlay control.
For fill/submit tasks, do not detach before the final visible Save/Submit/Send/Create/Continue action has succeeded.`,
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    try {
      const agentId = requireAgentId(context);
      await overlaySessionManager.detach(agentId);
      return {
        content: [{ type: 'text', text: 'Detached from the granted Interpreter Overlay square.' }],
      };
    } catch (error) {
      return overlayError(error instanceof Error ? error.message : String(error));
    }
  },
};

export const overlayCompleteTool: BuiltinToolDefinition = {
  name: 'overlay_complete',
  description: `Mark the live Interpreter Overlay session complete and close the on-screen overlay box.

This is terminal for the live overlay session. After completion, you no longer have live inspection or control of that granted square.
Use this only once the requested live UI work in the square is fully complete.
For fill/submit tasks, do not complete the session before the final visible Save/Submit/Send/Create/Continue action has succeeded.`,
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    try {
      const agentId = requireAgentId(context);
      await overlaySessionManager.complete(agentId);
      return {
        content: [{ type: 'text', text: 'Completed the granted Interpreter Overlay session.' }],
      };
    } catch (error) {
      return overlayError(error instanceof Error ? error.message : String(error));
    }
  },
};
