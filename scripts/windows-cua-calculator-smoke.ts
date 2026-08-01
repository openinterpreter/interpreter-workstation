import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  actions?: Array<{ mode?: string; no_focus?: boolean; selector?: string; tool?: string }>;
  automation_id?: string | null;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  element_index: number;
  name?: string | null;
  preferred_selector?: string | null;
  role: string;
  states?: string[];
  value?: string | null;
};

const CALCULATOR_EXPRESSION = '42';
const EXPECTED_RESULT = '42';
const SENTINEL_TITLE = 'Interpreter Computer Use Sentinel';
const CALCULATOR_KEY_SEQUENCE = [
  'Escape',
  'Escape',
  '4',
  '2',
] as const;
const CALCULATOR_CLICK_AUTOMATION_SEQUENCE = [
  'num2Button',
  'num0Button',
  'num2Button',
  'num6Button',
  'minusButton',
  'num1Button',
  'num9Button',
  'num9Button',
  'num6Button',
  'equalButton',
] as const;

const SENTINEL_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$EventPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Write-Sentinel-Event {
  param([string]$Name)
  Add-Content -LiteralPath $EventPath -Value "$([DateTimeOffset]::UtcNow.ToString('o')) $Name"
}

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'Manual'
$form.Left = 760
$form.Top = 120
$form.Width = 440
$form.Height = 220
$form.AccessibleName = $Title

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Foreground focus sentinel'
$label.Left = 24
$label.Top = 24
$label.Width = 260

$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'SentinelInput'
$box.AccessibleName = 'SentinelInput'
$box.Text = 'focus must stay here'
$box.Left = 24
$box.Top = 64
$box.Width = 300

$form.Controls.AddRange(@($label, $box))
$form.Add_Activated({ Write-Sentinel-Event 'activated' })
$form.Add_Deactivate({ Write-Sentinel-Event 'deactivated' })
$form.Add_Shown({
  Write-Sentinel-Event 'shown'
  $form.TopMost = $true
  $form.Activate()
  $box.Focus()
  $form.TopMost = $false
})
[System.Windows.Forms.Application]::Run($form)
`;

const CALCULATOR_WINDOWS_SCRIPT = String.raw`
param([Parameter(Mandatory=$true)][ValidateSet('close','count')][string]$Mode)

$ErrorActionPreference = 'Stop'

if ($Mode -eq 'count') {
  [Console]::WriteLine(@(Get-Process -Name calc,CalculatorApp -ErrorAction SilentlyContinue).Count)
  return
}

Get-Process -Name calc,CalculatorApp -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 700
`;

const FOREGROUND_WINDOW_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class InterpreterForegroundWindow {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  public static string ReadTitle() {
    IntPtr hwnd = GetForegroundWindow();
    StringBuilder builder = new StringBuilder(512);
    GetWindowText(hwnd, builder, builder.Capacity);
    return builder.ToString();
  }
}
"@
[Console]::WriteLine([InterpreterForegroundWindow]::ReadTitle())
`;

async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error('[win-cua-calculator] watchdog timed out after 300s');
    process.exit(1);
  }, 300_000);

  if (process.platform !== 'win32') {
    throw new Error('windows-cua-calculator-smoke must run inside Windows.');
  }

  const runDir = path.join(os.tmpdir(), `interpreter-desktop-driver-calc-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const children: ChildProcess[] = [];

  const calculatorWindowsScript = path.join(runDir, 'calculator-windows.ps1');
  const foregroundWindowScript = path.join(runDir, 'foreground-window.ps1');
  await writeFile(calculatorWindowsScript, CALCULATOR_WINDOWS_SCRIPT, 'utf8');
  await writeFile(foregroundWindowScript, FOREGROUND_WINDOW_SCRIPT, 'utf8');

  try {
    await closeCalculatorWindows(calculatorWindowsScript);
    await waitFor(async () => {
      const count = await countCalculatorWindows(calculatorWindowsScript);
      if (count !== 0) {
        throw new Error(`expected 0 Calculator windows, found ${count}`);
      }
    }, 10_000, 'existing Calculator windows to close');

    console.log('[win-cua-calculator] launching Calculator through Windows CUA launch_app');
    await callTool('launch_app', { path: 'calc.exe', window_style: 'normal' });

    let calculator = await waitForValue(
      async () => assertCalculatorWindow(await listWindows()),
      15_000,
      'Calculator window to appear',
    );
    await assertRenderedCursor();

    const sentinelScript = path.join(runDir, 'sentinel.ps1');
    await writeFile(sentinelScript, SENTINEL_SCRIPT, 'utf8');

    let sentinelTitle = `${SENTINEL_TITLE} Keyboard`;
    let sentinelEventPath = path.join(runDir, 'sentinel-keyboard-events.log');
    await writeFile(sentinelEventPath, '', 'utf8');
    children.push(spawnPowerShellSta(sentinelScript, [sentinelTitle, sentinelEventPath]));

    await waitFor(async () => {
      await assertForegroundTitle(foregroundWindowScript, sentinelTitle);
    }, 10_000, 'foreground sentinel to become focused');
    await assertSentinelNotDeactivated(sentinelEventPath);

    console.log('[win-cua-calculator] keyboard background-safe pass');
    for (const key of CALCULATOR_KEY_SEQUENCE) {
      await assertForegroundTitle(foregroundWindowScript, sentinelTitle);
      await assertSentinelNotDeactivated(sentinelEventPath);
      console.log(`[win-cua-calculator] press ${key}`);
      await callTool('press_key', {
        pid: calculator.pid,
        window_id: calculator.window_id,
        key,
      });
      await waitFor(async () => {
        await assertForegroundTitle(foregroundWindowScript, sentinelTitle);
        await assertSentinelNotDeactivated(sentinelEventPath);
      }, 3_000, `${key} to preserve sentinel foreground focus`);
    }
    await assertRenderedCursor({ activityKind: 'key', activityText: CALCULATOR_KEY_SEQUENCE[CALCULATOR_KEY_SEQUENCE.length - 1] });

    await waitFor(async () => {
      const state = await callTool('get_window_state', {
        pid: calculator.pid,
        window_id: calculator.window_id,
        automation_id: 'CalculatorResults',
      });
      const displayText = calculatorDisplayText(state);
      console.log(`[win-cua-calculator] keyboard display=${JSON.stringify(displayText)}`);
      if (calculatorDisplayName(state) !== `Display is ${EXPECTED_RESULT}`) {
        throw new Error(`Expected Calculator keyboard result ${EXPECTED_RESULT}, got ${JSON.stringify(displayText)}`);
      }
      await assertForegroundTitle(foregroundWindowScript, sentinelTitle);
      await assertSentinelNotDeactivated(sentinelEventPath);
    }, 5_000, 'Calculator display to contain keyboard result');

    console.log('[win-cua-calculator] clearing Calculator through background-safe click');
    const clearResult = await callTool('click', {
      pid: calculator.pid,
      window_id: calculator.window_id,
      automation_id: 'clearButton',
    });
    if (!isBackgroundSafeClickAction(clearResult.action)) {
      throw new Error(`Expected background-safe click for clearButton, got ${JSON.stringify(clearResult)}`);
    }
    await assertRenderedCursor();
    await assertForegroundTitle(foregroundWindowScript, sentinelTitle);
    await assertSentinelNotDeactivated(sentinelEventPath);

    const displayAfterClearClick = await readCalculatorDisplayName(calculator);
    console.log(`[win-cua-calculator] clear click display=${JSON.stringify(displayAfterClearClick)}`);
    if (displayAfterClearClick !== 'Display is 0') {
      console.log('[win-cua-calculator] Calculator ignored background mouse click; this is expected for its UWP buttons');
    }
    await assertNoFocusClickAction(calculator, 'num2Button');

    console.log('[win-cua-calculator] element click background-safe pass');
    for (const automationId of CALCULATOR_CLICK_AUTOMATION_SEQUENCE) {
      await assertForegroundTitle(foregroundWindowScript, sentinelTitle);
      await assertSentinelNotDeactivated(sentinelEventPath);
      console.log(`[win-cua-calculator] click ${automationId}`);
      const clickResult = await callTool('click', {
        pid: calculator.pid,
        window_id: calculator.window_id,
        automation_id: automationId,
      });
      console.log(`[win-cua-calculator] click ${automationId} action=${JSON.stringify(clickResult.action)}`);
      if (!isBackgroundSafeClickAction(clickResult.action)) {
        throw new Error(`Expected background-safe click for ${automationId}, got ${JSON.stringify(clickResult)}`);
      }
      await assertRenderedCursor();
      await waitFor(async () => {
        await assertForegroundTitle(foregroundWindowScript, sentinelTitle);
        await assertSentinelNotDeactivated(sentinelEventPath);
      }, 3_000, `${automationId} click to preserve sentinel foreground focus`);
    }

    await waitFor(async () => {
      console.log('[win-cua-calculator] reading final display');
      const displayName = await readCalculatorDisplayName(calculator);
      console.log(`[win-cua-calculator] final display=${JSON.stringify(displayName)}`);
      await assertForegroundTitle(foregroundWindowScript, sentinelTitle);
      await assertSentinelNotDeactivated(sentinelEventPath);
    }, 5_000, 'Calculator click pass to preserve foreground focus');

    console.log('[win-cua-calculator] automation discovery pass');
    const automationTargets = await callTool('list_automation_targets', { query: 'Calculator', limit: 8 });
    if (!Array.isArray(automationTargets) || !automationTargets.some((target) => target.window_id === calculator.window_id && target.automation_channels?.foreground_input?.argument === 'bring_to_foreground')) {
      throw new Error(`Expected Calculator automation target with foreground click channel, got ${JSON.stringify(automationTargets)}`);
    }
    const comObjects = await callTool('list_com_objects', { limit: 1 });
    if (!Array.isArray(comObjects)) {
      throw new Error(`Expected list_com_objects to return an array, got ${JSON.stringify(comObjects)}`);
    }

    console.log('[win-cua-calculator] approved foreground click pass');
    for (const automationId of ['clearButton', 'num4Button', 'num2Button'] as const) {
      const foregroundClick = await callTool('click', {
        pid: calculator.pid,
        window_id: calculator.window_id,
        automation_id: automationId,
        bring_to_foreground: true,
      });
      if (foregroundClick.action !== 'foreground_left_click' || foregroundClick.real_cursor_moved !== true || foregroundClick.is_foreground !== true) {
        throw new Error(`Expected foreground click for ${automationId}, got ${JSON.stringify(foregroundClick)}`);
      }
    }
    await waitFor(async () => {
      const title = await runPowerShell(foregroundWindowScript, []);
      if (!/Calculator/i.test(title)) {
        throw new Error(`Expected Calculator foreground after approved foreground click, got ${JSON.stringify(title)}`);
      }
      const displayName = await readCalculatorDisplayName(calculator);
      console.log(`[win-cua-calculator] foreground click display=${JSON.stringify(displayName)}`);
      if (displayName !== `Display is ${EXPECTED_RESULT}`) {
        throw new Error(`Expected foreground click result ${EXPECTED_RESULT}, got ${JSON.stringify(displayName)}`);
      }
    }, 8_000, 'Calculator foreground click result');

    console.log(`[win-cua-calculator] ${CALCULATOR_EXPRESSION} = ${EXPECTED_RESULT}`);
    console.log('Windows Computer Use Calculator smoke passed.');
  } finally {
    console.log('[win-cua-calculator] cleanup starting');
    for (const child of children) {
      if (!child.killed) child.kill();
    }
    console.log('[win-cua-calculator] closing Calculator windows');
    await closeCalculatorWindows(calculatorWindowsScript).catch(() => {});
    console.log('[win-cua-calculator] removing temporary files');
    await rm(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch((error) => {
      console.warn(`[win-cua-calculator] cleanup skipped for ${runDir}: ${error instanceof Error ? error.message : String(error)}`);
    });
    clearTimeout(watchdog);
    console.log('[win-cua-calculator] cleanup complete');
  }
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

async function assertRenderedCursor(expected: { activityKind?: string; activityText?: string } = {}): Promise<void> {
  await waitFor(async () => {
    const cursorState = await callTool('get_agent_cursor_state', {});
    if (cursorState.enabled !== true) {
      throw new Error(`expected cursor enabled, got ${JSON.stringify(cursorState)}`);
    }
    if (cursorState.rendered !== true || typeof cursorState.overlay_pid !== 'number') {
      throw new Error(`expected rendered cursor overlay, got ${JSON.stringify(cursorState)}`);
    }
    if (cursorState.real_cursor_moved !== false) {
      throw new Error(`expected real_cursor_moved=false, got ${JSON.stringify(cursorState)}`);
    }
    if (expected.activityKind && String(cursorState.activity_kind).toLowerCase() !== expected.activityKind.toLowerCase()) {
      throw new Error(`expected cursor activity kind ${expected.activityKind}, got ${JSON.stringify(cursorState)}`);
    }
    if (expected.activityText && !String(cursorState.activity_text ?? '').includes(expected.activityText)) {
      throw new Error(`expected cursor activity text to include ${expected.activityText}, got ${JSON.stringify(cursorState)}`);
    }
  }, 6_000, 'rendered cursor state');
}

function spawnPowerShellSta(scriptPath: string, args: string[]): ChildProcess {
  const child = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    ...args,
  ], {
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return child;
}

function assertCalculatorWindow(windows: WindowRecord[]): WindowRecord {
  const calculator = windows.find((window) => (
    window.title === 'Calculator'
    || window.app_name === 'CalculatorApp'
    || (window.app_name === 'ApplicationFrameHost' && window.title !== SENTINEL_TITLE && /calculator/i.test(window.title))
  ));
  if (!calculator) {
    throw new Error(`Calculator window not found. Windows: ${windows.map((window) => `${window.title} (${window.app_name})`).join(', ')}`);
  }
  return calculator;
}

async function assertForegroundTitle(scriptPath: string, expectedTitle: string): Promise<void> {
  const title = await runPowerShell(scriptPath, []);
  if (title !== expectedTitle) {
    throw new Error(`Expected foreground '${expectedTitle}', got '${title || 'none'}'.`);
  }
}

async function assertSentinelNotDeactivated(eventPath: string): Promise<void> {
  const text = await readFile(eventPath, 'utf8').catch(() => '');
  const deactivation = text.split(/\r?\n/).find((line) => line.includes('deactivated'));
  if (deactivation) {
    throw new Error(`Sentinel lost focus during background action: ${deactivation}`);
  }
}

function calculatorDisplayText(state: { elements?: ElementRecord[]; tree_markdown?: string }): string {
  const display = (state.elements ?? []).find((element) => element.automation_id === 'CalculatorResults');
  return [
    display?.name,
    display?.value,
    state.tree_markdown,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
}

function calculatorDisplayName(state: { elements?: ElementRecord[] }): string | null {
  const display = (state.elements ?? []).find((element) => element.automation_id === 'CalculatorResults');
  return display?.name ?? null;
}

async function readCalculatorDisplayName(calculator: WindowRecord): Promise<string | null> {
  const state = await callTool('get_window_state', {
    pid: calculator.pid,
    window_id: calculator.window_id,
    automation_id: 'CalculatorResults',
  });
  return calculatorDisplayName(state);
}

async function assertNoFocusClickAction(calculator: WindowRecord, automationId: string): Promise<void> {
  const state = await callTool('get_window_state', {
    pid: calculator.pid,
    window_id: calculator.window_id,
    automation_id: automationId,
  });
  const element = (state.elements ?? [])[0] as ElementRecord | undefined;
  if (!element) {
    throw new Error(`Expected ${automationId} element action inventory.`);
  }
  const actions = Array.isArray(element.actions)
    ? element.actions
    : element.actions
      ? [element.actions]
      : [];
  const noFocusClick = actions.find((action) => (
    action.tool === 'click'
    && isBackgroundSafeClickAction(action.mode)
    && action.no_focus === true
    && action.selector === 'automation_id'
  ));
  if (element.preferred_selector !== 'automation_id' || !noFocusClick) {
    throw new Error(`Expected ${automationId} to advertise an automation_id background-safe click, got ${JSON.stringify(element)}`);
  }
}

function isBackgroundSafeClickAction(action: unknown): boolean {
  return action === 'wm_left_click' || action === 'wm_child_left_click' || action === 'wm_button_click';
}

async function closeCalculatorWindows(scriptPath: string): Promise<void> {
  await runPowerShell(scriptPath, ['close'], { sta: true });
}

async function countCalculatorWindows(scriptPath: string): Promise<number> {
  const stdout = await runPowerShell(scriptPath, ['count'], { sta: true });
  const count = Number.parseInt(stdout.trim(), 10);
  if (!Number.isFinite(count)) {
    throw new Error(`Invalid Calculator window count: ${JSON.stringify(stdout)}`);
  }
  return count;
}

async function runPowerShell(
  scriptPath: string,
  args: string[],
  options: { sta?: boolean } = {},
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      ...(options.sta ? ['-STA'] : []),
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      ...args,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      void killProcessTree(child.pid);
      if (settled) return;
      settled = true;
      reject(new Error(`PowerShell timed out: ${scriptPath}`));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`PowerShell failed (code=${code}, signal=${signal ?? 'none'}): ${stderr.trim()}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function killProcessTree(pid: number | undefined): Promise<void> {
  if (typeof pid !== 'number') return;
  await new Promise<void>((resolve) => {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });
}

async function waitFor(action: () => Promise<void>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForValue<T>(action: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
