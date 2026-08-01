import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clearConfigCache, loadConfig, saveConfig } from './configStore';
import { clearTelemetryCache, trackError } from './telemetry';

const CONFIG_DIR = join(homedir(), '.interpreter');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const originalFetch = globalThis.fetch;

let originalConfig: string | null = null;

async function backupConfig() {
  try {
    originalConfig = await readFile(CONFIG_FILE, 'utf-8');
  } catch {
    originalConfig = null;
  }
}

async function restoreConfig() {
  if (originalConfig !== null) {
    await writeFile(CONFIG_FILE, originalConfig, 'utf-8');
  } else {
    try {
      await unlink(CONFIG_FILE);
    } catch {
      // noop
    }

    try {
      await access(CONFIG_DIR, constants.F_OK);
    } catch {
      // noop
    }
  }

  clearConfigCache();
  clearTelemetryCache();
}

await backupConfig();
afterAll(restoreConfig);

beforeEach(async () => {
  clearConfigCache();
  clearTelemetryCache();

  await mkdir(CONFIG_DIR, { recursive: true });
  const config = await loadConfig();
  config.telemetryEnabled = true;
  config.appLaunchCount = 1;
  config.deviceId = 'device-test-id';
  await saveConfig(config);

  clearConfigCache();
  clearTelemetryCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfigCache();
  clearTelemetryCache();
});

describe('server telemetry', () => {
  test('does not send events without distribution telemetry endpoints', async () => {
    const calls: Array<{ url: string; body: any }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });

      return new Response(null, { status: 201 });
    }) as typeof fetch;

    await trackError('response_error', 'Connection lost', { source: 'renderer' });

    expect(calls).toHaveLength(0);
  });
});
