#!/usr/bin/env swift
import Cocoa
import ApplicationServices

func getExcludedPIDs() -> Set<Int32> {
  guard let raw = ProcessInfo.processInfo.environment["INTERPRETER_OVERLAY_EXCLUDED_PID"] else {
    return []
  }

  return Set(
    raw.split(separator: ",")
      .compactMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
  )
}

guard CommandLine.arguments.count >= 3 else {
  print("error: usage: focus-window <x> <y>")
  exit(1)
}

guard let x = Int(CommandLine.arguments[1]),
      let y = Int(CommandLine.arguments[2]) else {
  print("error: invalid coordinates")
  exit(1)
}

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let windowList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
  print("error: could not get window list")
  exit(1)
}

let skipOwners: Set<String> = [
  "Window Server", "Dock", "Control Center", "Notification Center",
  "loginwindow", "Spotlight", "ScreensaverEngine", "Interpreter Next",
  "progressive-blur",
  "Interpreter Overlay", "Workstation", "Interpreter"
]
let excludedPIDs = getExcludedPIDs()

func cgRectFromWindowBounds(_ boundsDict: [String: CGFloat]) -> CGRect {
  CGRect(
    x: boundsDict["X"] ?? 0,
    y: boundsDict["Y"] ?? 0,
    width: boundsDict["Width"] ?? 0,
    height: boundsDict["Height"] ?? 0
  )
}

func pointFromAXValue(_ value: AnyObject?) -> CGPoint? {
  guard let axValue = value, CFGetTypeID(axValue) == AXValueGetTypeID() else {
    return nil
  }

  var point = CGPoint.zero
  let success = AXValueGetValue(axValue as! AXValue, .cgPoint, &point)
  return success ? point : nil
}

func sizeFromAXValue(_ value: AnyObject?) -> CGSize? {
  guard let axValue = value, CFGetTypeID(axValue) == AXValueGetTypeID() else {
    return nil
  }

  var size = CGSize.zero
  let success = AXValueGetValue(axValue as! AXValue, .cgSize, &size)
  return success ? size : nil
}

func copyAXAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
  var value: CFTypeRef?
  let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
  guard result == .success else {
    return nil
  }
  return value
}

func windowMatchesTarget(_ window: AXUIElement, title: String, bounds: CGRect) -> Bool {
  let windowTitle = (copyAXAttribute(window, kAXTitleAttribute) as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  let position = pointFromAXValue(copyAXAttribute(window, kAXPositionAttribute))
  let size = sizeFromAXValue(copyAXAttribute(window, kAXSizeAttribute))

  if !title.isEmpty && windowTitle == title {
    return true
  }

  guard let position, let size else {
    return false
  }

  let axRect = CGRect(origin: position, size: size)
  return abs(axRect.origin.x - bounds.origin.x) <= 4
    && abs(axRect.origin.y - bounds.origin.y) <= 4
    && abs(axRect.size.width - bounds.size.width) <= 6
    && abs(axRect.size.height - bounds.size.height) <= 6
}

func raiseMatchingWindow(pid: Int32, title: String, bounds: CGRect) -> Bool {
  let applicationElement = AXUIElementCreateApplication(pid)
  guard let windows = copyAXAttribute(applicationElement, kAXWindowsAttribute) as? [AXUIElement] else {
    return false
  }

  for window in windows {
    guard windowMatchesTarget(window, title: title, bounds: bounds) else {
      continue
    }

    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    _ = AXUIElementSetAttributeValue(applicationElement, kAXFocusedWindowAttribute as CFString, window)
    _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    return true
  }

  return false
}

for window in windowList {
  guard let ownerName = window[kCGWindowOwnerName as String] as? String,
        !skipOwners.contains(ownerName),
        let boundsDict = window[kCGWindowBounds as String] as? [String: CGFloat],
        let pid = window[kCGWindowOwnerPID as String] as? Int32 else {
    continue
  }

  if excludedPIDs.contains(pid) {
    continue
  }

  let windowName = (window[kCGWindowName as String] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  if ownerName == "Electron" && (windowName == "Interpreter" || windowName == "Interpreter Overlay") {
    continue
  }

  let layer = window[kCGWindowLayer as String] as? Int ?? 0
  if layer >= 24 {
    continue
  }

  let wx = Int(boundsDict["X"] ?? 0)
  let wy = Int(boundsDict["Y"] ?? 0)
  let ww = Int(boundsDict["Width"] ?? 0)
  let wh = Int(boundsDict["Height"] ?? 0)
  let cgBounds = cgRectFromWindowBounds(boundsDict)

  if x >= wx && x < wx + ww && y >= wy && y < wy + wh {
    if let app = NSRunningApplication(processIdentifier: pid) {
      app.activate(options: [.activateIgnoringOtherApps])
      let raised = raiseMatchingWindow(pid: pid, title: windowName, bounds: cgBounds)
      Thread.sleep(forTimeInterval: 0.012)
      print("activated owner=\(ownerName) pid=\(pid) window=\(windowName.isEmpty ? "<untitled>" : windowName) raised=\(raised)")
      exit(0)
    }
  }
}

print("no_window")
exit(0)
