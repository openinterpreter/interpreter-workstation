import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { callWindowsCuaDriverTool } from '../server/tools/builtin-tools/cua-driver/windowsUia';

type ToolEnvelope = {
  ok: boolean;
  data?: any;
  error?: { code?: string; message?: string; suggestion?: string };
};

type WindowRecord = {
  app_name?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  is_focused?: boolean;
  pid: number;
  title: string;
  window_id: string;
};

type ElementRecord = {
  automation_id?: string | null;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  element_index: number;
  name?: string | null;
  role: string;
  states?: string[];
  value?: string | null;
};

type SubmittedState = {
  name?: string;
  email?: string;
  notes?: string;
  status?: string;
};

const EDGE_PATHS = [
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const SENTINEL_SCRIPT = String.raw`
param([Parameter(Mandatory=$true)][string]$Title)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'Manual'
$form.Left = 80
$form.Top = 80
$form.Width = 460
$form.Height = 180
$form.TopMost = $false
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Sentinel foreground window'
$label.AutoSize = $true
$label.Left = 32
$label.Top = 52
$form.Controls.Add($label)
$form.Add_Shown({
  $form.Activate()
})
[System.Windows.Forms.Application]::Run($form)
`;

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('windows-cua-chromium-background-smoke must run inside Windows.');
  }

  const edgePath = await findExistingPath(EDGE_PATHS);
  if (!edgePath) {
    throw new Error(`Chromium-family Edge executable not found. Checked: ${EDGE_PATHS.join(', ')}`);
  }

  const runDir = path.join(os.tmpdir(), `interpreter-desktop-driver-chromium-bg-${Date.now()}-${process.pid}`);
  const userDataDir = path.join(runDir, 'edge-profile');
  const sentinelTitle = `Interpreter Computer Use Chromium Sentinel ${Date.now()}`;
  const pageTitle = `Interpreter Computer Use Chromium Background ${Date.now()}`;
  let submitted: SubmittedState | null = null;
  let sentinel: ChildProcess | null = null;
  let edgeRootPid: number | null = null;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderFormHtml(pageTitle));
      return;
    }
    if (req.method === 'POST' && req.url === '/submit') {
      submitted = JSON.parse(await readRequestBody(req)) as SubmittedState;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  try {
    await mkdir(runDir, { recursive: true });
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/`;
    const launch = await callTool('launch_app', {
      path: edgePath,
      window_style: 'normal',
      arguments: [
        '--new-window',
        '--no-first-run',
        '--no-default-browser-check',
        '--force-renderer-accessibility',
        '--disable-features=msEdgeFirstRunExperience',
        `--user-data-dir=${quoteArg(userDataDir)}`,
        url,
      ].join(' '),
    });
    edgeRootPid = typeof launch.pid === 'number' ? launch.pid : null;
    console.log(`[win-cua-chromium] launched Edge pid=${launch.pid} path=${edgePath}`);

    const edgeWindow = await waitForValue(
      async () => findWindowByTitle(await listWindows(), pageTitle),
      20_000,
      'Edge web app window',
    );
    console.log(`[win-cua-chromium] target window_id=${edgeWindow.window_id} title=${JSON.stringify(edgeWindow.title)}`);

    const sentinelScript = path.join(runDir, 'sentinel.ps1');
    await writeFile(sentinelScript, SENTINEL_SCRIPT, 'utf8');
    sentinel = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      sentinelScript,
      sentinelTitle,
    ], {
      cwd: runDir,
      stdio: 'ignore',
      windowsHide: false,
    });

    await waitFor(async () => {
      assertForeground(await listWindows(), sentinelTitle);
    }, 12_000, 'sentinel foreground after Edge launch');

    let state = await callTool('get_window_state', {
      pid: edgeWindow.pid,
      window_id: edgeWindow.window_id,
    });
    let actionViewMode = 'control';
    let elements = flattenElements(state);
    console.log(`[win-cua-chromium] exposed ${elements.length} Edge UIA control-view elements`);
    let controls = findPageControls(elements);
    if (!controls) {
      actionViewMode = 'raw';
      state = await callTool('get_window_state', {
        pid: edgeWindow.pid,
        window_id: edgeWindow.window_id,
        view_mode: 'raw',
        max_depth: 24,
        max_elements: 1600,
      });
      elements = flattenElements(state);
      console.log(`[win-cua-chromium] exposed ${elements.length} Edge UIA raw-view elements`);
      controls = findPageControls(elements);
    }

    if (!controls) {
      const sample = elements.slice(0, 80).map((element) => ({
        element_index: element.element_index,
        role: element.role,
        name: element.name,
        value: element.value,
        bounds: element.bounds,
      }));
      throw new Error(`Edge page controls were not exposed through UIA. sample=${JSON.stringify(sample)}`);
    }

    const { nameInput, emailInput, notesInput, saveButton } = controls;
    console.log(`[win-cua-chromium] page controls name=${nameInput.element_index} email=${emailInput.element_index} notes=${notesInput.element_index} save=${saveButton.element_index}`);
    if (actionViewMode === 'raw') {
      await typeByCoordinatePreservingForeground(edgeWindow, nameInput, 'Ada Chromium', sentinelTitle);
      await typeByCoordinatePreservingForeground(edgeWindow, emailInput, 'ada.chromium@example.com', sentinelTitle);
      await typeByCoordinatePreservingForeground(edgeWindow, notesInput, 'Windows Chromium background CUA', sentinelTitle);
      await clickByCoordinatePreservingForeground(edgeWindow, saveButton, sentinelTitle);
    } else {
      await setValuePreservingForeground(edgeWindow, nameInput, 'Ada Chromium', sentinelTitle, actionViewMode);
      await setValuePreservingForeground(edgeWindow, emailInput, 'ada.chromium@example.com', sentinelTitle, actionViewMode);
      await setValuePreservingForeground(edgeWindow, notesInput, 'Windows Chromium background CUA', sentinelTitle, actionViewMode);
      await callTool('click', {
        pid: edgeWindow.pid,
        window_id: edgeWindow.window_id,
        element_index: saveButton.element_index,
        view_mode: actionViewMode,
        max_depth: 24,
        max_elements: 1600,
      });
    }
    assertForeground(await listWindows(), sentinelTitle);

    await waitFor(() => {
      if (!submitted) {
        throw new Error('form has not submitted yet');
      }
      const expected: SubmittedState = {
        name: 'Ada Chromium',
        email: 'ada.chromium@example.com',
        notes: 'Windows Chromium background CUA',
        status: 'saved',
      };
      for (const [key, value] of Object.entries(expected)) {
        if ((submitted as Record<string, unknown>)[key] !== value) {
          throw new Error(`expected ${key}=${JSON.stringify(value)}, got ${JSON.stringify((submitted as Record<string, unknown>)[key])}; submitted=${JSON.stringify(submitted)}`);
        }
      }
    }, 10_000, 'background Edge web form submission');

    assertForeground(await listWindows(), sentinelTitle);
    console.log('Windows Chromium CUA background web form smoke passed.');
  } finally {
    server.close();
    if (sentinel?.pid) {
      await killProcessTree(sentinel.pid);
    }
    if (edgeRootPid) {
      await killProcessTree(edgeRootPid);
    }
    await killEdgeProfileProcesses(userDataDir);
    await rm(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
  }
}

async function typeByCoordinatePreservingForeground(
  target: WindowRecord,
  element: ElementRecord,
  value: string,
  sentinelTitle: string,
): Promise<void> {
  await clickByCoordinatePreservingForeground(target, element, sentinelTitle);
  await callTool('type_text_chars', {
    pid: target.pid,
    window_id: target.window_id,
    text: value,
    delay_ms: 2,
  });
  assertForeground(await listWindows(), sentinelTitle);
}

async function clickByCoordinatePreservingForeground(
  target: WindowRecord,
  element: ElementRecord,
  sentinelTitle: string,
): Promise<void> {
  const point = centerOfElement(element);
  await callTool('click', {
    pid: target.pid,
    window_id: target.window_id,
    x: point.x,
    y: point.y,
  });
  assertForeground(await listWindows(), sentinelTitle);
}

function centerOfElement(element: ElementRecord): { x: number; y: number } {
  if (!element.bounds) {
    throw new Error(`element has no bounds: ${JSON.stringify(element)}`);
  }
  return {
    x: Math.round(element.bounds.x + element.bounds.width / 2),
    y: Math.round(element.bounds.y + element.bounds.height / 2),
  };
}

function findPageControls(elements: ElementRecord[]): {
  nameInput: ElementRecord;
  emailInput: ElementRecord;
  notesInput: ElementRecord;
  saveButton: ElementRecord;
} | null {
  const nameInput = findElement(elements, { role: 'Edit', nameIncludes: 'Name' })
    ?? findElement(elements, { role: 'Edit', nameIncludes: 'name' });
  const emailInput = findElement(elements, { role: 'Edit', nameIncludes: 'Email' })
    ?? findElement(elements, { role: 'Edit', nameIncludes: 'email' });
  const notesInput = findElement(elements, { role: 'Edit', nameIncludes: 'Notes' })
    ?? findElement(elements, { role: 'Edit', nameIncludes: 'notes' });
  const saveButton = elements.find((element) => (
    element.role.toLowerCase() === 'button'
    && (element.name ?? '').trim() === 'Save'
    && !!element.bounds
  )) ?? null;
  if (!nameInput || !emailInput || !notesInput || !saveButton) {
    return null;
  }
  return { nameInput, emailInput, notesInput, saveButton };
}

async function setValuePreservingForeground(
  target: WindowRecord,
  element: ElementRecord,
  value: string,
  sentinelTitle: string,
  viewMode: string,
): Promise<void> {
  await callTool('set_value', {
    pid: target.pid,
    window_id: target.window_id,
    element_index: element.element_index,
    view_mode: viewMode,
    max_depth: 24,
    max_elements: 1600,
    value,
  });
  assertForeground(await listWindows(), sentinelTitle);
}

async function findExistingPath(paths: string[]): Promise<string | null> {
  const fs = await import('node:fs');
  return paths.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function callTool(toolName: string, args: Record<string, unknown>): Promise<any> {
  const response = await callWindowsCuaDriverTool(toolName, args);
  const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
  const jsonLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('{'));
  if (!jsonLine) {
    throw new Error(`${toolName} returned no JSON envelope: ${text}`);
  }
  const parsed = JSON.parse(jsonLine) as ToolEnvelope;
  if (!parsed.ok) {
    throw new Error(`${toolName} failed: ${parsed.error?.message ?? text}`);
  }
  return parsed.data;
}

async function listWindows(): Promise<WindowRecord[]> {
  return await callTool('list_windows', {});
}

function flattenElements(state: any): ElementRecord[] {
  if (Array.isArray(state?.elements)) return state.elements as ElementRecord[];
  if (Array.isArray(state?.interactive_elements)) return state.interactive_elements as ElementRecord[];
  if (Array.isArray(state?.tree)) return state.tree as ElementRecord[];
  const found: ElementRecord[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (typeof (value as ElementRecord).element_index === 'number' && typeof (value as ElementRecord).role === 'string') {
      found.push(value as ElementRecord);
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else if (child && typeof child === 'object') {
        visit(child);
      }
    }
  };
  visit(state);
  return found;
}

function findElement(
  elements: ElementRecord[],
  options: { role: string; nameIncludes: string },
): ElementRecord | null {
  const needle = options.nameIncludes.toLowerCase();
  const role = options.role.toLowerCase();
  return elements.find((element) => (
    element.role.toLowerCase() === role
    && `${element.name ?? ''} ${element.automation_id ?? ''}`.toLowerCase().includes(needle)
  )) ?? null;
}

function findWindowByTitle(windows: WindowRecord[], title: string): WindowRecord {
  const match = windows.find((window) => window.title.includes(title));
  if (!match) {
    throw new Error(`window not found: ${title}; windows=${JSON.stringify(windows.map((window) => ({ title: window.title, app_name: window.app_name, is_focused: window.is_focused })))}`);
  }
  return match;
}

function assertForeground(windows: WindowRecord[], title: string): void {
  const focused = windows.find((window) => window.is_focused);
  if (!focused?.title.includes(title)) {
    throw new Error(`expected foreground ${JSON.stringify(title)}, got ${JSON.stringify(focused?.title ?? null)}`);
  }
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

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function renderFormHtml(title: string): string {
  return String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; margin: 40px; color: #171717; }
    main { max-width: 560px; }
    label { display: block; margin: 18px 0; font-size: 16px; }
    input, textarea { display: block; width: 100%; margin-top: 6px; font-size: 16px; padding: 8px; }
    button { font-size: 16px; padding: 8px 14px; }
    #status { margin-top: 18px; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <label>Name <input aria-label="Name" id="name" name="name" type="text" autocomplete="off"></label>
    <label>Email <input aria-label="Email" id="email" name="email" type="email" autocomplete="off"></label>
    <label>Notes <textarea aria-label="Notes" id="notes" name="notes" rows="4"></textarea></label>
    <button id="save" type="button">Save</button>
    <p id="status">Ready</p>
  </main>
  <script>
    document.querySelector("#save").addEventListener("click", async () => {
      const payload = {
        name: document.querySelector("#name").value,
        email: document.querySelector("#email").value,
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function quoteArg(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

async function killProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });
}

async function killEdgeProfileProcesses(userDataDir: string): Promise<void> {
  await withTimeout(new Promise<void>((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      [
        '$needle = $args[0]',
        'Get-CimInstance Win32_Process -Filter "Name = \'msedge.exe\'" | Where-Object { $_.CommandLine -like "*$needle*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
      ].join('; '),
      userDataDir,
    ], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  }), 5_000);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(
  fn: () => void | Promise<void>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`timed out waiting for ${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForValue<T>(
  fn: () => T | Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let value: T | undefined;
  await waitFor(async () => {
    value = await fn();
  }, timeoutMs, label);
  return value as T;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
