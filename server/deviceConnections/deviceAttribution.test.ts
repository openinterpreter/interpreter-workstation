import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import {
  attributeDeviceInput,
  createDeviceInputAttributionMiddleware,
  DEVICE_ATTRIBUTED_INPUT_PATHS,
} from './deviceAttribution';
import { CLIENT_DEVICE_HEADER, DEVICE_GATEWAY_TOKEN_HEADER, getDeviceGatewayToken } from './gatewayTrust';

const DEVICE_ID = 'dev_abcdefghijklmnop';

function appWithAttribution() {
  const app = express();
  app.use(express.json());
  app.use('/api/agent/chat/stream', createDeviceInputAttributionMiddleware(async (id) => (
    id === DEVICE_ID
      ? { id, label: 'Phone', kind: 'web', createdAt: '2026-11-01T00:00:00.000Z', lastSeenAt: null }
      : null
  )));
  app.post('/api/agent/chat/stream', (req, res) => res.json({ message: req.body.message }));
  return app;
}

describe('paired-device input attribution', () => {
  test('uses the existing source label and composes with another source', () => {
    expect(attributeDeviceInput('Turn on the lights', 'Phone')).toBe('[From Phone]\nTurn on the lights');
    expect(attributeDeviceInput('[From GPT Live]\nHello', 'Phone')).toBe('[From GPT Live on Phone]\nHello');
    expect(attributeDeviceInput('[From Phone]\nHello', 'Phone')).toBe('[From Phone]\nHello');
    expect(attributeDeviceInput('Hi', 'Kitchen [tablet]')).toBe('[From Kitchen tablet]\nHi');
    expect(attributeDeviceInput('', 'Phone')).toBe('');
    expect(attributeDeviceInput(undefined, 'Phone')).toBeUndefined();
  });

  test('labels only requests the gateway forwarded for a paired device', async () => {
    const app = appWithAttribution();
    const desktop = await request(app).post('/api/agent/chat/stream').send({ message: 'Hello' });
    expect(desktop.body.message).toBe('Hello');

    const spoofed = await request(app).post('/api/agent/chat/stream')
      .set(CLIENT_DEVICE_HEADER, DEVICE_ID)
      .set(DEVICE_GATEWAY_TOKEN_HEADER, 'not-the-token')
      .send({ message: 'Hello' });
    expect(spoofed.body.message).toBe('Hello');

    const device = await request(app).post('/api/agent/chat/stream')
      .set(CLIENT_DEVICE_HEADER, DEVICE_ID)
      .set(DEVICE_GATEWAY_TOKEN_HEADER, getDeviceGatewayToken())
      .send({ message: 'Hello' });
    expect(device.body.message).toBe('[From Phone]\nHello');
  });

  test('labels every route that submits user text, and no other', async () => {
    const app = express();
    app.use(express.json());
    app.use(DEVICE_ATTRIBUTED_INPUT_PATHS, createDeviceInputAttributionMiddleware(async (id) => (
      { id, label: 'Phone', kind: 'web', createdAt: '2026-11-01T00:00:00.000Z', lastSeenAt: null }
    )));
    app.post('/api/agent/*', (req, res) => res.json({ message: req.body.message }));
    const fromDevice = (path: string) => request(app).post(path)
      .set(CLIENT_DEVICE_HEADER, DEVICE_ID)
      .set(DEVICE_GATEWAY_TOKEN_HEADER, getDeviceGatewayToken())
      .send({ message: 'Hello' });

    expect(DEVICE_ATTRIBUTED_INPUT_PATHS).toEqual(expect.arrayContaining([
      '/api/agent/chat/stream', '/api/agent/chat/steer', '/api/agent/tasks', '/api/agent/tasks/stream', '/api/agent/queue',
    ]));
    for (const path of DEVICE_ATTRIBUTED_INPUT_PATHS) {
      expect((await fromDevice(path)).body.message).toBe('[From Phone]\nHello');
    }
    expect((await fromDevice('/api/agent/tasks/stream?x=1')).body.message).toBe('[From Phone]\nHello');
    expect((await fromDevice('/api/agent/chat/stream/other')).body.message).toBe('Hello');
  });
});
