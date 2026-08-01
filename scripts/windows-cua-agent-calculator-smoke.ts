import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { callWindowsCuaDriverTool } from '../server/tools/builtin-tools/cua-driver/windowsUia';
import { cuaDriverTools } from '../server/tools/builtin-tools/cua-driver/tools';

type AgentTaskResult = {
  completed?: boolean;
  error?: string;
  threadId?: string;
};

type RawWindowsToolEnvelope = {
  ok?: boolean;
  data?: unknown;
  error?: {
    message?: string;
  };
};

const MODEL = process.env.WIN_CUA_AGENT_MODEL?.trim() || 'gpt-5.4';
const CALCULATOR_WINDOWS_SCRIPT = String.raw`
param([Parameter(Mandatory=$true)][ValidateSet('close','count')][string]$Mode)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class InterpreterCalculatorWindows {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

function Get-CalculatorWindows {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window
  )
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $windowCondition)
  $matches = @()
  for ($i = 0; $i -lt $windows.Count; $i++) {
    $candidate = $windows.Item($i)
    if ([string]$candidate.Current.Name -like '*Calculator*') {
      $matches += $candidate
    }
  }
  return @($matches)
}

if ($Mode -eq 'count') {
  [Console]::WriteLine((Get-CalculatorWindows).Count)
  return
}

foreach ($window in Get-CalculatorWindows) {
  $handle = [IntPtr][int]$window.Current.NativeWindowHandle
  if ($handle -ne [IntPtr]::Zero) {
    [void][InterpreterCalculatorWindows]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  }
}
Start-Sleep -Milliseconds 500
foreach ($window in Get-CalculatorWindows) {
  $handle = [IntPtr][int]$window.Current.NativeWindowHandle
  if ($handle -eq [IntPtr]::Zero) { continue }
  $ownerPid = [uint32]0
  [void][InterpreterCalculatorWindows]::GetWindowThreadProcessId($handle, [ref]$ownerPid)
  if ($ownerPid -gt 0) {
    Stop-Process -Id ([int]$ownerPid) -Force -ErrorAction SilentlyContinue
  }
}
Get-Process -Name calc,CalculatorApp -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
`;

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('windows-cua-agent-calculator-smoke must run inside Windows.');
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error('OPENAI_API_KEY is required for the live Windows CUA agent smoke.');
  }

  const runDir = path.join(os.tmpdir(), `interpreter-desktop-driver-agent-calc-${Date.now()}-${process.pid}`);
  const homeDir = path.join(runDir, 'home');
  await mkdir(runDir, { recursive: true });

  const calculatorWindowsScript = path.join(runDir, 'calculator-windows.ps1');
  await writeFile(calculatorWindowsScript, CALCULATOR_WINDOWS_SCRIPT, 'utf8');
  try {
    await closeCalculatorWindows(calculatorWindowsScript);
    await waitFor(async () => {
      const count = await countCalculatorWindows(calculatorWindowsScript);
      if (count !== 0) {
        throw new Error(`expected 0 Calculator windows, found ${count}`);
      }
    }, 10_000, 'existing Calculator windows to close');

    console.log('[win-cua-agent-calc] turn 1: agent opens Calculator');
    const firstTurn = await runAgentTurn({
      runDir,
      homeDir,
      label: 'open-calculator',
      message: [
        'Use $computer-use.',
        'Open the Windows Calculator app using builtin-cua-driver launch_app.',
        'Do not use Start-Process, shell start, or any non-driver app launcher.',
        'Do not calculate anything yet.',
        'Finish only when a visible Calculator window exists.',
      ].join(' '),
    });
    if (!firstTurn.result.completed || !firstTurn.result.threadId) {
      throw new Error(`agent did not complete Calculator-open turn: ${JSON.stringify(firstTurn.result)}`);
    }
    assertAgentUsedCua(firstTurn.stdout, 'open Calculator turn');
    assertAgentUsedCuaTool(firstTurn.stdout, 'open Calculator turn', 'launch_app');
    assertAgentDidNotUseShellLaunch(firstTurn.stdout, 'open Calculator turn');
    await waitForValue(
      async () => {
        const count = await countCalculatorWindows(calculatorWindowsScript);
        if (count <= 0) {
          throw new Error('Calculator window not found.');
        }
        return count;
      },
      15_000,
      'Calculator window after agent open turn',
    );

    console.log('[win-cua-agent-calc] turn 2: agent controls Calculator in the background');
    const secondTurn = await runAgentTurn({
      runDir,
      homeDir,
      label: 'control-calculator',
      threadId: firstTurn.result.threadId,
      message: [
        'Use $computer-use.',
        'The Windows Calculator window is already open.',
        'Use the Calculator UI through builtin-cua-driver to enter 42 and make the Calculator display exactly 42.',
        'Do not answer by mental math and do not use shell, PowerShell, Node, Python, or any non-Calculator math tool to compute the result.',
        'Use get_app_state, then app-scoped press_key, type_text, click, or set_value actions.',
        'Finish only after re-reading Calculator and confirming the visible display is 42.',
      ].join(' '),
    });
    if (!secondTurn.result.completed) {
      throw new Error(`agent did not complete Calculator-control turn: ${JSON.stringify(secondTurn.result)}`);
    }
    assertAgentUsedCua(secondTurn.stdout, 'control Calculator turn');
    assertAgentUsedAnyCuaTool(secondTurn.stdout, 'control Calculator turn', ['press_key', 'type_text', 'click', 'set_value']);
    assertAgentDidNotUseShellLaunch(secondTurn.stdout, 'control Calculator turn');

    await waitFor(async () => {
      const display = await readCalculatorDisplay();
      console.log(`[win-cua-agent-calc] Calculator display=${JSON.stringify(display)}`);
      if (display !== 'Display is 42') {
        throw new Error(`expected Calculator display "Display is 42", got ${JSON.stringify(display)}`);
      }
    }, 20_000, 'agent Calculator result to be visible');
    await assertRenderedCursor();

    console.log('Windows CUA live agent Calculator smoke passed.');
  } finally {
    await closeCalculatorWindows(calculatorWindowsScript).catch(() => {});
    await rm(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch((error) => {
      console.warn(`[win-cua-agent-calc] cleanup skipped for ${runDir}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function runAgentTurn(options: {
  homeDir: string;
  label: string;
  message: string;
  runDir: string;
  threadId?: string;
}): Promise<{ result: AgentTaskResult; stdout: string; stderr: string }> {
  const messageFile = path.join(options.runDir, `${options.label}.message.txt`);
  const resultFile = path.join(options.runDir, `${options.label}.result.json`);
  await writeFile(messageFile, options.message, 'utf8');

  const standaloneArgs = [
    'server/standalone.ts',
    '--message-file',
    messageFile,
    '--shutdown-after-task',
    '--stream-jsonl',
    '--quiet-startup',
    '--workspace',
    process.cwd(),
    '--home',
    options.homeDir,
    '--result-file',
    resultFile,
    '--profile-id',
    'win-cua-agent-calculator-smoke',
    '--profile-name',
    'Windows CUA Agent Calculator Smoke',
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
    String(240_000),
    '--skill',
    'computer-use',
  ];
  if (options.threadId) {
    standaloneArgs.push('--thread-id', options.threadId);
  }

  const { stdout, stderr } = await runChild('cmd.exe', ['/c', 'pnpm', 'exec', 'tsx', ...standaloneArgs], {
    ...process.env,
    INTERPRETER_MACHINE_RUN_DIR: options.runDir,
  }, 300_000);
  const result = JSON.parse(await readFile(resultFile, 'utf8')) as AgentTaskResult;
  return { result, stdout, stderr };
}

async function callRawWindowsTool(toolName: string, args: Record<string, unknown>): Promise<any> {
  const response = await callWindowsCuaDriverTool(toolName, args);
  const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
  const jsonLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('{'));
  if (!jsonLine) {
    throw new Error(`${toolName} returned no JSON envelope: ${text}`);
  }
  const parsed = JSON.parse(jsonLine) as RawWindowsToolEnvelope;
  if (!parsed.ok) {
    throw new Error(`${toolName} failed: ${parsed.error?.message ?? text}`);
  }
  return parsed.data;
}

async function callComputerUseTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  const tool = cuaDriverTools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new Error(`Computer Use tool not found: ${toolName}`);
  }
  const response = await tool.handler(args);
  const text = response.content
    .filter((item): item is { type: string; text: string } => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  if (response.isError) {
    throw new Error(`${toolName} failed: ${text}`);
  }
  return text;
}

async function assertRenderedCursor(): Promise<void> {
  await waitFor(async () => {
    const cursorState = await callRawWindowsTool('get_agent_cursor_state', {});
    if (cursorState.enabled !== true) {
      throw new Error(`expected cursor enabled, got ${JSON.stringify(cursorState)}`);
    }
    if (cursorState.rendered !== true || typeof cursorState.overlay_pid !== 'number') {
      throw new Error(`expected rendered cursor overlay, got ${JSON.stringify(cursorState)}`);
    }
    if (cursorState.real_cursor_moved !== false) {
      throw new Error(`expected real_cursor_moved=false, got ${JSON.stringify(cursorState)}`);
    }
  }, 6_000, 'rendered cursor state after agent Calculator task');
}

async function readCalculatorDisplay(): Promise<string> {
  const markdown = await callComputerUseTool('get_app_state', { app: 'Calculator' });
  const match = markdown.match(/Display is [^\r\n"]+/);
  return match?.[0]?.trim() ?? markdown.trim();
}

function assertAgentUsedCua(stdout: string, label: string): void {
  if (!stdout.includes('builtin-cua-driver')) {
    throw new Error(`${label} did not show builtin-cua-driver usage in agent progress output.`);
  }
}

function assertAgentUsedCuaTool(stdout: string, label: string, toolName: string): void {
  const commandNeedle = `tools builtin-cua-driver ${toolName}`;
  const logNeedle = `toolName: '${toolName}'`;
  const jsonNeedle = `"toolName":"${toolName}"`;
  if (!stdout.includes(commandNeedle) && !stdout.includes(logNeedle) && !stdout.includes(jsonNeedle)) {
    throw new Error(`${label} did not show builtin-cua-driver ${toolName} usage in agent progress output.`);
  }
}

function assertAgentUsedAnyCuaTool(stdout: string, label: string, toolNames: string[]): void {
  if (toolNames.some((toolName) => agentOutputContainsCuaTool(stdout, toolName))) {
    return;
  }
  throw new Error(`${label} did not show any of these builtin-cua-driver tools in agent progress output: ${toolNames.join(', ')}.`);
}

function agentOutputContainsCuaTool(stdout: string, toolName: string): boolean {
  const commandNeedle = `tools builtin-cua-driver ${toolName}`;
  const logNeedle = `toolName: '${toolName}'`;
  const jsonNeedle = `"toolName":"${toolName}"`;
  return stdout.includes(commandNeedle) || stdout.includes(logNeedle) || stdout.includes(jsonNeedle);
}

function assertAgentDidNotUseShellLaunch(stdout: string, label: string): void {
  if (/\bStart-Process\s+calc(?:\.exe)?\b/i.test(stdout) || /\bstart\s+calc(?:\.exe)?\b/i.test(stdout)) {
    throw new Error(`${label} used a shell Calculator launch instead of builtin-cua-driver launch_app.`);
  }
}

async function closeCalculatorWindows(scriptPath: string): Promise<void> {
  await execPowerShellFile(scriptPath, ['close']);
}

async function countCalculatorWindows(scriptPath: string): Promise<number> {
  const { stdout } = await runChild('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    'count',
  ], process.env, 30_000);
  return Number(stdout.trim() || '0');
}

async function execPowerShellFile(scriptPath: string, args: string[]): Promise<void> {
  await runChild('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    ...args,
  ], process.env, 30_000);
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
      windowsHide: true,
    });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms\nstdout:\n${tail(stdout)}\nstderr:\n${tail(stderr)}`));
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
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`${command} exited with code=${code}, signal=${signal ?? 'none'}\nstdout:\n${tail(stdout)}\nstderr:\n${tail(stderr)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function tail(text: string, maxLines = 80): string {
  return text.split(/\r?\n/).slice(-maxLines).join('\n');
}

async function waitFor(check: () => Promise<void>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForValue<T>(read: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await read();
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
