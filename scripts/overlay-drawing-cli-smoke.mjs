#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const TARGET_WINDOW = Object.freeze({ x: 160, y: 180, width: 420, height: 260 });
const TARGET_BUTTON = Object.freeze({ x: 118, y: 82, width: 184, height: 84 });

function parseArgs(argv) {
  const args = {
    port: Number(process.env.INTERPRETER_OVERLAY_DEBUG_PORT || process.env.FORM_TESTS_DEBUG_PORT || 9877),
    token: process.env.INTERPRETER_OVERLAY_DEBUG_TOKEN || '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      args.port = Number(argv[++index]);
    } else if (arg === '--token') {
      args.token = argv[++index] || '';
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.port) || args.port <= 0) {
    throw new Error('Debug port must be a positive number.');
  }
  if (!args.token) {
    throw new Error('Missing debug token. Set INTERPRETER_OVERLAY_DEBUG_TOKEN or pass --token.');
  }
  return args;
}

function postDebugCommand(port, token, command, params = {}) {
  const body = JSON.stringify({ command, params });
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/command',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-interpreter-debug-token': token,
      },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => {
        text += chunk.toString();
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Debug command ${command} failed status=${response.statusCode} body=${text}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(new Error(`Debug command ${command} returned invalid JSON: ${error instanceof Error ? error.message : String(error)} body=${text}`));
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(10_000, () => {
      request.destroy(new Error(`Debug command ${command} timed out.`));
    });
    request.write(body);
    request.end();
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(label, callback, { timeoutMs = 5_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(intervalMs);
  }
  throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

async function callOverlayTool(session, toolName, args) {
  const env = {
    ...process.env,
    INTERPRETER_CLI_SERVER_CONNECTION: session.interpreterCliServerConnection,
    INTERPRETER_CALLER_TOKEN: session.callerToken,
  };
  console.log(`[overlay-drawing-cli-smoke] interpreter-app tools builtin-interpreter-overlay ${toolName} --json '${JSON.stringify(args)}'`);
  const { stdout, stderr } = await execFileAsync(session.interpreterCliPath, [
    'tools',
    'builtin-interpreter-overlay',
    toolName,
    '--json',
    JSON.stringify(args),
  ], {
    cwd: process.cwd(),
    env,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  if (parsed.isError) {
    throw new Error(`${toolName} returned isError=true stdout=${stdout} stderr=${stderr}`);
  }
  return parsed;
}

function getElectronBinaryPath() {
  const electronPath = require('electron');
  if (typeof electronPath !== 'string' || electronPath.length === 0) {
    throw new Error('Could not resolve Electron binary for drawing click-through target.');
  }
  return electronPath;
}

function startHttpServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Target HTTP server did not expose a TCP port.'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

async function startClickThroughTarget() {
  let clickCount = 0;
  const { server, port } = await startHttpServer((request, response) => {
    if (request.url?.startsWith('/clicked')) {
      clickCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === '/state') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ clickCount }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interpreter-overlay-drawing-target-'));
  const mainPath = path.join(tmpDir, 'main.cjs');
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #f8fafc; font-family: system-ui, sans-serif; }
      #target { position: absolute; left: ${TARGET_BUTTON.x}px; top: ${TARGET_BUTTON.y}px; width: ${TARGET_BUTTON.width}px; height: ${TARGET_BUTTON.height}px; border: 2px solid #0f172a; background: #dbeafe; color: #0f172a; font: 18px system-ui, sans-serif; }
      #status { position: absolute; left: 24px; top: 24px; font: 14px system-ui, sans-serif; color: #334155; }
    </style>
  </head>
  <body>
    <div id="status">Waiting for drawing click-through</div>
    <button id="target">Click target</button>
    <script>
      let clicks = 0;
      document.getElementById('target').addEventListener('click', (event) => {
        clicks += 1;
        document.getElementById('status').textContent = 'clicks=' + clicks;
        const img = new Image();
        img.src = 'http://127.0.0.1:${port}/clicked?x=' + Math.round(event.clientX) + '&y=' + Math.round(event.clientY) + '&n=' + clicks;
      });
    </script>
  </body>
</html>`;
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  await fs.writeFile(mainPath, `
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    x: ${TARGET_WINDOW.x},
    y: ${TARGET_WINDOW.y},
    width: ${TARGET_WINDOW.width},
    height: ${TARGET_WINDOW.height},
    frame: false,
    resizable: false,
    movable: false,
    show: true,
    alwaysOnTop: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadURL(${JSON.stringify(dataUrl)});
  console.log(JSON.stringify({ event: 'ready', bounds: ${JSON.stringify(TARGET_WINDOW)}, button: ${JSON.stringify(TARGET_BUTTON)} }));
});
app.on('window-all-closed', () => app.quit());
`, 'utf8');

  const electronPath = getElectronBinaryPath();
  const child = spawn(electronPath, [mainPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  });

  const ready = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for drawing click-through target. stdout=${stdout} stderr=${stderr}`));
    }, 10_000);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.event === 'ready') {
            clearTimeout(timeout);
            resolve(parsed);
          }
        } catch {
          // Ignore non-JSON Electron startup output.
        }
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Drawing click-through target exited early code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`));
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  const readyPayload = await ready;
  child.removeAllListeners('exit');
  child.removeAllListeners('error');

  return {
    bounds: readyPayload.bounds,
    button: readyPayload.button,
    getClickCount: () => clickCount,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, 2_000);
      });
      server.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

async function clickScreenPoint(point) {
  const cliclickPath = process.env.INTERPRETER_SCENARIO_CLICLICK_PATH || 'cliclick';
  const rounded = `${Math.round(point.x)},${Math.round(point.y)}`;
  await execFileAsync(cliclickPath, [`m:${rounded}`, 'w:140', `dd:${rounded}`, 'w:90', `du:${rounded}`, 'w:160'], {
    timeout: 15_000,
  });
}

function requireDrawingState(payload, label) {
  const state = payload?.overlayState;
  const action = state?.action;
  if (!action || typeof action.id !== 'string' || !action.id.startsWith('overlay-drawing-')) {
    throw new Error(`${label}: expected active overlay drawing action, got ${JSON.stringify({
      mode: state?.mode,
      action,
      ghosts: state?.ghosts,
    })}`);
  }
  return state;
}

function requireScreenshotReference(toolResult) {
  const text = toolResult?.content?.find((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string' || !text.includes('Captured a fresh screenshot') || !text.includes('@[')) {
    throw new Error(`overlay_screenshot did not return a saved screenshot reference: ${JSON.stringify(toolResult)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const session = await postDebugCommand(args.port, args.token, 'createAttachedOverlayCliSession', {
    agentId: 'overlay-drawing-cli-smoke-agent',
    callerToken: 'agtok_overlay_drawing_cli_smoke',
    workspacePath: process.cwd(),
  });
  console.log(`[overlay-drawing-cli-smoke] session=${session.session.id}`);
  let target = null;

  try {
    const screenshot = await callOverlayTool(session, 'overlay_screenshot', {});
    requireScreenshotReference(screenshot);

    target = await startClickThroughTarget();
    const annotation = {
      id: 'click-through-target',
      label: 'Click through',
      x: target.bounds.x + target.button.x,
      y: target.bounds.y + target.button.y,
      width: target.button.width,
      height: target.button.height,
    };
    await callOverlayTool(session, 'overlay_show_drawings', {
      annotations: [annotation],
    });
    const clickThroughDrawing = await postDebugCommand(args.port, args.token, 'getOverlayState');
    requireDrawingState(clickThroughDrawing, 'after click-through overlay_show_drawings');

    await clickScreenPoint({
      x: annotation.x + (annotation.width / 2),
      y: annotation.y + (annotation.height / 2),
    });
    await waitFor('target-side drawing click-through', () => target.getClickCount() > 0);
    await waitFor('drawing clear after click-through', async () => {
      const state = await postDebugCommand(args.port, args.token, 'getOverlayState');
      return state?.overlayState?.action === null && (state?.overlayState?.ghosts ?? []).length === 0;
    });
    console.log('[overlay-drawing-cli-smoke] drawing click-through reached target and cleared overlay drawing');

    await callOverlayTool(session, 'overlay_show_drawings', {
      annotations: [{
        id: 'smoke-box',
        label: 'Smoke',
        x: 64,
        y: 64,
        width: 180,
        height: 72,
      }],
    });
    const drawn = await postDebugCommand(args.port, args.token, 'getOverlayState');
    requireDrawingState(drawn, 'after overlay_show_drawings');

    await callOverlayTool(session, 'overlay_clear_drawings', {});
    const cleared = await postDebugCommand(args.port, args.token, 'getOverlayState');
    if (cleared?.overlayState?.action !== null || (cleared?.overlayState?.ghosts ?? []).length !== 0) {
      throw new Error(`Expected cleared drawing state, got ${JSON.stringify(cleared?.overlayState)}`);
    }

    console.log('[overlay-drawing-cli-smoke] passed');
  } finally {
    await postDebugCommand(args.port, args.token, 'detachOverlaySession', {
      agentId: session.agentId,
    }).catch((error) => {
      console.warn(`[overlay-drawing-cli-smoke] detach failed: ${error.message}`);
    });
    await postDebugCommand(args.port, args.token, 'forceResetOverlay', {
      reason: 'overlay_drawing_cli_smoke_cleanup',
    }).catch((error) => {
      console.warn(`[overlay-drawing-cli-smoke] force reset failed: ${error.message}`);
    });
    if (target) {
      await target.stop().catch((error) => {
        console.warn(`[overlay-drawing-cli-smoke] target cleanup failed: ${error.message}`);
      });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
