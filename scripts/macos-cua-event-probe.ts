import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SWIFT = String.raw`
import Cocoa

final class EventLog {
  static let shared = EventLog()
  let path = CommandLine.arguments.dropFirst().first ?? "/tmp/interpreter-desktop-driver-event-probe.jsonl"
  let formatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZZZZZ"
    return f
  }()

  func record(_ event: NSEvent, note: String? = nil) {
    var payload: [String: Any] = [
      "ts": formatter.string(from: Date()),
      "type": String(describing: event.type),
      "locationInWindow": ["x": event.locationInWindow.x, "y": event.locationInWindow.y],
      "windowNumber": event.windowNumber,
      "clickCount": event.clickCount,
      "keyCode": event.keyCode,
      "modifierFlagsRaw": event.modifierFlags.rawValue,
      "characters": event.characters ?? "",
      "charactersIgnoringModifiers": event.charactersIgnoringModifiers ?? "",
      "isARepeat": event.isARepeat
    ]
    if let window = event.window {
      payload["windowTitle"] = window.title
    }
    if let note {
      payload["note"] = note
    }
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
       let line = String(data: data, encoding: .utf8) {
      FileHandle.standardError.write(Data((line + "\n").utf8))
      if FileManager.default.fileExists(atPath: path),
         let handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: path)) {
        defer { try? handle.close() }
        try? handle.seekToEnd()
        try? handle.write(contentsOf: Data((line + "\n").utf8))
      } else {
        try? (line + "\n").write(toFile: path, atomically: true, encoding: .utf8)
      }
    }
  }

  func note(_ value: String) {
    let payload: [String: Any] = [
      "ts": formatter.string(from: Date()),
      "note": value
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
       let line = String(data: data, encoding: .utf8) {
      FileHandle.standardError.write(Data((line + "\n").utf8))
      append(line)
    }
  }

  private func append(_ line: String) {
    if FileManager.default.fileExists(atPath: path),
       let handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: path)) {
      defer { try? handle.close() }
      try? handle.seekToEnd()
      try? handle.write(contentsOf: Data((line + "\n").utf8))
    } else {
      try? (line + "\n").write(toFile: path, atomically: true, encoding: .utf8)
    }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var textField: NSTextField!
  var status: NSTextField!

  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: 220, y: 220, width: 520, height: 260),
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    window.title = "Interpreter Computer Use Event Probe"
    window.isReleasedWhenClosed = false

    let content = NSView(frame: NSRect(x: 0, y: 0, width: 520, height: 260))
    window.contentView = content

    let button = NSButton(title: "Probe Button", target: self, action: #selector(buttonPressed(_:)))
    button.frame = NSRect(x: 32, y: 180, width: 140, height: 36)
    button.identifier = NSUserInterfaceItemIdentifier("ProbeButton")
    button.setAccessibilityIdentifier("ProbeButton")
    button.setAccessibilityLabel("ProbeButton")
    content.addSubview(button)

    let panelButton = NSButton(title: "Open Panel", target: self, action: #selector(openPanel(_:)))
    panelButton.frame = NSRect(x: 190, y: 180, width: 140, height: 36)
    panelButton.identifier = NSUserInterfaceItemIdentifier("OpenPanelButton")
    panelButton.setAccessibilityIdentifier("OpenPanelButton")
    panelButton.setAccessibilityLabel("OpenPanelButton")
    content.addSubview(panelButton)

    textField = NSTextField(frame: NSRect(x: 32, y: 124, width: 300, height: 28))
    textField.identifier = NSUserInterfaceItemIdentifier("ProbeTextField")
    textField.setAccessibilityIdentifier("ProbeTextField")
    textField.setAccessibilityLabel("ProbeTextField")
    content.addSubview(textField)

    status = NSTextField(labelWithString: "Ready")
    status.frame = NSRect(x: 32, y: 72, width: 420, height: 24)
    status.identifier = NSUserInterfaceItemIdentifier("ProbeStatus")
    status.setAccessibilityIdentifier("ProbeStatus")
    status.setAccessibilityLabel("ProbeStatus")
    content.addSubview(status)

    EventLog.shared.note("launched")
    window.makeKeyAndOrderFront(nil)
  }

  @objc func buttonPressed(_ sender: Any?) {
    status.stringValue = "Button pressed"
    EventLog.shared.note("button-action")
  }

  @objc func openPanel(_ sender: Any?) {
    EventLog.shared.note("open-panel-requested")
    let panel = NSOpenPanel()
    panel.title = "Probe Open Panel"
    panel.prompt = "Choose"
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false
    panel.beginSheetModal(for: window) { response in
      EventLog.shared.note("open-panel-response:\(response.rawValue):\(panel.url?.path ?? "")")
      self.status.stringValue = panel.url?.lastPathComponent ?? "No file"
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
NSEvent.addLocalMonitorForEvents(matching: .any) { event in
  EventLog.shared.record(event)
  return event
}
app.run()
`;

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>InterpreterCUAEventProbe</string>
  <key>CFBundleIdentifier</key><string>dev.interpreter.cua.eventprobe</string>
  <key>CFBundleName</key><string>Interpreter Computer Use Event Probe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`;

async function main() {
  const appPath = path.join(os.homedir(), 'Applications', 'Interpreter Computer Use Event Probe.app');
  const contents = path.join(appPath, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const source = path.join(contents, 'Source');
  const logPath = path.join(os.tmpdir(), 'interpreter-desktop-driver-event-probe.jsonl');
  await rm(appPath, { recursive: true, force: true });
  await rm(logPath, { force: true });
  await mkdir(macos, { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'main.swift'), SWIFT, 'utf8');
  await writeFile(path.join(contents, 'Info.plist'), PLIST, 'utf8');

  await new Promise<void>((resolve, reject) => {
    const child = spawn('swiftc', ['-framework', 'Cocoa', '-o', path.join(macos, 'InterpreterCUAEventProbe'), path.join(source, 'main.swift')], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`swiftc exited ${code}`)));
    child.on('error', reject);
  });

  const child = spawn(path.join(macos, 'InterpreterCUAEventProbe'), [logPath], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  console.log(JSON.stringify({
    appName: 'Interpreter Computer Use Event Probe',
    bundleId: 'dev.interpreter.cua.eventprobe',
    appPath,
    logPath,
    pid: child.pid,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
