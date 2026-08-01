/**
 * MCP Discovery Handler
 *
 * Scans the user's home directory for globally configured MCP servers:
 * - Claude Code: ~/.claude.json (user-scope MCPs)
 * - Cursor: ~/.cursor/mcp.json (global MCPs)
 *
 * Note: Project-scope configs (.mcp.json, .cursor/mcp.json) are not scanned
 * because searching the entire filesystem would be impractical.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { McpTransportType } from '../tools/mcpTypes';

export interface DiscoveredMcp {
  id: string;
  name: string;
  source: 'claude-code' | 'cursor';
  transport: McpTransportType;
  // For stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // For http/sse
  url?: string;
  headers?: Record<string, string>;
  oauthResource?: string;
}

export interface McpDiscoveryResult {
  discovered: DiscoveredMcp[];
  sources: {
    claudeCode: { found: boolean; path: string };
    cursor: { found: boolean; path: string };
  };
}

/**
 * Parse Claude Code config file (.claude.json or ~/.claude.json)
 */
function parseClaudeCodeConfig(configPath: string): DiscoveredMcp[] {
  const discovered: DiscoveredMcp[] = [];

  try {
    if (!existsSync(configPath)) {
      return discovered;
    }

    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    // Claude Code stores MCPs under mcpServers key
    const mcpServers = config.mcpServers || {};

    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      const server = serverConfig as any;

      // Determine transport type
      let transport: McpTransportType = 'stdio';
      if (server.type === 'http' || server.url?.startsWith('http')) {
        transport = 'http';
      } else if (server.type === 'sse') {
        transport = 'sse';
      }

      const mcp: DiscoveredMcp = {
        id: `claude-code-${name}`,
        name,
        source: 'claude-code',
        transport,
      };

      if (transport === 'stdio') {
        mcp.command = server.command;
        mcp.args = server.args || [];
        mcp.env = server.env || {};
      } else {
        mcp.url = server.url;
        mcp.headers = server.headers || {};
        if (typeof server.oauthResource === 'string') {
          mcp.oauthResource = server.oauthResource;
        }
      }

      discovered.push(mcp);
    }
  } catch (error) {
    console.error(`[MCP Discovery] Error parsing Claude Code config at ${configPath}:`, error);
  }

  return discovered;
}

/**
 * Parse Cursor config file (~/.cursor/mcp.json or .cursor/mcp.json)
 */
function parseCursorConfig(configPath: string): DiscoveredMcp[] {
  const discovered: DiscoveredMcp[] = [];

  try {
    if (!existsSync(configPath)) {
      return discovered;
    }

    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    // Cursor stores MCPs under mcpServers key
    const mcpServers = config.mcpServers || {};

    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      const server = serverConfig as any;

      // Determine transport type
      let transport: McpTransportType = 'stdio';
      if (server.transport === 'http' || server.url?.startsWith('http')) {
        transport = 'http';
      } else if (server.transport === 'sse') {
        transport = 'sse';
      }

      const mcp: DiscoveredMcp = {
        id: `cursor-${name}`,
        name,
        source: 'cursor',
        transport,
      };

      if (transport === 'stdio') {
        mcp.command = server.command;
        mcp.args = server.args || [];
        mcp.env = server.env || {};
      } else {
        mcp.url = server.url;
        mcp.headers = server.headers || {};
        if (typeof server.oauthResource === 'string') {
          mcp.oauthResource = server.oauthResource;
        }
      }

      discovered.push(mcp);
    }
  } catch (error) {
    console.error(`[MCP Discovery] Error parsing Cursor config at ${configPath}:`, error);
  }

  return discovered;
}

/**
 * Discover MCPs from Claude Code and Cursor configurations (global only)
 */
export async function discoverMcps(): Promise<McpDiscoveryResult> {
  const home = homedir();

  // Claude Code paths
  const claudeCodePath = join(home, '.claude.json');

  // Cursor paths
  const cursorPath = join(home, '.cursor', 'mcp.json');

  // Parse configs
  const claudeCodeMcps = parseClaudeCodeConfig(claudeCodePath);
  const cursorMcps = parseCursorConfig(cursorPath);

  // Combine and deduplicate by name (prefer Claude Code over Cursor)
  const seenNames = new Set<string>();
  const discovered: DiscoveredMcp[] = [];

  for (const mcp of [...claudeCodeMcps, ...cursorMcps]) {
    if (!seenNames.has(mcp.name)) {
      seenNames.add(mcp.name);
      discovered.push(mcp);
    }
  }

  return {
    discovered,
    sources: {
      claudeCode: {
        found: existsSync(claudeCodePath),
        path: claudeCodePath,
      },
      cursor: {
        found: existsSync(cursorPath),
        path: cursorPath,
      },
    },
  };
}

/**
 * Deep scan specific folders for project-scope MCP configs.
 * Scans Documents, Downloads, and Desktop for .mcp.json and .cursor/mcp.json files.
 * This may trigger macOS permission dialogs.
 */
export async function deepScanForMcps(): Promise<{ discovered: DiscoveredMcp[]; scannedFolders: string[] }> {
  const home = homedir();
  const foldersToScan = [
    join(home, 'Documents'),
    join(home, 'Downloads'),
    join(home, 'Desktop'),
  ];

  const discovered: DiscoveredMcp[] = [];
  const seenNames = new Set<string>();
  const scannedFolders: string[] = [];

  // Import fs promises for async operations
  const { readdir } = await import('fs/promises');

  // Recursive function to find MCP config files
  async function scanDirectory(dirPath: string, depth: number = 0): Promise<void> {
    // Limit depth to avoid going too deep
    if (depth > 5) return;

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        // Skip hidden directories (except .cursor)
        if (entry.name.startsWith('.') && entry.name !== '.cursor') {
          continue;
        }

        // Skip common large directories
        if (['node_modules', '.git', 'Library', '.Trash'].includes(entry.name)) {
          continue;
        }

        if (entry.isDirectory()) {
          // Check for .mcp.json (Claude Code project config)
          const mcpJsonPath = join(fullPath, '.mcp.json');
          if (existsSync(mcpJsonPath)) {
            const mcps = parseClaudeCodeConfig(mcpJsonPath);
            for (const mcp of mcps) {
              // Modify the ID to indicate it's from a project scan
              mcp.id = `project-claude-${mcp.name}-${depth}`;
              if (!seenNames.has(mcp.name)) {
                seenNames.add(mcp.name);
                discovered.push(mcp);
              }
            }
          }

          // Check for .cursor/mcp.json (Cursor project config)
          const cursorMcpPath = join(fullPath, '.cursor', 'mcp.json');
          if (existsSync(cursorMcpPath)) {
            const mcps = parseCursorConfig(cursorMcpPath);
            for (const mcp of mcps) {
              // Modify the ID to indicate it's from a project scan
              mcp.id = `project-cursor-${mcp.name}-${depth}`;
              if (!seenNames.has(mcp.name)) {
                seenNames.add(mcp.name);
                discovered.push(mcp);
              }
            }
          }

          // Recurse into subdirectories
          await scanDirectory(fullPath, depth + 1);
        }
      }
    } catch (error) {
      // Silently skip directories we can't access
      console.debug(`[MCP Discovery] Skipping ${dirPath}:`, error);
    }
  }

  // Scan each folder
  for (const folder of foldersToScan) {
    if (existsSync(folder)) {
      scannedFolders.push(folder);
      await scanDirectory(folder);
    }
  }

  return { discovered, scannedFolders };
}
