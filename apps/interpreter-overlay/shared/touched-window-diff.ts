/**
 * Touched-window DIFF for computer_batch results.
 *
 * The batch result contract (2026-07-06) is per-action outcomes plus, for CUA
 * actions, the before/after DIFF of each window the batch touched - changes
 * only, never a full context dump. This module diffs the observed formatted
 * accessibility text of the captured target scope between the last observed
 * pre-batch state and the observed post-batch state. It is raw and honest:
 * observed lines only, no inferred meaning, no label backfilling. Full current
 * state requires an explicit read tool call (overlay_read_context).
 */

export interface TouchedWindowDiffWindow {
  window: string;
  status: 'changed' | 'appeared' | 'removed';
  removedLines: string[];
  addedLines: string[];
}

export interface TouchedWindowDiff {
  changed: boolean;
  windows: TouchedWindowDiffWindow[];
}

/**
 * One observed capture of the touched target scope: the formatted
 * accessibility text plus, when a selected target is attached, the observed
 * selected-context ref lines (id/role/raw label, which carries observed
 * values). Both streams are raw observations; the diff covers each.
 */
export interface TouchedWindowObservation {
  formattedText: string;
  selectableRefLines?: string[];
}

interface WindowBlock {
  key: string;
  lines: string[];
}

const OUTSIDE_WINDOWS_KEY = '(outside window blocks)';
const SELECTED_TARGET_REFS_KEY = '(selected target refs)';

/**
 * Split formatted accessibility text into top-level `<window ...>` blocks.
 * Lines outside any window block collect under a single synthetic key so
 * captures without window tags still diff.
 */
function splitWindowBlocks(formattedText: string): WindowBlock[] {
  const blocks: WindowBlock[] = [];
  const keyCounts = new Map<string, number>();
  let current: WindowBlock | null = null;
  let outside: WindowBlock | null = null;
  let depth = 0;

  for (const line of formattedText.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const isWindowOpenLine = /^\s*<window[\s/>]/.test(line);
    const isSelfClosedWindowLine = isWindowOpenLine && /\/>\s*$/.test(line);
    if (current === null && isWindowOpenLine) {
      const baseKey = line.trim();
      const seen = keyCounts.get(baseKey) ?? 0;
      keyCounts.set(baseKey, seen + 1);
      const block = {
        key: seen === 0 ? baseKey : `${baseKey} (#${seen + 1})`,
        lines: [],
      };
      if (isSelfClosedWindowLine) {
        blocks.push(block);
        continue;
      }
      current = block;
      depth = 1;
      continue;
    }
    if (current !== null) {
      if (isWindowOpenLine && !isSelfClosedWindowLine) {
        depth += 1;
      } else if (/^\s*<\/window>/.test(line)) {
        depth -= 1;
        if (depth === 0) {
          blocks.push(current);
          current = null;
          continue;
        }
      }
      current.lines.push(line);
      continue;
    }
    if (!outside) {
      outside = { key: OUTSIDE_WINDOWS_KEY, lines: [] };
      blocks.push(outside);
    }
    outside.lines.push(line);
  }
  if (current !== null) {
    blocks.push(current);
  }
  return blocks;
}

/**
 * Unique lines observed in `left` but not in `right`, preserving
 * first-appearance order. Duplicate identical lines collapse: the diff is a
 * change report, not a full-state mirror.
 */
function subtractLines(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of left) {
    if (!rightSet.has(line) && !seen.has(line)) {
      seen.add(line);
      result.push(line);
    }
  }
  return result;
}

function toWindowBlocks(observation: TouchedWindowObservation): WindowBlock[] {
  const blocks = splitWindowBlocks(observation.formattedText);
  if (observation.selectableRefLines && observation.selectableRefLines.length > 0) {
    blocks.push({
      key: SELECTED_TARGET_REFS_KEY,
      lines: observation.selectableRefLines,
    });
  }
  return blocks;
}

export function diffTouchedWindows(
  before: TouchedWindowObservation,
  after: TouchedWindowObservation,
): TouchedWindowDiff {
  const beforeBlocks = toWindowBlocks(before);
  const afterBlocks = toWindowBlocks(after);
  const beforeByKey = new Map(beforeBlocks.map((block) => [block.key, block]));
  const afterByKey = new Map(afterBlocks.map((block) => [block.key, block]));
  const windows: TouchedWindowDiffWindow[] = [];

  for (const block of beforeBlocks) {
    if (!afterByKey.has(block.key)) {
      windows.push({
        window: block.key,
        status: 'removed',
        removedLines: block.lines,
        addedLines: [],
      });
    }
  }
  for (const block of afterBlocks) {
    const before = beforeByKey.get(block.key);
    if (!before) {
      windows.push({
        window: block.key,
        status: 'appeared',
        removedLines: [],
        addedLines: block.lines,
      });
      continue;
    }
    const removedLines = subtractLines(before.lines, block.lines);
    const addedLines = subtractLines(block.lines, before.lines);
    if (removedLines.length > 0 || addedLines.length > 0) {
      windows.push({
        window: block.key,
        status: 'changed',
        removedLines,
        addedLines,
      });
    }
  }

  return { changed: windows.length > 0, windows };
}

/**
 * Model-facing text for the touched-window diff. Changes only; full state
 * requires an explicit overlay_read_context call.
 */
export function formatTouchedWindowDiff(diff: TouchedWindowDiff): string {
  const lines = [
    '<touched_window_diff>',
    'Observed before/after change of the windows this batch touched. Lines starting with "- " were observed before the batch and are no longer observed; lines starting with "+ " are newly observed. Unchanged windows and unchanged lines are omitted. This is the only post-batch state in this result; for full current state, call overlay_read_context.',
  ];
  if (!diff.changed) {
    lines.push('no_observed_change: the observed window text is identical before and after this batch.');
  }
  for (const window of diff.windows) {
    lines.push(`<window_diff window=${JSON.stringify(window.window)} status="${window.status}">`);
    for (const removed of window.removedLines) {
      lines.push(`- ${removed.trim()}`);
    }
    for (const added of window.addedLines) {
      lines.push(`+ ${added.trim()}`);
    }
    lines.push('</window_diff>');
  }
  lines.push('</touched_window_diff>');
  return lines.join('\n');
}
