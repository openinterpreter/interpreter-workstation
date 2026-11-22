import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deviceConnectionCreateTool,
  deviceConnectionRevokeTool,
  deviceConnectionsListTool,
} from './deviceConnectionTools';
import { setActiveDeviceGateway } from '../../../deviceConnections/gatewayTrust';
import {
  DeviceRegistry,
  setDeviceRegistryForTests,
  type PairedDevice,
} from '../../../deviceConnections/deviceRegistry';

let dataDir = '';
const originalDataDir = process.env.INTERPRETER_USER_DATA_DIR;
let registry: DeviceRegistry;

function text(result: Awaited<ReturnType<typeof deviceConnectionCreateTool.handler>>): string {
  return String(result.content[0]?.text ?? '');
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'device-connections-'));
  process.env.INTERPRETER_USER_DATA_DIR = dataDir;
  let stored: PairedDevice[] = [];
  registry = new DeviceRegistry({ read: async () => stored, write: async (devices) => { stored = devices; } });
  setDeviceRegistryForTests(registry);
});

afterEach(() => {
  setActiveDeviceGateway(null);
  setDeviceRegistryForTests(null);
  if (originalDataDir === undefined) delete process.env.INTERPRETER_USER_DATA_DIR;
  else process.env.INTERPRETER_USER_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Connect a device tools', () => {
  test('refuse clearly when the device gateway is not configured', async () => {
    const result = await deviceConnectionCreateTool.handler({ label: 'Phone' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('INTERPRETER_DEVICE_GATEWAY_PORT');
    expect(text(result)).toContain('INTERPRETER_DEVICE_GATEWAY_PUBLIC_ORIGIN');

    const listed = JSON.parse(text(await deviceConnectionsListTool.handler({})));
    expect(listed).toEqual({ available: false, devices: [] });
  });

  test('return a one-time link with its QR code as a file and SVG text', async () => {
    setActiveDeviceGateway({ publicOrigin: 'https://devices.example', port: 5179 });
    const result = await deviceConnectionCreateTool.handler({ label: 'Phone', kind: 'web' });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(text(result));

    expect(payload.link).toMatch(/^https:\/\/devices\.example\/pair#code=[A-Za-z0-9_-]{24}$/);
    expect(Date.parse(payload.expiresAt)).toBeGreaterThan(Date.now());
    expect(payload.qrSvg).toContain('<svg');
    expect(payload.qrSvgPath.startsWith(path.join(dataDir, 'device-pairing'))).toBe(true);
    expect(readFileSync(payload.qrSvgPath, 'utf8')).toBe(payload.qrSvg);
    if (process.platform !== 'win32') expect(statSync(payload.qrSvgPath).mode & 0o077).toBe(0);

    const code = new URL(payload.link).hash.slice('#code='.length);
    const claimed = await registry.claim(code);
    expect(claimed?.device.label).toBe('Phone');

    const listed = JSON.parse(text(await deviceConnectionsListTool.handler({})));
    expect(listed.available).toBe(true);
    expect(listed.devices).toHaveLength(1);
    expect(listed.devices[0]).not.toHaveProperty('secretHash');

    const revoked = JSON.parse(text(await deviceConnectionRevokeTool.handler({ id: claimed!.device.id })));
    expect(revoked).toEqual({ revoked: true });
    expect(await registry.authenticate(claimed!.credential)).toBeNull();
  });

  test('reject an unsupported device kind', async () => {
    setActiveDeviceGateway({ publicOrigin: 'https://devices.example', port: 5179 });
    const result = await deviceConnectionCreateTool.handler({ kind: 'satellite' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Device kind');
  });
});
