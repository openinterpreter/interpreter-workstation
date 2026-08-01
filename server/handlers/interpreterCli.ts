import lodash from 'lodash';
import { agentTabManager } from '../agentTabManager';
import { getGlobalDisabledToolsSync } from '../configStore';
import {
  getBuiltinServerIncludingHidden,
  getBuiltinServersIncludingHidden,
  isHiddenBuiltinServerId,
} from '../tools/builtinTools';
import type { ToolServerStatus } from '../tools/toolTypes';
import { getToolManager } from '../tools/toolManagerAccessor';
import { runWithWorkspaceOverride } from '../utils/workspace';
import {
  createAllowedToolSet,
  matchesAllowedToolScope,
} from '../utils/toolScope';
import { runWithWindowSessionOverride } from '../utils/windowSessions';
import { isToolServerAgentAccessible } from '../../shared/toolServerAvailability';
import { isInterpreterCliToolVisible } from '../../shared/utils/interpreterToolSurface';
import { prefixToolName } from '../../shared/utils/mcpToolName';
import {
  INTERPRETER_CONFIG_ALIAS_ROOTS,
  INTERPRETER_CONFIG_PATH_ALIASES,
} from "../../shared/settingsCatalog";
import { INTERPRETER_CLI_COMMAND } from "../utils/interpreterCliRuntime";
import { requestInterpreterRuntimeRestart } from "../utils/interpreterRuntimeRestart";
import { classifyReadToolPromptInjection } from "../utils/readToolPromptInjectionGuard";

const { get, set, unset } = lodash;

type JsonObject = Record<string, unknown>;
type ToolInputSchema = {
  type?: unknown;
  required?: unknown;
};
type InterpreterCliToolInfo = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    [key: string]: unknown;
  };
};
type InterpreterCliServerInfo = {
  id: string;
  name: string;
  description?: string;
  tools: InterpreterCliToolInfo[];
};
type InterpreterCliServerSummaryInfo = {
  id: string;
  name: string;
  description?: string;
  toolCount: number;
};
type InterpreterCliToolSearchMatch = {
  qualifiedName: string;
  server: {
    id: string;
    name: string;
    description?: string;
  };
  tool: InterpreterCliToolInfo;
};
type InterpreterCliToolCallResult = {
  content?: Array<{
    type?: unknown;
    text?: unknown;
    image?: {
      data?: unknown;
      mimeType?: unknown;
    };
    [key: string]: unknown;
  }>;
  structuredContent?: unknown;
  isError?: boolean;
  is_error?: boolean;
  savedToPath?: unknown;
  imagePaths?: unknown;
};
type InterpreterCliProgressHandler = (text: string) => void | Promise<void>;

const INTERPRETER_CONFIG_ALIAS_ROOT_SET = new Set(
  INTERPRETER_CONFIG_ALIAS_ROOTS,
);

function summarizeToolArgs(args: JsonObject): string {
  const summary: JsonObject = {};
  for (const key of ['pid', 'window_id', 'automation_id', 'element_index', 'key', 'direction', 'path', 'app', 'window_style']) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      summary[key] = args[key];
    }
  }
  if (typeof args.text === 'string') {
    summary.text_chars = args.text.length;
  }
  if (typeof args.value === 'string') {
    summary.value_chars = args.value.length;
  }
  const argKeys = Object.keys(args).sort();
  return JSON.stringify({ ...summary, arg_keys: argKeys });
}

function summarizeToolResult(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return JSON.stringify({ result_type: typeof result });
  }
  const toolResult = result as InterpreterCliToolCallResult;
  const text = extractToolResultText(toolResult);
  const isError = toolResult.isError === true || toolResult.is_error === true;
  if (!text) {
    return JSON.stringify({ has_text: false, is_error: isError });
  }
  try {
    const parsed = JSON.parse(text) as {
      ok?: unknown;
      tool?: unknown;
      data?: Record<string, unknown>;
      error?: Record<string, unknown>;
    };
    const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
    const error = parsed.error && typeof parsed.error === 'object' ? parsed.error : {};
    const summary: JsonObject = {
      ok: parsed.ok,
      tool: parsed.tool,
    };
    for (const key of ['action', 'pid', 'window_id', 'automation_id', 'rendered', 'overlay_pid', 'real_cursor_moved']) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        summary[key] = data[key];
      }
    }
    if (typeof error.code === 'string') {
      summary.error_code = error.code;
    }
    return JSON.stringify(summary);
  } catch {
    return JSON.stringify({ text_chars: text.length, is_error: isError });
  }
}

function isInterpreterCliToolCallError(result: unknown): boolean {
  if (!result || typeof result !== 'object') {
    return false;
  }
  const toolResult = result as InterpreterCliToolCallResult;
  if (toolResult.isError === true || toolResult.is_error === true) {
    return true;
  }
  if (hasErrorFlag(toolResult.structuredContent)) {
    return true;
  }
  for (const item of toolResult.content ?? []) {
    if (typeof item.text !== 'string') {
      continue;
    }
    try {
      if (hasErrorFlag(JSON.parse(item.text))) {
        return true;
      }
    } catch {
      // Non-JSON text is ordinary tool output.
    }
  }
  return false;
}

function isReadOnlyInterpreterCliTool(params: {
  serverId: string;
  toolName: string;
  toolSpec: InterpreterCliToolInfo;
}): boolean {
  const builtinServer = getBuiltinServerIncludingHidden(params.serverId);
  const builtinTool = builtinServer?.tools.find((tool) => tool.name === params.toolName);
  if (builtinTool) {
    return builtinTool.annotations?.readOnlyHint === true || builtinTool.mode === 'read';
  }
  return params.toolSpec.annotations?.readOnlyHint === true;
}

async function applyReadToolPromptInjectionGuard(params: {
  serverId: string;
  toolName: string;
  args: JsonObject;
  result: unknown;
  enabled: boolean;
}): Promise<unknown> {
  if (!params.enabled || isInterpreterCliToolCallError(params.result)) {
    return params.result;
  }

  const resultText = extractToolResultText(params.result as InterpreterCliToolCallResult);
  if (!resultText?.trim()) {
    return params.result;
  }

  const decision = await classifyReadToolPromptInjection({
    serverId: params.serverId,
    toolName: params.toolName,
    args: params.args,
    resultText,
  });
  if (!decision || decision.verdict === 'allow') {
    return params.result;
  }

  return {
    content: [{
      type: 'text',
      text: `Read tool result blocked by prompt-injection guard: ${decision.reason}`,
    }],
    isError: true,
  };
}

function formatCliImageNotice(
  result: InterpreterCliToolCallResult,
  imageIndex: number,
): string {
  const imagePaths = Array.isArray(result.imagePaths)
    ? result.imagePaths.filter((value): value is string => typeof value === 'string')
    : [];
  const path = imagePaths[imageIndex]
    ?? (typeof result.savedToPath === 'string' ? result.savedToPath : undefined);
  return path
    ? `Image content is available at: ${path}`
    : 'Image content is not serialized into CLI stdout. Use the direct injected tool transport for structured image content.';
}

function serializeToolResultForCliTextTransport(result: unknown): unknown {
  if (!result || typeof result !== 'object') {
    return result;
  }
  const toolResult = result as InterpreterCliToolCallResult;
  const content = toolResult.content;
  if (!Array.isArray(content) || !content.some((item) => item?.type === 'image')) {
    return result;
  }

  let imageIndex = 0;
  return {
    ...toolResult,
    content: content.map((item) => {
      if (item?.type !== 'image') {
        return item;
      }
      const notice = formatCliImageNotice(toolResult, imageIndex);
      imageIndex += 1;
      return {
        type: 'text',
        text: notice,
      };
    }),
  };
}

function hasErrorFlag(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && (
      (value as InterpreterCliToolCallResult).isError === true
      || (value as InterpreterCliToolCallResult).is_error === true
    )
  );
}

function mapConfigPathPrefix(path: string, from: string, to: string): string | null {
  if (path === from) {
    return to;
  }
  if (path.startsWith(`${from}.`) || path.startsWith(`${from}[`)) {
    return `${to}${path.slice(from.length)}`;
  }
  return null;
}

function toRawInterpreterConfigPath(path: string): string {
  for (const mapping of INTERPRETER_CONFIG_PATH_ALIASES) {
    const mapped = mapConfigPathPrefix(path, mapping.alias, mapping.raw);
    if (mapped !== null) {
      return mapped;
    }
  }
  return path;
}

function toAliasInterpreterConfigPath(path: string): string {
  for (const mapping of INTERPRETER_CONFIG_PATH_ALIASES) {
    const mapped = mapConfigPathPrefix(path, mapping.raw, mapping.alias);
    if (mapped !== null) {
      return mapped;
    }
  }
  return path;
}

function remapInterpreterConfigForCli(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const next = structuredClone(value) as Record<string, unknown>;
  for (const mapping of INTERPRETER_CONFIG_PATH_ALIASES) {
    const rawValue = get(next, mapping.raw);
    if (rawValue !== undefined) {
      set(next, mapping.alias, rawValue);
      unset(next, mapping.raw);
    }
  }
  return next;
}

function isAliasRootPath(path: string): boolean {
  return INTERPRETER_CONFIG_ALIAS_ROOT_SET.has(path);
}

function stringSimilarity(a: string, b: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  if (aLower === bLower) {
    return 1;
  }
  const normalizePhrase = (value: string): string => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ');
  const hasPhraseBoundaryMatch = (haystack: string, needle: string): boolean => {
    if (!haystack || !needle) {
      return false;
    }
    return ` ${haystack} `.includes(` ${needle} `);
  };
  const aPhrase = normalizePhrase(aLower);
  const bPhrase = normalizePhrase(bLower);
  if (aPhrase && bPhrase && (hasPhraseBoundaryMatch(aPhrase, bPhrase) || hasPhraseBoundaryMatch(bPhrase, aPhrase))) {
    return 0.85;
  }
  const aTokens = [...new Set(aLower.split(/[^a-z0-9]+/).filter(Boolean))];
  const bTokens = [...new Set(bLower.split(/[^a-z0-9]+/).filter(Boolean))];
  if (aTokens.length === 0 || bTokens.length === 0) {
    return 0;
  }
  let common = 0;
  let softCommon = 0;
  for (const token of aTokens) {
    if (bTokens.includes(token)) {
      common += 1;
      continue;
    }
    const partialMatch = bTokens.some((candidate) => (
      token.length >= 4
      && candidate.length >= 4
      && (token.startsWith(candidate) || candidate.startsWith(token))
    ));
    if (partialMatch) {
      softCommon += 0.8;
    }
  }
  return (common + softCommon) / Math.max(aTokens.length, bTokens.length);
}

function getClosestMatches<T>(
  query: string,
  candidates: T[],
  getValue: (candidate: T) => string,
  limit: number = 3,
): T[] {
  return [...candidates]
    .map((candidate) => ({
      candidate,
      value: getValue(candidate),
      score: stringSimilarity(query, getValue(candidate)),
    }))
    .filter(({ score }) => score >= 0.3)
    .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value))
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

function scoreToolSearchMatch(
  query: string,
  server: InterpreterCliServerInfo,
  tool: InterpreterCliToolInfo,
): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }

  const serverId = server.id.toLowerCase();
  const serverName = server.name.toLowerCase();
  const serverDescription = (server.description ?? "").toLowerCase();
  const toolName = tool.name.toLowerCase();
  const toolDescription = (tool.description ?? "").toLowerCase();
  const qualifiedName = prefixToolName(server.id, tool.name).toLowerCase();
  const tokenize = (value: string): string[] => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const queryTokens = tokenize(normalizedQuery);
  const qualifiedTokens = tokenize(qualifiedName);
  const toolNameTokens = tokenize(toolName);
  const serverIdTokens = tokenize(serverId);
  const serverNameTokens = tokenize(serverName);
  const toolDescriptionTokens = tokenize(toolDescription);
  const serverDescriptionTokens = tokenize(serverDescription);
  const toolTokenSet = new Set(toolNameTokens);
  const serverTokenSet = new Set([
    ...serverIdTokens,
    ...serverNameTokens,
  ]);
  const primaryTokens = new Set([
    ...qualifiedTokens,
    ...toolNameTokens,
    ...serverIdTokens,
    ...serverNameTokens,
  ]);
  const secondaryTokens = new Set([
    ...toolDescriptionTokens,
    ...serverDescriptionTokens,
  ]);
  const searchableTokens = new Set([
    ...primaryTokens,
    ...secondaryTokens,
  ]);
  const normalizePhrase = (value: string): string => tokenize(value).join(' ');
  const queryPhrase = normalizePhrase(normalizedQuery);
  const qualifiedPhrase = normalizePhrase(qualifiedName);
  const toolPhrase = normalizePhrase(toolName);
  const serverIdPhrase = normalizePhrase(serverId);
  const serverNamePhrase = normalizePhrase(serverName);
  const toolDescriptionPhrase = normalizePhrase(toolDescription);
  const serverDescriptionPhrase = normalizePhrase(serverDescription);
  const containsPhrase = (haystack: string): boolean => (
    Boolean(queryPhrase && haystack && ` ${haystack} `.includes(` ${queryPhrase} `))
  );
  const tokenCoverageFor = (candidateTokens: Set<string>): number => {
    if (queryTokens.length === 0) {
      return 0;
    }
    const matchedTokens = queryTokens.filter((token) => candidateTokens.has(token)).length;
    return matchedTokens / queryTokens.length;
  };

  let score = Math.max(
    stringSimilarity(normalizedQuery, qualifiedName),
    stringSimilarity(normalizedQuery, toolName),
    stringSimilarity(normalizedQuery, serverId),
    stringSimilarity(normalizedQuery, serverName),
    toolDescription ? stringSimilarity(normalizedQuery, toolDescription) : 0,
    serverDescription
      ? stringSimilarity(normalizedQuery, serverDescription)
      : 0,
  );

  if (qualifiedName === normalizedQuery || toolName === normalizedQuery) {
    score = Math.max(score, 1.6);
  } else if (containsPhrase(qualifiedPhrase)) {
    score = Math.max(score, 1.35);
  } else if (containsPhrase(toolPhrase)) {
    score = Math.max(score, 1.25);
  } else if (containsPhrase(serverIdPhrase) || containsPhrase(serverNamePhrase)) {
    score = Math.max(score, 0.95);
  } else if (containsPhrase(toolDescriptionPhrase) || containsPhrase(serverDescriptionPhrase)) {
    score = Math.max(score, 0.75);
  }

  if (queryTokens.length > 0) {
    const toolCoverage = tokenCoverageFor(toolTokenSet);
    const serverCoverage = tokenCoverageFor(serverTokenSet);
    const primaryCoverage = tokenCoverageFor(primaryTokens);
    const secondaryCoverage = tokenCoverageFor(secondaryTokens);
    const tokenCoverage = tokenCoverageFor(searchableTokens);
    const leadingQueryToken = queryTokens[0];

    if (primaryCoverage >= 1) {
      score = Math.max(score, 1.5);
    } else if (primaryCoverage >= 0.67) {
      score = Math.max(score, 1.2);
    } else if (primaryCoverage >= 0.34) {
      score = Math.max(score, 0.9);
    }

    if (secondaryCoverage >= 1) {
      score = Math.max(score, 1.05);
    } else if (secondaryCoverage >= 0.67) {
      score = Math.max(score, 0.92);
    } else if (secondaryCoverage >= 0.34) {
      score = Math.max(score, 0.82);
    }

    if (tokenCoverage >= 1) {
      score = Math.max(score, 1.42);
    } else if (tokenCoverage >= 0.67) {
      score = Math.max(score, 1.08);
    } else if (tokenCoverage >= 0.34) {
      score = Math.max(score, 0.8);
    }

    if (leadingQueryToken) {
      if (toolTokenSet.has(leadingQueryToken)) {
        score += 0.22;
      } else if (serverTokenSet.has(leadingQueryToken)) {
        score += 0.08;
      }
    }

    score += toolCoverage * 0.25;
    score += serverCoverage * 0.08;
  }

  return score;
}

function formatSuggestionList(values: string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

function formatToolCommand(
  serverId: string,
  toolName: string,
  suffix: string = "",
): string {
  const command = `${INTERPRETER_CLI_COMMAND} tools ${serverId} ${toolName}`;
  return suffix ? `${command} ${suffix}` : command;
}

function formatSchema(inputSchema: unknown): string | null {
  if (!inputSchema || typeof inputSchema !== "object") {
    return null;
  }
  try {
    return JSON.stringify(inputSchema);
  } catch {
    return null;
  }
}

function buildServerUnavailableError(
  serverId: string,
  servers: InterpreterCliServerInfo[],
  requestedToolName?: string,
): Error {
  const messageParts = [`Tool server '${serverId}' is not available.`];
  const similarServers = getClosestMatches(
    serverId,
    servers,
    (server) => server.id,
  );
  if (similarServers.length > 0) {
    messageParts.push(
      `Did you mean ${formatSuggestionList([similarServers[0]!.id])}?`,
    );
    if (similarServers.length > 1) {
      messageParts.push(
        `Other similar visible servers: ${formatSuggestionList(similarServers.slice(1).map((server) => server.id))}.`,
      );
    }
  }

  if (requestedToolName) {
    const matchingTools = servers
      .filter((server) =>
        server.tools.some((tool) => tool.name === requestedToolName),
      )
      .map((server) =>
        formatToolCommand(server.id, requestedToolName, "--help"),
      );
    if (matchingTools.length > 0) {
      messageParts.push(`Try: ${formatSuggestionList(matchingTools)}.`);
    }
  }

  return new Error(messageParts.join(" "));
}

function buildToolNotFoundError(
  server: InterpreterCliServerInfo,
  toolName: string,
  servers: InterpreterCliServerInfo[],
): Error {
  const messageParts = [
    `Tool '${toolName}' was not found on server '${server.id}'.`,
  ];
  const similarTools = getClosestMatches(
    toolName,
    server.tools,
    (tool) => tool.name,
  );
  if (similarTools.length > 0) {
    messageParts.push(
      `Did you mean ${formatSuggestionList([similarTools[0]!.name])}?`,
    );
    if (similarTools.length > 1) {
      messageParts.push(
        `Other similar tools on '${server.id}': ${formatSuggestionList(similarTools.slice(1).map((tool) => tool.name))}.`,
      );
    }
    messageParts.push(
      `Try: '${formatToolCommand(server.id, similarTools[0]!.name, "--help")}'.`,
    );
  }

  const matchingToolsOnOtherServers = servers
    .filter(
      (candidate) =>
        candidate.id !== server.id &&
        candidate.tools.some((tool) => tool.name === toolName),
    )
    .map((candidate) => formatToolCommand(candidate.id, toolName, "--help"));
  if (matchingToolsOnOtherServers.length > 0) {
    messageParts.push(
      `Same tool name on other visible servers: ${formatSuggestionList(matchingToolsOnOtherServers)}.`,
    );
  }

  return new Error(messageParts.join(" "));
}

function buildMissingRequiredArgsError(params: {
  serverId: string;
  toolName: string;
  missingRequiredArgs: string[];
  inputSchema?: unknown;
}): Error {
  const messageParts = [
    `Missing required args for '${formatToolCommand(params.serverId, params.toolName)}': ${params.missingRequiredArgs.join(", ")}.`,
    `Run '${formatToolCommand(params.serverId, params.toolName, "--help")}' for the full schema.`,
  ];
  const schema = formatSchema(params.inputSchema);
  if (schema) {
    messageParts.push(`Input schema: ${schema}`);
  }
  return new Error(messageParts.join(" "));
}

function requireCallerBinding(callerToken: string) {
  const binding = agentTabManager.getBindingForCallerToken(callerToken);
  if (!binding?.agentId) {
    throw new Error("Unknown interpreter caller token.");
  }
  return binding;
}

function getScopedHiddenBuiltinServers(
  allowedTools: Set<string> | null,
): InterpreterCliServerInfo[] {
  if (!allowedTools) {
    return [];
  }

  return getBuiltinServersIncludingHidden()
    .filter((server) => isHiddenBuiltinServerId(server.id))
    .map((server) => ({
      id: server.id,
      name: server.name,
      description: server.description,
      tools: server.tools
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        }))
        .filter((tool) => {
          if (
            !isInterpreterCliToolVisible({
              serverId: server.id,
              toolName: tool.name,
              allowedToolNames: allowedTools,
            })
          ) {
            return false;
          }
          return matchesAllowedToolScope(allowedTools, server.id, tool.name);
        }),
    }))
    .filter((server) => server.tools.length > 0);
}

function hasScopedHiddenBuiltinServerAccess(
  allowedTools: Set<string> | null,
  serverId: string,
): boolean {
  return Boolean(
    allowedTools &&
    [...allowedTools].some((toolName) =>
      toolName.startsWith(prefixToolName(serverId, "")),
    ),
  );
}

function toInterpreterCliServerInfo(
  server: ToolServerStatus,
  allowedTools: Set<string> | null,
): InterpreterCliServerInfo {
  const rawTools =
    server.state.status === "connected" ? server.state.tools : [];
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    tools: rawTools
      .map(
        (tool: {
          name: string;
          description?: string;
          inputSchema?: unknown;
          annotations?: InterpreterCliToolInfo['annotations'];
        }) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        }),
      )
      .filter((tool) => {
        if (
          !isInterpreterCliToolVisible({
            serverId: server.id,
            toolName: tool.name,
            allowedToolNames: allowedTools,
          })
        ) {
          return false;
        }
        return matchesAllowedToolScope(allowedTools, server.id, tool.name);
      }),
  };
}

async function getBuiltinToolServerForCli(params: {
  serverId: string;
  toolName?: string;
  allowedTools: Set<string> | null;
}): Promise<{
  includeHiddenBuiltins: boolean;
  server: ToolServerStatus;
} | null> {
  if (!getBuiltinServerIncludingHidden(params.serverId)) {
    return null;
  }

  const hidden = isHiddenBuiltinServerId(params.serverId);
  if (hidden) {
    const scoped = params.toolName
      ? isScopedHiddenBuiltinTool({
          allowedTools: params.allowedTools,
          serverId: params.serverId,
          toolName: params.toolName,
        })
      : hasScopedHiddenBuiltinServerAccess(
          params.allowedTools,
          params.serverId,
        );
    if (!scoped) {
      return null;
    }
  }

  const toolManager = getToolManager();
  const server = hidden
    ? await toolManager.getToolServerIncludingHidden(params.serverId)
    : await toolManager.getToolServer(params.serverId);
  return server ? { includeHiddenBuiltins: hidden, server } : null;
}

function getMissingRequiredArgs(
  inputSchema: ToolInputSchema | undefined,
  args: JsonObject,
): string[] {
  if (
    !inputSchema ||
    inputSchema.type !== "object" ||
    !Array.isArray(inputSchema.required)
  ) {
    return [];
  }

  return inputSchema.required.filter((name): name is string => {
    return (
      typeof name === "string" &&
      !Object.prototype.hasOwnProperty.call(args, name)
    );
  });
}

async function listVisibleInterpreterCliServers(
  callerToken: string,
): Promise<InterpreterCliServerInfo[]> {
  // NOTE(interpreter-cli-mcp): CLI listing asks ToolManager for the app's unified tool
  // inventory, then filters by caller binding, allowed tools, hidden builtins,
  // disabled servers, and connection state. It does not open MCP connections or
  // read MCP config itself. Continue in `server/tools/toolManager.ts`.
  const binding = requireCallerBinding(callerToken);
  const toolManager = getToolManager();
  const servers = await toolManager.listAllToolServers();
  const allowedTools = createAllowedToolSet(binding.allowedToolNames);
  const disabledServers = new Set(getGlobalDisabledToolsSync());
  const visibleServers = servers
    .filter(
      (server) =>
        isToolServerAgentAccessible(server.state) &&
        !disabledServers.has(server.id),
    )
    .map((server) => ({
      id: server.id,
      name: server.name,
      description: server.description,
      tools: ("tools" in server.state ? server.state.tools : [])
        .map(
          (tool: {
            name: string;
            description?: string;
            inputSchema?: unknown;
            annotations?: InterpreterCliToolInfo['annotations'];
          }) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          }),
        )
        .filter((tool) => {
          if (
            !isInterpreterCliToolVisible({
              serverId: server.id,
              toolName: tool.name,
              allowedToolNames: allowedTools,
            })
          ) {
            return false;
          }
          return matchesAllowedToolScope(allowedTools, server.id, tool.name);
        }),
    }))
    .filter((server) => server.tools.length > 0);

  const scopedHiddenServers = getScopedHiddenBuiltinServers(allowedTools)
    .filter((server) => !disabledServers.has(server.id))
    .filter(
      (server) =>
        !visibleServers.some((visibleServer) => visibleServer.id === server.id),
    );

  return [...visibleServers, ...scopedHiddenServers];
}

function isScopedHiddenBuiltinTool(params: {
  allowedTools: Set<string> | null;
  serverId: string;
  toolName: string;
}): boolean {
  return Boolean(
    params.allowedTools &&
    isHiddenBuiltinServerId(params.serverId) &&
    matchesAllowedToolScope(
      params.allowedTools,
      params.serverId,
      params.toolName,
    ),
  );
}

export async function listInterpreterCliTools(callerToken: string): Promise<{
  servers: InterpreterCliServerSummaryInfo[];
}> {
  const servers = await listVisibleInterpreterCliServers(callerToken);
  return {
    servers: servers.map((server) => ({
      id: server.id,
      name: server.name,
      description: server.description,
      toolCount: server.tools.length,
    })),
  };
}

export async function findInterpreterCliTools(
  callerToken: string,
  query: string,
): Promise<{
  query: string;
  matches: InterpreterCliToolSearchMatch[];
}> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new Error("Tool search query is required.");
  }

  const servers = await listVisibleInterpreterCliServers(callerToken);
  const matches = servers
    .flatMap((server) =>
      server.tools.map((tool) => ({
        qualifiedName: prefixToolName(server.id, tool.name),
        score: scoreToolSearchMatch(normalizedQuery, server, tool),
        server: {
          id: server.id,
          name: server.name,
          description: server.description,
        },
        tool,
      })),
    )
    .filter((candidate) => candidate.score >= 0.3)
    .sort(
      (a, b) =>
        b.score - a.score || a.qualifiedName.localeCompare(b.qualifiedName),
    )
    .slice(0, 20)
    .map(({ qualifiedName, server, tool }) => ({
      qualifiedName,
      server,
      tool,
    }));

  return {
    query: normalizedQuery,
    matches,
  };
}

export async function listInterpreterCliServerTools(
  callerToken: string,
  serverId: string,
): Promise<{
  server: {
    id: string;
    name: string;
    description?: string;
  };
  tools: InterpreterCliToolInfo[];
  notice?: string;
}> {
  const binding = requireCallerBinding(callerToken);
  const allowedTools = createAllowedToolSet(binding.allowedToolNames);
  const disabledServers = new Set(getGlobalDisabledToolsSync());
  const builtinServer = await getBuiltinToolServerForCli({
    serverId,
    allowedTools,
  });
  if (builtinServer) {
    const server = toInterpreterCliServerInfo(
      builtinServer.server,
      allowedTools,
    );
    if (
      !disabledServers.has(server.id) &&
      builtinServer.server.state.status === "connected" &&
      server.tools.length > 0
    ) {
      return {
        server: {
          id: server.id,
          name: server.name,
          description: server.description,
        },
        tools: server.tools,
      };
    }
  }
  if (getBuiltinServerIncludingHidden(serverId)) {
    throw buildServerUnavailableError(serverId, [], undefined);
  }

  const servers = await listVisibleInterpreterCliServers(callerToken);
  const server = servers.find((candidate) => candidate.id === serverId);
  if (!server) {
    const hasServerScopedAccess =
      !allowedTools ||
      [...allowedTools].some((toolName) =>
        toolName.startsWith(prefixToolName(serverId, "")),
      );
    const toolManager = getToolManager();
    const allServers = await toolManager.listAllToolServers();
    const rawServer = allServers.find((candidate) => candidate.id === serverId);
    const rawTools =
      rawServer?.state.status === "connected" && "tools" in rawServer.state
        ? rawServer.state.tools
        : null;
    if (
      rawServer &&
      rawServer.state.status === "connected" &&
      rawTools?.length === 0 &&
      hasServerScopedAccess &&
      !disabledServers.has(rawServer.id)
    ) {
      return {
        server: {
          id: rawServer.id,
          name: rawServer.name,
          description: rawServer.description,
        },
        tools: [],
        notice:
          'This server is connected, but Interpreter has not discovered callable tools yet. Run `interpreter-app tools builtin-mcp-management mcp_refresh_tools --json \'{"reason":"Refresh MCP tools"}\'`, then run `interpreter-app tools list <server-id>` again.',
      };
    }

    throw buildServerUnavailableError(serverId, servers);
  }

  return {
    server: {
      id: server.id,
      name: server.name,
      description: server.description,
    },
    tools: server.tools,
  };
}

export async function describeInterpreterCliTool(
  callerToken: string,
  serverId: string,
  toolName: string,
): Promise<{
  server: {
    id: string;
    name: string;
    description?: string;
  };
  tool: InterpreterCliToolInfo;
}> {
  const binding = requireCallerBinding(callerToken);
  const allowedTools = createAllowedToolSet(binding.allowedToolNames);
  const disabledServers = new Set(getGlobalDisabledToolsSync());
  const builtinServer = await getBuiltinToolServerForCli({
    serverId,
    toolName,
    allowedTools,
  });
  if (builtinServer) {
    const server = toInterpreterCliServerInfo(
      builtinServer.server,
      allowedTools,
    );
    if (
      disabledServers.has(server.id) ||
      builtinServer.server.state.status !== "connected" ||
      server.tools.length === 0
    ) {
      throw buildServerUnavailableError(serverId, [], toolName);
    }

    const tool = server.tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw buildToolNotFoundError(server, toolName, [server]);
    }

    return {
      server: {
        id: server.id,
        name: server.name,
        description: server.description,
      },
      tool,
    };
  }
  if (getBuiltinServerIncludingHidden(serverId)) {
    throw buildServerUnavailableError(serverId, [], toolName);
  }

  const servers = await listVisibleInterpreterCliServers(callerToken);
  const server = servers.find((candidate) => candidate.id === serverId);
  if (!server) {
    throw buildServerUnavailableError(serverId, servers, toolName);
  }

  const tool = server.tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw buildToolNotFoundError(server, toolName, servers);
  }

  return {
    server: {
      id: server.id,
      name: server.name,
      description: server.description,
    },
    tool,
  };
}

export async function callInterpreterCliTool(params: {
  callerToken: string;
  serverId: string;
  toolName: string;
  args: JsonObject;
  saveToDisk?: boolean;
  saveToDiskPath?: string;
  onProgress?: InterpreterCliProgressHandler;
}): Promise<unknown> {
  /**
   * NOTE(interpreter-cli-mcp): `interpreter-app tools <server> <tool>` is the CLI route
   * for model-facing app tools. It must always rehydrate the caller token into
   * the bound agent/thread/workspace/model/window context before entering
   * `ToolManager.callTool()`. Scoped `/mcp` calls mirror this path in
   * `server/utils/codexMcpBridge.ts`; both paths converge at ToolManager's MCP
   * approval gate.
   *
   * Trail: [MCP bridge](../utils/codexMcpBridge.ts) ->
   * [approval gate](../tools/toolManager.ts) ->
   * [runtime caller](../../src/lib/codex/mcp-service.ts).
   */
  const binding = requireCallerBinding(params.callerToken);
  const toolManager = getToolManager();
  const allowedTools = createAllowedToolSet(binding.allowedToolNames);
  const disabledServers = new Set(getGlobalDisabledToolsSync());

  console.log("[Interpreter CLI] Calling tool", {
    agentId: binding.agentId,
    serverId: params.serverId,
    toolName: params.toolName,
    saveToDisk: params.saveToDisk ?? false,
    saveToDiskPath: params.saveToDiskPath,
  });
  const startedAt = Date.now();
  console.log(`[INTERPRETER_CLI_TOOL] phase=start agentId=${binding.agentId} serverId=${params.serverId} tool=${params.toolName} saveToDisk=${params.saveToDisk === true} saveToDiskPath=${JSON.stringify(params.saveToDiskPath ?? '')} args=${summarizeToolArgs(params.args)}`);

  if (disabledServers.has(params.serverId)) {
    throw new Error(
      `Tool server '${params.serverId}' is disabled for this interpreter runtime.`,
    );
  }

  const builtinServer = await getBuiltinToolServerForCli({
    serverId: params.serverId,
    toolName: params.toolName,
    allowedTools,
  });
  const targetIsBuiltin = Boolean(
    getBuiltinServerIncludingHidden(params.serverId),
  );
  let visibleServers: InterpreterCliServerInfo[] | null = null;
  const getVisibleServers = async () => {
    visibleServers ??= await listVisibleInterpreterCliServers(
      params.callerToken,
    );
    return visibleServers;
  };

  if (targetIsBuiltin && !builtinServer) {
    throw buildServerUnavailableError(params.serverId, [], params.toolName);
  }

  const includeHiddenBuiltins = builtinServer?.includeHiddenBuiltins ?? false;
  const cliServer = builtinServer
    ? toInterpreterCliServerInfo(builtinServer.server, allowedTools)
    : (await getVisibleServers()).find(
        (candidate) => candidate.id === params.serverId,
      );
  if (
    !cliServer ||
    (builtinServer && builtinServer.server.state.status !== "connected")
  ) {
    throw buildServerUnavailableError(
      params.serverId,
      builtinServer ? [] : await getVisibleServers(),
      params.toolName,
    );
  }

  const rawBuiltinToolSpec =
    builtinServer?.server.state.status === "connected"
      ? builtinServer.server.state.tools.find(
          (tool) => tool.name === params.toolName,
        )
      : undefined;
  const toolSpec =
    rawBuiltinToolSpec ??
    cliServer.tools.find((tool) => tool.name === params.toolName);
  if (!toolSpec) {
    const visibleServerList = builtinServer ? [cliServer] : await getVisibleServers();
    throw buildToolNotFoundError(
      cliServer,
      params.toolName,
      visibleServerList,
    );
  }

  if (
    !isInterpreterCliToolVisible({
      serverId: params.serverId,
      toolName: params.toolName,
      allowedToolNames: allowedTools,
    }) ||
    !matchesAllowedToolScope(allowedTools, params.serverId, params.toolName)
  ) {
    throw new Error(
      `Tool '${params.serverId}__${params.toolName}' is not allowed for this interpreter runtime.`,
    );
  }

  const missingRequiredArgs = getMissingRequiredArgs(
    toolSpec.inputSchema as ToolInputSchema | undefined,
    params.args,
  );
  if (missingRequiredArgs.length > 0) {
    throw buildMissingRequiredArgsError({
      serverId: params.serverId,
      toolName: params.toolName,
      missingRequiredArgs,
      inputSchema: toolSpec.inputSchema,
    });
  }

  try {
    const shouldGuardReadResult = isReadOnlyInterpreterCliTool({
      serverId: params.serverId,
      toolName: params.toolName,
      toolSpec: toolSpec as InterpreterCliToolInfo,
    });
    const result = await runWithWindowSessionOverride(binding.windowSessionKey ?? null, async () => {
      return await runWithWorkspaceOverride(binding.workspacePath ?? null, async () => {
        return await toolManager.callTool(
          params.serverId,
          params.toolName,
          params.args,
          params.saveToDisk,
          binding.agentId,
          {
            profileId: binding.toolProfileId,
            modelConfig: binding.modelConfig,
            threadId: binding.threadId,
            workspace: binding.workspacePath,
            progressReporter: params.onProgress,
            saveToDiskPath: params.saveToDiskPath,
          },
          undefined,
          { includeHiddenBuiltins },
        );
      });
    });
    const guardedResult = await applyReadToolPromptInjectionGuard({
      serverId: params.serverId,
      toolName: params.toolName,
      args: params.args,
      result,
      enabled: shouldGuardReadResult,
    });
    const ok = !isInterpreterCliToolCallError(guardedResult);
    const durationMs = Date.now() - startedAt;
    console.log(`[INTERPRETER_CLI_TOOL] phase=result agentId=${binding.agentId} serverId=${params.serverId} tool=${params.toolName} ok=${ok ? 'true' : 'false'} durationMs=${durationMs} result=${summarizeToolResult(guardedResult)}`);
    return serializeToolResultForCliTextTransport(guardedResult);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[INTERPRETER_CLI_TOOL] phase=result agentId=${binding.agentId} serverId=${params.serverId} tool=${params.toolName} ok=false durationMs=${durationMs} error=${JSON.stringify(message.slice(0, 500))}`);
    throw error;
  }
}

function extractToolResultText(
  result: InterpreterCliToolCallResult,
): string | null {
  const textParts = (result.content ?? [])
    .filter(
      (item): item is { type?: unknown; text: string } =>
        item?.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text.trim())
    .filter(Boolean);

  return textParts.length > 0 ? textParts.join("\n\n") : null;
}

function unwrapInterpreterCliToolJsonResult(
  result: unknown,
  fallbackErrorMessage: string,
): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }

  const typedResult = result as InterpreterCliToolCallResult;
  const text = extractToolResultText(typedResult);

  if (typedResult.isError) {
    throw new Error(text ?? fallbackErrorMessage);
  }

  if (
    typedResult.structuredContent !== undefined &&
    typedResult.structuredContent !== null
  ) {
    return typedResult.structuredContent;
  }

  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  return result;
}

async function callInterpreterCliBuiltinJsonTool(params: {
  callerToken: string;
  toolName: string;
  args: JsonObject;
}): Promise<unknown> {
  const result = await callInterpreterCliTool({
    callerToken: params.callerToken,
    serverId: "builtin-interpreter",
    toolName: params.toolName,
    args: params.args,
    saveToDisk: false,
  });

  return unwrapInterpreterCliToolJsonResult(
    result,
    `Tool 'builtin-interpreter__${params.toolName}' failed.`,
  );
}

export async function getInterpreterCliConfig(
  callerToken: string,
  path: string,
): Promise<unknown> {
  if (path === "" || isAliasRootPath(path)) {
    const fullConfig = await callInterpreterCliBuiltinJsonTool({
      callerToken,
      toolName: "interpreter_settings_get",
      args: { path: "" },
    });
    const remappedConfig = remapInterpreterConfigForCli(fullConfig);
    return path === "" ? remappedConfig : (get(remappedConfig, path) ?? null);
  }

  return callInterpreterCliBuiltinJsonTool({
    callerToken,
    toolName: "interpreter_settings_get",
    args: { path: toRawInterpreterConfigPath(path) },
  });
}

export async function setInterpreterCliConfig(params: {
  callerToken: string;
  path: string;
  value: unknown;
  restartRuntime?: boolean;
}): Promise<unknown> {
  if (isAliasRootPath(params.path)) {
    throw new Error(
      `Set individual paths under '${params.path}.*' instead of replacing the whole section.`,
    );
  }

  const result = await callInterpreterCliBuiltinJsonTool({
    callerToken: params.callerToken,
    toolName: "interpreter_settings_set",
    args: {
      path: toRawInterpreterConfigPath(params.path),
      value: params.value,
      ...(params.restartRuntime ? { restart_runtime: true } : {}),
    },
  });

  if (result && typeof result === "object" && !Array.isArray(result)) {
    const payload = result as Record<string, unknown>;
    if (typeof payload.path === "string") {
      return {
        ...payload,
        path: toAliasInterpreterConfigPath(payload.path),
      };
    }
  }

  return result;
}

export async function restartInterpreterCliRuntime(params: {
  callerToken: string;
  reason?: string;
}): Promise<unknown> {
  const binding = requireCallerBinding(params.callerToken);

  const reason =
    typeof params.reason === "string" && params.reason.trim().length > 0
      ? params.reason.trim()
      : "A fresh runtime snapshot is needed.";
  const outcome = await requestInterpreterRuntimeRestart({
    approvalToolName: "interpreter_config_restart_runtime",
    approvalServerId: "builtin-interpreter",
    message: `Interpreter wants to restart its agent runtime. ${reason} Restarting will stop running conversations for every agent.`,
    agentId: binding.agentId,
    timeoutMs: 120_000,
  });

  return {
    success: outcome.restartPerformed,
    reason,
    ...outcome,
    message: outcome.restartPerformed
      ? "Interpreter restarted. New changes have taken effect."
      : "Interpreter agent runtime restart was not performed.",
  };
}

export async function getInterpreterCliLayout(
  callerToken: string,
  path: string,
): Promise<unknown> {
  return callInterpreterCliBuiltinJsonTool({
    callerToken,
    toolName: "interpreter_get",
    args: { path },
  });
}

export async function setInterpreterCliLayout(params: {
  callerToken: string;
  path: string;
  value: unknown;
}): Promise<unknown> {
  return callInterpreterCliBuiltinJsonTool({
    callerToken: params.callerToken,
    toolName: "interpreter_set",
    args: {
      path: params.path,
      value: params.value,
    },
  });
}
