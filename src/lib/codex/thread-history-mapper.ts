import type { v2 } from "../../../server/handlers/codex-generated-types/index";
import { hasToolCalls, type ChatMessage, type ToolCallInfo } from "../../hooks/use-chat";
import { buildToolCallInfoFromItem } from "./tool-call-info";
import { userInputToText } from "./user-input-to-text";

type MappedItem =
  | { role: "user"; message: ChatMessage }
  | { kind: "text"; text: string }
  | { kind: "tool"; toolCall: ToolCallInfo };

type ThreadItemWithSource = v2.ThreadItem & {
  sourceInput?: string;
  sourceToolName?: string;
};

function mapToolItem(item: v2.ThreadItem): ToolCallInfo {
  const sourceItem = item as ThreadItemWithSource;
  return buildToolCallInfoFromItem(item, {
    sourceInput: sourceItem.sourceInput,
    sourceToolName: sourceItem.sourceToolName,
  });
}

function mapThreadItem(item: v2.ThreadItem): MappedItem {
  switch (item.type) {
    case "userMessage":
      return {
        role: "user",
        message: {
          id: item.id,
          role: "user",
          parts: [{ kind: 'text' as const, content: userInputToText(item.content) }],
        },
      };
    case "agentMessage":
      return { kind: "text", text: item.text };
    case "contextCompaction":
      return {
        kind: "text",
        text: '<compaction reason="context_limit"></compaction>',
      };
    default:
      return { kind: "tool", toolCall: mapToolItem(item) };
  }
}

export function mapThreadToChatMessages(thread: v2.Thread): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const usedIds = new Set<string>();

  /** Return `id` if unused, otherwise generate a unique variant. */
  function uniqueId(id: string): string {
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
    const alt = `${id}-dup-${usedIds.size}`;
    usedIds.add(alt);
    return alt;
  }

  for (const turn of thread.turns) {
    let currentAssistant: ChatMessage | null = null;

    for (const item of turn.items) {
      const mapped = mapThreadItem(item);

      if ("role" in mapped && mapped.role === "user") {
        if (currentAssistant) {
          messages.push(currentAssistant);
          currentAssistant = null;
        }
        messages.push({ ...mapped.message, id: uniqueId(mapped.message.id) });
      } else if ("kind" in mapped) {
        if (!currentAssistant) {
          currentAssistant = {
            id: uniqueId(item.id),
            role: "assistant",
            parts: [],
            serverMessageId: turn.id,
          };
        }

        if (mapped.kind === "text") {
          // NOTE(victor): Mirror the live reducer so restored history matches
          // streaming chronology exactly: once any tool activity has been
          // emitted, the next assistant text belongs in a fresh message.
          if (hasToolCalls(currentAssistant)) {
            messages.push(currentAssistant);
            currentAssistant = {
              id: uniqueId(item.id),
              role: "assistant",
              parts: [],
              serverMessageId: turn.id,
            };
          }
          currentAssistant.parts.push({ kind: 'text', content: mapped.text });
        } else if (mapped.kind === "tool") {
          currentAssistant.parts.push({ kind: 'tool-call', toolCall: mapped.toolCall });
        }
      }
    }

    if (currentAssistant) {
      messages.push(currentAssistant);
    }
  }

  return messages;
}
