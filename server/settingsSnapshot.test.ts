import { describe, expect, test } from 'bun:test';

import { BUILTIN_PROFILES } from '../shared/types/profile';
import { BUILTIN_PROVIDERS } from '../shared/types/provider';
import {
  applySettingsSnapshot,
  assertValidSettingsSnapshot,
  buildSettingsSnapshot,
} from './settingsSnapshot';

describe('settings snapshot helpers', () => {
  test('buildSettingsSnapshot produces a concrete settings object', () => {
    const snapshot = buildSettingsSnapshot({
      agents: {},
    });

    expect(snapshot).toEqual({
      backgroundOpacity: 0.8,
      zoomFactor: 1,
      theme: 'system',
      language: 'en',
      primaryColor: 'gray',
      maxSteps: 1000,
      maxSubagentDepth: 5,
      autoContinuationLimit: 10,
      showHelpPanelPreview: false,
      reviewMarkdownEdits: true,
      launchAtLogin: false,
      autoApproveLowRiskMediaCards: false,
      telemetryEnabled: false,
      allowAgentAddTools: true,
      allowLocalMcpServers: false,
      skillFolders: [],
      allowModelSkillEditing: true,
    });
  });

  test('applySettingsSnapshot preserves unrelated config sections', () => {
    const providers: Record<string, any> = {};
    for (const provider of BUILTIN_PROVIDERS) {
      providers[provider.id] = provider;
    }

    const baseConfig = {
      agents: {
        'agent-1': { authenticated: true },
      },
      profiles: [{ ...BUILTIN_PROFILES[0], isBuiltin: true }],
      providers,
      mcpServers: {
        demo: {
          id: 'demo',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
        },
      },
    };

    const nextConfig = applySettingsSnapshot(baseConfig, {
      ...buildSettingsSnapshot(baseConfig),
      theme: 'dark',
      skillFolders: ['/tmp/skills-b'],
    });

    expect(nextConfig.theme).toBe('dark');
    expect(nextConfig.skillFolders).toEqual(['/tmp/skills-b']);
    expect(nextConfig.agents).toEqual(baseConfig.agents);
    expect(nextConfig.profiles).toEqual(baseConfig.profiles);
    expect(nextConfig.providers).toEqual(baseConfig.providers);
    expect(nextConfig.mcpServers).toEqual(baseConfig.mcpServers);
  });

  test('assertValidSettingsSnapshot rejects invalid snapshots', () => {
    expect(() =>
      assertValidSettingsSnapshot({
        ...buildSettingsSnapshot({ agents: {} }),
        theme: 'neon' as any,
      }),
    ).toThrow('Invalid settings snapshot');
  });
});
