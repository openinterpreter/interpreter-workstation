import {
  getMcpService as _getMcpService,
  McpService as _McpService,
} from '../../src/lib/codex/mcp-service';

export function getMcpService() {
  return _getMcpService();
}

export const McpService = _McpService;
