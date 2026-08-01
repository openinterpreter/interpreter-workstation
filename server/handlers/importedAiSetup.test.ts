import { describe, expect, test } from 'bun:test';

import { buildImportedAiSetupSnapshotForTest } from './importedAiSetup';

describe('imported AI setup', () => {
  test('returns redacted imported MCP candidates for startup inventory', () => {
    const snapshot = buildImportedAiSetupSnapshotForTest({
      discovered: [
        {
          id: 'claude-code-github',
          name: 'GitHub',
          source: 'claude-code',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@secret/github-mcp'],
          env: { GITHUB_TOKEN: 'secret-token' },
        },
        {
          id: 'cursor-notion',
          name: 'Notion',
          source: 'cursor',
          transport: 'http',
          url: 'https://mcp.example.test/notion',
          headers: { Authorization: 'Bearer secret' },
        },
      ],
    }, '2026-06-22T12:00:00.000Z');

    expect(snapshot).toEqual({
      generatedAt: '2026-06-22T12:00:00.000Z',
      candidates: [
        {
          id: 'claude-code:github',
          name: 'GitHub',
          source: 'claude-code',
          transport: 'stdio',
          installable: true,
        },
        {
          id: 'cursor:notion',
          name: 'Notion',
          source: 'cursor',
          transport: 'http',
          installable: true,
        },
      ],
      summary: {
        generatedAt: '2026-06-22T12:00:00.000Z',
        sources: ['discovered-mcp-configs'],
        summary: 'Importable MCP servers: GitHub (Claude Code, stdio), Notion (Cursor, http).',
      },
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('@secret/github-mcp');
    expect(serialized).not.toContain('mcp.example.test');
  });
});
