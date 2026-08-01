import { afterAll, beforeAll, describe, mock, test } from 'bun:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveInterpreterConfigFile,
  resolveLegacyInterpreterConfigFile,
} from '../shared/interpreterConfigPaths';
import { DEFAULT_STT_SETTINGS } from '../shared/types/stt';
import {
  CodexAppServerClient,
  StdioJsonRpcTransport,
} from '../src/lib/codex/app-server-client';
import {
  interpreterAppServerTestBinaryAvailable,
  spawnInterpreterAppServerForTest,
} from '../src/lib/codex/test-fixtures/interpreter-app-server-test-binary';
import {
  getCodexClient as getRealCodexClient,
  getCodexService as getRealCodexService,
} from '../src/lib/codex/service';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_FILE = join(ROOT, 'server', 'test-fixtures', 'configStore.legacy-complex.json');
const TEST_CODEX_HOME = '/tmp/test-config-store-migration-codex-home';

const CONFIG_FILE = resolveInterpreterConfigFile();
const LEGACY_CONFIG_FILE = resolveLegacyInterpreterConfigFile();
const LEGACY_CONFIG_DIR = dirname(LEGACY_CONFIG_FILE);

const describeIf = interpreterAppServerTestBinaryAvailable ? describe : describe.skip;

let client: CodexAppServerClient;
let transport: StdioJsonRpcTransport;
let originalConfig: string | null = null;
let originalLegacyConfig: string | null = null;

mock.module('./utils/codexServiceBridge', () => ({
  getCodexClient: () => client ?? getRealCodexClient(),
  getCodexService: getRealCodexService,
}));

const configStore = await import('./configStore');
const modelConfigTomlStore = await import('./modelConfigTomlStore');

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
}

async function restoreConfig() {
  await restoreFile(CONFIG_FILE, originalConfig);
  await restoreFile(LEGACY_CONFIG_FILE, originalLegacyConfig);
  configStore.clearConfigCache();
}

async function writeLegacyConfig(content: string) {
  try {
    await unlink(CONFIG_FILE);
  } catch {}

  await mkdir(LEGACY_CONFIG_DIR, { recursive: true });
  await writeFile(LEGACY_CONFIG_FILE, content, 'utf-8');
  configStore.clearConfigCache();
}

async function writeCurrentAndLegacyConfig(currentContent: string, legacyContent: string) {
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, currentContent, 'utf-8');
  await mkdir(LEGACY_CONFIG_DIR, { recursive: true });
  await writeFile(LEGACY_CONFIG_FILE, legacyContent, 'utf-8');
  configStore.clearConfigCache();
}

function normalizeExpectedMigratedConfig(config: Record<string, unknown>): Record<string, unknown> {
  const normalized = modelConfigTomlStore.stripLegacyModelConfigFields(config as any) as Record<string, unknown>;
  delete normalized.filePermissions;
  delete normalized.permissions;
  if (
    typeof normalized.stt === 'object'
    && normalized.stt !== null
    && !Array.isArray(normalized.stt)
    && typeof (normalized.stt as Record<string, unknown>).stripChineseCharacters !== 'boolean'
  ) {
    (normalized.stt as Record<string, unknown>).stripChineseCharacters = DEFAULT_STT_SETTINGS.stripChineseCharacters;
  }
  if (
    process.platform === 'win32'
    && typeof normalized.stt === 'object'
    && normalized.stt !== null
    && !Array.isArray(normalized.stt)
  ) {
    (normalized.stt as Record<string, unknown>).backend = 'moonshine';
  }
  return normalized;
}

function assertMissing(filePath: string) {
  return access(filePath).then(
    () => {
      throw new Error(`Expected ${filePath} to be missing`);
    },
    () => undefined,
  );
}

describeIf('configStore model config TOML migration (integration)', () => {
  beforeAll(async () => {
    await backupConfig();
    rmSync(TEST_CODEX_HOME, { recursive: true, force: true });

    transport = new StdioJsonRpcTransport(
      (_command, args, env) =>
        spawnInterpreterAppServerForTest(args, env),
      TEST_CODEX_HOME,
    );
    client = new CodexAppServerClient(transport, null);
    await client.ensureConnected();
  }, 70_000);

  afterAll(async () => {
    await transport?.stop();
    rmSync(TEST_CODEX_HOME, { recursive: true, force: true });
    await restoreConfig();
  });

  test('round-trips a complex legacy config through JSON to TOML migration without losing data', async () => {
    const legacyConfigText = await readFile(FIXTURE_FILE, 'utf-8');
    const legacyConfig = JSON.parse(legacyConfigText) as Record<string, unknown>;
    const normalizedConfig = normalizeExpectedMigratedConfig(legacyConfig);

    await writeLegacyConfig(legacyConfigText);

    const migratedConfig = await configStore.loadConfigWithModelState();

    const persistedJson = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    assert.deepEqual(
      persistedJson,
      normalizedConfig,
    );

    const persistedModelState = await modelConfigTomlStore.loadModelConfigState();
    assert.deepEqual(
      persistedModelState,
      modelConfigTomlStore.extractModelConfigState(legacyConfig as any),
    );

    const expectedConfig = modelConfigTomlStore.mergeModelConfigState(
      normalizedConfig,
      persistedModelState,
    );
    assert.deepEqual(migratedConfig as unknown as Record<string, unknown>, expectedConfig);

    await assertMissing(LEGACY_CONFIG_FILE);

    configStore.clearConfigCache();

    const reloadedConfig = await configStore.loadConfigWithModelState();
    assert.deepEqual(reloadedConfig as unknown as Record<string, unknown>, expectedConfig);
  }, 70_000);

  test('imports a restored legacy config when userData config exists without model state', async () => {
    const legacyConfigText = await readFile(FIXTURE_FILE, 'utf-8');
    const legacyConfig = JSON.parse(legacyConfigText) as Record<string, unknown>;
    const normalizedConfig = normalizeExpectedMigratedConfig(legacyConfig);
    const existingConfig = {
      configVersion: 11,
      agents: {},
      authToken: 'current-access-token',
      refreshToken: 'current-refresh-token',
      userName: 'Current User',
    };

    await writeCurrentAndLegacyConfig(JSON.stringify(existingConfig), legacyConfigText);

    const migratedConfig = await configStore.loadConfigWithModelState();

    const persistedJson = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    assert.deepEqual(
      persistedJson,
      normalizedConfig,
    );

    const persistedModelState = await modelConfigTomlStore.loadModelConfigState();
    assert.deepEqual(
      persistedModelState,
      modelConfigTomlStore.extractModelConfigState(legacyConfig as any),
    );

    const expectedConfig = modelConfigTomlStore.mergeModelConfigState(
      normalizedConfig,
      persistedModelState,
    );
    assert.deepEqual(migratedConfig as unknown as Record<string, unknown>, expectedConfig);

    await assertMissing(LEGACY_CONFIG_FILE);
  }, 70_000);
});
