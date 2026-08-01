#!/usr/bin/env swift
import Cocoa

func getExcludedPIDs() -> Set<Int32> {
  guard let raw = ProcessInfo.processInfo.environment["INTERPRETER_OVERLAY_EXCLUDED_PID"] else {
    return []
  }
  return Set(
    raw.split(separator: ",")
      .compactMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
  )
}

let skipOwners: Set<String> = [
  "Window Server", "Dock", "Control Center", "Notification Center",
  "loginwindow", "Spotlight", "ScreensaverEngine",
  "Interpreter Next", "progressive-blur",
  "Interpreter Overlay", "Workstation",
  // The embedded CUA driver renders its virtual cursor through a full-screen
  // borderless window at the normal window level. It is Interpreter runtime
  // chrome, never a valid user target.
  "cua-driver",
]

func windowEntry(_ entry: [String: Any]) -> (
  pid: Int32, cgWindowId: UInt32, owner: String, title: String,
  x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, layer: Int
)? {
  guard let pid = entry[kCGWindowOwnerPID as String] as? Int32,
        let owner = entry[kCGWindowOwnerName as String] as? String,
        let bounds = entry[kCGWindowBounds as String] as? [String: CGFloat] else {
    return nil
  }
  let cgWindowId = (entry[kCGWindowNumber as String] as? UInt32)
    ?? UInt32((entry[kCGWindowNumber as String] as? Int) ?? 0)
  let title = (entry[kCGWindowName as String] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  let layer = entry[kCGWindowLayer as String] as? Int ?? 0
  return (
    pid, cgWindowId, owner, title,
    bounds["X"] ?? 0, bounds["Y"] ?? 0, bounds["Width"] ?? 0, bounds["Height"] ?? 0,
    layer
  )
}

func emitWindow(
  pid: Int32, cgWindowId: UInt32, owner: String, title: String,
  x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat
) {
  let safeOwner = owner.replacingOccurrences(of: "\n", with: " ")
  let safeTitle = title.replacingOccurrences(of: "\n", with: " ")
  let appBundle = NSRunningApplication(processIdentifier: pid)?.bundleURL?.path ?? ""
  let safeAppBundle = appBundle.replacingOccurrences(of: "\n", with: " ")
  print("ok pid=\(pid) cgWindowId=\(cgWindowId) x=\(Int(x)) y=\(Int(y)) w=\(Int(w)) h=\(Int(h)) owner=\(safeOwner) title=\(safeTitle) appBundle=\(safeAppBundle)")
}

func cmdAt(x: Int, y: Int) {
  let excluded = getExcludedPIDs()
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    print("error no_window_list")
    exit(1)
  }
  // Find the first front-to-back window under the point that is not system
  // chrome or an explicitly excluded helper process.
  for raw in list {
    guard let w = windowEntry(raw) else { continue }
    if w.layer >= 24 { continue }
    if skipOwners.contains(w.owner) { continue }
    if excluded.contains(w.pid) { continue }
    if w.owner == "Interpreter Overlay" { continue }
    if CGFloat(x) >= w.x && CGFloat(x) < w.x + w.w && CGFloat(y) >= w.y && CGFloat(y) < w.y + w.h {
      emitWindow(pid: w.pid, cgWindowId: w.cgWindowId, owner: w.owner, title: w.title, x: w.x, y: w.y, w: w.w, h: w.h)
      exit(0)
    }
  }
  print("none")
  exit(0)
}

func cmdListAt(x: Int, y: Int) {
  // Debug helper: print every visible non-system window under the point in
  // front-to-back order (with whether we'd skip it). Used to diagnose when the
  // primary `at` command returns no match.
  let excluded = getExcludedPIDs()
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    print("error no_window_list")
    exit(1)
  }
  for raw in list {
    guard let w = windowEntry(raw) else { continue }
    if !(CGFloat(x) >= w.x && CGFloat(x) < w.x + w.w && CGFloat(y) >= w.y && CGFloat(y) < w.y + w.h) {
      continue
    }
    var skip = "no"
    if w.layer >= 24 { skip = "layer\(w.layer)" }
    else if skipOwners.contains(w.owner) { skip = "owner" }
    else if excluded.contains(w.pid) { skip = "pid" }
    else if w.owner == "Interpreter Overlay" { skip = "overlay" }
    print("hit pid=\(w.pid) cgWindowId=\(w.cgWindowId) layer=\(w.layer) skip=\(skip) bounds=\(Int(w.x)),\(Int(w.y)),\(Int(w.w)),\(Int(w.h)) owner=\(w.owner.replacingOccurrences(of: "\n", with: " ")) title=\(w.title.replacingOccurrences(of: "\n", with: " "))")
  }
  exit(0)
}

func resolveByCgWindowId(_ targetId: UInt32) -> (pid: Int32, cgWindowId: UInt32, owner: String, title: String, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)? {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    return nil
  }
  for raw in list {
    guard let w = windowEntry(raw) else { continue }
    if w.cgWindowId == targetId {
      return (w.pid, w.cgWindowId, w.owner, w.title, w.x, w.y, w.w, w.h)
    }
  }
  return nil
}

// Apps own small layer-0 windows (update bubbles, popovers, find bars,
// tooltips) that can sit in front of the real window in z-order. "The active
// window" means the app's main window, so prefer the frontmost window of a
// plausible main-window size and only fall back to the largest small window.
let minMainWindowWidth: CGFloat = 220
let minMainWindowHeight: CGFloat = 140

func resolveFrontmostByPid(_ pid: Int32) -> (pid: Int32, cgWindowId: UInt32, owner: String, title: String, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)? {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    return nil
  }
  // CGWindowList returns windows in front-to-back order, so the first match owned
  // by `pid` at layer 0 of main-window size is the frontmost real window.
  var fallback: (pid: Int32, cgWindowId: UInt32, owner: String, title: String, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)? = nil
  for raw in list {
    guard let w = windowEntry(raw) else { continue }
    if w.pid == pid && w.layer == 0 {
      if w.w >= minMainWindowWidth && w.h >= minMainWindowHeight {
        return (w.pid, w.cgWindowId, w.owner, w.title, w.x, w.y, w.w, w.h)
      }
      if fallback == nil || (w.w * w.h) > (fallback!.w * fallback!.h) {
        fallback = (w.pid, w.cgWindowId, w.owner, w.title, w.x, w.y, w.w, w.h)
      }
    }
  }
  return fallback
}

func resolveActiveWindow() -> (pid: Int32, cgWindowId: UInt32, owner: String, title: String, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)? {
  guard let frontmostApp = NSWorkspace.shared.frontmostApplication else {
    return nil
  }
  return resolveFrontmostByPid(frontmostApp.processIdentifier)
}

func cmdBounds(idArg: String) {
  guard let id = UInt32(idArg) else {
    print("error invalid_id")
    exit(1)
  }
  if let w = resolveByCgWindowId(id) {
    emitWindow(pid: w.pid, cgWindowId: w.cgWindowId, owner: w.owner, title: w.title, x: w.x, y: w.y, w: w.w, h: w.h)
    exit(0)
  }
  print("gone")
  exit(0)
}

func cmdFrontmost(pidArg: String) {
  guard let pid = Int32(pidArg) else {
    print("error invalid_pid")
    exit(1)
  }
  if let w = resolveFrontmostByPid(pid) {
    emitWindow(pid: w.pid, cgWindowId: w.cgWindowId, owner: w.owner, title: w.title, x: w.x, y: w.y, w: w.w, h: w.h)
    exit(0)
  }
  print("gone")
  exit(0)
}

func cmdActive() {
  if let w = resolveActiveWindow() {
    emitWindow(pid: w.pid, cgWindowId: w.cgWindowId, owner: w.owner, title: w.title, x: w.x, y: w.y, w: w.w, h: w.h)
    exit(0)
  }
  print("gone")
  exit(0)
}

func cmdWatch(pidArg: String, intervalArg: String?) {
  // Long-running mode: emit one line per tick describing the frontmost on-screen
  // window owned by `pid`. Stdout is line-buffered so the consumer reads at the
  // tick cadence. Exit cleanly when stdin closes (parent dies).
  guard let pid = Int32(pidArg) else {
    print("error invalid_pid")
    exit(1)
  }
  let intervalMs = max(16, Int(intervalArg ?? "33") ?? 33)
  setbuf(stdout, nil)

  // Detect parent close via stdin EOF on a background thread.
  DispatchQueue.global(qos: .background).async {
    var byte: UInt8 = 0
    while read(STDIN_FILENO, &byte, 1) > 0 {}
    exit(0)
  }

  var lastPayload: String? = nil
  while true {
    let payload: String
    if let w = resolveFrontmostByPid(pid) {
      let appBundle = NSRunningApplication(processIdentifier: pid)?.bundleURL?.path ?? ""
      payload = "ok pid=\(w.pid) cgWindowId=\(w.cgWindowId) x=\(Int(w.x)) y=\(Int(w.y)) w=\(Int(w.w)) h=\(Int(w.h)) owner=\(w.owner.replacingOccurrences(of: "\n", with: " ")) title=\(w.title.replacingOccurrences(of: "\n", with: " ")) appBundle=\(appBundle.replacingOccurrences(of: "\n", with: " "))"
    } else {
      payload = "gone"
    }
    if payload != lastPayload {
      print(payload)
      lastPayload = payload
    }
    Thread.sleep(forTimeInterval: Double(intervalMs) / 1000.0)
  }
}

let args = CommandLine.arguments
guard args.count >= 2 else {
  print("error usage: window-tracker <at|bounds|frontmost|active|watch> ...")
  exit(1)
}

switch args[1] {
case "at":
  guard args.count >= 4, let x = Int(args[2]), let y = Int(args[3]) else {
    print("error usage: window-tracker at <x> <y>")
    exit(1)
  }
  cmdAt(x: x, y: y)
case "list-at":
  guard args.count >= 4, let x = Int(args[2]), let y = Int(args[3]) else {
    print("error usage: window-tracker list-at <x> <y>")
    exit(1)
  }
  cmdListAt(x: x, y: y)
case "bounds":
  guard args.count >= 3 else {
    print("error usage: window-tracker bounds <cgWindowId>")
    exit(1)
  }
  cmdBounds(idArg: args[2])
case "frontmost":
  guard args.count >= 3 else {
    print("error usage: window-tracker frontmost <pid>")
    exit(1)
  }
  cmdFrontmost(pidArg: args[2])
case "active":
  cmdActive()
case "watch":
  guard args.count >= 3 else {
    print("error usage: window-tracker watch <pid> [intervalMs]")
    exit(1)
  }
  cmdWatch(pidArg: args[2], intervalArg: args.count >= 4 ? args[3] : nil)
default:
  print("error unknown_command \(args[1])")
  exit(1)
}
