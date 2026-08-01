/**
 * Configuration for terminal-based coding agents (Claude Code, Codex, etc.)
 */

export type TerminalAgentId = 'claude-code' | 'codex';

export interface TerminalAgentConfig {
  id: TerminalAgentId;
  name: string;
  command: string;
  titleMarker: string;
  icon: 'claude' | 'openai'; // Brand icon identifier
  helpDescription: string; // Description shown in help panel on hover
  // Temporarily disabled: terminal profiles launch the raw CLI command with no injected MCP args.
  // getMcpArgs?: (port: number, profileId?: string, tabId?: string) => string;
}

export const TERMINAL_AGENTS: Record<TerminalAgentId, TerminalAgentConfig> = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    titleMarker: '⏺',
    icon: 'claude',
    helpDescription: 'Reuse your installed Claude Code CLI in a terminal. The embedded terminal launches the local claude command as-is.',
    // getMcpArgs: (port: number, profileId?: string, tabId?: string) => {
    //   const endpoint = profileId && tabId
    //     ? `/mcp/${encodeURIComponent(profileId)}/${encodeURIComponent(tabId)}`
    //     : '/mcp';
    //   const mcpConfig = {
    //     mcpServers: {
    //       interpreter: {
    //         type: 'http',
    //         url: `http://localhost:${port}${endpoint}`,
    //       },
    //     },
    //   };
    //   const configJson = JSON.stringify(JSON.stringify(mcpConfig));
    //   return `--allowedTools "Read,Edit,Write,Bash" --permission-mode acceptEdits --strict-mcp-config --mcp-config ${configJson}`;
    // },
  },
  'codex': {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    titleMarker: '•',
    icon: 'openai',
    helpDescription: 'Reuse your installed Codex CLI in a terminal. The embedded terminal launches the local codex command as-is.',
    // getMcpArgs: (port: number, profileId?: string, tabId?: string) => {
    //   const endpoint = profileId && tabId
    //     ? `/mcp/${encodeURIComponent(profileId)}/${encodeURIComponent(tabId)}`
    //     : '/mcp';
    //   return `--config mcp_servers.interpreter.url=http://localhost:${port}${endpoint}`;
    // },
  },
};

// Helper to get all terminal agents as an array (for rendering lists)
export const TERMINAL_AGENT_LIST = Object.values(TERMINAL_AGENTS);
