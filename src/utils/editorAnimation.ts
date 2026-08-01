/**
 * In-editor diff animation utility.
 *
 * Drives a TipTap editor through a small number of content updates to
 * animate the transition from the current document to a new version on disk.
 *
 * Design goals:
 *   - Total animation ≤ 2 seconds.
 *   - Minimal setContent calls (each causes a full re-render) to avoid flicker.
 *   - Deletions: show all deleted text in red, pause, then remove it (2 calls).
 *   - Additions: progressively add content in chunks with the newest chunk in
 *     orange text, then settle (5–12 calls).
 */

import * as Diff from 'diff';
import { markdownToTiptap, type TiptapNode } from './markdown-parser';

// ── Timing ──────────────────────────────────────────────────────────────────

/** How long deleted text stays visible in red before being removed */
const DELETION_DISPLAY_MS = 400;
/** Total time budget for the addition phase */
const ADDITION_BUDGET_MS = 1500;
/** Minimum time per addition step (keeps things visible) */
const ADDITION_STEP_MIN_MS = 80;
/** Maximum number of addition steps (caps setContent calls) */
const MAX_ADDITION_STEPS = 12;

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── TipTap JSON helpers ─────────────────────────────────────────────────────

/**
 * Deep-clone a tiptap node tree, adding the animationHighlight mark
 * (with the given color) to every text leaf node.
 */
function colorizeNode(node: TiptapNode, color: 'red' | 'orange'): TiptapNode {
  if (node.type === 'text') {
    const mark = { type: 'animationHighlight', attrs: { color } };
    return { ...node, marks: [...(node.marks || []), mark] };
  }
  if (node.content) {
    return { ...node, content: node.content.map(c => colorizeNode(c, color)) };
  }
  return { ...node };
}

// ── Diff at the TipTap-node level ───────────────────────────────────────────

interface InsertionEntry {
  node: TiptapNode;
  /** Index in afterDeletions after which this node is inserted; -1 = before all */
  insertAfterUnchangedIndex: number;
}

interface NodeDiff {
  /** Nodes to display as the "current" state, with deletions colored red */
  withDeletionsRed: TiptapNode[];
  /** Nodes after deletions have been removed */
  afterDeletions: TiptapNode[];
  /** Nodes that are newly added (in insertion order) */
  addedNodes: TiptapNode[];
  /** Pre-computed insertion plan for additions */
  insertionPlan: InsertionEntry[];
  /** The final complete node list (= target) */
  finalNodes: TiptapNode[];
}

/**
 * Diff two tiptap documents at the top-level node granularity.
 * Uses serialised comparison via Diff.diffArrays.
 */
function diffNodes(currentMd: string, targetMd: string): NodeDiff {
  const currentDoc = markdownToTiptap(currentMd);
  const targetDoc = markdownToTiptap(targetMd);

  const currentNodes = currentDoc.content;
  const targetNodes = targetDoc.content;

  // Serialise each node so we can use diffArrays
  const serialiseCurrent = currentNodes.map(n => JSON.stringify(n));
  const serialiseTarget = targetNodes.map(n => JSON.stringify(n));

  const changes = Diff.diffArrays(serialiseCurrent, serialiseTarget);

  // Build: current doc with deleted nodes colored red
  const withDeletionsRed: TiptapNode[] = [];
  // Build: current doc with deleted nodes removed
  const afterDeletions: TiptapNode[] = [];
  // Collect: added nodes in order
  const addedNodes: TiptapNode[] = [];
  // Pre-computed insertion plan
  const insertionPlan: InsertionEntry[] = [];

  let currentIdx = 0;
  let targetIdx = 0;
  let unchangedCount = 0;

  for (const change of changes) {
    const count = change.value.length;

    if (change.removed) {
      // These nodes exist in current but not target — color them red
      for (let i = 0; i < count; i++) {
        withDeletionsRed.push(colorizeNode(currentNodes[currentIdx + i], 'red'));
      }
      // They don't appear in afterDeletions
      currentIdx += count;
    } else if (change.added) {
      // These nodes exist in target but not current — they're additions
      for (let i = 0; i < count; i++) {
        const node = targetNodes[targetIdx + i];
        addedNodes.push(node);
        insertionPlan.push({
          node,
          insertAfterUnchangedIndex: unchangedCount - 1,
        });
      }
      targetIdx += count;
    } else {
      // Unchanged nodes
      for (let i = 0; i < count; i++) {
        withDeletionsRed.push(currentNodes[currentIdx + i]);
        afterDeletions.push(currentNodes[currentIdx + i]);
        unchangedCount++;
      }
      currentIdx += count;
      targetIdx += count;
    }
  }

  return {
    withDeletionsRed,
    afterDeletions,
    addedNodes,
    insertionPlan,
    finalNodes: targetNodes,
  };
}

/**
 * Build a tiptap doc from afterDeletions + a subset of the pre-computed
 * insertion plan.  The most-recently-added chunk is colored orange.
 *
 * Uses the insertion plan computed once in diffNodes instead of
 * re-parsing markdown and re-diffing on every step.
 */
function buildAdditionStepFromPlan(
  afterDeletions: TiptapNode[],
  insertionPlan: InsertionEntry[],
  addedSoFar: number,
  newChunkSize: number,
): { type: 'doc'; content: TiptapNode[] } {
  const limit = addedSoFar + newChunkSize;
  const entriesToInclude = insertionPlan.slice(0, limit);

  // Group entries by their insertion position
  const groups = new Map<number, { entry: InsertionEntry; idx: number }[]>();
  for (let i = 0; i < entriesToInclude.length; i++) {
    const entry = entriesToInclude[i];
    const key = entry.insertAfterUnchangedIndex;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ entry, idx: i });
  }

  const result: TiptapNode[] = [];

  // Insert any additions that go before all unchanged nodes (index = -1)
  const beforeAll = groups.get(-1);
  if (beforeAll) {
    for (const { entry, idx } of beforeAll) {
      const isNewChunk = idx >= addedSoFar;
      result.push(isNewChunk ? colorizeNode(entry.node, 'orange') : entry.node);
    }
  }

  // Walk through afterDeletions, inserting grouped additions after each unchanged node
  for (let i = 0; i < afterDeletions.length; i++) {
    result.push(afterDeletions[i]);
    const group = groups.get(i);
    if (group) {
      for (const { entry, idx } of group) {
        const isNewChunk = idx >= addedSoFar;
        result.push(isNewChunk ? colorizeNode(entry.node, 'orange') : entry.node);
      }
    }
  }

  return { type: 'doc', content: result };
}

// ── Main animation runner ───────────────────────────────────────────────────

export interface AnimationCallbacks {
  setContentJSON: (json: Record<string, unknown>) => void;
  setEditable: (editable: boolean) => void;
  isCancelled: () => boolean;
}

/**
 * Run the in-editor diff animation.
 *
 * Total time budget: ≤ 2 seconds.  Minimises setContent calls to avoid flicker.
 *
 * Phase 1 — Deletions (2 setContent calls):
 *   1. Show current doc with all deleted nodes in red text.
 *   2. After a pause, show doc with deleted nodes removed.
 *
 * Phase 2 — Additions (5–12 setContent calls):
 *   Progressively add nodes in chunks.  The newest chunk is orange text.
 *   Each step replaces the previous orange with black and adds the next chunk
 *   in orange.
 */
export async function runEditorAnimation(
  currentMarkdown: string,
  targetMarkdown: string,
  callbacks: AnimationCallbacks,
): Promise<void> {
  const { setContentJSON, isCancelled } = callbacks;

  const nodeDiff = diffNodes(currentMarkdown, targetMarkdown);
  const hasDeletions = nodeDiff.withDeletionsRed.length !== nodeDiff.afterDeletions.length;
  const hasAdditions = nodeDiff.addedNodes.length > 0;

  // ── Phase 1: Deletions ──────────────────────────────────────────────────
  if (hasDeletions) {
    // Show everything with deletions in red
    setContentJSON({ type: 'doc', content: nodeDiff.withDeletionsRed });
    await wait(DELETION_DISPLAY_MS);
    if (isCancelled()) return;

    // Remove the deleted nodes
    if (hasAdditions) {
      // Just show afterDeletions (additions come next)
      setContentJSON({ type: 'doc', content: nodeDiff.afterDeletions });
      await wait(100); // brief beat before additions start
      if (isCancelled()) return;
    }
    // If no additions, we'll set final content below
  }

  // ── Phase 2: Additions ──────────────────────────────────────────────────
  if (hasAdditions) {
    const totalToAdd = nodeDiff.addedNodes.length;

    // Calculate step count: aim to use the time budget with reasonable chunks
    const stepCount = Math.min(
      totalToAdd,
      MAX_ADDITION_STEPS,
      Math.max(1, Math.floor(ADDITION_BUDGET_MS / ADDITION_STEP_MIN_MS))
    );
    const stepDelay = Math.max(ADDITION_STEP_MIN_MS, Math.floor(ADDITION_BUDGET_MS / stepCount));

    let addedSoFar = 0;

    for (let step = 0; step < stepCount; step++) {
      if (isCancelled()) return;

      // Calculate how many nodes to add in this chunk
      const remaining = totalToAdd - addedSoFar;
      const remainingSteps = stepCount - step;
      const chunkSize = Math.ceil(remaining / remainingSteps);

      const doc = buildAdditionStepFromPlan(
        nodeDiff.afterDeletions,
        nodeDiff.insertionPlan,
        addedSoFar,
        chunkSize,
      );
      setContentJSON(doc);

      addedSoFar += chunkSize;

      if (step < stepCount - 1) {
        await wait(stepDelay);
      }
    }

    if (isCancelled()) return;
    // Brief pause showing last chunk in orange before settling
    await wait(Math.min(stepDelay, 150));
  }

  // ── Final: set exact target content (no marks) ──────────────────────────
  if (isCancelled()) return;
  setContentJSON({ type: 'doc', content: nodeDiff.finalNodes });
}
