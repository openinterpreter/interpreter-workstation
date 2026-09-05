import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import router from './publicWorkspace';

let root = '';
const previousRoot = process.env.INTERPRETER_PUBLIC_WORKSPACE_ROOT;
const previousToken = process.env.INTERPRETER_PUBLIC_THREAD_TOKEN;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'public-workspace-route-'));
  await mkdir(path.join(root, 'papers'));
  await writeFile(path.join(root, 'manifest.json'), '{"count":0}\n');
  process.env.INTERPRETER_PUBLIC_WORKSPACE_ROOT = root;
  process.env.INTERPRETER_PUBLIC_THREAD_TOKEN = 'test-token';
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.INTERPRETER_PUBLIC_WORKSPACE_ROOT;
  else process.env.INTERPRETER_PUBLIC_WORKSPACE_ROOT = previousRoot;
  if (previousToken === undefined) delete process.env.INTERPRETER_PUBLIC_THREAD_TOKEN;
  else process.env.INTERPRETER_PUBLIC_THREAD_TOKEN = previousToken;
});

function app() {
  const server = express();
  server.use('/', router);
  return server;
}

describe('public workspace routes', () => {
  test('requires the server-side bearer credential', async () => {
    const response = await request(app()).get('/');
    expect(response.status).toBe(401);
  });

  test('lists only relative public entries', async () => {
    const response = await request(app()).get('/').set('Authorization', 'Bearer test-token');
    expect(response.status).toBe(200);
    expect(response.body.capabilities).toEqual(['browse', 'read']);
    expect(response.body.entries.map((entry: { path: string }) => entry.path)).toEqual(['papers', 'manifest.json']);
    expect(JSON.stringify(response.body)).not.toContain(root);
  });

  test('serves allowlisted files inline and rejects traversal', async () => {
    const fileResponse = await request(app())
      .get('/file?path=manifest.json')
      .set('Authorization', 'Bearer test-token');
    expect(fileResponse.status).toBe(200);
    expect(fileResponse.headers['content-type']).toContain('application/json');
    expect(fileResponse.headers['x-content-type-options']).toBe('nosniff');

    const traversalResponse = await request(app())
      .get('/file?path=..%2Fsecret.txt')
      .set('Authorization', 'Bearer test-token');
    expect(traversalResponse.status).toBe(400);
    expect(JSON.stringify(traversalResponse.body)).not.toContain(root);
  });
});
