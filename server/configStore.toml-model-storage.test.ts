import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

import { MODEL_OPTIONS } from '../shared/types/model';
import { BUILTIN_PROVIDERS, type Provider } from '../shared/types/provider';
import { resolveInterpreterConfigFile, resolveInterpreterDataDir, resolveLegacyInterpreterConfigFile } from '../shared/interpreterConfigPaths';
import { createHostedFallbackModelConfigState } from './modelConfigTomlStore';

declare const Bun: {
  TOML: {
    parse(input: string): unknown;
  };
};

const CONFIG_FILE = resolveInterpreterConfigFile();
const CONFIG_DIR = dirname(CONFIG_FILE);
const LEGACY_CONFIG_FILE = resolveLegacyInterpreterConfigFile();
const MODEL_CONFIG_FILE = join(resolveInterpreterDataDir(), 'codex-home', 'config.toml');
const CORRUPTED_RECOVERY_CONFIG_FIXTURE = new URL('./test-fixtures/corrupted-recovery-config.toml', import.meta.url);
const USER_RESERVED_LOCAL_PROVIDER_CONFIG_FIXTURE = new URL('./test-fixtures/user-reserved-local-provider-config.toml', import.meta.url);
const MOCK_MODEL_CONFIG_FILE = '/tmp/test-codex-home/config.toml';

const EXACT_REPEATED_RECOVERY_CONFIG_TOML = `# Interpreter user configuration
# Hosted model IDs must be "interpreter-smart", "interpreter-fast", or <provider>/<model_id>.
# Interpreter may repair or remove invalid [interpreter_app] profiles when it reloads this file.
# OpenAI, Groq, and OpenRouter API model IDs are validated against Interpreter's generated models.dev catalog.
# For API profiles, set base_url to the API root.
# Responses is the default API wire format. API profiles use wire_api = "chat" only when Chat Completions is explicitly enabled in Settings.

[interpreter_app]
default_profile_id = "onboarding:lmstudio-qwen-qwen3-5-4b"
profiles = [{ baseURL = "http://localhost:1234/v1", codexProfileId = "lmstudio", id = "onboarding:lmstudio-qwen-qwen3-5-4b", isBuiltin = false, modelId = "qwen/qwen3.5-4b", name = "Qwen3.5 4B (4B) (LM Studio)", provider = "local", providerId = "builtin:local" }, { baseURL = "http://localhost:11434/v1", id = "custom:1775658652876", isBuiltin = false, modelId = "qwen3.5:4b", name = "Qwen3.5:4b", provider = "local", providerId = "builtin:local" }]
storage_version = 1

[interpreter_app.providers]

[interpreter_app.providers."builtin:agent"]
createdAt = 0
id = "builtin:agent"
name = "CLI Agent"
type = "agent"
updatedAt = 0

[interpreter_app.providers."builtin:hosted"]
createdAt = 0
id = "builtin:hosted"
name = "Hosted"
type = "hosted"
updatedAt = 0

[interpreter_app.providers."builtin:local"]
createdAt = 0
id = "builtin:local"
name = "Local (Ollama / LM Studio)"
type = "local"
updatedAt = 0

[interpreter_app.providers."builtin:openai-oauth"]
createdAt = 0
id = "builtin:openai-oauth"
name = "OpenAI (OAuth)"
type = "openai-oauth"
updatedAt = 0

[model_providers.ollama-62be5c93]
base_url = "http://localhost:11434/v1"
name = "Ollama"
requires_openai_auth = false
wire_api = "responses"

[projects."/Users/example/Projects/interpreter-workstation"]
trust_level = "trusted"
# Interpreter user configuration
# Hosted model IDs must be "interpreter-smart", "interpreter-fast", or <provider>/<model_id>.
# Interpreter may repair or remove invalid [interpreter_app] profiles when it reloads this file.
# OpenAI, Groq, and OpenRouter API model IDs are validated against Interpreter's generated models.dev catalog.
# For API profiles, set base_url to the API root.
# Responses is the default API wire format. API profiles use wire_api = "chat" only when Chat Completions is explicitly enabled in Settings.
`;

const exactRepeatedRecoveryConfigSchema = z.object({
  interpreter_app: z.object({
    default_profile_id: z.literal('onboarding:lmstudio-qwen-qwen3-5-4b'),
    storage_version: z.literal(1),
    profiles: z.tuple([
      z.object({
        baseURL: z.literal('http://localhost:1234/v1'),
        codexProfileId: z.literal('lmstudio'),
        id: z.literal('onboarding:lmstudio-qwen-qwen3-5-4b'),
        isBuiltin: z.literal(false),
        modelId: z.literal('qwen/qwen3.5-4b'),
        name: z.literal('Qwen3.5 4B (4B) (LM Studio)'),
        provider: z.literal('local'),
        providerId: z.literal('builtin:local'),
      }),
      z.object({
        baseURL: z.literal('http://localhost:11434/v1'),
        id: z.literal('custom:1775658652876'),
        isBuiltin: z.literal(false),
        modelId: z.literal('qwen3.5:4b'),
        name: z.literal('Qwen3.5:4b'),
        provider: z.literal('local'),
        providerId: z.literal('builtin:local'),
      }),
    ]),
    providers: z.object({
      'builtin:agent': z.object({
        createdAt: z.literal(0),
        id: z.literal('builtin:agent'),
        name: z.literal('CLI Agent'),
        type: z.literal('agent'),
        updatedAt: z.literal(0),
      }),
      'builtin:hosted': z.object({
        createdAt: z.literal(0),
        id: z.literal('builtin:hosted'),
        name: z.literal('Hosted'),
        type: z.literal('hosted'),
        updatedAt: z.literal(0),
      }),
      'builtin:local': z.object({
        createdAt: z.literal(0),
        id: z.literal('builtin:local'),
        name: z.literal('Local (Ollama / LM Studio)'),
        type: z.literal('local'),
        updatedAt: z.literal(0),
      }),
      'builtin:openai-oauth': z.object({
        createdAt: z.literal(0),
        id: z.literal('builtin:openai-oauth'),
        name: z.literal('OpenAI (OAuth)'),
        type: z.literal('openai-oauth'),
        updatedAt: z.literal(0),
      }),
    }),
  }),
  model_providers: z.object({
    'ollama-62be5c93': z.object({
      base_url: z.literal('http://localhost:11434/v1'),
      name: z.literal('Ollama'),
      requires_openai_auth: z.literal(false),
      wire_api: z.literal('responses'),
    }),
  }),
  projects: z.object({
    '/Users/example/Projects/interpreter-workstation': z.object({
      trust_level: z.literal('trusted'),
    }),
  }),
});

function parseExactRepeatedRecoveryConfigToml(): Record<string, unknown> {
  return exactRepeatedRecoveryConfigSchema.parse(Bun.TOML.parse(EXACT_REPEATED_RECOVERY_CONFIG_TOML)) as Record<string, unknown>;
}

const corruptedRecoveryConfigSchema = z.object({
  interpreter_app: z.object({
    default_profile_id: z.literal('custom:1775687765769'),
    fast_profile_id: z.literal('onboarding:interpreter-fast'),
    storage_version: z.literal(1),
    profiles: z.array(z.object({
      id: z.string(),
      name: z.string(),
      modelId: z.string(),
      provider: z.string(),
      isBuiltin: z.boolean(),
      providerId: z.string().optional(),
    }).passthrough()),
    providers: z.object({
      'builtin:agent': z.object({ id: z.literal('builtin:agent') }).passthrough(),
      'builtin:hosted': z.object({ id: z.literal('builtin:hosted') }).passthrough(),
      'builtin:local': z.object({ id: z.literal('builtin:local') }).passthrough(),
      'builtin:openai-oauth': z.object({ id: z.literal('builtin:openai-oauth') }).passthrough(),
    }),
  }),
  model_providers: z.object({
    'ollama-62be5c9dfgdfgdfgdfgdf3': z.object({
      base_url: z.literal('http://localhost:11434/v1'),
      wire_api: z.literal('responses'),
    }).passthrough(),
    interpreter: z.object({
      base_url: z.literal('https://api.example.invalid/v0/openrouter'),
      experimental_bearer_token: z.string(),
      http_headers: z.object({
        'x-api-key': z.string(),
      }),
    }).passthrough(),
  }),
  projects: z.object({
    '/Users/example/Projects/interpreter-workstation': z.object({
      trust_level: z.literal('trusted'),
    }),
  }),
});

async function parseCorruptedRecoveryConfigFixture(): Promise<Record<string, unknown>> {
  const toml = await readFile(CORRUPTED_RECOVERY_CONFIG_FIXTURE, 'utf-8');
  return corruptedRecoveryConfigSchema.parse(Bun.TOML.parse(toml)) as Record<string, unknown>;
}

const userReservedLocalProviderConfigSchema = z.object({
  interpreter_app: z.object({
    default_profile_id: z.literal('onboarding:openai-gpt-5-4'),
    fast_profile_id: z.literal('custom:1774615299811'),
    storage_version: z.literal(1),
    profiles: z.array(z.object({
      id: z.string(),
      name: z.string(),
      modelId: z.string(),
      provider: z.string(),
      isBuiltin: z.boolean(),
    }).passthrough()),
    providers: z.object({
      'builtin:agent': z.object({ id: z.literal('builtin:agent') }).passthrough(),
      'builtin:hosted': z.object({ id: z.literal('builtin:hosted') }).passthrough(),
      'builtin:local': z.object({ id: z.literal('builtin:local') }).passthrough(),
      'builtin:openai-oauth': z.object({ id: z.literal('builtin:openai-oauth') }).passthrough(),
    }),
  }),
  model_providers: z.object({
    ollama: z.object({
      base_url: z.literal('http://localhost:11434/v1'),
      wire_api: z.literal('responses'),
    }),
  }),
  projects: z.object({
    'C:\\Users\\Example\\Downloads': z.object({
      trust_level: z.literal('trusted'),
    }),
  }),
});

async function parseUserReservedLocalProviderConfigFixture(): Promise<Record<string, unknown>> {
  const toml = await readFile(USER_RESERVED_LOCAL_PROVIDER_CONFIG_FIXTURE, 'utf-8');
  return userReservedLocalProviderConfigSchema.parse(Bun.TOML.parse(toml)) as Record<string, unknown>;
}

let userLayerConfig: Record<string, unknown> = {};
let configWriteFailure: Error | null = null;
let configValueWriteFailure: Error | null = null;

const mockConfigRead = mock(async () => ({
  config: {} as any,
  origins: {},
  layers: [
    {
      name: { type: 'user', file: '/tmp/test-codex-home/config.toml' },
      version: '1',
      config: userLayerConfig,
      disabledReason: null,
    },
  ],
}));

const AUTH_CREDENTIAL_KEYS = new Set([
  'cli_auth_credentials_store',
  'mcp_oauth_credentials_store',
]);

const mockConfigBatchWrite = mock(async ({ edits }: { edits?: Array<{ keyPath: string; value: unknown }> }) => {
  const hasModelConfigEdit = (edits ?? []).some((e) => e.keyPath === 'interpreter_app');

  if (configWriteFailure && hasModelConfigEdit) {
    const error = configWriteFailure;
    configWriteFailure = null;
    throw error;
  }

  for (const edit of edits ?? []) {
    if (edit.keyPath === 'interpreter_app') {
      userLayerConfig = {
        ...userLayerConfig,
        interpreter_app: edit.value as Record<string, unknown>,
      };
    } else if (AUTH_CREDENTIAL_KEYS.has(edit.keyPath)) {
      userLayerConfig = {
        ...userLayerConfig,
        [edit.keyPath]: edit.value,
      };
    } else {
      throw new Error(`Unexpected key path in test mock: ${edit.keyPath}`);
    }
  }

  return {
    status: 'ok',
    version: '1',
    filePath: '/tmp/test-codex-home/config.toml',
    overriddenMetadata: null,
  } as any;
});

function removeReservedProviderFromToml(content: string, providerId: string): string {
  const lines = content.split(/\r?\n/);
  const nextLines: string[] = [];
  let skipSection = false;
  const sectionPrefixes = new Set([
    `model_providers.${providerId}`,
    `model_providers."${providerId}"`,
    `model_providers.'${providerId}'`,
  ]);

  const parseHeader = (line: string): string | null => {
    const match = line.trim().match(/^\[\[?\s*(.+?)\s*\]\]?(?:\s+#.*)?$/);
    return match?.[1] ?? null;
  };

  for (const line of lines) {
    const header = parseHeader(line);
    if (header) {
      skipSection = Array.from(sectionPrefixes).some((prefix) => header === prefix || header.startsWith(`${prefix}.`));
      if (skipSection) {
        continue;
      }
    }

    if (skipSection) {
      continue;
    }

    const normalized = line.trimStart();
    if (Array.from(sectionPrefixes).some((prefix) =>
      normalized.startsWith(`${prefix} `)
      || normalized.startsWith(`${prefix}=`)
      || normalized.startsWith(`${prefix}.`),
    )) {
      continue;
    }

    nextLines.push(line);
  }

  return nextLines.join(content.includes('\r\n') ? '\r\n' : '\n');
}

const mockConfigValueWrite = mock(async (keyPath: string, value: unknown) => {
  if (configValueWriteFailure) {
    const error = configValueWriteFailure;
    configValueWriteFailure = null;
    throw error;
  }

  if (value !== null) {
    throw new Error(`Unexpected value for test mock configValueWrite: ${String(value)}`);
  }
  if (!keyPath.startsWith('model_providers.')) {
    throw new Error(`Unexpected key path for test mock configValueWrite: ${keyPath}`);
  }

  const providerId = keyPath.replace('model_providers.', '');
  if ((userLayerConfig as any).model_providers && typeof (userLayerConfig as any).model_providers === 'object') {
    delete (userLayerConfig as any).model_providers[providerId];
  }

  try {
    const current = await readFile(MODEL_CONFIG_FILE, 'utf-8');
    await writeFile(MODEL_CONFIG_FILE, removeReservedProviderFromToml(current, providerId), 'utf-8');
  } catch {}

  return {
    status: 'ok',
    version: '1',
    filePath: MOCK_MODEL_CONFIG_FILE,
    overriddenMetadata: null,
  } as any;
});

mock.module('./utils/codexServiceBridge', () => ({
  getCodexClient: () => ({
    configRead: mockConfigRead,
    configBatchWrite: mockConfigBatchWrite,
    configValueWrite: mockConfigValueWrite,
  }),
}));

const configStore = await import('./configStore');

let originalConfig: string | null = null;
let originalLegacyConfig: string | null = null;
let originalModelConfig: string | null = null;

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

async function removeMatchingFiles(directoryPath: string, pattern: RegExp) {
  try {
    const entries = await readdir(directoryPath);
    await Promise.all(entries
      .filter((entry) => pattern.test(entry))
      .map(async (entry) => {
        try {
          await unlink(join(directoryPath, entry));
        } catch {}
      }));
  } catch {}
}

async function backupConfig() {
  originalConfig = await backupFile(CONFIG_FILE);
  originalLegacyConfig = await backupFile(LEGACY_CONFIG_FILE);
  originalModelConfig = await backupFile(MODEL_CONFIG_FILE);
}

async function restoreConfig() {
  await restoreFile(CONFIG_FILE, originalConfig);
  await restoreFile(LEGACY_CONFIG_FILE, originalLegacyConfig);
  await restoreFile(MODEL_CONFIG_FILE, originalModelConfig);
  configStore.clearConfigCache();
}

async function writeConfig(config: Record<string, unknown>) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  configStore.clearConfigCache();
}

function buildProviders(): Record<string, Provider> {
  return Object.fromEntries(BUILTIN_PROVIDERS.map((provider) => [provider.id, provider])) as Record<string, Provider>;
}

await backupConfig();
afterAll(restoreConfig);

const AUTH_CREDENTIAL_DEFAULTS = {
  cli_auth_credentials_store: 'file',
  mcp_oauth_credentials_store: 'file',
};

beforeEach(() => {
  userLayerConfig = { ...AUTH_CREDENTIAL_DEFAULTS };
  configWriteFailure = null;
  configValueWriteFailure = null;
  mockConfigRead.mockClear();
  mockConfigBatchWrite.mockClear();
  mockConfigValueWrite.mockClear();
  configStore.clearConfigCache();
});

describe('configStore model config TOML migration', () => {
  test('moves legacy profile/provider data out of config.json on first read', async () => {
    const providers = buildProviders();
    const profile = {
      id: 'custom:hosted-profile',
      name: 'Hosted Profile',
      modelId: 'interpreter-smart',
      provider: 'hosted',
      providerId: 'builtin:hosted',
      isBuiltin: false,
    };

    await writeConfig({
      agents: {},
      theme: 'dark',
      profiles: [profile],
      providers,
      defaultProfileId: profile.id,
      fastProfileId: profile.id,
    });

    const profiles = await configStore.getAllProfiles();

    expect(profiles).toEqual([profile]);
    expect(await configStore.getDefaultProfileId()).toBe(profile.id);
    expect(await configStore.getFastProfileId()).toBe(profile.id);
    expect((userLayerConfig as any).interpreter_app).toEqual({
      storage_version: 1,
      profiles: [profile],
      providers,
      default_profile_id: profile.id,
      fast_profile_id: profile.id,
    });

    const persistedJson = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    expect(persistedJson.theme).toBe('dark');
    expect(persistedJson.profiles).toBeUndefined();
    expect(persistedJson.providers).toBeUndefined();
    expect(persistedJson.defaultProfileId).toBeUndefined();
    expect(persistedJson.fastProfileId).toBeUndefined();
  });

  test('reads and updates TOML-backed profiles without writing them back into config.json', async () => {
    const providers = buildProviders();
    const profile = {
      id: 'custom:api-profile',
      name: 'API Profile',
      modelId: 'gpt-5.4',
      provider: 'api',
      providerId: 'builtin:hosted',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      apiFormat: 'openai',
      isBuiltin: false,
    };

    userLayerConfig = {
      ...AUTH_CREDENTIAL_DEFAULTS,
      interpreter_app: {
        storage_version: 1,
        profiles: [profile],
        providers,
        default_profile_id: profile.id,
      },
    };

    await writeConfig({
      agents: {},
      theme: 'dark',
    });

    const fullConfig = await configStore.getFullConfig();
    expect(fullConfig).toMatchObject({
      theme: 'dark',
      profiles: [profile],
      providers,
      defaultProfileId: profile.id,
    });

    await configStore.updateProfile(profile.id, { modelId: 'gpt-5.4-mini' });

    expect((userLayerConfig as any).interpreter_app).toMatchObject({
      profiles: [
        {
          ...profile,
          modelId: 'gpt-5.4-mini',
        },
      ],
      default_profile_id: profile.id,
    });

    const persistedJson = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    expect(persistedJson.theme).toBe('dark');
    expect(persistedJson.profiles).toBeUndefined();
    expect(persistedJson.providers).toBeUndefined();
  });

  test('recovers unreadable model config into hosted fallback profiles', async () => {
    const expectedFallbackState = createHostedFallbackModelConfigState();
    const invalidModelConfig = '[interpreter_app\nprofiles = [';

    await writeConfig({
      agents: {},
      theme: 'dark',
    });
    await mkdir(dirname(MODEL_CONFIG_FILE), { recursive: true });
    await writeFile(MODEL_CONFIG_FILE, invalidModelConfig, 'utf-8');

    mockConfigRead.mockImplementationOnce(async () => {
      throw new Error(`failed to read configuration layers: ${MODEL_CONFIG_FILE}:1:17: unclosed table, expected \`]\``);
    });

    const fullConfig = await configStore.loadConfigWithModelState();

    expect(fullConfig.theme).toBe('dark');
    expect(fullConfig.profiles).toEqual(expectedFallbackState.profiles);
    expect(fullConfig.defaultProfileId).toBe(expectedFallbackState.defaultProfileId);
    expect(fullConfig.fastProfileId).toBe(expectedFallbackState.fastProfileId);
    expect((userLayerConfig as any).interpreter_app).toEqual({
      storage_version: 1,
      profiles: expectedFallbackState.profiles,
      providers: expectedFallbackState.providers,
      default_profile_id: expectedFallbackState.defaultProfileId,
      fast_profile_id: expectedFallbackState.fastProfileId,
    });
  });

  test('recovers reserved model_providers collisions into hosted fallback profiles', async () => {
    const expectedFallbackState = createHostedFallbackModelConfigState();

    await writeConfig({
      agents: {},
      theme: 'dark',
    });

    mockConfigRead.mockImplementationOnce(async () => {
      throw new Error('Invalid configuration: model_providers contains reserved built-in provider IDs: `ollama`.\nin `model_providers`\n');
    });

    const fullConfig = await configStore.loadConfigWithModelState();

    expect(fullConfig.theme).toBe('dark');
    expect(fullConfig.profiles).toEqual(expectedFallbackState.profiles);
    expect(fullConfig.defaultProfileId).toBe(expectedFallbackState.defaultProfileId);
    expect(fullConfig.fastProfileId).toBe(expectedFallbackState.fastProfileId);
    expect((userLayerConfig as any).interpreter_app).toEqual({
      storage_version: 1,
      profiles: expectedFallbackState.profiles,
      providers: expectedFallbackState.providers,
      default_profile_id: expectedFallbackState.defaultProfileId,
      fast_profile_id: expectedFallbackState.fastProfileId,
    });
  });

  test('recovers model_providers validation errors without config.toml path into hosted fallback profiles', async () => {
    const expectedFallbackState = createHostedFallbackModelConfigState();

    await writeConfig({
      agents: {},
      theme: 'dark',
    });

    mockConfigRead.mockImplementationOnce(async () => {
      throw new Error(
        'Invalid configuration: `wire_api = "chat"` is no longer supported.\n'
        + 'How to fix: set `wire_api = "responses"` in your provider config.\n'
        + 'More info: https://github.com/openai/codex/discussions/7782\n'
        + 'in `model_providers.ollama-62be5c93.wire_api`\n',
      );
    });

    const fullConfig = await configStore.loadConfigWithModelState();

    expect(fullConfig.theme).toBe('dark');
    expect(fullConfig.profiles).toEqual(expectedFallbackState.profiles);
    expect(fullConfig.defaultProfileId).toBe(expectedFallbackState.defaultProfileId);
    expect(fullConfig.fastProfileId).toBe(expectedFallbackState.fastProfileId);
    expect((userLayerConfig as any).interpreter_app).toEqual({
      storage_version: 1,
      profiles: expectedFallbackState.profiles,
      providers: expectedFallbackState.providers,
      default_profile_id: expectedFallbackState.defaultProfileId,
      fast_profile_id: expectedFallbackState.fastProfileId,
    });
  });

  const recoverableModelProviderValidationErrors = [
    {
      name: 'profile list JSON-RPC errors for deprecated Ollama wire_api values',
      error: new Error(
        'Error invoking remote method \'profiles:list\': Error: invalid configuration: `wire_api = "chat"` is no longer supported.\n'
        + 'How to fix: set `wire_api = "responses"` in your provider config.\n'
        + 'More info: https://github.com/openai/codex/discussions/7782\n'
        + 'in `model_providers.ollama-62be5c93.wire_api`\n',
      ),
    },
    {
      name: 'profile create JSON-RPC errors for deprecated Ollama wire_api values',
      error: new Error(
        'Error invoking remote method \'profiles:create\': Error: invalid configuration: `wire_api = "chat"` is no longer supported.\n'
        + 'How to fix: set `wire_api = "responses"` in your provider config.\n'
        + 'More info: https://github.com/openai/codex/discussions/7782\n'
        + 'in `model_providers.ollama-62be5c93.wire_api`\n',
      ),
    },
    {
      name: 'skills reload errors that include only the config.toml path',
      error: new Error(
        'failed to reload config: \\\\?\\C:\\Users\\MTC Admin\\AppData\\Roaming\\interpreter\\codex-home\\config.toml:61:12: `wire_api = "chat"` is no longer supported.\n'
        + 'How to fix: set `wire_api = "responses"` in your provider config.\n'
        + 'More info: https://github.com/openai/codex/discussions/7782',
      ),
    },
    {
      name: 'chat turn errors surfaced by the agent runtime',
      error: new Error(
        'Invalid configuration: `wire_api = "chat"` is no longer supported.\n'
        + 'How to fix: set `wire_api = "responses"` in your provider config.\n'
        + 'More info: https://github.com/openai/codex/discussions/7782\n'
        + 'in `model_providers.ollama-62be5c93.wire_api`\n',
      ),
    },
    {
      name: 'quoted provider IDs in model_providers validation paths',
      error: new Error(
        'Invalid configuration: missing field `base_url`\n'
        + 'in `model_providers."ollama-62be5c93".base_url`\n',
      ),
    },
    {
      name: 'LM Studio provider validation paths',
      error: new Error(
        'Invalid configuration: unknown field `wire_api`\n'
        + 'in `model_providers.lmstudio-22f8d4ab.wire_api`\n',
      ),
    },
    {
      name: 'non-Error string throws from the Codex bridge',
      error: 'Invalid configuration: `wire_api = "chat"` is no longer supported.\n'
        + 'How to fix: set `wire_api = "responses"` in your provider config.\n'
        + 'in `model_providers.ollama-62be5c93.wire_api`\n',
    },
  ];

  for (const testCase of recoverableModelProviderValidationErrors) {
    test(`recovers ${testCase.name} into hosted fallback profiles`, async () => {
      const expectedFallbackState = createHostedFallbackModelConfigState();

      await writeConfig({
        agents: {},
        theme: 'dark',
      });

      mockConfigRead.mockImplementationOnce(async () => {
        throw testCase.error;
      });

      const fullConfig = await configStore.loadConfigWithModelState();

      expect(fullConfig.theme).toBe('dark');
      expect(fullConfig.profiles).toEqual(expectedFallbackState.profiles);
      expect(fullConfig.defaultProfileId).toBe(expectedFallbackState.defaultProfileId);
      expect(fullConfig.fastProfileId).toBe(expectedFallbackState.fastProfileId);
      expect((userLayerConfig as any).interpreter_app).toEqual({
        storage_version: 1,
        profiles: expectedFallbackState.profiles,
        providers: expectedFallbackState.providers,
        default_profile_id: expectedFallbackState.defaultProfileId,
        fast_profile_id: expectedFallbackState.fastProfileId,
      });
    });
  }

  test('falls back when reserved provider repair exposes a second model_providers validation error', async () => {
    const expectedFallbackState = createHostedFallbackModelConfigState();

    await writeConfig({
      agents: {},
      theme: 'dark',
    });
    await mkdir(dirname(MODEL_CONFIG_FILE), { recursive: true });
    await writeFile(
      MODEL_CONFIG_FILE,
      `[model_providers.ollama]
base_url = "http://localhost:11434/v1"
wire_api = "responses"
`,
      'utf-8',
    );
    userLayerConfig = {
      ...userLayerConfig,
      model_providers: {
        ollama: {
          base_url: 'http://localhost:11434/v1',
          wire_api: 'responses',
        },
      },
    };

    mockConfigRead
      .mockImplementationOnce(async () => {
        throw new Error('Invalid configuration: model_providers contains reserved built-in provider IDs: `ollama`.\nin `model_providers`\n');
      })
      .mockImplementationOnce(async () => {
        throw new Error(
          'Invalid configuration: `wire_api = "chat"` is no longer supported.\n'
          + 'How to fix: set `wire_api = "responses"` in your provider config.\n'
          + 'in `model_providers.ollama-62be5c93.wire_api`\n',
        );
      });

    const fullConfig = await configStore.loadConfigWithModelState();

    expect(fullConfig.theme).toBe('dark');
    expect(fullConfig.profiles).toEqual(expectedFallbackState.profiles);
    expect(fullConfig.defaultProfileId).toBe(expectedFallbackState.defaultProfileId);
    expect(fullConfig.fastProfileId).toBe(expectedFallbackState.fastProfileId);
    expect((userLayerConfig as any).interpreter_app).toEqual({
      storage_version: 1,
      profiles: expectedFallbackState.profiles,
      providers: expectedFallbackState.providers,
      default_profile_id: expectedFallbackState.defaultProfileId,
      fast_profile_id: expectedFallbackState.fastProfileId,
    });
  });

  test('does not recover unrelated invalid configuration errors without model config evidence', async () => {
    await writeConfig({
      agents: {},
      theme: 'dark',
    });

    mockConfigRead.mockImplementationOnce(async () => {
      throw new Error('Invalid configuration: invalid trust level `sometimes`\nin `projects."/tmp/workspace".trust_level`\n');
    });

    await expect(configStore.loadConfigWithModelState()).rejects.toThrow('invalid trust level');
    expect((userLayerConfig as any).interpreter_app).toBeUndefined();
  });

  test('does not recover generic model_providers messages without a validation path or reserved collision', async () => {
    await writeConfig({
      agents: {},
      theme: 'dark',
    });

    mockConfigRead.mockImplementationOnce(async () => {
      throw new Error('Invalid configuration: model_providers are disabled by current policy');
    });

    await expect(configStore.loadConfigWithModelState()).rejects.toThrow('disabled by current policy');
    expect((userLayerConfig as any).interpreter_app).toBeUndefined();
  });

  test('repairs reserved local provider overrides before migrating legacy profile data out of config.json', async () => {
    const providers = buildProviders();
    const profile = {
      id: 'custom:local-profile',
      name: 'Local Profile',
      modelId: 'qwen3-vl:8b',
      provider: 'local',
      providerId: 'builtin:local',
      baseURL: 'http://localhost:11434/v1',
      codexProfileId: 'ollama',
      isBuiltin: false,
    };

    await writeConfig({
      agents: {},
      theme: 'dark',
      profiles: [profile],
      providers,
      defaultProfileId: profile.id,
      fastProfileId: profile.id,
    });
    await mkdir(dirname(MODEL_CONFIG_FILE), { recursive: true });
    await writeFile(
      MODEL_CONFIG_FILE,
      `# Interpreter user configuration
# Hosted model IDs must be "interpreter-smart", "interpreter-fast", or <provider>/<model_id>.
# Interpreter may repair or remove invalid [interpreter_app] profiles when it reloads this file.
# OpenAI, Groq, and OpenRouter API model IDs are validated against Interpreter's generated models.dev catalog.
# For API profiles, set base_url to the API root.
# Responses is the default API wire format. API profiles use wire_api = "chat" only when Chat Completions is explicitly enabled in Settings.

[model_providers.ollama]
base_url = "http://localhost:11434/v1"

[model_providers.ollama.http_headers]
Authorization = "Bearer token"

[projects."/tmp/workspace"]
trust_level = "trusted"
`,
      'utf-8',
    );
    configWriteFailure = new Error(
      'Invalid configuration: model_providers contains reserved built-in provider IDs: `ollama`.\nin `model_providers`\n',
    );

    const fullConfig = await configStore.loadConfigWithModelState();

    expect(fullConfig.theme).toBe('dark');
    expect(fullConfig.profiles).toEqual([profile]);
    expect(fullConfig.defaultProfileId).toBe(profile.id);
    expect(fullConfig.fastProfileId).toBe(profile.id);
    expect((userLayerConfig as any).interpreter_app).toEqual({
      storage_version: 1,
      profiles: [profile],
      providers,
      default_profile_id: profile.id,
      fast_profile_id: profile.id,
    });
    const persistedJson = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    expect(persistedJson.profiles).toBeUndefined();
    expect(persistedJson.providers).toBeUndefined();
    expect(persistedJson.defaultProfileId).toBeUndefined();
    expect(persistedJson.fastProfileId).toBeUndefined();
    const repairedToml = await readFile(MODEL_CONFIG_FILE, 'utf-8');
    expect(repairedToml).not.toContain('[model_providers.ollama]');
    expect(repairedToml).not.toContain('[model_providers.ollama.http_headers]');
    expect(repairedToml).toContain('[projects."/tmp/workspace"]');
    expect(mockConfigValueWrite).toHaveBeenCalledTimes(1);
    expect(mockConfigValueWrite).toHaveBeenCalledWith('model_providers.ollama', null);
  });

  test('falls back safely when reserved local provider repair write fails', async () => {
    const expectedFallbackState = createHostedFallbackModelConfigState();

    await writeConfig({
      agents: {},
      theme: 'dark',
    });
    await mkdir(dirname(MODEL_CONFIG_FILE), { recursive: true });
    await writeFile(
      MODEL_CONFIG_FILE,
      `# Interpreter user configuration
# Hosted model IDs must be "interpreter-smart", "interpreter-fast", or <provider>/<model_id>.
# Interpreter may repair or remove invalid [interpreter_app] profiles when it reloads this file.
# OpenAI, Groq, and OpenRouter API model IDs are validated against Interpreter's generated models.dev catalog.
# For API profiles, set base_url to the API root.
# Responses is the default API wire format. API profiles use wire_api = "chat" only when Chat Completions is explicitly enabled in Settings.

[model_providers.ollama]
base_url = "http://localhost:11434/v1"
`,
      'utf-8',
    );

    mockConfigRead.mockImplementationOnce(async () => {
      throw new Error(
        'Invalid configuration: model_providers contains reserved built-in provider IDs: `ollama`.\nin `model_providers`\n',
      );
    });
    configValueWriteFailure = new Error('permission denied while updating config.toml');

    const fullConfig = await configStore.loadConfigWithModelState();

    expect(fullConfig.theme).toBe('dark');
    expect(fullConfig.profiles).toEqual(expectedFallbackState.profiles);
    expect(fullConfig.defaultProfileId).toBe(expectedFallbackState.defaultProfileId);
    expect(fullConfig.fastProfileId).toBe(expectedFallbackState.fastProfileId);
    expect((userLayerConfig as any).interpreter_app).toEqual({
      storage_version: 1,
      profiles: expectedFallbackState.profiles,
      providers: expectedFallbackState.providers,
      default_profile_id: expectedFallbackState.defaultProfileId,
      fast_profile_id: expectedFallbackState.fastProfileId,
    });
  });

  test('returns repaired model config when persisting read recovery fails', async () => {
    const providers = buildProviders();
    const profile = {
      id: 'custom:api-profile',
      name: 'API Profile',
      modelId: 'gpt-5.4',
      provider: 'api',
      providerId: 'builtin:hosted',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      apiFormat: 'openai',
      isBuiltin: false,
    };

    await writeConfig({
      agents: {},
      theme: 'dark',
    });

    userLayerConfig = {
      ...AUTH_CREDENTIAL_DEFAULTS,
      interpreter_app: {
        storage_version: 1,
        profiles: [profile],
        providers,
        default_profile_id: 'missing:default',
        fast_profile_id: 'missing:fast',
      },
    };
    configWriteFailure = new Error('permission denied while updating config.toml');

    const fullConfig = await configStore.getFullConfig();

    expect(fullConfig.theme).toBe('dark');
    expect(fullConfig.profiles).toEqual([profile]);
    expect(fullConfig.defaultProfileId).toBe(profile.id);
    expect(fullConfig.fastProfileId).toBe(profile.id);
    expect(mockConfigBatchWrite).toHaveBeenCalledTimes(1);

    const secondRead = await configStore.getFullConfig();

    expect(secondRead.profiles).toEqual([profile]);
    expect(secondRead.defaultProfileId).toBe(profile.id);
    expect(secondRead.fastProfileId).toBe(profile.id);
    expect(mockConfigBatchWrite).toHaveBeenCalledTimes(1);
  });

  test('keeps an in-memory default profile usable when model config save fails', async () => {
    const customProfile = {
      id: 'custom:openai-profile',
      name: 'OpenAI Profile',
      modelId: 'gpt-5.4',
      provider: 'api',
      providerId: 'builtin:hosted',
      isBuiltin: false,
    };

    await writeConfig({
      agents: {},
      theme: 'dark',
    });
    configWriteFailure = new Error('permission denied while updating config.toml');

    await expect(configStore.addProfile(customProfile as any)).rejects.toThrow('permission denied while updating config.toml');

    const fullConfig = await configStore.loadConfigWithModelState();
    const defaultProfile = await configStore.getDefaultProfile();

    expect(fullConfig.theme).toBe('dark');
    expect(fullConfig.profiles).toEqual([customProfile]);
    expect(fullConfig.defaultProfileId).toBe(customProfile.id);
    expect(fullConfig.fastProfileId).toBe(customProfile.id);
    expect(defaultProfile).toEqual(customProfile);
    expect((userLayerConfig as any).interpreter_app).toBeUndefined();
  });

  test('removes only reserved local provider sections and preserves unrelated TOML content on read recovery', async () => {
    const profile = {
      id: 'custom:openai-profile',
      name: 'OpenAI Profile',
      modelId: 'gpt-5.4',
      provider: 'openai-oauth',
      providerId: 'builtin:openai-oauth',
      isBuiltin: false,
    };

    userLayerConfig = {
      ...AUTH_CREDENTIAL_DEFAULTS,
      interpreter_app: {
        storage_version: 1,
        profiles: [profile],
        providers: buildProviders(),
        default_profile_id: profile.id,
      },
      model_providers: {
        'openai-custom': {
          base_url: 'https://api.openai.com/v1',
          wire_api: 'responses',
        },
      },
      projects: {
        '/tmp/workspace': {
          trust_level: 'trusted',
        },
      },
    };

    await writeConfig({
      agents: {},
      theme: 'dark',
    });
    await mkdir(dirname(MODEL_CONFIG_FILE), { recursive: true });
    await writeFile(
      MODEL_CONFIG_FILE,
      `# Interpreter user configuration
# Hosted model IDs must be "interpreter-smart", "interpreter-fast", or <provider>/<model_id>.
# Interpreter may repair or remove invalid [interpreter_app] profiles when it reloads this file.
# OpenAI, Groq, and OpenRouter API model IDs are validated against Interpreter's generated models.dev catalog.
# For API profiles, set base_url to the API root.
# Responses is the default API wire format. API profiles use wire_api = "chat" only when Chat Completions is explicitly enabled in Settings.

[model_providers."ollama"]
base_url = "http://localhost:11434/v1"

[model_providers.lmstudio]
base_url = "http://localhost:1234/v1"

[model_providers.lmstudio.http_headers]
Authorization = "Bearer lm-studio"

[model_providers.openai-custom]
base_url = "https://api.openai.com/v1"
wire_api = "responses"

[projects."/tmp/workspace"]
trust_level = "trusted"
`,
      'utf-8',
    );

    mockConfigRead.mockImplementationOnce(async () => {
      throw new Error(
        'Invalid configuration: model_providers contains reserved built-in provider IDs: `ollama`, `lmstudio`.\nin `model_providers`\n',
      );
    });

    const fullConfig = await configStore.loadConfigWithModelState();

    expect(fullConfig.theme).toBe('dark');
    expect(fullConfig.profiles).toEqual([profile]);
    expect(fullConfig.defaultProfileId).toBe(profile.id);
    const repairedToml = await readFile(MODEL_CONFIG_FILE, 'utf-8');
    expect(repairedToml).not.toContain('[model_providers."ollama"]');
    expect(repairedToml).not.toContain('[model_providers.lmstudio]');
    expect(repairedToml).not.toContain('[model_providers.lmstudio.http_headers]');
    expect(repairedToml).toContain('[model_providers.openai-custom]');
    expect(repairedToml).toContain('[projects."/tmp/workspace"]');
    expect(mockConfigValueWrite).toHaveBeenCalledTimes(2);
    expect(mockConfigValueWrite).toHaveBeenCalledWith('model_providers.ollama', null);
    expect(mockConfigValueWrite).toHaveBeenCalledWith('model_providers.lmstudio', null);
  });

  test('removes reserved local provider dotted assignments without touching unrelated keys', async () => {
    const profile = {
      id: 'custom:openai-profile',
      name: 'OpenAI Profile',
      modelId: 'gpt-5.4',
      provider: 'openai-oauth',
      providerId: 'builtin:openai-oauth',
      isBuiltin: false,
    };

    userLayerConfig = {
      ...AUTH_CREDENTIAL_DEFAULTS,
      interpreter_app: {
        storage_version: 1,
        profiles: [profile],
        providers: buildProviders(),
        default_profile_id: profile.id,
      },
    };

    await writeConfig({
      agents: {},
      theme: 'dark',
    });
    await mkdir(dirname(MODEL_CONFIG_FILE), { recursive: true });
    await writeFile(
      MODEL_CONFIG_FILE,
      `# Interpreter user configuration
# Hosted model IDs must be "interpreter-smart", "interpreter-fast", or <provider>/<model_id>.
# Interpreter may repair or remove invalid [interpreter_app] profiles when it reloads this file.
# OpenAI, Groq, and OpenRouter API model IDs are validated against Interpreter's generated models.dev catalog.
# For API profiles, set base_url to the API root.
# Responses is the default API wire format. API profiles use wire_api = "chat" only when Chat Completions is explicitly enabled in Settings.

model_providers.ollama = { base_url = "http://localhost:11434/v1" }
model_providers.lmstudio.http_headers = { Authorization = "Bearer lm-studio" }
web_search = "disabled"
`,
      'utf-8',
    );

    mockConfigRead.mockImplementationOnce(async () => {
      throw new Error(
        'Invalid configuration: model_providers contains reserved built-in provider IDs: `ollama`, `lmstudio`.\nin `model_providers`\n',
      );
    });

    await configStore.loadConfigWithModelState();

    const repairedToml = await readFile(MODEL_CONFIG_FILE, 'utf-8');
    expect(repairedToml).not.toContain('model_providers.ollama =');
    expect(repairedToml).not.toContain('model_providers.lmstudio.http_headers =');
    expect(repairedToml).toContain('web_search = "disabled"');
    expect(mockConfigValueWrite).toHaveBeenCalledTimes(2);
    expect(mockConfigValueWrite).toHaveBeenCalledWith('model_providers.ollama', null);
    expect(mockConfigValueWrite).toHaveBeenCalledWith('model_providers.lmstudio', null);
  });

  test('repairs a Windows user fixture with reserved ollama provider overrides without rewriting unrelated state', async () => {
    const fixtureToml = await readFile(USER_RESERVED_LOCAL_PROVIDER_CONFIG_FIXTURE, 'utf-8');
    userLayerConfig = { ...AUTH_CREDENTIAL_DEFAULTS, ...await parseUserReservedLocalProviderConfigFixture() };

    await writeConfig({
      agents: {},
      theme: 'system',
    });
    await mkdir(dirname(MODEL_CONFIG_FILE), { recursive: true });
    await writeFile(MODEL_CONFIG_FILE, fixtureToml, 'utf-8');

    mockConfigRead.mockImplementationOnce(async () => {
      throw new Error(
        'Invalid configuration: model_providers contains reserved built-in provider IDs: `ollama`.\nin `model_providers`\n',
      );
    });

    const fullConfig = await configStore.loadConfigWithModelState();

    expect(fullConfig.theme).toBe('system');
    expect(fullConfig.defaultProfileId).toBe('onboarding:openai-gpt-5-4');
    expect(fullConfig.fastProfileId).toBe('custom:1774615299811');
    expect(fullConfig.profiles.map((profile) => profile.id)).toEqual(expect.arrayContaining([
      'custom:1774615269314',
      'custom:1774615283062',
      'custom:1774660196366',
    ]));

    const repairedToml = await readFile(MODEL_CONFIG_FILE, 'utf-8');
    expect(repairedToml).not.toContain('[model_providers.ollama]');
    expect(repairedToml).toContain('[projects.\'C:\\Users\\Example\\Downloads\']');
    expect(repairedToml).toContain('modelId = "qwen3-vl:8b"');
    expect(mockConfigValueWrite).toHaveBeenCalledTimes(1);
    expect(mockConfigValueWrite).toHaveBeenCalledWith('model_providers.ollama', null);
  });

  test('does not rewrite the exact LM Studio config fixture when builtin providers only differ by key order', async () => {
    userLayerConfig = { ...AUTH_CREDENTIAL_DEFAULTS, ...parseExactRepeatedRecoveryConfigToml() };

    await writeConfig({
      agents: {},
      theme: 'dark',
    });

    const fullConfig = await configStore.loadConfigWithModelState();

    expect(fullConfig.defaultProfileId).toBe('onboarding:lmstudio-qwen-qwen3-5-4b');
    expect(fullConfig.profiles).toHaveLength(2);
    expect(mockConfigBatchWrite).not.toHaveBeenCalled();
  });

  test('repairs corrupted hosted model IDs from the exact broken config fixture', async () => {
    userLayerConfig = { ...AUTH_CREDENTIAL_DEFAULTS, ...await parseCorruptedRecoveryConfigFixture() };

    await writeConfig({
      agents: {},
      theme: 'dark',
    });

    const fullConfig = await configStore.loadConfigWithModelState();
    const validHostedModelIds = new Set(MODEL_OPTIONS.hosted.map((option) => option.id));
    const hostedProfiles = (fullConfig.profiles ?? []).filter((profile) => profile.provider === 'hosted');

    expect(hostedProfiles.length).toBeGreaterThan(0);
    expect(hostedProfiles.every((profile) => validHostedModelIds.has(profile.modelId))).toBe(true);
  });

  test('backs up repaired model config as config.<timestamp>.toml', async () => {
    userLayerConfig = { ...AUTH_CREDENTIAL_DEFAULTS, ...await parseCorruptedRecoveryConfigFixture() };

    await removeMatchingFiles(dirname(MOCK_MODEL_CONFIG_FILE), /^config\..+\.toml$/);
    await removeMatchingFiles(dirname(MOCK_MODEL_CONFIG_FILE), /^config\.toml\.invalid-/);
    await mkdir(dirname(MOCK_MODEL_CONFIG_FILE), { recursive: true });
    await writeFile(MOCK_MODEL_CONFIG_FILE, 'placeholder', 'utf-8');

    await writeConfig({
      agents: {},
      theme: 'dark',
    });

    await configStore.loadConfigWithModelState();

    const entries = await readdir(dirname(MOCK_MODEL_CONFIG_FILE));
    expect(entries.some((entry) => /^config\..+\.toml$/.test(entry) && entry !== basename(MOCK_MODEL_CONFIG_FILE))).toBe(true);
    expect(entries.some((entry) => /^config\.toml\.invalid-/.test(entry))).toBe(false);
  });

  test('restores hosted fallback profiles when recovery issues leave no saved profiles', async () => {
    userLayerConfig = {
      ...AUTH_CREDENTIAL_DEFAULTS,
      interpreter_app: {
        storage_version: 1,
        providers: {
          'builtin:agent': {
            createdAt: 0,
            id: 'builtin:agent',
            name: 'CLI Agent',
            type: 'agent',
            updatedAt: 0,
          },
          'builtin:local': {
            createdAt: 0,
            id: 'builtin:local',
            name: 'Local (Ollama / LM Studio)',
            type: 'local',
            updatedAt: 0,
          },
          'builtin:openai-oauth': {
            createdAt: 0,
            id: 'builtin:openai-oauth',
            name: 'OpenAI (OAuth)',
            type: 'openai-oauth',
            updatedAt: 0,
          },
        },
      },
      model_providers: {
        interpreter: {
          base_url: 'https://api.example.invalid/v0/openrouter',
          experimental_bearer_token: 'token',
          name: 'Interpreter',
          requires_openai_auth: false,
          wire_api: 'responses',
          http_headers: {
            'x-api-key': 'token',
          },
        },
      },
      storage_version: 1,
      projects: {
        '/Users/example/Projects/interpreter-workstation': {
          trust_level: 'trusted',
        },
      },
    };

    await writeConfig({
      agents: {},
      theme: 'dark',
    });

    const fullConfig = await configStore.loadConfigWithModelState();

    expect(fullConfig.profiles).toMatchObject([
      {
        id: 'onboarding:interpreter-smart',
        name: 'Interpreter Smart',
        provider: 'hosted',
        modelId: 'interpreter-smart',
      },
      {
        id: 'onboarding:interpreter-fast',
        name: 'Interpreter Fast',
        provider: 'hosted',
        modelId: 'interpreter-fast',
      },
    ]);
    expect(fullConfig.defaultProfileId).toBe('onboarding:interpreter-smart');
    expect(fullConfig.fastProfileId).toBe('onboarding:interpreter-fast');
  });

  // NOTE(victor): On Windows, antivirus and search indexers briefly hold file
  // handles on config.toml, causing the Rust atomic-rename (tempfile::persist)
  // to fail with "failed to persist config.toml". saveModelConfigState retries
  // transient persist errors with backoff. See sindresorhus/conf -> stubborn-fs
  // and Git's mingw_rename for prior art on this pattern.
  test('retries transient config.toml persist failures on Windows', async () => {
    const profile = {
      id: 'custom:retry-test',
      name: 'Retry Test',
      modelId: 'interpreter-smart',
      provider: 'hosted',
      providerId: 'builtin:hosted',
      isBuiltin: false,
    };

    await writeConfig({ agents: {}, theme: 'dark' });

    configWriteFailure = new Error(
      'failed to persist config.toml at \\\\?\\C:\\Users\\Administrator\\AppData\\Roaming\\interpreter\\codex-home\\config.toml',
    );

    await configStore.addProfile(profile as any);

    expect(mockConfigBatchWrite).toHaveBeenCalledTimes(2);
    const fullConfig = await configStore.loadConfigWithModelState();
    expect(fullConfig.profiles?.some((p) => p.id === profile.id)).toBe(true);
  });

  test('does not retry non-persist config write errors', async () => {
    const profile = {
      id: 'custom:no-retry-test',
      name: 'No Retry Test',
      modelId: 'interpreter-smart',
      provider: 'hosted',
      providerId: 'builtin:hosted',
      isBuiltin: false,
    };

    await writeConfig({ agents: {}, theme: 'dark' });

    configWriteFailure = new Error('permission denied while updating config.toml');

    await expect(configStore.addProfile(profile as any)).rejects.toThrow(
      'permission denied while updating config.toml',
    );
    expect(mockConfigBatchWrite).toHaveBeenCalledTimes(1);
  });

  test('writes file-based auth credentials store settings on first config load', async () => {
    const providers = buildProviders();
    const profile = {
      id: 'custom:auth-cred-test',
      name: 'Auth Credentials Test',
      modelId: 'interpreter-smart',
      provider: 'hosted',
      providerId: 'builtin:hosted',
      isBuiltin: false,
    };

    userLayerConfig = {
      interpreter_app: {
        storage_version: 1,
        profiles: [profile],
        providers,
        default_profile_id: profile.id,
      },
    };

    await writeConfig({ agents: {}, theme: 'dark' });

    await configStore.loadConfigWithModelState();

    expect(mockConfigBatchWrite).toHaveBeenCalledTimes(1);
    const batchCall = mockConfigBatchWrite.mock.calls[0]![0] as { edits: Array<{ keyPath: string; value: unknown; mergeStrategy: string }> };
    const authEdits = batchCall.edits.filter((e) => AUTH_CREDENTIAL_KEYS.has(e.keyPath));
    expect(authEdits).toEqual([
      { keyPath: 'cli_auth_credentials_store', value: 'file', mergeStrategy: 'upsert' },
      { keyPath: 'mcp_oauth_credentials_store', value: 'file', mergeStrategy: 'upsert' },
    ]);
    expect((userLayerConfig as any).cli_auth_credentials_store).toBe('file');
    expect((userLayerConfig as any).mcp_oauth_credentials_store).toBe('file');
  });

  test('loadConfigWithModelState succeeds when auth credentials write fails due to unwritable config', async () => {
    const providers = buildProviders();
    const profile = {
      id: 'custom:auth-write-fail',
      name: 'Auth Write Fail Test',
      modelId: 'interpreter-smart',
      provider: 'hosted',
      providerId: 'builtin:hosted',
      isBuiltin: false,
    };

    userLayerConfig = {
      interpreter_app: {
        storage_version: 1,
        profiles: [profile],
        providers,
        default_profile_id: profile.id,
      },
    };

    await writeConfig({ agents: {}, theme: 'dark' });

    configWriteFailure = new Error('EACCES: permission denied, rename config.toml');

    const config = await configStore.loadConfigWithModelState();

    expect(config).toBeDefined();
    expect(config.theme).toBe('dark');
    expect(config.profiles).toEqual([profile]);
    expect(config.defaultProfileId).toBe(profile.id);
  });

  test('includes auth credentials edits alongside model config in profile save batch', async () => {
    const profile = {
      id: 'custom:batch-auth-test',
      name: 'Batch Auth Test',
      modelId: 'interpreter-smart',
      provider: 'hosted',
      providerId: 'builtin:hosted',
      isBuiltin: false,
    };

    await writeConfig({ agents: {}, theme: 'dark' });
    await configStore.addProfile(profile as any);

    const lastCall = mockConfigBatchWrite.mock.calls.at(-1)![0] as { edits: Array<{ keyPath: string; value: unknown; mergeStrategy: string }> };
    const keyPaths = lastCall.edits.map((e) => e.keyPath);
    expect(keyPaths).toContain('interpreter_app');
    expect(keyPaths).toContain('cli_auth_credentials_store');
    expect(keyPaths).toContain('mcp_oauth_credentials_store');
  });
});
