import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type AgentTaskResult = {
  completed?: boolean;
  error?: string;
  threadId?: string;
};

type SubmittedState = {
  name?: string;
  email?: string;
  subscribed?: boolean;
  notes?: string;
  status?: string;
};

const MODEL = process.env.MAC_CUA_AGENT_MODEL?.trim() || 'gpt-5.4';
const AGENT_TIMEOUT_MS = Number(process.env.MAC_CUA_AGENT_TIMEOUT_MS || 420_000);

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('macos-cua-agent-chrome-web-form-smoke must run on macOS.');
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error('OPENAI_API_KEY is required for the live macOS CUA agent web smoke.');
  }

  const runDir = path.join(os.tmpdir(), `interpreter-desktop-driver-agent-web-${Date.now()}-${process.pid}`);
  const homeDir = path.join(runDir, 'home');
  await mkdir(runDir, { recursive: true });

  let submitted: SubmittedState | null = null;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderFormHtml());
      return;
    }
    if (req.method === 'POST' && req.url === '/submit') {
      const body = await readRequestBody(req);
      submitted = JSON.parse(body) as SubmittedState;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  try {
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/`;
    const messageFile = path.join(runDir, 'task.message.txt');
    const resultFile = path.join(runDir, 'task.result.json');
    await writeFile(messageFile, [
      'Use $computer-use.',
      `Open Google Chrome to ${url} using builtin-cua-driver launch_app, not shell open.`,
      'This is a browser-rendered web app, so follow the computer-use WEB_APPS.md routing.',
      'Use the normal-user Chrome route: browser-control if the tab is shared, otherwise builtin-cua-driver get_app_state plus app-scoped click/type_text against Google Chrome.',
      'Fill the form with name "Ada Web", email "ada.web@example.com", check Subscribe, notes "Chrome background CUA route", and click Save.',
      'Do not use curl, fetch from Node, Python requests, direct HTTP POSTs, or any non-browser shortcut to submit the form.',
      'Finish only after the page visibly reports Saved.',
    ].join(' '), 'utf8');

    const { stdout, stderr } = await runChild('pnpm', [
      'exec',
      'tsx',
      'server/standalone.ts',
      '--port',
      'auto',
      '--message-file',
      messageFile,
      '--shutdown-after-task',
      '--stream-jsonl',
      '--quiet-startup',
      '--workspace',
      process.cwd(),
      '--home',
      homeDir,
      '--result-file',
      resultFile,
      '--profile-id',
      'mac-cua-agent-chrome-web-form-smoke',
      '--profile-name',
      'macOS CUA Agent Chrome Web Form Smoke',
      '--model',
      MODEL,
      '--openai-api-key-env',
      'OPENAI_API_KEY',
      '--approval-policy',
      'never',
      '--sandbox',
      'danger-full-access',
      '--network-access',
      '--timeout-ms',
      String(AGENT_TIMEOUT_MS),
      '--skill',
      'computer-use',
    ], {
      ...process.env,
      INTERPRETER_MACHINE_RUN_DIR: runDir,
    }, AGENT_TIMEOUT_MS + 60_000);

    const result = JSON.parse(await readFile(resultFile, 'utf8')) as AgentTaskResult;
    if (!result.completed) {
      throw new Error(`agent did not complete web form task: ${JSON.stringify(result)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    assertAgentUsedCua(stdout);
    assertAgentDidNotUseForbiddenShortcut(stdout);

    await waitFor(() => {
      if (!submitted) {
        throw new Error('form has not been submitted yet');
      }
      const expected: SubmittedState = {
        name: 'Ada Web',
        email: 'ada.web@example.com',
        subscribed: true,
        notes: 'Chrome background CUA route',
        status: 'saved',
      };
      for (const [key, value] of Object.entries(expected)) {
        if ((submitted as Record<string, unknown>)[key] !== value) {
          throw new Error(`expected ${key}=${JSON.stringify(value)}, got ${JSON.stringify((submitted as Record<string, unknown>)[key])}; submitted=${JSON.stringify(submitted)}`);
        }
      }
    }, 15_000, 'web form submission');

    console.log('macOS CUA live agent Chrome web form smoke passed.');
  } finally {
    server.close();
    await rm(runDir, { recursive: true, force: true });
  }
}

function renderFormHtml(): string {
  return String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Interpreter Computer Use Agent Chrome Web Form Smoke</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; margin: 40px; color: #161616; }
    main { max-width: 520px; }
    label { display: block; margin: 18px 0; font-size: 16px; }
    input[type="text"], input[type="email"], textarea { display: block; width: 100%; margin-top: 6px; font-size: 16px; padding: 8px; }
    button { font-size: 16px; padding: 8px 14px; }
    #status { margin-top: 18px; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>Interpreter Computer Use Agent Chrome Web Form Smoke</h1>
    <label>Name <input id="name" name="name" type="text" autocomplete="off"></label>
    <label>Email <input id="email" name="email" type="email" autocomplete="off"></label>
    <label><input id="subscribed" name="subscribed" type="checkbox"> Subscribe</label>
    <label>Notes <textarea id="notes" name="notes" rows="4"></textarea></label>
    <button id="save" type="button">Save</button>
    <p id="status">Ready</p>
  </main>
  <script>
    document.querySelector("#save").addEventListener("click", async () => {
      const payload = {
        name: document.querySelector("#name").value,
        email: document.querySelector("#email").value,
        subscribed: document.querySelector("#subscribed").checked,
        notes: document.querySelector("#notes").value,
        status: "saved"
      };
      const response = await fetch("/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      document.querySelector("#status").textContent = response.ok ? "Saved" : "Save failed";
    });
  </script>
</body>
</html>`;
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function listen(server: http.Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error(`unexpected server address: ${JSON.stringify(address)}`));
        return;
      }
      resolve(address.port);
    });
  });
}

async function runChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited code=${code} signal=${signal ?? 'none'}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

function assertAgentUsedCua(stdout: string): void {
  if (!stdout.includes('computer-use') && !stdout.includes('builtin-cua-driver')) {
    throw new Error('agent progress did not show computer-use or builtin-cua-driver usage.');
  }
  if (!stdout.includes('tools builtin-cua-driver')) {
    throw new Error('agent progress did not show interpreter-app CLI builtin-cua-driver usage.');
  }
  if (!stdout.includes('tools builtin-cua-driver launch_app')) {
    throw new Error('agent did not launch Chrome through builtin-cua-driver launch_app.');
  }
}

function assertAgentDidNotUseForbiddenShortcut(stdout: string): void {
  const forbidden = [
    'curl ',
    'requests.',
    'fetch("http://127.0.0.1',
    "fetch('http://127.0.0.1",
    'tools builtin-cua-driver page',
  ];
  const commands = extractExecutedCommands(stdout);
  for (const command of commands) {
    const hit = forbidden.find((needle) => command.includes(needle));
    if (hit) {
      throw new Error(`agent appeared to use forbidden non-browser shortcut: ${hit}\ncommand: ${command}`);
    }
  }
}

function extractExecutedCommands(stdout: string): string[] {
  const commands: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/\bcommand="((?:\\"|[^"])*)"/);
    if (!match) {
      continue;
    }
    commands.push(match[1].replace(/\\"/g, '"'));
  }
  return commands;
}

async function waitFor(fn: () => void, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      fn();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
