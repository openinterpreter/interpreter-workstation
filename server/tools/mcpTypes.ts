// MCP-specific types
// For generic tool types, see toolTypes.ts

import type { ToolConnectionState } from './toolTypes';

export type McpServerId = string;

export type McpTransportType = 'stdio' | 'http' | 'sse' | 'websocket';

// MCP connection state (alias to generic ToolConnectionState)
export type McpConnectionState = ToolConnectionState;

export type McpToolApprovalMode = 'auto' | 'prompt' | 'approve';

export interface McpServerToolConfig {
  approvalMode?: McpToolApprovalMode;
}

export interface McpServerConnectionFailure {
  error: string;
  needsAuth?: boolean;
  updatedAt: number;
}

export interface McpServerConfig {
  id: string;
  name: string;
  description?: string;
  transport: McpTransportType;

  // Transport-specific
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauthResource?: string;
  wsUrl?: string;

  // Status (stored in config for persistence)
  enabled: boolean;
  defaultToolsApprovalMode?: McpToolApprovalMode;
  tools?: Record<string, McpServerToolConfig>;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  createdAt: number;
  lastConnectedAt?: number;
  lastConnectionFailure?: McpServerConnectionFailure;
}

export interface McpServerStatus {
  id: McpServerId;
  name: string;
  description?: string;
  state: McpConnectionState; // Real-time state
  config: McpServerConfig; // Persisted config from AppConfig
}

// Re-export ToolServerStatus for convenience
export type { ToolServerStatus } from './toolTypes';
