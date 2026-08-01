import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { constants } from 'node:fs';
import { readFile, writeFile, mkdir, unlink, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  loadConfig,
  clearConfigCache,
  setConfigOverride,
  configStoreFs,
  getConfigPath,
  getWatchedConfigFilePathForTests,
  getAuthTokens,
  setAuthTokens,
  clearAuthTokens,
  getPermissions,
  setPermissions,
  setCodexReadAccessMode,
  setCodexSandboxMode,
  getCodexReadAccessMode,
  getCodexSandboxMode,
  getBooleanUISetting,
  setBooleanUISetting,
  getBooleanUISettingSync,
  getZoomFactor,
  setZoomFactor,
  getCustomInstructions,
  getOnboardingCustomInstructionsDraft,
  setCustomInstructions,
  getInterpreterOverlaySettings,
  setInterpreterOverlaySettings,
  getOnboardingState,
  resetOnboardingState,
  setOnboardingState,
  getUserName,
  setUserName,
  getAppLaunchCount,
  incrementAppLaunchCount,
  getCodexNetworkAccess,
  getCuaAccessPolicy,
  isBuiltinToolEnabled,
  listBuiltinToolsEnabled,
  setCuaAccessPolicy,
  getSttSettings,
  setLanguage,
  setLastWorkspace,
} from './configStore';
import { BUILTIN_PROVIDERS } from '../shared/types/provider';
import { BUILTIN_PROFILES } from '../shared/types/profile';
import { DEFAULT_STT_SETTINGS } from '../shared/types/stt';
import {
  buildOnboardingCustomInstructionsDraft,
  createDefaultOnboardingState,
  ONBOARDING_STATE_VERSION,
} from '../shared/types/onboardingState';
import { resolveInterpreterConfigFile, resolveLegacyInterpreterConfigFile } from '../shared/interpreterConfigPaths';
import { CURRENT_CONFIG_VERSION } from './configMigrations';
import { DEFAULT_CUA_ACCESS_POLICY } from '../shared/cuaAccessPolicy';

const CONFIG_FILE = resolveInterpreterConfigFile();
const CONFIG_DIR = dirname(CONFIG_FILE);
const LEGACY_CONFIG_FILE = resolveLegacyInterpreterConfigFile();
const LEGACY_CONFIG_DIR = dirname(LEGACY_CONFIG_FILE);
const CREDENTIALS_FILE = join(CONFIG_DIR, 'codex-home', '.credentials.json');

let originalConfig: string | null = null;
let originalLegacyConfig: string | null = null;
let originalCredentials: string | null = null;

async function backupFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function restoreFile(filePath: string, content: string | null) {
  if (content !== null) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    return;
  }

  try {
    await unlink(filePath);
  } catch {}
}

async function backupConfig() {
  originalConfig = await backupFile(CONFIG_FILE);
  originalLegacyConfig = await backupFile(LEGACY_CONFIG_FILE);
  originalCredentials = await backupFile(CREDENTIALS_FILE);
}

async function restoreConfig() {
  await restoreFile(CONFIG_FILE, originalConfig);
  await restoreFile(LEGACY_CONFIG_FILE, originalLegacyConfig);
  await restoreFile(CREDENTIALS_FILE, originalCredentials);
  clearConfigCache();
}

async function writeCorruptConfig(content: string) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, content, 'utf-8');
  clearConfigCache();
}

async function writeLegacyConfig(content: string) {
  try {
    await unlink(CONFIG_FILE);
  } catch {}

  await mkdir(LEGACY_CONFIG_DIR, { recursive: true });
  await writeFile(LEGACY_CONFIG_FILE, content, 'utf-8');
  clearConfigCache();
}

function assertValidConfig(config: any) {
  expect(config).toBeDefined();
  expect(typeof config).toBe('object');
  expect(config).not.toBeNull();
  expect(Array.isArray(config)).toBe(false);
  expect(typeof config.agents).toBe('object');
}

await backupConfig();
afterAll(restoreConfig);

beforeEach(() => {
  clearConfigCache();
});

// NOTE(victor): conf's `watch: true` crashed the main process on async EMFILE (Sentry ELECTRON-GB);
// see startConfigFileWatcher. The replacement fs.watchFile poller must start and stop with the store.
describe('config file watcher lifecycle', () => {
  test('stat-polling watcher starts with the store, stops on reset, restarts with a fresh store', () => {
    const configPath = getConfigPath();
    expect(getWatchedConfigFilePathForTests()).toBe(configPath);
    clearConfigCache();
    expect(getWatchedConfigFilePathForTests()).toBeNull();
    getConfigPath();
    expect(getWatchedConfigFilePathForTests()).toBe(configPath);
  });
});

// NOTE(victor): config.json containing non-object JSON (e.g. `null`) bypasses SyntaxError catch,
// reaches validateBuiltins which assumes non-null object, crashes app on startup with uncaught TypeError.
describe('loadConfig recovers from corrupt config files', () => {
  const NON_OBJECT_JSON = [
    { name: 'null', content: 'null' },
    { name: 'true', content: 'true' },
    { name: 'false', content: 'false' },
    { name: 'number', content: '42' },
    { name: 'string', content: '"hello"' },
    { name: 'array', content: '[1,2,3]' },
    { name: 'array of objects', content: '[{"id":"x"}]' },
  ];

  for (const { name, content } of NON_OBJECT_JSON) {
    test(`recovers when config file is valid JSON but non-object: ${name}`, async () => {
      await writeCorruptConfig(content);
      const config = await loadConfig();
      assertValidConfig(config);
    });
  }

  const MALFORMED_CONTENT = [
    { name: 'truncated JSON', content: '{"agents":' },
    { name: 'HTML', content: '<html>Error</html>' },
    { name: 'plain text', content: 'not json' },
    { name: 'empty file', content: '' },
    { name: 'whitespace only', content: '   \n\t  ' },
    { name: 'undefined literal', content: 'undefined' },
    { name: 'binary garbage', content: '\x00\x01\x02' },
  ];

  for (const { name, content } of MALFORMED_CONTENT) {
    test(`recovers when config file is malformed: ${name}`, async () => {
      await writeCorruptConfig(content);
      const config = await loadConfig();
      assertValidConfig(config);
    });
  }

  const INCOMPLETE_CONFIGS = [
    { name: 'empty object', content: '{}' },
    { name: 'empty profiles', content: '{"profiles":[],"providers":{}}' },
    { name: 'null profiles field', content: '{"profiles":null,"providers":{}}' },
    {
      name: 'missing one builtin provider',
      content: JSON.stringify({
        agents: {},
        profiles: [],
        providers: Object.fromEntries(BUILTIN_PROVIDERS.slice(1).map(p => [p.id, p])),
      }),
    },
  ];

  for (const { name, content } of INCOMPLETE_CONFIGS) {
    test(`recovers when config is incomplete: ${name}`, async () => {
      await writeCorruptConfig(content);
      const config = await loadConfig();
      assertValidConfig(config);
    });
  }
});

describe('auth and workspace writes recover from malformed config', () => {
  test('setAuthTokens repairs truncated config and persists tokens', async () => {
    await writeCorruptConfig('{"agents":');

    await setAuthTokens('access-token', 'refresh-token');

    const config = await loadConfig();
    assertValidConfig(config);
    expect(config.authToken).toBe('access-token');
    expect(config.refreshToken).toBe('refresh-token');

    const storedTokens = await getAuthTokens();
    expect(storedTokens).toEqual({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    });

    const persistedConfig = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    expect(persistedConfig.authToken).toBe('access-token');
    expect(persistedConfig.refreshToken).toBe('refresh-token');
  });

  test('setAuthTokens repairs non-object JSON and persists tokens', async () => {
    await writeCorruptConfig('null');

    await setAuthTokens('access-token', 'refresh-token');

    const config = await loadConfig();
    assertValidConfig(config);
    expect(config.authToken).toBe('access-token');
    expect(config.refreshToken).toBe('refresh-token');
  });

  test('clearAuthTokens repairs malformed config and clears stored tokens', async () => {
    await writeCorruptConfig('{"agents":');

    await clearAuthTokens();

    const config = await loadConfig();
    assertValidConfig(config);
    expect(config.authToken).toBeUndefined();
    expect(config.refreshToken).toBeUndefined();

    const storedTokens = await getAuthTokens();
    expect(storedTokens).toEqual({
      access_token: null,
      refresh_token: null,
    });
  });

  test('workspace save and auth token write both persist after malformed config recovery', async () => {
    await writeCorruptConfig('{"agents":');

    await setLastWorkspace('/tmp/issue-1102-workspace');
    await setAuthTokens('access-token', 'refresh-token');

    const config = await loadConfig();
    assertValidConfig(config);
    expect(config.lastWorkspace).toBe('/tmp/issue-1102-workspace');
    expect(config.authToken).toBe('access-token');
    expect(config.refreshToken).toBe('refresh-token');

    const persistedConfig = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    expect(persistedConfig.lastWorkspace).toBe('/tmp/issue-1102-workspace');
    expect(persistedConfig.authToken).toBe('access-token');
    expect(persistedConfig.refreshToken).toBe('refresh-token');
  });

  test('concurrent workspace and auth writes recover from malformed config without losing either update', async () => {
    await writeCorruptConfig('{"agents":');

    await Promise.all([
      setLastWorkspace('/tmp/issue-1102-concurrent-workspace'),
      setAuthTokens('concurrent-access-token', 'concurrent-refresh-token'),
    ]);

    const config = await loadConfig();
    assertValidConfig(config);
    expect(config.lastWorkspace).toBe('/tmp/issue-1102-concurrent-workspace');
    expect(config.authToken).toBe('concurrent-access-token');
    expect(config.refreshToken).toBe('concurrent-refresh-token');
  });
});

describe('loadConfig recovers from unexpected errors', () => {
  // NOTE(victor): chmod 0o000 is a Unix concept -- on Windows it silently succeeds
  // without restricting read access, so conf reads the corrupt content and its
  // debounced onChange handler throws an async SyntaxError outside the test's try/catch.
  test.skipIf(process.platform === 'win32')('should return in-memory defaults when config file is unreadable (EACCES)', async () => {
    const { chmod } = await import('node:fs/promises');
    await writeCorruptConfig('{"this will not parse');
    try {
      await chmod(CONFIG_FILE, 0o000);
    } catch {
      return;
    }

    try {
      await access(CONFIG_FILE, constants.R_OK);
      await chmod(CONFIG_FILE, 0o644).catch(() => {});
      return;
    } catch {
      // Continue only when the file truly became unreadable.
    }

    try {
      const config = await loadConfig();
      assertValidConfig(config);
    } finally {
      await chmod(CONFIG_FILE, 0o644).catch(() => {});
    }
  });
});

describe('loadConfig preserves valid config', () => {
  test('round-trips a valid config with custom data', async () => {
    const providers: Record<string, any> = {};
    for (const p of BUILTIN_PROVIDERS) {
      providers[p.id] = p;
    }
    const validConfig = {
      agents: { 'test-agent': { authenticated: true } },
      primaryColor: 'blue',
      profiles: [
        {
          id: 'custom:test',
          name: 'Test Profile',
          modelId: 'gpt-5.2',
          provider: 'openai-oauth',
          providerId: 'builtin:openai-oauth',
          isBuiltin: false,
        },
      ],
      providers,
      theme: 'dark',
    };

    await writeCorruptConfig(JSON.stringify(validConfig));
    const config = await loadConfig();
    assertValidConfig(config);
    expect(config.theme).toBe('dark');
    expect((config as any).agents['test-agent'].authenticated).toBe(true);
  });
});

describe('loadConfig migrates config.json to the user data directory', () => {
  test('moves the legacy config file and deletes ~/.interpreter/config.json', async () => {
    const legacyConfig = {
      agents: {},
      theme: 'dark',
      authToken: 'access-token',
      refreshToken: 'refresh-token',
    };

    await writeLegacyConfig(JSON.stringify(legacyConfig));

    const config = await loadConfig();
    expect(config.theme).toBe('dark');
    expect(config.authToken).toBe('access-token');
    expect(config.refreshToken).toBe('refresh-token');

    const migratedConfig = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    expect(migratedConfig.theme).toBe('dark');
    expect(migratedConfig.authToken).toBe('access-token');

    let legacyExists = true;
    try {
      await access(LEGACY_CONFIG_FILE);
    } catch {
      legacyExists = false;
    }
    expect(legacyExists).toBe(false);
  });

  test('does not phone home when distribution telemetry is not configured', async () => {
    const fetchMock = mock(async () => new Response(null, { status: 204 }));
    const originalFetch = global.fetch;
    global.fetch = fetchMock as typeof fetch;

    try {
      await writeLegacyConfig(JSON.stringify({
        agents: {},
        telemetryEnabled: true,
        deviceId: '00000000-0000-0000-0000-000000000000',
      }));

      await loadConfig();

      for (let attempt = 0; attempt < 20 && fetchMock.mock.calls.length < 1; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('imports the restored legacy config even when userData config.json already exists', async () => {
    const existingConfig = {
      agents: {},
      userName: 'Branch User',
      authToken: 'branch-access-token',
      refreshToken: 'branch-refresh-token',
      configVersion: CURRENT_CONFIG_VERSION,
    };
    const legacyConfig = {
      agents: {},
      userName: 'Legacy User',
      authToken: 'legacy-access-token',
      refreshToken: 'legacy-refresh-token',
      profiles: [
        {
          id: 'custom:test',
          name: 'Legacy Profile',
          modelId: 'gpt-5.4',
          provider: 'api',
          isBuiltin: false,
        },
      ],
      providers: {},
      defaultProfileId: 'custom:test',
      configVersion: CURRENT_CONFIG_VERSION,
    };

    await writeCorruptConfig(JSON.stringify(existingConfig));
    await mkdir(LEGACY_CONFIG_DIR, { recursive: true });
    await writeFile(LEGACY_CONFIG_FILE, JSON.stringify(legacyConfig), 'utf-8');
    clearConfigCache();

    const config = await loadConfig();
    expect(config.userName).toBe('Legacy User');
    expect(config.authToken).toBe('legacy-access-token');
    expect(config.refreshToken).toBe('legacy-refresh-token');
    expect(config.defaultProfileId).toBe('custom:test');
    expect(config.profiles).toHaveLength(1);
    expect(config.profiles?.[0]?.name).toBe('Legacy Profile');

    const migratedConfig = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    expect(migratedConfig.userName).toBe('Legacy User');
    expect(migratedConfig.authToken).toBe('legacy-access-token');
    expect(migratedConfig.refreshToken).toBe('legacy-refresh-token');

    await expect(access(LEGACY_CONFIG_FILE)).rejects.toThrow();
  });

  test('does not fail when the legacy config disappears before import copy runs', async () => {
    const existingConfig = {
      agents: {},
      userName: 'Branch User',
      authToken: 'branch-access-token',
      refreshToken: 'branch-refresh-token',
      configVersion: CURRENT_CONFIG_VERSION,
    };
    const legacyConfig = {
      agents: {},
      userName: 'Legacy User',
      authToken: 'legacy-access-token',
      refreshToken: 'legacy-refresh-token',
      configVersion: CURRENT_CONFIG_VERSION,
    };

    await writeCorruptConfig(JSON.stringify(existingConfig));
    await mkdir(LEGACY_CONFIG_DIR, { recursive: true });
    await writeFile(LEGACY_CONFIG_FILE, JSON.stringify(legacyConfig), 'utf-8');
    clearConfigCache();

    const originalCopyFile = configStoreFs.copyFile;
    configStoreFs.copyFile = async (...args: Parameters<typeof originalCopyFile>) => {
      const [source, destination] = args;
      if (source === LEGACY_CONFIG_FILE && destination === CONFIG_FILE) {
        await unlink(LEGACY_CONFIG_FILE).catch(() => {});
        throw Object.assign(new Error('legacy config disappeared during import'), { code: 'ENOENT' });
      }
      return originalCopyFile(...args);
    };

    try {
      const config = await loadConfig();
      expect(config.userName).toBe('Branch User');
      expect(config.authToken).toBe('branch-access-token');
      expect(config.refreshToken).toBe('branch-refresh-token');
      await expect(access(LEGACY_CONFIG_FILE)).rejects.toThrow();
    } finally {
      configStoreFs.copyFile = originalCopyFile;
      await unlink(LEGACY_CONFIG_FILE).catch(() => {});
      await unlink(CONFIG_FILE).catch(() => {});
      clearConfigCache();
    }
  });

  test('falls back to defaults instead of crashing when migration throws unexpectedly', async () => {
    await writeLegacyConfig(JSON.stringify({
      agents: {},
      theme: 'dark',
      authToken: 'legacy-access-token',
      refreshToken: 'legacy-refresh-token',
    }));

    const originalRename = configStoreFs.rename;
    configStoreFs.rename = async (...args: Parameters<typeof originalRename>) => {
      const [source, destination] = args;
      if (source === LEGACY_CONFIG_FILE && destination === CONFIG_FILE) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return originalRename(...args);
    };

    try {
      await expect(loadConfig()).rejects.toMatchObject({ code: 'EACCES' });
      await expect(getZoomFactor()).resolves.toBe(1);
      await expect(getBooleanUISetting('launchAtLogin')).resolves.toBe(false);
    } finally {
      configStoreFs.rename = originalRename;
      await unlink(LEGACY_CONFIG_FILE).catch(() => {});
      await unlink(CONFIG_FILE).catch(() => {});
      clearConfigCache();
    }
  });

  test('does not overwrite the on-disk config when a setter hits a migration failure', async () => {
    const legacyConfig = {
      agents: {
        existing: {
          authenticated: true,
          selectedAuthMethod: 'openai',
        },
      },
      theme: 'dark',
      authToken: 'legacy-access-token',
      refreshToken: 'legacy-refresh-token',
      launchAtLogin: true,
    };
    await writeLegacyConfig(JSON.stringify(legacyConfig));

    const originalRename = configStoreFs.rename;
    configStoreFs.rename = async (...args: Parameters<typeof originalRename>) => {
      const [source, destination] = args;
      if (source === LEGACY_CONFIG_FILE && destination === CONFIG_FILE) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return originalRename(...args);
    };

    try {
      await expect(setBooleanUISetting('launchAtLogin', false)).rejects.toMatchObject({ code: 'EACCES' });

      const persistedLegacyConfig = JSON.parse(await readFile(LEGACY_CONFIG_FILE, 'utf-8'));
      expect(persistedLegacyConfig).toEqual(legacyConfig);
      await expect(access(CONFIG_FILE)).rejects.toThrow();
    } finally {
      configStoreFs.rename = originalRename;
      await unlink(LEGACY_CONFIG_FILE).catch(() => {});
      await unlink(CONFIG_FILE).catch(() => {});
      clearConfigCache();
    }
  });
});

describe('loadConfig cleans legacy profile fields', () => {
  test('keeps profile values while stripping legacy per-profile fields', async () => {
    const providers: Record<string, any> = {};
    for (const p of BUILTIN_PROVIDERS) {
      providers[p.id] = p;
    }

    const profile = {
      id: 'custom:legacy',
      name: 'Legacy Profile',
      provider: 'openai-oauth',
      providerId: 'builtin:openai-oauth',
      modelId: 'gpt-4o',
      isBuiltin: false,
      permissions: { system: 'none' },
      disabledTools: ['builtin-google'],
      maxSteps: 50,
      maxSubagentDepth: 2,
    } as any;

    const validConfig = {
      profiles: [profile],
      providers,
    };

    await writeCorruptConfig(JSON.stringify(validConfig));
    const config = await loadConfig();
    const cleaned = (config.profiles || []).find((p: any) => p.id === 'custom:legacy');
    expect(cleaned).toBeDefined();
    expect(cleaned!.name).toBe('Legacy Profile');
    expect(cleaned!.provider).toBe('openai-oauth');
    expect(cleaned!.modelId).toBe('gpt-4o');
    expect(cleaned!.isBuiltin).toBe(false);
    expect((cleaned as any).permissions).toBeUndefined();
    expect((cleaned as any).disabledTools).toBeUndefined();
    expect((cleaned as any).maxSteps).toBeUndefined();
    expect((cleaned as any).maxSubagentDepth).toBeUndefined();
  });
});

describe('permissions wiring', () => {
  test('loadConfig strips legacy root file permission fields', async () => {
    await writeCorruptConfig(JSON.stringify({
      agents: {},
      filePermissions: {
        readOutsideWorkspace: 'allow',
        editOpenFolder: true,
        approveCopy: false,
        approveMove: false,
      },
      permissions: {
        readOutsideWorkspace: 'deny',
        writeFilesInWorkspace: false,
      },
    }));

    const config = await loadConfig();
    expect((config as any).filePermissions).toBeUndefined();
    expect((config as any).permissions).toBeUndefined();

    const persistedConfig = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    expect(persistedConfig.filePermissions).toBeUndefined();
    expect(persistedConfig.permissions).toBeUndefined();
  });

  test('getPermissions mirrors effective file permissions toggles', async () => {
    await setCodexReadAccessMode('workspace-only');
    await setCodexSandboxMode('workspace-write');

    const onboardingPerms = await getPermissions();
    expect(onboardingPerms).toEqual({
      readOutsideWorkspace: 'deny',
      writeFilesInWorkspace: true,
    });
  });

  test('setPermissions updates the runtime permission source of truth', async () => {
    await setPermissions({
      readOutsideWorkspace: 'allow',
      writeFilesInWorkspace: false,
    });

    expect(await getCodexReadAccessMode()).toBe('full-system');
    expect(await getCodexSandboxMode()).toBe('read-only');
  });

  test('getOnboardingState returns the current explicit default when unset', async () => {
    expect(await getOnboardingState()).toEqual(createDefaultOnboardingState());
  });

  test('setOnboardingState persists durable onboarding progress', async () => {
    const state = {
      ...createDefaultOnboardingState(),
      completed: true,
      completedStepIds: ['name', 'privacy', 'model-setup', 'feedback'],
      interviewDraft: 'I mostly use local models.',
      interviewResult: {
        summary: 'Uses local models for coding.',
        modelPreferences: ['local-first'],
        workingPreferences: ['ask before broad edits'],
        customInstructionsDraft: buildOnboardingCustomInstructionsDraft({
          summary: 'Uses local models for coding.',
          modelPreferences: ['local-first'],
          workingPreferences: ['ask before broad edits'],
        }),
        updatedAt: '2026-06-21T00:00:00.000Z',
      },
      extensionDecisions: {
        browser: 'install' as const,
      },
      importedToolSummary: {
        generatedAt: '2026-06-21T00:00:00.000Z',
        sources: ['claude', 'codex'],
        summary: 'Imported local tool names only.',
      },
    };

    await setOnboardingState(state);

    expect(await getOnboardingState()).toEqual(state);
    const persistedConfig = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    expect(persistedConfig.onboardingState.version).toBe(ONBOARDING_STATE_VERSION);
    expect(persistedConfig.onboardingState.completedStepIds).toEqual(state.completedStepIds);
    expect(persistedConfig.onboardingState.interviewResult.customInstructionsDraft).toBe([
      'Onboarding summary: Uses local models for coding.',
      'Model preference: local-first',
      'Working preference: ask before broad edits',
    ].join('\n'));
    expect(await getOnboardingCustomInstructionsDraft()).toBe([
      'Onboarding summary: Uses local models for coding.',
      'Model preference: local-first',
      'Working preference: ask before broad edits',
    ].join('\n'));
  });

  test('resetOnboardingState clears onboarding progress without clearing profile fields', async () => {
    await setUserName('Ada');
    await setOnboardingState({
      ...createDefaultOnboardingState(),
      completed: true,
      completedStepIds: ['name', 'feedback'],
    });

    await resetOnboardingState();

    expect(await getOnboardingState()).toEqual(createDefaultOnboardingState());
    expect(await getUserName()).toBe('Ada');
  });
});

describe('builtin tool defaults', () => {
  test('enables builtin tool servers by default', async () => {
    setConfigOverride({ agents: {} } as any);

    const enabledBuiltins = await listBuiltinToolsEnabled();

    expect(await isBuiltinToolEnabled('builtin-docx')).toBe(true);
    expect(enabledBuiltins['builtin-docx']).toBeUndefined();

    clearConfigCache();
  });
});

describe('codex runtime defaults', () => {
  test('enables network access by default', async () => {
    setConfigOverride({ agents: {} } as any);

    expect(await getCodexNetworkAccess()).toBe(true);

    clearConfigCache();
  });
});

describe('Computer Use access policy', () => {
  test('defaults to ask and persists normalized app rules', async () => {
    setConfigOverride({ agents: {} } as any);
    expect(await getCuaAccessPolicy()).toEqual(DEFAULT_CUA_ACCESS_POLICY);
    clearConfigCache();

    const savedPolicy = await setCuaAccessPolicy({
      permissions: {
        inspect: { mode: 'ask' },
        control: { mode: 'deny' },
      },
      appPolicies: [{
        appId: ' TextEdit ',
        displayName: '',
        permissions: {
          inspect: { mode: 'all' },
          control: { mode: 'ask' },
        },
      }],
    });

    expect(savedPolicy).toEqual({
      permissions: {
        inspect: { mode: 'ask' },
        control: { mode: 'deny' },
      },
      appPolicies: [{
        appId: 'TextEdit',
        displayName: 'TextEdit',
        permissions: {
          inspect: { mode: 'all' },
          control: { mode: 'ask' },
        },
      }],
    });
    expect(await getCuaAccessPolicy()).toEqual(savedPolicy);
  });
});

describe('language-dependent STT cleanup', () => {
  test('re-enables Chinese character stripping after leaving a Chinese language', async () => {
    setConfigOverride({
      agents: {},
      language: 'zh-CN',
      stt: {
        ...DEFAULT_STT_SETTINGS,
        stripChineseCharacters: false,
      },
    } as any);

    await setLanguage('en');

    expect((await getSttSettings()).stripChineseCharacters).toBe(true);

    clearConfigCache();
  });
});

describe('boolean UI settings', () => {
  test('launchAtLogin defaults to false and persists', async () => {
    expect(await getBooleanUISetting('launchAtLogin')).toBe(false);
    expect(getBooleanUISettingSync('launchAtLogin')).toBe(false);

    await setBooleanUISetting('launchAtLogin', true);
    expect(await getBooleanUISetting('launchAtLogin')).toBe(true);
    expect(getBooleanUISettingSync('launchAtLogin')).toBe(true);
  });

  test('showHelpPanelPreview defaults to false and persists', async () => {
    expect(await getBooleanUISetting('showHelpPanelPreview')).toBe(false);
    await setBooleanUISetting('showHelpPanelPreview', true);
    expect(await getBooleanUISetting('showHelpPanelPreview')).toBe(true);
  });

  test('reviewMarkdownEdits defaults to true and persists', async () => {
    expect(await getBooleanUISetting('reviewMarkdownEdits')).toBe(true);
    await setBooleanUISetting('reviewMarkdownEdits', false);
    expect(await getBooleanUISetting('reviewMarkdownEdits')).toBe(false);
  });

  test('autoApproveLowRiskMediaCards defaults to false and persists', async () => {
    expect(await getBooleanUISetting('autoApproveLowRiskMediaCards')).toBe(false);
    await setBooleanUISetting('autoApproveLowRiskMediaCards', true);
    expect(await getBooleanUISetting('autoApproveLowRiskMediaCards')).toBe(true);
  });
});

describe('zoom setting', () => {
  test('defaults to 1 and persists a valid zoom factor', async () => {
    expect(await getZoomFactor()).toBe(1);

    await setZoomFactor(1.4);

    expect(await getZoomFactor()).toBe(1.4);
    const config = await loadConfig();
    expect(config.zoomFactor).toBe(1.4);
  });

  test('rejects zoom factors outside supported range', async () => {
    await expect(setZoomFactor(0.49)).rejects.toThrow('Zoom factor must be between 0.5 and 3');
    await expect(setZoomFactor(3.01)).rejects.toThrow('Zoom factor must be between 0.5 and 3');
    await expect(setZoomFactor(Number.NaN)).rejects.toThrow('Zoom factor must be between 0.5 and 3');
  });
});

describe('custom instructions setting', () => {
  test('defaults to null and persists trimmed values', async () => {
    expect(await getCustomInstructions()).toBeNull();

    await setCustomInstructions('  Keep answers concise.  ');
    expect(await getCustomInstructions()).toBe('Keep answers concise.');

    await setCustomInstructions('   ');
    expect(await getCustomInstructions()).toBeNull();
  });
});

describe('interpreter overlay tool guard setting', () => {
  test('defaults read-tool prompt-injection guard to off', async () => {
    expect((await getInterpreterOverlaySettings()).readToolPromptInjectionGuard).toEqual({
      enabled: false,
      modelProfileId: null,
    });
  });

  test('persists read-tool prompt-injection guard model profile setting', async () => {
    const current = await getInterpreterOverlaySettings();

    const saved = await setInterpreterOverlaySettings({
      ...current,
      readToolPromptInjectionGuard: {
        enabled: true,
        modelProfileId: '  interpreter-smart  ',
      },
    });

    expect(saved.readToolPromptInjectionGuard).toEqual({
      enabled: true,
      modelProfileId: 'interpreter-smart',
    });
    expect((await getInterpreterOverlaySettings()).readToolPromptInjectionGuard).toEqual({
      enabled: true,
      modelProfileId: 'interpreter-smart',
    });
  });
});

describe('app launch count', () => {
  test('defaults to zero and increments per launch', async () => {
    expect(await getAppLaunchCount()).toBe(0);

    const firstLaunchCount = await incrementAppLaunchCount();
    expect(firstLaunchCount).toBe(1);
    expect(await getAppLaunchCount()).toBe(1);

    const secondLaunchCount = await incrementAppLaunchCount();
    expect(secondLaunchCount).toBe(2);
    expect(await getAppLaunchCount()).toBe(2);
  });
});

describe('loadConfig migrates stale configs', () => {
  const backupPath = `${CONFIG_FILE}.pre-migration-v${CURRENT_CONFIG_VERSION}`;

  test('should migrate v0 config with stale model IDs and create backup', async () => {
    const providers: Record<string, any> = {};
    for (const p of BUILTIN_PROVIDERS) {
      providers[p.id] = p;
    }

    const staleConfig = {
      agents: {},
      profiles: [
        { ...BUILTIN_PROFILES[0], modelId: 'gpt-5-mini' },
      ],
      providers,
    };

    await writeCorruptConfig(JSON.stringify(staleConfig));
    const config = await loadConfig();

    expect(config.configVersion).toBe(CURRENT_CONFIG_VERSION);
    expect(config.profiles![0].modelId).toBe('gpt-5.1-codex-mini');

    // Verify backup was created
    let backupExists = false;
    try {
      await access(backupPath);
      backupExists = true;
    } catch {}
    expect(backupExists).toBe(true);

    // Cleanup backup
    try { await unlink(backupPath); } catch {}
  });

  test('should not create backup when config is already current version', async () => {
    const providers: Record<string, any> = {};
    for (const p of BUILTIN_PROVIDERS) {
      providers[p.id] = p;
    }

    const currentConfig = {
      configVersion: CURRENT_CONFIG_VERSION,
      agents: {},
      profiles: [...BUILTIN_PROFILES],
      providers,
    };

    await writeCorruptConfig(JSON.stringify(currentConfig));

    // Remove any leftover backup
    try { await unlink(backupPath); } catch {}

    await loadConfig();

    let backupExists = false;
    try {
      await access(backupPath);
      backupExists = true;
    } catch {}
    expect(backupExists).toBe(false);
  });

  test('removes stale removed provider types even on current config versions', async () => {
    const providers: Record<string, any> = {};
    for (const p of BUILTIN_PROVIDERS) {
      providers[p.id] = p;
    }
    providers['builtin:claude-oauth'] = {
      id: 'builtin:claude-oauth',
      name: 'Claude (OAuth)',
      type: 'claude-oauth',
      createdAt: 0,
      updatedAt: 0,
    };

    await writeCorruptConfig(JSON.stringify({
      configVersion: CURRENT_CONFIG_VERSION,
      agents: {},
      profiles: [],
      providers,
    }));

    const repairedConfig = await loadConfig();
    expect(repairedConfig.providers?.['builtin:claude-oauth']).toBeUndefined();

    // Regression guard: settings snapshot save path must no longer fail validation.
    await expect(setZoomFactor(1.1)).resolves.toBeUndefined();
  });

  test('drops malformed provider entries during repair for current config versions', async () => {
    const providers: Record<string, any> = {};
    for (const p of BUILTIN_PROVIDERS) {
      providers[p.id] = p;
    }
    providers.foo = null;

    await writeCorruptConfig(JSON.stringify({
      configVersion: CURRENT_CONFIG_VERSION,
      agents: {},
      profiles: [],
      providers,
    }));

    const repairedConfig = await loadConfig();
    expect(repairedConfig.providers?.foo).toBeUndefined();

    // Regression guard: settings snapshot save path must no longer fail validation.
    await expect(setZoomFactor(1.2)).resolves.toBeUndefined();
  });
});

describe('loadConfig migrates legacy MCP OAuth state', () => {
  test('writes matching legacy OAuth entries to the Codex fallback credentials file and removes mcpOAuth from config', async () => {
    try { await unlink(CREDENTIALS_FILE); } catch {}

    await writeCorruptConfig(JSON.stringify({
      agents: {},
      configVersion: CURRENT_CONFIG_VERSION,
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
      mcpOAuth: {
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
      },
    }));

    const config = await loadConfig();

    expect((config as { mcpOAuth?: Record<string, unknown> }).mcpOAuth).toBeUndefined();

    const persistedConfig = JSON.parse(await readFile(CONFIG_FILE, 'utf-8')) as {
      mcpOAuth?: Record<string, unknown>;
    };
    expect(persistedConfig.mcpOAuth).toBeUndefined();

    const storedCredentials = JSON.parse(
      await readFile(CREDENTIALS_FILE, 'utf-8'),
    ) as Record<string, Record<string, unknown>>;
    expect(Object.keys(storedCredentials)).toHaveLength(1);
    expect(Object.values(storedCredentials)[0]).toEqual({
      server_name: 'github',
      server_url: 'https://mcp.example.com',
      client_id: 'client-123',
      access_token: 'access-token',
      expires_at: 1_712_345_678_000,
      refresh_token: 'refresh-token',
      scopes: ['repo', 'user'],
    });
  });
});
