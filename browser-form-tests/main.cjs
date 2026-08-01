#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL, pathToFileURL } = require('url');
const { chromium } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(__dirname, 'test-output');
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_MODEL = 'gpt-5.4';
const RELAY_BASE_URL = 'http://127.0.0.1:19988';

const FORM_CASES = [
  {
    id: 'contact-intake',
    title: 'Contact Intake',
    description: 'A basic contact form with required text, email, select, and textarea fields.',
    fields: [
      { name: 'firstName', label: 'First name', type: 'text', required: true },
      { name: 'lastName', label: 'Last name', type: 'text', required: true },
      { name: 'email', label: 'Email address', type: 'email', required: true },
      {
        name: 'team',
        label: 'Team',
        type: 'select',
        required: true,
        options: ['Engineering', 'Design', 'Operations', 'Sales'],
      },
      { name: 'company', label: 'Company', type: 'text', required: true },
      { name: 'notes', label: 'Notes', type: 'textarea', required: true },
    ],
    expected: {
      firstName: 'Avery',
      lastName: 'Nguyen',
      email: 'avery.nguyen@example.com',
      team: 'Operations',
      company: 'Northwind Atelier',
      notes: 'Please schedule a follow-up demo for next Tuesday afternoon.',
    },
  },
  {
    id: 'shipping-profile',
    title: 'Shipping Profile',
    description: 'A shipping details form with address fields and a state select.',
    fields: [
      { name: 'fullName', label: 'Full name', type: 'text', required: true },
      { name: 'street', label: 'Street address', type: 'text', required: true },
      { name: 'city', label: 'City', type: 'text', required: true },
      {
        name: 'state',
        label: 'State',
        type: 'select',
        required: true,
        options: ['California', 'Nevada', 'Oregon', 'Washington'],
      },
      { name: 'zip', label: 'ZIP code', type: 'text', required: true },
      { name: 'instructions', label: 'Delivery instructions', type: 'textarea', required: true },
    ],
    expected: {
      fullName: 'Jordan Patel',
      street: '418 Willow Street',
      city: 'Berkeley',
      state: 'California',
      zip: '94704',
      instructions: 'Leave the package with the front desk if nobody answers the bell.',
    },
  },
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function requireOpenAiApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for browser form tests.');
  }
  return apiKey;
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

function buildChildProcessEnv(extraEnv = {}) {
  const merged = { ...process.env, ...extraEnv };
  if (process.platform !== 'win32') {
    return merged;
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(merged)) {
    if (!key || key.startsWith('=') || value === undefined) {
      continue;
    }
    sanitized[key.toUpperCase()] = String(value);
  }
  return sanitized;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    skipSetup: false,
    testIds: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    model: DEFAULT_MODEL,
    keepBrowser: false,
    browserHeadless: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '--skip-setup') {
      options.skipSetup = true;
    } else if (arg === '--test' && args[i + 1]) {
      options.testIds = args[++i].split(',').map((value) => value.trim()).filter(Boolean);
    } else if (arg === '--timeout-ms' && args[i + 1]) {
      options.timeoutMs = Number(args[++i]);
    } else if (arg === '--model' && args[i + 1]) {
      options.model = args[++i];
    } else if (arg === '--keep-browser') {
      options.keepBrowser = true;
    } else if (arg === '--browser-headless') {
      options.browserHeadless = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node browser-form-tests/main.cjs [options]

Options:
  --skip-setup         Skip runtime and extension preparation
  --test <id,id>       Run only specific test ids
  --timeout-ms <ms>    Agent timeout per test (default: ${DEFAULT_TIMEOUT_MS})
  --model <id>         Agent model id (default: ${DEFAULT_MODEL})
  --keep-browser       Leave the managed browser running after the run
  --browser-headless   Launch the managed browser in headless mode
  --help, -h           Show this help message
`);
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeValue(value) {
  return String(value ?? '').trim();
}

function renderField(field) {
  const label = htmlEscape(field.label);
  const required = field.required ? '<span class="required">Required</span>' : '';
  if (field.type === 'textarea') {
    return `
      <label class="field">
        <span>${label} ${required}</span>
        <textarea name="${htmlEscape(field.name)}" rows="4" ${field.required ? 'required' : ''}></textarea>
      </label>
    `;
  }

  if (field.type === 'select') {
    const options = field.options.map((option) => {
      return `<option value="${htmlEscape(option)}">${htmlEscape(option)}</option>`;
    }).join('');
    return `
      <label class="field">
        <span>${label} ${required}</span>
        <select name="${htmlEscape(field.name)}" ${field.required ? 'required' : ''}>
          <option value="">Choose one</option>
          ${options}
        </select>
      </label>
    `;
  }

  return `
    <label class="field">
      <span>${label} ${required}</span>
      <input type="${htmlEscape(field.type)}" name="${htmlEscape(field.name)}" ${field.required ? 'required' : ''} />
    </label>
  `;
}

function renderCasePage(testCase, serverBaseUrl) {
  const fieldsHtml = testCase.fields.map(renderField).join('\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlEscape(testCase.title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f7fb;
        --panel: #ffffff;
        --ink: #12243a;
        --muted: #5f7087;
        --accent: #0d6bff;
        --border: #d8e0ea;
      }
      body {
        margin: 0;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        background: linear-gradient(180deg, #eef4ff 0%, var(--bg) 55%, #edf2f7 100%);
        color: var(--ink);
      }
      main {
        max-width: 860px;
        margin: 40px auto;
        padding: 0 20px;
      }
      .hero, form {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 18px;
        box-shadow: 0 12px 30px rgba(18, 36, 58, 0.08);
      }
      .hero {
        padding: 28px;
        margin-bottom: 20px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 30px;
      }
      p {
        margin: 0;
        line-height: 1.5;
        color: var(--muted);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
      }
      form {
        padding: 28px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 16px;
      }
      .field span {
        font-size: 14px;
        font-weight: 600;
      }
      input, select, textarea, button {
        font: inherit;
      }
      input, select, textarea {
        padding: 12px 14px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: #fbfdff;
      }
      textarea {
        resize: vertical;
      }
      button {
        border: 0;
        border-radius: 999px;
        background: var(--accent);
        color: white;
        padding: 12px 18px;
        font-weight: 700;
        cursor: pointer;
      }
      .required {
        color: #b42318;
        font-size: 12px;
        margin-left: 6px;
      }
      .hint {
        margin-top: 20px;
        padding: 16px;
        border-radius: 14px;
        background: #f6f9fc;
        color: var(--muted);
      }
      .hidden {
        display: none;
      }
      @media (max-width: 720px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <h1>${htmlEscape(testCase.title)}</h1>
        <p>${htmlEscape(testCase.description)}</p>
      </section>
      <form id="browser-form-test-form">
        <div class="grid">
          ${fieldsHtml}
        </div>
        <button type="submit" id="submit-button">Submit Form</button>
        <div class="hint">
          Fill every required field, then submit the form. The server will validate the submitted values after the page shows a success state.
        </div>
      </form>
      <section id="success-message" class="hero hidden">
        <h1>Submission received</h1>
        <p>The server recorded your form submission successfully.</p>
      </section>
    </main>
    <script>
      const form = document.getElementById('browser-form-test-form');
      const success = document.getElementById('success-message');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const payload = {};
        for (const [key, value] of formData.entries()) {
          payload[key] = value;
        }
        const response = await fetch(${JSON.stringify(`${serverBaseUrl}/api/submit/${testCase.id}`)}, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error('Failed to submit test form');
        }
        form.classList.add('hidden');
        success.classList.remove('hidden');
      });
    </script>
  </body>
</html>`;
}

function createHarnessServer(testCases) {
  const submissions = new Map();
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;

    if (req.method === 'GET' && pathname === '/') {
      const indexHtml = `<!doctype html><html><body><h1>Browser Form Tests</h1><ul>${testCases.map((testCase) => {
        return `<li><a href="/cases/${testCase.id}">${htmlEscape(testCase.title)}</a></li>`;
      }).join('')}</ul></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(indexHtml);
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/cases/')) {
      const caseId = pathname.replace('/cases/', '');
      const testCase = testCases.find((entry) => entry.id === caseId);
      if (!testCase) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Unknown case');
        return;
      }
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      const baseUrl = `http://127.0.0.1:${port}`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCasePage(testCase, baseUrl));
      return;
    }

    if (req.method === 'POST' && pathname.startsWith('/api/submit/')) {
      const caseId = pathname.replace('/api/submit/', '');
      const testCase = testCases.find((entry) => entry.id === caseId);
      if (!testCase) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unknown case' }));
        return;
      }

      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const payload = JSON.parse(body || '{}');
        submissions.set(caseId, {
          submittedAt: new Date().toISOString(),
          values: payload,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/state/')) {
      const caseId = pathname.replace('/api/state/', '');
      const submission = submissions.get(caseId) || null;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ submission }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  return {
    async listen() {
      await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address !== 'object') {
        throw new Error('Failed to bind browser form test server');
      }
      return {
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
      };
    },
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) {
          socket.destroy();
        }
      });
    },
  };
}

function buildAgentSystemPrompt(browserSessionId) {
  return [
    'Use the shipped $browser-control skill for this task.',
    'A live browser session is already available for this run.',
    `Use the managed browser session with stable key "${browserSessionId}".`,
    `The correct session is already named. Set selectedBrowserSessionId to "${browserSessionId}" directly and skip session discovery unless connection fails.`,
    'Your first tool call must be js_repl for browser control.',
    'Do not use any other tool before the browser connection succeeds.',
    'Do not use shell commands, interpreter-app discovery, web search, curl, direct HTTP requests, or direct file inspection to read or submit the form.',
    'Use only browser automation for this task.',
    'Prefer a single js_repl call for this bounded form task: connect, navigate, fill, submit, wait for success, and log the final page state.',
    'First js_repl call:',
    '```javascript',
    `globalThis.selectedBrowserSessionId = ${JSON.stringify(browserSessionId)};`,
    'const { setupInterpreterBrowserControl } = await import("interpreter-browser-control");',
    'await setupInterpreterBrowserControl({ globals: globalThis, sessionId: globalThis.selectedBrowserSessionId });',
    'globalThis.page = await globalThis.ensurePage();',
    'globalThis.tab = await agent.browser.tabs.selected();',
    'console.log({ browserSessionId: globalThis.selectedBrowserSessionId, title: await globalThis.tab.title().catch(() => ""), url: await globalThis.tab.url() });',
    '```',
    'After that succeeds, continue in the same js_repl call whenever possible: navigate with `tab.goto(...)`, use either `tab.playwright` or raw Playwright `page` to fill the form exactly, and submit it for real.',
    'Do not stop after typing. Wait until the page clearly shows the submission success state.',
    'If multiple browser pages exist, choose the page you navigated for this task and act only on that page.',
  ].join('\n');
}

function buildAgentMessage(testCase, formUrl, browserSessionId) {
  const lines = [
    'Use $browser-control to solve this form through the attached live browser tab.',
    `If the app exposes multiple browser sessions, choose stable key: ${browserSessionId}`,
    `Open this form URL in the browser: ${formUrl}`,
    'Fill the form with these exact values:',
    '',
  ];

  for (const [key, value] of Object.entries(testCase.expected)) {
    lines.push(`${key}: ${value}`);
  }

  lines.push('');
  lines.push('Submit the form after all fields match exactly.');
  lines.push('Do not use shell commands, interpreter-app discovery, web search, or direct HTTP calls for this task.');
  return lines.join('\n');
}

async function waitForRelayReady(outputDir, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const versionResponse = await fetch(`${RELAY_BASE_URL}/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (versionResponse.ok) {
        fs.writeFileSync(
          path.join(outputDir, 'relay-ready.json'),
          JSON.stringify({
            checkedAt: new Date().toISOString(),
            relayBaseUrl: RELAY_BASE_URL,
            version: await versionResponse.json(),
          }, null, 2),
          'utf8',
        );
        return;
      }
      lastError = new Error(`Relay returned ${versionResponse.status} from /version`);
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }

  throw new Error(`Timed out waiting for relay readiness at ${RELAY_BASE_URL}: ${lastError?.message || 'unknown error'}`);
}

async function waitForExtensionConnection(outputDir, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${RELAY_BASE_URL}/extensions/status`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        const body = await response.json();
        lastStatus = body;
        const extensions = Array.isArray(body.extensions) ? body.extensions : [];
        const liveExtensions = extensions.filter((extension) => Number(extension?.activeTargets || 0) > 0);
        const selectedExtension =
          liveExtensions.find((extension) => extension?.browser === 'Chromium') ||
          liveExtensions[0] ||
          null;
        if (selectedExtension) {
          const browserSessionId = selectedExtension.stableKey || selectedExtension.extensionId || null;
          if (!browserSessionId) {
            throw new Error(`Connected browser session is missing a usable identifier: ${JSON.stringify(selectedExtension)}`);
          }
          fs.writeFileSync(
            path.join(outputDir, 'extension-status.json'),
            JSON.stringify({
              checkedAt: new Date().toISOString(),
              relayBaseUrl: RELAY_BASE_URL,
              selectedBrowserSessionId: browserSessionId,
              selectedExtension,
              ...body,
            }, null, 2),
            'utf8',
          );
          return browserSessionId;
        }
      }
    } catch (error) {
      lastStatus = { error: error.message };
    }
    await wait(250);
  }

  throw new Error(
    `Timed out waiting for the browser extension to expose an active browser session at ${RELAY_BASE_URL}. Last status: ${JSON.stringify(lastStatus)}`,
  );
}

function gradeSubmission(testCase, submission) {
  if (!submission) {
    return {
      passed: false,
      reason: 'No form submission was recorded.',
      mismatches: Object.entries(testCase.expected).map(([field, expected]) => ({
        field,
        expected,
        actual: '',
      })),
    };
  }

  const mismatches = [];
  for (const [field, expected] of Object.entries(testCase.expected)) {
    const actual = normalizeValue(submission.values[field]);
    if (actual !== normalizeValue(expected)) {
      mismatches.push({
        field,
        expected,
        actual,
      });
    }
  }

  if (mismatches.length > 0) {
    return {
      passed: false,
      reason: 'Submitted values did not match expected values.',
      mismatches,
    };
  }

  return {
    passed: true,
    reason: 'Submission matched expected values.',
    mismatches: [],
  };
}

async function runCommand(options) {
  const {
    command,
    args,
    cwd,
    env,
    logPath,
    waitForExit = true,
  } = options;

  return new Promise((resolve, reject) => {
    const shouldUseWindowsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
      cwd,
      env: buildChildProcessEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: shouldUseWindowsShell,
    });

    let stdout = '';
    let stderr = '';
    const logStream = fs.createWriteStream(logPath, { flags: 'w' });

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      logStream.write(text);
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logStream.write(text);
      process.stderr.write(text);
    });

    child.on('error', (error) => {
      logStream.end();
      reject(error);
    });

    child.on('close', () => {
      logStream.end();
    });

    if (!waitForExit) {
      resolve({ child, logPath });
      return;
    }

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed (${command} ${args.join(' ')}): exit ${code}\n${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr, logPath });
    });
  });
}

async function prepareEnvironment(outputDir) {
  const pnpm = getPnpmCommand();
  await runCommand({
    command: pnpm,
    args: ['run', 'download:oix', '--', '--current-platform'],
    cwd: REPO_ROOT,
    logPath: path.join(outputDir, 'setup-download-oix.log'),
  });
  await runCommand({
    command: pnpm,
    args: ['run', 'build:js-repl-runtime'],
    cwd: REPO_ROOT,
    logPath: path.join(outputDir, 'setup-js-repl-runtime.log'),
  });
  await runCommand({
    command: pnpm,
    args: ['run', 'ensure:browser-extension-relay-assets'],
    cwd: REPO_ROOT,
    logPath: path.join(outputDir, 'setup-browser-extension-relay.log'),
  });
}

async function startRelayOwner(outputDir, serverPort) {
  const relayHomeDir = path.join(outputDir, 'relay-owner-home');
  ensureDir(relayHomeDir);
  writeHarnessBrowserPolicy(relayHomeDir, serverPort);

  const { child, logPath } = await runCommand({
    command: getBunCommand(),
    args: [
      'server/standalone.ts',
      '--home',
      relayHomeDir,
      '--workspace',
      REPO_ROOT,
      '--port',
      'auto',
      '--quiet-startup',
      '--stream-jsonl',
    ],
    cwd: REPO_ROOT,
    env: {
      LOG_FILE: path.join(outputDir, 'relay-owner-server.log'),
      PLAYWRITER_AUTO_ENABLE: '1',
    },
    logPath: path.join(outputDir, 'relay-owner.log'),
    waitForExit: false,
  });

  return { child, homeDir: relayHomeDir, logPath };
}

async function stopBackgroundProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

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

function resolveStagedRelayDistDir() {
  return path.join(REPO_ROOT, 'resources', 'browser-extension-relay', 'dist');
}

async function loadBrowserLaunchHelpers() {
  const relayDistDir = resolveStagedRelayDistDir();
  const browserConfigPath = path.join(relayDistDir, 'browser-config.js');
  const browserLaunchPath = path.join(relayDistDir, 'browser-launch.js');

  const [browserConfig, browserLaunch] = await Promise.all([
    import(pathToFileURL(browserConfigPath).href),
    import(pathToFileURL(browserLaunchPath).href),
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
        const isReady = await worker.evaluate(() => {
          return typeof globalThis.toggleExtensionForActiveTab === 'function';
        });
        if (isReady) {
          return worker;
        }
      } catch {}
    }

    await wait(100);
    serviceWorkers = browserContext.serviceWorkers().filter((worker) => worker.url().startsWith('chrome-extension://'));
  }

  throw new Error('Interpreter browser extension service worker did not expose toggleExtensionForActiveTab().');
}

async function startManagedBrowser(outputDir, options, initialUrl) {
  const browserProfileDir = path.join(outputDir, 'browser-profile');
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
  const rawArgs = getBrowserLaunchArgs({
    extensionPath,
    userDataDir: browserProfileDir,
    headless,
  });

  const args = rawArgs.filter((arg) => {
    return !(
      arg.startsWith('--user-data-dir=') ||
      arg === '--profile-directory=Default' ||
      arg === 'about:blank' ||
      /^https?:\/\//i.test(arg)
    );
  });

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

  fs.writeFileSync(
    path.join(outputDir, 'managed-browser.json'),
    JSON.stringify({
      browserPath,
      extensionPath,
      userDataDir: browserProfileDir,
      headless,
      initialUrl,
      extensionAttachResult: enableResult,
      args,
    }, null, 2),
    'utf8',
  );

  return {
    browserContext,
    profileDir: browserProfileDir,
  };
}

async function stopManagedBrowser(browserContext) {
  if (!browserContext) {
    return;
  }
  await browserContext.close();
}

async function killRelayPort(outputDir) {
  const command = process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-Command', "Get-NetTCPConnection -LocalPort 19988 -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 } | ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop } catch {} }"]
    : ['-lc', 'PIDS=($(lsof -ti :19988)); if [ ${#PIDS[@]} -gt 0 ]; then kill "${PIDS[@]}"; fi'];
  try {
    await runCommand({
      command,
      args,
      cwd: REPO_ROOT,
      logPath: path.join(outputDir, 'cleanup-relay.log'),
    });
  } catch {}
}

function writeHarnessBrowserPolicy(userDataDir, serverPort) {
  ensureDir(userDataDir);
  fs.writeFileSync(
    path.join(userDataDir, 'config.json'),
    JSON.stringify({
      agents: {},
      browserAccessPolicy: {
        mode: 'allowList',
        allowedPatterns: [
          `127.0.0.1:${serverPort}/*`,
          `localhost:${serverPort}/*`,
        ],
        profilePolicies: [],
      },
    }, null, 2),
    'utf8',
  );
}

async function runAgentTask({ testCase, formUrl, timeoutMs, outputDir, browserSessionId, model, serverPort }) {
  const systemPath = path.join(outputDir, `${testCase.id}-system.txt`);
  const messagePath = path.join(outputDir, `${testCase.id}-message.txt`);
  const resultPath = path.join(outputDir, `${testCase.id}-result.json`);
  const homeDir = path.join(outputDir, 'interpreter-home');

  requireOpenAiApiKey();
  ensureDir(homeDir);
  writeHarnessBrowserPolicy(homeDir, serverPort);

  fs.writeFileSync(systemPath, buildAgentSystemPrompt(browserSessionId), 'utf8');
  fs.writeFileSync(messagePath, buildAgentMessage(testCase, formUrl, browserSessionId), 'utf8');

  const runResult = await runCommand({
    command: getBunCommand(),
    args: [
      'server/standalone.ts',
      '--message-file',
      messagePath,
      '--system-file',
      systemPath,
      '--timeout-ms',
      String(timeoutMs),
      '--home',
      homeDir,
      '--workspace',
      REPO_ROOT,
      '--port',
      'auto',
      '--approval-policy',
      'never',
      '--sandbox',
      'workspace-write',
      '--network-access',
      '--profile-id',
      'programmatic:browser-form-tests',
      '--profile-name',
      'Browser Form Tests',
      '--model',
      model,
      '--openai-api-key-env',
      'OPENAI_API_KEY',
      '--stream-jsonl',
      '--quiet-startup',
      '--result-file',
      resultPath,
      '--shutdown-after-task',
    ],
    cwd: REPO_ROOT,
    env: {
      LOG_FILE: path.join(outputDir, `${testCase.id}-headless-server.log`),
    },
    logPath: path.join(outputDir, `${testCase.id}-agent.log`),
  });

  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  return {
    runResult,
    result,
    resultPath,
  };
}

async function runSingleCase({ testCase, serverBaseUrl, serverPort, timeoutMs, outputDir, browserSessionId, model }) {
  const formUrl = `${serverBaseUrl}/cases/${testCase.id}`;
  console.log(`\n[BrowserFormTests] Running ${testCase.id} -> ${formUrl}`);
  const agent = await runAgentTask({ testCase, formUrl, timeoutMs, outputDir, browserSessionId, model, serverPort });
  const stateResponse = await fetch(`${serverBaseUrl}/api/state/${testCase.id}`);
  const state = await stateResponse.json();
  const grade = gradeSubmission(testCase, state.submission);
  const record = {
    caseId: testCase.id,
    formUrl,
    completed: Boolean(agent.result.completed),
    agentError: agent.result.error || null,
    submission: state.submission,
    grade,
  };
  fs.writeFileSync(
    path.join(outputDir, `${testCase.id}-evaluation.json`),
    JSON.stringify(record, null, 2),
    'utf8',
  );

  if (!agent.result.completed) {
    throw new Error(`Agent task did not complete for ${testCase.id}: ${agent.result.error || 'unknown error'}`);
  }
  if (!grade.passed) {
    throw new Error(
      `Form grading failed for ${testCase.id}: ${grade.reason}\n${JSON.stringify(grade.mismatches, null, 2)}`,
    );
  }

  console.log(`[BrowserFormTests] ${testCase.id} passed.`);
  return record;
}

async function main() {
  const options = parseArgs();
  ensureDir(OUTPUT_DIR);
  const runDir = path.join(
    OUTPUT_DIR,
    `${new Date().toISOString().replaceAll(':', '-')}--${crypto.randomBytes(3).toString('hex')}`,
  );
  ensureDir(runDir);

  const selectedCases = options.testIds
    ? FORM_CASES.filter((testCase) => options.testIds.includes(testCase.id))
    : FORM_CASES;

  if (selectedCases.length === 0) {
    throw new Error('No browser form test cases selected.');
  }

  if (!options.skipSetup) {
    console.log('[BrowserFormTests] Preparing runtime and extension assets...');
    await prepareEnvironment(runDir);
  }

  const harnessServer = createHarnessServer(selectedCases);
  const serverHandle = await harnessServer.listen();
  console.log(`[BrowserFormTests] Form server listening at ${serverHandle.baseUrl}`);
  const initialFormUrl = `${serverHandle.baseUrl}/cases/${selectedCases[0].id}`;

  let browserContext = null;
  let relayOwner = null;
  try {
    relayOwner = await startRelayOwner(runDir, serverHandle.port);
    await waitForRelayReady(runDir);
    const browser = await startManagedBrowser(runDir, options, initialFormUrl);
    browserContext = browser.browserContext;
    console.log('[BrowserFormTests] Managed browser launched and extension attached.');
    const browserSessionId = await waitForExtensionConnection(runDir);

    const results = [];
    for (const testCase of selectedCases) {
      results.push(await runSingleCase({
        testCase,
        serverBaseUrl: serverHandle.baseUrl,
        serverPort: serverHandle.port,
        timeoutMs: options.timeoutMs,
        outputDir: runDir,
        browserSessionId,
        model: options.model,
      }));
    }

    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(results, null, 2), 'utf8');
    console.log(`\n[BrowserFormTests] All cases passed. Artifacts: ${runDir}`);
  } finally {
    await harnessServer.close();
    await stopBackgroundProcess(relayOwner?.child);
    if (!options.keepBrowser) {
      await stopManagedBrowser(browserContext);
      await wait(1000);
      await killRelayPort(runDir);
    }
  }
}

main().catch((error) => {
  console.error('[BrowserFormTests] Failed:', error);
  process.exit(1);
});
