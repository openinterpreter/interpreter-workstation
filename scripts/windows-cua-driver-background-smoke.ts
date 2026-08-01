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
  automation_id?: string | null;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  element_index: number;
  name?: string | null;
  role: string;
  states?: string[];
  value?: string | null;
};

let visualCapture: { scriptPath: string; dir: string } | null = null;

const HIDE_CONSOLE_WINDOW_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class InterpreterCuaConsoleWindow {
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetConsoleWindow();

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@

$consoleHandle = [InterpreterCuaConsoleWindow]::GetConsoleWindow()
if ($consoleHandle -ne [IntPtr]::Zero) {
  [void][InterpreterCuaConsoleWindow]::ShowWindow($consoleHandle, 0)
}
`;

const DESKTOP_CAPTURE_SCRIPT = String.raw`
param([Parameter(Mandatory=$true)][string]$OutputPath)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class InterpreterCuaDpiAwareness {
  public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
}
'@
[void][InterpreterCuaDpiAwareness]::SetProcessDpiAwarenessContext([InterpreterCuaDpiAwareness]::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$parent = Split-Path -Parent $OutputPath
if ($parent) {
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
}
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output $OutputPath
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
`;

const MOVE_WINDOW_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][int]$Left,
  [Parameter(Mandatory=$true)][int]$Top
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class InterpreterCuaMoveWindow {
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_NOOWNERZORDER = 0x0200;
  public const uint SWP_ASYNCWINDOWPOS = 0x4000;
  public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

  public static IntPtr FindVisibleWindowByTitle(string title) {
    IntPtr match = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hwnd, IntPtr lParam) {
      if (!IsWindowVisible(hwnd)) return true;
      StringBuilder builder = new StringBuilder(512);
      GetWindowText(hwnd, builder, builder.Capacity);
      if (String.Equals(builder.ToString(), title, StringComparison.Ordinal)) {
        match = hwnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return match;
  }
}
'@

[void][InterpreterCuaMoveWindow]::SetProcessDpiAwarenessContext([InterpreterCuaMoveWindow]::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
$hwnd = [InterpreterCuaMoveWindow]::FindVisibleWindowByTitle($Title)
if ($hwnd -eq [IntPtr]::Zero) {
  throw "Window not found: $Title"
}

$flags = [InterpreterCuaMoveWindow]::SWP_NOSIZE -bor [InterpreterCuaMoveWindow]::SWP_NOZORDER -bor [InterpreterCuaMoveWindow]::SWP_NOACTIVATE -bor [InterpreterCuaMoveWindow]::SWP_NOOWNERZORDER -bor [InterpreterCuaMoveWindow]::SWP_ASYNCWINDOWPOS

if (![InterpreterCuaMoveWindow]::SetWindowPos($hwnd, [IntPtr]::Zero, $Left, $Top, 0, 0, $flags)) {
  throw "SetWindowPos failed"
}
`;

const FIXTURE_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$StatePath,
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$Kind
)

$ErrorActionPreference = 'Stop'
${HIDE_CONSOLE_WINDOW_SCRIPT}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Write-State {
  param([string]$Status)
  $state = [ordered]@{
    title = $Title
    kind = $Kind
    name = $nameInput.Text
    subscribed = $subscribeBox.Checked
    priority = [string]$priorityBox.SelectedItem
    right_clicked = $script:rightClicked
    hotkey_count = $script:hotkeyCount
    status = $Status
  }
  $state | ConvertTo-Json -Compress | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

$script:rightClicked = $false
$script:hotkeyCount = 0

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'Manual'
$form.Left = 160
$form.Top = if ($Kind -eq 'primary') { 150 } else { 500 }
$form.Width = 460
$form.Height = 280
$form.AccessibleName = $Title

$nameLabel = New-Object System.Windows.Forms.Label
$nameLabel.Text = 'Name'
$nameLabel.Left = 24
$nameLabel.Top = 24
$nameLabel.Width = 100

$nameInput = New-Object System.Windows.Forms.TextBox
$nameInput.Name = 'NameInput'
$nameInput.AccessibleName = 'NameInput'
$nameInput.Left = 140
$nameInput.Top = 20
$nameInput.Width = 250
$nameInput.Add_KeyDown({
  param($sender, $eventArgs)
  if ($eventArgs.KeyCode -eq [System.Windows.Forms.Keys]::F2) {
    $script:hotkeyCount += 1
    Write-State -Status 'hotkey'
  }
})

$subscribeBox = New-Object System.Windows.Forms.CheckBox
$subscribeBox.Name = 'SubscribeBox'
$subscribeBox.AccessibleName = 'SubscribeBox'
$subscribeBox.Text = 'Subscribe'
$subscribeBox.Left = 140
$subscribeBox.Top = 62
$subscribeBox.Width = 250

$priorityLabel = New-Object System.Windows.Forms.Label
$priorityLabel.Text = 'Priority'
$priorityLabel.Left = 24
$priorityLabel.Top = 104
$priorityLabel.Width = 100

$priorityBox = New-Object System.Windows.Forms.ComboBox
$priorityBox.Name = 'PriorityBox'
$priorityBox.AccessibleName = 'PriorityBox'
$priorityBox.Left = 140
$priorityBox.Top = 100
$priorityBox.Width = 250
[void]$priorityBox.Items.Add('Low')
[void]$priorityBox.Items.Add('Normal')
[void]$priorityBox.Items.Add('High')
$priorityBox.SelectedItem = 'Normal'

$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Name = 'SaveButton'
$saveButton.AccessibleName = 'SaveButton'
$saveButton.Text = 'Save'
$saveButton.Left = 140
$saveButton.Top = 150
$saveButton.Width = 100
$saveButton.Add_Click({
  $statusLabel.Text = "Saved $($nameInput.Text)"
  Write-State -Status 'saved'
})

$contextButton = New-Object System.Windows.Forms.Button
$contextButton.Name = 'ContextButton'
$contextButton.AccessibleName = 'ContextButton'
$contextButton.Text = 'Context'
$contextButton.Left = 260
$contextButton.Top = 150
$contextButton.Width = 100
$contextButton.Add_MouseUp({
  param($sender, $eventArgs)
  if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
    $script:rightClicked = $true
    Write-State -Status 'right-clicked'
  }
})

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Name = 'StatusLabel'
$statusLabel.AccessibleName = 'StatusLabel'
$statusLabel.Text = 'Ready'
$statusLabel.Left = 24
$statusLabel.Top = 198
$statusLabel.Width = 380

$form.Controls.AddRange(@($nameLabel, $nameInput, $subscribeBox, $priorityLabel, $priorityBox, $saveButton, $contextButton, $statusLabel))
$form.Add_Shown({ Write-State -Status 'ready' })
[System.Windows.Forms.Application]::Run($form)
`;

const SENTINEL_SCRIPT = String.raw`
param([Parameter(Mandatory=$true)][string]$Title)

$ErrorActionPreference = 'Stop'
${HIDE_CONSOLE_WINDOW_SCRIPT}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'Manual'
$form.Left = 720
$form.Top = 180
$form.Width = 420
$form.Height = 220
$form.AccessibleName = $Title

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Foreground sentinel'
$label.Left = 24
$label.Top = 24
$label.Width = 240

$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'SentinelInput'
$box.AccessibleName = 'SentinelInput'
$box.Text = 'keep focus here'
$box.Left = 24
$box.Top = 64
$box.Width = 300

$form.Controls.AddRange(@($label, $box))
$form.Add_Shown({ $form.Activate(); $box.Focus() })
[System.Windows.Forms.Application]::Run($form)
`;

const COMPLEX_FORM_TASK = {
  customerName: 'Dr. Evelyn Carter',
  email: 'evelyn.carter@example.com',
  phone: '+1 415 555 0198',
  accountId: 'ACME-ENT-4821',
  plan: 'Enterprise Annual',
  seats: '42',
  billingContact: 'billing@acme.example',
  address: '100 Market St, Suite 420, San Francisco, CA 94105',
  notesPrefix: 'Provision SSO, SOC2 packet, and onboarding call.',
  notesSuffix: ' Confirmed for the launch window.',
  expedited: true,
  taxExempt: true,
  delivery: 'Express',
  support: 'Premium',
  acceptedTerms: true,
} as const;

const COMPLEX_FORM_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$StatePath,
  [Parameter(Mandatory=$true)][string]$Title
)

$ErrorActionPreference = 'Stop'
${HIDE_CONSOLE_WINDOW_SCRIPT}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Selected-Plan {
  if ($enterprisePlan.Checked) { return 'Enterprise Annual' }
  if ($businessPlan.Checked) { return 'Business Monthly' }
  return 'Starter'
}

function Selected-Delivery {
  if ($expressDelivery.Checked) { return 'Express' }
  return 'Standard'
}

function Selected-Support {
  if ($premiumSupport.Checked) { return 'Premium' }
  if ($standardSupport.Checked) { return 'Standard' }
  return 'Basic'
}

function Write-State {
  param([string]$Status)
  $state = [ordered]@{
    title = $Title
    customer_name = $customerNameInput.Text
    email = $emailInput.Text
    phone = $phoneInput.Text
    account_id = $accountIdInput.Text
    plan = Selected-Plan
    seats = $seatsInput.Text
    billing_contact = $billingContactInput.Text
    address = $addressInput.Text
    notes = $notesInput.Text
    expedited = $expeditedBox.Checked
    tax_exempt = $taxExemptBox.Checked
    delivery = Selected-Delivery
    support = Selected-Support
    accepted_terms = $acceptedTermsBox.Checked
    status = $Status
  }
  $state | ConvertTo-Json -Compress | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

function Add-Label {
  param([string]$Text, [int]$Left, [int]$Top)
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Text
  $label.Left = $Left
  $label.Top = $Top
  $label.Width = 120
  return $label
}

function Add-TextBox {
  param([string]$Name, [int]$Left, [int]$Top, [int]$Width, [bool]$Multiline = $false)
  $box = New-Object System.Windows.Forms.TextBox
  $box.Name = $Name
  $box.AccessibleName = $Name
  $box.Left = $Left
  $box.Top = $Top
  $box.Width = $Width
  if ($Multiline) {
    $box.Multiline = $true
    $box.Height = 62
    $box.ScrollBars = 'Vertical'
  }
  return $box
}

function Add-Radio {
  param([string]$Name, [string]$Text, [int]$Left, [int]$Top)
  $radio = New-Object System.Windows.Forms.RadioButton
  $radio.Name = $Name
  $radio.AccessibleName = $Name
  $radio.Text = $Text
  $radio.Left = $Left
  $radio.Top = $Top
  $radio.Width = 190
  return $radio
}

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'Manual'
$form.Left = 80
$form.Top = 20
$form.Width = 640
$form.Height = 730
$form.AccessibleName = $Title

$customerNameInput = Add-TextBox 'CustomerNameInput' 160 24 410
$emailInput = Add-TextBox 'EmailInput' 160 62 410
$phoneInput = Add-TextBox 'PhoneInput' 160 100 410
$accountIdInput = Add-TextBox 'AccountIdInput' 160 138 410
$seatsInput = Add-TextBox 'SeatsInput' 160 382 140
$billingContactInput = Add-TextBox 'BillingContactInput' 160 420 410
$addressInput = Add-TextBox 'AddressInput' 160 458 410
$notesInput = Add-TextBox 'NotesInput' 160 496 410 $true

$planGroup = New-Object System.Windows.Forms.GroupBox
$planGroup.Text = 'Plan'
$planGroup.Left = 24
$planGroup.Top = 174
$planGroup.Width = 260
$planGroup.Height = 104
$starterPlan = Add-Radio 'StarterPlanRadio' 'Starter' 16 22
$businessPlan = Add-Radio 'BusinessPlanRadio' 'Business Monthly' 16 50
$enterprisePlan = Add-Radio 'EnterprisePlanRadio' 'Enterprise Annual' 16 78
$starterPlan.Checked = $true
[void]$planGroup.Controls.AddRange(@($starterPlan, $businessPlan, $enterprisePlan))

$deliveryGroup = New-Object System.Windows.Forms.GroupBox
$deliveryGroup.Text = 'Delivery'
$deliveryGroup.Left = 306
$deliveryGroup.Top = 174
$deliveryGroup.Width = 270
$deliveryGroup.Height = 78
$standardDelivery = Add-Radio 'StandardDeliveryRadio' 'Standard' 16 22
$expressDelivery = Add-Radio 'ExpressDeliveryRadio' 'Express' 16 50
$standardDelivery.Checked = $true
[void]$deliveryGroup.Controls.AddRange(@($standardDelivery, $expressDelivery))

$supportGroup = New-Object System.Windows.Forms.GroupBox
$supportGroup.Text = 'Support'
$supportGroup.Left = 306
$supportGroup.Top = 258
$supportGroup.Width = 270
$supportGroup.Height = 106
$basicSupport = Add-Radio 'BasicSupportRadio' 'Basic' 16 22
$standardSupport = Add-Radio 'StandardSupportRadio' 'Standard' 16 50
$premiumSupport = Add-Radio 'PremiumSupportRadio' 'Premium' 16 78
$basicSupport.Checked = $true
[void]$supportGroup.Controls.AddRange(@($basicSupport, $standardSupport, $premiumSupport))

$expeditedBox = New-Object System.Windows.Forms.CheckBox
$expeditedBox.Name = 'ExpeditedCheckbox'
$expeditedBox.AccessibleName = 'ExpeditedCheckbox'
$expeditedBox.Text = 'Expedited onboarding'
$expeditedBox.Left = 160
$expeditedBox.Top = 584
$expeditedBox.Width = 210

$taxExemptBox = New-Object System.Windows.Forms.CheckBox
$taxExemptBox.Name = 'TaxExemptCheckbox'
$taxExemptBox.AccessibleName = 'TaxExemptCheckbox'
$taxExemptBox.Text = 'Tax exempt'
$taxExemptBox.Left = 390
$taxExemptBox.Top = 584
$taxExemptBox.Width = 170

$acceptedTermsBox = New-Object System.Windows.Forms.CheckBox
$acceptedTermsBox.Name = 'AcceptedTermsCheckbox'
$acceptedTermsBox.AccessibleName = 'AcceptedTermsCheckbox'
$acceptedTermsBox.Text = 'Accepted terms'
$acceptedTermsBox.Left = 160
$acceptedTermsBox.Top = 618
$acceptedTermsBox.Width = 210

$submitButton = New-Object System.Windows.Forms.Button
$submitButton.Name = 'SubmitButton'
$submitButton.AccessibleName = 'SubmitButton'
$submitButton.Text = 'Submit'
$submitButton.Left = 160
$submitButton.Top = 660
$submitButton.Width = 110
$submitButton.Add_Click({
  $statusLabel.Text = "Submitted $($customerNameInput.Text)"
  Write-State -Status 'submitted'
})

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Name = 'ComplexStatusLabel'
$statusLabel.Text = 'Ready'
$statusLabel.Left = 292
$statusLabel.Top = 665
$statusLabel.Width = 280

$form.Controls.AddRange(@(
  (Add-Label 'Customer name' 24 27), $customerNameInput,
  (Add-Label 'Email' 24 65), $emailInput,
  (Add-Label 'Phone' 24 103), $phoneInput,
  (Add-Label 'Account ID' 24 141), $accountIdInput,
  $planGroup, $deliveryGroup, $supportGroup,
  (Add-Label 'Seats' 24 385), $seatsInput,
  (Add-Label 'Billing contact' 24 423), $billingContactInput,
  (Add-Label 'Address' 24 461), $addressInput,
  (Add-Label 'Notes' 24 499), $notesInput,
  $expeditedBox, $taxExemptBox, $acceptedTermsBox,
  $submitButton, $statusLabel
))
$form.Add_Shown({ Write-State -Status 'ready' })
[System.Windows.Forms.Application]::Run($form)
`;

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('windows-cua-driver-background-smoke must run inside Windows.');
  }

  const runDir = path.join(os.tmpdir(), `interpreter-desktop-driver-win-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });

  const fixtureScript = path.join(runDir, 'fixture-form.ps1');
  const sentinelScript = path.join(runDir, 'sentinel.ps1');
  const complexFormScript = path.join(runDir, 'complex-form.ps1');
  const desktopCaptureScript = path.join(runDir, 'desktop-capture.ps1');
  const moveWindowScript = path.join(runDir, 'move-window.ps1');
  await writeFile(fixtureScript, FIXTURE_SCRIPT, 'utf8');
  await writeFile(sentinelScript, SENTINEL_SCRIPT, 'utf8');
  await writeFile(complexFormScript, COMPLEX_FORM_SCRIPT, 'utf8');
  await writeFile(desktopCaptureScript, DESKTOP_CAPTURE_SCRIPT, 'utf8');
  await writeFile(moveWindowScript, MOVE_WINDOW_SCRIPT, 'utf8');
  const visualDir = process.env.WIN_CUA_VISUAL_DIR
    ? path.resolve(process.env.WIN_CUA_VISUAL_DIR)
    : path.join(process.cwd(), 'test-runs', 'win-cua-visual');
  await mkdir(visualDir, { recursive: true });
  visualCapture = { scriptPath: desktopCaptureScript, dir: visualDir };
  console.log(`[win-cua-smoke] visual_dir=${visualDir}`);

  const children: ChildProcess[] = [];
  const primaryState = path.join(runDir, 'primary-state.json');
  const secondaryState = path.join(runDir, 'secondary-state.json');
  const complexState = path.join(runDir, 'complex-state.json');
  const sentinelTitle = 'Interpreter Computer Use Foreground Sentinel';
  const primaryTitle = 'Interpreter Computer Use Fixture Primary';
  const secondaryTitle = 'Interpreter Computer Use Fixture Secondary';
  const complexTitle = 'Interpreter Computer Use Complex Intake';

  try {
    children.push(spawnPowerShellSta(fixtureScript, [primaryState, primaryTitle, 'primary']));
    children.push(spawnPowerShellSta(fixtureScript, [secondaryState, secondaryTitle, 'secondary']));
    children.push(spawnPowerShellSta(complexFormScript, [complexState, complexTitle]));
    children.push(spawnPowerShellSta(sentinelScript, [sentinelTitle]));

    await waitFor(async () => {
      await readJson(primaryState);
      await readJson(secondaryState);
      await readJson(complexState);
      const windows = await listWindows();
      assertWindow(windows, primaryTitle);
      assertWindow(windows, secondaryTitle);
      assertWindow(windows, complexTitle);
      assertWindow(windows, sentinelTitle);
    }, 15_000, 'fixture windows to start');

    await activateWindow(sentinelTitle);
    await waitFor(async () => {
      assertForeground(await listWindows(), sentinelTitle);
    }, 8_000, 'sentinel to become foreground');

    await exerciseSetWindowBounds(primaryTitle, sentinelTitle);
    if (process.env.WIN_CUA_WINDOW_BOUNDS_ONLY === '1') {
      console.log('Windows Computer Use window bounds smoke passed.');
      return;
    }

    await exerciseVirtualCursorAndRecording(sentinelTitle, moveWindowScript);
    assertForeground(await listWindows(), sentinelTitle);

    await driveFixture(primaryTitle, 'Ada Lovelace', primaryState, sentinelTitle);
    await driveFixture(secondaryTitle, 'Grace Hopper', secondaryState, sentinelTitle);
    await runComplexFormAgent(complexTitle, complexState, sentinelTitle);

    console.log('Windows Computer Use background smoke passed.');
  } finally {
    try {
      await callTool('set_agent_cursor_enabled', { enabled: false });
    } catch {}
    for (const child of children) {
      if (!child.killed) child.kill();
    }
    await rm(runDir, { recursive: true, force: true });
  }
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

async function runPowerShellSta(scriptPath: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-STA',
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
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`PowerShell timed out: ${scriptPath}`));
    }, timeoutMs);
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
        reject(new Error(`PowerShell failed code=${code} signal=${signal ?? 'none'}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function captureDesktopArtifact(label: string): Promise<void> {
  if (!visualCapture) return;
  const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const outputPath = path.join(visualCapture.dir, `${Date.now()}-${safeLabel || 'capture'}.png`);
  await runPowerShellSta(visualCapture.scriptPath, [outputPath], 60_000);
  console.log(`[win-cua-smoke] visual_capture=${outputPath}`);
}

async function callTool(toolName: string, args: Record<string, unknown>): Promise<any> {
  console.log(`[win-cua-smoke] ${toolName}`);
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

async function exerciseSetWindowBounds(title: string, sentinelTitle: string): Promise<void> {
  const windows = await listWindows();
  const target = assertWindow(windows, title);
  assertForeground(windows, sentinelTitle);
  if (!target.bounds) {
    throw new Error(`target has no bounds before set_window_bounds: ${JSON.stringify(target)}`);
  }
  const nextBounds = {
    x: target.bounds.x + 45,
    y: target.bounds.y + 35,
    width: Math.max(360, target.bounds.width + 24),
    height: Math.max(260, target.bounds.height + 18),
  };

  const moved = await callTool('set_window_bounds', {
    pid: target.pid,
    window_id: target.window_id,
    ...nextBounds,
  });
  assertWindowBounds(moved.bounds, nextBounds, 'set_window_bounds result');
  assertForeground(await listWindows(), sentinelTitle);

  await waitFor(async () => {
    const observed = assertWindow(await listWindows(), title);
    assertWindowBounds(observed.bounds, nextBounds, 'list_windows after set_window_bounds');
    assertForeground(await listWindows(), sentinelTitle);
  }, 6_000, `${title} set_window_bounds`);
}

async function driveFixture(
  title: string,
  expectedName: string,
  statePath: string,
  sentinelTitle: string,
): Promise<void> {
  const windows = await listWindows();
  const target = assertWindow(windows, title);
  assertForeground(windows, sentinelTitle);

  const state = await callTool('get_window_state', {
    pid: target.pid,
    window_id: target.window_id,
  });
  const elements = state.elements as ElementRecord[];
  const nameInput = findElement(elements, 'NameInput');
  const subscribeBox = findElement(elements, 'SubscribeBox');
  const saveButton = findElement(elements, 'SaveButton');
  const contextButton = findElement(elements, 'ContextButton');

  assertPng(await callTool('screenshot', {
    pid: target.pid,
    window_id: target.window_id,
  }), `${title} screenshot`);
  assertForeground(await listWindows(), sentinelTitle);

  assertPng(await callTool('zoom', {
    pid: target.pid,
    window_id: target.window_id,
    x: 0,
    y: 0,
    width: 180,
    height: 120,
  }), `${title} zoom`);
  assertForeground(await listWindows(), sentinelTitle);

  await callTool('set_value', {
    pid: target.pid,
    window_id: target.window_id,
    element_index: nameInput.element_index,
    value: expectedName,
  });
  assertForeground(await listWindows(), sentinelTitle);

  await callTool('press_key', {
    pid: target.pid,
    window_id: target.window_id,
    element_index: nameInput.element_index,
    key: 'End',
  });
  assertForeground(await listWindows(), sentinelTitle);
  await assertCursorActivity('key', 'End');

  await callTool('type_text_chars', {
    pid: target.pid,
    window_id: target.window_id,
    element_index: nameInput.element_index,
    text: 'x',
  });
  assertForeground(await listWindows(), sentinelTitle);
  await assertCursorActivity('typing', 'x');

  await callTool('press_key', {
    pid: target.pid,
    window_id: target.window_id,
    element_index: nameInput.element_index,
    key: 'Backspace',
  });
  assertForeground(await listWindows(), sentinelTitle);
  await assertCursorActivity('key', 'Backspace');

  await callTool('hotkey', {
    pid: target.pid,
    window_id: target.window_id,
    element_index: nameInput.element_index,
    keys: ['F2'],
  });
  assertForeground(await listWindows(), sentinelTitle);
  await assertCursorActivity('hotkey', 'F2');

  await callTool('click', {
    pid: target.pid,
    window_id: target.window_id,
    element_index: subscribeBox.element_index,
  });
  assertForeground(await listWindows(), sentinelTitle);

  await callTool('right_click', {
    pid: target.pid,
    window_id: target.window_id,
    element_index: contextButton.element_index,
  });
  assertForeground(await listWindows(), sentinelTitle);

  await callTool('click', {
    pid: target.pid,
    window_id: target.window_id,
    element_index: saveButton.element_index,
  });
  await waitFor(async () => {
    assertForeground(await listWindows(), sentinelTitle);
  }, 3_000, `${title} save click to preserve sentinel foreground`);

  await waitFor(async () => {
    const saved = await readJson(statePath);
    if (saved.name !== expectedName) {
      throw new Error(`expected ${title} name ${JSON.stringify(expectedName)}, got ${JSON.stringify(saved.name)}`);
    }
    if (saved.subscribed !== true) {
      throw new Error(`expected ${title} subscribed=true, got ${JSON.stringify(saved.subscribed)}`);
    }
    if (saved.status !== 'saved') {
      throw new Error(`expected ${title} status=saved, got ${JSON.stringify(saved.status)}`);
    }
    if (saved.right_clicked !== true) {
      throw new Error(`expected ${title} right_clicked=true, got ${JSON.stringify(saved.right_clicked)}`);
    }
    if (saved.hotkey_count < 1) {
      throw new Error(`expected ${title} hotkey_count >= 1, got ${JSON.stringify(saved.hotkey_count)}`);
    }
  }, 8_000, `${title} state save`);
}

async function exerciseVirtualCursorAndRecording(sentinelTitle: string, moveWindowScript: string): Promise<void> {
  await callTool('set_agent_cursor_enabled', { enabled: true });
  await callTool('set_recording', { enabled: true });
  const beforeMove = assertWindow(await listWindows(), sentinelTitle);
  if (!beforeMove.bounds) {
    throw new Error(`sentinel has no bounds before cursor move: ${JSON.stringify(beforeMove)}`);
  }
  const cursorX = beforeMove.bounds.x + 160;
  const cursorY = beforeMove.bounds.y + 140;
  await callTool('move_cursor', {
    title: sentinelTitle,
    x: cursorX,
    y: cursorY,
  });
  await callTool('set_recording', { enabled: false });
  await assertRenderedCursor(cursorX, cursorY);

  const movedLeft = beforeMove.bounds.x + 90;
  const movedTop = beforeMove.bounds.y + 70;
  await moveWindowNoActivate(moveWindowScript, sentinelTitle, movedLeft, movedTop);
  await waitFor(async () => {
    const windows = await listWindows();
    const moved = assertWindow(windows, sentinelTitle);
    assertForeground(windows, sentinelTitle);
    if (!moved.bounds || moved.bounds.x !== movedLeft || moved.bounds.y !== movedTop) {
      throw new Error(`expected moved sentinel bounds ${movedLeft},${movedTop}, got ${JSON.stringify(moved.bounds ?? null)}`);
    }
  }, 6_000, 'sentinel window move without activation');
  await assertRenderedCursor(cursorX + (movedLeft - beforeMove.bounds.x), cursorY + (movedTop - beforeMove.bounds.y));

  const recordingState = await callTool('get_recording_state', {});
  if (!Array.isArray(recordingState.events) || recordingState.events.length < 1) {
    throw new Error(`expected at least one recorded event, got ${JSON.stringify(recordingState)}`);
  }
  const replay = await callTool('replay_trajectory', { events: recordingState.events });
  if (replay.count < 1) {
    throw new Error(`expected replay count >= 1, got ${JSON.stringify(replay)}`);
  }
}

async function moveWindowNoActivate(scriptPath: string, title: string, left: number, top: number): Promise<void> {
  await runPowerShellSta(scriptPath, [title, String(left), String(top)], 10_000);
}

type WindowSnapshot = {
  state: any;
  target: WindowRecord;
  elements: ElementRecord[];
};

async function runComplexFormAgent(
  title: string,
  statePath: string,
  sentinelTitle: string,
): Promise<void> {
  console.log('[win-cua-agent] starting complex form task');

  const readSnapshot = async (): Promise<WindowSnapshot> => {
    const windows = await listWindows();
    const target = assertWindow(windows, title);
    assertForeground(windows, sentinelTitle);
    const state = await callTool('get_window_state', {
      pid: target.pid,
      window_id: target.window_id,
    });
    return { state, target, elements: state.elements as ElementRecord[] };
  };

  const setField = async (automationId: string, value: string, verifyValue = true): Promise<void> => {
    console.log(`[win-cua-agent] set ${automationId}`);
    const snapshot = await readSnapshot();
    const element = findElement(snapshot.elements, automationId);
    await callTool('set_value', {
      pid: snapshot.target.pid,
      window_id: snapshot.target.window_id,
      element_index: element.element_index,
      value,
    });
    assertForeground(await listWindows(), sentinelTitle);
    await assertCursorActivity('typing', value);
    if (verifyValue) {
      await assertElementValue(title, sentinelTitle, automationId, value);
    }
  };

  const clickElement = async (automationId: string): Promise<void> => {
    console.log(`[win-cua-agent] click ${automationId}`);
    const snapshot = await readSnapshot();
    const element = findElement(snapshot.elements, automationId);
    await callTool('click', {
      pid: snapshot.target.pid,
      window_id: snapshot.target.window_id,
      element_index: element.element_index,
    });
    assertForeground(await listWindows(), sentinelTitle);
  };

  await setField('CustomerNameInput', COMPLEX_FORM_TASK.customerName);
  await setField('EmailInput', COMPLEX_FORM_TASK.email);
  await setField('PhoneInput', COMPLEX_FORM_TASK.phone);
  await setField('AccountIdInput', COMPLEX_FORM_TASK.accountId);
  await clickElement('EnterprisePlanRadio');
  await assertElementChecked(title, sentinelTitle, 'EnterprisePlanRadio');
  await setField('SeatsInput', COMPLEX_FORM_TASK.seats);
  await clickElement('ExpressDeliveryRadio');
  await assertElementChecked(title, sentinelTitle, 'ExpressDeliveryRadio');
  await clickElement('PremiumSupportRadio');
  await assertElementChecked(title, sentinelTitle, 'PremiumSupportRadio');
  await setField('BillingContactInput', COMPLEX_FORM_TASK.billingContact);
  await setField('AddressInput', COMPLEX_FORM_TASK.address);
  await setField('NotesInput', `${COMPLEX_FORM_TASK.notesPrefix}${COMPLEX_FORM_TASK.notesSuffix}`, false);
  await clickElement('ExpeditedCheckbox');
  await assertElementChecked(title, sentinelTitle, 'ExpeditedCheckbox');
  await clickElement('TaxExemptCheckbox');
  await assertElementChecked(title, sentinelTitle, 'TaxExemptCheckbox');
  await clickElement('AcceptedTermsCheckbox');
  await assertElementChecked(title, sentinelTitle, 'AcceptedTermsCheckbox');

  const submitSnapshot = await readSnapshot();
  const submitButton = findElement(submitSnapshot.elements, 'SubmitButton');
  const submitCenter = centerOfElement(submitButton);
  await callTool('move_cursor', {
    pid: submitSnapshot.target.pid,
    window_id: submitSnapshot.target.window_id,
    x: submitCenter.x,
    y: submitCenter.y,
  });
  assertForeground(await listWindows(), sentinelTitle);
  await assertRenderedCursor(submitCenter.x, submitCenter.y);

  await callTool('click', {
    pid: submitSnapshot.target.pid,
    window_id: submitSnapshot.target.window_id,
    element_index: submitButton.element_index,
  });
  assertForeground(await listWindows(), sentinelTitle);

  await waitFor(async () => {
    const saved = await readJson(statePath);
    const expected = {
      customer_name: COMPLEX_FORM_TASK.customerName,
      email: COMPLEX_FORM_TASK.email,
      phone: COMPLEX_FORM_TASK.phone,
      account_id: COMPLEX_FORM_TASK.accountId,
      plan: COMPLEX_FORM_TASK.plan,
      seats: COMPLEX_FORM_TASK.seats,
      billing_contact: COMPLEX_FORM_TASK.billingContact,
      address: COMPLEX_FORM_TASK.address,
      notes: `${COMPLEX_FORM_TASK.notesPrefix}${COMPLEX_FORM_TASK.notesSuffix}`,
      expedited: COMPLEX_FORM_TASK.expedited,
      tax_exempt: COMPLEX_FORM_TASK.taxExempt,
      delivery: COMPLEX_FORM_TASK.delivery,
      support: COMPLEX_FORM_TASK.support,
      accepted_terms: COMPLEX_FORM_TASK.acceptedTerms,
      status: 'submitted',
    };
    for (const [key, value] of Object.entries(expected)) {
      if (saved[key] !== value) {
        throw new Error(`complex form expected ${key}=${JSON.stringify(value)}, got ${JSON.stringify(saved[key])}`);
      }
    }
  }, 8_000, 'complex form submitted state');

  await assertTreeContains(title, sentinelTitle, `Submitted ${COMPLEX_FORM_TASK.customerName}`);
  console.log('[win-cua-agent] complex form task passed');
}

async function assertElementValue(
  title: string,
  sentinelTitle: string,
  automationId: string,
  expectedValue: string,
  useName = false,
): Promise<void> {
  await waitFor(async () => {
    const windows = await listWindows();
    const target = assertWindow(windows, title);
    assertForeground(windows, sentinelTitle);
    const state = await callTool('get_window_state', {
      pid: target.pid,
      window_id: target.window_id,
    });
    const element = findElement(state.elements as ElementRecord[], automationId);
    const actual = useName ? element.name : element.value;
    if (actual !== expectedValue) {
      throw new Error(`expected ${automationId} ${useName ? 'name' : 'value'} ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actual)}`);
    }
  }, 6_000, `${automationId} value ${JSON.stringify(expectedValue)}`);
}

async function assertElementChecked(title: string, sentinelTitle: string, automationId: string): Promise<void> {
  await waitFor(async () => {
    const windows = await listWindows();
    const target = assertWindow(windows, title);
    assertForeground(windows, sentinelTitle);
    const state = await callTool('get_window_state', {
      pid: target.pid,
      window_id: target.window_id,
    });
    const element = findElement(state.elements as ElementRecord[], automationId);
    const states = element.states ?? [];
    if (!states.includes('checked') && !states.includes('selected')) {
      throw new Error(`expected ${automationId} checked/selected, got ${JSON.stringify(states)}`);
    }
  }, 6_000, `${automationId} checked`);
}

async function assertTreeContains(title: string, sentinelTitle: string, expectedText: string): Promise<void> {
  await waitFor(async () => {
    const windows = await listWindows();
    const target = assertWindow(windows, title);
    assertForeground(windows, sentinelTitle);
    const state = await callTool('get_window_state', {
      pid: target.pid,
      window_id: target.window_id,
    });
    if (typeof state.tree_markdown !== 'string' || !state.tree_markdown.includes(expectedText)) {
      throw new Error(`expected tree to contain ${JSON.stringify(expectedText)}, got ${JSON.stringify(state.tree_markdown)}`);
    }
  }, 6_000, `tree text ${JSON.stringify(expectedText)}`);
}

function centerOfElement(element: ElementRecord): { x: number; y: number } {
  if (!element.bounds) {
    throw new Error(`Element has no bounds: ${JSON.stringify(element)}`);
  }
  return {
    x: Math.round(element.bounds.x + element.bounds.width / 2),
    y: Math.round(element.bounds.y + element.bounds.height / 2),
  };
}

async function assertRenderedCursor(x: number, y: number): Promise<void> {
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
    if (cursorState.x !== x || cursorState.y !== y) {
      throw new Error(`expected cursor at ${x},${y}, got ${JSON.stringify(cursorState)}`);
    }
  }, 6_000, 'rendered cursor state');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await captureDesktopArtifact(`cursor-${x}-${y}`);
}

async function assertCursorActivity(kind: string, text: string): Promise<void> {
  const expectedText = text.slice(0, Math.min(48, text.length));
  await waitFor(async () => {
    const cursorState = await callTool('get_agent_cursor_state', {});
    if (cursorState.enabled !== true || cursorState.rendered !== true || typeof cursorState.overlay_pid !== 'number') {
      throw new Error(`expected rendered cursor overlay, got ${JSON.stringify(cursorState)}`);
    }
    if (cursorState.real_cursor_moved !== false) {
      throw new Error(`expected real_cursor_moved=false, got ${JSON.stringify(cursorState)}`);
    }
    if (String(cursorState.activity_kind).toLowerCase() !== kind.toLowerCase()) {
      throw new Error(`expected cursor activity kind ${kind}, got ${JSON.stringify(cursorState)}`);
    }
    if (!String(cursorState.activity_text ?? '').includes(expectedText)) {
      throw new Error(`expected cursor activity text to include ${JSON.stringify(expectedText)}, got ${JSON.stringify(cursorState)}`);
    }
  }, 6_000, `cursor activity ${kind}`);
  await captureDesktopArtifact(`activity-${kind}-${expectedText}`);
}

function assertWindow(windows: WindowRecord[], title: string): WindowRecord {
  const match = windows.find((window) => window.title === title);
  if (!match) {
    throw new Error(`Window not found: ${title}. Visible windows: ${windows.map((window) => window.title).join(', ')}`);
  }
  return match;
}

function assertForeground(windows: WindowRecord[], title: string): void {
  const focused = windows.find((window) => window.is_focused);
  if (focused?.title !== title) {
    throw new Error(`Expected foreground ${JSON.stringify(title)}, got ${JSON.stringify(focused?.title ?? null)}`);
  }
}

function assertWindowBounds(
  actual: WindowRecord['bounds'] | undefined,
  expected: { x: number; y: number; width: number; height: number },
  label: string,
): void {
  if (!actual) {
    throw new Error(`${label} missing bounds.`);
  }
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (Math.abs(actual[key] - expected[key]) > 2) {
      throw new Error(`${label} expected ${key}=${expected[key]}, got ${actual[key]} in ${JSON.stringify(actual)}`);
    }
  }
}

function findElement(elements: ElementRecord[], automationId: string): ElementRecord {
  const match = elements.find((element) => element.automation_id === automationId || element.name === automationId);
  if (!match) {
    throw new Error(`Element not found: ${automationId}. Elements: ${JSON.stringify(elements, null, 2)}`);
  }
  return match;
}

function assertPng(payload: any, label: string): void {
  const encoded = payload?.screenshot_png_b64 ?? payload?.png_base64;
  if (typeof encoded !== 'string' || encoded.length < 32) {
    throw new Error(`${label} did not return PNG base64`);
  }
  const bytes = Buffer.from(encoded, 'base64');
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < pngSignature.length; index += 1) {
    if (bytes[index] !== pngSignature[index]) {
      throw new Error(`${label} returned invalid PNG signature`);
    }
  }
}

async function readJson(filePath: string): Promise<any> {
  const content = await readFile(filePath, 'utf8');
  return JSON.parse(content.replace(/^\uFEFF/, ''));
}

async function activateWindow(title: string): Promise<void> {
  const escaped = title.replaceAll("'", "''");
  await execPowerShell(`(New-Object -ComObject WScript.Shell).AppActivate('${escaped}') | Out-Null`);
}

async function execPowerShell(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command,
    ], { stdio: 'ignore', windowsHide: true });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell exited with ${code}`));
    });
    child.on('error', reject);
  });
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
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
