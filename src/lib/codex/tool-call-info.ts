import type { v2 } from "../../../server/handlers/codex-generated-types/index";
import type { ToolCallInfo } from "../../hooks/use-chat";
import {
  formatToolDetails,
  formatToolLabel,
  isFailedToolItem,
  toolOutputFromItem,
  extractToolVerb,
  extractToolTarget,
  extractToolFilePath,
} from "./tool-call-format";

type ToolItemPhase = "started" | "completed";

export function resolveToolCallState(
  item: v2.ThreadItem,
  phase: ToolItemPhase = "completed",
): ToolCallInfo["state"] {
  if (phase !== "completed") {
    return "loading";
  }

  return isFailedToolItem(item) ? "error" : "complete";
}

function resolveBackgroundState(
  item: v2.ThreadItem,
  previous?: ToolCallInfo,
): ToolCallInfo["backgroundState"] {
  if (item.type !== "commandExecution") {
    return previous?.backgroundState;
  }

  if (!item.processId || item.status !== "completed") {
    return undefined;
  }

  return previous?.backgroundState;
}

export function buildToolCallInfoFromItem(
  item: v2.ThreadItem,
  options?: {
    phase?: ToolItemPhase;
    previous?: ToolCallInfo;
    sourceInput?: string;
    sourceToolName?: string;
  },
): ToolCallInfo {
  const previous = options?.previous;
  const phase = options?.phase ?? "completed";
  const output = toolOutputFromItem(item);
  const target = extractToolTarget(item);
  const filePath = extractToolFilePath(item);

  return {
    id: item.id,
    type: item.type,
    item,
    label: formatToolLabel(item),
    state: resolveToolCallState(item, phase),
    startedAt: previous?.startedAt ?? Date.now(),
    completedAt: phase === "completed"
      ? (previous?.completedAt ?? Date.now())
      : previous?.completedAt,
    processId: item.type === "commandExecution"
      ? (item.processId ?? previous?.processId)
      : previous?.processId,
    backgroundState: resolveBackgroundState(item, previous),
    backgroundInput: previous?.backgroundInput,
    details: formatToolDetails(item),
    output: output ?? previous?.output,
    verb: extractToolVerb(item),
    target: target ?? previous?.target,
    filePath: filePath ?? previous?.filePath,
    sourceInput: options?.sourceInput ?? previous?.sourceInput,
    sourceToolName: options?.sourceToolName ?? previous?.sourceToolName,
    reasoningSummaryIndex: previous?.reasoningSummaryIndex,
  };
}
