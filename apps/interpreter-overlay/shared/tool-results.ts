import { createTwoFilesPatch } from 'diff';

export interface OverlayScreenElement {
  id: string;
  role: string;
  label: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  groupLabel?: string;
  option?: string;
}

export interface StructuredScreenSnapshot {
  formattedText: string;
  elements: OverlayScreenElement[];
  focusedMenuElementId: string | null;
}

export interface ToolExecutionActionTiming {
  seq: number;
  tool: string;
  durationMs: number;
  status: 'completed' | 'failed' | 'skipped';
  error?: string;
}

export interface ToolExecutionDebugInfo {
  durationMs?: number;
  actionTimings?: ToolExecutionActionTiming[];
}

export type ToolExecutionResult =
  | { kind: 'text'; text: string; isError?: boolean; debug?: ToolExecutionDebugInfo }
  | { kind: 'structured-screen'; snapshot: StructuredScreenSnapshot; debug?: ToolExecutionDebugInfo }
  | {
      kind: 'image';
      screenshotId: string;
      screenshotBase64?: string;
      debug?: ToolExecutionDebugInfo;
    };

export function textToolResult(text: string): ToolExecutionResult {
  return { kind: 'text', text };
}

/**
 * A staged batch action that was rejected by validation before anything
 * executed. Marked as an error so bridge layers report an explicit invalid
 * status instead of a completed batch with no observed change.
 */
export function invalidActionToolResult(text: string): ToolExecutionResult {
  return { kind: 'text', text, isError: true };
}

/**
 * Typed rejection for a reviewed batch whose staged actions failed validation
 * before execution. Bridge result mapping uses this to return an explicit
 * invalid-action status to the controller model.
 */
export class OverlayInvalidBatchActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverlayInvalidBatchActionError';
  }
}

/**
 * Fatal rejection raised when the committed selected-target window no longer
 * exists (closed or off screen). The run must fail loudly with this message —
 * never retry, never hand the dead target to another agent.
 */
export class OverlayTargetWindowClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverlayTargetWindowClosedError';
  }
}

export function isGenericActionResult(resultText: string | undefined): boolean {
  if (!resultText) {
    return false;
  }

  return (
    resultText === 'success'
    || resultText === 'Action completed successfully'
    || resultText === 'No actions completed'
  );
}

export function shouldStopBatchAfterActionResult(resultText: string | undefined): boolean {
  if (!resultText) {
    return false;
  }

  return !isGenericActionResult(resultText);
}

export function buildCombinedToolResult(
  results: string[],
  _stoppedAtIndex: number,
  _actionCount: number,
): string {
  const meaningfulResults = results.filter((resultText) =>
    resultText
    && !resultText.includes('Action completed successfully')
    && !resultText.includes('Successfully')
    && resultText !== 'success',
  );

  let combinedResult: string;
  if (meaningfulResults.length > 0) {
    combinedResult = meaningfulResults.join('\n\n');
  } else if (results.length > 0) {
    combinedResult = 'success';
  } else {
    combinedResult = 'No actions completed';
  }

  return combinedResult;
}

export function buildStructuredTextRefreshResult(
  previousSnapshot: StructuredScreenSnapshot | null,
  nextSnapshot: StructuredScreenSnapshot,
): string {
  const previousText = normalizeSnapshotText(previousSnapshot?.formattedText ?? '');
  const nextText = normalizeSnapshotText(nextSnapshot.formattedText);
  const patch = createTwoFilesPatch(
    'previous',
    'current',
    previousText,
    nextText,
    '',
    '',
    { context: 3 },
  );
  return stripPatchDivider(patch);
}

export function buildStructuredTextQueryResult(snapshot: StructuredScreenSnapshot): string {
  return snapshot.formattedText;
}

function normalizeSnapshotText(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function stripPatchDivider(patch: string): string {
  const lines = patch.split('\n');
  if (lines[0] === '===================================================================') {
    return lines.slice(1).join('\n').trimEnd();
  }
  return patch.trimEnd();
}
