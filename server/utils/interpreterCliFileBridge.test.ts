import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { agentTabManager } from '../agentTabManager';
import { clearConfigCache, setConfigOverride } from '../configStore';
import { setToolManager } from '../tools/toolManagerAccessor';
import { setCurrentWorkspace } from './workspace';
import { startInterpreterCliFileBridge } from './interpreterCliFileBridge';

const ORIGINAL_INTERPRETER_HOME = process.env.INTERPRETER_HOME;

function writeListRequest(requestsDir: string, requestId: string, callerToken: string): void {
  const requestDir = path.join(requestsDir, requestId);
  mkdirSync(requestDir, { recursive: true });
  writeFileSync(path.join(requestDir, 'kind'), 'list', 'utf8');
  writeFileSync(path.join(requestDir, 'caller-token'), callerToken, 'utf8');
  writeFileSync(path.join(requestDir, '.ready'), '', 'utf8');
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met');
}

describe('interpreterCliFileBridge', () => {
  beforeEach(() => {
    agentTabManager.clearAll();
    setCurrentWorkspace(null);
    setConfigOverride({ globalDisabledTools: [] } as any);
    clearConfigCache();
  });

  afterEach(async () => {
    agentTabManager.clearAll();
    setConfigOverride(null);
    clearConfigCache();
    if (ORIGINAL_INTERPRETER_HOME) {
      process.env.INTERPRETER_HOME = ORIGINAL_INTERPRETER_HOME;
    } else {
      delete process.env.INTERPRETER_HOME;
    }
  });

  // NOTE(victor): fs.FSWatcher extends EventEmitter (@types/node/fs.d.ts:366) with
  // close(), ref(), unref(). Tests spy on fs.watch to inject this fake so we can
  // emit controlled 'error' events without touching the real filesystem.
  function createFakeWatcher(): EventEmitter & { close: () => void } {
    const emitter = new EventEmitter();
    (emitter as any).close = () => {};
    return emitter as EventEmitter & { close: () => void };
  }

  // NOTE(victor): Node emits ErrnoException (Error + optional code/errno/path/syscall)
  // for fs errors. The 'error' event on FSWatcher is typed as plain Error
  // (@types/node/fs.d.ts:404), but runtime always includes .code for OS-level failures.
  function makeErrno(code: string, message: string): NodeJS.ErrnoException {
    const err = new Error(message) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  }

  test('processes file bridge requests concurrently', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-file-bridge-'));
    process.env.INTERPRETER_HOME = tempHome;

    let activeCalls = 0;
    let maxActiveCalls = 0;
    let startedCalls = 0;
    let resolveRelease: (() => void) | null = null;
    const releasePromise = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    let resolveBothStarted: (() => void) | null = null;
    const bothStartedPromise = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    let bothStartedNotified = false;

    setToolManager({
      async listAllToolServers() {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        startedCalls += 1;
        if (startedCalls >= 2 && !bothStartedNotified) {
          bothStartedNotified = true;
          resolveBothStarted?.();
        }

        try {
          await releasePromise;
          return [];
        } finally {
          activeCalls -= 1;
        }
      },
    } as any);

    agentTabManager.bindThread({
      agentId: 'agent-file-bridge',
      threadId: 'thr_file_bridge',
      callerToken: 'agtok_file_bridge',
    });

    const bridgePort = Date.now();
    const bridge = await startInterpreterCliFileBridge(bridgePort);

    try {
      const requestsDir = path.join(bridge.bridgeDir, 'requests');
      const responsesDir = path.join(bridge.bridgeDir, 'responses');

      writeListRequest(requestsDir, 'req-a', 'agtok_file_bridge');
      writeListRequest(requestsDir, 'req-b', 'agtok_file_bridge');

      await Promise.race([
        bothStartedPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('bridge requests did not overlap')), 1_000)),
      ]);
      expect(maxActiveCalls).toBe(2);

      resolveRelease?.();

      const responseAStatus = path.join(responsesDir, 'req-a', 'status');
      const responseBStatus = path.join(responsesDir, 'req-b', 'status');
      await waitFor(() => existsSync(responseAStatus) && existsSync(responseBStatus));

      expect(readFileSync(responseAStatus, 'utf8')).toBe('ok');
      expect(readFileSync(responseBStatus, 'utf8')).toBe('ok');
      expect(readFileSync(path.join(responsesDir, 'req-a', 'body'), 'utf8')).toBe('{"servers":[]}');
      expect(readFileSync(path.join(responsesDir, 'req-b', 'body'), 'utf8')).toBe('{"servers":[]}');
    } finally {
      resolveRelease?.();
      await bridge.close();
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('watcher EPERM error is caught and logged without crashing', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-file-bridge-'));
    process.env.INTERPRETER_HOME = tempHome;

    const fakeWatcher = createFakeWatcher();
    const watchSpy = spyOn(fs, 'watch').mockReturnValue(fakeWatcher as any);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    setToolManager({ async listAllToolServers() { return []; } } as any);
    agentTabManager.bindThread({
      agentId: 'agent-file-bridge',
      threadId: 'thr_file_bridge',
      callerToken: 'agtok_file_bridge',
    });

    const bridge = await startInterpreterCliFileBridge(Date.now());
    try {
      fakeWatcher.emit('error', makeErrno('EPERM', 'EPERM: operation not permitted, watch'));

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = warnSpy.mock.calls[0]![0] as string;
      expect(logged).toContain('code=EPERM');
      expect(logged).toContain('operation not permitted');
    } finally {
      await bridge.close();
      watchSpy.mockRestore();
      warnSpy.mockRestore();
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('startup continues with poller when fs.watch throws synchronously', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-file-bridge-'));
    process.env.INTERPRETER_HOME = tempHome;

    const watchSpy = spyOn(fs, 'watch').mockImplementation(() => {
      throw makeErrno('ENOSPC', 'ENOSPC: System limit for number of file watchers reached, watch');
    });
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    setToolManager({ async listAllToolServers() { return []; } } as any);
    agentTabManager.bindThread({
      agentId: 'agent-file-bridge',
      threadId: 'thr_file_bridge',
      callerToken: 'agtok_file_bridge',
    });

    const bridge = await startInterpreterCliFileBridge(Date.now());
    try {
      const requestsDir = path.join(bridge.bridgeDir, 'requests');
      const responsesDir = path.join(bridge.bridgeDir, 'responses');

      writeListRequest(requestsDir, 'req-watch-unavailable', 'agtok_file_bridge');

      const responseStatus = path.join(responsesDir, 'req-watch-unavailable', 'status');
      await waitFor(() => existsSync(responseStatus));

      expect(readFileSync(responseStatus, 'utf8')).toBe('ok');
      const logged = warnSpy.mock.calls[0]![0] as string;
      expect(logged).toContain('watcher unavailable');
      expect(logged).toContain('code=ENOSPC');
      expect(logged).toContain('continuing with poller');
    } finally {
      await bridge.close();
      watchSpy.mockRestore();
      warnSpy.mockRestore();
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('startup scan handles transient readdir ENOENT without rejecting bridge startup', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-file-bridge-'));
    process.env.INTERPRETER_HOME = tempHome;

    let readdirCalls = 0;
    const originalReaddirSync = fs.readdirSync;
    const readdirSpy = spyOn(fs, 'readdirSync').mockImplementation(((targetPath: fs.PathLike, options?: any) => {
      readdirCalls += 1;
      if (readdirCalls === 1) {
        throw makeErrno('ENOENT', 'ENOENT: no such file or directory, scandir');
      }
      return originalReaddirSync(targetPath, options as any) as any;
    }) as typeof fs.readdirSync);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    setToolManager({ async listAllToolServers() { return []; } } as any);
    agentTabManager.bindThread({
      agentId: 'agent-file-bridge',
      threadId: 'thr_file_bridge',
      callerToken: 'agtok_file_bridge',
    });

    const bridge = await startInterpreterCliFileBridge(Date.now());
    try {
      const logged = warnSpy.mock.calls[0]![0] as string;
      expect(logged).toContain('request scan failed');
      expect(logged).toContain('code=ENOENT');

      const requestsDir = path.join(bridge.bridgeDir, 'requests');
      const responsesDir = path.join(bridge.bridgeDir, 'responses');

      writeListRequest(requestsDir, 'req-after-readdir-race', 'agtok_file_bridge');

      const responseStatus = path.join(responsesDir, 'req-after-readdir-race', 'status');
      await waitFor(() => existsSync(responseStatus));

      expect(readFileSync(responseStatus, 'utf8')).toBe('ok');
    } finally {
      await bridge.close();
      readdirSpy.mockRestore();
      warnSpy.mockRestore();
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('watcher EACCES error is caught and logged', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-file-bridge-'));
    process.env.INTERPRETER_HOME = tempHome;

    const fakeWatcher = createFakeWatcher();
    const watchSpy = spyOn(fs, 'watch').mockReturnValue(fakeWatcher as any);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    setToolManager({ async listAllToolServers() { return []; } } as any);
    agentTabManager.bindThread({
      agentId: 'agent-file-bridge',
      threadId: 'thr_file_bridge',
      callerToken: 'agtok_file_bridge',
    });

    const bridge = await startInterpreterCliFileBridge(Date.now());
    try {
      fakeWatcher.emit('error', makeErrno('EACCES', 'EACCES: permission denied, watch'));

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = warnSpy.mock.calls[0]![0] as string;
      expect(logged).toContain('code=EACCES');
      expect(logged).toContain('permission denied');
    } finally {
      await bridge.close();
      watchSpy.mockRestore();
      warnSpy.mockRestore();
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('watcher EBUSY error from Windows file lock is caught', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-file-bridge-'));
    process.env.INTERPRETER_HOME = tempHome;

    const fakeWatcher = createFakeWatcher();
    const watchSpy = spyOn(fs, 'watch').mockReturnValue(fakeWatcher as any);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    setToolManager({ async listAllToolServers() { return []; } } as any);
    agentTabManager.bindThread({
      agentId: 'agent-file-bridge',
      threadId: 'thr_file_bridge',
      callerToken: 'agtok_file_bridge',
    });

    const bridge = await startInterpreterCliFileBridge(Date.now());
    try {
      fakeWatcher.emit('error', makeErrno('EBUSY', 'EBUSY: resource busy or locked, watch'));

      const logged = warnSpy.mock.calls[0]![0] as string;
      expect(logged).toContain('code=EBUSY');
    } finally {
      await bridge.close();
      watchSpy.mockRestore();
      warnSpy.mockRestore();
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('watcher ENOENT error from deleted directory is caught', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-file-bridge-'));
    process.env.INTERPRETER_HOME = tempHome;

    const fakeWatcher = createFakeWatcher();
    const watchSpy = spyOn(fs, 'watch').mockReturnValue(fakeWatcher as any);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    setToolManager({ async listAllToolServers() { return []; } } as any);
    agentTabManager.bindThread({
      agentId: 'agent-file-bridge',
      threadId: 'thr_file_bridge',
      callerToken: 'agtok_file_bridge',
    });

    const bridge = await startInterpreterCliFileBridge(Date.now());
    try {
      fakeWatcher.emit('error', makeErrno('ENOENT', 'ENOENT: no such file or directory, watch'));

      const logged = warnSpy.mock.calls[0]![0] as string;
      expect(logged).toContain('code=ENOENT');
    } finally {
      await bridge.close();
      watchSpy.mockRestore();
      warnSpy.mockRestore();
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  for (const watchFailure of [
    {
      code: 'ENOSPC',
      message: "ENOSPC: System limit for number of file watchers reached, watch '/tmp/interpreter-cli-bridge-5177/requests'",
    },
    {
      code: 'EMFILE',
      message: "EMFILE: too many open files, watch '/tmp/interpreter-cli-bridge-5177/requests'",
    },
  ]) {
    test(`poller processes requests when fs.watch throws ${watchFailure.code} on startup`, async () => {
      const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-file-bridge-'));
      process.env.INTERPRETER_HOME = tempHome;

      const watchSpy = spyOn(fs, 'watch').mockImplementation(() => {
        throw makeErrno(watchFailure.code, watchFailure.message);
      });
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      setToolManager({ async listAllToolServers() { return []; } } as any);
      agentTabManager.bindThread({
        agentId: 'agent-file-bridge',
        threadId: 'thr_file_bridge',
        callerToken: 'agtok_file_bridge',
      });

      const bridge = await startInterpreterCliFileBridge(Date.now());
      try {
        const requestsDir = path.join(bridge.bridgeDir, 'requests');
        const responsesDir = path.join(bridge.bridgeDir, 'responses');
        const requestId = `req-after-watch-${watchFailure.code.toLowerCase()}`;

        writeListRequest(requestsDir, requestId, 'agtok_file_bridge');

        const responseStatus = path.join(responsesDir, requestId, 'status');
        await waitFor(() => existsSync(responseStatus));

        expect(readFileSync(responseStatus, 'utf8')).toBe('ok');
        expect(readFileSync(path.join(responsesDir, requestId, 'body'), 'utf8')).toBe('{"servers":[]}');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`code=${watchFailure.code}`));
      } finally {
        await bridge.close();
        watchSpy.mockRestore();
        warnSpy.mockRestore();
        await rm(tempHome, { recursive: true, force: true });
      }
    });
  }

  test('watcher error without code field logs code=unknown', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-file-bridge-'));
    process.env.INTERPRETER_HOME = tempHome;

    const fakeWatcher = createFakeWatcher();
    const watchSpy = spyOn(fs, 'watch').mockReturnValue(fakeWatcher as any);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    setToolManager({ async listAllToolServers() { return []; } } as any);
    agentTabManager.bindThread({
      agentId: 'agent-file-bridge',
      threadId: 'thr_file_bridge',
      callerToken: 'agtok_file_bridge',
    });

    const bridge = await startInterpreterCliFileBridge(Date.now());
    try {
      fakeWatcher.emit('error', new Error('something unexpected'));

      const logged = warnSpy.mock.calls[0]![0] as string;
      expect(logged).toContain('code=unknown');
      expect(logged).toContain('something unexpected');
    } finally {
      await bridge.close();
      watchSpy.mockRestore();
      warnSpy.mockRestore();
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('multiple sequential watcher errors are all caught', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-file-bridge-'));
    process.env.INTERPRETER_HOME = tempHome;

    const fakeWatcher = createFakeWatcher();
    const watchSpy = spyOn(fs, 'watch').mockReturnValue(fakeWatcher as any);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    setToolManager({ async listAllToolServers() { return []; } } as any);
    agentTabManager.bindThread({
      agentId: 'agent-file-bridge',
      threadId: 'thr_file_bridge',
      callerToken: 'agtok_file_bridge',
    });

    const bridge = await startInterpreterCliFileBridge(Date.now());
    try {
      fakeWatcher.emit('error', makeErrno('EPERM', 'EPERM: operation not permitted, watch'));
      fakeWatcher.emit('error', makeErrno('EACCES', 'EACCES: permission denied, watch'));
      fakeWatcher.emit('error', makeErrno('EBUSY', 'EBUSY: resource busy or locked, watch'));

      expect(warnSpy).toHaveBeenCalledTimes(3);
      expect((warnSpy.mock.calls[0]![0] as string)).toContain('code=EPERM');
      expect((warnSpy.mock.calls[1]![0] as string)).toContain('code=EACCES');
      expect((warnSpy.mock.calls[2]![0] as string)).toContain('code=EBUSY');
    } finally {
      await bridge.close();
      watchSpy.mockRestore();
      warnSpy.mockRestore();
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('poller continues processing requests after watcher error', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-file-bridge-'));
    process.env.INTERPRETER_HOME = tempHome;

    const fakeWatcher = createFakeWatcher();
    const watchSpy = spyOn(fs, 'watch').mockReturnValue(fakeWatcher as any);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    setToolManager({
      async listAllToolServers() { return []; },
    } as any);

    agentTabManager.bindThread({
      agentId: 'agent-file-bridge',
      threadId: 'thr_file_bridge',
      callerToken: 'agtok_file_bridge',
    });

    const bridge = await startInterpreterCliFileBridge(Date.now());
    try {
      fakeWatcher.emit('error', makeErrno('EPERM', 'EPERM: operation not permitted, watch'));

      const requestsDir = path.join(bridge.bridgeDir, 'requests');
      const responsesDir = path.join(bridge.bridgeDir, 'responses');

      writeListRequest(requestsDir, 'req-after-eperm', 'agtok_file_bridge');

      const responseStatus = path.join(responsesDir, 'req-after-eperm', 'status');
      await waitFor(() => existsSync(responseStatus));

      expect(readFileSync(responseStatus, 'utf8')).toBe('ok');
      expect(readFileSync(path.join(responsesDir, 'req-after-eperm', 'body'), 'utf8')).toBe('{"servers":[]}');
    } finally {
      await bridge.close();
      watchSpy.mockRestore();
      warnSpy.mockRestore();
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  for (const scanFailure of [
    { code: 'UNKNOWN', message: 'UNKNOWN: unknown error, scandir' },
    { code: 'EPERM', message: "EPERM: operation not permitted, scandir 'C:\\Users\\MykoG\\AppData\\Local\\Temp\\interpreter-cli-bridge-5177\\requests'" },
    { code: 'ENFILE', message: 'ENFILE: file table overflow, scandir' },
  ]) {
    test(`poller continues processing requests after a transient ${scanFailure.code} request scan failure`, async () => {
      const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-file-bridge-'));
      process.env.INTERPRETER_HOME = tempHome;

      const realReaddirSync = fs.readdirSync;
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      let throwOnce = true;
      const readdirSpy = spyOn(fs, 'readdirSync').mockImplementation((target: fs.PathLike, options?: any) => {
        if (throwOnce && String(target).endsWith(`${path.sep}requests`)) {
          throwOnce = false;
          throw makeErrno(scanFailure.code, scanFailure.message);
        }
        return (realReaddirSync as any)(target, options);
      });

      setToolManager({
        async listAllToolServers() { return []; },
      } as any);

      agentTabManager.bindThread({
        agentId: 'agent-file-bridge',
        threadId: 'thr_file_bridge',
        callerToken: 'agtok_file_bridge',
      });

      const bridge = await startInterpreterCliFileBridge(Date.now());
      try {
        const requestsDir = path.join(bridge.bridgeDir, 'requests');
        const responsesDir = path.join(bridge.bridgeDir, 'responses');

        writeListRequest(requestsDir, 'req-after-scan-failure', 'agtok_file_bridge');

        const responseStatus = path.join(responsesDir, 'req-after-scan-failure', 'status');
        await waitFor(() => existsSync(responseStatus));

        expect(readFileSync(responseStatus, 'utf8')).toBe('ok');
        expect(readFileSync(path.join(responsesDir, 'req-after-scan-failure', 'body'), 'utf8')).toBe('{"servers":[]}');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('request scan failed'));
      } finally {
        await bridge.close();
        readdirSpy.mockRestore();
        warnSpy.mockRestore();
        await rm(tempHome, { recursive: true, force: true });
      }
    });
  }
});
