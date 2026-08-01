import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { getInterpreterCliBridgeDir } from './interpreterCliRuntime';
import {
  callInterpreterCliTool,
  describeInterpreterCliTool,
  findInterpreterCliTools,
  getInterpreterCliConfig,
  getInterpreterCliLayout,
  listInterpreterCliServerTools,
  listInterpreterCliTools,
  restartInterpreterCliRuntime,
  setInterpreterCliConfig,
  setInterpreterCliLayout,
} from '../handlers/interpreterCli';

export interface InterpreterCliFileBridgeHandle {
  bridgeDir: string;
  close: () => Promise<void>;
}

type BridgeRequest =
  | {
    kind: 'list';
    callerToken: string;
  }
  | {
    kind: 'list-server-tools';
    callerToken: string;
    serverId: string;
  }
  | {
    kind: 'find-tools';
    callerToken: string;
    query: string;
  }
  | {
    kind: 'call';
    callerToken: string;
    serverId: string;
    toolName: string;
    args: Record<string, unknown>;
    saveToDisk?: boolean;
    saveToDiskPath?: string;
  }
  | {
    kind: 'describe';
    callerToken: string;
    serverId: string;
    toolName: string;
  }
  | {
    kind: 'config-get';
    callerToken: string;
    path: string;
  }
  | {
    kind: 'config-set';
    callerToken: string;
    path: string;
    value: unknown;
    restartRuntime?: boolean;
  }
  | {
    kind: 'config-restart-runtime';
    callerToken: string;
    reason?: string;
  }
  | {
    kind: 'layout-get';
    callerToken: string;
    path: string;
  }
  | {
    kind: 'layout-set';
    callerToken: string;
    path: string;
    value: unknown;
  };

function getRequestsDir(bridgeDir: string): string {
  return path.join(bridgeDir, 'requests');
}

function getResponsesDir(bridgeDir: string): string {
  return path.join(bridgeDir, 'responses');
}

function readRequestField(requestDir: string, name: string): string {
  return readFileSync(path.join(requestDir, name), 'utf8').trim();
}

function appendProgressLine(progressPath: string, text: string): void {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized.length === 0) {
    return;
  }
  // Keep progress line-oriented so the shell launcher can stream it cleanly to stderr.
  appendFileSync(
    progressPath,
    normalized.endsWith('\n') ? normalized : `${normalized}\n`,
    'utf8',
  );
}

function describeFsErrorCode(error: unknown): string {
  return error instanceof Error
    ? (error as NodeJS.ErrnoException).code ?? 'unknown'
    : 'unknown';
}

function describeFsErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRequest(requestDir: string): BridgeRequest {
  const kind = readRequestField(requestDir, 'kind');
  const callerToken = readRequestField(requestDir, 'caller-token');

  if (kind === 'list') {
    return { kind, callerToken };
  }

  if (kind === 'list-server-tools') {
    return {
      kind,
      callerToken,
      serverId: readRequestField(requestDir, 'server-id'),
    };
  }

  if (kind === 'find-tools') {
    return {
      kind,
      callerToken,
      query: readRequestField(requestDir, 'query'),
    };
  }

  if (kind === 'call') {
    const argsPath = path.join(requestDir, 'args.json');
    const rawArgs = readFileSync(argsPath, 'utf8');
    return {
      kind,
      callerToken,
      serverId: readRequestField(requestDir, 'server-id'),
      toolName: readRequestField(requestDir, 'tool-name'),
      args: JSON.parse(rawArgs) as Record<string, unknown>,
      saveToDisk: readRequestField(requestDir, 'save-to-disk') === 'true',
      saveToDiskPath: existsSync(path.join(requestDir, 'save-to-disk-path'))
        ? readRequestField(requestDir, 'save-to-disk-path')
        : undefined,
    };
  }

  if (kind === 'describe') {
    return {
      kind,
      callerToken,
      serverId: readRequestField(requestDir, 'server-id'),
      toolName: readRequestField(requestDir, 'tool-name'),
    };
  }

  if (kind === 'config-get') {
    return {
      kind,
      callerToken,
      path: readRequestField(requestDir, 'path'),
    };
  }

  if (kind === 'config-set') {
    const valuePath = path.join(requestDir, 'value.json');
    return {
      kind,
      callerToken,
      path: readRequestField(requestDir, 'path'),
      value: JSON.parse(readFileSync(valuePath, 'utf8')),
      restartRuntime: existsSync(path.join(requestDir, 'restart-runtime'))
        && readRequestField(requestDir, 'restart-runtime') === 'true',
    };
  }

  if (kind === 'config-restart-runtime') {
    const reasonPath = path.join(requestDir, 'reason');
    return {
      kind,
      callerToken,
      reason: existsSync(reasonPath) ? readRequestField(requestDir, 'reason') : undefined,
    };
  }

  if (kind === 'layout-get') {
    return {
      kind,
      callerToken,
      path: readRequestField(requestDir, 'path'),
    };
  }

  if (kind === 'layout-set') {
    const valuePath = path.join(requestDir, 'value.json');
    return {
      kind,
      callerToken,
      path: readRequestField(requestDir, 'path'),
      value: JSON.parse(readFileSync(valuePath, 'utf8')),
    };
  }

  throw new Error(`Unknown interpreter CLI bridge request kind: ${kind}`);
}

async function handleRequestDirectory(bridgeDir: string, requestId: string): Promise<void> {
  const requestsDir = getRequestsDir(bridgeDir);
  const responsesDir = getResponsesDir(bridgeDir);
  const requestDir = path.join(requestsDir, requestId);
  const readyPath = path.join(requestDir, '.ready');
  const responseDir = path.join(responsesDir, requestId);
  const responseStatusPath = path.join(responseDir, 'status');
  const responseBodyPath = path.join(responseDir, 'body');
  const responseProgressPath = path.join(responseDir, 'progress');

  if (!existsSync(requestDir) || !statSync(requestDir).isDirectory() || !existsSync(readyPath)) {
    return;
  }

  mkdirSync(responseDir, { recursive: true });

  let request: BridgeRequest;
  try {
    request = parseRequest(requestDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to parse interpreter CLI bridge request.';
    writeFileSync(responseBodyPath, message, 'utf8');
    writeFileSync(responseStatusPath, 'error', 'utf8');
    rmSync(requestDir, { recursive: true, force: true });
    return;
  }

  try {
    const result = request.kind === 'list'
      ? await listInterpreterCliTools(request.callerToken)
      : request.kind === 'list-server-tools'
        ? await listInterpreterCliServerTools(request.callerToken, request.serverId)
        : request.kind === 'find-tools'
          ? await findInterpreterCliTools(request.callerToken, request.query)
      : request.kind === 'describe'
        ? await describeInterpreterCliTool(
          request.callerToken,
          request.serverId,
          request.toolName,
        )
        : request.kind === 'config-get'
          ? await getInterpreterCliConfig(request.callerToken, request.path)
          : request.kind === 'config-set'
            ? await setInterpreterCliConfig({
              callerToken: request.callerToken,
              path: request.path,
              value: request.value,
              restartRuntime: request.restartRuntime,
            })
            : request.kind === 'config-restart-runtime'
              ? await restartInterpreterCliRuntime({
                callerToken: request.callerToken,
                reason: request.reason,
              })
            : request.kind === 'layout-get'
              ? await getInterpreterCliLayout(request.callerToken, request.path)
              : request.kind === 'layout-set'
                ? await setInterpreterCliLayout({
                  callerToken: request.callerToken,
                  path: request.path,
                  value: request.value,
                })
                : await callInterpreterCliTool({
                  callerToken: request.callerToken,
                  serverId: request.serverId,
                  toolName: request.toolName,
                  args: request.args,
                  saveToDisk: request.saveToDisk,
                  saveToDiskPath: request.saveToDiskPath,
                  onProgress: (text) => appendProgressLine(responseProgressPath, text),
                });
    writeFileSync(responseBodyPath, JSON.stringify(result), 'utf8');
    writeFileSync(responseStatusPath, 'ok', 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Interpreter CLI bridge request failed.';
    writeFileSync(responseBodyPath, message, 'utf8');
    writeFileSync(responseStatusPath, 'error', 'utf8');
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
  }
}

export async function startInterpreterCliFileBridge(
  port: number,
): Promise<InterpreterCliFileBridgeHandle> {
  const bridgeDir = getInterpreterCliBridgeDir(port);
  const requestsDir = getRequestsDir(bridgeDir);
  const responsesDir = getResponsesDir(bridgeDir);
  // Best-effort pre-clean of a stale bridge dir from a prior run. If a leftover dir is
  // owned by another uid (shared /tmp), rmSync throws EACCES/EPERM; that must not crash
  // startup. The recursive mkdirSync below is a no-op when the tree already exists.
  try {
    rmSync(bridgeDir, { recursive: true, force: true });
  } catch (error) {
    const code = describeFsErrorCode(error);
    if (code !== 'EACCES' && code !== 'EPERM') {
      throw error;
    }
    console.warn(
      `[interpreter-cli-file-bridge] stale bridge dir not removable path=${bridgeDir} code=${code}; reusing existing tree`,
    );
  }
  mkdirSync(requestsDir, { recursive: true });
  mkdirSync(responsesDir, { recursive: true });

  let scanInProgress = false;
  const activeRequests = new Set<string>();
  const scanWarningCodes = new Set<string>();

  const launchRequest = (requestId: string) => {
    if (!requestId || requestId.startsWith('.') || activeRequests.has(requestId)) {
      return;
    }

    activeRequests.add(requestId);
    void (async () => {
      try {
        await handleRequestDirectory(bridgeDir, requestId);
      } finally {
        activeRequests.delete(requestId);
        // A long-running request may have blocked later requests from being
        // discovered when it first started. Re-scan after every completion.
        void processPendingRequests();
      }
    })();
  };

  const processPendingRequests = async () => {
    if (scanInProgress) {
      return;
    }
    if (!existsSync(requestsDir)) {
      return;
    }
    scanInProgress = true;
    try {
      for (const requestId of readdirSync(requestsDir)) {
        launchRequest(requestId);
      }
    } catch (error) {
      const code = describeFsErrorCode(error);
      if (!scanWarningCodes.has(code)) {
        scanWarningCodes.add(code);
        console.warn(
          `[interpreter-cli-file-bridge] request scan failed path=${requestsDir} code=${code} message=${describeFsErrorMessage(error)}`,
        );
      }
    } finally {
      scanInProgress = false;
    }
  };

  const logWatcherError = (error: Error): void => {
    const code = describeFsErrorCode(error);
    console.warn(
      `[interpreter-cli-file-bridge] watcher error path=${requestsDir} code=${code} message=${describeFsErrorMessage(error)}`,
    );
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(requestsDir, () => {
      void processPendingRequests();
    });
    // NOTE(victor): fs.watch emits unhandled EPERM/EACCES/EBUSY/ENOSPC when
    // OS capacity, antivirus, indexers, or directory deletion break the watcher.
    // The 50ms poller below keeps processing requests even if watching fails.
    watcher.on('error', logWatcherError);
  } catch (error) {
    const code = describeFsErrorCode(error);
    console.warn(
      `[interpreter-cli-file-bridge] watcher unavailable path=${requestsDir} code=${code} message=${describeFsErrorMessage(error)}; continuing with poller`,
    );
  }
  // NOTE(victor): poller is the reliability fallback for fs.watch. On Windows, EPERM
  // from libuv destroys the underlying uv_fs_event_t handle, leaving the watcher inert.
  // Do not remove this poller without replacing the watcher reliability guarantee.
  const poller = setInterval(() => {
    void processPendingRequests();
  }, 50);
  poller.unref?.();

  await processPendingRequests();

  return {
    bridgeDir,
    close: async () => {
      watcher?.close();
      clearInterval(poller);
      rmSync(bridgeDir, { recursive: true, force: true });
    },
  };
}
