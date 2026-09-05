import { afterEach, describe, expect, mock, test } from 'bun:test';

const restartCodexRuntimeMock = mock(() => {});

mock.module('../src/lib/codex/service', () => ({
  restartCodexRuntime: restartCodexRuntimeMock,
}));

import {
  clearConfigCache,
  loadConfig,
  setConfigOverride,
  type AppConfig,
} from './configStore';
import {
  applyProgrammaticTaskRuntimeConfig,
  createOpenAiApiProgrammaticProfile,
} from './programmaticTaskRuntimeConfig';

function createTestConfig(): AppConfig {
  return {
    agents: {},
    profiles: [],
    providers: {},
    mcpServers: {
      'mcp-a': {
        id: 'mcp-a',
        name: 'MCP A',
        type: 'stdio',
        command: 'echo',
        args: [],
        enabled: true,
        createdAt: Date.now(),
      },
      'mcp-b': {
        id: 'mcp-b',
        name: 'MCP B',
        type: 'stdio',
        command: 'echo',
        args: [],
        enabled: true,
        createdAt: Date.now(),
      },
    },
    globalDisabledTools: [],
    codexApprovalPolicy: 'on-failure',
    codexSandboxMode: 'workspace-write',
    codexNetworkAccess: false,
  };
}

afterEach(() => {
  clearConfigCache();
  restartCodexRuntimeMock.mockClear();
});

describe('programmaticTaskRuntimeConfig', () => {
  test('applies runtime overrides and writes a default profile without changing tool shape', async () => {
    setConfigOverride(createTestConfig());

    await applyProgrammaticTaskRuntimeConfig({
      codexApprovalPolicy: 'never',
      codexSandboxMode: 'danger-full-access',
      codexNetworkAccess: true,
      defaultProfile: createOpenAiApiProgrammaticProfile({
        id: 'programmatic:test-openai',
        name: 'Programmatic Test OpenAI',
        modelId: 'gpt-5.4-mini',
        apiKey: 'sk-test',
      }),
    });

    const config = await loadConfig();

    expect(config.globalDisabledTools).toEqual([]);
    expect(config.codexApprovalPolicy).toBe('never');
    expect(config.codexSandboxMode).toBe('danger-full-access');
    expect(config.codexNetworkAccess).toBe(true);
    expect(config.defaultProfileId).toBe('programmatic:test-openai');

    const profile = config.profiles?.find((entry) => entry.id === 'programmatic:test-openai');
    expect(profile).toBeTruthy();
    expect(profile?.provider).toBe('api');
    expect(profile?.apiFormat).toBe('openai');
    expect(profile?.codexProfileId).toBe('openai-api');
    expect(profile?.modelId).toBe('gpt-5.4-mini');
    expect(profile?.apiKey).toBe('sk-test');
    expect(profile?.wireApi).toBe('responses');
    expect(profile?.useResponsesApi).toBe(true);
    expect(restartCodexRuntimeMock).toHaveBeenCalledTimes(1);
  });

  test('can defer API credential resolution to the runtime environment', async () => {
    setConfigOverride(createTestConfig());

    await applyProgrammaticTaskRuntimeConfig({
      defaultProfile: createOpenAiApiProgrammaticProfile({
        id: 'programmatic:environment-openai',
        environmentKey: 'OPENAI_API_KEY',
      }),
    });

    const config = await loadConfig();
    const profile = config.profiles?.find((entry) => entry.id === 'programmatic:environment-openai');
    expect(profile?.environmentKey).toBe('OPENAI_API_KEY');
    expect(profile?.apiKey).toBeUndefined();
  });
});
