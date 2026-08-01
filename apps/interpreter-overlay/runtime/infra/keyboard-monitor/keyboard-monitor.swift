import ApplicationServices
import CoreGraphics
import Foundation

// Pure polling keyboard monitor.
//
// Intentionally does NOT call CGEvent.tapCreate (which would require the
// Input Monitoring TCC grant and trigger the "receive keystrokes from any
// application" dialog). Instead we poll CGEventSource state at a fixed
// interval:
//
//   - CGEventSource.flagsState(.hidSystemState)          -> Ctrl, Shift
//   - CGEventSource.keyState(.hidSystemState, key: 53)   -> Esc
//   - CGEventSource.buttonState(.hidSystemState, .left)  -> mouse drag selection
//   - CGEvent(source: nil)?.location                      -> pointer position
//
// Both of these read current HID state without the ListenEvent TCC bucket.
// Space is intentionally not tracked here — Ctrl+Space is registered via
// Electron's globalShortcut (Carbon RegisterEventHotKey), which also does
// not prompt.

let pollIntervalSeconds: TimeInterval = 0.02
let escapeKeyCode: CGKeyCode = 53

private func emit(_ line: String) {
  FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

private func runProbeAndExit() -> Never {
  let access = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent).rawValue
  emit("PROBE listenEventAccess=\(access)")
  exit(0)
}

if CommandLine.arguments.contains("--probe") {
  runProbeAndExit()
}

final class KeyboardMonitor {
  private var ctrlHeld = false
  private var shiftHeld = false
  private var escHeld = false
  private var leftMouseHeld = false
  private var lastMouseX: Int?
  private var lastMouseY: Int?

  func run() {
    emit("READY")
    let timer = Timer(timeInterval: pollIntervalSeconds, repeats: true) { _ in
      self.poll()
    }
    timer.tolerance = pollIntervalSeconds / 2
    RunLoop.current.add(timer, forMode: .common)
    RunLoop.current.run()
  }

  private func poll() {
    let flags = CGEventSource.flagsState(.hidSystemState)
    let isCtrl = flags.contains(.maskControl)
    if isCtrl != ctrlHeld {
      ctrlHeld = isCtrl
      emit(isCtrl ? "CTRL_DOWN" : "CTRL_UP")
    }

    let isShift = flags.contains(.maskShift)
    if isShift != shiftHeld {
      shiftHeld = isShift
      emit(isShift ? "SHIFT_DOWN" : "SHIFT_UP")
    }

    let isEsc = CGEventSource.keyState(.hidSystemState, key: escapeKeyCode)
    if isEsc != escHeld {
      escHeld = isEsc
      if isEsc {
        emit("ESC")
      }
    }

    guard let event = CGEvent(source: nil) else {
      return
    }

    let point = event.location
    let mouseX = Int(point.x.rounded())
    let mouseY = Int(point.y.rounded())
    let isLeftMouse = CGEventSource.buttonState(.hidSystemState, button: .left)

    if isLeftMouse != leftMouseHeld {
      leftMouseHeld = isLeftMouse
      lastMouseX = mouseX
      lastMouseY = mouseY
      emit(isLeftMouse ? "MOUSE_DOWN \(mouseX) \(mouseY) 0" : "MOUSE_UP \(mouseX) \(mouseY) 0")
      return
    }

    if leftMouseHeld && (lastMouseX != mouseX || lastMouseY != mouseY) {
      lastMouseX = mouseX
      lastMouseY = mouseY
      emit("MOUSE_MOVE \(mouseX) \(mouseY)")
    }
  }
}

KeyboardMonitor().run()
