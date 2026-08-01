/**
 * MCP Server Endpoint
 *
 * Exposes all tools (builtin + MCP servers) as an MCP server using Streamable HTTP transport.
 * This allows external MCP clients (like Claude Code) to connect and use the tools.
 *
 * Endpoints:
 * - POST /mcp - Handle JSON-RPC requests (initialize, tools/list, tools/call)
 * - GET /mcp - Optional SSE stream for server-initiated notifications
 * - DELETE /mcp - Terminate session
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { getToolManager } from '../tools/toolManagerAccessor';
import { prefixToolName, parseToolName } from '../../shared/utils/mcpToolName';
import {
  createAllowedToolSet,
  matchesAllowedToolScope,
} from '../utils/toolScope';
import { isToolServerAgentAccessible } from '../../shared/toolServerAvailability';
import { getGlobalDisabledTools, resolveAndExecuteCodexTool } from './mcpDependencies';

const router = Router();

function createClientDisconnectSignal(req: Request, res: Response): AbortSignal {
  const abortController = new AbortController();
  const abort = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };

  req.on('aborted', abort);
  res.on('close', () => {
    if (!res.writableEnded) {
      abort();
    }
  });

  return abortController.signal;
}

// Session storage (in-memory for now)
const sessions = new Map<string, {
  createdAt: number;
  lastActivity: number;
}>();

// SSE connections for server-initiated notifications (keyed by session ID)
// We store the Response object so we can write notifications to it
const sseConnections = new Map<string, Response>();

// Server info
const SERVER_INFO = {
  name: 'interpreter',
  version: '1.0.0',
};

// Server capabilities
const SERVER_CAPABILITIES = {
  tools: {
    listChanged: true, // We support notifications/tools/list_changed
  },
  // We don't support resources or prompts yet via MCP server
  // resources: {},
  // prompts: {},
};

/**
 * Blacklist of tool server IDs that should NOT be exposed via MCP.
 * These are internal/hidden servers that don't make sense to expose externally.
 *
 * By default, ALL other connected servers (builtin + user-added MCPs) are exposed.
 * This makes the workstation a "docking station" for MCPs - when you add an MCP,
 * it becomes available to both internal agents AND external MCP clients.
 */
const MCP_TOOL_SERVER_BLACKLIST: string[] = [
  // Internal agent execution - shouldn't be exposed
  'builtin-run-agent',
  'builtin-run-agent-ui',
  // Testing tools - shouldn't be exposed
  'builtin-test-approval',
  'builtin-echo-secret',
];

function isBlacklistedMcpServer(serverId: string, _profileId?: string): boolean {
  if (MCP_TOOL_SERVER_BLACKLIST.includes(serverId)) {
    return true;
  }

  return false;
}

/**
 * Blacklist of individual tool names that should NOT be exposed via MCP.
 * Use this for tools that belong to an otherwise-visible server.
 */
const MCP_TOOL_BLACKLIST = new Set<string>();

interface McpQueryScope {
  disabledServers: Set<string>;
  disabledTools: Set<string>;
  allowedServers: Set<string> | null;
  allowedTools: Set<string> | null;
  toolProfileId?: string;
}

function readSingleQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function parseEncodedList(value: unknown): string[] {
  const raw = readSingleQueryValue(value);
  if (!raw) return [];

  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === 'string');
    }
  } catch {
    // Fall back to comma-separated parsing.
  }

  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function parseMcpQueryScope(req: Request): McpQueryScope {
  const disabledServers = new Set(parseEncodedList(req.query.disabled_servers));
  const disabledTools = new Set(parseEncodedList(req.query.disabled_tools));
  const allowedServersList = parseEncodedList(req.query.allowed_servers);
  const allowedToolsList = parseEncodedList(req.query.allowed_tools);
  const toolProfileId = readSingleQueryValue(req.query.tool_profile);

  return {
    disabledServers,
    disabledTools,
    allowedServers: allowedServersList.length > 0 ? new Set(allowedServersList) : null,
    allowedTools: createAllowedToolSet(allowedToolsList),
    toolProfileId: toolProfileId || undefined,
  };
}

/**
 * Notify all connected MCP clients that the tool list has changed.
 * Clients should call tools/list again to get the updated list.
 *
 * This sends a JSON-RPC notification (no id field = no response expected)
 * via SSE to all connected clients.
 */
export function notifyMcpToolsListChanged(): void {
  if (sseConnections.size === 0) {
    return; // No clients to notify
  }

  console.log(`[MCP] Notifying ${sseConnections.size} connected client(s) of tool list change`);

  const notification = {
    jsonrpc: '2.0',
    method: 'notifications/tools/list_changed',
  };

  const sseData = `event: message\ndata: ${JSON.stringify(notification)}\n\n`;

  for (const [sessionId, res] of sseConnections) {
    try {
      res.write(sseData);
    } catch (error) {
      console.error(`[MCP] Failed to send notification to session ${sessionId}:`, error);
      // Connection might be dead, remove it
      sseConnections.delete(sessionId);
    }
  }
}

/**
 * Convert our tool format to MCP tool format
 */
interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Get all tools as MCP format, optionally filtering by global disabled tools
 * @param disabledTools - Tool server IDs to exclude (global blacklist)
 */
async function getAllToolsAsMcp(
  disabledTools: string[] = [],
  scope?: McpQueryScope,
  profileId?: string,
): Promise<McpTool[]> {
  const toolManager = getToolManager();
  const servers = await toolManager.listAllToolServers();
  const mcpTools: McpTool[] = [];
  let exposedServerCount = 0;

  for (const server of servers) {
    if (!isToolServerAgentAccessible(server.state)) continue;

    // Exclude blacklisted servers (internal/hidden servers)
    if (isBlacklistedMcpServer(server.id, profileId)) {
      continue;
    }

    // Exclude globally disabled servers
    if (disabledTools.includes(server.id) || scope?.disabledServers.has(server.id)) {
      continue;
    }
    if (scope?.allowedServers && !scope.allowedServers.has(server.id)) {
      continue;
    }

    exposedServerCount++;
    const tools = 'tools' in server.state && Array.isArray(server.state.tools)
      ? server.state.tools
      : [];
    for (const tool of tools) {
      if (MCP_TOOL_BLACKLIST.has(tool.name)) continue;

      // Prefix tool name with server ID to avoid collisions
      // e.g., "builtin-interpreter__open_file" or "my-custom-mcp__do_something"
      const prefixedName = prefixToolName(server.id, tool.name);
      if (!matchesAllowedToolScope(scope?.allowedTools || null, server.id, tool.name)) {
        continue;
      }
      if (scope?.disabledTools.has(prefixedName) || scope?.disabledTools.has(tool.name)) {
        continue;
      }

      mcpTools.push({
        name: prefixedName,
        description: tool.description || `Tool from ${server.name}`,
        inputSchema: tool.inputSchema || {
          type: 'object',
          properties: {},
        },
      });
    }
  }

  console.log(`[MCP] Exposing ${mcpTools.length} tools from ${exposedServerCount} server(s)${disabledTools.length > 0 ? ` (${disabledTools.length} disabled)` : ''}`);
  return mcpTools;
}


// Result of handling a JSON-RPC request
interface HandleResult {
  response: JsonRpcResponse | JsonRpcError;
  sessionId?: string; // New session ID to set in header (only for initialize)
}

/**
 * Handle JSON-RPC request
 * @param request - The JSON-RPC request
 * @param sessionId - Session ID from header
 * @param disabledTools - Tool server IDs to exclude (global blacklist)
 */
async function handleJsonRpcRequest(
  request: JsonRpcRequest,
  sessionId: string | null,
  disabledTools: string[] = [],
  callerTabId?: string,
  profileId?: string,
  scope?: McpQueryScope,
  signal?: AbortSignal,
): Promise<HandleResult> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'initialize': {
        // Create new session if none exists
        const newSessionId = sessionId || randomUUID();
        sessions.set(newSessionId, {
          createdAt: Date.now(),
          lastActivity: Date.now(),
        });

        console.log('[MCP] Initialize request, creating session:', newSessionId);

        // Note: sessionId is returned in the Mcp-Session-Id header, not in the body
        // per MCP Streamable HTTP spec
        return {
          response: {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              serverInfo: SERVER_INFO,
              capabilities: SERVER_CAPABILITIES,
            },
          },
          sessionId: newSessionId,
        };
      }

      case 'tools/list': {
        const tools = await getAllToolsAsMcp(disabledTools, scope, profileId);
        return {
          response: {
            jsonrpc: '2.0',
            id,
            result: { tools },
          },
        };
      }

      case 'tools/call': {
        const { name, arguments: args } = params as {
          name: string;
          arguments?: Record<string, unknown>;
        };

        const parsed = parseToolName(name);
        if (!parsed) {
          return {
            response: {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: `Invalid tool name format: ${name}. Expected format: serverId__toolName`,
              },
            },
          };
        }

        const { serverId, toolName } = parsed;
        const prefixedToolName = prefixToolName(serverId, toolName);

        // Check if server is blacklisted (internal/hidden servers)
        if (isBlacklistedMcpServer(serverId, profileId)) {
          return {
            response: {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: `Tool server '${serverId}' is not available via MCP`,
              },
            },
          };
        }

        // Check if server is disabled for this profile
        if (disabledTools.includes(serverId) || scope?.disabledServers.has(serverId)) {
          return {
            response: {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: `Tool server '${serverId}' is disabled for this profile`,
              },
            },
          };
        }

        if (scope?.allowedServers && !scope.allowedServers.has(serverId)) {
          return {
            response: {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: `Tool server '${serverId}' is not allowed for this MCP scope`,
              },
            },
          };
        }

        if (!matchesAllowedToolScope(scope?.allowedTools || null, serverId, toolName)) {
          return {
            response: {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: `Tool '${prefixedToolName}' is not allowed for this MCP scope`,
              },
            },
          };
        }

        if (scope?.disabledTools.has(prefixedToolName) || scope?.disabledTools.has(toolName)) {
          return {
            response: {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: `Tool '${prefixedToolName}' is disabled for this MCP scope`,
              },
            },
          };
        }

        try {
          const result = await resolveAndExecuteCodexTool({
            serverId,
            toolName,
            args: args || {},
            callerTabId,
            profileId: scope?.toolProfileId || profileId,
            signal,
          });
          return {
            response: {
              jsonrpc: '2.0',
              id,
              result: {
                content: result.content || [{ type: 'text', text: JSON.stringify(result) }],
                isError: result.isError || false,
              },
            },
          };
        } catch (error: any) {
          return {
            response: {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `Error: ${error.message}` }],
                isError: true,
              },
            },
          };
        }
      }

      case 'ping': {
        return {
          response: {
            jsonrpc: '2.0',
            id,
            result: {},
          },
        };
      }

      default:
        return {
          response: {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          },
        };
    }
  } catch (error: any) {
    return {
      response: {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: `Internal error: ${error.message}`,
        },
      },
    };
  }
}

// JSON-RPC types
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id?: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Common handler for MCP POST requests
 */
async function handleMcpPostRequest(req: Request, res: Response, profileId?: string, tabId?: string) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const request = req.body as JsonRpcRequest;
  const scope = parseMcpQueryScope(req);

  console.log(`[MCP] ${request.method}${profileId ? ` (profile: ${profileId})` : ''} id=${request.id ?? 'notification'}`);

  // Validate JSON-RPC format
  if (!request || request.jsonrpc !== '2.0' || !request.method) {
    res.status(400).json({
      jsonrpc: '2.0',
      id: request?.id ?? null,
      error: {
        code: -32600,
        message: 'Invalid Request: must be a valid JSON-RPC 2.0 request',
      },
    });
    return;
  }

  // Check if this is a notification (no id field = no response expected)
  // According to JSON-RPC 2.0, notifications MUST NOT have a response
  const isNotification = request.id === undefined || request.id === null;

  if (isNotification) {
    // Handle notification-specific methods
    if (request.method === 'notifications/initialized') {
      // Client is done initializing - acknowledge with 202 Accepted, no body
      console.log('[MCP] Received initialized notification');
      res.status(202).end();
      return;
    }
    if (request.method === 'notifications/cancelled') {
      // Client cancelled a request
      console.log('[MCP] Received cancelled notification');
      res.status(202).end();
      return;
    }
    // Unknown notification - still accept it
    console.log('[MCP] Received unknown notification:', request.method);
    res.status(202).end();
    return;
  }

  const signal = createClientDisconnectSignal(req, res);

  // Get globally disabled tools
  const disabledTools = await getGlobalDisabledTools();

  // Handle the request (has id, expects response)
  const result = await handleJsonRpcRequest(
    request,
    sessionId || null,
    disabledTools,
    tabId,
    profileId,
    scope,
    signal,
  );

  // Set session ID header
  if (sessionId) {
    res.setHeader('Mcp-Session-Id', sessionId);
  } else if (result.sessionId) {
    res.setHeader('Mcp-Session-Id', result.sessionId);
  }

  // Set headers for HTTP connection handling
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Connection', 'keep-alive');

  console.log(`[MCP] Response id=${request.id ?? 'notification'}${result.sessionId ? ` session=${result.sessionId}` : ''}`);
  res.json(result.response);
}

/**
 * NOTE(interpreter-cli-mcp): Scoped `/mcp/:profileId/:tabId` is the terminal/app-server
 * MCP entrypoint that still carries a UI owner. `tabId` becomes `callerTabId`,
 * then the bridge rehydrates the full AgentTabManager binding before any MCP
 * approval can be created. Anonymous `/mcp` has no tab owner, so do not use it
 * for approval-gated app-managed MCP execution.
 *
 * Trail: [bridge](../utils/codexMcpBridge.ts) ->
 * [approval gate](../tools/toolManager.ts) ->
 * [approval owner capture](../approvalManager.ts) ->
 * [dock owner resolver](../../src/hooks/usePendingApprovalsByAgent.ts).
 */
router.post('/:profileId/:tabId', async (req: Request, res: Response) => {
  const profileId = decodeURIComponent(req.params.profileId);
  const tabId = decodeURIComponent(req.params.tabId);
  await handleMcpPostRequest(req, res, profileId, tabId);
});

/**
 * GET /mcp/:profileId/:tabId - SSE stream for server-initiated notifications (with profile + tab identity)
 */
router.get('/:profileId/:tabId', (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const accept = req.headers['accept'] || '';

  console.log('[MCP] GET request (parameterized), session:', sessionId, 'accept:', accept);

  if (accept.includes('text/event-stream')) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (sessionId) {
      res.setHeader('Mcp-Session-Id', sessionId);
      sseConnections.set(sessionId, res);
      console.log(`[MCP] SSE connection registered for session ${sessionId}, total connections: ${sseConnections.size}`);
    }

    res.write('event: open\ndata: {}\n\n');

    const interval = setInterval(() => {
      res.write('event: ping\ndata: {}\n\n');
    }, 30000);

    req.on('close', () => {
      console.log('[MCP] SSE connection closed, session:', sessionId);
      clearInterval(interval);
      if (sessionId) {
        sseConnections.delete(sessionId);
        console.log(`[MCP] SSE connection removed for session ${sessionId}, remaining: ${sseConnections.size}`);
      }
    });
    return;
  }

  res.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    protocolVersion: '2024-11-05',
  });
});

/**
 * DELETE /mcp/:profileId/:tabId - Terminate session (with profile + tab identity)
 */
router.delete('/:profileId/:tabId', (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    sessions.delete(sessionId);
    sseConnections.delete(sessionId);
    res.status(204).end();
  } else {
    res.status(404).json({
      error: 'Session not found',
    });
  }
});

/**
 * POST /mcp - Handle JSON-RPC requests (no profile filtering)
 */
router.post('/', async (req: Request, res: Response) => {
  await handleMcpPostRequest(req, res);
});

/**
 * GET /mcp - SSE stream for server-initiated notifications (optional)
 * Also serves as endpoint discovery for MCP clients
 *
 * When a client connects with Accept: text/event-stream, we store the connection
 * so we can send notifications like tools/list_changed when tools are added/removed.
 */
router.get('/', (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const accept = req.headers['accept'] || '';

  console.log('[MCP] GET request, session:', sessionId, 'accept:', accept);

  // If client wants SSE, set up the stream
  if (accept.includes('text/event-stream')) {
    // Need a session ID to track the connection
    if (!sessionId) {
      console.log('[MCP] SSE request without session ID - client should initialize first');
      // Still allow connection for backwards compatibility, but use a temp ID
    }

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (sessionId) {
      res.setHeader('Mcp-Session-Id', sessionId);
      // Track this connection for notifications
      sseConnections.set(sessionId, res);
      console.log(`[MCP] SSE connection registered for session ${sessionId}, total connections: ${sseConnections.size}`);
    }

    // Send initial message
    res.write('event: open\ndata: {}\n\n');

    // Keep connection open
    const interval = setInterval(() => {
      res.write('event: ping\ndata: {}\n\n');
    }, 30000);

    req.on('close', () => {
      console.log('[MCP] SSE connection closed, session:', sessionId);
      clearInterval(interval);
      // Remove from tracked connections
      if (sessionId) {
        sseConnections.delete(sessionId);
        console.log(`[MCP] SSE connection removed for session ${sessionId}, remaining: ${sseConnections.size}`);
      }
    });
    return;
  }

  // Otherwise return server info (for discovery)
  res.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    protocolVersion: '2024-11-05',
  });
});

/**
 * DELETE /mcp - Terminate session
 */
router.delete('/', (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    sessions.delete(sessionId);
    // Also clean up any SSE connection for this session
    sseConnections.delete(sessionId);
    res.status(204).end();
  } else {
    res.status(404).json({
      error: 'Session not found',
    });
  }
});

export default router;
