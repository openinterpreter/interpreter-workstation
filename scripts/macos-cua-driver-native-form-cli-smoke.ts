import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type ServerReady = {
  interpreterCliPath: string;
  interpreterCliServerConnection: string;
  interpreterCallerToken: string;
};

type FrontmostApp = {
  name: string;
  pid: number | null;
};

type ToolContent = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

type ToolResponse = {
  content?: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

type ToolContext = {
  cliPath: string;
  env: NodeJS.ProcessEnv;
};

type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CuaWindowRecord = {
  id?: number | string;
  window_id?: number | string;
  pid?: number;
  name?: string;
  title?: string;
  is_on_screen?: boolean;
  isOnScreen?: boolean;
  bounds?: Partial<WindowBounds>;
  target_identity?: {
    kind?: string;
    app?: {
      pid?: number;
      name?: string | null;
    };
    window?: {
      native_window_id?: number | string;
      title?: string | null;
    };
  };
};

type ElementSearchOptions = {
  exactName?: string;
  excludeNeedles?: string[];
  roleNeedles?: string[];
};

const FIXTURE_SWIFT = String.raw`
import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  let statePath: String
  let windowTitle: String
  var window: NSWindow!
  var nameInput: NSTextField!
  var emailInput: NSTextField!
  var subscribeButton: NSButton!
  var priorityInput: NSTextField!
  var receiptButton: NSButton!
  var receiptLabel: NSTextField!
  var receiptPath: String = ""
  var statusLabel: NSTextField!
  var windowEventCount: Int = 0
  var lastWindowEvent: String = "none"

  init(statePath: String, windowTitle: String) {
    self.statePath = statePath
    self.windowTitle = windowTitle
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: 180, y: 180, width: 560, height: 380),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = windowTitle
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.standardWindowButton(.closeButton)?.target = self
    window.standardWindowButton(.closeButton)?.action = #selector(closeWindow(_:))

    let content = NSView(frame: NSRect(x: 0, y: 0, width: 560, height: 380))
    window.contentView = content

    addLabel("Name", x: 32, y: 302, to: content)
    nameInput = NSTextField(frame: NSRect(x: 150, y: 296, width: 340, height: 28))
    nameInput.identifier = NSUserInterfaceItemIdentifier("NameInput")
    nameInput.setAccessibilityIdentifier("NameInput")
    nameInput.setAccessibilityLabel("NameInput")
    content.addSubview(nameInput)

    addLabel("Email", x: 32, y: 258, to: content)
    emailInput = NSTextField(frame: NSRect(x: 150, y: 252, width: 340, height: 28))
    emailInput.identifier = NSUserInterfaceItemIdentifier("EmailInput")
    emailInput.setAccessibilityIdentifier("EmailInput")
    emailInput.setAccessibilityLabel("EmailInput")
    content.addSubview(emailInput)

    subscribeButton = NSButton(checkboxWithTitle: "Subscribe", target: nil, action: nil)
    subscribeButton.frame = NSRect(x: 150, y: 206, width: 180, height: 28)
    subscribeButton.identifier = NSUserInterfaceItemIdentifier("SubscribeCheckbox")
    subscribeButton.setAccessibilityIdentifier("SubscribeCheckbox")
    subscribeButton.setAccessibilityLabel("SubscribeCheckbox")
    content.addSubview(subscribeButton)

    addLabel("Priority", x: 32, y: 164, to: content)
    priorityInput = NSTextField(frame: NSRect(x: 150, y: 158, width: 180, height: 28))
    priorityInput.stringValue = "Normal"
    priorityInput.identifier = NSUserInterfaceItemIdentifier("PriorityInput")
    priorityInput.setAccessibilityIdentifier("PriorityInput")
    priorityInput.setAccessibilityLabel("PriorityInput")
    content.addSubview(priorityInput)

    receiptButton = NSButton(title: "Attach Receipt", target: self, action: #selector(attachReceipt(_:)))
    receiptButton.frame = NSRect(x: 150, y: 108, width: 132, height: 32)
    receiptButton.identifier = NSUserInterfaceItemIdentifier("AttachReceiptButton")
    receiptButton.setAccessibilityIdentifier("AttachReceiptButton")
    receiptButton.setAccessibilityLabel("AttachReceiptButton")
    content.addSubview(receiptButton)

    receiptLabel = NSTextField(labelWithString: "No receipt attached")
    receiptLabel.frame = NSRect(x: 300, y: 114, width: 220, height: 22)
    receiptLabel.identifier = NSUserInterfaceItemIdentifier("ReceiptLabel")
    receiptLabel.setAccessibilityIdentifier("ReceiptLabel")
    receiptLabel.setAccessibilityLabel("ReceiptLabel")
    content.addSubview(receiptLabel)

    let saveButton = NSButton(title: "Save", target: self, action: #selector(save(_:)))
    saveButton.frame = NSRect(x: 150, y: 48, width: 96, height: 32)
    saveButton.identifier = NSUserInterfaceItemIdentifier("SaveButton")
    saveButton.setAccessibilityIdentifier("SaveButton")
    saveButton.setAccessibilityLabel("SaveButton")
    content.addSubview(saveButton)

    statusLabel = NSTextField(labelWithString: "Ready")
    statusLabel.frame = NSRect(x: 266, y: 54, width: 250, height: 22)
    statusLabel.identifier = NSUserInterfaceItemIdentifier("StatusLabel")
    statusLabel.setAccessibilityIdentifier("StatusLabel")
    statusLabel.setAccessibilityLabel("StatusLabel")
    content.addSubview(statusLabel)

    writeState(status: "ready")
    window.makeKeyAndOrderFront(nil)
  }

  func windowDidMove(_ notification: Notification) {
    recordWindowEvent("moved")
  }

  func windowDidResize(_ notification: Notification) {
    recordWindowEvent("resized")
  }

  func windowWillClose(_ notification: Notification) {
    recordWindowEvent("closed")
  }

  func windowDidMiniaturize(_ notification: Notification) {
    recordWindowEvent("minimized")
  }

  func windowDidDeminiaturize(_ notification: Notification) {
    recordWindowEvent("restored")
  }

  @objc private func closeWindow(_ sender: Any?) {
    window.close()
  }

  private func addLabel(_ text: String, x: CGFloat, y: CGFloat, to content: NSView) {
    let label = NSTextField(labelWithString: text)
    label.frame = NSRect(x: x, y: y, width: 92, height: 22)
    content.addSubview(label)
  }

  @objc private func save(_ sender: Any?) {
    statusLabel.stringValue = "Saved \(nameInput.stringValue)"
    writeState(status: "saved")
  }

  @objc private func attachReceipt(_ sender: Any?) {
    let panel = NSOpenPanel()
    panel.title = "Attach Receipt"
    panel.message = "Select a receipt file for this native fixture."
    panel.prompt = "Attach"
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false
    panel.directoryURL = URL(fileURLWithPath: statePath).deletingLastPathComponent()
    panel.beginSheetModal(for: window) { [weak self] response in
      guard response == .OK, let selectedURL = panel.url else {
        return
      }
      self?.receiptLabel.stringValue = selectedURL.lastPathComponent
      self?.receiptPath = selectedURL.path
      self?.writeState(status: "attached")
    }
  }

  private func recordWindowEvent(_ event: String) {
    windowEventCount += 1
    lastWindowEvent = event
    writeState(status: "window-\(event)")
  }

  private func currentWindowBounds() -> [String: CGFloat] {
    guard let window else {
      return ["x": 0, "y": 0, "width": 0, "height": 0]
    }
    let frame = window.frame
    return [
      "x": frame.origin.x,
      "y": frame.origin.y,
      "width": frame.size.width,
      "height": frame.size.height
    ]
  }

  private func writeState(status: String) {
    let state: [String: Any] = [
      "title": windowTitle,
      "name": nameInput?.stringValue ?? "",
      "email": emailInput?.stringValue ?? "",
      "subscribed": subscribeButton?.state == .on,
      "priority": priorityInput?.stringValue ?? "",
      "receiptName": receiptLabel?.stringValue == "No receipt attached" ? "" : receiptLabel?.stringValue ?? "",
      "receiptPath": receiptPath,
      "windowBounds": currentWindowBounds(),
      "windowEventCount": windowEventCount,
      "lastWindowEvent": lastWindowEvent,
      "status": status
    ]
    do {
      let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
      try data.write(to: URL(fileURLWithPath: statePath), options: [.atomic])
    } catch {
      FileHandle.standardError.write(Data("state write failed: \(error)\n".utf8))
    }
  }
}

func argument(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

guard let statePath = argument("--state"), let title = argument("--title") else {
  FileHandle.standardError.write(Data("Missing --state or --title\n".utf8))
  exit(64)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate(statePath: statePath, windowTitle: title)
app.delegate = delegate
app.run()
`;

const INFO_PLIST = (bundleId: string, appName: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${appName}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
`;

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('macos-cua-driver-native-form-cli-smoke must run on macOS.');
  }

  await access(path.join(process.cwd(), 'dist-electron', 'cua-driver', 'cua-driver'), fsConstants.X_OK).catch(() => {
    throw new Error('Missing dist-electron/cua-driver/cua-driver. Run pnpm run build:electron before this smoke.');
  });

  const runId = `${Date.now()}-${process.pid}`;
  const appName = `InterpreterCUAFormSmoke-${runId}`;
  const bundleId = `dev.interpreter.cua.form-smoke.${process.pid}.${Date.now()}`;
  const title = `Interpreter Computer Use Native Form ${runId}`;
  const runDir = path.join(os.tmpdir(), `interpreter-desktop-driver-mac-native-form-${runId}`);
  const statePath = path.join(runDir, 'state.json');
  const uploadFileName = 'fixture-receipt-upload.txt';
  const uploadFilePath = path.join(runDir, uploadFileName);
  const appPath = path.join(os.homedir(), 'Applications', `${appName}.app`);
  let sidecar: ChildProcess | null = null;
  let fixtureProcess: ChildProcess | null = null;
  let launchedPid: number | null = null;
  let toolContext: ToolContext | null = null;
  let canonicalUploadFilePath = uploadFilePath;
  const stepDelayMs = parsePositiveIntEnv('MAC_CUA_SMOKE_STEP_DELAY_MS');
  const keepOpenMs = parsePositiveIntEnv('MAC_CUA_SMOKE_KEEP_OPEN_MS');
  const pauseOpenPanelMs = parsePositiveIntEnv('MAC_CUA_SMOKE_PAUSE_OPEN_PANEL_MS');
  const testFilePanel = process.env.MAC_CUA_SMOKE_FILE_PANEL === '1';
  const windowOnly = process.argv.includes('--window-only');
  const closeWindowOnly = process.argv.includes('--close-window-only');

  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(uploadFilePath, 'Interpreter Computer Use native upload smoke fixture\n', 'utf8');
    canonicalUploadFilePath = await realpath(uploadFilePath);
    await buildNativeFixtureApp(appPath, appName, bundleId);
    const initialFrontmost = await focusTerminalSentinel();
    console.log(`[mac-cua-cli-smoke] preserving frontmost=${initialFrontmost.name} pid=${initialFrontmost.pid}`);
    await assertAppIsBackground(appName, 'before fixture launch');

    sidecar = spawn('pnpm', [
      'run',
      'sidecar:tools:auto-approve',
      '--',
      '--port',
      'auto',
      '--stream-jsonl',
      '--quiet-startup',
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      detached: true,
    });

    const ready = await waitForServerReady(sidecar);
    toolContext = {
      cliPath: ready.interpreterCliPath,
      env: {
        ...process.env,
        INTERPRETER_CLI_SERVER_CONNECTION: ready.interpreterCliServerConnection,
        INTERPRETER_CALLER_TOKEN: ready.interpreterCallerToken,
      },
    };

    console.log(`[mac-cua-cli-smoke] cli=${ready.interpreterCliPath}`);
    console.log(`[mac-cua-cli-smoke] app=${appPath}`);

    const executablePath = path.join(appPath, 'Contents', 'MacOS', appName);
    fixtureProcess = spawn(executablePath, ['--state', statePath, '--title', title], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fixtureProcess.stdout?.setEncoding('utf8');
    fixtureProcess.stderr?.setEncoding('utf8');
    fixtureProcess.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.warn(`[mac-cua-cli-smoke] fixture stderr: ${text}`);
    });
    launchedPid = fixtureProcess.pid ?? null;
    if (launchedPid === null) {
      throw new Error('Native fixture did not expose a pid.');
    }
    console.log(`[mac-cua-cli-smoke] fixture pid=${launchedPid}`);
    await demoDelay(stepDelayMs);
    await assertAppIsBackground(appName, 'after fixture launch');
    await assertFrontmostUnchanged(initialFrontmost, 'after fixture launch');

    await waitFor(async () => {
      const state = await readJson(statePath);
      if (state.status !== 'ready') {
        throw new Error(`expected ready state, got ${JSON.stringify(state)}`);
      }
    }, 8_000, 'fixture ready state');

    const targetWindow = await findFixtureWindow(toolContext, launchedPid, title);
    const originalBounds = requireWindowBounds(targetWindow);
    const readyState = await readJson(statePath);
    const originalWindowEventCount = asNumber(readyState.windowEventCount, 'readyState.windowEventCount');
    const requestedBounds = buildMovedBounds(originalBounds);
    const targetIdentity = requireWindowTargetIdentity(targetWindow);
    console.log(
      `[mac-cua-cli-smoke] moving window target_identity.app.pid=${targetIdentity.app?.pid} target_identity.window.native_window_id=${targetIdentity.window?.native_window_id} `
        + `from=${formatBounds(originalBounds)} to=${formatBounds(requestedBounds)}`,
    );
    await callToolText(toolContext, 'set_window_bounds', {
      target_identity: targetIdentity,
      ...requestedBounds,
    });
    const movedWindow = await waitFor(async () => {
      const next = await findFixtureWindow(toolContext!, launchedPid!, title);
      const observed = requireWindowBounds(next);
      if (!boundsApproximatelyEqual(observed, requestedBounds)) {
        throw new Error(`expected moved bounds ${formatBounds(requestedBounds)}, got ${formatBounds(observed)}`);
      }
      return next;
    }, 8_000, 'window bounds update');
    const targetSideWindowState = await waitFor(async () => {
      const state = await readJson(statePath);
      const eventCount = asNumber(state.windowEventCount, 'windowEventCount');
      if (eventCount <= originalWindowEventCount) {
        throw new Error(`expected target-side window event count to increase above ${originalWindowEventCount}, got ${eventCount}`);
      }
      const bounds = targetSideBoundsFromState(state);
      if (!windowSizesApproximatelyEqual(bounds, requestedBounds)) {
        throw new Error(`expected target-side size ${formatSize(requestedBounds)}, got ${formatSize(bounds)} state=${JSON.stringify(state)}`);
      }
      return state;
    }, 8_000, 'target-side window event log');
    console.log(
      `[mac-cua-cli-smoke] moved bounds=${formatBounds(requireWindowBounds(movedWindow))} `
        + `target_event=${targetSideWindowState.lastWindowEvent} target_count=${targetSideWindowState.windowEventCount}`,
    );
    if (closeWindowOnly) {
      console.log(
        `[mac-cua-cli-smoke] closing window target_identity.app.pid=${targetIdentity.app?.pid} `
          + `target_identity.window.native_window_id=${targetIdentity.window?.native_window_id}`,
      );
      await callToolText(toolContext, 'close_window', {
        target_identity: targetIdentity,
      });
      await waitFor(async () => {
        const windows = await listWindows(toolContext!, { pid: launchedPid! });
        const stillPresent = windows.find((window) => {
          if (window.pid !== launchedPid || windowTitle(window) !== title) return false;
          return window.is_on_screen === true || window.isOnScreen === true;
        });
        if (stillPresent) {
          throw new Error(`closed fixture window still present: ${JSON.stringify(stillPresent)}`);
        }
      }, 8_000, 'closed fixture window absent from list_windows');
      const closedState = await waitFor(async () => {
        const state = await readJson(statePath);
        if (state.lastWindowEvent !== 'closed') {
          throw new Error(`expected target-side closed event, got ${JSON.stringify(state)}`);
        }
        return state;
      }, 8_000, 'target-side window close event');
      console.log(
        `[mac-cua-cli-smoke] closed window target_event=${closedState.lastWindowEvent} `
          + `target_count=${closedState.windowEventCount}`,
      );
      console.log('macOS Computer Use close_window CLI smoke passed.');
      return;
    }
    if (windowOnly) {
      const beforeLifecycleState = await readJson(statePath);
      const beforeLifecycleCount = asNumber(beforeLifecycleState.windowEventCount, 'beforeLifecycleState.windowEventCount');
      console.log(
        `[mac-cua-cli-smoke] minimizing window target_identity.app.pid=${targetIdentity.app?.pid} `
          + `target_identity.window.native_window_id=${targetIdentity.window?.native_window_id}`,
      );
      await callToolText(toolContext, 'minimize_window', {
        target_identity: targetIdentity,
      });
      await waitFor(async () => {
        const window = await findFixtureWindow(toolContext!, launchedPid!, title);
        if (windowIsOnScreen(window)) {
          throw new Error(`expected minimized fixture window to be off-screen: ${JSON.stringify(window)}`);
        }
      }, 8_000, 'minimized fixture window off-screen');
      await waitFor(async () => {
        const state = await readJson(statePath);
        if (state.lastWindowEvent !== 'minimized') {
          throw new Error(`expected target-side minimized event, got ${JSON.stringify(state)}`);
        }
        return state;
      }, 8_000, 'target-side window minimize event');

      console.log(
        `[mac-cua-cli-smoke] restoring window target_identity.app.pid=${targetIdentity.app?.pid} `
          + `target_identity.window.native_window_id=${targetIdentity.window?.native_window_id}`,
      );
      await callToolText(toolContext, 'restore_window', {
        target_identity: targetIdentity,
      });
      await waitFor(async () => {
        const window = await findFixtureWindow(toolContext!, launchedPid!, title);
        if (!windowIsOnScreen(window)) {
          throw new Error(`expected restored fixture window to be on-screen: ${JSON.stringify(window)}`);
        }
      }, 8_000, 'restored fixture window on-screen');
      await waitFor(async () => {
        const state = await readJson(statePath);
        if (state.lastWindowEvent !== 'restored') {
          throw new Error(`expected target-side restored event, got ${JSON.stringify(state)}`);
        }
        return state;
      }, 8_000, 'target-side window restore event');

      console.log(
        `[mac-cua-cli-smoke] focusing window target_identity.app.pid=${targetIdentity.app?.pid} `
          + `target_identity.window.native_window_id=${targetIdentity.window?.native_window_id}`,
      );
      await callToolText(toolContext, 'focus_window', {
        target_identity: targetIdentity,
      });
      await waitFor(async () => {
        const frontmost = await getFrontmostApp();
        if (frontmost.pid !== launchedPid) {
          throw new Error(`expected fixture pid ${launchedPid} to be frontmost, got ${frontmost.name} pid=${frontmost.pid}`);
        }
      }, 8_000, 'focused fixture window');

      const beforeMaximizeWindow = await findFixtureWindow(toolContext, launchedPid, title);
      const beforeMaximizeBounds = requireWindowBounds(beforeMaximizeWindow);
      console.log(
        `[mac-cua-cli-smoke] maximizing window target_identity.app.pid=${targetIdentity.app?.pid} `
          + `target_identity.window.native_window_id=${targetIdentity.window?.native_window_id}`,
      );
      await callToolText(toolContext, 'maximize_window', {
        target_identity: targetIdentity,
      });
      await waitFor(async () => {
        const window = await findFixtureWindow(toolContext!, launchedPid!, title);
        const bounds = requireWindowBounds(window);
        if (boundsApproximatelyEqual(bounds, beforeMaximizeBounds)) {
          throw new Error(`expected maximized bounds to change from ${formatBounds(beforeMaximizeBounds)}, got ${formatBounds(bounds)}`);
        }
        return window;
      }, 8_000, 'maximized fixture window bounds changed');
      const lifecycleState = await waitFor(async () => {
        const state = await readJson(statePath);
        const count = asNumber(state.windowEventCount, 'windowEventCount');
        if (count <= beforeLifecycleCount) {
          throw new Error(`expected lifecycle event count to increase above ${beforeLifecycleCount}, got ${count}`);
        }
        return state;
      }, 8_000, 'target-side lifecycle event count');
      console.log(
        `[mac-cua-cli-smoke] lifecycle target_event=${lifecycleState.lastWindowEvent} `
          + `target_count=${lifecycleState.windowEventCount}`,
      );

      console.log('macOS Computer Use window lifecycle/positioning/focus CLI smoke passed.');
      if (keepOpenMs > 0) {
        console.log(`[mac-cua-cli-smoke] keeping window-only fixture open for ${keepOpenMs}ms`);
        await demoDelay(keepOpenMs);
      }
      return;
    }

    const firstSnapshot = await getAppState(toolContext, title);
    const nameIndex = findElementIndex(firstSnapshot, ['NameInput']);
    const emailIndex = findElementIndex(firstSnapshot, ['EmailInput']);
    const uiElementsText = await callToolText(toolContext, 'get_ui_elements', {
      app: title,
      x: requestedBounds.x,
      y: requestedBounds.y,
      width: requestedBounds.width,
      height: requestedBounds.height,
    });
    for (const expected of [
      `element_index=${nameIndex}`,
      `element_index=${emailIndex}`,
      'NameInput',
      'EmailInput',
      'bounds={x=',
      'coordinate_space=screen_points',
      'display_id=unreported_by_cua_driver',
    ]) {
      if (!uiElementsText.includes(expected)) {
        throw new Error(`get_ui_elements output missing ${expected}:\n${uiElementsText}`);
      }
    }

    console.log(`[mac-cua-cli-smoke] indices name=${nameIndex} email=${emailIndex}`);

    await callToolText(toolContext, 'set_value', {
      app: title,
      element_index: nameIndex,
      value: 'Ada Lovelace',
    });
    await demoDelay(stepDelayMs);
    await callToolText(toolContext, 'set_value', {
      app: title,
      element_index: emailIndex,
      value: 'ada@example.com',
    });
    await demoDelay(stepDelayMs);

    const secondSnapshot = await getAppState(toolContext, title);
    await callToolText(toolContext, 'click', {
      app: title,
      element_index: findElementIndex(secondSnapshot, ['SubscribeCheckbox', 'Subscribe']),
    });
    await demoDelay(stepDelayMs);
    await callToolText(toolContext, 'set_value', {
      app: title,
      element_index: findElementIndex(secondSnapshot, ['PriorityInput']),
      value: 'High',
    });
    await demoDelay(stepDelayMs);

    if (testFilePanel) {
      const beforeAttachSnapshot = await getAppState(toolContext, title);
      await callToolText(toolContext, 'press_key', {
        app: title,
        key: 'space',
      });
      await callToolText(toolContext, 'click', {
        app: title,
        element_index: findElementIndex(beforeAttachSnapshot, ['AttachReceiptButton', 'Attach Receipt']),
      });
      await assertFrontmostUnchanged(initialFrontmost, 'after opening Open Panel');

      const panelSnapshot = await waitFor(async () => {
        const snapshot = await getAppState(toolContext, title);
        const text = JSON.stringify(snapshot);
        if (!text.includes(uploadFileName) || !text.includes('Attach')) {
          throw new Error('Open Panel did not expose expected file/action yet.');
        }
        return snapshot;
      }, 8_000, 'Open Panel AX tree');
      await writeOpenPanelDebugSnapshot('before-select', runId, panelSnapshot);
      if (pauseOpenPanelMs > 0) {
        console.log(`[mac-cua-cli-smoke] pausing with Open Panel visible for ${pauseOpenPanelMs}ms`);
        await demoDelay(pauseOpenPanelMs);
      }
      const fileRowIndex = findAncestorElementIndex(panelSnapshot, uploadFileName, 'row');
      const fileNameIndex = findElementIndex(panelSnapshot, [uploadFileName], {
        roleNeedles: ['text field'],
      });
      console.log(`[mac-cua-cli-smoke] open-panel file-row=${fileRowIndex} file-name=${fileNameIndex}`);
      await callToolText(toolContext, 'click', {
        app: title,
        element_index: fileRowIndex,
      });
      await assertFrontmostUnchanged(initialFrontmost, 'after AX-selecting Open Panel file row');
      await callToolText(toolContext, 'click', {
        app: title,
        element_index: fileRowIndex,
      });
      await assertFrontmostUnchanged(initialFrontmost, 'after clicking Open Panel file row');
      await callToolText(toolContext, 'press_key', { app: title, key: 'return' });
      await assertFrontmostUnchanged(initialFrontmost, 'after committing Open Panel file row');

      const afterFileCommit = await readJson(statePath);
      if (afterFileCommit.status === 'attached') {
        await assertFrontmostUnchanged(initialFrontmost, 'after direct Open Panel attachment');
      } else {

        const selectedPanelSnapshot = await getAppState(toolContext, title);
        await writeOpenPanelDebugSnapshot('after-select', runId, selectedPanelSnapshot);
        const attachIndex = findElementIndex(selectedPanelSnapshot, ['Attach'], {
          exactName: 'Attach',
        });
        console.log(`[mac-cua-cli-smoke] open-panel attach=${attachIndex}`);
        await callToolText(toolContext, 'click', {
          app: title,
          element_index: attachIndex,
        });
        await callToolText(toolContext, 'press_key', {
          app: title,
          key: 'return',
        });
        await assertFrontmostUnchanged(initialFrontmost, 'after confirming Open Panel');
        await waitFor(async () => {
          const attached = await readJson(statePath);
          if (attached.receiptName !== uploadFileName || attached.receiptPath !== canonicalUploadFilePath || attached.status !== 'attached') {
            throw new Error(`expected attached receipt, got ${JSON.stringify(attached)}`);
          }
        }, 8_000, 'Open Panel attached state');
      }
    }

    const beforeSaveSnapshot = await getAppState(toolContext, title);
    await callToolText(toolContext, 'click', {
      app: title,
      element_index: findElementIndex(beforeSaveSnapshot, ['SaveButton', 'Save']),
    });
    await demoDelay(stepDelayMs);
    await assertAppIsBackground(appName, 'after save');

    await waitFor(async () => {
      const saved = await readJson(statePath);
      const expected = {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        subscribed: true,
        priority: 'High',
        receiptName: testFilePanel ? uploadFileName : '',
        receiptPath: testFilePanel ? canonicalUploadFilePath : '',
        status: 'saved',
      };
      for (const [key, value] of Object.entries(expected)) {
        if (saved[key] !== value) {
          throw new Error(`expected ${key}=${JSON.stringify(value)}, got ${JSON.stringify(saved[key])}; saved=${JSON.stringify(saved)}`);
        }
      }
    }, 8_000, 'fixture saved state');

    console.log('macOS Computer Use native form CLI smoke passed.');
    if (keepOpenMs > 0) {
      console.log(`[mac-cua-cli-smoke] keeping filled form open for ${keepOpenMs}ms`);
      await demoDelay(keepOpenMs);
    }
  } finally {
    await Promise.all([
      terminateChild(fixtureProcess, launchedPid),
      terminateChild(sidecar),
    ]);
    await rm(appPath, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
}

async function terminateChild(child: ChildProcess | null, pid?: number | null): Promise<void> {
  if (child?.exitCode !== null || (child && child.signalCode !== null)) {
    return;
  }

  const targetPid = pid ?? child?.pid ?? null;
  if (targetPid !== null) {
    try {
      process.kill(-targetPid, 'SIGTERM');
    } catch {}
    try {
      process.kill(targetPid, 'SIGTERM');
    } catch {}
  }

  if (!child) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      const forcePid = pid ?? child.pid;
      if (forcePid) {
        try {
          process.kill(-forcePid, 'SIGKILL');
        } catch {}
        try {
          process.kill(forcePid, 'SIGKILL');
        } catch {}
      }
      resolve();
    }, 2_000);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function buildNativeFixtureApp(appPath: string, appName: string, bundleId: string): Promise<void> {
  await rm(appPath, { recursive: true, force: true });
  const contentsDir = path.join(appPath, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const sourceDir = path.join(contentsDir, 'Source');
  await mkdir(macosDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, 'main.swift');
  const executablePath = path.join(macosDir, appName);
  await writeFile(sourcePath, FIXTURE_SWIFT, 'utf8');
  await writeFile(path.join(contentsDir, 'Info.plist'), INFO_PLIST(bundleId, appName), 'utf8');
  await execFileChecked('swiftc', ['-framework', 'Cocoa', '-o', executablePath, sourcePath], {
    cwd: process.cwd(),
    timeoutMs: 60_000,
  });
}

async function waitForServerReady(child: ChildProcess): Promise<ServerReady> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for sidecar server_ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onStdout = (chunk: string) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(trimmed) as Partial<ServerReady> & { type?: string };
          if (
            parsed.type === 'server_ready'
            && parsed.interpreterCliPath
            && parsed.interpreterCliServerConnection
            && parsed.interpreterCallerToken
          ) {
            cleanup();
            resolve({
              interpreterCliPath: parsed.interpreterCliPath,
              interpreterCliServerConnection: parsed.interpreterCliServerConnection,
              interpreterCallerToken: parsed.interpreterCallerToken,
            });
            return;
          }
        } catch {}
      }
    };
    const onStderr = (chunk: string) => {
      stderr += chunk;
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Sidecar exited before server_ready code=${code} signal=${signal ?? 'none'}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

async function callToolText(context: ToolContext, toolName: string, args: Record<string, unknown>): Promise<string> {
  return (await callTool(context, toolName, args)).text;
}

async function listWindows(context: ToolContext, args: Record<string, unknown> = {}): Promise<CuaWindowRecord[]> {
  const text = await callToolText(context, 'list_windows', args);
  const parsed = parseJsonText(text);
  if (Array.isArray(parsed)) return parsed as CuaWindowRecord[];
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.windows)) return record.windows as CuaWindowRecord[];
    if (Array.isArray(record.data)) return record.data as CuaWindowRecord[];
  }
  throw new Error(`list_windows returned unexpected payload: ${text.slice(0, 1000)}`);
}

async function findFixtureWindow(context: ToolContext, pid: number, title: string): Promise<CuaWindowRecord> {
  const windows = await listWindows(context, { pid });
  const match = windows.find((window) => window.pid === pid && windowRecordId(window) !== null && windowTitle(window) === title)
    ?? windows.find((window) => window.pid === pid && windowRecordId(window) !== null && windowTitle(window).includes(title))
    ?? windows.find((window) => window.pid === pid && windowRecordId(window) !== null);
  if (!match) {
    throw new Error(`No fixture window found for pid=${pid} title=${JSON.stringify(title)} windows=${JSON.stringify(windows).slice(0, 4000)}`);
  }
  return match;
}

function windowRecordId(window: CuaWindowRecord): number {
  const raw = window.window_id ?? window.id;
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  throw new Error(`Window record has no numeric id: ${JSON.stringify(window)}`);
}

function requireWindowTargetIdentity(window: CuaWindowRecord): NonNullable<CuaWindowRecord['target_identity']> {
  const targetIdentity = window.target_identity;
  if (
    !targetIdentity
    || targetIdentity.kind !== 'app-window'
    || typeof targetIdentity.app?.pid !== 'number'
    || typeof targetIdentity.window?.native_window_id !== 'number'
  ) {
    throw new Error(`Window record has no numeric app-window target_identity: ${JSON.stringify(window)}`);
  }
  return targetIdentity;
}

function windowTitle(window: CuaWindowRecord): string {
  return window.name ?? window.title ?? '';
}

function windowIsOnScreen(window: CuaWindowRecord): boolean {
  const raw = (window as { is_on_screen?: unknown; isOnScreen?: unknown }).is_on_screen
    ?? (window as { is_on_screen?: unknown; isOnScreen?: unknown }).isOnScreen;
  return raw === true;
}

function requireWindowBounds(window: CuaWindowRecord): WindowBounds {
  const bounds = window.bounds;
  if (
    !bounds
    || typeof bounds.x !== 'number'
    || typeof bounds.y !== 'number'
    || typeof bounds.width !== 'number'
    || typeof bounds.height !== 'number'
  ) {
    throw new Error(`Window record has no complete bounds: ${JSON.stringify(window)}`);
  }
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function buildMovedBounds(original: WindowBounds): WindowBounds {
  return {
    x: Math.round(original.x + 34),
    y: Math.round(original.y + 28),
    width: Math.round(original.width + 24),
    height: Math.round(original.height + 18),
  };
}

function boundsApproximatelyEqual(left: WindowBounds, right: WindowBounds): boolean {
  return Math.abs(left.x - right.x) <= 2
    && Math.abs(left.y - right.y) <= 2
    && Math.abs(left.width - right.width) <= 2
    && Math.abs(left.height - right.height) <= 2;
}

function windowSizesApproximatelyEqual(left: WindowBounds, right: WindowBounds): boolean {
  return Math.abs(left.width - right.width) <= 2
    && Math.abs(left.height - right.height) <= 2;
}

function formatBounds(bounds: WindowBounds): string {
  return `x=${Math.round(bounds.x)} y=${Math.round(bounds.y)} w=${Math.round(bounds.width)} h=${Math.round(bounds.height)}`;
}

function formatSize(bounds: WindowBounds): string {
  return `w=${Math.round(bounds.width)} h=${Math.round(bounds.height)}`;
}

function targetSideBoundsFromState(state: any): WindowBounds {
  const bounds = state.windowBounds;
  if (
    !bounds
    || typeof bounds.x !== 'number'
    || typeof bounds.y !== 'number'
    || typeof bounds.width !== 'number'
    || typeof bounds.height !== 'number'
  ) {
    throw new Error(`state.windowBounds is missing or incomplete: ${JSON.stringify(state)}`);
  }
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

async function getAppState(context: ToolContext, app: string): Promise<{ tree_markdown: string; elements: Array<Record<string, unknown>> }> {
  const text = await callToolText(context, 'get_app_state', { app });
  const jsonText = text.split(/\nImage content is available at:/)[0]?.trim() ?? '';
  if (jsonText.startsWith('{')) {
    const parsed = JSON.parse(jsonText) as { elements?: Array<Record<string, unknown>> };
    return {
      ...parsed,
      tree_markdown: text,
      elements: Array.isArray(parsed.elements) ? parsed.elements : [],
    };
  }
  return { tree_markdown: text, elements: [] };
}

async function callTool(context: ToolContext, toolName: string, args: Record<string, unknown>): Promise<{ text: string; structuredContent?: unknown }> {
  console.log(`[mac-cua-cli-smoke] interpreter-app tools builtin-cua-driver ${toolName} --json '${JSON.stringify(args)}'`);
  const { stdout, stderr } = await execFileChecked(context.cliPath, [
    'tools',
    'builtin-cua-driver',
    toolName,
    '--json',
    JSON.stringify(args),
  ], {
    cwd: process.cwd(),
    env: context.env,
    timeoutMs: 90_000,
  });
  const parsed = JSON.parse(stdout) as ToolResponse;
  if (parsed.isError) {
    throw new Error(`${toolName} returned isError=true:\n${stdout}\n${stderr}`);
  }
  const text = (parsed.content ?? [])
    .filter((item): item is ToolContent & { text: string } => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n');
  if (!text && stderr.trim()) {
    throw new Error(`${toolName} returned no text:\n${stderr}`);
  }
  return { text, structuredContent: parsed.structuredContent };
}

function findElementIndex(snapshot: any, needles: string[], options: ElementSearchOptions = {}): string {
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements as Array<Record<string, unknown>> : [];
  const candidates: Array<{ element: Record<string, unknown>; score: number }> = [];
  for (const element of elements) {
    const haystack = JSON.stringify(element);
    const elementIndex = element.element_index;
    if (typeof elementIndex !== 'string' && !Number.isInteger(elementIndex)) {
      continue;
    }
    if (options.excludeNeedles?.some((needle) => haystack.includes(needle))) {
      continue;
    }
    if (options.roleNeedles?.length) {
      const role = String(element.role ?? '');
      if (!options.roleNeedles.some((needle) => role.toLowerCase().includes(needle.toLowerCase()))) {
        continue;
      }
    }
    if (!needles.some((needle) => haystack.includes(needle))) {
      continue;
    }

    let score = 1;
    if (options.exactName && String(element.name ?? '') === options.exactName) {
      score += 100;
    }
    if (options.exactName && String(element.value ?? '') === options.exactName) {
      score += 50;
    }
    candidates.push({ element, score });
  }

  if (candidates.length > 0) {
    candidates.sort((left, right) => right.score - left.score);
    return String(candidates[0].element.element_index);
  }

  const markdown = typeof snapshot.tree_markdown === 'string' ? snapshot.tree_markdown : '';
  for (const line of markdown.split(/\r?\n/)) {
    if (!needles.some((needle) => line.includes(needle))) continue;
    if (options.excludeNeedles?.some((needle) => line.includes(needle))) continue;
    if (options.roleNeedles?.length && !options.roleNeedles.some((needle) => line.toLowerCase().includes(needle.toLowerCase()))) continue;
    const match = line.match(/^\s*(?:-\s*)?(?:\[(?:element_index\s+)?(\d+)\]|(\d+)\b)/);
    if (match) return String(match[1] ?? match[2]);
  }

  throw new Error(`Could not find element for ${needles.join(' or ')} in snapshot:\n${JSON.stringify(snapshot, null, 2).slice(0, 8000)}`);
}

function findAncestorElementIndex(snapshot: any, needle: string, ancestorRole: string): number {
  const markdown = typeof snapshot.tree_markdown === 'string' ? snapshot.tree_markdown : '';
  const stack: Array<{ depth: number; role: string; index: number }> = [];
  const expectedRole = normalizeMarkdownRole(ancestorRole);
  for (const line of markdown.split(/\r?\n/)) {
    const depth = line.match(/^[\t ]*/)?.[0].replace(/ /g, '\t').length ?? 0;
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    const match = line.match(/^\s*(?:-\s*)?(?:\[(?:element_index\s+)?(\d+)\]|(\d+)\b)\s+([^,]+)/);
    if (match) {
      stack.push({
        depth,
        index: Number(match[1] ?? match[2]),
        role: normalizeMarkdownRole(match[3]),
      });
    }
    if (!line.includes(needle)) {
      continue;
    }
    const ancestor = [...stack].reverse().find((entry) => entry.role === expectedRole);
    if (ancestor) {
      return ancestor.index;
    }
    if (match) {
      return Number(match[1] ?? match[2]);
    }
  }
  throw new Error(`Could not find ${ancestorRole} ancestor for ${needle} in snapshot:\n${JSON.stringify(snapshot, null, 2).slice(0, 8000)}`);
}

function normalizeMarkdownRole(role: string): string {
  return role
    .replace(/^AX/, '')
    .replace(/\s+Secondary Actions:.*$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  for (const candidate of [
    trimmed,
    trimmed.slice(trimmed.indexOf('{')),
    trimmed.slice(trimmed.indexOf('[')),
  ]) {
    if (!candidate || candidate === trimmed.slice(-1)) continue;
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  const line = trimmed.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith('{') || entry.startsWith('['));
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function readJson(filePath: string): Promise<any> {
  const content = await readFile(filePath, 'utf8');
  return JSON.parse(content.replace(/^\uFEFF/, ''));
}

async function writeOpenPanelDebugSnapshot(label: string, runId: string, snapshot: unknown): Promise<void> {
  if (process.env.MAC_CUA_SMOKE_DEBUG_OPEN_PANEL !== '1') return;
  const outputDir = path.join(process.cwd(), 'output', 'cua-open-panel');
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, `${runId}-${label}.json`),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} is not a number: ${JSON.stringify(value)}`);
  }
  return value;
}

async function assertAppIsBackground(targetAppName: string, label: string): Promise<void> {
  const frontmost = await getFrontmostApp();
  console.log(`[mac-cua-cli-smoke] background-check ${label}: frontmost=${frontmost.name} pid=${frontmost.pid}`);
  if (frontmost.name === targetAppName) {
    throw new Error(`${label}: ${targetAppName} became frontmost; CUA smoke must run against a background app.`);
  }
}

async function focusTerminalSentinel(): Promise<FrontmostApp> {
  await execFileChecked('osascript', [
    '-e',
    'tell application "Terminal" to activate',
  ], {
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  await assertFrontmostAppName('Terminal', 'foreground Terminal');
  return getFrontmostApp();
}

async function assertFrontmostUnchanged(expected: FrontmostApp, label: string): Promise<void> {
  const frontmost = await getFrontmostApp();
  if (frontmost.pid !== expected.pid || frontmost.name !== expected.name) {
    throw new Error(`${label}: frontmost changed from ${expected.name} pid=${expected.pid} to ${frontmost.name} pid=${frontmost.pid}`);
  }
}

async function assertFrontmostAppName(expectedName: string, label: string): Promise<void> {
  const frontmost = await getFrontmostApp();
  if (frontmost.name !== expectedName) {
    throw new Error(`${label}: expected frontmost ${expectedName}, got ${frontmost.name} pid=${frontmost.pid}`);
  }
}

async function getFrontmostApp(): Promise<FrontmostApp> {
  const { stdout } = await execFileChecked('osascript', [
    '-e',
    'tell application "System Events" to tell first application process whose frontmost is true to return (name as text) & "\t" & (unix id as text)',
  ], {
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  const [name = '', pidText = ''] = stdout.split('\t');
  const pid = Number.parseInt(pidText, 10);
  return {
    name: name.trim(),
    pid: Number.isFinite(pid) ? pid : null,
  };
}

async function execFileChecked(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, options.timeoutMs);
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
        reject(new Error(`${command} failed code=${code} signal=${signal ?? 'none'}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function waitFor<T>(check: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function parsePositiveIntEnv(name: string): number {
  const raw = process.env[name]?.trim();
  if (!raw) return 0;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function demoDelay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

void main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
