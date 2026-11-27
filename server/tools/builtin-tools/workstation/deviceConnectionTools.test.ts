import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deviceConnectionCreateTool,
  deviceConnectionRevokeTool,
  deviceConnectionsListTool,
} from './deviceConnectionTools';
import {
  clearPendingDeviceLinksForTests,
  createDeviceConnection,
  listPendingDeviceLinks,
  revokeDeviceConnection,
} from '../../../handlers/deviceConnections';
import { setActiveDeviceGateway } from '../../../deviceConnections/gatewayTrust';
import {
  DeviceRegistry,
  setDeviceRegistryForTests,
  type PairedDevice,
} from '../../../deviceConnections/deviceRegistry';

let dataDir = '';
const originalDataDir = process.env.INTERPRETER_USER_DATA_DIR;
const originalAgentLinks = process.env.INTERPRETER_DEVICE_GATEWAY_AGENT_LINKS;
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
  clearPendingDeviceLinksForTests();
  if (originalAgentLinks === undefined) delete process.env.INTERPRETER_DEVICE_GATEWAY_AGENT_LINKS;
  else process.env.INTERPRETER_DEVICE_GATEWAY_AGENT_LINKS = originalAgentLinks;
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

  test('by default create a connection without giving the link or QR code to the agent', async () => {
    delete process.env.INTERPRETER_DEVICE_GATEWAY_AGENT_LINKS;
    setActiveDeviceGateway({ publicOrigin: 'https://devices.example', port: 5179 });
    const result = await deviceConnectionCreateTool.handler({ label: 'Phone', kind: 'web' });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(text(result));
    expect(Object.keys(payload).sort()).toEqual(['created', 'expiresAt', 'note']);
    expect(payload.created).toBe(true);
    expect(payload.note).toContain('shown on this Workstation');
    expect(text(result)).not.toContain('devices.example');
    expect(text(result)).not.toContain('<svg');
    expect(existsSync(path.join(dataDir, 'device-pairing'))).toBe(false);

    // The local interface reads it from the bridge; a paired device cannot.
    const { links } = await listPendingDeviceLinks();
    expect(links).toHaveLength(1);
    expect(links[0].expiresAt).toBe(payload.expiresAt);
    expect(links[0].qrSvg).toContain('<svg');
    await expect(listPendingDeviceLinks({ deviceId: 'dev_abcdefghijklmnop' })).rejects.toThrow(/connected device/);

    const code = new URL(links[0].link).hash.slice('#code='.length);
    expect(await registry.claim(code)).not.toBeNull();
    expect((await listPendingDeviceLinks()).links).toEqual([]);
  });

  test('bridge refuses link creation from a paired device and lets a device revoke only itself', async () => {
    setActiveDeviceGateway({ publicOrigin: 'https://devices.example', port: 5179 });
    const local = await createDeviceConnection({ label: 'Phone' });
    expect(local.link).toMatch(/^https:\/\/devices\.example\/pair#code=/);
    const first = (await registry.claim(new URL(local.link).hash.slice('#code='.length)))!;
    const second = (await registry.claim(registry.createPairingCode().code))!;

    await expect(createDeviceConnection({}, { deviceId: first.device.id })).rejects.toThrow(/connected device/);
    await expect(revokeDeviceConnection(second.device.id, { deviceId: first.device.id })).rejects.toThrow(/connected device/);
    expect(await revokeDeviceConnection(first.device.id, { deviceId: first.device.id })).toEqual({ revoked: true });
    expect(await revokeDeviceConnection(second.device.id)).toEqual({ revoked: true });
  });

  test('return the link with its QR code as a file and SVG text when the operator opts in', async () => {
    process.env.INTERPRETER_DEVICE_GATEWAY_AGENT_LINKS = '1';
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
