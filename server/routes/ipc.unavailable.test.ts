import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { IPC_UNAVAILABLE_CODE, isIpcUnavailableResponse } from '../../shared/ipcAvailability';

const ipcRouter = (await import('./ipc')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ipc', ipcRouter);
  return app;
}

describe('IPC router availability contract', () => {
  test('an unknown namespace is reported as unavailable', async () => {
    const response = await request(buildApp()).post('/api/ipc/noSuchNamespace/list').send([]);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Unknown namespace: noSuchNamespace', code: IPC_UNAVAILABLE_CODE });
    expect(isIpcUnavailableResponse(response.status, response.body)).toBe(true);
  });

  test('an unknown method of a known namespace is reported as unavailable', async () => {
    const response = await request(buildApp()).post('/api/ipc/topNotices/noSuchMethod').send([]);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe(IPC_UNAVAILABLE_CODE);
    expect(isIpcUnavailableResponse(response.status, response.body)).toBe(true);
  });
});
