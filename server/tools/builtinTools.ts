// Built-in tools that run directly on the server without MCP protocol
// These are exposed through the same HTTP interface as other tools

import type { ToolCallResponse } from './toolTypes';
import type { AgentModelConfig } from '../../shared/types/model';
import * as pathModule from 'path';

export interface BuiltinToolContext {
  toolCallId?: string;
  agentId?: string;
  messageId?: string;
  modelConfig?: AgentModelConfig;
  abortSignal?: AbortSignal;
  /**
   * Optional line-oriented progress reporter for long-running CLI-facing tool calls.
   * Messages should be human-readable, concise, and safe to surface directly in the CLI.
   */
  reportProgress?: (text: string) => void | Promise<void>;
  /** The user's current workspace directory. CRITICAL: Tools must use this, NOT process.cwd()! */
  workspace?: string;
  /** True when tool is called from a subagent. */
  isSubagent?: boolean;
  /** Full path from root to current subagent, e.g., ["explore-abc", "task-def"]. Used for nested subagent streaming. */
  toolCallPath?: string[];
  /** Maximum subagent nesting depth (from settings). Default: 5. */
  maxDepth?: number;
  /** Tab ID of the MCP caller (from URL path /mcp/:profileId/:tabId). Allows tools to identify which tab invoked them. */
  callerTabId?: string;
  /** Agent runtime thread that issued the call. Used to scope per-thread tool state such as js_repl kernels. */
  threadId?: string;
  /** Optional explicit output path from `interpreter-app tools ... --save-to-disk <path>`. */
  saveToDiskPath?: string;
  /** True only for internal overlay actions already accepted through computer_batch review. */
  overlayReviewedAction?: boolean;
}

// Re-export types from shared for convenience
export type { ToolCategory, ToolDisplayInfo, ToolName } from '../../shared/toolMetadata';
import type { ToolName } from '../../shared/toolMetadata';

export interface BuiltinToolDefinition {
  /** Tool name - MUST be defined in shared/toolMetadata.ts TOOL_DISPLAY */
  name: ToolName;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (args: Record<string, any>, context?: BuiltinToolContext) => Promise<ToolCallResponse>;
  fileAccess?: {
    mode: 'read' | 'write';
    /** Single path argument name OR array of path argument names */
    pathArg: string | string[];
    /**
     * Optional per-argument access mode override.
     * Useful for tools like copy_file where source needs read and destination needs write.
     */
    pathArgModes?: Record<string, 'read' | 'write'>;
  };

  // Tool metadata for subagent access control
  // 'read' = read-only tool, 'write' = modifies files
  mode?: 'read' | 'write';
  // File extensions this tool handles, e.g. ['.pdf'], ['.xlsx', '.xls']
  // Use ['*'] for universal tools that work on any file type
  fileTypes?: string[];

  // If true, this tool is ONLY available to the main agent, not to any subagents.
  // Used for dangerous tools that require explicit user approval.
  mainAgentOnly?: boolean;

  // MCP-style tool annotations
  annotations?: {
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
    destructiveHint?: boolean;
  };
}

export interface BuiltinServerDefinition {
  id: string;
  name: string;
  description: string;
  isBuiltin: true;
  tools: BuiltinToolDefinition[];
  resources: any[];
  prompts: any[];
}

// ============================================================================
// BUILT-IN SERVERS REGISTRY
// ============================================================================

import { googleServerDefinition } from './builtin-tools/google/index';
import { testApprovalServerDefinition } from './builtin-tools/test-approval/index';
import { runAgentServerDefinition } from './builtin-tools/run-agent/index';
import { runAgentUiServerDefinition } from './builtin-tools/run-agent-ui/index';
import { echoSecretServerDefinition } from './builtin-tools/echo-secret/index';
import { nylasServerDefinition } from './builtin-tools/nylas/index';
import { whatsappServerDefinition } from './builtin-tools/whatsapp/index';
import { isConfigured as isWhatsAppConfigured } from './builtin-tools/whatsapp/credentials';
import { telegramServerDefinition } from './builtin-tools/telegram/index';
import { docxServerDefinition } from './builtin-tools/docx/index.js';
import { pdfServerDefinition } from './builtin-tools/pdf/index';
import { utilityServerDefinition } from './builtin-tools/utility/index';
import { mediaAiServerDefinition } from './builtin-tools/media-ai/index';
import { mcpManagementServerDefinition } from './builtin-tools/mcp-management/index';
import { askUserServerDefinition } from './builtin-tools/ask-user/index';
import { tasksServerDefinition } from './builtin-tools/tasks/index';
import { interpreterServerDefinition } from './builtin-tools/workstation/index';
import { jsReplServerDefinition } from './builtin-tools/js-repl/index';
import { interpreterOverlayServerDefinition } from './builtin-tools/interpreter-overlay/index';
import { cuaDriverServerDefinition, isCuaDriverSupportedPlatform } from './builtin-tools/cua-driver/index';
import { transcribeServerDefinition } from './builtin-tools/transcribe/index';
import { agentWindowsServerDefinition } from './builtin-tools/agent-windows/index';
import { selectionServerDefinition } from './builtin-tools/selection/index';

const BUILTIN_SERVER_LOAD_FAILURES = new Map<string, string>();

function tryLoadServer<T>(serverId: string, loader: () => T): T | null {
  try {
    BUILTIN_SERVER_LOAD_FAILURES.delete(serverId);
    return loader();
  } catch (error) {
    const details = error instanceof Error ? error.stack ?? error.message : String(error);
    BUILTIN_SERVER_LOAD_FAILURES.set(serverId, details);
    console.error(
      `[Built-in Tools] Failed to load ${serverId}:`,
      details,
    );
    return null;
  }
}

// Converter tools require Electron (x2t binary from OfficeExtension editors) - conditionally load
let converterServerDefinition: BuiltinServerDefinition | null = null;
if (process.versions.electron) {
  converterServerDefinition = tryLoadServer(
    'builtin-converter',
    () => require('./builtin-tools/converter/index.js').converterServerDefinition as BuiltinServerDefinition,
  );
}

// Remotion tools require Electron (webFrameMain for iframe control) and are dev-only
// (Remotion's license does not permit redistribution in packaged apps)
let remotionServerDefinition: BuiltinServerDefinition | null = null;
if (process.versions.electron) {
  remotionServerDefinition = tryLoadServer('builtin-remotion', () => {
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return null;
    }
    return require('./builtin-tools/remotion/index').remotionServerDefinition as BuiltinServerDefinition;
  });
}

// ============================================================================
// HIDDEN SERVERS - Add server IDs here to hide them system-wide
// These servers won't appear in /api/servers or the UI.
// Agent tool discovery only re-adds the explicit internal subset below.
// ============================================================================

const BASE_HIDDEN_SERVER_IDS: string[] = [
  'builtin-run-agent',
  'builtin-run-agent-ui',
  'builtin-test-approval',
  'builtin-echo-secret',
  'builtin-tasks',
  'builtin-agent-windows',
  'builtin-interpreter-overlay',
  // Keep these hidden from general tool/server discovery.
  'builtin-nylas',
  'builtin-telegram',
];

export const AGENT_FACING_HIDDEN_SERVER_IDS = [
  'builtin-run-agent',
  'builtin-run-agent-ui',
  'builtin-tasks',
  'builtin-agent-windows',
] as const;

function getHiddenServerIds(): string[] {
  const hidden = [...BASE_HIDDEN_SERVER_IDS];

  // WhatsApp tools should only appear after the user explicitly connects it in Settings.
  if (!isWhatsAppConfigured()) {
    hidden.push('builtin-whatsapp');
  }

  return hidden;
}

const includeElectronWorkstationServers =
  Boolean(process.versions.electron)
  || process.env.INTERPRETER_ENABLE_HEADLESS_BROWSER_TOOLS === '1';

/**
 * All built-in servers (internal - includes hidden)
 */
const ALL_BUILTIN_SERVERS: BuiltinServerDefinition[] = [
  ...(googleServerDefinition ? [googleServerDefinition] : []),
  ...(testApprovalServerDefinition ? [testApprovalServerDefinition] : []),
  ...(runAgentServerDefinition ? [runAgentServerDefinition] : []),
  ...(runAgentUiServerDefinition ? [runAgentUiServerDefinition] : []),
  ...(echoSecretServerDefinition ? [echoSecretServerDefinition] : []),
  ...(nylasServerDefinition ? [nylasServerDefinition] : []),
  ...(whatsappServerDefinition ? [whatsappServerDefinition] : []),
  ...(telegramServerDefinition ? [telegramServerDefinition] : []),
  ...(docxServerDefinition ? [docxServerDefinition] : []),
  ...(pdfServerDefinition ? [pdfServerDefinition] : []),
  // Converter requires Electron (x2t binary) - only include when available
  ...(converterServerDefinition ? [converterServerDefinition] : []),
  // Remotion tools require Electron (webFrameMain) - only include when available
  ...(remotionServerDefinition ? [remotionServerDefinition] : []),
  ...(utilityServerDefinition ? [utilityServerDefinition] : []),
  jsReplServerDefinition,
  ...(mediaAiServerDefinition ? [mediaAiServerDefinition] : []),
  ...(transcribeServerDefinition ? [transcribeServerDefinition] : []),
  // Most workstation tools require Electron BrowserWindow state. The explicit
  // headless opt-in is used by deterministic browser-extension CLI smoke tests
  // for the browser page tools that do not depend on Electron windows.
  ...(includeElectronWorkstationServers ? [interpreterServerDefinition] : []),
  ...(process.versions.electron ? [interpreterOverlayServerDefinition] : []),
  ...(process.versions.electron ? [selectionServerDefinition] : []),
  ...(isCuaDriverSupportedPlatform() ? [cuaDriverServerDefinition] : []),
  ...(mcpManagementServerDefinition ? [mcpManagementServerDefinition] : []),
  ...(askUserServerDefinition ? [askUserServerDefinition] : []),
  ...(tasksServerDefinition ? [tasksServerDefinition] : []),
  agentWindowsServerDefinition,
];

export function getBuiltinServersIncludingHidden(): BuiltinServerDefinition[] {
  return [...ALL_BUILTIN_SERVERS];
}

export function isHiddenBuiltinServerId(serverId: string): boolean {
  return getHiddenServerIds().includes(serverId);
}

export function getAgentFacingHiddenBuiltinServers(): BuiltinServerDefinition[] {
  return ALL_BUILTIN_SERVERS.filter((server) =>
    (AGENT_FACING_HIDDEN_SERVER_IDS as readonly string[]).includes(server.id)
  );
}

export function getBuiltinServerLoadFailures(): Map<string, string> {
  return new Map(BUILTIN_SERVER_LOAD_FAILURES);
}

/**
 * All available built-in servers (excludes hidden servers)
 * Add new built-in servers to ALL_BUILTIN_SERVERS array above.
 *
 * NOTE: This is a snapshot at module load. Prefer getBuiltinServers() for
 * runtime decisions because hidden server state can depend on user settings.
 */
export const BUILTIN_SERVERS: BuiltinServerDefinition[] = ALL_BUILTIN_SERVERS.filter(
  s => !getHiddenServerIds().includes(s.id)
);

/**
 * Get visible built-in servers at runtime.
 */
export function getBuiltinServers(): BuiltinServerDefinition[] {
  const hidden = getHiddenServerIds();
  return ALL_BUILTIN_SERVERS.filter((s) => !hidden.includes(s.id));
}

/**
 * Get a built-in server by ID
 */
export function getBuiltinServer(id: string): BuiltinServerDefinition | undefined {
  return getBuiltinServers().find(s => s.id === id);
}

export function getBuiltinServerIncludingHidden(id: string): BuiltinServerDefinition | undefined {
  return ALL_BUILTIN_SERVERS.find((server) => server.id === id);
}

/**
 * Get a built-in tool handler
 */
export function getBuiltinToolHandler(serverId: string, toolName: string): BuiltinToolDefinition | undefined {
  const server = getBuiltinServer(serverId);
  if (!server) return undefined;
  return server.tools.find(t => t.name === toolName);
}

export function getBuiltinToolHandlerIncludingHidden(
  serverId: string,
  toolName: string,
): BuiltinToolDefinition | undefined {
  const server = getBuiltinServerIncludingHidden(serverId);
  if (!server) return undefined;
  return server.tools.find((tool) => tool.name === toolName);
}

// ============================================================================
// TOOL DISCOVERY UTILITIES FOR SUBAGENTS
// ============================================================================

/**
 * Get file extensions from a list of paths
 */
export function getFileExtensions(paths: string[]): string[] {
  const extensions = new Set<string>();
  for (const p of paths) {
    const ext = pathModule.extname(p).toLowerCase();
    if (ext) extensions.add(ext);
  }
  return Array.from(extensions);
}

/**
 * Get all tools matching the given mode and optionally filtered by file types
 *
 * @param mode - 'read' for read-only tools, 'write' for write tools, 'all' for both
 * @param fileTypes - If provided, only return tools that handle these file extensions
 * @returns Array of matching tool definitions
 */
export function getToolsForMode(
  mode: 'read' | 'write' | 'all',
  fileTypes?: string[]
): BuiltinToolDefinition[] {
  const allTools: BuiltinToolDefinition[] = [];

  for (const server of getBuiltinServers()) {
    for (const tool of server.tools) {
      // Skip tools without mode (not file-related or not tagged)
      if (!tool.mode) continue;

      // CRITICAL: Skip mainAgentOnly tools - these are not available to subagents
      // (for example, tools that require explicit user approval should not be delegated)
      if (tool.mainAgentOnly) continue;

      // Check mode
      if (mode !== 'all' && tool.mode !== mode) continue;

      // Check file types (if filter specified)
      if (fileTypes && fileTypes.length > 0 && tool.fileTypes) {
        const isUniversal = tool.fileTypes.includes('*');
        const hasMatch = fileTypes.some(ft => tool.fileTypes!.includes(ft.toLowerCase()));
        if (!isUniversal && !hasMatch) continue;
      }

      allTools.push(tool);
    }
  }

  return allTools;
}

/**
 * Get all read tools, optionally filtered by file types
 */
export function getReadTools(fileTypes?: string[]): BuiltinToolDefinition[] {
  return getToolsForMode('read', fileTypes);
}

/**
 * Get all write tools, optionally filtered by file types
 */
export function getWriteTools(fileTypes?: string[]): BuiltinToolDefinition[] {
  return getToolsForMode('write', fileTypes);
}

/**
 * Get both read and write tools, optionally filtered by file types
 */
export function getAllFileTools(fileTypes?: string[]): BuiltinToolDefinition[] {
  return getToolsForMode('all', fileTypes);
}

// Tool display info is now in shared/toolMetadata.ts
// Import from there: import { TOOL_DISPLAY, getToolDisplay } from '../../shared/toolMetadata';
