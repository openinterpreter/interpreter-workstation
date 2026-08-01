import { readFileSync } from "node:fs";
import type { v2 } from "../../../server/handlers/codex-generated-types/index";

interface RolloutResponseItem {
  type: "response_item";
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

function enrichToolItemsWithSource(
  items: v2.ThreadItem[],
  responseItems: RolloutResponseItem[],
): { items: EnrichedThreadItem[]; changed: boolean } {
  const customToolInputs = new Map<
    string,
    { sourceInput: string; sourceToolName?: string }
  >();

  for (const ri of responseItems) {
    if (ri.payload.type !== "custom_tool_call") continue;
    if (typeof ri.payload.call_id !== "string") continue;
    if (typeof ri.payload.input !== "string") continue;
    customToolInputs.set(ri.payload.call_id, {
      sourceInput: ri.payload.input,
      sourceToolName:
        typeof ri.payload.name === "string" ? ri.payload.name : undefined,
    });
  }

  if (customToolInputs.size === 0) {
    return { items, changed: false };
  }

  let changed = false;
  const enrichedItems = items.map((item) => {
    if (item.type !== "commandExecution") {
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

// NOTE(victor): ThreadHistoryBuilder in the Rust app-server reconstructs v2 Thread turns
// from EventMsg events, not from ResponseItem entries. But ReasoningItem::as_legacy_events()
// iterates over an empty summary array (the API returns summary: []) producing zero EventMsg
// events, and handle_item_completed treats TurnItem::Reasoning as a no-op
// (codex-rs/app-server-protocol/src/protocol/thread_history.rs:274).
// Result: ResponseItem::Reasoning IS persisted in the rollout JSONL
// (codex-rs/core/src/rollout/policy.rs), but the v2 Thread served to the frontend has no
// reasoning items. This function post-processes the thread by reading the rollout JSONL at
// thread.path and injecting reasoning items back into the correct positions.
// Related: openai/codex#10723, #10746.
//
// NOTE(victor): A single turn can emit multiple turn_context lines in the JSONL -- once after
// initial context computation and again after mid-turn compaction when replacement history
// re-establishes full context (codex-rs/protocol/src/protocol.rs:2188-2191). We concatenate
// response_items across all groups for the same turn_id so reasoning items from before
// compaction are not silently dropped.
export function enrichThreadWithReasoning(thread: v2.Thread): v2.Thread {
  if (!thread.path || thread.turns.length === 0) return thread;

  let raw: string;
  try {
    raw = readFileSync(thread.path, "utf-8");
  } catch {
    return thread;
  }

  const turnGroups = new Map<string, RolloutResponseItem[]>();
  let currentTurnId: string | null = null;
  let currentGroup: RolloutResponseItem[] = [];

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let parsed: { type: string; payload?: Record<string, unknown> };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type === "turn_context") {
      if (currentTurnId && currentGroup.length > 0) {
        const existing = turnGroups.get(currentTurnId);
        turnGroups.set(
          currentTurnId,
          existing ? existing.concat(currentGroup) : currentGroup,
        );
      }
      currentTurnId =
        (parsed.payload?.turn_id as string | undefined) ?? null;
      currentGroup = [];
    } else if (parsed.type === "response_item") {
      currentGroup.push(parsed as RolloutResponseItem);
    }
  }
  if (currentTurnId && currentGroup.length > 0) {
    const existing = turnGroups.get(currentTurnId);
    turnGroups.set(
      currentTurnId,
      existing ? existing.concat(currentGroup) : currentGroup,
    );
  }

  if (turnGroups.size === 0) return thread;

  const enrichedTurns = thread.turns.map((turn) => {
    const responseItems = turnGroups.get(turn.id);
    if (!responseItems) return turn;

    const {
      items: itemsWithToolSource,
      changed: toolSourceChanged,
    } = enrichToolItemsWithSource(turn.items, responseItems);

    // Treat thread/read as authoritative once the backend emits native
    // reasoning items for this turn. The JSONL shim is compatibility-only for
    // older histories that still omit reasoning entirely.
    if (itemsWithToolSource.some((item) => item.type === "reasoning")) {
      return toolSourceChanged ? { ...turn, items: itemsWithToolSource } : turn;
    }

    const hasReasoning = responseItems.some(
      (ri) => ri.payload.type === "reasoning",
    );
    if (!hasReasoning) {
      return toolSourceChanged ? { ...turn, items: itemsWithToolSource } : turn;
    }

    // NOTE(victor): function_call_output and custom_tool_call_output are merged into
    // their parent tool ThreadItem and do not produce separate v2 items. Every other
    // non-reasoning response_item maps 1:1 to a v2 ThreadItem, so we use them all as
    // positional anchors to keep reasoning items interleaved with tool calls correctly.
    const NON_ITEM_TYPES = new Set([
      "reasoning",
      "function_call_output",
      "custom_tool_call_output",
    ]);

    const insertBefore = new Map<number, v2.ThreadItem[]>();
    const pending: v2.ThreadItem[] = [];
    let v2Idx = 0;

    for (const ri of responseItems) {
      if (ri.payload.type === "reasoning") {
        const summary = (ri.payload.summary ?? []).map((s) => s.text);
        const content = (ri.payload.content ?? []).map((c) => c.text);
        const hasSubstance =
          content.some((t) => t.trim().length > 0) ||
          summary.some((t) => t.trim().length > 0);
        if (!hasSubstance) continue;
        pending.push({
          type: "reasoning",
          id: crypto.randomUUID(),
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
  });

  return { ...thread, turns: enrichedTurns };
}
