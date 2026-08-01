import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import { createServer, type Server } from 'node:http';

import interpreterCliRouter, { setInterpreterCliHandlersLoaderForTest } from './interpreterCli';
import { INTERPRETER_CLI_CALLER_TOKEN_HEADER } from '../utils/interpreterCliRuntime';

type InterpreterCliHandlers = typeof import('../handlers/interpreterCli');

let activeServer: Server | null = null;
let listInterpreterCliServerToolsImpl: (() => Promise<unknown>) | null = null;
let callInterpreterCliToolImpl: ((args: {
  onProgress?: (text: string) => Promise<void> | void;
  saveToDisk?: boolean;
  saveToDiskPath?: string;
}) => Promise<unknown>) | null = null;

beforeEach(() => {
  setInterpreterCliHandlersLoaderForTest(async () => ({
    listInterpreterCliServerTools: async (): Promise<unknown> => {
      if (!listInterpreterCliServerToolsImpl) {
        throw new Error('listInterpreterCliServerTools mock not configured for this test.');
      }
      return await listInterpreterCliServerToolsImpl();
    },
    callInterpreterCliTool: async (args: {
      onProgress?: (text: string) => Promise<void> | void;
      saveToDisk?: boolean;
      saveToDiskPath?: string;
    }) => {
      if (!callInterpreterCliToolImpl) {
        throw new Error('callInterpreterCliTool mock not configured for this test.');
      }
      return await callInterpreterCliToolImpl(args);
    },
  }) as unknown as InterpreterCliHandlers);
});

async function startInterpreterCliTestServer(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api/interpreter-cli', interpreterCliRouter);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  activeServer = server;
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected interpreter CLI test server to bind an ephemeral port.');
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  setInterpreterCliHandlersLoaderForTest(null);
  listInterpreterCliServerToolsImpl = null;
  callInterpreterCliToolImpl = null;
  if (activeServer) {
    await new Promise<void>((resolve, reject) => {
      activeServer?.close((error) => (error ? reject(error) : resolve()));
    });
    activeServer = null;
  }
});

describe('interpreterCli streaming tool route', () => {
  test('maps unavailable tool servers to 404 with the route error body', async () => {
    listInterpreterCliServerToolsImpl = async () => {
      throw new Error("Tool server 'builtin-cells' is not available.");
    };

    const baseUrl = await startInterpreterCliTestServer();
    const response = await fetch(
      `${baseUrl}/api/interpreter-cli/tools/builtin-cells`,
      {
        headers: {
          [INTERPRETER_CLI_CALLER_TOKEN_HEADER]: 'agtok_missing_server',
        },
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Tool server 'builtin-cells' is not available.",
    });
  });

  test('streams progress lines before the final result payload', async () => {
    callInterpreterCliToolImpl = async ({ onProgress }: { onProgress?: (text: string) => Promise<void> | void }) => {
      await onProgress?.('[MediaAI] phase="queue_submitted" requestId="req_123"');
      await onProgress?.('[MediaAI] phase="queue_status" status="IN_PROGRESS"');
      return { ok: true, saved: 'Movie/output.mp4' };
    };

    const baseUrl = await startInterpreterCliTestServer();
    const response = await fetch(
      `${baseUrl}/api/interpreter-cli/tools/builtin-media-ai/run_media_model/stream?saveToDisk=false`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTERPRETER_CLI_CALLER_TOKEN_HEADER]: 'agtok_stream',
        },
        body: JSON.stringify({ prompt: 'test' }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe(
      'progress [MediaAI] phase="queue_submitted" requestId="req_123"\n'
      + 'progress [MediaAI] phase="queue_status" status="IN_PROGRESS"\n'
      + 'result {"ok":true,"saved":"Movie/output.mp4"}\n',
    );
  });

  test('passes explicit save-to-disk paths into streamed tool calls', async () => {
    let received: { saveToDisk?: boolean; saveToDiskPath?: string } | null = null;
    callInterpreterCliToolImpl = async (args) => {
      received = {
        saveToDisk: args.saveToDisk,
        saveToDiskPath: args.saveToDiskPath,
      };
      return { ok: true };
    };

    const baseUrl = await startInterpreterCliTestServer();
    const response = await fetch(
      `${baseUrl}/api/interpreter-cli/tools/builtin-cua-driver/screenshot/stream?saveToDisk=true&saveToDiskPath=${encodeURIComponent('/tmp/shot.png')}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTERPRETER_CLI_CALLER_TOKEN_HEADER]: 'agtok_stream',
        },
        body: JSON.stringify({ window_id: 123, format: 'png' }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('result {"ok":true}\n');
    expect(received).toEqual({
      saveToDisk: true,
      saveToDiskPath: '/tmp/shot.png',
    });
  });

  test('emits line-oriented errors when the tool call fails', async () => {
    callInterpreterCliToolImpl = async () => {
      throw new Error('Tool exploded\nwith details');
    };

    const baseUrl = await startInterpreterCliTestServer();
    const response = await fetch(
      `${baseUrl}/api/interpreter-cli/tools/builtin-media-ai/run_media_model/stream?saveToDisk=false`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTERPRETER_CLI_CALLER_TOKEN_HEADER]: 'agtok_stream',
        },
        body: JSON.stringify({ prompt: 'test' }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      'error Tool exploded\n'
      + 'error with details\n',
    );
  });
});
