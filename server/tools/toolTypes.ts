// Generic tool types (used for both MCP and built-in tools)

export interface ToolCallRequest {
  serverId: string;
  toolName: string;
  arguments: Record<string, any>;
  saveToDisk?: boolean; // If true, save response to file and return path
}

export interface ToolCallResponse {
  content: Array<{
    type: string;
    text?: string;
    image?: {
      data: string; // base64
      mimeType: string;
    };
    [key: string]: any;
  }>;
  isError?: boolean;
  savedToPath?: string; // If saveToDisk=true, path to saved file
  imagePaths?: string[]; // Paths to any saved images
}

export interface ToolResourceReadRequest {
  serverId: string;
  uri: string;
}

export interface ToolResourceReadResponse {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  }>;
}

// Connection state (used for both MCP and built-in tools)
export type ToolConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; tools: any[]; resources: any[]; prompts: any[] }
  | { status: 'failed'; error: string; needsAuth?: boolean };

// Unified tool server status
export interface ToolServerStatus {
  id: string;
  name: string;
  description?: string;
  state: ToolConnectionState;
  config?: any; // Config is optional and type depends on tool provider (MCP, built-in, etc)
  globallyDisabled?: boolean; // True if tool is disabled globally in Settings → Tools
}
