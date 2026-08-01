import type { v2 } from "../../../server/handlers/codex-generated-types/index";
import { displayToolName } from "../../../shared/utils/mcpToolName";
import { getToolDisplay, DEFAULT_DISPLAY, type ToolCategory } from "../../../shared/toolMetadata";
import { isAbsolutePath, pathBasename, pathJoin, pathNormalize } from "../../ipc";

type CommandExecutionItem = Extract<v2.ThreadItem, { type: "commandExecution" }>;
type CommandAction = CommandExecutionItem["commandActions"][number];
type ToolVerb = { active: string; past: string };
const COMMAND_EXECUTION_VERB: ToolVerb = { active: "Running", past: "Ran" };
const SHELL_SCRIPT_TARGET = "script";
const JS_REPL_COMMAND = "js_repl";
const JAVASCRIPT_TARGET = "JavaScript";

function toPrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function commandActionDisplayPath(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  return pathBasename(path) || path;
}

function isShellScriptWrapper(command: string): boolean {
  return /^\s*(?:\/bin\/)?(?:zsh|bash|sh)\s+-[A-Za-z]*c(?:\s|$)/i.test(command);
}

function commandActionSummarySuffix(commandActions: CommandExecutionItem["commandActions"]): string {
  const extraCount = Math.max(commandActions.length - 1, 0);
  return extraCount > 0 ? ` +${extraCount} more` : "";
}

function primaryCommandAction(item: CommandExecutionItem): CommandAction | null {
  return item.commandActions.find((action) => action.type !== "unknown") ?? item.commandActions[0] ?? null;
}

function commandActionTarget(action: CommandAction, suffix: string): string | undefined {
  switch (action.type) {
    case "read": {
      const name = action.name || commandActionDisplayPath(action.path);
      return name ? `${name}${suffix}` : undefined;
    }
    case "listFiles": {
      const location = commandActionDisplayPath(action.path);
      return location ? `files in ${location}${suffix}` : `files${suffix}`;
    }
    case "search": {
      const query = action.query ? JSON.stringify(action.query) : null;
      const location = commandActionDisplayPath(action.path);
      if (location && query) return `${location} for ${query}${suffix}`;
      if (location) return `${location}${suffix}`;
      if (query) return `for ${query}${suffix}`;
      return `files${suffix}`;
    }
    case "unknown":
      return undefined;
    default:
      return undefined;
  }
}

function commandActionVerb(action: CommandAction): { active: string; past: string } | undefined {
  switch (action.type) {
    case "read":
      return { active: "Reading", past: "Read" };
    case "listFiles":
      return { active: "Listing", past: "Listed" };
    case "search":
      return { active: "Searching", past: "Searched" };
    case "unknown":
      return undefined;
    default:
      return undefined;
  }
}

function commandExecutionDisplay(item: CommandExecutionItem): {
  label: string;
  target?: string;
  verb?: ToolVerb;
} | null {
  const serviceTool = parseInterpreterAppServiceToolCommand(item.command);
  if (serviceTool) {
    return {
      label: serviceTool.active,
      target: serviceTool.serviceLabel,
      verb: { active: serviceTool.active.replace(/\.\.\.$/, ""), past: serviceTool.past },
    };
  }

  const builtinTool = parseInterpreterAppBuiltinToolCommand(item.command, item.cwd);
  if (builtinTool) {
    return {
      label: builtinTool.active,
      target: builtinTool.mentions[0]?.label,
      verb: { active: builtinTool.active.replace(/\.\.\.$/, ""), past: builtinTool.past },
    };
  }

  if (item.command.trim() === JS_REPL_COMMAND) {
    return {
      label: `${COMMAND_EXECUTION_VERB.active} ${JAVASCRIPT_TARGET}`,
      target: JAVASCRIPT_TARGET,
      verb: COMMAND_EXECUTION_VERB,
    };
  }

  if (isShellScriptWrapper(item.command)) {
    return {
      label: `${COMMAND_EXECUTION_VERB.active} ${SHELL_SCRIPT_TARGET}`,
      target: SHELL_SCRIPT_TARGET,
      verb: COMMAND_EXECUTION_VERB,
    };
  }

  const action = primaryCommandAction(item);
  if (action) {
    const target = commandActionTarget(action, commandActionSummarySuffix(item.commandActions));
    const verb = commandActionVerb(action);
    if (verb) {
      return {
        label: target ? `${verb.active} ${target}` : verb.active,
        target,
        verb,
      };
    }
  }
  return null;
}

/**
 * Extract content fields from an unrecognized ThreadItem variant.
 *
 * The generated ThreadItem union will grow as Codex adds new item types.
 * When our switch cases lag behind, the `default` branch is typed as `never`
 * but at runtime the item carries real data. This helper centralizes the
 * cast so callers don't each need their own `as Record<string, unknown>`.
 */
function extractUnknownItemContent(item: v2.ThreadItem): string | undefined {
  const raw = item as unknown as Record<string, unknown>;
  const { id: _id, type: _type, ...rest } = raw;
  return Object.keys(rest).length > 0 ? toPrettyJson(rest) : undefined;
}

function textResult(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const value = (entry as { type?: unknown; text?: unknown }).type === "text"
        ? (entry as { text?: unknown }).text
        : undefined;
      return typeof value === "string" && value.trim().length > 0 ? [value] : [];
    })
    .join("\n\n");
  return text || undefined;
}

function formatWindowsSandboxSpawnError(output: string): string | null {
  if (!/windows sandbox/i.test(output)) {
    return null;
  }

  if (!/CreateProcessWithLogonW failed:\s*267/i.test(output)) {
    return null;
  }

  return [
    "Windows sandbox failed to start this command (CreateProcessWithLogonW error 267).",
    "Open Settings -> Native Tools and run Windows sandbox setup, then retry.",
    "If this continues, temporarily set Sandbox Mode to Full Access.",
  ].join("\n");
}

export function formatToolLabel(item: v2.ThreadItem): string {
  switch (item.type) {
    case "commandExecution":
      return commandExecutionDisplay(item)?.label ?? item.command;
    case "mcpToolCall":
      return displayToolName(item.tool);
    case "dynamicToolCall":
      return displayToolName(item.tool);
    case "webSearch":
      return item.query;
    case "fileChange":
      return "proposed file changes";
    case "collabAgentToolCall":
      return item.tool;
    case "reasoning":
      return "reasoning";
    case "plan":
      return "plan";
    case "imageView":
      return item.path;
    case "contextCompaction":
      return "context compaction";
    case "enteredReviewMode":
    case "exitedReviewMode":
      return "review mode";
    default:
      return item.type;
  }
}

export function formatToolDetails(item: v2.ThreadItem): string | undefined {
  switch (item.type) {
    case "reasoning":
      return undefined;
    case "commandExecution": {
      const parts = [
        `Command: ${item.command}`,
        `CWD: ${item.cwd}`,
        `Status: ${item.status}`,
        ...(item.exitCode !== null ? [`Exit code: ${item.exitCode}`] : []),
        ...(item.durationMs !== null ? [`Duration: ${item.durationMs}ms`] : []),
      ];
      return parts.join("\n");
    }
    case "webSearch": {
      const action = item.action ? `Action: ${toPrettyJson(item.action)}` : null;
      const parts = [
        ...(item.query ? [`Query: ${item.query}`] : []),
        ...(action ? [action] : []),
      ];
      return parts.length > 0 ? parts.join("\n") : undefined;
    }
    case "mcpToolCall": {
      const parts = [
        `Server: ${item.server}`,
        `Tool: ${item.tool}`,
        `Status: ${item.status}`,
        ...(item.error ? [`Error: ${item.error.message}`] : []),
      ];
      return parts.join("\n");
    }
    case "dynamicToolCall": {
      const parts = [
        ...(item.namespace ? [`Namespace: ${item.namespace}`] : []),
        `Tool: ${item.tool}`,
        `Status: ${item.status}`,
        ...(item.success === false ? ['Success: false'] : []),
      ];
      return parts.join("\n");
    }
    case "fileChange": {
      if (item.changes.length === 0) {
        return `Status: ${item.status}`;
      }
      const fileLines = item.changes.map((change) => {
        const kind =
          change.kind.type === "update" && change.kind.move_path
            ? `update -> ${change.kind.move_path}`
            : change.kind.type;
        return `- ${change.path} (${kind})`;
      });
      return [`Status: ${item.status}`, `Changes: ${item.changes.length}`, ...fileLines].join("\n");
    }
    case "collabAgentToolCall": {
      const parts = [
        `Tool: ${item.tool}`,
        `Status: ${item.status}`,
        `Sender: ${item.senderThreadId}`,
        `Receivers: ${item.receiverThreadIds.join(", ") || "none"}`,
        ...(item.prompt ? [`Prompt: ${item.prompt}`] : []),
      ];
      return parts.join("\n");
    }
    default:
      return extractUnknownItemContent(item);
  }
}

export function toolOutputFromItem(item: v2.ThreadItem): string | undefined {
  switch (item.type) {
    case "commandExecution": {
      if (typeof item.aggregatedOutput !== "string") {
        return undefined;
      }

      return formatWindowsSandboxSpawnError(item.aggregatedOutput)
        ?? item.aggregatedOutput;
    }

    case "mcpToolCall": {
      if (item.error) return `Error: ${item.error.message}`;
      if (!item.result) return undefined;
      return textResult(item.result.content)
        ?? toPrettyJson(item.result.content);
    }

    case "fileChange": {
      if (item.changes.length === 0) return undefined;
      return item.changes.map((c) => c.diff).filter(Boolean).join("\n");
    }

    case "webSearch":
      return item.action ? toPrettyJson(item.action) : undefined;

    case "collabAgentToolCall": {
      const entries = Object.entries(item.agentsStates);
      if (entries.length === 0) return undefined;
      return entries
        .map(([id, state]) => `${id}: ${state?.status ?? "unknown"}${state?.message ? ` - ${state.message}` : ""}`)
        .join("\n");
    }

    case "reasoning":
      return item.summary.join("\n") || item.content.join("\n") || undefined;

    case "plan":
      return item.text || undefined;

    case "imageView":
      return item.path;

    case "enteredReviewMode":
    case "exitedReviewMode":
      return item.review || undefined;

    default:
      return extractUnknownItemContent(item);
  }
}

// ---------------------------------------------------------------------------
// Verb / target extraction for "Verb target" display pattern
// ---------------------------------------------------------------------------

const ITEM_TYPE_VERBS: Record<string, { active: string; past: string }> = {
  commandExecution: COMMAND_EXECUTION_VERB,
  fileChange: { active: "Editing", past: "Edited" },
  webSearch: { active: "Searching", past: "Searched" },
  reasoning: { active: "Reasoning", past: "Reasoned" },
  plan: { active: "Planning", past: "Planned" },
  imageView: { active: "Viewing", past: "Viewed" },
  contextCompaction: { active: "Compacting", past: "Compacted" },
  collabAgentToolCall: { active: "Collaborating", past: "Collaborated" },
  enteredReviewMode: { active: "Reviewing", past: "Reviewed" },
  exitedReviewMode: { active: "Reviewing", past: "Reviewed" },
};

const ITEM_TYPE_CATEGORIES: Record<string, ToolCategory> = {
  commandExecution: "run",
  fileChange: "edit",
  webSearch: "browse",
  reasoning: "other",
  plan: "other",
  imageView: "explore",
  contextCompaction: "other",
  collabAgentToolCall: "other",
  enteredReviewMode: "other",
  exitedReviewMode: "other",
};

const READ_COMMANDS = new Set(["cat", "bat", "head", "tail", "sed", "nl", "awk", "more", "less"]);
const SEARCH_COMMANDS = new Set(["rg", "grep", "ag", "ack"]);
const LIST_COMMANDS = new Set(["ls", "find", "fd", "tree"]);
const TEST_COMMANDS = new Set(["pytest", "vitest", "jest", "playwright"]);
const SHELL_WRAPPERS = new Set(["bash", "zsh", "sh", "fish"]);
const POWERSHELL_WRAPPERS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const POWERSHELL_COMMAND_FLAGS = new Set(["-command", "-c", "/c"]);
const OPEN_COMMANDS = new Set(["open", "xdg-open"]);
const MULTI_READ_COMMANDS = new Set(["cat", "bat", "more", "less"]);
const LAST_READ_COMMANDS = new Set(["head", "tail", "sed", "nl", "awk"]);
const SCRIPT_RUNNERS = new Set(["node", "python", "python3", "ruby", "perl", "php", "swift", "deno", "osascript", "bunx", "tsx", "ts-node"]);
const SCRIPT_INLINE_SOURCE_FLAGS = new Set(["-c", "-e", "--eval"]);
const SCRIPT_MODULE_FLAGS = new Set(["-m"]);

export type ShellCommandIntent = {
  kind: "read" | "search" | "list" | "git" | "test" | "run";
  label: string;
  program: string;
  subcommand?: string;
  path?: string;
  query?: string;
};

export type ToolMention = {
  path: string;
  itemType: "file" | "directory" | "service";
  label: string;
};

export type ShellCommandAction = {
  kind: "read" | "search" | "list" | "write" | "delete" | "move" | "copy" | "git" | "test" | "run";
  label: string;
  active: string;
  past: string;
  command: string;
  query?: string;
  service?: ServiceToolCall;
  mentions: ToolMention[];
};

export type ServiceToolCall = {
  syntax: "mcp" | "tools";
  serviceId: string;
  serviceLabel: string;
  toolName: string;
  toolLabel: string;
  active: string;
  past: string;
};

type BuiltinAppToolCall = {
  serverId: string;
  toolName: string;
  label: string;
  active: string;
  past: string;
  kind: ShellCommandAction["kind"];
  mentions: ToolMention[];
};

function stripQuotes(value: string): string {
  const quoted = (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
    || (value.startsWith("`") && value.endsWith("`"))
  );
  return quoted ? value.slice(1, -1) : value;
}

function splitShell(command: string): string[] {
  const parts = command.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[^\s]+/g) ?? [];
  return parts.map(stripQuotes);
}

function commandBase(value: string | undefined): string {
  if (!value) return "";
  const base = pathBasename(value);
  return base || value;
}

function pathLike(value: string): boolean {
  if (!value || value.startsWith("-")) return false;
  if (value === "." || value === ".." || value === "~") return true;
  if (value.includes("/")) return true;
  if (/^[A-Za-z]:\\/.test(value)) return true;
  if (/\.[A-Za-z0-9_-]{1,8}$/.test(value)) return true;
  return false;
}

function packageSpecifierLike(value: string): boolean {
  if (!value.startsWith("@")) return false;
  const parts = value.split("/");
  return parts.length === 2 && parts[0].length > 1 && parts[1].length > 0;
}

function normalizePathToken(value: string): string {
  return value.replace(/^\d*>>?/, "").replace(/^<<?/, "");
}

function resolvePath(value: string | undefined, cwd: string | undefined): string | undefined {
  if (!value) return undefined;
  if (isAbsolutePath(value)) return pathNormalize(value);
  if (!cwd) return value;
  return pathNormalize(pathJoin(cwd, value));
}

function mention(path: string | undefined, itemType: "file" | "directory"): ToolMention[] {
  if (!path) return [];
  const normalized = pathNormalize(path);
  if (normalized === "/dev/null" || normalized === "NUL") {
    return [];
  }
  return [{
    path: normalized,
    itemType,
    label: pathBasename(normalized) || normalized,
  }];
}

function uniqMentions(mentions: ToolMention[]): ToolMention[] {
  const seen = new Set<string>();
  return mentions.filter((entry) => {
    const key = `${entry.itemType}:${entry.itemType === "service" ? entry.path : pathNormalize(entry.path)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function naturalDurationText(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "0 seconds";
  }

  if (durationMs < 1000) {
    return `${durationMs} millisecond${durationMs === 1 ? "" : "s"}`;
  }

  const totalSeconds = Math.ceil(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    if (seconds === 0) {
      return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
    return `${minutes} minute${minutes === 1 ? "" : "s"} ${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (remMinutes === 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"} ${remMinutes} minute${remMinutes === 1 ? "" : "s"}`;
}

function parseDurationToken(token: string): number | null {
  let total = 0;
  let remaining = token.trim();
  let matched = false;

  while (remaining.length > 0) {
    const match = remaining.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?/i);
    if (!match) {
      return null;
    }

    const value = Number(match[1]);
    const unit = (match[2] || "s").toLowerCase();
    if (!Number.isFinite(value)) {
      return null;
    }

    matched = true;
    if (unit === "ms") {
      total += value;
    } else if (unit === "s") {
      total += value * 1000;
    } else if (unit === "m") {
      total += value * 60 * 1000;
    } else if (unit === "h") {
      total += value * 60 * 60 * 1000;
    } else {
      return null;
    }

    remaining = remaining.slice(match[0].length);
  }

  return matched ? total : null;
}

function sleepDurationText(parts: string[]): string | null {
  if (parts.length === 0) {
    return null;
  }

  const totalMs = parts.reduce((sum, part) => {
    if (!part || part.startsWith("-")) {
      return Number.NaN;
    }

    const parsed = parseDurationToken(part);
    if (parsed === null) {
      return Number.NaN;
    }

    return sum + parsed;
  }, 0);

  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return null;
  }

  return naturalDurationText(totalMs);
}

function splitCommandSegments(command: string): string[] {
  const result: string[] = [];
  let quote: "'" | '"' | "`" | null = null;
  let escape = false;
  let start = 0;

  for (let index = 0; index < command.length; index += 1) {
    const value = command[index];
    if (!value) continue;

    if (escape) {
      escape = false;
      continue;
    }

    if (value === "\\") {
      escape = true;
      continue;
    }

    if (quote) {
      if (value === quote) {
        quote = null;
      }
      continue;
    }

    if (value === "'" || value === '"' || value === "`") {
      quote = value;
      continue;
    }

    const pair = command.slice(index, index + 2);
    const isBoundary = pair === "&&" || pair === "||" || pair === ">>" || pair === "<<"
      ? pair === "&&" || pair === "||"
      : value === ";" || value === "|";

    if (!isBoundary) continue;

    const segment = command.slice(start, index).trim();
    if (segment) result.push(segment);
    start = index + (pair === "&&" || pair === "||" ? 2 : 1);
    if (pair === "&&" || pair === "||") {
      index += 1;
    }
  }

  const tail = command.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

function hasHeredoc(command: string): boolean {
  return /<<-?\s*['"]?[A-Za-z0-9_]+['"]?/.test(command);
}

function isSimpleCatHeredocWriteCommand(command: string): boolean {
  const raw = unwrapShellCommand(command).trim();
  return /^cat(?:\s+[^>\n]+)?\s+\d*>>?\s*[^\s]+\s+<<-?\s*['"]?[A-Za-z0-9_]+['"]?(?:\n|$)/.test(raw)
    || /^cat\s+\d*>>?[^\s]+\s+<<-?\s*['"]?[A-Za-z0-9_]+['"]?(?:\n|$)/.test(raw);
}

function looksLikeShellScript(command: string): boolean {
  if (!command.trim()) return false;
  if (isSimpleCatHeredocWriteCommand(command)) return false;
  if (/[\r\n]/.test(command)) return true;
  if (/\$\(|`/.test(command)) return true;
  if (hasHeredoc(command) && !isSimpleCatHeredocWriteCommand(command)) return true;
  return /\b(for|while|until|if|then|elif|else|fi|do|done|case|esac|select|function)\b/.test(command);
}

function skipAssignments(parts: string[]): string[] {
  const index = parts.findIndex((value) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(value));
  return index < 0 ? [] : parts.slice(index);
}

function commandRunner(parts: string[]) {
  const program = commandBase(parts[0]);
  const runner = new Set(["bun", "pnpm", "npm", "yarn"]).has(program) ? commandBase(parts[1]) : "";
  if (!runner) {
    return {
      program,
      base: program,
      args: parts.slice(1),
    };
  }

  return {
    program,
    base: runner,
    args: parts.slice(2),
  };
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/^builtin-/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function serviceLabelForId(serviceId: string): string {
  return humanizeIdentifier(serviceId) || serviceId;
}

function toolActionVerb(toolName: string): { active: string; past: string; gerund: string } {
  const normalized = toolName.toLowerCase();
  const parts = normalized.split(/[_-]+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? normalized;

  if (normalized.includes("reconcile")) return { active: "Reconciling", past: "Reconciled", gerund: "Reconcile" };
  if (normalized.includes("stage")) return { active: "Staging", past: "Staged", gerund: "Stage" };
  if (last === "list" || normalized.includes("_list_") || normalized.startsWith("list_") || last === "entries" || last === "transactions") {
    return { active: "Listing", past: "Listed", gerund: "List" };
  }
  if (normalized.startsWith("get_") || normalized.includes("_get_") || normalized.startsWith("read_") || normalized.includes("_read_")) {
    return { active: "Reading", past: "Read", gerund: "Read" };
  }
  if (normalized.startsWith("search_") || normalized.includes("_search_") || normalized.startsWith("find_") || normalized.includes("_find_")) {
    return { active: "Searching", past: "Searched", gerund: "Search" };
  }
  if (normalized.startsWith("create_") || normalized.includes("_create_")) {
    return { active: "Creating", past: "Created", gerund: "Create" };
  }
  if (normalized.startsWith("update_") || normalized.includes("_update_")) {
    return { active: "Updating", past: "Updated", gerund: "Update" };
  }
  if (normalized.startsWith("send_") || normalized.includes("_send_")) {
    return { active: "Sending", past: "Sent", gerund: "Send" };
  }
  return { active: "Using", past: "Used", gerund: "Use" };
}

function toolObjectLabel(toolName: string, serviceLabel: string): string {
  const normalized = toolName.toLowerCase();
  const parts = normalized.split(/[_-]+/).filter(Boolean);
  const serviceTokens = new Set(serviceLabel.toLowerCase().split(/\s+/));
  const actionTokens = new Set(["list", "get", "read", "search", "find", "create", "update", "send", "stage"]);
  const objectParts = parts.filter((part) => !serviceTokens.has(part) && !actionTokens.has(part));

  if (normalized.includes("transaction")) return `${serviceLabel} transactions`;
  if (normalized.includes("message")) return `${serviceLabel} message`;

  const humanized = objectParts.length > 0 ? humanizeIdentifier(objectParts.join("_")) : humanizeIdentifier(toolName);
  return humanized || `${serviceLabel} tool`;
}

function parseJsonFlag(parts: string[], flagStartIndex: number): Record<string, unknown> | null {
  for (let index = flagStartIndex; index < parts.length; index += 1) {
    if (parts[index] !== "--json") continue;
    const raw = parts[index + 1];
    if (!raw) return null;
    return parseJsonObject(raw);
  }
  return null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const candidates = raw.includes('\\"') ? [raw, raw.replace(/\\"/g, '"')] : [raw];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next shell-unescaped representation.
    }
  }
  return null;
}

function firstStringArg(args: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function appToolFileMentions(args: Record<string, unknown> | null, cwd: string | undefined): ToolMention[] {
  const path = firstStringArg(args, [
    "path",
    "file",
    "filePath",
    "workbook",
    "workbookPath",
    "input",
    "inputPath",
    "output",
    "outputPath",
    "saveToDiskPath",
    "document",
    "documentPath",
  ]);
  return mention(resolvePath(path, cwd), "file");
}

function builtinAppToolVerb(serverId: string, toolName: string): Pick<BuiltinAppToolCall, "label" | "active" | "past" | "kind"> {
  const normalized = `${serverId} ${toolName}`.toLowerCase();
  const toolTokens = toolName.toLowerCase().split(/[_-]+/).filter(Boolean);
  const hasToolToken = (...tokens: string[]) => tokens.some((token) => toolTokens.includes(token));
  if (serverId === "builtin-cells" || /\.(?:xlsx|xlsm|xls|csv)\b/.test(normalized)) {
    if (hasToolToken("read", "search", "inspect", "list")) {
      return { label: "Read spreadsheet", active: "Reading spreadsheet...", past: "Read spreadsheet", kind: "read" };
    }
    if (hasToolToken("recalculate", "calculate", "refresh")) {
      return { label: "Recalculate spreadsheet", active: "Recalculating spreadsheet...", past: "Recalculated spreadsheet", kind: "run" };
    }
    return { label: "Edit spreadsheet", active: "Editing spreadsheet...", past: "Edited spreadsheet", kind: "write" };
  }

  if (serverId === "builtin-docx" || normalized.includes("document")) {
    if (/(read|inspect|extract)/.test(normalized)) {
      return { label: "Read document", active: "Reading document...", past: "Read document", kind: "read" };
    }
    return { label: "Edit document", active: "Editing document...", past: "Edited document", kind: "write" };
  }

  if (serverId === "builtin-pdf" || normalized.includes("pdf")) {
    if (/(fill|write|edit)/.test(normalized)) {
      return { label: "Edit PDF", active: "Editing PDF...", past: "Edited PDF", kind: "write" };
    }
    return { label: "Read PDF", active: "Reading PDF...", past: "Read PDF", kind: "read" };
  }

  if (toolName === "interpreter_refresh_file") {
    return { label: "Refresh file view", active: "Refreshing file view...", past: "Refreshed file view", kind: "run" };
  }

  return { label: humanizeIdentifier(toolName), active: "Using app tool...", past: "Used app tool", kind: "run" };
}

function parseInterpreterAppBuiltinToolCommand(command: string, cwd: string | undefined): BuiltinAppToolCall | null {
  const raw = unwrapShellCommand(command);
  const firstSegment = splitCommandSegments(raw)[0] ?? raw;
  const parts = skipAssignments(splitShell(firstSegment));
  const target = parseInterpreterToolTarget(parts);
  if (!target || parts[1] !== "tools" || !target.serverId.startsWith("builtin-")) {
    return null;
  }

  const args = parseJsonFlag(parts, target.flagStartIndex);
  const verb = builtinAppToolVerb(target.serverId, target.toolName);
  return {
    serverId: target.serverId,
    toolName: target.toolName,
    ...verb,
    mentions: appToolFileMentions(args, cwd),
  };
}

function parseInterpreterToolTarget(parts: string[]): { serverId: string; toolName: string; flagStartIndex: number } | null {
  if (!parts[0] || commandBase(parts[0]) !== "interpreter-app") return null;
  const namespace = parts[1];
  if (namespace !== "mcp" && namespace !== "tools") return null;
  const target = parts[2];
  if (!target || target === "list" || target === "find" || target === "search" || target === "help" || target === "describe") {
    return null;
  }

  const next = parts[3];
  if (target.includes("__") && (!next || next.startsWith("-"))) {
    const [serverId, ...toolParts] = target.split("__");
    const toolName = toolParts.join("__");
    if (serverId && toolName) {
      return { serverId, toolName, flagStartIndex: 3 };
    }
  }

  if (!next || next.startsWith("-")) return null;
  return { serverId: target, toolName: next, flagStartIndex: 4 };
}

export function parseInterpreterAppServiceToolCommand(command: string): ServiceToolCall | null {
  const raw = unwrapShellCommand(command);
  const firstSegment = splitCommandSegments(raw)[0] ?? raw;
  const parts = skipAssignments(splitShell(firstSegment));
  const namespace = parts[1];
  const target = parseInterpreterToolTarget(parts);
  if (!target || (namespace !== "mcp" && namespace !== "tools")) return null;
  if (namespace === "tools" && target.serverId.startsWith("builtin-")) return null;

  const serviceLabel = serviceLabelForId(target.serverId);
  const objectLabel = toolObjectLabel(target.toolName, serviceLabel);
  const verb = toolActionVerb(target.toolName);
  const toolLabel = humanizeIdentifier(target.toolName);

  return {
    syntax: namespace,
    serviceId: target.serverId,
    serviceLabel,
    toolName: target.toolName,
    toolLabel,
    active: `${verb.active} ${objectLabel}...`,
    past: `${verb.past} ${objectLabel}`,
  };
}

function candidatePaths(parts: string[], cwd: string | undefined) {
  return parts
    .map(normalizePathToken)
    .filter((value) => !packageSpecifierLike(value))
    .filter(pathLike)
    .map((value) => resolvePath(value, cwd))
    .filter((value): value is string => Boolean(value));
}

function genericCandidatePaths(base: string, shellArgs: string[], runnerArgs: string[], cwd: string | undefined) {
  if (hasNonFileScriptSource(base, shellArgs)) {
    return [];
  }

  if (base === "jq" || base === "yq") {
    return candidatePaths(runnerArgs.slice(1), cwd);
  }

  return candidatePaths(shellArgs, cwd);
}

function positional(parts: string[]) {
  return parts.filter((value) => value && !value.startsWith("-") && value !== ">" && value !== ">>");
}

function outputRedirectMentions(parts: string[], cwd: string | undefined) {
  return parts.flatMap((value, index) => {
    if (/^\d*>>?.+/.test(value)) {
      const inlinePath = resolvePath(normalizePathToken(value), cwd);
      return mention(inlinePath, "file");
    }
    if (!/^\d*>>?$/.test(value) && value !== ">" && value !== ">>") return [];
    const next = resolvePath(parts[index + 1], cwd);
    return mention(next, "file");
  });
}

function isCatHeredocWrite(command: string, base: string, redirects: ToolMention[]) {
  return base === "cat" && redirects.length > 0 && hasHeredoc(command);
}

function stripRedirects(parts: string[]) {
  return parts.filter((value, index) => {
    const prev = parts[index - 1];
    if (/^\d*>>?$/.test(value) || value === ">" || value === ">>") return false;
    if (/^\d*>>?.+/.test(value)) return false;
    if (/^<<?.+/.test(value)) return false;
    if (!prev) return true;
    return !/^\d*>>?$/.test(prev) && prev !== ">" && prev !== ">>";
  });
}

function firstQuery(parts: string[]) {
  return parts.find((value) => value && !value.startsWith("-") && !pathLike(value));
}

function action(value: Omit<ShellCommandAction, "mentions"> & { mentions?: ToolMention[] }): ShellCommandAction {
  return {
    ...value,
    mentions: uniqMentions(value.mentions ?? []),
  };
}

function isJsReplCommandExecution(
  item: CommandExecutionItem,
  sourceToolName?: string,
): boolean {
  return item.command.trim() === JS_REPL_COMMAND || sourceToolName === JS_REPL_COMMAND;
}

function stripJsReplPragma(source: string): string {
  return source.replace(/^[ \t]*\/\/\s*codex-js-repl:[^\r\n]*(?:\r?\n)?/, "");
}

function normalizeJsReplSource(source?: string): string | undefined {
  if (!source) {
    return undefined;
  }

  const normalized = stripJsReplPragma(source).trim();
  return normalized || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldSplitJsStatementOnNewline(current: string, remainder: string): boolean {
  const trimmed = current.trim();
  if (!trimmed) {
    return false;
  }

  if (
    /[([{.,:+\-*/%=&|^!?<>]$/.test(trimmed)
    || trimmed.endsWith("\\")
  ) {
    return false;
  }

  const next = remainder.trimStart();
  if (!next) {
    return false;
  }

  if (/^[).,\]}]/.test(next)) {
    return false;
  }

  return true;
}

function splitTopLevelJsStatements(source: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let escape = false;
  let lineComment = false;
  let blockComment = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) {
      statements.push(trimmed);
    }
    current = "";
  };

  for (let index = 0; index < source.length; index += 1) {
    const value = source[index];
    const next = source[index + 1];
    if (!value) {
      continue;
    }

    if (lineComment) {
      if (value === "\n") {
        lineComment = false;
        if (
          parenDepth === 0
          && bracketDepth === 0
          && braceDepth === 0
          && shouldSplitJsStatementOnNewline(current, source.slice(index + 1))
        ) {
          flush();
        }
      }
      continue;
    }

    if (blockComment) {
      if (value === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      current += value;

      if (escape) {
        escape = false;
        continue;
      }

      if (value === "\\") {
        escape = true;
        continue;
      }

      if (value === quote) {
        quote = null;
      }
      continue;
    }

    if (value === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (value === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    current += value;

    if (value === "'" || value === '"' || value === "`") {
      quote = value;
      continue;
    }

    if (value === "(") {
      parenDepth += 1;
    } else if (value === ")") {
      parenDepth = Math.max(parenDepth - 1, 0);
    } else if (value === "[") {
      bracketDepth += 1;
    } else if (value === "]") {
      bracketDepth = Math.max(bracketDepth - 1, 0);
    } else if (value === "{") {
      braceDepth += 1;
    } else if (value === "}") {
      braceDepth = Math.max(braceDepth - 1, 0);
    }

    const atTopLevel = parenDepth === 0 && bracketDepth === 0 && braceDepth === 0;
    if (!atTopLevel) {
      continue;
    }

    if (value === ";") {
      flush();
      continue;
    }

    if (value === "\n" && shouldSplitJsStatementOnNewline(current, source.slice(index + 1))) {
      flush();
    }
  }

  flush();
  return statements;
}

function splitTopLevelJsArguments(source: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let escape = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const value = source[index];
    if (!value) {
      continue;
    }

    current += value;

    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }

      if (value === "\\") {
        escape = true;
        continue;
      }

      if (value === quote) {
        quote = null;
      }
      continue;
    }

    if (value === "'" || value === '"' || value === "`") {
      quote = value;
      continue;
    }

    if (value === "(") {
      parenDepth += 1;
      continue;
    }
    if (value === ")") {
      parenDepth = Math.max(parenDepth - 1, 0);
      continue;
    }
    if (value === "[") {
      bracketDepth += 1;
      continue;
    }
    if (value === "]") {
      bracketDepth = Math.max(bracketDepth - 1, 0);
      continue;
    }
    if (value === "{") {
      braceDepth += 1;
      continue;
    }
    if (value === "}") {
      braceDepth = Math.max(braceDepth - 1, 0);
      continue;
    }

    if (value === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      const trimmed = current.slice(0, -1).trim();
      if (trimmed) {
        args.push(trimmed);
      }
      current = "";
    }
  }

  const tail = current.trim();
  if (tail) {
    args.push(tail);
  }

  return args;
}

function extractCallArguments(source: string, openParenIndex: number): string | undefined {
  let quote: "'" | '"' | "`" | null = null;
  let escape = false;
  let lineComment = false;
  let blockComment = false;
  let depth = 1;

  for (let index = openParenIndex + 1; index < source.length; index += 1) {
    const value = source[index];
    const next = source[index + 1];
    if (!value) {
      continue;
    }

    if (lineComment) {
      if (value === "\n") {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (value === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }

      if (value === "\\") {
        escape = true;
        continue;
      }

      if (value === quote) {
        quote = null;
      }
      continue;
    }

    if (value === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (value === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (value === "'" || value === '"' || value === "`") {
      quote = value;
      continue;
    }

    if (value === "(") {
      depth += 1;
      continue;
    }

    if (value === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openParenIndex + 1, index);
      }
    }
  }

  return undefined;
}

function extractJsLiteralText(source: string): string | undefined {
  const trimmed = source.trim();
  const quote = trimmed[0];
  if (quote !== "'" && quote !== '"' && quote !== "`") {
    return undefined;
  }

  let value = "";
  let escape = false;

  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (!char) {
      continue;
    }

    if (escape) {
      value += char;
      escape = false;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (quote === "`" && char === "$" && trimmed[index + 1] === "{") {
      return undefined;
    }

    if (char === quote) {
      return value.trim() || undefined;
    }

    value += char;
  }

  return undefined;
}

function cleanDisplayText(value: string | undefined, maxLength = 72): string | undefined {
  if (!value) {
    return undefined;
  }

  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }

  return compact.length > maxLength
    ? `${compact.slice(0, maxLength - 1).trimEnd()}…`
    : compact;
}

function extractJsArgumentText(args: string, index = 0): string | undefined {
  return cleanDisplayText(extractJsLiteralText(splitTopLevelJsArguments(args)[index] ?? ""));
}

function extractJsObjectPropertyText(source: string, key: string): string | undefined {
  const pattern = new RegExp(
    `${escapeRegExp(key)}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`,
    "i",
  );
  const match = source.match(pattern);
  return cleanDisplayText(match?.[2]);
}

function stripJsExpressionWrappers(source: string): string {
  let value = source.trim().replace(/;+\s*$/, "").trim();

  while (value.startsWith("await ")) {
    value = value.slice("await ".length).trim();
  }

  while (value.startsWith("void ")) {
    value = value.slice("void ".length).trim();
  }

  while (value.startsWith("(") && value.endsWith(")")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) {
      break;
    }
    value = inner;
  }

  return value;
}

function stripJsLocatorSuffixes(source: string): string {
  let value = source.trim();

  while (true) {
    const next = value
      .replace(/\.(?:first|last)\(\)\s*$/, "")
      .replace(/\.nth\([\s\S]*\)\s*$/, "")
      .replace(/\.filter\([\s\S]*\)\s*$/, "");
    if (next === value) {
      return value;
    }
    value = next.trim();
  }
}

function findLastMethodCall(
  source: string,
  methods: readonly string[],
): { method: string; objectExpression: string; args: string } | null {
  let best:
    | { method: string; objectExpression: string; args: string; index: number }
    | null = null;

  for (const method of methods) {
    const marker = `.${method}(`;
    const index = source.lastIndexOf(marker);
    if (index < 0) {
      continue;
    }

    const args = extractCallArguments(source, index + marker.length - 1);
    if (args == null) {
      continue;
    }

    if (!best || index > best.index) {
      best = {
        method,
        objectExpression: source.slice(0, index).trim(),
        args,
        index,
      };
    }
  }

  return best
    ? {
        method: best.method,
        objectExpression: best.objectExpression,
        args: best.args,
      }
    : null;
}

function resolveJsLocatorAlias(
  source: string,
  aliases: Map<string, string>,
): string | undefined {
  const normalized = stripJsLocatorSuffixes(stripJsExpressionWrappers(source));
  if (aliases.has(normalized)) {
    return aliases.get(normalized);
  }

  const baseMatch = normalized.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
  if (baseMatch?.[1] && aliases.has(baseMatch[1])) {
    return aliases.get(baseMatch[1]);
  }

  return undefined;
}

function describeJsLocatorExpression(
  source: string,
  aliases: Map<string, string>,
): string | undefined {
  const aliased = resolveJsLocatorAlias(source, aliases);
  if (aliased) {
    return aliased;
  }

  const normalized = stripJsExpressionWrappers(source);
  const roleCall = findLastMethodCall(normalized, ["getByRole"]);
  if (roleCall) {
    const role = extractJsArgumentText(roleCall.args, 0);
    const name = extractJsObjectPropertyText(roleCall.args, "name");
    return name ?? role;
  }

  const labelCall = findLastMethodCall(normalized, ["getByLabel"]);
  if (labelCall) {
    return extractJsArgumentText(labelCall.args, 0);
  }

  const textCall = findLastMethodCall(normalized, ["getByText"]);
  if (textCall) {
    return extractJsArgumentText(textCall.args, 0);
  }

  const placeholderCall = findLastMethodCall(normalized, ["getByPlaceholder"]);
  if (placeholderCall) {
    return extractJsArgumentText(placeholderCall.args, 0);
  }

  const testIdCall = findLastMethodCall(normalized, ["getByTestId"]);
  if (testIdCall) {
    return extractJsArgumentText(testIdCall.args, 0);
  }

  const locatorCall = findLastMethodCall(normalized, ["locator", "frameLocator"]);
  if (locatorCall) {
    return extractJsArgumentText(locatorCall.args, 0);
  }

  if (/\.keyboard$/.test(normalized)) {
    return "keyboard";
  }

  if (/\.mouse$/.test(normalized)) {
    return "page";
  }

  if (normalized === "page" || normalized.endsWith(".page")) {
    return "page";
  }

  return undefined;
}

function buildJsReplAction(
  command: string,
  active: string,
  past: string,
): ShellCommandAction {
  return action({
    kind: "run",
    label: past,
    active,
    past,
    command,
    mentions: [],
  });
}

function formatJsReplTarget(prefix: string, target: string | undefined): string {
  return target ? `${prefix} ${target}` : prefix;
}

function parseJsReplAction(
  statement: string,
  aliases: Map<string, string>,
): ShellCommandAction | null {
  const trimmed = statement.trim();
  if (!trimmed) {
    return null;
  }

  if (/^(?:async\s+)?function\b/.test(trimmed) || /^class\b/.test(trimmed)) {
    return null;
  }

  const declarationMatch = trimmed.match(
    /^(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([\s\S]+)$/,
  );
  const assignmentMatch = declarationMatch
    ?? trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([\s\S]+)$/);
  const subject = assignmentMatch?.[2]?.trim() ?? trimmed;
  const normalizedSubject = stripJsExpressionWrappers(subject);

  if (assignmentMatch && !/^[({[]/.test(trimmed)) {
    const aliasTarget = describeJsLocatorExpression(subject, aliases);
    const methodCall = findLastMethodCall(normalizedSubject, [
      "goto",
      "reload",
      "goBack",
      "goForward",
      "click",
      "dblclick",
      "tap",
      "fill",
      "type",
      "press",
      "check",
      "uncheck",
      "selectOption",
      "hover",
      "scrollIntoViewIfNeeded",
      "focus",
      "dragTo",
    ]);

    if (aliasTarget && !methodCall) {
      aliases.set(assignmentMatch[1]!, aliasTarget);
      return null;
    }
  }

  if (/import\(\s*["'`]playwright-core["'`]\s*\)/.test(normalizedSubject)) {
    return buildJsReplAction(statement, "Loading Playwright...", "Loaded Playwright");
  }

  if (/fetch\([\s\S]*\/extensions\/status/.test(normalizedSubject)) {
    return buildJsReplAction(
      statement,
      "Inspecting browser sessions...",
      "Inspected browser sessions",
    );
  }

  if (/connectOverCDP\(/.test(normalizedSubject)) {
    return buildJsReplAction(statement, "Connecting to browser...", "Connected to browser");
  }

  if (/\bensurePage\(/.test(normalizedSubject)) {
    return buildJsReplAction(statement, "Selecting live page...", "Selected live page");
  }

  const navigationCall = findLastMethodCall(normalizedSubject, [
    "goto",
    "reload",
    "goBack",
    "goForward",
  ]);
  if (navigationCall) {
    if (navigationCall.method === "goto") {
      const url = extractJsArgumentText(navigationCall.args, 0);
      return buildJsReplAction(
        statement,
        formatJsReplTarget("Navigating to", url),
        formatJsReplTarget("Navigated to", url),
      );
    }

    if (navigationCall.method === "reload") {
      return buildJsReplAction(statement, "Reloading page...", "Reloaded page");
    }

    if (navigationCall.method === "goBack") {
      return buildJsReplAction(statement, "Going back...", "Went back");
    }

    if (navigationCall.method === "goForward") {
      return buildJsReplAction(statement, "Going forward...", "Went forward");
    }
  }

  const interactionCall = findLastMethodCall(normalizedSubject, [
    "click",
    "dblclick",
    "tap",
    "fill",
    "type",
    "press",
    "check",
    "uncheck",
    "selectOption",
    "hover",
    "scrollIntoViewIfNeeded",
    "focus",
    "dragTo",
  ]);
  if (interactionCall) {
    const target = describeJsLocatorExpression(interactionCall.objectExpression, aliases);
    const key = extractJsArgumentText(interactionCall.args, 0);

    if (interactionCall.method === "click") {
      return buildJsReplAction(
        statement,
        formatJsReplTarget("Clicking", target),
        formatJsReplTarget("Clicked", target),
      );
    }

    if (interactionCall.method === "dblclick") {
      return buildJsReplAction(
        statement,
        formatJsReplTarget("Double-clicking", target),
        formatJsReplTarget("Double-clicked", target),
      );
    }

    if (interactionCall.method === "tap") {
      return buildJsReplAction(
        statement,
        formatJsReplTarget("Tapping", target),
        formatJsReplTarget("Tapped", target),
      );
    }

    if (interactionCall.method === "fill" || interactionCall.method === "type") {
      return buildJsReplAction(
        statement,
        formatJsReplTarget("Typing in", target),
        formatJsReplTarget("Typed in", target),
      );
    }

    if (interactionCall.method === "press") {
      const pressTarget = target && target !== "keyboard" && target !== "page"
        ? target
        : undefined;
      const suffix = [key, pressTarget].filter(Boolean).join(" in ");
      return buildJsReplAction(
        statement,
        suffix ? `Pressing ${suffix}...` : "Pressing key...",
        suffix ? `Pressed ${suffix}` : "Pressed key",
      );
    }

    if (interactionCall.method === "check") {
      return buildJsReplAction(
        statement,
        formatJsReplTarget("Checking", target),
        formatJsReplTarget("Checked", target),
      );
    }

    if (interactionCall.method === "uncheck") {
      return buildJsReplAction(
        statement,
        formatJsReplTarget("Unchecking", target),
        formatJsReplTarget("Unchecked", target),
      );
    }

    if (interactionCall.method === "selectOption") {
      return buildJsReplAction(
        statement,
        formatJsReplTarget("Selecting option in", target),
        formatJsReplTarget("Selected option in", target),
      );
    }

    if (interactionCall.method === "hover") {
      return buildJsReplAction(
        statement,
        formatJsReplTarget("Hovering", target),
        formatJsReplTarget("Hovered", target),
      );
    }

    if (interactionCall.method === "scrollIntoViewIfNeeded") {
      return buildJsReplAction(
        statement,
        formatJsReplTarget("Scrolling to", target),
        formatJsReplTarget("Scrolled to", target),
      );
    }

    if (interactionCall.method === "focus") {
      return buildJsReplAction(
        statement,
        formatJsReplTarget("Focusing", target),
        formatJsReplTarget("Focused", target),
      );
    }

    if (interactionCall.method === "dragTo") {
      return buildJsReplAction(
        statement,
        formatJsReplTarget("Dragging", target),
        formatJsReplTarget("Dragged", target),
      );
    }
  }

  if (
    /\.(?:title|url|textContent|innerText|allTextContents|content)\(/.test(normalizedSubject)
    || /console\.(?:log|info|dir)\([\s\S]*\bpage\.(?:title|url)\(/.test(normalizedSubject)
    || /\bcontext\.pages\(\)/.test(normalizedSubject)
  ) {
    return buildJsReplAction(statement, "Reading page state...", "Read page state");
  }

  return null;
}

function parseJsReplActions(source: string | undefined): ShellCommandAction[] {
  const normalized = normalizeJsReplSource(source);
  if (!normalized) {
    return [buildJsReplAction(JS_REPL_COMMAND, "Running JavaScript...", "Ran JavaScript")];
  }

  const aliases = new Map<string, string>();
  const actions = splitTopLevelJsStatements(normalized)
    .map((statement) => parseJsReplAction(statement, aliases))
    .filter((value): value is ShellCommandAction => value !== null);

  if (actions.length > 0) {
    return actions;
  }

  return [buildJsReplAction(normalized, "Running JavaScript...", "Ran JavaScript")];
}

function isInlineScriptFlag(value: string): boolean {
  return SCRIPT_INLINE_SOURCE_FLAGS.has(value)
    || value.startsWith("-c")
    || value.startsWith("-e")
    || value.startsWith("--eval=");
}

function isModuleScriptFlag(value: string): boolean {
  return SCRIPT_MODULE_FLAGS.has(value);
}

function hasNonFileScriptSource(base: string, args: string[]): boolean {
  if (!SCRIPT_RUNNERS.has(base)) {
    return false;
  }

  for (const value of args) {
    const normalized = normalizePathToken(value);
    if (normalized === "-" || isInlineScriptFlag(normalized) || isModuleScriptFlag(normalized)) {
      return true;
    }
    if (!normalized.startsWith("-")) {
      return false;
    }
  }

  return false;
}

function scriptPath(base: string, args: string[], cwd: string | undefined) {
  if (!SCRIPT_RUNNERS.has(base)) {
    return undefined;
  }

  for (const value of args) {
    const normalized = normalizePathToken(value);
    if (normalized === "-" || isInlineScriptFlag(normalized) || isModuleScriptFlag(normalized)) {
      return undefined;
    }
    if (value.startsWith("<<")) {
      return undefined;
    }
    if (normalized.startsWith("-")) {
      continue;
    }
    if (!pathLike(normalized)) {
      return undefined;
    }
    return resolvePath(normalized, cwd);
  }

  return undefined;
}

function mentionTypeForPath(path: string): "file" | "directory" {
  return /\.[A-Za-z0-9_-]{1,8}$/.test(path) ? "file" : "directory";
}

function scriptMentions(command: string, cwd: string | undefined) {
  const parts = skipAssignments(splitShell(command));
  if (parts.length === 0) {
    return mention(cwd, "directory");
  }

  const runner = commandRunner(parts);
  const runnerArgs = stripRedirects(runner.args);
  const script = scriptPath(runner.base, runnerArgs, cwd);
  if (script) {
    return mention(script, mentionTypeForPath(script));
  }

  return mention(cwd, "directory");
}

function scriptSummaryAction(command: string, cwd: string | undefined): ShellCommandAction {
  const mentions = scriptMentions(command, cwd);

  if (/\bcommand\s+-v\b|\bwhich\b/.test(command)) {
    return action({
      kind: "run",
      label: "Check tools",
      active: "Checking installed commands...",
      past: "Checked installed commands",
      command,
      mentions,
    });
  }

  return action({
    kind: "run",
    label: "Run script",
    active: "Running shell script...",
    past: "Ran shell script",
    command,
    mentions,
  });
}

function actionKey(value: ShellCommandAction) {
  return [
    value.kind,
    value.command,
    value.query ?? "",
  ].join("\u0000");
}

function uniqActions(actions: ShellCommandAction[]) {
  return [...actions.reduce((memo, entry) => {
    const key = actionKey(entry);
    const prev = memo.get(key);
    if (!prev) {
      memo.set(key, entry);
      return memo;
    }

    memo.set(key, {
      ...prev,
      mentions: uniqMentions([...prev.mentions, ...entry.mentions]),
    });
    return memo;
  }, new Map<string, ShellCommandAction>()).values()];
}

function looksLikeSedExpression(value: string) {
  if (!value || (value[0] !== "s" && value[0] !== "y")) {
    return false;
  }

  const delimiter = value[1];
  if (!delimiter || /[A-Za-z0-9\s\\]/.test(delimiter)) {
    return false;
  }

  const second = value.indexOf(delimiter, 2);
  if (second < 0) {
    return false;
  }

  const third = value.indexOf(delimiter, second + 1);
  return third >= 0;
}

function readMentions(base: string, args: string[], cwd: string | undefined) {
  const values = MULTI_READ_COMMANDS.has(base)
    ? positional(args)
    : LAST_READ_COMMANDS.has(base)
      ? positional(args).slice(-1)
      : positional(args);

  return uniqMentions(
    values
      .filter((value) => !(base === "sed" && looksLikeSedExpression(value)))
      .filter(pathLike)
      .flatMap((value) => mention(resolvePath(value, cwd), "file")),
  );
}

function parseShellSegment(command: string, cwd: string | undefined) {
  const parts = skipAssignments(splitShell(command));
  if (parts.length === 0) {
    return { cwd, actions: [] as ShellCommandAction[] };
  }

  const builtinTool = parseInterpreterAppBuiltinToolCommand(command, cwd);
  if (builtinTool) {
    return {
      cwd,
      actions: [action({
        kind: builtinTool.kind,
        label: builtinTool.label,
        active: builtinTool.active,
        past: builtinTool.past,
        command,
        mentions: builtinTool.mentions,
      })],
    };
  }

  const serviceTool = parseInterpreterAppServiceToolCommand(command);
  if (serviceTool) {
    return {
      cwd,
      actions: [action({
        kind: "run",
        label: serviceTool.toolLabel,
        active: serviceTool.active,
        past: serviceTool.past,
        command,
        service: serviceTool,
        mentions: [],
      })],
    };
  }

  const args = positional(parts.slice(1));

  const nextCwd = (
    commandBase(parts[0]) === "cd"
    && typeof args[0] === "string"
  )
    ? resolvePath(args[0], cwd) ?? cwd
    : cwd;

  if (commandBase(parts[0]) === "cd") {
    return { cwd: nextCwd, actions: [] as ShellCommandAction[] };
  }

  const runner = commandRunner(parts);
  const shellArgs = stripRedirects(runner.args);
  const base = runner.base;
  const paths = genericCandidatePaths(base, shellArgs, positional(shellArgs), cwd);
  const redirects = outputRedirectMentions(runner.args, cwd);
  const runnerArgs = positional(shellArgs);

  if (isCatHeredocWrite(command, base, redirects)) {
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "write",
        label: "Create",
        active: "Creating file...",
        past: "Created",
        command,
        mentions: redirects,
      })],
    };
  }

  if (base === "pwd") {
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "list",
        label: "Explore folder",
        active: "Exploring folder...",
        past: "Explored folder",
        command,
        mentions: mention(cwd, "directory"),
      })],
    };
  }

  if (base === "sleep") {
    const duration = sleepDurationText(runnerArgs);
    const active = duration ? `Waiting for ${duration}...` : "Waiting...";
    const past = duration ? `Waited for ${duration}` : "Waited";
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "run",
        label: "Wait",
        active,
        past,
        command,
        mentions: [],
      })],
    };
  }

  if (base === "clear" || base === "cls") {
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "run",
        label: "Clear terminal",
        active: "Clearing terminal...",
        past: "Cleared terminal",
        command,
        mentions: [],
      })],
    };
  }

  if (base === "date") {
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "run",
        label: "Check time",
        active: "Checking time...",
        past: "Checked time",
        command,
        mentions: [],
      })],
    };
  }

  if (base === "history") {
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "run",
        label: "View history",
        active: "Viewing history...",
        past: "Viewed history",
        command,
        mentions: [],
      })],
    };
  }

  if (OPEN_COMMANDS.has(base)) {
    const target = runnerArgs.find((value) => pathLike(value));
    const targetPath = resolvePath(target, cwd);
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "run",
        label: "Open",
        active: "Opening...",
        past: "Opened",
        command,
        mentions: targetPath ? mention(targetPath, mentionTypeForPath(targetPath)) : [],
      })],
    };
  }

  if (READ_COMMANDS.has(base)) {
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "read",
        label: "Read",
        active: "Reading file...",
        past: "Read",
        command,
        mentions: [...readMentions(base, shellArgs, cwd), ...redirects],
      })],
    };
  }

  if (SEARCH_COMMANDS.has(base)) {
    const query = runnerArgs[0] ?? firstQuery(shellArgs);
    const scoped = resolvePath(runnerArgs[1], cwd) ?? paths[0] ?? cwd;
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "search",
        label: "Search",
        active: "Searching...",
        past: "Searched",
        command,
        query,
        mentions: mention(scoped, "directory"),
      })],
    };
  }

  if (LIST_COMMANDS.has(base)) {
    const target = resolvePath(runnerArgs[0], cwd) ?? paths[0] ?? cwd;
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "list",
        label: "Explore",
        active: "Exploring folder...",
        past: "Explored folder",
        command,
        mentions: mention(target, "directory"),
      })],
    };
  }

  if (base === "touch") {
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "write",
        label: "Create",
        active: "Creating file...",
        past: "Created",
        command,
        mentions: runnerArgs.flatMap((value) => mention(resolvePath(value, cwd), "file")),
      })],
    };
  }

  if (base === "mkdir") {
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "write",
        label: "Create",
        active: "Creating folder...",
        past: "Created",
        command,
        mentions: runnerArgs.flatMap((value) => mention(resolvePath(value, cwd), "directory")),
      })],
    };
  }

  if (base === "cp") {
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "copy",
        label: "Copy",
        active: "Copying...",
        past: "Copied",
        command,
        mentions: runnerArgs.flatMap((value) => mention(resolvePath(value, cwd), "file")),
      })],
    };
  }

  if (base === "mv") {
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "move",
        label: "Move",
        active: "Moving...",
        past: "Moved",
        command,
        mentions: runnerArgs.flatMap((value) => mention(resolvePath(value, cwd), "file")),
      })],
    };
  }

  if (base === "rm") {
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "delete",
        label: "Delete",
        active: "Deleting...",
        past: "Deleted",
        command,
        mentions: runnerArgs.flatMap((value) => mention(resolvePath(value, cwd), "file")),
      })],
    };
  }

  if (base === "git") {
    const subcommand = firstQuery(runner.args) ?? runner.args[0];
    const query = subcommand === "grep" ? firstQuery(runner.args.slice(1)) : undefined;
    const scoped = runnerArgs.slice(1).length > 0
      ? runnerArgs.slice(1).flatMap((value) => mention(resolvePath(value, cwd), /\.[A-Za-z0-9_-]{1,8}$/.test(value) ? "file" : "directory"))
      : mention(cwd, "directory");
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "git",
        label: "Git",
        active: "Working in git...",
        past: subcommand ? `Git ${subcommand}` : "Used git",
        command,
        query,
        mentions: scoped,
      })],
    };
  }

  if (
    TEST_COMMANDS.has(base)
    || (runner.program === "bun" && runner.base === "test")
    || (runner.program === "pnpm" && runner.base === "test")
    || (runner.program === "npm" && runner.base === "test")
    || (runner.program === "yarn" && runner.base === "test")
  ) {
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "test",
        label: "Test",
        active: "Running checks...",
        past: "Ran checks",
        command,
        mentions: runnerArgs.flatMap((value) => mention(resolvePath(value, cwd), "file")),
      })],
    };
  }

  const script = scriptPath(base, shellArgs, cwd);
  if (script) {
    return {
      cwd: nextCwd,
      actions: [action({
        kind: "run",
        label: "Run script",
        active: "Running script...",
        past: "Ran script",
        command,
        mentions: [...mention(script, "file"), ...redirects],
      })],
    };
  }

  const genericMentions = uniqMentions([
    ...paths.flatMap((value) => mention(value, /\.[A-Za-z0-9_-]{1,8}$/.test(value) ? "file" : "directory")),
    ...redirects,
  ]);

  return {
    cwd: nextCwd,
    actions: [action({
      kind: "run",
      label: "Run",
      active: "Running command...",
      past: "Ran command",
      command,
      mentions: genericMentions,
    })],
  };
}

function actionsFromCommandActions(actions: v2.CommandAction[], cwd: string | undefined) {
  return actions.flatMap((entry) => {
    if (entry.type === "read") {
      return [action({
        kind: "read",
        label: "Read",
        active: "Reading file...",
        past: "Read",
        command: entry.command,
        mentions: mention(resolvePath(entry.path, cwd), "file"),
      })];
    }

    if (entry.type === "listFiles") {
      return [action({
        kind: "list",
        label: "Explore",
        active: "Exploring folder...",
        past: "Explored folder",
        command: entry.command,
        mentions: mention(resolvePath(entry.path ?? cwd, cwd), "directory"),
      })];
    }

    if (entry.type === "search") {
      return [action({
        kind: "search",
        label: "Search",
        active: "Searching...",
        past: "Searched",
        command: entry.command,
        query: entry.query ?? undefined,
        mentions: mention(resolvePath(entry.path ?? cwd, cwd), "directory"),
      })];
    }

    return [];
  });
}

export function extractCommandActions(
  item: Extract<v2.ThreadItem, { type: "commandExecution" }>,
  sourceInput?: string,
  sourceToolName?: string,
) {
  if (isJsReplCommandExecution(item, sourceToolName)) {
    return uniqActions(parseJsReplActions(sourceInput));
  }

  const primary = item.commandActions.length > 0
    ? actionsFromCommandActions(item.commandActions, item.cwd)
    : [];
  const fallback = parseShellActions(item.command, item.cwd)
    .filter((entry) => primary.length === 0 || entry.kind !== "run");
  return uniqActions([...primary, ...fallback]);
}

export function unwrapShellCommand(command: string): string {
  const parts = splitShell(command);
  const program = commandBase(parts[0]);

  if (
    SHELL_WRAPPERS.has(program)
    && (parts[1] === "-lc" || parts[1] === "-c")
    && typeof parts[2] === "string"
  ) {
    return unwrapShellCommand(parts[2]);
  }

  if (POWERSHELL_WRAPPERS.has(program.toLowerCase())) {
    const commandFlagIndex = parts.findIndex((part, index) => (
      index > 0 && POWERSHELL_COMMAND_FLAGS.has(part.toLowerCase())
    ));
    if (commandFlagIndex >= 0) {
      const script = parts[commandFlagIndex + 1];
      if (typeof script !== "string") return command;
      return unwrapShellCommand(script);
    }
  }

  return command;
}

export function parseShellActions(command: string, cwd?: string): ShellCommandAction[] {
  const raw = unwrapShellCommand(command);
  if (looksLikeShellScript(raw)) {
    return [scriptSummaryAction(raw, cwd)];
  }
  const segments = splitCommandSegments(raw);
  const state = segments.reduce(
    (memo, segment) => {
      const parsed = parseShellSegment(segment, memo.cwd);
      return {
        cwd: parsed.cwd,
        actions: [...memo.actions, ...parsed.actions],
      };
    },
    { cwd, actions: [] as ShellCommandAction[] },
  );

  if (state.actions.length > 0) {
    return state.actions;
  }

  return [action({
    kind: "run",
    label: "Run",
    active: "Running command...",
    past: "Ran command",
    command: raw,
    mentions: mention(cwd, "directory"),
  })];
}

export function extractToolVerb(item: v2.ThreadItem): { active: string; past: string } {
  if (item.type === "commandExecution") {
    return commandExecutionDisplay(item)?.verb ?? ITEM_TYPE_VERBS.commandExecution;
  }
  if (item.type === "mcpToolCall") {
    const toolName = displayToolName(item.tool);
    const display = getToolDisplay(toolName);
    if (display) return display.verb;
    return DEFAULT_DISPLAY.verb;
  }
  return ITEM_TYPE_VERBS[item.type] ?? DEFAULT_DISPLAY.verb;
}

export function extractToolCategory(item: v2.ThreadItem): ToolCategory {
  if (item.type === "commandExecution") {
    const builtinTool = parseInterpreterAppBuiltinToolCommand(item.command, item.cwd);
    if (builtinTool) {
      return builtinTool.kind === "read" || builtinTool.kind === "list" || builtinTool.kind === "search"
        ? "explore"
        : builtinTool.kind === "write"
          ? "edit"
          : "run";
    }

    const serviceTool = parseInterpreterAppServiceToolCommand(item.command);
    if (serviceTool) {
      const lowerTool = serviceTool.toolName.toLowerCase();
      if (lowerTool.includes("list") || lowerTool.includes("get") || lowerTool.includes("read") || lowerTool.includes("search")) {
        return "explore";
      }
      if (lowerTool.includes("stage") || lowerTool.includes("create") || lowerTool.includes("update") || lowerTool.includes("send")) {
        return "edit";
      }
      return "run";
    }
  }

  if (item.type === "mcpToolCall") {
    const toolName = displayToolName(item.tool);
    return getToolDisplay(toolName)?.category ?? DEFAULT_DISPLAY.category;
  }

  return ITEM_TYPE_CATEGORIES[item.type] ?? DEFAULT_DISPLAY.category;
}

export function extractToolTarget(item: v2.ThreadItem): string | undefined {
  switch (item.type) {
    case "mcpToolCall": {
      const args = item.arguments as Record<string, unknown> | null;
      if (!args || typeof args !== "object") return undefined;
      const pathArg = args.file_path ?? args.path ?? args.filename;
      if (typeof pathArg === "string") return pathBasename(pathArg);
      const cmdArg = args.command;
      if (typeof cmdArg === "string") return cmdArg;
      return undefined;
    }
    case "fileChange":
      return item.changes[0]?.path ? pathBasename(item.changes[0].path) : undefined;
    case "commandExecution":
      return commandExecutionDisplay(item)?.target ?? item.command;
    case "webSearch":
      return item.query;
    case "imageView":
      return pathBasename(item.path);
    default:
      return undefined;
  }
}

export function extractToolFilePath(item: v2.ThreadItem): string | undefined {
  switch (item.type) {
    case "mcpToolCall": {
      const args = item.arguments as Record<string, unknown> | null;
      if (!args || typeof args !== "object") return undefined;
      const pathArg = args.file_path ?? args.path ?? args.filename;
      if (typeof pathArg === "string") return pathArg;
      return undefined;
    }
    case "fileChange":
      return item.changes[0]?.path ?? undefined;
    case "imageView":
      return item.path;
    default:
      return undefined;
  }
}

export function extractToolPaths(item: v2.ThreadItem): string[] {
  if (item.type === "mcpToolCall") {
    const args = item.arguments as Record<string, unknown> | null;
    if (!args || typeof args !== "object") return [];
    const path = [args.file_path, args.path, args.filename].find((value) => typeof value === "string");
    if (typeof path === "string") return [path];
    const values = [args.paths, args.files, args.file_paths].find(Array.isArray);
    if (!Array.isArray(values)) return [];
    return values.filter((value): value is string => typeof value === "string");
  }

  if (item.type === "fileChange") {
    return item.changes
      .map((change) => change.kind.type === "update" && change.kind.move_path ? change.kind.move_path : change.path)
      .filter(Boolean);
  }

  if (item.type === "imageView") return [item.path];
  if (item.type === "commandExecution") {
    return uniqMentions(extractCommandActions(item).flatMap((entry) => entry.mentions)).map((entry) => entry.path);
  }

  return [];
}

export function extractToolQuery(item: v2.ThreadItem): string | undefined {
  if (item.type === "webSearch") return item.query;
  if (item.type !== "mcpToolCall") {
    if (item.type !== "commandExecution") return undefined;
    return extractCommandActions(item)
      .find((entry) => typeof entry.query === "string" && entry.query.trim().length > 0)
      ?.query;
  }

  const args = item.arguments as Record<string, unknown> | null;
  if (!args || typeof args !== "object") return undefined;
  const keys = ["query", "pattern", "search_term", "text", "needle"] as const;
  const value = keys
    .map((key) => args[key])
    .find((entry) => typeof entry === "string" && entry.trim().length > 0);
  return typeof value === "string" ? value : undefined;
}

export function parseShellCommand(command: string): ShellCommandIntent {
  const raw = unwrapShellCommand(command);
  const first = parseShellActions(command)[0];
  const runner = commandRunner(skipAssignments(splitShell(raw)));

  if (!first) {
    return {
      kind: "run",
      label: "Run command",
      program: runner.program,
    };
  }

  return {
    kind: first.kind === "write" || first.kind === "delete" || first.kind === "move" || first.kind === "copy"
      ? "run"
      : first.kind,
    label: first.label,
    program: runner.program,
    subcommand: first.kind === "git" ? first.past.replace(/^Git\s+/i, "") : undefined,
    path: first.mentions[0]?.path,
    query: first.query,
  };
}

export function isFailedToolItem(item: v2.ThreadItem): boolean {
  if (item.type === "commandExecution") {
    return item.status === "failed" || item.status === "declined";
  }
  if (item.type === "mcpToolCall") {
    return item.status === "failed";
  }
  if (item.type === "fileChange") {
    return item.status === "failed" || item.status === "declined";
  }
  if (item.type === "collabAgentToolCall") {
    return item.status === "failed";
  }
  return false;
}
