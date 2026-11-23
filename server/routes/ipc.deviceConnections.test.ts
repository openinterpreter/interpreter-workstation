import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import * as configStore from '../configStore';
import type { AppConfig } from '../configStore';
import {
  CLIENT_DEVICE_HEADER,
  DEVICE_GATEWAY_TOKEN_HEADER,
  getDeviceGatewayToken,
  setActiveDeviceGateway,
} from '../deviceConnections/gatewayTrust';
import { DeviceRegistry, setDeviceRegistryForTests, type PairedDevice } from '../deviceConnections/deviceRegistry';
import { clearPendingDeviceLinksForTests } from '../handlers/deviceConnections';

const ipcRouter = (await import('./ipc')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ipc', ipcRouter);
  return app;
}

function fromDevice(deviceId: string) {
  return { [DEVICE_GATEWAY_TOKEN_HEADER]: getDeviceGatewayToken(), [CLIENT_DEVICE_HEADER]: deviceId };
}

afterEach(() => {
  configStore.setConfigOverride(null);
  setActiveDeviceGateway(null);
  setDeviceRegistryForTests(null);
  clearPendingDeviceLinksForTests();
});

describe('IPC settings.get', () => {
  test('never returns paired-device secret hashes', async () => {
    configStore.setConfigOverride({
      agents: {},
      connectedDevices: [{
        id: 'dev_abcdefghijklmnop',
        label: 'Phone',
        kind: 'web',
        createdAt: '2026-11-01T00:00:00.000Z',
        lastSeenAt: null,
        secretHash: 'f'.repeat(64),
      }],
    } as unknown as AppConfig);
    const response = await request(buildApp()).post('/api/ipc/settings/get').send([]);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('f'.repeat(64));
    expect(response.body.connectedDevices).toEqual([{
      id: 'dev_abcdefghijklmnop', label: 'Phone', kind: 'web', createdAt: '2026-11-01T00:00:00.000Z', lastSeenAt: null,
    }]);
  });
});

describe('IPC deviceConnections from a paired device', () => {
  test('cannot create or read links and may disconnect only itself', async () => {
    let stored: PairedDevice[] = [];
    const registry = new DeviceRegistry({ read: async () => stored, write: async (devices) => { stored = devices; } });
    setDeviceRegistryForTests(registry);
    setActiveDeviceGateway({ publicOrigin: 'https://devices.example', port: 5179 });
    const phone = (await registry.claim(registry.createPairingCode({ label: 'Phone' }).code))!;
    const tablet = (await registry.claim(registry.createPairingCode({ label: 'Tablet' }).code))!;
    const app = buildApp();

    const created = await request(app).post('/api/ipc/deviceConnections/create').set(fromDevice(phone.device.id)).send([{}]);
    expect(created.status).toBe(403);
    expect(JSON.stringify(created.body)).not.toContain('pair#code');
    expect((await request(app).post('/api/ipc/deviceConnections/pending').set(fromDevice(phone.device.id)).send([])).status).toBe(403);

    const listed = await request(app).post('/api/ipc/deviceConnections/list').set(fromDevice(phone.device.id)).send([]);
    expect(listed.status).toBe(200);
    expect(Object.keys(listed.body.devices[0]).sort()).toEqual(['createdAt', 'id', 'kind', 'label', 'lastSeenAt']);

    const other = await request(app).post('/api/ipc/deviceConnections/revoke').set(fromDevice(phone.device.id)).send([tablet.device.id]);
    expect(other.status).toBe(403);
    const self = await request(app).post('/api/ipc/deviceConnections/revoke').set(fromDevice(phone.device.id)).send([phone.device.id]);
    expect(self.body).toEqual({ revoked: true });

    // The Workstation's own interface still creates links and sees them.
    const local = await request(app).post('/api/ipc/deviceConnections/create').send([{ label: 'Laptop' }]);
    expect(local.status).toBe(200);
    expect(local.body.link).toMatch(/^https:\/\/devices\.example\/pair#code=/);
    const pending = await request(app).post('/api/ipc/deviceConnections/pending').send([]);
    expect(pending.body.links.map((link: { link: string }) => link.link)).toEqual([local.body.link]);
  });
});
