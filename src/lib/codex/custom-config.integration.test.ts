import { afterAll, beforeAll, describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  CodexAppServerClient,
  StdioJsonRpcTransport,
} from './app-server-client';
import {
  interpreterAppServerTestBinaryAvailable,
  spawnInterpreterAppServerForTest,
} from './test-fixtures/interpreter-app-server-test-binary';

const HEADER_PREFIX = '# Interpreter user configuration';
const TEST_HOME_PREFIX = 'test-custom-config-codex-home-';
const STARTUP_TIMEOUT_MS = 30_000;

const describeIf = interpreterAppServerTestBinaryAvailable ? describe : describe.skip;
const CODEX_CONFIG_TEST_TIMEOUT_MS = 30000;

describeIf('custom config.toml sections (integration)', () => {
  let transport: StdioJsonRpcTransport;
  let client: CodexAppServerClient;
  let testCodexHome: string;
  let testCodexConfig: string;
  let clientPromise: Promise<CodexAppServerClient> | null = null;

  beforeAll(async () => {
    testCodexHome = await mkdtemp(join(tmpdir(), TEST_HOME_PREFIX));
    testCodexConfig = join(testCodexHome, 'config.toml');
  }, STARTUP_TIMEOUT_MS);

  async function getClient(): Promise<CodexAppServerClient> {
    if (clientPromise) {
      return clientPromise;
    }

    clientPromise = (async () => {
      transport = new StdioJsonRpcTransport(
        (_command, args, env) =>
          spawnInterpreterAppServerForTest(args, env),
        testCodexHome,
      );
      client = new CodexAppServerClient(transport, null);
      await client.ensureConnected();
      return client;
    })().catch(async (error) => {
      clientPromise = null;
      await transport?.stop();
      throw error;
    });

    return clientPromise;
  }

  afterAll(async () => {
    await transport?.stop();
    if (testCodexHome) {
      rmSync(testCodexHome, { recursive: true, force: true });
    }
  });

  test('configRead creates the user config file header when config.toml does not exist yet', async () => {
    rmSync(testCodexConfig, { force: true });
    assert.equal(existsSync(testCodexConfig), false);

    const result = await (await getClient()).configRead({ includeLayers: true });
    const userLayer = result.layers?.find((layer) => layer.name.type === 'user');

    assert.ok(userLayer, 'expected user config layer');
    assert.equal(userLayer.name.type, 'user');
    assert.equal(basename(userLayer.name.file), 'config.toml');
    assert.equal(basename(dirname(userLayer.name.file)), basename(testCodexHome));

    const contents = await readFile(userLayer.name.file, 'utf-8');
    assert.ok(contents.startsWith(HEADER_PREFIX));
  }, CODEX_CONFIG_TEST_TIMEOUT_MS);

  test('preserves the app-owned interpreter_app section across official Codex writes', async () => {
    const interpreterApp = {
      storage_version: 1,
      default_profile_id: 'profile:custom',
      profiles: [
        {
          id: 'profile:custom',
          name: 'Custom Profile',
          modelId: 'gpt-5.4',
          provider: 'hosted',
          providerId: 'builtin:hosted',
          isBuiltin: false,
        },
      ],
      providers: {
        'custom:test-provider': {
          id: 'custom:test-provider',
          name: 'Test Provider',
          type: 'api',
          baseURL: 'https://example.com/v1',
          apiKey: 'sk-test',
          createdAt: 1,
          updatedAt: 1,
        },
      },
    };

    const configClient = await getClient();
    await configClient.configBatchWrite({
      edits: [
        {
          keyPath: 'interpreter_app',
          value: interpreterApp as any,
          mergeStrategy: 'replace',
        },
      ],
    });
    await configClient.configValueWrite('web_search', 'disabled');

    const result = await configClient.configRead({ includeLayers: true });
    const userLayer = result.layers?.find((layer) => layer.name.type === 'user');

    assert.ok(userLayer, 'expected user config layer');
    assert.deepEqual((userLayer.config as any).interpreter_app, interpreterApp);
    assert.equal((userLayer.config as any).web_search, 'disabled');
  }, CODEX_CONFIG_TEST_TIMEOUT_MS);
});
