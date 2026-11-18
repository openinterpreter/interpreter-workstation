import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';

import interpreterCliRouter, { abortWhenCallerLeaves, setInterpreterCliHandlersLoaderForTest } from './interpreterCli';
import { INTERPRETER_CLI_CALLER_TOKEN_HEADER } from '../utils/interpreterCliRuntime';
import { approvalManager } from '../approvalManager';

type InterpreterCliHandlers = typeof import('../handlers/interpreterCli');

let activeServer: Server | null = null;
let listInterpreterCliServerToolsImpl: (() => Promise<unknown>) | null = null;
let callInterpreterCliToolImpl: ((args: {
  onProgress?: (text: string) => Promise<void> | void;
  saveToDisk?: boolean;
  saveToDiskPath?: string;
  approvalAbortSignal?: AbortSignal;
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
      approvalAbortSignal?: AbortSignal;
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

  test('withdraws the call\'s pending approval when the client disconnects', async () => {
    approvalManager.setAutoApprove(false);
    approvalManager.clearAll();
    let approvalPending!: () => void;
    const pendingSeen = new Promise<void>((resolve) => { approvalPending = resolve; });
    let approvalOutcome: Promise<unknown> | null = null;
    const callTool = async ({ onProgress, approvalAbortSignal }: {
      onProgress?: (text: string) => Promise<void> | void;
      approvalAbortSignal?: AbortSignal;
    }) => {
      approvalOutcome = approvalManager.createApproval(
        'cua_driver:foreground:Notes',
        'builtin-cua-driver',
        { message: 'Bring Notes forward' },
        0,
        undefined,
        'agent_cli_disconnect',
        { signal: approvalAbortSignal },
      );
      approvalOutcome.catch(() => undefined);
      await onProgress?.('Waiting for user approval.');
      approvalPending();
      return await approvalOutcome;
    };

    // The route's response close handler, driven directly: a socket-level
    // disconnect is not observable through every node:http implementation.
    const res = Object.assign(new EventEmitter(), { writableFinished: false });
    const callerGone = abortWhenCallerLeaves(res as unknown as Parameters<typeof abortWhenCallerLeaves>[0]);
    const call = callTool({ approvalAbortSignal: callerGone.signal });
    const callOutcome = call.then(() => 'resolved', (error: Error) => error.message);
    await pendingSeen;
    expect(approvalManager.getGlobalPendingRequestIds()).toHaveLength(1);

    res.emit('close');
    await expect(approvalOutcome!).rejects.toThrow(/^APPROVAL_WITHDRAWN: /);
    expect(await callOutcome).toMatch(/^APPROVAL_WITHDRAWN: /);
    expect(approvalManager.getGlobalPendingRequestIds()).toEqual([]);
  });

  test('does not signal a departed caller after the response finished', () => {
    const res = Object.assign(new EventEmitter(), { writableFinished: true });
    const callerGone = abortWhenCallerLeaves(res as unknown as Parameters<typeof abortWhenCallerLeaves>[0]);
    res.emit('close');
    expect(callerGone.signal.aborted).toBe(false);
  });

  test('passes a live caller signal into streamed tool calls', async () => {
    let received: AbortSignal | undefined;
    callInterpreterCliToolImpl = async ({ approvalAbortSignal }) => {
      received = approvalAbortSignal;
      return { ok: true };
    };

    const baseUrl = await startInterpreterCliTestServer();
    const response = await fetch(
      `${baseUrl}/api/interpreter-cli/tools/builtin-cua-driver/list_apps/stream?saveToDisk=false`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTERPRETER_CLI_CALLER_TOKEN_HEADER]: 'agtok_stream',
        },
        body: JSON.stringify({}),
      },
    );

    expect(await response.text()).toBe('result {"ok":true}\n');
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(false);
  });
});

