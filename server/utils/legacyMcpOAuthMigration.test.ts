import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppConfig } from '../configStore';
import {
  computeCodexMcpOAuthStorageKey,
  migrateLegacyMcpOAuthToCodex,
} from './legacyMcpOAuthMigration';

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    agents: {},
    ...overrides,
  };
}

describe('migrateLegacyMcpOAuthToCodex', () => {
  let codexHome: string;

  beforeEach(async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'legacy-mcp-oauth-'));
  });

  afterEach(async () => {
    await rm(codexHome, { recursive: true, force: true });
  });

  test('migrates matching legacy OAuth entries into the Codex fallback credentials file', async () => {
    const config = createConfig({
      mcpServers: {
        github: {
          id: 'github',
          name: 'GitHub',
          transport: 'http',
          url: 'https://mcp.example.com',
          enabled: true,
          createdAt: 1,
        },
      },
    }) as AppConfig & { mcpOAuth?: Record<string, unknown> };

    config.mcpOAuth = {
      'https://mcp.example.com': {
        tokens: {
          access_token: 'access-token',
          token_type: 'Bearer',
          refresh_token: 'refresh-token',
          scope: 'repo user',
          expires_at: 1_712_345_678,
        },
        clientInfo: {
          client_id: 'client-123',
        },
      },
    };

    const result = await migrateLegacyMcpOAuthToCodex(config, { codexHome });

    expect(result.changed).toBe(true);
    expect(result.migratedLegacyUrls).toEqual(['https://mcp.example.com']);
    expect((config as { mcpOAuth?: Record<string, unknown> }).mcpOAuth).toBeUndefined();

    const stored = JSON.parse(
      await readFile(join(codexHome, '.credentials.json'), 'utf-8'),
    ) as Record<string, Record<string, unknown>>;

    expect(Object.keys(stored)).toHaveLength(1);
    expect(Object.keys(stored)[0]).toBe(
      computeCodexMcpOAuthStorageKey('github', 'https://mcp.example.com'),
    );
    expect(Object.values(stored)[0]).toEqual({
      server_name: 'github',
      server_url: 'https://mcp.example.com',
      client_id: 'client-123',
      access_token: 'access-token',
      expires_at: 1_712_345_678_000,
      refresh_token: 'refresh-token',
      scopes: ['repo', 'user'],
    });
  });

  test('leaves unmatched or invalid legacy entries behind while migrating valid ones', async () => {
    const config = createConfig({
      mcpServers: {
        github: {
          id: 'github',
          name: 'GitHub',
          transport: 'http',
          url: 'https://mcp.example.com',
          enabled: true,
          createdAt: 1,
        },
        local: {
          id: 'local',
          name: 'Local',
          transport: 'stdio',
          command: 'node',
          enabled: true,
          createdAt: 2,
        },
      },
    }) as AppConfig & { mcpOAuth?: Record<string, unknown> };

    config.mcpOAuth = {
      'https://mcp.example.com': {
        tokens: {
          access_token: 'access-token',
          token_type: 'Bearer',
        },
        clientInfo: {
          client_id: 'client-123',
        },
      },
      'https://missing-client.example.com': {
        tokens: {
          access_token: 'other-access-token',
          token_type: 'Bearer',
        },
      },
      'https://missing-access-token.example.com': {
        tokens: {
          token_type: 'Bearer',
        },
        clientInfo: {
          client_id: 'client-789',
        },
      },
      'https://no-server.example.com': {
        tokens: {
          access_token: 'third-access-token',
          token_type: 'Bearer',
        },
        clientInfo: {
          client_id: 'client-456',
        },
      },
    };

    const result = await migrateLegacyMcpOAuthToCodex(config, { codexHome });

    expect(result.changed).toBe(true);
    expect(result.migratedLegacyUrls).toEqual(['https://mcp.example.com']);
    expect(result.skippedLegacyUrls).toEqual([
      'https://missing-client.example.com',
      'https://missing-access-token.example.com',
      'https://no-server.example.com',
    ]);
    expect(config.mcpOAuth).toEqual({
      'https://missing-client.example.com': {
        tokens: {
          access_token: 'other-access-token',
          token_type: 'Bearer',
        },
      },
      'https://missing-access-token.example.com': {
        tokens: {
          token_type: 'Bearer',
        },
        clientInfo: {
          client_id: 'client-789',
        },
      },
      'https://no-server.example.com': {
        tokens: {
          access_token: 'third-access-token',
          token_type: 'Bearer',
        },
        clientInfo: {
          client_id: 'client-456',
        },
      },
    });
  });

  test('migrates the same legacy URL into every matching MCP server id', async () => {
    const config = createConfig({
      mcpServers: {
        githubPrimary: {
          id: 'githubPrimary',
          name: 'GitHub Primary',
          transport: 'http',
          url: 'https://mcp.example.com',
          enabled: true,
          createdAt: 1,
        },
        githubBackup: {
          id: 'githubBackup',
          name: 'GitHub Backup',
          transport: 'http',
          url: 'https://mcp.example.com',
          enabled: false,
          createdAt: 2,
        },
      },
    }) as AppConfig & { mcpOAuth?: Record<string, unknown> };

    config.mcpOAuth = {
      'https://mcp.example.com': {
        tokens: {
          access_token: 'access-token',
          token_type: 'Bearer',
        },
        clientInfo: {
          client_id: 'client-123',
        },
      },
    };

    await migrateLegacyMcpOAuthToCodex(config, { codexHome });

    const stored = JSON.parse(
      await readFile(join(codexHome, '.credentials.json'), 'utf-8'),
    ) as Record<string, Record<string, unknown>>;

    expect(Object.keys(stored)).toHaveLength(2);
    expect(Object.keys(stored).sort()).toEqual([
      computeCodexMcpOAuthStorageKey('githubBackup', 'https://mcp.example.com'),
      computeCodexMcpOAuthStorageKey('githubPrimary', 'https://mcp.example.com'),
    ]);
  });

  test('does not overwrite existing fallback credentials and treats the legacy entry as satisfied', async () => {
    const existingKey = computeCodexMcpOAuthStorageKey('github', 'https://mcp.example.com');
    await writeFile(
      join(codexHome, '.credentials.json'),
      JSON.stringify({
        [existingKey]: {
          server_name: 'github',
          server_url: 'https://mcp.example.com',
          client_id: 'existing-client',
          access_token: 'existing-access-token',
          expires_at: 999,
          refresh_token: 'existing-refresh-token',
          scopes: ['existing'],
        },
      }),
      'utf-8',
    );

    const config = createConfig({
      mcpServers: {
        github: {
          id: 'github',
          name: 'GitHub',
          transport: 'http',
          url: 'https://mcp.example.com',
          enabled: true,
          createdAt: 1,
        },
      },
    }) as AppConfig & { mcpOAuth?: Record<string, unknown> };

    config.mcpOAuth = {
      'https://mcp.example.com': {
        tokens: {
          access_token: 'new-access-token',
          token_type: 'Bearer',
        },
        clientInfo: {
          client_id: 'new-client',
        },
      },
    };

    const result = await migrateLegacyMcpOAuthToCodex(config, { codexHome });

    expect(result.changed).toBe(true);
    expect((config as { mcpOAuth?: Record<string, unknown> }).mcpOAuth).toBeUndefined();

    const stored = JSON.parse(
      await readFile(join(codexHome, '.credentials.json'), 'utf-8'),
    ) as Record<string, Record<string, unknown>>;

    expect(stored[existingKey]).toEqual({
      server_name: 'github',
      server_url: 'https://mcp.example.com',
      client_id: 'existing-client',
      access_token: 'existing-access-token',
      expires_at: 999,
      refresh_token: 'existing-refresh-token',
      scopes: ['existing'],
    });
  });

  test('leaves legacy OAuth state untouched when the existing credentials file is invalid JSON', async () => {
    await writeFile(join(codexHome, '.credentials.json'), '{not-json', 'utf-8');

    const config = createConfig({
      mcpServers: {
        github: {
          id: 'github',
          name: 'GitHub',
          transport: 'http',
          url: 'https://mcp.example.com',
          enabled: true,
          createdAt: 1,
        },
      },
    }) as AppConfig & { mcpOAuth?: Record<string, unknown> };

    config.mcpOAuth = {
      'https://mcp.example.com': {
        tokens: {
          access_token: 'access-token',
          token_type: 'Bearer',
        },
        clientInfo: {
          client_id: 'client-123',
        },
      },
    };

    const result = await migrateLegacyMcpOAuthToCodex(config, { codexHome });

    expect(result.changed).toBe(false);
    expect(config.mcpOAuth).toEqual({
      'https://mcp.example.com': {
        tokens: {
          access_token: 'access-token',
          token_type: 'Bearer',
        },
        clientInfo: {
          client_id: 'client-123',
        },
      },
    });
    expect(await readFile(join(codexHome, '.credentials.json'), 'utf-8')).toBe('{not-json');
  });

  test('is idempotent on repeated runs', async () => {
    const config = createConfig({
      mcpServers: {
        github: {
          id: 'github',
          name: 'GitHub',
          transport: 'http',
          url: 'https://mcp.example.com',
          enabled: true,
          createdAt: 1,
        },
      },
    }) as AppConfig & { mcpOAuth?: Record<string, unknown> };

    config.mcpOAuth = {
      'https://mcp.example.com': {
        tokens: {
          access_token: 'access-token',
          token_type: 'Bearer',
        },
        clientInfo: {
          client_id: 'client-123',
        },
      },
    };

    const firstResult = await migrateLegacyMcpOAuthToCodex(config, { codexHome });
    const secondResult = await migrateLegacyMcpOAuthToCodex(config, { codexHome });

    expect(firstResult.changed).toBe(true);
    expect(secondResult.changed).toBe(false);

    const stored = JSON.parse(
      await readFile(join(codexHome, '.credentials.json'), 'utf-8'),
    ) as Record<string, Record<string, unknown>>;
    expect(Object.keys(stored)).toHaveLength(1);
  });
});
