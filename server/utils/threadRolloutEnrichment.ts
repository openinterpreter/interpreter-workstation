import { randomUUID } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import type { v2 } from '../handlers/codex-generated-types/index';

/** Bytes read per step while walking a saved history backwards. */
export const ROLLOUT_TAIL_CHUNK_BYTES = 64 * 1024;
/** Most bytes one enrichment may read from the end of a saved history. */
export const ROLLOUT_TAIL_BYTE_BUDGET = 32 * 1024 * 1024;

const NEWLINE = 0x0a;

interface RolloutResponseItem {
  type: 'response_item';
  payload: {
    type: string;
    role?: string;
    call_id?: string;
    name?: string;
    input?: string;
    summary?: Array<{ type: string; text: string }>;
    content?: Array<{ type: string; text: string }>;
  };
}

type EnrichedThreadItem = v2.ThreadItem & {
  sourceInput?: string;
  sourceToolName?: string;
};

export type RolloutEnrichmentStatus =
  /** Every turn that could use the saved history was read and enriched. */
  | 'enriched'
  /** No turn could gain anything, so the file was not opened. */
  | 'skipped'
  /** The byte budget ran out before the needed turns were reached. */
  | 'budget'
  /** No path, a missing or unreadable file, or another read failure. */
  | 'unavailable';

export type RolloutEnrichmentResult = {
  thread: v2.Thread;
  status: RolloutEnrichmentStatus;
  bytesRead: number;
  fileSize: number;
};

export type RolloutEnrichmentOptions = {
  byteBudget?: number;
  chunkBytes?: number;
  /** When the budget runs out, still enrich the newest turns whose saved
   * lines were read completely instead of returning the turns unchanged. */
  partial?: boolean;
};

function turnCanBeEnriched(turn: v2.Turn): boolean {
  // Tool source applies to command items; restored reasoning applies only to
  // turns saved without native reasoning.
  return turn.items.some((item) => item.type === 'commandExecution')
    || !turn.items.some((item) => item.type === 'reasoning');
}

/**
 * Restore saved tool source and older reasoning for the given turns by
 * reading the saved history backwards from its end, never the whole file.
 *
 * Reading stops once the earliest saved line of the oldest needed turn has
 * been passed, or when the byte budget is spent. Any failure, and an
 * exhausted budget (unless `partial`), returns the turns unchanged.
 */
export async function enrichThreadTurnsFromRollout(
  thread: v2.Thread,
  options: RolloutEnrichmentOptions = {},
): Promise<RolloutEnrichmentResult> {
  const unchanged = (status: RolloutEnrichmentStatus, bytesRead = 0, fileSize = 0): RolloutEnrichmentResult => (
    { thread, status, bytesRead, fileSize }
  );
  const targetIds = new Set(
    thread.turns.filter(turnCanBeEnriched).map((turn) => turn.id),
  );
  if (targetIds.size === 0) return unchanged('skipped');
  if (!thread.path) return unchanged('unavailable');

  const byteBudget = options.byteBudget ?? ROLLOUT_TAIL_BYTE_BUDGET;
  const chunkBytes = Math.max(1, options.chunkBytes ?? ROLLOUT_TAIL_CHUNK_BYTES);

  // Response items per needed turn, in file order.
  const groups = new Map<string, RolloutResponseItem[]>();
  // Turns whose saved lines have all been passed.
  const completed = new Set<string>();
  const seen = new Set<string>();
  const pageIds = new Set(thread.turns.map((turn) => turn.id));
  let reachedPage = false;
  // Response items after the turn_context not yet reached, newest first.
  let pending: RolloutResponseItem[] = [];
  let lastContextId: string | null = null;
  let done = false;

  const handleLine = (bytes: Buffer): void => {
    if (bytes.length === 0) return;
    let parsed: { type?: unknown; payload?: Record<string, unknown> };
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      return;
    }
    if (parsed?.type === 'response_item') {
      pending.push(parsed as RolloutResponseItem);
      return;
    }
    if (parsed?.type !== 'turn_context') return;

    const rawTurnId = parsed.payload?.turn_id;
    const turnId = typeof rawTurnId === 'string' ? rawTurnId : null;
    // Moving to a different turn means every turn seen so far is complete;
    // a turn compacted mid-way repeats its own turn_context and stays open.
    if (turnId !== lastContextId) {
      for (const id of seen) if (id !== turnId) completed.add(id);
    }
    lastContextId = turnId;
    if (turnId && pageIds.has(turnId)) reachedPage = true;
    if (turnId && targetIds.has(turnId)) {
      seen.add(turnId);
      if (pending.length > 0) {
        const group = pending.reverse();
        const existing = groups.get(turnId);
        groups.set(turnId, existing ? group.concat(existing) : group);
      }
    } else if (
      // Every needed turn has been read in full,
      seen.size === targetIds.size
      // or a turn older than the page has been reached (the page's turns are
      // consecutive, so nothing further back belongs to it),
      || (reachedPage && !(turnId && pageIds.has(turnId)))
      // or the saved lines predate turn ids and cannot match any turn.
      || turnId === null
    ) {
      done = true;
    }
    pending = [];
  };

  let handle: FileHandle | null = null;
  let bytesRead = 0;
  let fileSize = 0;
  try {
    handle = await open(thread.path, 'r');
    // A history being appended to is read only up to its size at open.
    fileSize = (await handle.stat()).size;
    let position = fileSize;
    // Fragments of the line being assembled across chunks, in file order.
    let carry: Buffer[] = [];
    while (position > 0 && !done) {
      const length = Math.min(chunkBytes, position);
      if (bytesRead + length > byteBudget) break;
      const chunk = Buffer.allocUnsafe(length);
      const start = position - length;
      let filled = 0;
      while (filled < length) {
        const { bytesRead: n } = await handle.read(chunk, filled, length - filled, start + filled);
        if (n === 0) throw new Error('Saved history shrank while reading');
        filled += n;
      }
      bytesRead += length;
      position = start;

      let end = length;
      for (let index = length - 1; index >= 0 && !done; index -= 1) {
        if (chunk[index] !== NEWLINE) continue;
        const tail = chunk.subarray(index + 1, end);
        handleLine(carry.length > 0 ? Buffer.concat([tail, ...carry]) : tail);
        carry = [];
        end = index;
      }
      if (!done && end > 0) carry.unshift(chunk.subarray(0, end));
    }
    if (position === 0 && !done) {
      // The start of the file: the first line ends the walk.
      if (carry.length > 0) handleLine(Buffer.concat(carry));
      for (const id of seen) completed.add(id);
      done = true;
    }
  } catch {
    return unchanged('unavailable', bytesRead, fileSize);
  } finally {
    await handle?.close().catch(() => undefined);
  }

  let usable: ReadonlySet<string>;
  let status: RolloutEnrichmentStatus = 'enriched';
  if (done) {
    usable = new Set(groups.keys());
  } else if (options.partial) {
    usable = completed;
    status = 'budget';
  } else {
    return unchanged('budget', bytesRead, fileSize);
  }

  let changed = false;
  const turns = thread.turns.map((turn) => {
    const responseItems = usable.has(turn.id) ? groups.get(turn.id) : undefined;
    if (!responseItems) return turn;
    const next = enrichTurn(turn, responseItems);
    if (next !== turn) changed = true;
    return next;
  });
  return {
    thread: changed ? { ...thread, turns } : thread,
    status,
    bytesRead,
    fileSize,
  };
}

function enrichToolItemsWithSource(
  items: v2.ThreadItem[],
  responseItems: RolloutResponseItem[],
): { items: EnrichedThreadItem[]; changed: boolean } {
  const customToolInputs = new Map<
    string,
    { sourceInput: string; sourceToolName?: string }
  >();

  for (const ri of responseItems) {
    if (ri.payload.type !== 'custom_tool_call') continue;
    if (typeof ri.payload.call_id !== 'string') continue;
    if (typeof ri.payload.input !== 'string') continue;
    customToolInputs.set(ri.payload.call_id, {
      sourceInput: ri.payload.input,
      sourceToolName:
        typeof ri.payload.name === 'string' ? ri.payload.name : undefined,
    });
  }

  if (customToolInputs.size === 0) {
    return { items, changed: false };
  }

  let changed = false;
  const enrichedItems = items.map((item) => {
    if (item.type !== 'commandExecution') {
      return item;
    }

    const source = customToolInputs.get(item.id);
    if (!source) {
      return item;
    }

    const existing = item as EnrichedThreadItem;
    if (
      existing.sourceInput === source.sourceInput
      && existing.sourceToolName === source.sourceToolName
    ) {
      return item;
    }

    changed = true;
    return {
      ...item,
      sourceInput: source.sourceInput,
      sourceToolName: source.sourceToolName,
    };
  });

  return { items: enrichedItems, changed };
}

// Saved turns are rebuilt from events rather than from the saved response
// items, and older runtimes emitted no reasoning event when the reasoning
// summary was empty. The response items still carry that reasoning, so it is
// reinserted here at its original position for turns without native
// reasoning. A turn compacted mid-way writes several turn_context lines; the
// response items of all its segments are concatenated so reasoning from
// before the compaction is kept.
function enrichTurn(turn: v2.Turn, responseItems: RolloutResponseItem[]): v2.Turn {
  const {
    items: itemsWithToolSource,
    changed: toolSourceChanged,
  } = enrichToolItemsWithSource(turn.items, responseItems);

  // The saved turn is authoritative once it carries native reasoning.
  if (itemsWithToolSource.some((item) => item.type === 'reasoning')) {
    return toolSourceChanged ? { ...turn, items: itemsWithToolSource } : turn;
  }

  const hasReasoning = responseItems.some(
    (ri) => ri.payload.type === 'reasoning',
  );
  if (!hasReasoning) {
    return toolSourceChanged ? { ...turn, items: itemsWithToolSource } : turn;
  }

  // Tool outputs merge into their parent tool item and produce no item of
  // their own. Every other non-reasoning response item maps 1:1 to a saved
  // item, so they serve as positional anchors for the reasoning.
  const NON_ITEM_TYPES = new Set([
    'reasoning',
    'function_call_output',
    'custom_tool_call_output',
  ]);

  const insertBefore = new Map<number, v2.ThreadItem[]>();
  const pending: v2.ThreadItem[] = [];
  let v2Idx = 0;

  for (const ri of responseItems) {
    if (ri.payload.type === 'reasoning') {
      const summary = (ri.payload.summary ?? []).map((s) => s.text);
      const content = (ri.payload.content ?? []).map((c) => c.text);
      const hasSubstance =
        content.some((t) => t.trim().length > 0)
        || summary.some((t) => t.trim().length > 0);
      if (!hasSubstance) continue;
      pending.push({
        type: 'reasoning',
        id: randomUUID(),
        summary,
        content,
      });
    } else if (!NON_ITEM_TYPES.has(ri.payload.type)) {
      if (pending.length > 0) {
        insertBefore.set(v2Idx, [...pending]);
        pending.length = 0;
      }
      v2Idx++;
    }
  }

  const newItems: v2.ThreadItem[] = [];
  for (let i = 0; i < itemsWithToolSource.length; i++) {
    const reasoning = insertBefore.get(i);
    if (reasoning) newItems.push(...reasoning);
    newItems.push(itemsWithToolSource[i]!);
  }
  if (pending.length > 0) newItems.push(...pending);

  return { ...turn, items: newItems };
}
