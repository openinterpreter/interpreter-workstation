import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { Key } from '@nut-tree-fork/nut-js';
import { activeWindow } from '../../../../apps/interpreter-overlay/runtime/infra/window-tracker';
import { getFocusedSelectionContext } from '../../../../apps/interpreter-overlay/runtime/infra/accessibility-parser/index';
import { isSelectedFileSourceApp } from '../../../../apps/interpreter-overlay/electron/selected-file-source';
import { readSelectedFinderFiles } from '../../../../apps/interpreter-overlay/electron/selected-file-context';
import { getInterpreterOverlayNativeHelperPath } from '../../../../apps/interpreter-overlay/runtime/infra/native-helper-paths';
import type { Bounds } from '../../../../apps/interpreter-overlay/shared/types';
import type { OsFileSelectionSourceKind, OsTextSelectionSourceKind } from '../../../../shared/types/selectionSource';
import type { BuiltinServerDefinition, BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import type { ToolCallResponse } from '../../toolTypes';
import { checkFileAccessPermission } from '../../../utils/permissions';

const execFileAsync = promisify(execFile);

type SelectedFileRecord = {
  path: string;
  name: string;
  sourceKind: OsFileSelectionSourceKind;
  bounds: Bounds | null;
};

type SelectionSnapshot = {
  text: {
    text: string;
    sourceKind: OsTextSelectionSourceKind;
    sourceAppName: string | null;
    sourceAppBundleIdentifier: string | null;
    sourceAppPid: number | null;
    bounds: Bounds | null;
  } | null;
  files: SelectedFileRecord[];
  deniedFiles: Array<{ name: string; reason: string }>;
};

type SelectionOutputFormat = 'text' | 'json';

type FileAccessChecker = (
  requesterId: string,
  filePath: string,
  mode: 'read',
  workspace: string | null,
) => boolean;

function callerId(context?: BuiltinToolContext): string | null {
  return context?.agentId ?? context?.callerTabId ?? null;
}

function normalizeTextSourceKind(
  sourceKind: 'selected_text' | 'selected_children' | 'focused_element' | 'unknown',
): OsTextSelectionSourceKind {
  switch (sourceKind) {
    case 'selected_text':
      return 'os-selected-text';
    case 'selected_children':
      return 'os-selected-children';
    case 'focused_element':
      return 'os-focused-element';
    case 'unknown':
      return 'os-selection-unknown';
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeWindowsPowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function readPasteboardFilePaths(): Promise<string[]> {
  const helperPath = getInterpreterOverlayNativeHelperPath('file-drag-context');
  const { stdout } = await execFileAsync(helperPath, [], {
    timeout: 1000,
    maxBuffer: 64 * 1024,
  });
  const rawPaths = JSON.parse(stdout) as unknown;
  if (!Array.isArray(rawPaths)) {
    throw new Error('file-drag-context returned a non-array payload.');
  }
  return rawPaths.filter((item): item is string => typeof item === 'string');
}

async function isSelectedFileSourceActive(): Promise<boolean> {
  if (process.platform === 'darwin') {
    const target = await activeWindow().catch(() => null);
    return isSelectedFileSourceApp(process.platform, {
      ownerName: target?.ownerName,
    });
  }

  if (process.platform === 'win32') {
    const script = `
$signature = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ForegroundWindow {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
'@
Add-Type -TypeDefinition $signature
$hwnd = [ForegroundWindow]::GetForegroundWindow()
$pid = 0
[void][ForegroundWindow]::GetWindowThreadProcessId($hwnd, [ref]$pid)
if ($pid -eq 0) {
  Write-Output 'false'
  exit 0
}
$process = Get-Process -Id $pid -ErrorAction SilentlyContinue
if ($process -and $process.ProcessName -eq 'explorer') {
  Write-Output 'true'
} else {
  Write-Output 'false'
}
`;
    const { stdout } = await execFileAsync('powershell.exe', [
      '-Sta',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodeWindowsPowerShellCommand(script),
    ], {
      timeout: 1500,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    });
    return isSelectedFileSourceApp(process.platform, {
      processName: stdout.trim() === 'true' ? 'explorer' : null,
    });
  }

  return false;
}

function filterSelectedFilesByCallerScope(
  rawFiles: SelectedFileRecord[],
  context: BuiltinToolContext | undefined,
  canReadFile: FileAccessChecker,
): Pick<SelectionSnapshot, 'files' | 'deniedFiles'> {
  const id = callerId(context);
  const files: SelectedFileRecord[] = [];
  const deniedFiles: SelectionSnapshot['deniedFiles'] = [];
  for (const file of rawFiles) {
    if (!id) {
      deniedFiles.push({ name: file.name, reason: 'caller identity is required before returning selected file paths' });
      continue;
    }
    if (!canReadFile(id, file.path, 'read', context?.workspace ?? null)) {
      deniedFiles.push({ name: file.name, reason: 'read permission denied by agent file scope' });
      continue;
    }
    files.push(file);
  }
  return { files, deniedFiles };
}

async function readMacSelectedFinderFiles(): Promise<SelectedFileRecord[]> {
  if (!await isSelectedFileSourceActive()) {
    return [];
  }

  const selectedFiles: Array<{ path: string; bounds: Bounds | null }> = [];
  const deadline = Date.now() + 1800;
  let lastError: unknown = null;
  while (Date.now() <= deadline && selectedFiles.length === 0) {
    try {
      selectedFiles.push(...await readSelectedFinderFiles());
    } catch (error) {
      lastError = error;
    }
    if (selectedFiles.length === 0) {
      try {
        selectedFiles.push(...(await readPasteboardFilePaths()).map((filePath) => ({
          path: filePath,
          bounds: null,
        })));
      } catch (error) {
        lastError = error;
      }
    }
    if (selectedFiles.length === 0) await wait(120);
  }
  if (selectedFiles.length === 0 && lastError) {
    console.warn('[SelectionTool] failed to read selected file source', lastError);
  }

  const files = selectedFiles;
  return files.map((file): SelectedFileRecord => {
    return {
      path: file.path,
      name: path.basename(file.path),
      sourceKind: 'os-selected-file',
      bounds: file.bounds,
    };
  });
}

async function readWindowsSelectedFiles(): Promise<SelectedFileRecord[]> {
  if (!await isSelectedFileSourceActive()) {
    return [];
  }

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function RectObject($rect) {
  if ($rect.IsEmpty) { return $null }
  return @{
    x = [int]$rect.X
    y = [int]$rect.Y
    width = [int]$rect.Width
    height = [int]$rect.Height
  }
}

$shell = New-Object -ComObject Shell.Application
$windows = @($shell.Windows() | Where-Object { $_.Name -eq 'File Explorer' -or $_.FullName -match 'explorer.exe' })
if ($windows.Count -eq 0) {
  @() | ConvertTo-Json -Compress
  exit 0
}
$window = $windows[$windows.Count - 1]
$selectedFiles = @()
foreach ($item in @($window.Document.SelectedItems())) {
  if ($item -and $item.Path -and (Test-Path -LiteralPath $item.Path -PathType Leaf)) {
    $selectedFiles += @{
      path = $item.Path
      name = $item.Name
      bounds = $null
    }
  }
}

if ($selectedFiles.Count -gt 0) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $explorerCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty,
    'CabinetWClass'
  )
  $explorers = @($root.FindAll([System.Windows.Automation.TreeScope]::Children, $explorerCondition))
  $selectedListItems = @()
  foreach ($explorer in $explorers) {
    $selectedCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty,
      $true
    )
    $items = @($explorer.FindAll([System.Windows.Automation.TreeScope]::Descendants, $selectedCondition))
    foreach ($element in $items) {
      if ([string]$element.Current.ControlType.ProgrammaticName -eq 'ControlType.ListItem' -and [string]$element.Current.ClassName -eq 'UIItem') {
        $selectedListItems += $element
      }
    }
  }

  if ($selectedFiles.Count -eq 1 -and $selectedListItems.Count -eq 1) {
    $selectedFiles[0].bounds = RectObject $selectedListItems[0].Current.BoundingRectangle
  } else {
    foreach ($file in $selectedFiles) {
      $baseName = [System.IO.Path]::GetFileNameWithoutExtension([string]$file.path)
      $matchingItems = @($selectedListItems | Where-Object {
        [string]$_.Current.Name -eq [string]$file.name -or [string]$_.Current.Name -eq $baseName
      })
      if ($matchingItems.Count -eq 1) {
        $file.bounds = RectObject $matchingItems[0].Current.BoundingRectangle
      }
    }
  }
}

$selectedFiles | ConvertTo-Json -Compress -Depth 6
`;
  const { stdout } = await execFileAsync('powershell.exe', [
    '-Sta',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodeWindowsPowerShellCommand(script),
  ], {
    timeout: 8000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  const trimmedStdout = stdout.trim();
  if (!trimmedStdout) {
    return [];
  }
  const rawFiles = JSON.parse(trimmedStdout) as unknown;
  const files = Array.isArray(rawFiles) ? rawFiles : [rawFiles];
  return files.map((item): SelectedFileRecord => {
    if (!item || typeof item !== 'object') {
      throw new Error('Windows selected-file reader returned a malformed selected file.');
    }
    const file = item as { path?: unknown; name?: unknown; bounds?: unknown };
    if (typeof file.path !== 'string' || file.path.length === 0) {
      throw new Error('Windows selected-file reader returned a selected file without a path.');
    }
    return {
      path: file.path,
      name: typeof file.name === 'string' && file.name ? file.name : path.basename(file.path),
      sourceKind: 'os-selected-file',
      bounds: file.bounds && typeof file.bounds === 'object'
        && typeof (file.bounds as Bounds).x === 'number'
        && typeof (file.bounds as Bounds).y === 'number'
        && typeof (file.bounds as Bounds).width === 'number'
        && typeof (file.bounds as Bounds).height === 'number'
        ? file.bounds as Bounds
        : null,
    };
  });
}

async function readSelectedText(): Promise<SelectionSnapshot['text']> {
  if (process.platform === 'win32') {
    const { keyboard } = await import('@nut-tree-fork/nut-js');
    const { createRequire } = await import('node:module');
    const require = createRequire(
      typeof __filename !== 'undefined' ? __filename : import.meta.url,
    );
    const { clipboard } = require('electron') as typeof import('electron');
    const previousText = clipboard.readText();
    clipboard.writeText('');
    let controlPressed = false;
    let cPressed = false;
    try {
      await keyboard.pressKey(Key.LeftControl);
      controlPressed = true;
      await wait(18);
      await keyboard.pressKey(Key.C);
      cPressed = true;
      await wait(18);
      await keyboard.releaseKey(Key.C);
      cPressed = false;
      await keyboard.releaseKey(Key.LeftControl);
      controlPressed = false;
      await wait(160);
      const text = clipboard.readText().trim();
      return text
        ? {
            text,
            sourceKind: 'os-selected-text',
            sourceAppName: null,
            sourceAppBundleIdentifier: null,
            sourceAppPid: null,
            bounds: null,
          }
        : null;
    } finally {
      if (cPressed) {
        await keyboard.releaseKey(Key.C).catch(() => undefined);
      }
      if (controlPressed) {
        await keyboard.releaseKey(Key.LeftControl).catch(() => undefined);
      }
      clipboard.writeText(previousText);
    }
  }

  if (process.platform !== 'darwin') {
    return null;
  }

  const selection = await getFocusedSelectionContext().catch(() => null);
  if (!selection?.text?.trim()) {
    return null;
  }
  if (selection.sourceAppBundleIdentifier === 'com.apple.finder') {
    return null;
  }
  return {
    text: selection.text.trim(),
    sourceKind: normalizeTextSourceKind(selection.sourceKind),
    sourceAppName: selection.sourceAppName,
    sourceAppBundleIdentifier: selection.sourceAppBundleIdentifier,
    sourceAppPid: selection.sourceAppPid,
    bounds: selection.bounds,
  };
}

async function readSelectedFiles(context?: BuiltinToolContext): Promise<Pick<SelectionSnapshot, 'files' | 'deniedFiles'>> {
  const rawFiles = process.platform === 'darwin'
    ? await readMacSelectedFinderFiles()
    : process.platform === 'win32'
      ? await readWindowsSelectedFiles()
      : [];
  return filterSelectedFilesByCallerScope(rawFiles, context, checkFileAccessPermission);
}

function formatBounds(bounds: Bounds | null): string {
  if (!bounds) return 'bounds=null';
  return `bounds={x=${bounds.x}, y=${bounds.y}, width=${bounds.width}, height=${bounds.height}}`;
}

function formatCurrentSelectionSnapshotAsText(snapshot: SelectionSnapshot): string {
  const lines = ['Current selection'];
  if (snapshot.text) {
    lines.push('<selected_text>');
    lines.push(`source_kind=${snapshot.text.sourceKind}`);
    if (snapshot.text.sourceAppName) lines.push(`source_app=${JSON.stringify(snapshot.text.sourceAppName)}`);
    if (snapshot.text.sourceAppBundleIdentifier) lines.push(`source_bundle=${JSON.stringify(snapshot.text.sourceAppBundleIdentifier)}`);
    if (typeof snapshot.text.sourceAppPid === 'number') lines.push(`source_pid=${snapshot.text.sourceAppPid}`);
    lines.push(formatBounds(snapshot.text.bounds));
    lines.push(snapshot.text.text);
    lines.push('</selected_text>');
  } else {
    lines.push('selected_text=null');
  }

  lines.push('<selected_files>');
  if (snapshot.files.length === 0) {
    lines.push('No selected files visible to this caller.');
  } else {
    for (const file of snapshot.files) {
      lines.push(`file source_kind=${file.sourceKind} name=${JSON.stringify(file.name)} path=${JSON.stringify(file.path)} ${formatBounds(file.bounds)}`);
    }
  }
  if (snapshot.deniedFiles.length > 0) {
    lines.push('<denied_selected_files>');
    for (const file of snapshot.deniedFiles) {
      lines.push(`file name=${JSON.stringify(file.name)} reason=${JSON.stringify(file.reason)}`);
    }
    lines.push('</denied_selected_files>');
  }
  lines.push('</selected_files>');
  return lines.join('\n');
}

function formatCurrentSelectionSnapshotAsJson(snapshot: SelectionSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

function readSelectionOutputFormat(args: Record<string, unknown>): SelectionOutputFormat {
  const format = args.format;
  if (format === undefined) {
    return 'text';
  }
  if (format === 'text' || format === 'json') {
    return format;
  }
  throw new Error('format must be "text" or "json".');
}

function formatCurrentSelectionSnapshot(snapshot: SelectionSnapshot, format: SelectionOutputFormat): string {
  return format === 'json'
    ? formatCurrentSelectionSnapshotAsJson(snapshot)
    : formatCurrentSelectionSnapshotAsText(snapshot);
}

async function readCurrentSelection(args: Record<string, unknown>, context?: BuiltinToolContext): Promise<ToolCallResponse> {
  const format = readSelectionOutputFormat(args);
  const [text, fileResult] = await Promise.all([
    readSelectedText(),
    readSelectedFiles(context),
  ]);
  const snapshot = {
    text,
    files: fileResult.files,
    deniedFiles: fileResult.deniedFiles,
  };
  return {
    content: [{
      type: 'text',
      text: formatCurrentSelectionSnapshot(snapshot, format),
    }],
  };
}

const tools: BuiltinToolDefinition[] = [{
  name: 'read_current_selection',
  description: 'Read the current desktop selection as selected text and permission-filtered selected file refs.',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format. Use json for structured handoff between app surfaces.',
      },
    },
  },
  handler: readCurrentSelection,
  mode: 'read',
  annotations: {
    readOnlyHint: true,
  },
}];

export const selectionServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-selection',
  name: 'Selection',
  description: 'Read current desktop selection context through Interpreter',
  isBuiltin: true,
  tools,
  resources: [],
  prompts: [],
};

export function filterSelectedFilesByCallerScopeForTest(
  rawFiles: SelectedFileRecord[],
  context: BuiltinToolContext | undefined,
  canReadFile: FileAccessChecker,
): Pick<SelectionSnapshot, 'files' | 'deniedFiles'> {
  return filterSelectedFilesByCallerScope(rawFiles, context, canReadFile);
}

export function formatCurrentSelectionSnapshotForTest(snapshot: SelectionSnapshot): string {
  return formatCurrentSelectionSnapshotAsText(snapshot);
}

export function formatCurrentSelectionSnapshotAsJsonForTest(snapshot: SelectionSnapshot): string {
  return formatCurrentSelectionSnapshotAsJson(snapshot);
}
