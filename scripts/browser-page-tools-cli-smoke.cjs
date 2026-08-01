#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'browser-form-tests', 'test-output');
const RELAY_BASE_URL = 'http://127.0.0.1:19988';
const EXPECTED_VALUES = {
  name: 'Avery Browser Smoke',
  team: 'Operations',
  notes: 'Browser page tools CLI smoke completed through Interpreter.',
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function getBunCommand() {
  return process.platform === 'win32' ? 'bun.exe' : 'bun';
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    skipSetup: false,
    browserHeadless: false,
    keepBrowser: false,
    negative: false,
  };

  for (const arg of args) {
    if (arg === '--') {
      continue;
    }
    if (arg === '--skip-setup') {
      options.skipSetup = true;
    } else if (arg === '--browser-headless') {
      options.browserHeadless = true;
    } else if (arg === '--keep-browser') {
      options.keepBrowser = true;
    } else if (arg === '--negative') {
      options.negative = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/browser-page-tools-cli-smoke.cjs [--skip-setup] [--browser-headless] [--keep-browser] [--negative]`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function buildChildProcessEnv(extraEnv = {}) {
  const merged = { ...process.env, ...extraEnv };
  if (process.platform !== 'win32') {
    return merged;
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(merged)) {
    if (!key || key.startsWith('=') || value === undefined) continue;
    sanitized[key.toUpperCase()] = String(value);
  }
  return sanitized;
}

function runCommand(options) {
  const {
    command,
    args,
    cwd = REPO_ROOT,
    env,
    logPath,
    input,
    waitForExit = true,
    allowNonZeroExit = false,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: buildChildProcessEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    });

    let stdout = '';
    let stderr = '';
    const logStream = logPath ? fs.createWriteStream(logPath, { flags: 'w' }) : null;
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      logStream?.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logStream?.write(text);
    });
    child.on('error', (error) => {
      logStream?.end();
      reject(error);
    });
    child.on('close', (code) => {
      logStream?.end();
      if (!waitForExit) return;
      if (code !== 0 && !allowNonZeroExit) {
        reject(new Error(`Command failed (${command} ${args.join(' ')}): exit ${code}\n${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });

    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }

    if (!waitForExit) {
      resolve({ child, stdout: '', stderr: '' });
    }
  });
}

async function stopBackgroundProcess(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

function renderSmokePage(baseUrl) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Browser Page Tools CLI Smoke</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 32px; }
      label { display: block; margin: 18px 0; }
      input, select, textarea, button { display: block; font: inherit; margin-top: 8px; padding: 10px; width: 360px; }
      textarea { height: 96px; }
      .spacer { height: 900px; border: 1px dashed #aaa; margin: 28px 0; }
      #result { min-height: 24px; font-weight: 700; }
    </style>
  </head>
  <body>
    <h1>Browser Page Tools CLI Smoke</h1>
    <form id="smoke-form">
      <label>Smoke name
        <input id="smoke-name" name="name" aria-label="Smoke name" autocomplete="off" />
      </label>
      <label>Smoke team
        <select id="smoke-team" name="team" aria-label="Smoke team">
          <option value="">Choose one</option>
          <option value="Engineering">Engineering</option>
          <option value="Operations">Operations</option>
        </select>
      </label>
      <label>Smoke notes
        <textarea id="smoke-notes" name="notes" aria-label="Smoke notes"></textarea>
      </label>
      <div class="spacer" aria-label="Scroll proof spacer">Scroll proof spacer</div>
      <button id="smoke-submit" type="submit">Save Smoke</button>
    </form>
    <div id="result"></div>
    <script>
      const send = (event) => {
        fetch(${JSON.stringify(`${baseUrl}/api/event`)}, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event, at: Date.now(), scrollY: window.scrollY }),
          keepalive: true,
        }).catch(() => {});
      };
      for (const id of ['smoke-name', 'smoke-team', 'smoke-notes', 'smoke-submit']) {
        const node = document.getElementById(id);
        node.addEventListener('input', () => send({ type: 'input', id, value: node.value || '' }));
        node.addEventListener('change', () => send({ type: 'change', id, value: node.value || '' }));
        node.addEventListener('click', () => send({ type: 'click', id, value: node.value || '' }));
      }
      window.addEventListener('scroll', () => send({ type: 'scroll' }), { passive: true });
      document.getElementById('smoke-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget).entries());
        send({ type: 'submit', values });
        const response = await fetch(${JSON.stringify(`${baseUrl}/api/submit`)}, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values, scrollY: window.scrollY }),
        });
        if (!response.ok) throw new Error('submit failed');
        document.getElementById('result').textContent = 'Saved through browser page tools';
      });
    </script>
  </body>
</html>`;
}

function createSmokeServer() {
  const state = {
    events: [],
    submission: null,
  };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && requestUrl.pathname === '/') {
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderSmokePage(baseUrl));
      return;
    }
    if (req.method === 'GET' && requestUrl.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(state));
      return;
    }
    if (req.method === 'POST' && (requestUrl.pathname === '/api/event' || requestUrl.pathname === '/api/submit')) {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (requestUrl.pathname === '/api/submit') {
          state.submission = { ...body, at: new Date().toISOString() };
        } else {
          state.events.push(body);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return {
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      return {
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
      };
    },
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

function writeBrowserPolicy(homeDir, serverPort, permissionModes = {}) {
  ensureDir(homeDir);
  const allowedPatterns = [
    `127.0.0.1:${serverPort}/*`,
    `localhost:${serverPort}/*`,
  ];
  const modeFor = (permission) => permissionModes[permission] || 'allowList';
  const ruleFor = (permission) => {
    const mode = modeFor(permission);
    return { mode, allowedPatterns: mode === 'allowList' ? allowedPatterns : [] };
  };
  fs.writeFileSync(
    path.join(homeDir, 'config.json'),
    JSON.stringify({
      agents: {},
      browserAccessPolicy: {
        permissions: {
          read: ruleFor('read'),
          write: ruleFor('write'),
          action: ruleFor('action'),
        },
        profilePolicies: [],
      },
    }, null, 2),
    'utf8',
  );
}

async function prepareEnvironment(runDir) {
  await runCommand({
    command: getPnpmCommand(),
    args: ['run', 'ensure:browser-extension-relay-assets'],
    logPath: path.join(runDir, 'setup-browser-extension-relay.log'),
  });
}

async function startStandalone(runDir, serverPort, permissionModes = {}) {
  const homeDir = path.join(runDir, 'interpreter-home');
  writeBrowserPolicy(homeDir, serverPort, permissionModes);

  return new Promise((resolve, reject) => {
    const child = spawn(getBunCommand(), [
      'server/standalone.ts',
      '--home',
      homeDir,
      '--workspace',
      REPO_ROOT,
      '--port',
      'auto',
      '--dev-auto-approve-tools',
      '--quiet-startup',
      '--stream-jsonl',
    ], {
      cwd: REPO_ROOT,
      env: buildChildProcessEnv({
        LOG_FILE: path.join(runDir, 'standalone-server.log'),
        INTERPRETER_ENABLE_HEADLESS_BROWSER_TOOLS: '1',
        PLAYWRITER_AUTO_ENABLE: '1',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const logStream = fs.createWriteStream(path.join(runDir, 'standalone.log'), { flags: 'w' });
    let ready = false;
    let stdoutBuffer = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      if (!ready) {
        reject(new Error(`Timed out waiting for standalone server readiness. Stderr:\n${stderr}`));
      }
    }, 30000);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      logStream.write(text);
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const payload = JSON.parse(line);
          if (payload.type === 'server_ready') {
            ready = true;
            clearTimeout(timeout);
            resolve({ child, homeDir, ...payload });
          }
        } catch {}
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logStream.write(text);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      logStream.end();
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      logStream.end();
      if (!ready) {
        reject(new Error(`Standalone server exited before readiness with code ${code}. Stderr:\n${stderr}`));
      }
    });
  });
}

async function waitForRelayReady(runDir, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${RELAY_BASE_URL}/version`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        fs.writeFileSync(path.join(runDir, 'relay-ready.json'), JSON.stringify(await response.json(), null, 2));
        return;
      }
      lastError = new Error(`Relay returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for relay readiness: ${lastError?.message || 'unknown error'}`);
}

function resolveStagedRelayDistDir() {
  return path.join(REPO_ROOT, 'resources', 'browser-extension-relay', 'dist');
}

async function loadBrowserLaunchHelpers() {
  const relayDistDir = resolveStagedRelayDistDir();
  const [browserConfig, browserLaunch] = await Promise.all([
    import(pathToFileURL(path.join(relayDistDir, 'browser-config.js')).href),
    import(pathToFileURL(path.join(relayDistDir, 'browser-launch.js')).href),
  ]);
  return {
    resolveBrowserExecutablePath: browserConfig.resolveBrowserExecutablePath,
    shouldUseHeadlessByDefault: browserConfig.shouldUseHeadlessByDefault,
    getBrowserLaunchArgs: browserLaunch.getBrowserLaunchArgs,
  };
}

async function getExtensionServiceWorker(browserContext) {
  let serviceWorkers = browserContext.serviceWorkers().filter((worker) => worker.url().startsWith('chrome-extension://'));
  if (serviceWorkers.length === 0) {
    await browserContext.waitForEvent('serviceworker', {
      predicate: (worker) => worker.url().startsWith('chrome-extension://'),
    });
    serviceWorkers = browserContext.serviceWorkers().filter((worker) => worker.url().startsWith('chrome-extension://'));
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    for (const worker of serviceWorkers) {
      try {
        if (await worker.evaluate(() => typeof globalThis.toggleExtensionForActiveTab === 'function')) {
          return worker;
        }
      } catch {}
    }
    await wait(100);
    serviceWorkers = browserContext.serviceWorkers().filter((worker) => worker.url().startsWith('chrome-extension://'));
  }
  throw new Error('Interpreter browser extension service worker did not expose toggleExtensionForActiveTab().');
}

async function startManagedBrowser(runDir, options, initialUrl) {
  const browserProfileDir = path.join(runDir, 'browser-profile');
  ensureDir(browserProfileDir);
  const extensionPath = path.join(resolveStagedRelayDistDir(), 'extension');
  if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
    throw new Error(`Missing built extension manifest at ${extensionPath}`);
  }

  const {
    resolveBrowserExecutablePath,
    shouldUseHeadlessByDefault,
    getBrowserLaunchArgs,
  } = await loadBrowserLaunchHelpers();
  const headless = options.browserHeadless ? true : shouldUseHeadlessByDefault();
  const browserPath = resolveBrowserExecutablePath({});
  const args = getBrowserLaunchArgs({
    extensionPath,
    userDataDir: browserProfileDir,
    headless,
  }).filter((arg) => !(
    arg.startsWith('--user-data-dir=') ||
    arg === '--profile-directory=Default' ||
    arg === 'about:blank' ||
    /^https?:\/\//i.test(arg)
  ));

  const browserContext = await chromium.launchPersistentContext(browserProfileDir, {
    executablePath: browserPath,
    headless,
    args,
  });
  const serviceWorker = await getExtensionServiceWorker(browserContext);
  const page = await browserContext.newPage();
  await page.goto(initialUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const enableResult = await serviceWorker.evaluate(async () => {
    return await globalThis.toggleExtensionForActiveTab();
  });
  if (!enableResult?.isConnected) {
    throw new Error(`Interpreter browser extension failed to attach to the managed tab: ${JSON.stringify(enableResult)}`);
  }
  fs.writeFileSync(path.join(runDir, 'managed-browser.json'), JSON.stringify({
    browserPath,
    extensionPath,
    userDataDir: browserProfileDir,
    headless,
    initialUrl,
    extensionAttachResult: enableResult,
    args,
  }, null, 2));
  return browserContext;
}

async function waitForExtensionConnection(runDir, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${RELAY_BASE_URL}/extensions/status`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        const body = await response.json();
        lastStatus = body;
        const extensions = Array.isArray(body.extensions) ? body.extensions : [];
        const selectedExtension = extensions.find((extension) => Number(extension?.activeTargets || 0) > 0);
        if (selectedExtension) {
          fs.writeFileSync(path.join(runDir, 'extension-status.json'), JSON.stringify(body, null, 2));
          return selectedExtension.stableKey || selectedExtension.extensionId;
        }
      }
    } catch (error) {
      lastStatus = { error: error.message };
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for extension connection. Last status: ${JSON.stringify(lastStatus)}`);
}

async function callCliTool(standalone, toolName, args, options = {}) {
  const env = {
    INTERPRETER_CLI_SERVER_CONNECTION: `http:http://${standalone.host}:${standalone.port}`,
    INTERPRETER_CALLER_TOKEN: standalone.interpreterCallerToken,
  };
  const result = await runCommand({
    command: standalone.interpreterCliPath,
    args: ['tools', 'builtin-interpreter', toolName, '--json', JSON.stringify(args)],
    env,
    logPath: path.join(standalone.runDir, `cli-${toolName}-${Date.now()}.log`),
    allowNonZeroExit: options.allowError === true,
  });
  const stdout = result.stdout.trim();
  const parsed = JSON.parse(stdout.split(/\r?\n/).filter(Boolean).at(-1));
  if (parsed.isError || parsed.is_error) {
    if (options.allowError) {
      const firstText = parsed.content?.find((item) => item?.type === 'text')?.text;
      return {
        raw: parsed,
        text: typeof firstText === 'string' ? firstText : '',
      };
    }
    throw new Error(`${toolName} failed: ${JSON.stringify(parsed)}`);
  }
  const firstText = parsed.content?.find((item) => item?.type === 'text')?.text;
  return {
    raw: parsed,
    text: typeof firstText === 'string' ? firstText : '',
  };
}

function parseJsonText(toolResult, toolName) {
  try {
    return JSON.parse(toolResult.text);
  } catch (error) {
    throw new Error(`${toolName} returned non-JSON text: ${toolResult.text}`);
  }
}

async function waitForTabRef(standalone, smokeUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await callCliTool(standalone, 'interpreter_whole_computer_state_get', {
      max_browser_tabs: 20,
    });
    const state = parseJsonText(result, 'interpreter_whole_computer_state_get');
    const tab = state.browser_control?.tabs?.find((entry) => entry.url === smokeUrl);
    if (tab?.tab_ref) {
      return tab.tab_ref;
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for whole-computer state to list smoke tab ${smokeUrl}`);
}

function allElements(inspectPayload) {
  return (inspectPayload.frames || []).flatMap((frame) => {
    return (frame.elements || []).map((element) => ({ ...element, frame }));
  });
}

function findElement(inspectPayload, label, predicate) {
  const element = allElements(inspectPayload).find(predicate);
  if (!element) {
    const summary = allElements(inspectPayload).map((entry) => ({
      ref_id: entry.ref_id,
      tag_name: entry.tag_name,
      role: entry.role,
      name: entry.name,
      text: entry.text,
      input_type: entry.input_type,
      editable: entry.editable,
      clickable: entry.clickable,
    }));
    throw new Error(`Could not find ${label}. Elements: ${JSON.stringify(summary, null, 2)}`);
  }
  return element;
}

async function inspectTab(standalone, tabRef) {
  const result = await callCliTool(standalone, 'interpreter_browser_page_inspect', {
    tab_ref: tabRef,
    max_elements_per_frame: 80,
  });
  return parseJsonText(result, 'interpreter_browser_page_inspect');
}

function assertToolError(toolResult, expectedText) {
  if (!(toolResult.raw?.isError || toolResult.raw?.is_error)) {
    throw new Error(`Expected tool error containing ${JSON.stringify(expectedText)}, got success: ${JSON.stringify(toolResult.raw)}`);
  }
  if (!toolResult.text.includes(expectedText)) {
    throw new Error(`Expected tool error text to include ${JSON.stringify(expectedText)}, got: ${toolResult.text}`);
  }
}

async function waitForState(baseUrl, predicate, description) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/state`);
    const state = await response.json();
    if (predicate(state)) return state;
    await wait(250);
  }
  throw new Error(`Timed out waiting for smoke page state: ${description}`);
}

async function runNegativeBrowserControlsProof({ runDir, smoke, smokeUrl, standalone, browserContext }) {
  const tabRef = await waitForTabRef(standalone, smokeUrl);
  let inspectPayload = await inspectTab(standalone, tabRef);
  const nameInput = findElement(inspectPayload, 'name input', (entry) => entry.name === 'Smoke name' || entry.input_type === 'text');

  await callCliTool(standalone, 'interpreter_browser_page_type', {
    target_identity: nameInput.target_identity,
    ref_id: nameInput.ref_id,
    text: 'Stale Ref First Value',
    duration_ms: 200,
  });
  const staleType = await callCliTool(standalone, 'interpreter_browser_page_type', {
    target_identity: nameInput.target_identity,
    ref_id: nameInput.ref_id,
    text: 'Stale Ref Second Value',
    duration_ms: 200,
  }, { allowError: true });
  assertToolError(staleType, 'refId is stale or not visible');

  const staleState = await waitForState(smoke.baseUrl, (state) => {
    return state.events.some((event) => event.event?.type === 'input' && event.event?.id === 'smoke-name' && event.event?.value === 'Stale Ref First Value')
      && !state.events.some((event) => event.event?.type === 'input' && event.event?.id === 'smoke-name' && event.event?.value === 'Stale Ref Second Value');
  }, 'stale ref rejected without second input event');

  await stopBackgroundProcess(standalone.child);
  const deniedStandalone = await startStandalone(runDir, smoke.port, {
    read: 'allowList',
    write: 'deny',
    action: 'deny',
  });
  deniedStandalone.runDir = runDir;
  const deniedTabRef = await waitForTabRef(deniedStandalone, smokeUrl);
  inspectPayload = await inspectTab(deniedStandalone, deniedTabRef);
  const deniedNameInput = findElement(inspectPayload, 'name input after denied restart', (entry) => entry.name === 'Smoke name' || entry.input_type === 'text');
  const deniedType = await callCliTool(deniedStandalone, 'interpreter_browser_page_type', {
    target_identity: deniedNameInput.target_identity,
    ref_id: deniedNameInput.ref_id,
    text: 'Denied Browser Write',
    duration_ms: 200,
  }, { allowError: true });
  assertToolError(deniedType, 'Interpreter browser settings blocked this request.');

  const deniedState = await waitForState(smoke.baseUrl, (state) => {
    return !state.events.some((event) => event.event?.type === 'input' && event.event?.id === 'smoke-name' && event.event?.value === 'Denied Browser Write');
  }, 'denied browser write produced no input event');

  fs.writeFileSync(path.join(runDir, 'negative-browser-controls.json'), JSON.stringify({
    staleTypeError: staleType.text,
    deniedTypeError: deniedType.text,
    staleEventCount: staleState.events.length,
    deniedEventCount: deniedState.events.length,
    tabRef,
    deniedTabRef,
    headless: browserContext.browser()?.isConnected() ?? true,
  }, null, 2));
  console.log('[browser-page-tools-cli-smoke] negative browser controls proof passed');
  return deniedStandalone;
}

async function killRelayPort(runDir) {
  const command = process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-Command', "Get-NetTCPConnection -LocalPort 19988 -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 } | ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop } catch {} }"]
    : ['-lc', 'PIDS=($(lsof -ti :19988)); if [ ${#PIDS[@]} -gt 0 ]; then kill "${PIDS[@]}"; fi'];
  try {
    await runCommand({
      command,
      args,
      logPath: path.join(runDir, 'cleanup-relay.log'),
    });
  } catch {}
}

async function main() {
  const options = parseArgs();
  ensureDir(OUTPUT_ROOT);
  const runDir = path.join(
    OUTPUT_ROOT,
    `${new Date().toISOString().replaceAll(':', '-')}--browser-page-tools-cli--${crypto.randomBytes(3).toString('hex')}`,
  );
  ensureDir(runDir);
  console.log(`[browser-page-tools-cli-smoke] artifacts: ${runDir}`);

  if (!options.skipSetup) {
    await prepareEnvironment(runDir);
  }

  const smokeServer = createSmokeServer();
  let browserContext = null;
  let standalone = null;
  try {
    const smoke = await smokeServer.listen();
    const smokeUrl = `${smoke.baseUrl}/`;
    standalone = await startStandalone(runDir, smoke.port);
    standalone.runDir = runDir;
    await waitForRelayReady(runDir);
    browserContext = await startManagedBrowser(runDir, options, smokeUrl);
    await waitForExtensionConnection(runDir);

    if (options.negative) {
      standalone = await runNegativeBrowserControlsProof({
        runDir,
        smoke,
        smokeUrl,
        standalone,
        browserContext,
      });
      return;
    }

    const tabRef = await waitForTabRef(standalone, smokeUrl);
    const stateWithElements = parseJsonText(await callCliTool(standalone, 'interpreter_whole_computer_state_get', {
      max_browser_tabs: 20,
      browser_tab_ref_for_elements: tabRef,
      max_browser_elements: 80,
    }), 'interpreter_whole_computer_state_get');
    const tabWithElements = stateWithElements.browser_control?.tabs?.find((entry) => entry.tab_ref === tabRef);
    if (!tabWithElements?.page_elements?.frames?.length) {
      throw new Error('Whole-computer state did not return page element inventory for the smoke tab.');
    }

    let inspectPayload = await inspectTab(standalone, tabRef);
    let nameInput = findElement(inspectPayload, 'name input', (entry) => entry.name === 'Smoke name' || entry.input_type === 'text');
    await callCliTool(standalone, 'interpreter_browser_page_trace', {
      target_identity: nameInput.target_identity,
      ref_id: nameInput.ref_id,
      duration_ms: 200,
    });
    await callCliTool(standalone, 'interpreter_browser_page_type', {
      target_identity: nameInput.target_identity,
      ref_id: nameInput.ref_id,
      text: EXPECTED_VALUES.name,
      duration_ms: 200,
    });

    inspectPayload = await inspectTab(standalone, tabRef);
    const teamSelect = findElement(inspectPayload, 'team select', (entry) => entry.name === 'Smoke team' || entry.tag_name === 'select');
    await callCliTool(standalone, 'interpreter_browser_page_select', {
      target_identity: teamSelect.target_identity,
      ref_id: teamSelect.ref_id,
      value: EXPECTED_VALUES.team,
      duration_ms: 200,
    });

    inspectPayload = await inspectTab(standalone, tabRef);
    const notesInput = findElement(inspectPayload, 'notes textarea', (entry) => entry.name === 'Smoke notes' || entry.tag_name === 'textarea');
    await callCliTool(standalone, 'interpreter_browser_page_type', {
      target_identity: notesInput.target_identity,
      ref_id: notesInput.ref_id,
      text: EXPECTED_VALUES.notes,
      duration_ms: 200,
    });

    inspectPayload = await inspectTab(standalone, tabRef);
    const frameTarget = allElements(inspectPayload)[0]?.target_identity;
    if (!frameTarget) throw new Error('No target identity available for scroll proof.');
    await callCliTool(standalone, 'interpreter_browser_page_scroll', {
      target_identity: frameTarget,
      delta_y: 700,
    });

    inspectPayload = await inspectTab(standalone, tabRef);
    const submitButton = findElement(inspectPayload, 'submit button', (entry) => entry.name === 'Save Smoke' || entry.text === 'Save Smoke');
    await callCliTool(standalone, 'interpreter_browser_page_click', {
      target_identity: submitButton.target_identity,
      ref_id: submitButton.ref_id,
      duration_ms: 200,
    });

    const finalState = await waitForState(smoke.baseUrl, (state) => {
      return state.submission?.values?.name === EXPECTED_VALUES.name
        && state.submission?.values?.team === EXPECTED_VALUES.team
        && state.submission?.values?.notes === EXPECTED_VALUES.notes
        && state.events.some((event) => event.event?.type === 'scroll')
        && state.events.some((event) => event.event?.type === 'click' && event.event?.id === 'smoke-submit');
    }, 'submitted values, scroll event, and submit click event');

    fs.writeFileSync(path.join(runDir, 'final-state.json'), JSON.stringify(finalState, null, 2));
    console.log('[browser-page-tools-cli-smoke] passed');
  } finally {
    await smokeServer.close();
    await stopBackgroundProcess(standalone?.child);
    if (browserContext && !options.keepBrowser) {
      await browserContext.close();
      await wait(1000);
      await killRelayPort(runDir);
    }
  }
}

main().catch((error) => {
  console.error('[browser-page-tools-cli-smoke] failed:', error);
  process.exit(1);
});
