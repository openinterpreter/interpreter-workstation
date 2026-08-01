import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildInterpreterCliServerConnection,
  buildInterpreterCliShellEnvironmentPolicy,
  ensureInterpreterCliLauncher,
  materializeInterpreterCliLauncher,
  INTERPRETER_CLI_PATH_ENV,
  INTERPRETER_CLI_SERVER_CONNECTION_ENV,
  getInterpreterCliBridgeDir,
  getInterpreterCliExecutablePath,
  getInterpreterCliLauncherDir,
  getInterpreterCliRuntimeDir,
  getInterpreterCliShellSandboxReadableRoots,
  getInterpreterCliShellSafeExecutablePath,
  getInterpreterCliShellSafeLauncherDir,
  getInterpreterCliSocketPath,
  INTERPRETER_CALLER_TOKEN_ENV,
  INTERPRETER_CLI_CALLER_TOKEN_HEADER,
} from './interpreterCliRuntime';

const ORIGINAL_INTERPRETER_HOME = process.env.INTERPRETER_HOME;
const ORIGINAL_INTERPRETER_USER_DATA_DIR = process.env.INTERPRETER_USER_DATA_DIR;
const ORIGINAL_TEMP = process.env.TEMP;
const ORIGINAL_TMP = process.env.TMP;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

afterEach(async () => {
  restoreEnv('INTERPRETER_HOME', ORIGINAL_INTERPRETER_HOME);
  restoreEnv('INTERPRETER_USER_DATA_DIR', ORIGINAL_INTERPRETER_USER_DATA_DIR);
  restoreEnv('TEMP', ORIGINAL_TEMP);
  restoreEnv('TMP', ORIGINAL_TMP);
});

describe('interpreterCliRuntime', () => {
  async function useTempInterpreterDataDir(prefix: string): Promise<string> {
    const tempHome = await mkdtemp(path.join(tmpdir(), prefix));
    process.env.INTERPRETER_HOME = tempHome;
    process.env.INTERPRETER_USER_DATA_DIR = tempHome;
    return tempHome;
  }

  async function spawnProcess(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    stdin?: string,
  ): Promise<{
    error?: Error;
    signal: NodeJS.Signals | null;
    status: number | null;
    stderr: string;
    stdout: string;
  }> {
    return await new Promise((resolve) => {
      let childError: Error | undefined;
      const child = spawn(command, args, {
        env,
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';

      if (stdin !== undefined) {
        child.stdin?.write(stdin);
        child.stdin?.end();
      }
      child.on('error', (error) => {
        childError = error;
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (status, signal) => {
        resolve({
          error: childError,
          signal,
          status,
          stderr,
          stdout,
        });
      });
    });
  }

  test('uses Interpreter runtime storage for the Windows file bridge directory', async () => {
    const userDataDir = 'C:\\Users\\MykoG\\AppData\\Roaming\\Interpreter';
    process.env.INTERPRETER_USER_DATA_DIR = userDataDir;
    process.env.TEMP = '%USERP~1\\AppData\\Local\\Temp';
    process.env.TMP = '%USERP~1\\AppData\\Local\\Temp';

    const bridgeDir = path.win32.join(userDataDir, 'runtime', 'interpreter-cli', 'bridge', '5517');

    expect(getInterpreterCliBridgeDir(5517, 'win32')).toBe(bridgeDir);
    expect(buildInterpreterCliServerConnection(5517, { platform: 'win32', transport: 'file' })).toBe(
      `file:${bridgeDir}`,
    );
  });

  async function spawnNodeProcess(
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{
    error?: Error;
    signal: NodeJS.Signals | null;
    status: number | null;
    stderr: string;
    stdout: string;
  }> {
    return await spawnProcess('node', args, env);
  }

  async function spawnUnixLauncherProcess(
    launcherPath: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    stdin?: string,
  ): Promise<{
    error?: Error;
    signal: NodeJS.Signals | null;
    status: number | null;
    stderr: string;
    stdout: string;
  }> {
    if (process.platform === 'win32') {
      return await spawnProcess('sh', [launcherPath, ...args], env, stdin);
    }
    return await spawnProcess(launcherPath, args, env, stdin);
  }

  async function spawnLauncherProcess(
    launcherPath: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = process.platform,
  ): Promise<{
    error?: Error;
    signal: NodeJS.Signals | null;
    status: number | null;
    stderr: string;
    stdout: string;
  }> {
    if (platform === 'win32') {
      return await spawnProcess('cmd.exe', ['/d', '/c', launcherPath, ...args], env);
    }
    return await spawnUnixLauncherProcess(launcherPath, args, env);
  }

  function withServerConnection(
    env: NodeJS.ProcessEnv,
    port: number,
    transport: 'file' | 'http' | 'unix',
    platform: NodeJS.Platform = process.platform,
  ): NodeJS.ProcessEnv {
    return {
      ...env,
      [INTERPRETER_CLI_SERVER_CONNECTION_ENV]: buildInterpreterCliServerConnection(port, {
        platform,
        transport,
      }),
    };
  }

  test('writes launcher files into interpreter home', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-runtime-');

    try {
      const launcherPath = ensureInterpreterCliLauncher('darwin');

      expect(launcherPath).toBe(getInterpreterCliExecutablePath('darwin'));
      expect(existsSync(launcherPath)).toBe(true);

      const script = readFileSync(launcherPath, 'utf8');
      expect(script).toContain('/api/interpreter-cli/tools');
      expect(script).toContain('INTERPRETER_CALLER_TOKEN');
      expect(script).toContain('interpreter-app tools find <query>');
      expect(script).toContain('--unix-socket');
      expect(script).toContain('interpreter-app tools <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]');
      expect(script).toContain('interpreter-app mcp <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]');
      expect(script).toContain('interpreter-app tools <server-id>__<tool-name> --help');
      expect(script).toContain('interpreter-app tools find "read word docx"');
      expect(script).toContain('interpreter-app tools find "convert docx to pdf"');
      expect(script).toContain("interpreter-app tools builtin-docx read_word --json '{\"path\":\"Notes.docx\"}'");
      expect(script).toContain("interpreter-app tools builtin-pdf read_pdf --json '{\"path\":\"packet.pdf\"}'");
      expect(script).toContain("interpreter-app tools builtin-converter convert_file --json '{\"path\":\"Notes.docx\",\"format\":\"pdf\"}'");
      expect(script).toContain("interpreter-app tools builtin-interpreter interpreter_refresh_file --json '{\"path\":\"report.xlsx\"}'");
      expect(script).toContain('Top-level tools list does not list individual tools.');
      expect(script).toContain('Many built-in tools live on shared servers such as builtin-interpreter.');
      expect(script).toContain('interpreter-app config get [path]');
      expect(script).toContain('interpreter-app config restart-runtime [--reason <text>]');
      expect(script).toContain('/api/interpreter-cli/config/restart-runtime');
      expect(script).toContain("'config-restart-runtime'");
      expect(script).toContain('interpreter-app layout set <path>');
      expect(script).toContain('Current Settings tabs:');
      expect(script).toContain('Common settings you can change:');
      expect(script).toContain('theme - Theme');
      expect(script).toContain('agentAccess.network - Network (needs approval, restart needed)');
      expect(script).toContain('Config aliases:');
      expect(script).toContain('builtin-interpreter interpreter_settings_get --help');
      expect(script).toContain('mktemp -d "$staging_root/req-XXXXXX"');
      expect(script).toContain('query="saveToDisk=$save_to_disk"');
      expect(script).toContain('saveToDiskPath=$(url_encode "$save_to_disk_path")');
      expect(script).toContain('Interpreter CLI bridge disconnected while waiting for response.');
      expect(script).not.toContain("printf 'req-$$-");
      expect(script).not.toContain('Timed out waiting for interpreter CLI response.');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('keeps the Unix shell-safe launcher in a stable home path outside the runtime dir', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-shell-safe-home-');

    try {
      const shellHome = path.join(tempHome, 'Library', 'Application Support', 'interpreter', 'codex-home', 'home');
      expect(getInterpreterCliShellSafeLauncherDir('darwin', shellHome)).toBe(
        path.join(shellHome, '.interpreter', 'runtime', 'interpreter-cli', 'shell-safe-bin'),
      );
      expect(getInterpreterCliShellSafeExecutablePath('darwin', shellHome)).toBe(
        path.join(shellHome, '.interpreter', 'runtime', 'interpreter-cli', 'shell-safe-bin', 'interpreter-app'),
      );
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('streams file bridge progress to stderr while waiting for the final JSON body', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-file-progress-');

    try {
      const launcherPath = ensureInterpreterCliLauncher('darwin');

      const bridgeDir = getInterpreterCliBridgeDir(5517, 'darwin');
      const requestsDir = path.join(bridgeDir, 'requests');
      const responsesDir = path.join(bridgeDir, 'responses');
      mkdirSync(requestsDir, { recursive: true });
      mkdirSync(responsesDir, { recursive: true });

      const resultPromise = spawnUnixLauncherProcess(
        launcherPath,
        ['tools', 'builtin-media-ai', 'run_media_model'],
        withServerConnection({
          ...process.env,
          INTERPRETER_HOME: tempHome,
          [INTERPRETER_CALLER_TOKEN_ENV]: 'agtok_progress',
        }, 5517, 'file', 'darwin'),
      );

      let requestId = '';
      for (let attempt = 0; attempt < 100 && requestId.length === 0; attempt += 1) {
        const requestDirs = readdirSync(requestsDir).filter((entry) => !entry.startsWith('.'));
        requestId = requestDirs[0] ?? '';
        if (!requestId) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      expect(requestId.length).toBeGreaterThan(0);

      const responseDir = path.join(responsesDir, requestId);
      const progressPath = path.join(responseDir, 'progress');
      mkdirSync(responseDir, { recursive: true });
      appendFileSync(progressPath, '[MediaAI] phase="queue_submitted" requestId="req_123"\n', 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 40));
      appendFileSync(progressPath, '[MediaAI] phase="queue_status" status="IN_PROGRESS"\n', 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 40));
      appendFileSync(progressPath, '[MediaAI] phase="queue_completed" requestId="req_123"\n', 'utf8');
      writeFileSync(path.join(responseDir, 'body'), '{"ok":true}', 'utf8');
      writeFileSync(path.join(responseDir, 'status'), 'ok', 'utf8');

      const result = await resultPromise;
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('{"ok":true}');
      expect(result.stderr).toContain('[MediaAI] phase="queue_submitted" requestId="req_123"');
      expect(result.stderr).toContain('[MediaAI] phase="queue_status" status="IN_PROGRESS"');
      expect(result.stderr).toContain('[MediaAI] phase="queue_completed" requestId="req_123"');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('streams HTTP tool progress to stderr through the Unix launcher and keeps JSON on stdout', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-http-progress-');

    const requests: Array<{
      method?: string;
      url?: string;
      body: string;
      callerToken?: string;
      connection?: string;
    }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          body,
          callerToken: Array.isArray(req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()])
            ? req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()][0]
            : req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()],
          connection: Array.isArray(req.headers.connection)
            ? req.headers.connection[0]
            : req.headers.connection,
        });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.write('progress [MediaAI] phase="queue_submitted" requestId="req_123"\n');
        setTimeout(() => {
          res.write('progress [MediaAI] phase="queue_status" status="IN_PROGRESS"\n');
          res.end('result {"ok":true,"saved":"Movie/output.mp4"}\n');
        }, 20);
      });
    });

    try {
      const launcherPath = ensureInterpreterCliLauncher('darwin');
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected an ephemeral HTTP port for test server.');
      }

      const result = await spawnUnixLauncherProcess(
        launcherPath,
        ['tools', 'builtin-media-ai', 'run_media_model'],
        withServerConnection({
          ...process.env,
          INTERPRETER_HOME: tempHome,
          [INTERPRETER_CALLER_TOKEN_ENV]: 'agtok_http_progress',
        }, address.port, 'http', 'darwin'),
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('{"ok":true,"saved":"Movie/output.mp4"}');
      expect(result.stderr).toContain('[MediaAI] phase="queue_submitted" requestId="req_123"');
      expect(result.stderr).toContain('[MediaAI] phase="queue_status" status="IN_PROGRESS"');
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/api/interpreter-cli/tools/builtin-media-ai/run_media_model/stream?saveToDisk=false',
          body: '{}',
          callerToken: 'agtok_http_progress',
          connection: undefined,
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('supports the mcp namespace through the Unix launcher', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-mcp-alias-'));
    process.env.INTERPRETER_HOME = tempHome;

    const requests: Array<{
      method?: string;
      url?: string;
      body: string;
      callerToken?: string;
    }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          body,
          callerToken: Array.isArray(req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()])
            ? req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()][0]
            : req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()],
        });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('result {"ok":true}\n');
      });
    });

    try {
      const launcherPath = ensureInterpreterCliLauncher('darwin');
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected an ephemeral HTTP port for test server.');
      }

      const result = await spawnUnixLauncherProcess(
        launcherPath,
        ['mcp', 'filesystem', 'read_file', '--json', '{"path":"README.md"}'],
        withServerConnection({
          ...process.env,
          INTERPRETER_HOME: tempHome,
          [INTERPRETER_CALLER_TOKEN_ENV]: 'agtok_mcp_alias',
        }, address.port, 'http', 'darwin'),
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('{"ok":true}');
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/api/interpreter-cli/tools/filesystem/read_file/stream?saveToDisk=false',
          body: '{"path":"README.md"}',
          callerToken: 'agtok_mcp_alias',
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('merges --stdin-arg raw stdin into the tool args as a string field', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-stdin-arg-'));
    process.env.INTERPRETER_HOME = tempHome;

    const requests: Array<{ body: string }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({ body });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('result {"ok":true}\n');
      });
    });

    try {
      const launcherPath = ensureInterpreterCliLauncher('darwin');
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected an ephemeral HTTP port for test server.');
      }
      const env = withServerConnection({
        ...process.env,
        INTERPRETER_HOME: tempHome,
        [INTERPRETER_CALLER_TOKEN_ENV]: 'agtok_stdin_arg',
      }, address.port, 'http', 'darwin');
      const code = 'globalThis.page = await globalThis.ensurePage();\nconsole.log("quoted \\" and backslash \\\\ survive");\n';

      const bare = await spawnUnixLauncherProcess(
        launcherPath,
        ['tools', 'builtin-js-repl', 'js_repl', '--stdin-arg', 'code'],
        env,
        code,
      );
      expect(bare.stderr).toBe('');
      expect(bare.status).toBe(0);

      const combined = await spawnUnixLauncherProcess(
        launcherPath,
        ['tools', 'builtin-js-repl', 'js_repl', '--json', '{"timeout_ms":300000}', '--stdin-arg', 'code'],
        env,
        code,
      );
      expect(combined.stderr).toBe('');
      expect(combined.status).toBe(0);

      const padded = await spawnUnixLauncherProcess(
        launcherPath,
        ['tools', 'builtin-js-repl', 'js_repl', '--json', '  { "timeout_ms" : 5 }\n', '--stdin-arg', 'code'],
        env,
        code,
      );
      expect(padded.stderr).toBe('');
      expect(padded.status).toBe(0);

      // $(cat) strips trailing newlines, matching heredoc usage.
      const expectedCode = code.replace(/\n$/, '');
      expect(requests).toHaveLength(3);
      expect(JSON.parse(requests[0].body)).toEqual({ code: expectedCode });
      expect(JSON.parse(requests[1].body)).toEqual({ timeout_ms: 300000, code: expectedCode });
      expect(JSON.parse(requests[2].body)).toEqual({ timeout_ms: 5, code: expectedCode });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('merges --stdin-arg through the Node launcher variant', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-stdin-arg-node-'));
    process.env.INTERPRETER_HOME = tempHome;

    const requests: Array<{ body: string }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({ body });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('result {"ok":true}\n');
      });
    });

    try {
      ensureInterpreterCliLauncher('win32');
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected an ephemeral HTTP port for test server.');
      }
      const code = 'globalThis.page = await globalThis.ensurePage();\nconsole.log("quoted \\" and backslash \\\\");';

      const result = await spawnProcess(
        'node',
        [
          path.join(getInterpreterCliLauncherDir(), 'interpreter-app.cjs'),
          'tools', 'builtin-js-repl', 'js_repl', '--json', '{"timeout_ms":300000}', '--stdin-arg', 'code',
        ],
        withServerConnection({
          ...process.env,
          INTERPRETER_HOME: tempHome,
          [INTERPRETER_CALLER_TOKEN_ENV]: 'agtok_stdin_arg_node',
        }, address.port, 'http', 'win32'),
        code,
      );

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(requests).toHaveLength(1);
      expect(JSON.parse(requests[0].body)).toEqual({ timeout_ms: 300000, code });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('rejects --stdin-arg when combined with --stdin-json or a non-object --json', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-stdin-arg-err-'));
    process.env.INTERPRETER_HOME = tempHome;

    try {
      const launcherPath = ensureInterpreterCliLauncher('darwin');
      const env = withServerConnection({
        ...process.env,
        INTERPRETER_HOME: tempHome,
        [INTERPRETER_CALLER_TOKEN_ENV]: 'agtok_stdin_arg_err',
      }, 65_535, 'http', 'darwin');

      const conflicting = await spawnUnixLauncherProcess(
        launcherPath,
        ['tools', 'builtin-js-repl', 'js_repl', '--stdin-json', '--stdin-arg', 'code'],
        env,
        '{"code":"1"}',
      );
      expect(conflicting.status).toBe(1);
      expect(conflicting.stderr).toContain('--stdin-arg cannot be combined with --stdin-json');

      const nonObject = await spawnUnixLauncherProcess(
        launcherPath,
        ['tools', 'builtin-js-repl', 'js_repl', '--json', '[1,2]', '--stdin-arg', 'code'],
        env,
        'console.log(1);',
      );
      expect(nonObject.status).toBe(1);
      expect(nonObject.stderr).toContain('--stdin-arg requires the --json/--json-file value to be a JSON object');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('Unix launcher forwards save-to-disk paths and exits nonzero on tool isError', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-http-tool-error-');

    const requests: Array<{
      method?: string;
      url?: string;
      body: string;
      callerToken?: string;
    }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          body,
          callerToken: Array.isArray(req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()])
            ? req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()][0]
            : req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()],
        });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('result {"content":[{"type":"text","text":"failed"}],"isError":true}\n');
      });
    });

    try {
      const launcherPath = ensureInterpreterCliLauncher('darwin');
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected an ephemeral HTTP port for test server.');
      }

      const result = await spawnUnixLauncherProcess(
        launcherPath,
        ['tools', 'builtin-cua-driver', 'screenshot', '--json', '{"window_id":123}', '--save-to-disk', '/tmp/shot with space.png'],
        withServerConnection({
          ...process.env,
          INTERPRETER_HOME: tempHome,
          [INTERPRETER_CALLER_TOKEN_ENV]: 'agtok_http_tool_error',
        }, address.port, 'http', 'darwin'),
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('{"content":[{"type":"text","text":"failed"}],"isError":true}');
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/api/interpreter-cli/tools/builtin-cua-driver/screenshot/stream?saveToDisk=true&saveToDiskPath=%2ftmp%2fshot%20with%20space.png',
          body: '{"window_id":123}',
          callerToken: 'agtok_http_tool_error',
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('writes a Windows launcher that uses PowerShell for file bridge mode and node otherwise', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-win-');

    try {
      const launcherPath = ensureInterpreterCliLauncher('win32');
      expect(launcherPath).toBe(path.join(getInterpreterCliLauncherDir(), 'interpreter-app.cmd'));
      const launcherScript = readFileSync(launcherPath, 'utf8');
      expect(launcherScript).toContain(`echo %${INTERPRETER_CLI_SERVER_CONNECTION_ENV}% | findstr /B /C:"file:" >nul`);
      expect(launcherScript).toContain('where node >nul 2>nul');
      expect(launcherScript).toContain('interpreter-app.cjs');
      expect(launcherScript).toContain('powershell -NoProfile -ExecutionPolicy Bypass');

      const nodeScriptPath = path.join(path.dirname(launcherPath), 'interpreter-app.cjs');
      const nodeScript = readFileSync(nodeScriptPath, 'utf8');
      expect(nodeScript).toContain('/api/interpreter-cli/tools');
      expect(nodeScript).toContain('new URLSearchParams({ saveToDisk })');
      expect(nodeScript).toContain("query.set('saveToDiskPath', saveToDiskPath)");
      expect(nodeScript).toContain('INTERPRETER_CALLER_TOKEN');
      expect(nodeScript).toContain('interpreter-app tools find <query>');
      expect(nodeScript).toContain('interpreter-app tools <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]');
      expect(nodeScript).toContain('interpreter-app mcp <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]');
      expect(nodeScript).toContain('interpreter-app tools <server-id>__<tool-name> --help');
      expect(nodeScript).toContain('interpreter-app tools find "read word docx"');
      expect(nodeScript).toContain('interpreter-app tools builtin-docx read_word --json');
      expect(nodeScript).toContain('Notes.docx');
      expect(nodeScript).toContain('report.xlsx');
      expect(nodeScript).toContain('interpreter-app tools builtin-pdf read_pdf --json');
      expect(nodeScript).toContain('packet.pdf');
      expect(nodeScript).toContain('interpreter-app tools builtin-interpreter interpreter_refresh_file --json');
      expect(nodeScript).toContain('Top-level tools list does not list individual tools.');
      expect(nodeScript).toContain('Many built-in tools live on shared servers such as builtin-interpreter.');
      expect(nodeScript).toContain('interpreter-app config set <path>');
      expect(nodeScript).toContain('interpreter-app config restart-runtime [--reason <text>]');
      expect(nodeScript).toContain('/api/interpreter-cli/config/restart-runtime');
      expect(nodeScript).toContain('Common settings you can change:');
      expect(nodeScript).toContain('theme - Theme');
      expect(nodeScript).toContain('agentAccess.network - Network (needs approval, restart needed)');
      expect(nodeScript).toContain('Current Settings tabs:');
      expect(nodeScript).toContain('Config aliases:');
      expect(nodeScript).toContain('interpreter-app layout get [path]');
      expect(nodeScript).toContain('builtin-interpreter');

      const powershellScriptPath = path.join(path.dirname(launcherPath), 'interpreter-app.ps1');
      expect(existsSync(powershellScriptPath)).toBe(true);
      const powershellScript = readFileSync(powershellScriptPath, 'utf8');
      expect(powershellScript).toContain('interpreter-app config restart-runtime [--reason <text>]');
      expect(powershellScript).toContain('/api/interpreter-cli/config/restart-runtime');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('executes layout get through the Unix launcher wrapper without shell parse errors', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-unix-layout-get-');

    const requests: Array<{
      method?: string;
      url?: string;
      body: string;
      callerToken?: string;
      connection?: string;
    }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          body,
          callerToken: Array.isArray(req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()])
            ? req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()][0]
            : req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()],
          connection: Array.isArray(req.headers.connection)
            ? req.headers.connection[0]
            : req.headers.connection,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"layout":{"tree":{"kind":"tabs"}}}');
      });
    });

    try {
      const launcherPath = ensureInterpreterCliLauncher('darwin');
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected an ephemeral HTTP port for test server.');
      }

      const result = await spawnUnixLauncherProcess(
        launcherPath,
        ['layout', 'get'],
        withServerConnection({
          ...process.env,
          INTERPRETER_HOME: tempHome,
          [INTERPRETER_CALLER_TOKEN_ENV]: 'agtok_layout_get',
        }, address.port, 'http', 'darwin'),
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('{"layout":{"tree":{"kind":"tabs"}}}');

      for (let attempt = 0; attempt < 20 && requests.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request).toEqual({
          method: 'POST',
          url: '/api/interpreter-cli/layout/get',
          body: '{"path":""}',
          callerToken: 'agtok_layout_get',
          connection: undefined,
        });
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('prints non-2xx response bodies for Unix launcher tool discovery requests', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-unix-error-body-');

    const server = createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"Tool server \\"builtin-cells\\" is not available."}');
    });

    try {
      const launcherPath = ensureInterpreterCliLauncher('darwin');
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected an ephemeral HTTP port for test server.');
      }

      const result = await spawnUnixLauncherProcess(
        launcherPath,
        ['tools', 'list', 'builtin-cells'],
        withServerConnection({
          ...process.env,
          INTERPRETER_HOME: tempHome,
          [INTERPRETER_CALLER_TOKEN_ENV]: 'agtok_unix_error_body',
        }, address.port, 'http', 'darwin'),
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('"error":"Tool server \\"builtin-cells\\" is not available."');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('allows zero-argument tool calls in the Windows Node launcher', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-win-node-');

    const requests: Array<{
      method?: string;
      url?: string;
      body: string;
      callerToken?: string;
      connection?: string;
    }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          body,
          callerToken: Array.isArray(req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()])
            ? req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()][0]
            : req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()],
          connection: Array.isArray(req.headers.connection)
            ? req.headers.connection[0]
            : req.headers.connection,
        });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('result {"ok":true}\n');
      });
    });

    try {
      ensureInterpreterCliLauncher('win32');
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected an ephemeral HTTP port for test server.');
      }

      const result = await spawnNodeProcess(
        [path.join(getInterpreterCliLauncherDir(), 'interpreter-app.cjs'), 'tools', 'builtin-mcp-management', 'mcp_list_servers'],
        withServerConnection({
          ...process.env,
          INTERPRETER_HOME: tempHome,
          [INTERPRETER_CALLER_TOKEN_ENV]: 'agtok_test',
        }, address.port, 'http', 'win32'),
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('{"ok":true}');
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/api/interpreter-cli/tools/builtin-mcp-management/mcp_list_servers/stream?saveToDisk=false',
          body: '{}',
          callerToken: 'agtok_test',
          connection: 'close',
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('streams tool progress in the Windows Node launcher', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-win-node-progress-');

    const requests: Array<{
      method?: string;
      url?: string;
      body: string;
      callerToken?: string;
      connection?: string;
    }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          body,
          callerToken: Array.isArray(req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()])
            ? req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()][0]
            : req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()],
          connection: Array.isArray(req.headers.connection)
            ? req.headers.connection[0]
            : req.headers.connection,
        });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.write('progress [MediaAI] phase="queue_submitted" requestId="req_456"\n');
        setTimeout(() => {
          res.write('progress [MediaAI] phase="queue_status" status="IN_PROGRESS"\n');
          res.end('result {"ok":true,"saved":"Movie/output.mp4"}\n');
        }, 20);
      });
    });

    try {
      ensureInterpreterCliLauncher('win32');
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected an ephemeral HTTP port for test server.');
      }

      const result = await spawnNodeProcess(
        [path.join(getInterpreterCliLauncherDir(), 'interpreter-app.cjs'), 'tools', 'builtin-media-ai', 'run_media_model'],
        withServerConnection({
          ...process.env,
          INTERPRETER_HOME: tempHome,
          [INTERPRETER_CALLER_TOKEN_ENV]: 'agtok_node_progress',
        }, address.port, 'http', 'win32'),
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('{"ok":true,"saved":"Movie/output.mp4"}');
      expect(result.stderr).toContain('[MediaAI] phase="queue_submitted" requestId="req_456"');
      expect(result.stderr).toContain('[MediaAI] phase="queue_status" status="IN_PROGRESS"');
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/api/interpreter-cli/tools/builtin-media-ai/run_media_model/stream?saveToDisk=false',
          body: '{}',
          callerToken: 'agtok_node_progress',
          connection: 'close',
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('supports tools find in the Windows Node launcher', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-win-find-');

    const requests: Array<{
      method?: string;
      url?: string;
      body: string;
      callerToken?: string;
      connection?: string;
    }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          body,
          callerToken: Array.isArray(req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()])
            ? req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()][0]
            : req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()],
          connection: Array.isArray(req.headers.connection)
            ? req.headers.connection[0]
            : req.headers.connection,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"matches":[]}');
      });
    });

    try {
      ensureInterpreterCliLauncher('win32');
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected an ephemeral HTTP port for test server.');
      }

      const result = await spawnNodeProcess(
        [path.join(getInterpreterCliLauncherDir(), 'interpreter-app.cjs'), 'tools', 'find', 'interpreter_vault'],
        withServerConnection({
          ...process.env,
          INTERPRETER_HOME: tempHome,
          [INTERPRETER_CALLER_TOKEN_ENV]: 'agtok_find_test',
        }, address.port, 'http', 'win32'),
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('{"matches":[]}');
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/api/interpreter-cli/tools/find',
          body: '{"query":"interpreter_vault"}',
          callerToken: 'agtok_find_test',
          connection: 'close',
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('accepts qualified tool names in the Unix launcher', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-qualified-unix-');

    const requests: Array<{
      method?: string;
      url?: string;
      body: string;
      callerToken?: string;
      connection?: string;
    }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          body,
          callerToken: Array.isArray(req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()])
            ? req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()][0]
            : req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()],
          connection: Array.isArray(req.headers.connection)
            ? req.headers.connection[0]
            : req.headers.connection,
        });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('result {"ok":true}\n');
      });
    });

    try {
      const launcherPath = ensureInterpreterCliLauncher('darwin');
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected an ephemeral HTTP port for test server.');
      }

      const result = await spawnUnixLauncherProcess(
        launcherPath,
        ['tools', 'builtin-pdf__read_pdf', '--json', '{"path":"sample.pdf"}'],
        withServerConnection({
          ...process.env,
          INTERPRETER_HOME: tempHome,
          [INTERPRETER_CALLER_TOKEN_ENV]: 'agtok_qualified_unix',
        }, address.port, 'http', 'darwin'),
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('{"ok":true}');
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/api/interpreter-cli/tools/builtin-pdf/read_pdf/stream?saveToDisk=false',
          body: '{"path":"sample.pdf"}',
          callerToken: 'agtok_qualified_unix',
          connection: undefined,
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('accepts qualified tool names in the Windows Node launcher', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-qualified-win-');

    const requests: Array<{
      method?: string;
      url?: string;
      body: string;
      callerToken?: string;
      connection?: string;
    }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          body,
          callerToken: Array.isArray(req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()])
            ? req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()][0]
            : req.headers[INTERPRETER_CLI_CALLER_TOKEN_HEADER.toLowerCase()],
          connection: Array.isArray(req.headers.connection)
            ? req.headers.connection[0]
            : req.headers.connection,
        });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('result {"ok":true}\n');
      });
    });

    try {
      ensureInterpreterCliLauncher('win32');
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected an ephemeral HTTP port for test server.');
      }

      const result = await spawnNodeProcess(
        [
          path.join(getInterpreterCliLauncherDir(), 'interpreter-app.cjs'),
          'tools',
          'builtin-pdf__read_pdf',
          '--json',
          '{"path":"sample.pdf"}',
        ],
        withServerConnection({
          ...process.env,
          INTERPRETER_HOME: tempHome,
          [INTERPRETER_CALLER_TOKEN_ENV]: 'agtok_qualified_win',
        }, address.port, 'http', 'win32'),
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('{"ok":true}');
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/api/interpreter-cli/tools/builtin-pdf/read_pdf/stream?saveToDisk=false',
          body: '{"path":"sample.pdf"}',
          callerToken: 'agtok_qualified_win',
          connection: 'close',
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('writes a Windows PowerShell fallback that safely interpolates toolName before query params', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-win-ps-');

    try {
      const launcherPath = ensureInterpreterCliLauncher('win32');
      const powershellScriptPath = path.join(path.dirname(launcherPath), 'interpreter-app.ps1');
      const powershellScript = readFileSync(powershellScriptPath, 'utf8');

      expect(powershellScript).toContain(
        'Invoke-InterpreterCliToolStream "$transportTarget/api/interpreter-cli/tools/$serverId/$($toolName)/stream?$query" $argsJson',
      );
      expect(powershellScript).toContain("} elseif ($serverConnection.StartsWith('file:')) {");
      expect(powershellScript).toContain('Invoke-InterpreterCliFileBridgeFields $transportTarget @{');
      expect(powershellScript).toContain('[System.Text.UTF8Encoding]::new($false)');
      expect(powershellScript).toContain("kind = 'call'");
      expect(powershellScript).toContain("'args.json' = $argsJson");
      expect(powershellScript).toContain("'save-to-disk' = $saveToDisk");
      expect(powershellScript).toContain('$query = "saveToDisk=$saveToDisk"');
      expect(powershellScript).toContain('$query = "$query&saveToDiskPath=$([uri]::EscapeDataString($saveToDiskPath))"');
      expect(powershellScript).not.toContain('/$toolName?saveToDisk=');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('builds server connections for explicit and default transports', () => {
    expect(buildInterpreterCliServerConnection(5517, { transport: 'http', platform: 'darwin' })).toBe(
      'http:http://127.0.0.1:5517',
    );
    expect(buildInterpreterCliServerConnection(5517, { transport: 'file', platform: 'darwin' })).toBe(
      `file:${getInterpreterCliBridgeDir(5517, 'darwin')}`,
    );
    expect(buildInterpreterCliServerConnection(5517)).toBe(
      process.platform === 'win32'
        ? 'http:http://127.0.0.1:5517'
        : `unix:${getInterpreterCliSocketPath(5517)}`,
    );
  });

  test('builds shell environment policy with caller token and launcher path', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-env-');

    try {
      const codexHome = path.join(tempHome, 'codex-home');
      const shellHome = path.join(codexHome, 'home');
      const policy = buildInterpreterCliShellEnvironmentPolicy(
        'agtok_123',
        { PATH: '/usr/bin:/bin', CODEX_HOME: codexHome },
        'darwin',
        undefined,
        undefined,
        null,
      );

      expect(policy.inherit).toBe('core');
      expect(policy.set.INTERPRETER_CALLER_TOKEN).toBe('agtok_123');
      expect(policy.set[INTERPRETER_CLI_PATH_ENV]).toBe(getInterpreterCliShellSafeExecutablePath('darwin', shellHome));
      expect(policy.set.PATH).toBe(`${getInterpreterCliShellSafeLauncherDir('darwin', shellHome)}:/usr/bin:/bin`);
      expect(policy.ignore_default_excludes).toBeUndefined();
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('exposes Unix shell runtime as a macOS sandbox readable root', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-readable-root-');

    try {
      const codexHome = path.join(tempHome, 'codex-home');
      const shellHome = path.join(codexHome, 'home');

      expect(getInterpreterCliShellSandboxReadableRoots('darwin', { CODEX_HOME: codexHome })).toEqual([
        path.join(shellHome, '.interpreter', 'runtime', 'interpreter-cli'),
      ]);
      expect(getInterpreterCliShellSandboxReadableRoots('linux', { CODEX_HOME: codexHome })).toEqual([]);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('builds shell environment policy inside INTERPRETER_USER_DATA_DIR when CODEX_HOME is unset', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-user-data-env-');

    try {
      const tempUserDataDir = path.join(tempHome, 'interpreter-user-data');
      const codexHome = path.join(tempUserDataDir, 'codex-home');
      const shellHome = path.join(codexHome, 'home');
      const policy = buildInterpreterCliShellEnvironmentPolicy(
        'agtok_user_data',
        { PATH: '/usr/bin:/bin', INTERPRETER_USER_DATA_DIR: tempUserDataDir },
        'darwin',
        undefined,
        undefined,
        null,
      );

      expect(policy.inherit).toBe('core');
      expect(policy.set.INTERPRETER_CALLER_TOKEN).toBe('agtok_user_data');
      expect(policy.set[INTERPRETER_CLI_PATH_ENV]).toBe(getInterpreterCliShellSafeExecutablePath('darwin', shellHome));
      expect(policy.set.PATH).toBe(`${getInterpreterCliShellSafeLauncherDir('darwin', shellHome)}:/usr/bin:/bin`);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('adds bundled pdfcpu directory to shell command PATH policy', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-pdfcpu-env-');

    try {
      const codexHome = path.join(tempHome, 'codex-home');
      const shellHome = path.join(codexHome, 'home');
      const pdfcpuDir = '/Applications/Interpreter.app/Contents/Resources/pdfcpu';
      const policy = buildInterpreterCliShellEnvironmentPolicy(
        'agtok_pdfcpu',
        { PATH: '/usr/bin:/bin', CODEX_HOME: codexHome },
        'darwin',
        undefined,
        undefined,
        pdfcpuDir,
      );

      expect(policy.set.PATH).toBe(
        `${getInterpreterCliShellSafeLauncherDir('darwin', shellHome)}:${pdfcpuDir}:/usr/bin:/bin`,
      );
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('does not write shell bootstrap artifacts into the agent workspace', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-workspace-env-');
    const workspace = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-workspace-'));

    try {
      const codexHome = path.join(tempHome, 'codex-home');
      const shellHome = path.join(codexHome, 'home');
      const serverConnection = buildInterpreterCliServerConnection(5177, {
        platform: 'darwin',
        transport: 'http',
      });
      const policy = buildInterpreterCliShellEnvironmentPolicy(
        'agtok_workspace',
        { PATH: '/usr/bin:/bin', CODEX_HOME: codexHome },
        'darwin',
        workspace,
        serverConnection,
        null,
      );

      expect(policy.set.INTERPRETER_CALLER_TOKEN).toBe('agtok_workspace');
      expect(policy.set[INTERPRETER_CLI_SERVER_CONNECTION_ENV]).toBe(serverConnection);
      expect(policy.set[INTERPRETER_CLI_PATH_ENV]).toBe(
        getInterpreterCliShellSafeExecutablePath('darwin', shellHome),
      );
      expect(policy.set.PATH).toBe(
        `${getInterpreterCliShellSafeLauncherDir('darwin', shellHome)}:/usr/bin:/bin`,
      );
      expect(policy.set.ZDOTDIR).toBe(
        path.join(shellHome, '.interpreter', 'runtime', 'interpreter-cli', 'shell-init'),
      );

      expect(existsSync(path.join(workspace, '.interpreter'))).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('inherits the full environment for machine-run shells', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-machine-env-');

    try {
      const codexHome = path.join(tempHome, 'codex-home');
      const shellHome = path.join(codexHome, 'home');
      const policy = buildInterpreterCliShellEnvironmentPolicy(
        'agtok_machine',
        {
          PATH: '/usr/bin:/bin',
          DISPLAY: ':99',
          CODEX_HOME: codexHome,
          INTERPRETER_MACHINE_RUN_DIR: '/tmp/machine-run',
          OPENAI_API_KEY: 'sk-test',
        },
        'linux',
        undefined,
        undefined,
        null,
      );

      expect(policy.inherit).toBe('all');
      expect(policy.ignore_default_excludes).toBeUndefined();
      expect(policy.set.INTERPRETER_CALLER_TOKEN).toBe('agtok_machine');
      expect(policy.set.PATH).toBe(`${getInterpreterCliShellSafeLauncherDir('linux', shellHome)}:/usr/bin:/bin`);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('preserves Windows core environment values in shell policy', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-win-env-');

    try {
      const policy = buildInterpreterCliShellEnvironmentPolicy(
        'agtok_windows',
        {
          Path: 'C:\\Windows\\System32;C:\\Windows',
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          USERPROFILE: 'C:\\Users\\interpreter-user',
          TEMP: 'C:\\Users\\interpreter-user\\AppData\\Local\\Temp',
        },
        'win32',
        undefined,
        undefined,
        null,
      );

      expect(policy.set.Path).toContain(getInterpreterCliShellSafeLauncherDir('win32'));
      expect(policy.set.SystemRoot).toBe('C:\\Windows');
      expect(policy.set.ComSpec).toBe('C:\\Windows\\System32\\cmd.exe');
      expect(policy.set.USERPROFILE).toBe('C:\\Users\\interpreter-user');
      expect(policy.set.TEMP).toBe('C:\\Users\\interpreter-user\\AppData\\Local\\Temp');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('materializes the shell launcher on disk without mutating the caller environment', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-proc-env-');

    try {
      const codexHome = path.join(tempHome, 'codex-home');
      const shellHome = path.join(codexHome, 'home');
      const buildEnv = (platform: NodeJS.Platform): NodeJS.ProcessEnv => {
        if (platform === 'win32') {
          return {
            Path: 'C:\\Windows\\System32;C:\\Windows',
            SystemRoot: 'C:\\Windows',
            ComSpec: 'C:\\Windows\\System32\\cmd.exe',
            CODEX_HOME: codexHome,
          };
        }
        return {
          PATH: '/usr/bin:/bin',
          CODEX_HOME: codexHome,
        };
      };

      for (const platform of ['darwin', 'win32'] as const) {
        const env = buildEnv(platform);
        const envSnapshot = { ...env };
        const launcherPath = materializeInterpreterCliLauncher(env, platform);

        expect(launcherPath).toBe(getInterpreterCliShellSafeExecutablePath(platform, shellHome));
        expect(env).toEqual(envSnapshot);
        expect(existsSync(launcherPath)).toBe(true);

        const launcherScript = readFileSync(launcherPath, 'utf8');
        if (platform === 'win32') {
          expect(launcherScript).toContain('interpreter-app.cjs');
          expect(launcherScript).toContain('interpreter-app.ps1');
        } else {
          expect(launcherScript).toContain('/api/interpreter-cli/tools');
          expect(launcherScript).not.toContain(getInterpreterCliExecutablePath(platform));
        }
      }
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('does not mutate process.env when materializing the shell launcher', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-no-mutate-');

    const originalCliPath = process.env[INTERPRETER_CLI_PATH_ENV];
    const originalConnection = process.env[INTERPRETER_CLI_SERVER_CONNECTION_ENV];
    const originalZdot = process.env.ZDOTDIR;
    const originalBashEnv = process.env.BASH_ENV;
    const originalEnv = process.env.ENV;
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const originalPath = process.env[pathKey];

    try {
      materializeInterpreterCliLauncher();

      expect(process.env[INTERPRETER_CLI_PATH_ENV]).toBe(originalCliPath);
      expect(process.env[INTERPRETER_CLI_SERVER_CONNECTION_ENV]).toBe(originalConnection);
      expect(process.env.ZDOTDIR).toBe(originalZdot);
      expect(process.env.BASH_ENV).toBe(originalBashEnv);
      expect(process.env.ENV).toBe(originalEnv);
      expect(process.env[pathKey]).toBe(originalPath);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('uses the shell environment server connection for tool discovery', async () => {
    const tempHome = await useTempInterpreterDataDir('interpreter-cli-env-override-');

    const currentPlatform: NodeJS.Platform = process.platform === 'win32' ? 'win32' : 'darwin';
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/interpreter-cli/tools') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[{"id":"builtin-interpreter","name":"Interpreter"}]');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });

    try {
      const address = await new Promise<{ port: number }>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const value = server.address();
          if (!value || typeof value === 'string') {
            reject(new Error('Failed to determine interpreter CLI test server address.'));
            return;
          }
          resolve({ port: value.port });
        });
      });

      const serverConnection = buildInterpreterCliServerConnection(address.port, {
        platform: currentPlatform,
        transport: 'http',
      });
      const env: NodeJS.ProcessEnv = currentPlatform === 'win32'
        ? {
          ...process.env,
          Path: process.env.Path ?? process.env.PATH ?? 'C:\\Windows\\System32;C:\\Windows',
          SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
          ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe',
          PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
        }
        : { PATH: '/usr/bin:/bin' };
      env[INTERPRETER_CALLER_TOKEN_ENV] = 'agtok_env_override';
      env[INTERPRETER_CLI_SERVER_CONNECTION_ENV] = serverConnection;
      const launcherPath = materializeInterpreterCliLauncher(env, currentPlatform);
      expect(env[INTERPRETER_CLI_SERVER_CONNECTION_ENV]).toBe(serverConnection);

      const result = await spawnLauncherProcess(launcherPath, ['tools', 'list'], env, currentPlatform);

      if (result.status !== 0) {
        throw new Error(
          `Expected launcher to exit 0, got ${String(result.status)}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      expect(result.stdout).toContain('builtin-interpreter');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});
