import { afterEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKSTATION_NODE_PACKAGE } from './simpleWorkstationNodePackage';

let server: Server | null = null;
let folder: string | null = null;
const previousOrigin = process.env.INTERPRETER_CLI_SERVER_CONNECTION;
const previousToken = process.env.INTERPRETER_CALLER_TOKEN;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = null;
  if (folder) rmSync(folder, { recursive: true, force: true });
  folder = null;
  if (previousOrigin === undefined) delete process.env.INTERPRETER_CLI_SERVER_CONNECTION;
  else process.env.INTERPRETER_CLI_SERVER_CONNECTION = previousOrigin;
  if (previousToken === undefined) delete process.env.INTERPRETER_CALLER_TOKEN;
  else process.env.INTERPRETER_CALLER_TOKEN = previousToken;
});

test('server package sends the scoped token and unwraps tool results', async () => {
  const requests: Array<{ path: string; token: string | undefined }> = [];
  server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', token: req.headers['x-interpreter-caller-token'] as string | undefined });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.method === 'POST'
      ? { structuredContent: { windows: 1 } }
      : { tools: [{ name: 'interpreter_whole_computer_state_get' }] }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no port.');
  process.env.INTERPRETER_CLI_SERVER_CONNECTION = `http://127.0.0.1:${address.port}`;
  process.env.INTERPRETER_CALLER_TOKEN = 'test-scoped-token';
  folder = mkdtempSync(join(tmpdir(), 'interpreter-workstation-package-'));
  const modulePath = join(folder, 'index.mjs');
  writeFileSync(modulePath, WORKSTATION_NODE_PACKAGE);
  const api = await import(pathToFileURL(modulePath).href);
  expect((await api.tools.list()).tools).toHaveLength(1);
  expect(await api.computer.state()).toEqual({ windows: 1 });
  expect(requests).toEqual([
    { path: '/api/interpreter-cli/tools/builtin-interpreter', token: 'test-scoped-token' },
    { path: '/api/interpreter-cli/tools/builtin-interpreter/interpreter_whole_computer_state_get', token: 'test-scoped-token' },
  ]);
  await expect(api.tools.call('invalid', {})).rejects.toThrow();
});
