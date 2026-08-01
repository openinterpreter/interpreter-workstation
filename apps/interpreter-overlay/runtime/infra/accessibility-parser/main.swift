#!/usr/bin/env swift

import Cocoa
import ApplicationServices
import Quartz
import Darwin

private let overlayAccessibilityObserverNoopCallback: AXObserverCallbackWithInfo = {
    _, _, _, _, _ in
}

private var overlayAccessibilityObservers: [Int32: AXObserver] = [:]

private let axObserverAddNotificationAndCheckRemote:
    (@convention(c) (AXObserver, AXUIElement, CFString, UnsafeMutableRawPointer?) -> AXError)? = {
        guard let sym = dlsym(
            UnsafeMutableRawPointer(bitPattern: -2),
            "AXObserverAddNotificationAndCheckRemote"
        ) else {
            return nil
        }
        return unsafeBitCast(
            sym,
            to: (@convention(c) (AXObserver, AXUIElement, CFString, UnsafeMutableRawPointer?) -> AXError).self
        )
    }()

func addObserverNotificationPreferRemote(
    observer: AXObserver,
    element: AXUIElement,
    notification: CFString
) -> AXError {
    if let fn = axObserverAddNotificationAndCheckRemote {
        return fn(observer, element, notification, nil)
    }
    return AXObserverAddNotification(observer, element, notification, nil)
}

func pumpRunLoopForAccessibilityActivation(duration: CFTimeInterval) {
    let endTime = CFAbsoluteTimeGetCurrent() + duration
    while CFAbsoluteTimeGetCurrent() < endTime {
        let remaining = endTime - CFAbsoluteTimeGetCurrent()
        _ = CFRunLoopRunInMode(CFRunLoopMode.defaultMode, remaining, false)
    }
}

func registerAccessibilityObserver(pid: Int32, root: AXUIElement) {
    if overlayAccessibilityObservers[pid] != nil {
        return
    }

    var observer: AXObserver?
    let createResult = AXObserverCreateWithInfoCallback(
        pid,
        overlayAccessibilityObserverNoopCallback,
        &observer
    )
    guard createResult == .success, let observer else {
        return
    }

    if let source = AXObserverGetRunLoopSource(observer) as CFRunLoopSource? {
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, CFRunLoopMode.defaultMode)
    }

    for notification in [
        kAXFocusedUIElementChangedNotification,
        kAXFocusedWindowChangedNotification,
        kAXApplicationActivatedNotification,
        kAXApplicationDeactivatedNotification,
        kAXApplicationHiddenNotification,
        kAXApplicationShownNotification,
        kAXWindowCreatedNotification,
        kAXWindowMovedNotification,
        kAXWindowResizedNotification,
        kAXValueChangedNotification,
        kAXTitleChangedNotification,
        kAXSelectedChildrenChangedNotification,
        kAXLayoutChangedNotification,
    ] {
        _ = addObserverNotificationPreferRemote(
            observer: observer,
            element: root,
            notification: notification as CFString
        )
    }

    overlayAccessibilityObservers[pid] = observer
}

func activateAccessibilityForWebContent(pid: Int32, root: AXUIElement) {
    AXUIElementSetMessagingTimeout(root, 2.0)

    let manualResult = AXUIElementSetAttributeValue(
        root,
        "AXManualAccessibility" as CFString,
        kCFBooleanTrue
    )
    let enhancedResult = AXUIElementSetAttributeValue(
        root,
        "AXEnhancedUserInterface" as CFString,
        kCFBooleanTrue
    )

    guard manualResult == .success || enhancedResult == .success else {
        return
    }

    registerAccessibilityObserver(pid: pid, root: root)
    pumpRunLoopForAccessibilityActivation(duration: 0.5)
}

// MARK: - Rectangle Utilities (x, y, w, h format)

typealias Rect = (x: Double, y: Double, w: Double, h: Double)

/// Safe conversion from Double/CGFloat to Int
/// Returns 0 if the value is NaN or Infinity
func safeInt(_ value: Double) -> Int {
    if value.isNaN || value.isInfinite {
        return 0
    }
    return Int(value)
}

func rectIntersection(_ a: Rect, _ b: Rect) -> Rect? {
    let ax2 = a.x + a.w
    let ay2 = a.y + a.h
    let bx2 = b.x + b.w
    let by2 = b.y + b.h

    let ix1 = max(a.x, b.x)
    let iy1 = max(a.y, b.y)
    let ix2 = min(ax2, bx2)
    let iy2 = min(ay2, by2)

    if ix1 < ix2 && iy1 < iy2 {
        return (ix1, iy1, ix2 - ix1, iy2 - iy1)
    }
    return nil
}

func rectSubtract(_ a: Rect, _ bs: [Rect]) -> [Rect] {
    var remaining = [a]
    for b in bs {
        var newRemaining: [Rect] = []
        for r in remaining {
            guard let inter = rectIntersection(r, b) else {
                newRemaining.append(r)
                continue
            }
            let (rx, ry, rw, rh) = r
            let (ix, iy, iw, ih) = inter

            // top
            if iy > ry {
                newRemaining.append((rx, ry, rw, iy - ry))
            }
            // bottom
            if iy + ih < ry + rh {
                newRemaining.append((rx, iy + ih, rw, (ry + rh) - (iy + ih)))
            }
            // left
            if ix > rx {
                newRemaining.append((rx, iy, ix - rx, ih))
            }
            // right
            if ix + iw < rx + rw {
                newRemaining.append((ix + iw, iy, (rx + rw) - (ix + iw), ih))
            }
        }
        remaining = newRemaining
    }
    return remaining
}

func iou(_ a: Rect, _ b: Rect) -> Double {
    let ax2 = a.x + a.w
    let ay2 = a.y + a.h
    let bx2 = b.x + b.w
    let by2 = b.y + b.h

    let ix1 = max(a.x, b.x)
    let iy1 = max(a.y, b.y)
    let ix2 = min(ax2, bx2)
    let iy2 = min(ay2, by2)

    let iw = max(0, ix2 - ix1)
    let ih = max(0, iy2 - iy1)
    let inter = iw * ih

    if inter <= 0 {
        return 0.0
    }

    let area_a = max(0, a.w) * max(0, a.h)
    let area_b = max(0, b.w) * max(0, b.h)
    return inter / (area_a + area_b - inter + 1e-9)
}

// MARK: - Window Info

struct VisibleWindowInfo {
    let pid: Int32
    let bounds: Rect  // (x, y, w, h)
    let visible: [Rect]  // list of (x, y, w, h) rectangles that are visible
    let owner: String
    let name: String
}

func buildGlobalVisibleIndex(_ pids: [Int32], excludedPIDs: Set<Int32>) -> [VisibleWindowInfo] {
    let windows = getVisibleWindowsForPIDs(pids, excludedPIDs: excludedPIDs)
    var seen: [Rect] = []
    var out: [VisibleWindowInfo] = []

    // Get screen bounds to clip windows - only on-screen portions are truly visible
    let screenBounds = getScreenBounds()

    for (_, w) in windows.enumerated() {
        let full = w.bounds

        // Clip window bounds to screen - elements off-screen aren't visible
        guard let clipped = rectIntersection(full, screenBounds) else {
            out.append(VisibleWindowInfo(pid: w.pid, bounds: full, visible: [], owner: w.owner, name: w.name))
            continue
        }

        // Compute visibility using clipped bounds
        let remaining = rectSubtract(clipped, seen)
        if !remaining.isEmpty {
            out.append(VisibleWindowInfo(pid: w.pid, bounds: full, visible: remaining, owner: w.owner, name: w.name))
            // Add the CLIPPED bounds to seen (only on-screen portion occludes)
            seen.append(clipped)
        } else {
            out.append(VisibleWindowInfo(pid: w.pid, bounds: full, visible: [], owner: w.owner, name: w.name))
        }
    }
    return out
}

func normalizedTitle(_ raw: String) -> String {
    var text = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

    let suffixPatterns = [
        #" - google chrome.*$"#,
        #" - chromium.*$"#,
        #" - chrome.*$"#,
    ]
    for pattern in suffixPatterns {
        text = text.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
    }

    text = text.replacingOccurrences(of: #"[^\p{L}\p{N}]+"#, with: " ", options: .regularExpression)
    text = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
}

func titleTokenSet(_ raw: String) -> Set<String> {
    Set(normalizedTitle(raw).split(separator: " ").map(String.init).filter { !$0.isEmpty })
}

func titlesRoughlyMatch(_ a: String, _ b: String) -> Bool {
    let lhs = normalizedTitle(a)
    let rhs = normalizedTitle(b)
    if lhs.isEmpty || rhs.isEmpty {
        return false
    }
    if lhs == rhs || lhs.contains(rhs) || rhs.contains(lhs) {
        return true
    }

    let lhsTokens = titleTokenSet(a)
    let rhsTokens = titleTokenSet(b)
    if lhsTokens.isEmpty || rhsTokens.isEmpty {
        return false
    }

    let overlap = lhsTokens.intersection(rhsTokens)
    let minimumSharedTokens = min(max(2, min(lhsTokens.count, rhsTokens.count)), 3)
    return overlap.count >= minimumSharedTokens
}

/// Get the main screen bounds
func getScreenBounds() -> Rect {
    if let screen = NSScreen.main {
        let frame = screen.frame
        // NSScreen coordinates have origin at bottom-left, but we use top-left
        // For occlusion purposes, we need the full screen area
        return (0, 0, frame.width, frame.height)
    }
    // Fallback to common screen size
    return (0, 0, 1512, 982)
}

struct WindowInfo {
    let pid: Int32
    let bounds: Rect
    let owner: String
    let name: String
    let layer: Int
    let zIndex: Int
}

let systemExcludes: Set<String> = [
    "Window Server",
    "Dock",
    "Control Center",
    "Notification Center",
    "loginwindow",
    "Spotlight",
    "ScreensaverEngine"
]

let isFormTestsMode = ProcessInfo.processInfo.environment["FORM_TESTS_MODE"] == "true"

func getExcludedPIDs() -> Set<Int32> {
    guard let raw = ProcessInfo.processInfo.environment["INTERPRETER_OVERLAY_EXCLUDED_PID"],
          let pid = Int32(raw) else {
        return []
    }
    return [pid]
}

func getRequestedTargetPID() -> Int32? {
    guard let raw = ProcessInfo.processInfo.environment["INTERPRETER_OVERLAY_TARGET_PID"],
          let pid = Int32(raw) else {
        return nil
    }
    return pid
}

func getRequestedScopeBounds() -> Rect? {
    guard let raw = ProcessInfo.processInfo.environment["INTERPRETER_OVERLAY_SCOPE_BOUNDS"] else {
        return nil
    }

    let parts = raw.split(separator: ",").map { Double($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    guard parts.count == 4,
          let x = parts[0],
          let y = parts[1],
          let w = parts[2],
          let h = parts[3],
          x.isFinite,
          y.isFinite,
          w.isFinite,
          h.isFinite,
          w > 0,
          h > 0 else {
        return nil
    }

    return (x, y, w, h)
}

func shouldIncludeWindow(_ win: [String: Any], excludedPIDs: Set<Int32>) -> Bool {
    let layer = win[kCGWindowLayer as String] as? Int ?? 0
    if layer > 10 || layer >= 24 {
        return false
    }

    let owner = (win[kCGWindowOwnerName as String] as? String ?? "").trimmingCharacters(in: .whitespaces)
    if owner.isEmpty || systemExcludes.contains(owner) {
        return false
    }

    if owner.lowercased() == "progressive-blur" {
        return false
    }

    guard let pid = win[kCGWindowOwnerPID as String] as? Int32 else {
        return false
    }

    if excludedPIDs.contains(pid) {
        return false
    }

    let name = (win[kCGWindowName as String] as? String ?? "").trimmingCharacters(in: .whitespaces)
    if name == "Interpreter Next" || name == "Interpreter" || name == "Overlay" {
        return false
    }

    if isFormTestsMode && name == "Background" {
        return false
    }

    let alpha = win[kCGWindowAlpha as String] as? CGFloat ?? 1.0
    if alpha < 0.01 {
        return false
    }

    guard let boundsDict = win[kCGWindowBounds as String] as? [String: CGFloat] else {
        return false
    }

    let x = Double(boundsDict["X"] ?? 0)
    let y = Double(boundsDict["Y"] ?? 0)
    let w = Double(boundsDict["Width"] ?? 0)
    let h = Double(boundsDict["Height"] ?? 0)
    return w > 0 && h > 0 && x.isFinite && y.isFinite
}

func windowInfoFromDictionary(_ win: [String: Any], zIndex: Int) -> WindowInfo? {
    guard let pid = win[kCGWindowOwnerPID as String] as? Int32,
          let boundsDict = win[kCGWindowBounds as String] as? [String: CGFloat] else {
        return nil
    }

    let x = Double(boundsDict["X"] ?? 0)
    let y = Double(boundsDict["Y"] ?? 0)
    let w = Double(boundsDict["Width"] ?? 0)
    let h = Double(boundsDict["Height"] ?? 0)
    let layer = win[kCGWindowLayer as String] as? Int ?? 0
    let owner = win[kCGWindowOwnerName as String] as? String ?? ""
    let name = win[kCGWindowName as String] as? String ?? ""

    return WindowInfo(
        pid: pid,
        bounds: (x, y, w, h),
        owner: owner,
        name: name,
        layer: layer,
        zIndex: zIndex
    )
}

func getVisibleWindowsForPIDs(_ pids: [Int32], excludedPIDs: Set<Int32>) -> [WindowInfo] {
    let pidSet = Set(pids)
    let windows = getWindowInfo()

    var results: [WindowInfo] = []
    for (index, win) in windows.enumerated() {
        guard shouldIncludeWindow(win, excludedPIDs: excludedPIDs),
              let pid = win[kCGWindowOwnerPID as String] as? Int32,
              pidSet.contains(pid),
              let windowInfo = windowInfoFromDictionary(win, zIndex: index) else {
            continue
        }
        results.append(windowInfo)
    }

    // Sort by layer (higher first) then by z-index (earlier first)
    results.sort { w1, w2 in
        if w1.layer != w2.layer {
            return w1.layer > w2.layer
        }
        return w1.zIndex < w2.zIndex
    }

    return results
}

func getTopVisibleWindow(excludedPIDs: Set<Int32>, scopeBounds: Rect? = nil, targetPID: Int32? = nil) -> WindowInfo? {
    let windows = getWindowInfo()
    var candidates: [WindowInfo] = []

    for (index, win) in windows.enumerated() {
        guard shouldIncludeWindow(win, excludedPIDs: excludedPIDs),
              let windowInfo = windowInfoFromDictionary(win, zIndex: index) else {
            continue
        }

        if let targetPID, windowInfo.pid != targetPID {
            continue
        }

        if let scopeBounds, rectIntersection(windowInfo.bounds, scopeBounds) == nil {
            continue
        }

        candidates.append(windowInfo)
    }

    candidates.sort { w1, w2 in
        if w1.layer != w2.layer {
            return w1.layer > w2.layer
        }
        return w1.zIndex < w2.zIndex
    }

    guard let first = candidates.first else {
        return nil
    }

    let firstName = first.name.trimmingCharacters(in: .whitespacesAndNewlines)
    let firstArea = first.bounds.w * first.bounds.h
    let looksAuxiliary = firstArea < 120_000 || first.bounds.h < 120 || (firstName.isEmpty && first.bounds.h < 200)

    if looksAuxiliary {
        let samePIDReplacement = candidates.first { candidate in
            guard candidate.pid == first.pid else {
                return false
            }

            let candidateArea = candidate.bounds.w * candidate.bounds.h
            return candidateArea > max(firstArea * 8.0, 180_000)
        }

        if let samePIDReplacement {
            let originalName = firstName.isEmpty ? "(untitled)" : firstName
            let replacementName = samePIDReplacement.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "(untitled)"
                : samePIDReplacement.name.trimmingCharacters(in: .whitespacesAndNewlines)
            fputs("DEBUG: Replacing auxiliary top window '\(originalName)' bounds=\(first.bounds) with '\(replacementName)' bounds=\(samePIDReplacement.bounds)\n", stderr)
            return samePIDReplacement
        }
    }

    return first
}

func getWindowInfo() -> [[String: Any]] {
    let options = CGWindowListOption([
        .optionAll,
        .optionIncludingWindow,
        .excludeDesktopElements,
        .optionOnScreenOnly
    ])
    return (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
}

func getPIDToBundleMap(_ bundleIds: [String]) -> [Int32: String] {
    let workspace = NSWorkspace.shared
    var map: [Int32: String] = [:]
    for app in workspace.runningApplications {
        if let bid = app.bundleIdentifier, bundleIds.contains(bid) {
            map[app.processIdentifier] = bid
        }
    }
    return map
}

func listVisibleAppPIDs() -> [Int32] {
    let options = CGWindowListOption([.excludeDesktopElements, .optionOnScreenOnly])
    guard let wins = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }

    let excludedPIDs = getExcludedPIDs()
    var pids: [Int32] = []
    var seen = Set<Int32>()

    fputs("DEBUG: listVisibleAppBundles found \(wins.count) total windows\n", stderr)
    var layerCounts: [Int: Int] = [:]
    for w in wins {
        let layer = w[kCGWindowLayer as String] as? Int ?? 0
        layerCounts[layer, default: 0] += 1
        let owner = (w[kCGWindowOwnerName as String] as? String ?? "").trimmingCharacters(in: .whitespaces)
        let name = (w[kCGWindowName as String] as? String ?? "").trimmingCharacters(in: .whitespaces)
        if !shouldIncludeWindow(w, excludedPIDs: excludedPIDs) {
            fputs("DEBUG: Skipping window at layer \(layer): owner='\(owner)', name='\(name)'\n", stderr)
            continue
        }

        guard let pid = w[kCGWindowOwnerPID as String] as? Int32 else {
            fputs("DEBUG: Skipping window: could not get PID (owner='\(owner)', name='\(name)')\n", stderr)
            continue
        }

        if !seen.contains(pid) {
            pids.append(pid)
            seen.insert(pid)
            fputs("DEBUG: Added PID to visible apps: \(pid) (owner='\(owner)')\n", stderr)
        }
    }

    fputs("DEBUG: Layer distribution: \(layerCounts.sorted(by: { $0.key < $1.key }).map { "\($0.key):\($0.value)" }.joined(separator: ", "))\n", stderr)
    return pids
}

func getAllPIDToBundleMap() -> [Int32: String] {
    let workspace = NSWorkspace.shared
    var map: [Int32: String] = [:]
    for app in workspace.runningApplications {
        if let bid = app.bundleIdentifier {
            map[app.processIdentifier] = bid
            if bid.contains("electron") || bid.contains("Electron") || app.localizedName?.contains("Electron") == true {
                fputs("DEBUG: Found Electron app - PID: \(app.processIdentifier), bundle: \(bid), name: \(app.localizedName ?? "?")\n", stderr)
            }
        }
    }
    fputs("DEBUG: PID map has \(map.count) entries\n", stderr)
    return map
}

// MARK: - Accessibility Helpers

func elementAttribute(_ element: AXUIElement, _ attribute: CFString) -> Any? {
    // Special handling for child-collection attributes - use AXUIElementCopyAttributeValues to get all items.
    if attribute == kAXChildrenAttribute as CFString
        || attribute == kAXVisibleChildrenAttribute as CFString
        || attribute == kAXRowsAttribute as CFString {
        var value: CFArray?
        let result = AXUIElementCopyAttributeValues(element, attribute, 0, 9999, &value)
        guard result == .success else {
            return nil
        }
        return value as? [AXUIElement]
    }

    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute, &value)
    guard result == .success else {
        return nil
    }
    return value
}

func setBooleanAttribute(_ element: AXUIElement, _ attribute: CFString, _ value: Bool) -> AXError {
    let cfValue: CFTypeRef = value ? kCFBooleanTrue : kCFBooleanFalse
    return AXUIElementSetAttributeValue(element, attribute, cfValue)
}

func requestExpandedAccessibilityTree(_ appElement: AXUIElement) {
    let attributes: [CFString] = [
        "AXManualAccessibility" as CFString,
        "AXEnhancedUserInterface" as CFString,
    ]

    var enabledAnyAttribute = false
    for attribute in attributes {
        let result = setBooleanAttribute(appElement, attribute, true)
        if result == .success {
            enabledAnyAttribute = true
        }
    }

    if enabledAnyAttribute {
        usleep(150_000)
    }
}

func elementValue(_ element: Any?, _ type: AXValueType) -> Any? {
    guard let axValue = element else {
        return nil
    }

    switch type {
    case .cgPoint:
        var point = CGPoint.zero
        guard AXValueGetValue(axValue as! AXValue, type, &point) else { return nil }
        return point
    case .cgSize:
        var size = CGSize.zero
        guard AXValueGetValue(axValue as! AXValue, type, &size) else { return nil }
        return size
    case .cgRect:
        var rect = CGRect.zero
        guard AXValueGetValue(axValue as! AXValue, type, &rect) else { return nil }
        return rect
    default:
        return nil
    }
}

func trimmedString(_ value: String?) -> String? {
    guard let value else {
        return nil
    }

    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

func selectionLabelForElement(_ element: AXUIElement) -> String? {
    return trimmedString(elementAttribute(element, kAXTitleAttribute as CFString) as? String)
        ?? trimmedString(elementAttribute(element, kAXDescriptionAttribute as CFString) as? String)
        ?? trimmedString(elementAttribute(element, kAXValueAttribute as CFString) as? String)
        ?? trimmedString(elementAttribute(element, kAXRoleDescriptionAttribute as CFString) as? String)
}

func elementRect(_ element: AXUIElement) -> CGRect? {
    guard let position = elementValue(elementAttribute(element, kAXPositionAttribute as CFString), .cgPoint) as? CGPoint,
          let size = elementValue(elementAttribute(element, kAXSizeAttribute as CFString), .cgSize) as? CGSize,
          size.width > 0,
          size.height > 0 else {
        return nil
    }

    return CGRect(origin: position, size: size)
}

func unionRects(_ rects: [CGRect]) -> CGRect? {
    guard let first = rects.first else {
        return nil
    }

    return rects.dropFirst().reduce(first) { partial, rect in
        partial.union(rect)
    }
}

func selectedTextBounds(_ element: AXUIElement) -> CGRect? {
    guard let rawRangeValue = elementAttribute(element, kAXSelectedTextRangeAttribute as CFString) else {
        return nil
    }
    let rangeValue = rawRangeValue as! AXValue

    var range = CFRange()
    guard AXValueGetValue(rangeValue, .cfRange, &range), range.length > 0 else {
        return nil
    }

    var boundsValue: CFTypeRef?
    let result = AXUIElementCopyParameterizedAttributeValue(
        element,
        kAXBoundsForRangeParameterizedAttribute as CFString,
        rangeValue,
        &boundsValue
    )
    guard result == .success,
          let cgRect = elementValue(boundsValue, .cgRect) as? CGRect,
          cgRect.width > 0,
          cgRect.height > 0 else {
        return nil
    }

    return cgRect
}

func selectedChildrenContext(_ element: AXUIElement) -> (text: String?, bounds: CGRect?)? {
    guard let children = elementAttribute(element, kAXSelectedChildrenAttribute as CFString) as? [AXUIElement],
          !children.isEmpty else {
        return nil
    }

    let labels = children.compactMap { selectionLabelForElement($0) }
    let uniqueLabels = Array(NSOrderedSet(array: labels)) as? [String] ?? labels
    let bounds = unionRects(children.compactMap { elementRect($0) })
    let text = uniqueLabels.isEmpty ? nil : uniqueLabels.joined(separator: "\n")

    if text == nil && bounds == nil {
        return nil
    }

    return (text, bounds)
}

func captureFocusedSelectionContext() -> [String: Any]? {
    let systemWideElement = AXUIElementCreateSystemWide()
    let focusedElement: AXUIElement
    var focusedApplication: NSRunningApplication?
    if let rawFocusedElement = elementAttribute(systemWideElement, kAXFocusedUIElementAttribute as CFString) {
        focusedElement = rawFocusedElement as! AXUIElement
        var pid: pid_t = 0
        if AXUIElementGetPid(focusedElement, &pid) == .success {
            focusedApplication = NSWorkspace.shared.runningApplications.first {
                $0.processIdentifier == pid
            }
        }
    } else if let frontmostApp = NSWorkspace.shared.frontmostApplication,
              let rawAppFocusedElement = elementAttribute(AXUIElementCreateApplication(frontmostApp.processIdentifier), kAXFocusedUIElementAttribute as CFString) {
        focusedElement = rawAppFocusedElement as! AXUIElement
        focusedApplication = frontmostApp
    } else {
        return nil
    }

    let selectedText = trimmedString(elementAttribute(focusedElement, kAXSelectedTextAttribute as CFString) as? String)
    let selectedTextRect = selectedTextBounds(focusedElement)
    let selectedChildren = selectedChildrenContext(focusedElement)
    let focusedElementRect = elementRect(focusedElement)

    let text = selectedText ?? selectedChildren?.text
    let bounds = selectedTextRect ?? selectedChildren?.bounds ?? focusedElementRect
    let sourceKind: String
    if selectedText != nil {
        sourceKind = "selected_text"
    } else if selectedChildren?.text != nil {
        sourceKind = "selected_children"
    } else {
        sourceKind = "focused_element"
    }

    if text == nil && bounds == nil {
        return nil
    }

    var result: [String: Any] = [:]
    result["source_kind"] = sourceKind
    if let focusedApplication {
        result["source_app_name"] = focusedApplication.localizedName
        result["source_app_bundle_identifier"] = focusedApplication.bundleIdentifier
        result["source_app_pid"] = focusedApplication.processIdentifier
    }
    if let text {
        result["text"] = text
    }
    if let bounds {
        result["bbox"] = [
            safeInt(bounds.minX),
            safeInt(bounds.minY),
            safeInt(bounds.maxX),
            safeInt(bounds.maxY),
        ]
    }
    return result
}

// MARK: - Stable IDs

func fnv1a64(_ input: String) -> UInt64 {
    let prime: UInt64 = 1099511628211
    var hash: UInt64 = 1469598103934665603
    for byte in input.utf8 {
        hash ^= UInt64(byte)
        hash = hash &* prime
    }
    return hash
}

func toBase36(_ value: UInt64) -> String {
    let digits = Array("0123456789abcdefghijklmnopqrstuvwxyz")
    var current = value
    var output = ""

    repeat {
        let remainder = Int(current % 36)
        output = String(digits[remainder]) + output
        current /= 36
    } while current > 0

    return output
}

func normalizedSemanticIdentifierComponent(_ raw: String?) -> String? {
    guard let raw else {
        return nil
    }

    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
        return nil
    }

    let lowered = trimmed.lowercased()
    let collapsedWhitespace = lowered.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    return collapsedWhitespace
}

func quantizedGeometryComponent(
    bbox: [Int]?,
    position: CGPoint?,
    size: CGSize?,
    bucketSize: Int = 64
) -> String? {
    if let bbox, bbox.count == 4 {
        let x = bbox[0] / bucketSize
        let y = bbox[1] / bucketSize
        let w = max(1, (bbox[2] - bbox[0]) / bucketSize)
        let h = max(1, (bbox[3] - bbox[1]) / bucketSize)
        return "\(x),\(y),\(w),\(h)"
    }

    if let position, let size {
        let x = safeInt(position.x) / bucketSize
        let y = safeInt(position.y) / bucketSize
        let w = max(1, safeInt(size.width) / bucketSize)
        let h = max(1, safeInt(size.height) / bucketSize)
        return "\(x),\(y),\(w),\(h)"
    }

    return nil
}

func stableElementIdentifier(
    role: String,
    nativeIdentifier: String?,
    bbox: [Int]?,
    position: CGPoint?,
    size: CGSize?,
    name: String?,
    description: String?,
    roleDescription: String?
) -> String {
    var seed = role

    if let nativeIdentifier,
       !nativeIdentifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        seed += "|axid:\(nativeIdentifier)"
        return "e\(toBase36(fnv1a64(seed)))"
    }

    let semanticParts = [
        normalizedSemanticIdentifierComponent(name),
        normalizedSemanticIdentifierComponent(description),
        normalizedSemanticIdentifierComponent(roleDescription)
    ].compactMap { $0 }

    if !semanticParts.isEmpty {
        seed += "|semantic:\(semanticParts.joined(separator: "|"))"
    }

    if let geometryComponent = quantizedGeometryComponent(
        bbox: bbox,
        position: position,
        size: size
    ) {
        seed += "|grid:\(geometryComponent)"
    }

    return "e\(toBase36(fnv1a64(seed)))"
}

func mergeAXChildLists(_ primary: [AXUIElement], _ secondary: [AXUIElement]) -> [AXUIElement] {
    var merged = primary
    var seen = Set<UInt>()

    for child in primary {
        seen.insert(CFHash(child))
    }

    for child in secondary {
        let hash = CFHash(child)
        if seen.insert(hash).inserted {
            merged.append(child)
        }
    }

    return merged
}

func mergeAXChildSources(_ sources: [[AXUIElement]?]) -> [AXUIElement]? {
    var merged: [AXUIElement] = []
    var sawAnySource = false

    for source in sources {
        guard let source else {
            continue
        }
        sawAnySource = true
        if merged.isEmpty {
            merged = source
        } else if !source.isEmpty {
            merged = mergeAXChildLists(merged, source)
        }
    }

    guard sawAnySource else {
        return nil
    }

    return merged
}

// MARK: - UIElement

class UIElement {
    var axElement: AXUIElement
    var identifier: String = ""
    var nativeIdentifier: String?
    var name: String?
    var role: String = "No role"
    var roleDescription: String?
    var description: String?
    var value: Any?
    var enabled: Bool = false
    var focused: Bool = false
    var position: CGPoint?
    var size: CGSize?
    var bbox: [Int]?
    var visibleBBox: [Int]?
    var visible: Bool = false
    var children: [UIElement] = []
    var appName: String?
    var windowOffsetX: Double = 0
    var windowOffsetY: Double = 0
    var skipRendering: Bool = false
    var windowVisibleRects: [[Int]]? = nil  // Multiple visible rectangles for this window

    init(_ element: AXUIElement, offsetX: Double = 0, offsetY: Double = 0, maxDepth: Int? = nil, parentsVisibleBBox: [Int]? = nil, visibleRects: [[Int]]? = nil) {
        self.axElement = element
        self.windowOffsetX = offsetX
        self.windowOffsetY = offsetY
        self.windowVisibleRects = visibleRects

        // role
        if let r = elementAttribute(element, kAXRoleAttribute as CFString) as? String {
            self.role = r
        }

        // name (title)
        if let n = elementAttribute(element, kAXTitleAttribute as CFString) as? String {
            self.name = n
        }

        // enabled
        if let e = elementAttribute(element, kAXEnabledAttribute as CFString) as? Bool {
            self.enabled = e
        }

        if let f = elementAttribute(element, kAXFocusedAttribute as CFString) as? Bool {
            self.focused = f
        }

        // position and size
        let posAttr = elementAttribute(element, kAXPositionAttribute as CFString)
        let sizeAttr = elementAttribute(element, kAXSizeAttribute as CFString)
        self.position = elementValue(posAttr, .cgPoint) as? CGPoint
        self.size = elementValue(sizeAttr, .cgSize) as? CGSize

        // For windows, update offset - window's position IS the offset for its children
        var actualOffsetX = offsetX
        var actualOffsetY = offsetY
        if self.role == "AXWindow" {
            if let pos = self.position {
                // Window position is absolute, use it as offset for children
                actualOffsetX = pos.x
                actualOffsetY = pos.y
                // Window itself has no offset (its position is already absolute)
                self.windowOffsetX = 0
                self.windowOffsetY = 0
            }
        }

        // set bboxes - use visibleRects if available (for proper multi-rectangle occlusion)
        setBBoxes(parentsVisibleBBox, multiRects: visibleRects)

        // set visibility
        if let vb = self.visibleBBox {
            let visibleWidth = vb[2] - vb[0]
            let visibleHeight = vb[3] - vb[1]
            self.visible = visibleWidth > 0 && visibleHeight > 0

            let preservesThinGeometry = self.role == "AXWindow" || self.role == "AXWebArea"
            if !preservesThinGeometry && (visibleWidth <= 1 || visibleHeight <= 1) {
                self.visible = false
            }
        }

        // description
        if let d = elementAttribute(element, kAXDescriptionAttribute as CFString) as? String {
            self.description = d
        }

        // role description
        if let rd = elementAttribute(element, kAXRoleDescriptionAttribute as CFString) as? String {
            self.roleDescription = rd
        }

        if let axIdentifier = elementAttribute(element, kAXIdentifierAttribute as CFString) as? String {
            let trimmed = axIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                self.nativeIdentifier = trimmed
            }
        }

        self.identifier = stableElementIdentifier(
            role: self.role,
            nativeIdentifier: self.nativeIdentifier,
            bbox: self.bbox,
            position: self.position,
            size: self.size,
            name: self.name,
            description: self.description,
            roleDescription: self.roleDescription
        )

        // value
        self.value = elementAttribute(element, kAXValueAttribute as CFString)

        // Debug: log ALL elements with ANY value text
        if let v = self.value as? String, !v.isEmpty {
            if v.lowercased().contains("hope") || v.lowercased().contains("austin") || v.lowercased().contains("equipment") {
                fputs("DEBUG EMAIL: Found email text! role=\(self.role), visible=\(self.visible), hasPosition=\(self.position != nil), value=\"\(v.prefix(100))...\"\n", stderr)
            }
        }

        // Debug: Print text elements and inputs with their positions
        if self.role == "AXStaticText" {
            if let val = self.value as? String, !val.isEmpty {
                let posStr = self.position.map { "(\($0.x), \($0.y))" } ?? "nil"
                let cleanVal = val.prefix(50).replacingOccurrences(of: "\n", with: "\\n")
                fputs("DEBUG TEXT: role=\(self.role), value=\"\(cleanVal)\", pos=\(posStr)\n", stderr)
            }
        } else if self.role == "AXTextField" {
            let posStr = self.position.map { "(\($0.x), \($0.y))" } ?? "nil"
            fputs("DEBUG INPUT: id=\(identifier), pos=\(posStr)\n", stderr)
        }

        // children - always traverse to find visible descendants, even if this wrapper has no own bbox
        if (maxDepth == nil || maxDepth! > 0) {
            let childCount = (elementAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement])?.count ?? 0
            if self.role == "AXWindow" && childCount > 0 {
                fputs("DEBUG: Window '\(self.name ?? "nil")' has \(childCount) children, traversing with visibleBBox=\(self.visibleBBox?.description ?? "nil")\n", stderr)
            }
            let inheritedVisibleBBox = self.visibleBBox ?? parentsVisibleBBox
            self.children = getChildren(element, offsetX: actualOffsetX, offsetY: actualOffsetY,
                                       maxDepth: maxDepth,
                                       visibleBBox: inheritedVisibleBBox,
                                       multiRects: self.windowVisibleRects)

            // Chrome/web accessibility often uses wrapper groups with no own position.
            // If they contain visible descendants, keep the wrapper in the serialized tree.
            if !self.visible && !self.children.isEmpty && self.children.contains(where: { $0.visible }) {
                self.visible = true
                if self.visibleBBox == nil {
                    self.visibleBBox = inheritedVisibleBBox
                }
            }
            // Debug: log children visibility and positions
            if self.name == "Contact Form" {
                let posStr = self.position.map { "(\($0.x), \($0.y))" } ?? "nil"
                let sizeStr = self.size.map { "(\($0.width), \($0.height))" } ?? "nil"
                fputs("DEBUG: Contact Form window: position=\(posStr), size=\(sizeStr), windowOffset=(\(self.windowOffsetX),\(self.windowOffsetY))\n", stderr)
                for child in self.children {
                    let childPosStr = child.position.map { "(\($0.x), \($0.y))" } ?? "nil"
                    let childBBoxStr = child.bbox?.map { String($0) }.joined(separator: ", ") ?? "nil"
                    fputs("  Child: role=\(child.role), position=\(childPosStr), windowOffset=(\(child.windowOffsetX),\(child.windowOffsetY)), visible=\(child.visible), bbox=[\(childBBoxStr)]\n", stderr)
                }
            }
        }
    }

    func setBBoxes(_ parentsVisibleBBox: [Int]?, multiRects: [[Int]]? = nil) {
        guard let pos = self.position, let sz = self.size else {
            // Elements without position/size are usually invisible
            // BUT keep them visible if they have substantial text content (like email body paragraphs)
            if let v = self.value as? String, v.count > 50 {
                fputs("DEBUG: Element without position has text (\(v.count) chars), marking visible anyway: \(v.prefix(80))...\n", stderr)
                // Mark as visible even without bbox so it gets included
                self.bbox = nil
                self.visibleBBox = [0, 0, 1, 1]  // Fake bbox to mark as visible
                return
            }
            self.bbox = nil
            self.visibleBBox = nil
            return
        }

        // For visibility: use WINDOW-RELATIVE coords to match parentsVisibleBBox
        // Positions from API are screen-absolute, so we need to convert to window-relative
        let wx1: Int
        let wy1: Int
        let wx2: Int
        let wy2: Int

        if self.role == "AXWindow" {
            // Windows use (0,0) as their own top-left for visibility calculations
            wx1 = 0
            wy1 = 0
            wx2 = safeInt(sz.width)
            wy2 = safeInt(sz.height)
        } else {
            // Child elements: convert screen-absolute position to window-relative
            // by subtracting the window offset
            let relX = pos.x - windowOffsetX
            let relY = pos.y - windowOffsetY
            wx1 = safeInt(relX)
            wy1 = safeInt(relY)
            wx2 = safeInt(relX + sz.width)
            wy2 = safeInt(relY + sz.height)
        }

        // Calculate visibility
        // If we have multiple visible rectangles (screen coords), check intersection with ANY of them
        if let rects = multiRects, !rects.isEmpty {
            // Element position is screen-absolute, rects are also screen coords
            let ex1 = safeInt(pos.x)
            let ey1 = safeInt(pos.y)
            let ex2 = safeInt(pos.x + sz.width)
            let ey2 = safeInt(pos.y + sz.height)

            // Check if element intersects with ANY of the visible rectangles
            var bestIntersection: [Int]? = nil

            for rect in rects {
                // rect is [x1, y1, x2, y2] in screen coords
                let rx1 = rect[0]
                let ry1 = rect[1]
                let rx2 = rect[2]
                let ry2 = rect[3]

                // Check if element intersects this rectangle
                if ex1 < rx2 && ex2 > rx1 && ey1 < ry2 && ey2 > ry1 {
                    // There's an intersection - calculate the visible portion (in window-relative for visibleBBox)
                    let ix1 = max(ex1, rx1)
                    let iy1 = max(ey1, ry1)
                    let ix2 = min(ex2, rx2)
                    let iy2 = min(ey2, ry2)

                    // Convert intersection back to window-relative for visibleBBox
                    let vx1 = safeInt(Double(ix1) - windowOffsetX)
                    let vy1 = safeInt(Double(iy1) - windowOffsetY)
                    let vx2 = safeInt(Double(ix2) - windowOffsetX)
                    let vy2 = safeInt(Double(iy2) - windowOffsetY)

                    if bestIntersection == nil {
                        bestIntersection = [vx1, vy1, vx2, vy2]
                    } else {
                        // Keep the largest area intersection
                        let existingArea = (bestIntersection![2] - bestIntersection![0]) * (bestIntersection![3] - bestIntersection![1])
                        let newArea = (vx2 - vx1) * (vy2 - vy1)
                        if newArea > existingArea {
                            bestIntersection = [vx1, vy1, vx2, vy2]
                        }
                    }
                }
            }

            self.visibleBBox = bestIntersection

            // Debug: log buttons near center
            if self.role == "AXButton" && ex1 > 400 && ex1 < 1100 {
                fputs("DEBUG BTN MULTI: pos=(\(ex1),\(ey1))-(\(ex2),\(ey2)) rects=\(rects.count) visible=\(self.visibleBBox != nil)\n", stderr)
            }
        } else if let pvb = parentsVisibleBBox {
            // Fallback to single rectangle (backwards compatibility)
            // check if not intersected (use window-relative coords)
            if wx1 >= pvb[2] || wy1 >= pvb[3] || wx2 <= pvb[0] || wy2 <= pvb[1] {
                // Element is fully outside visible region - mark as not visible
                self.visibleBBox = nil
            } else {
                self.visibleBBox = [
                    max(wx1, pvb[0]),
                    max(wy1, pvb[1]),
                    min(wx2, pvb[2]),
                    min(wy2, pvb[3])
                ]
            }

            // Debug: log buttons with wx1 > 600 (near boundary)
            if self.role == "AXButton" && wx1 > 600 {
                fputs("DEBUG BTN: wx1=\(wx1) wx2=\(wx2) pvb=[\(pvb[0]),\(pvb[1]),\(pvb[2]),\(pvb[3])] visible=\(self.visibleBBox != nil)\n", stderr)
            }
        } else {
            // No parent constraint, fully visible
            self.visibleBBox = [wx1, wy1, wx2, wy2]
        }

        // Positions from accessibility API are ALREADY screen-absolute
        // Don't add any offset - use position directly
        let x1 = safeInt(pos.x)
        let y1 = safeInt(pos.y)
        let x2 = safeInt(pos.x + sz.width)
        let y2 = safeInt(pos.y + sz.height)
        self.bbox = [x1, y1, x2, y2]

        // Debug for input fields
        if self.role == "AXTextField" {
            fputs("DEBUG setBBoxes: role=\(self.role), name=\(self.name ?? "nil"), position=(\(pos.x),\(pos.y)), bbox=[\(x1),\(y1),\(x2),\(y2)], visible=\(self.visibleBBox != nil)\n", stderr)
        }
    }

    func getChildren(_ element: AXUIElement, offsetX: Double, offsetY: Double, maxDepth: Int?, visibleBBox: [Int]?, multiRects: [[Int]]? = nil) -> [UIElement] {
        // If parent has no visible bbox, skip all children
        guard let vb = visibleBBox, vb[2] > vb[0] && vb[3] > vb[1] else {
            // Debug: log when we skip children due to parent visibility
            if self.role == "AXGroup" && (self.name?.contains("TechSupply") ?? false) {
                fputs("DEBUG: Skipping children of AXGroup '\(self.name ?? "nil")' due to no visible bbox\n", stderr)
            }
            return []
        }

        let visibleChildren = elementAttribute(element, kAXVisibleChildrenAttribute as CFString) as? [AXUIElement]
        let allChildren = elementAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]
        let rowsChildren = elementAttribute(element, kAXRowsAttribute as CFString) as? [AXUIElement]
        let contentsChildren = elementAttribute(element, kAXContentsAttribute as CFString) as? [AXUIElement]
        let navigationChildren = elementAttribute(element, "AXChildrenInNavigationOrder" as CFString) as? [AXUIElement]
        var children: [AXUIElement]? = nil

        let shouldUnionChildSources =
            role == "AXWindow" ||
            role == "AXApplication" ||
            role == "AXWebArea" ||
            role == "AXScrollArea"

        if shouldUnionChildSources {
            children = mergeAXChildSources([
                visibleChildren,
                rowsChildren,
                allChildren,
                contentsChildren,
                navigationChildren,
            ])
        } else if let visibleChildren, !visibleChildren.isEmpty {
            children = visibleChildren
            if visibleChildren.count <= 2 {
                children = mergeAXChildSources([
                    visibleChildren,
                    rowsChildren,
                    allChildren,
                    contentsChildren,
                    navigationChildren,
                ])
            }
        }

        // For lists/tables/outlines, rows are often the real interactive items.
        if children == nil && (role == "AXList" || role == "AXOutline" || role == "AXTable") {
            children = rowsChildren
        }

        if children == nil {
            children = mergeAXChildSources([
                rowsChildren,
                allChildren,
                contentsChildren,
                navigationChildren,
            ])
            if let count = children?.count, count > 50 {
//                 fputs("      Element has \(count) children\n", stderr)
            }
        }

        guard var children = children, !children.isEmpty else {
            return []
        }

        guard maxDepth == nil || maxDepth! > 0 else {
            return []
        }

        // For rows/tables with many children, filter by position before creating UIElements
        if (role == "AXOutline" || role == "AXTable") && children.count > 50 {
//             fputs("      Filtering \(children.count) rows by visibility...\n", stderr)
            var visibleChildren: [AXUIElement] = []

            for child in children {
                // Check if this child is even potentially visible
                let posAttr = elementAttribute(child, kAXPositionAttribute as CFString)
                let sizeAttr = elementAttribute(child, kAXSizeAttribute as CFString)

                if let pos = elementValue(posAttr, .cgPoint) as? CGPoint,
                   let sz = elementValue(sizeAttr, .cgSize) as? CGSize {
                    let childX1 = safeInt(pos.x - offsetX)
                    let childY1 = safeInt(pos.y - offsetY)
                    let childX2 = safeInt(pos.x - offsetX + sz.width)
                    let childY2 = safeInt(pos.y - offsetY + sz.height)

                    // Check if child intersects with visible bbox
                    if !(childX1 > vb[2] || childY1 > vb[3] || childX2 < vb[0] || childY2 < vb[1]) {
                        visibleChildren.append(child)
                    }
                }
            }

//             fputs("      Found \(visibleChildren.count) visible rows out of \(children.count)\n", stderr)
            children = visibleChildren
        }

        var result: [UIElement] = []
        fputs("DEBUG: Processing \(children.count) children, parent role=\(self.role), depth=\(maxDepth ?? 999)\n", stderr)
        for child in children {
            let childEl = UIElement(child, offsetX: offsetX, offsetY: offsetY,
                                   maxDepth: maxDepth != nil ? maxDepth! - 1 : nil,
                                   parentsVisibleBBox: visibleBBox,
                                   visibleRects: multiRects)

            // Debug: Check ALL children for email text
            let childVal = elementAttribute(child, kAXValueAttribute as CFString) as? String ?? ""
            if childVal.lowercased().contains("hope") || childVal.lowercased().contains("austin") {
                fputs("  !!! Child HAS EMAIL TEXT: role=\(childEl.role), visible=\(childEl.visible), position=\(childEl.position?.debugDescription ?? "nil"), size=\(childEl.size?.debugDescription ?? "nil"), value=\"\(childVal.prefix(100))\"\n", stderr)
            }

            fputs("  Child: role=\(childEl.role), name=\(childEl.name ?? "nil"), hasPosition=\(childEl.position != nil), hasSize=\(childEl.size != nil), visible=\(childEl.visible)\n", stderr)
            result.append(childEl)
        }

        // Debug: log filtered elements
        let filteredOut = result.filter { $0.position == nil }
        if !filteredOut.isEmpty {
            fputs("  WARNING: Filtered out \(filteredOut.count) children without position (roles: \(filteredOut.map { $0.role }.joined(separator: ", ")), names: \(filteredOut.map { $0.name ?? "nil" }.joined(separator: ", ")))\n", stderr)
        }

        // Preserve wrapper nodes that carry visible descendants even if the wrapper itself has no position.
        // Web apps like X/Chrome frequently use these structural groups around real content/buttons.
        result = result.filter { $0.position != nil || !$0.children.isEmpty }

        return result
    }

    func toDict() -> [String: Any?] {
        var result: [String: Any?] = [:]

        result["id"] = identifier
        result["name"] = name
        result["role"] = role
        result["description"] = description
        result["role_description"] = roleDescription

        // value
        if let v = value {
            if let str = v as? String {
                result["value"] = str
            } else if let num = v as? NSNumber {
                result["value"] = num.stringValue
            } else {
                result["value"] = nil
            }
        } else {
            result["value"] = nil
        }

        // position (absolute screen coordinates)
        if let p = position {
            result["position"] = String(format: "%.2f;%.2f", p.x, p.y)
        } else {
            result["position"] = ""
        }

        if let s = size {
            result["size"] = String(format: "%.0f;%.0f", s.width, s.height)
        } else {
            result["size"] = ""
        }

        result["enabled"] = enabled
        result["focused"] = focused
        result["bbox"] = bbox
        if let visibleBBox {
            if role == "AXWindow" {
                result["visible_bbox"] = visibleBBox
            } else {
                result["visible_bbox"] = [
                    visibleBBox[0] + safeInt(windowOffsetX),
                    visibleBBox[1] + safeInt(windowOffsetY),
                    visibleBBox[2] + safeInt(windowOffsetX),
                    visibleBBox[3] + safeInt(windowOffsetY)
                ]
            }
        } else {
            result["visible_bbox"] = nil
        }
        result["visible"] = visible

        // children
        result["children"] = children.map { $0.toDict() }

        // app_name
        if let an = appName, (role == "AXWindow" || ["Dock", "MenuBar (App)", "MenuBar (System)"].contains(an)) {
            result["app_name"] = an
        }

        return result
    }

    func getAllVisibleDescendants() -> [UIElement] {
        // Recursively collect all visible descendants, preserving position-based sorting
        var result: [UIElement] = []

        func collect(_ element: UIElement) {
            if !element.visible {
                return
            }

            // Include ANY element with content and a position
            let hasContent = (element.value != nil && !(element.value as? String ?? "").isEmpty) ||
                            element.role == "AXTextField" ||
                            element.role == "AXButton" ||
                            element.role == "AXStaticText" ||
                            element.role == "AXLink"

            if hasContent && element.position != nil {
                result.append(element)
            }

            // Always recurse into children
            for child in element.children {
                collect(child)
            }
        }

        collect(self)

        // Sort by Y then X (reading order)
        result.sort { e1, e2 in
            guard let p1 = e1.position, let p2 = e2.position else { return false }
            let yThreshold: CGFloat = 10.0
            let yDiff = abs(p1.y - p2.y)

            if yDiff < yThreshold {
                return p1.x < p2.x
            } else {
                return p1.y < p2.y
            }
        }

        return result
    }

    func serializationName(maxLength: Int = 100, includeRoleFallback: Bool = false) -> String? {
        if let n = name?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty, n.count <= maxLength {
            return n
        }

        if includeRoleFallback,
           let rd = roleDescription?.trimmingCharacters(in: .whitespacesAndNewlines),
           !rd.isEmpty,
           rd.count <= maxLength {
            return rd
        }

        return nil
    }

    func toText(indent: Int = 0, parentTag: String = "") -> String {
        // Debug: Track roles being processed
        fputs("toText role=\(role) name=\(name ?? "nil")\n", stderr)

        // Debug: Track heading rendering
        if role.contains("Heading") {
            fputs("DEBUG toText: Heading role='\(role)' name=\(name ?? "nil"), value=\(String(describing: value)), children=\(children.count)\n", stderr)
        }
        // Debug: Track AXPage rendering
        if role == "AXPage" {
            fputs("DEBUG: toText() called for AXPage with \(children.count) children\n", stderr)
        }


        // Skip rendering if flagged
        if skipRendering {
            return ""
        }

        let indentStr = String(repeating: "  ", count: indent)

        // Map AX roles to HTML-like tags
        let tag: String
        let isDiv: Bool
        let isInteractive: Bool

        // Pre-check: For divs with substantial text in the name field, flag them to preserve them
        // This must be done before any filtering logic
        var hasSubstantialTextContent = false
        if (role == "AXGroup" || role == "AXScrollArea") {
            if let n = name, !n.isEmpty, n.count > 100 {
                hasSubstantialTextContent = true
            }
        }

        switch role {
        case "AXButton":
            tag = "button"
            isDiv = false
            isInteractive = true
        case "AXTextField", "AXTextArea", "AXSearchField":
            tag = "input"
            isDiv = false
            isInteractive = true
        case "AXPopUpButton":
            tag = "dropdown"
            isDiv = false
            isInteractive = true
        case "AXStaticText":
            tag = "text"
            isDiv = false
            isInteractive = false
        case "AXImage":
            tag = "img"
            isDiv = false
            isInteractive = false
        case "AXGroup", "AXScrollArea":
            tag = "div"
            isDiv = true
            isInteractive = false
        case "AXWindow":
            tag = "window"
            isDiv = false
            isInteractive = false
        case "AXToolbar":
            tag = "toolbar"
            isDiv = false
            isInteractive = false
        case "AXMenu", "AXMenuBar":
            tag = "menu"
            isDiv = false
            isInteractive = false
        case "AXMenuItem":
            tag = "menuitem"
            isDiv = false
            isInteractive = true
        case "AXCheckBox":
            tag = "checkbox"
            isDiv = false
            isInteractive = true
        case "AXRadioButton":
            tag = "radio"
            isDiv = false
            isInteractive = true
        case "AXLink":
            tag = "link"
            isDiv = false
            isInteractive = true
        case "AXList":
            tag = "list"
            isDiv = false
            isInteractive = false
        case "AXRow":
            tag = "tr"
            isDiv = false
            isInteractive = false
        case "AXCell":
            tag = "td"
            isDiv = false
            isInteractive = false
        case "AXTable":
            tag = "table"
            isDiv = false
            isInteractive = false
        case "AXDateField":
            tag = "date"
            isDiv = false
            isInteractive = true
        case "AXTimeField":
            tag = "time"
            isDiv = false
            isInteractive = true
        case "AXIncrementor":
            // Skip incrementor buttons (spinner +/- buttons) - they're noise
            tag = ""
            isDiv = false
            isInteractive = false
        case "AXSecureTextField":
            tag = "input"
            isDiv = false
            isInteractive = true
        case "AXSlider":
            tag = "slider"
            isDiv = false
            isInteractive = true
        case "AXComboBox":
            tag = "combobox"
            isDiv = false
            isInteractive = true
        case "AXProgressIndicator":
            tag = "progress"
            isDiv = false
            isInteractive = false
        case "AXRadioGroup":
            tag = "radiogroup"
            isDiv = true
            isInteractive = false
        case "AXSplitGroup", "AXSplitter":
            tag = "splitter"
            isDiv = false
            isInteractive = false
        case "AXTabGroup":
            tag = "tabgroup"
            isDiv = true
            isInteractive = false
        case "AXMenuBarItem", "AXMenuButton":
            tag = "menubutton"
            isDiv = false
            isInteractive = true
        case "AXDisclosureTriangle":
            tag = "details"
            isDiv = false
            isInteractive = true
        case "AXScrollBar", "AXValueIndicator":
            // Skip scroll bar UI elements - they're noise
            tag = ""
            isDiv = false
            isInteractive = false
        case "AXWebArea":
            tag = "webarea"
            isDiv = true
            isInteractive = false
        case "AXHeading":
            // Use heading level if available (h1, h2, etc), otherwise just h
            // Value can be NSNumber, Int, or other numeric types
            var level: Int? = nil
            if let v = value {
                if let num = v as? NSNumber {
                    level = num.intValue
                    fputs("DEBUG HEADING: NSNumber level=\(num.intValue)\n", stderr)
                } else if let num = v as? Int {
                    level = num
                    fputs("DEBUG HEADING: Int level=\(num)\n", stderr)
                } else if let str = v as? String, let num = Int(str) {
                    level = num
                    fputs("DEBUG HEADING: String level=\(num)\n", stderr)
                } else {
                    fputs("DEBUG HEADING: Unknown value type: \(type(of: v))\n", stderr)
                }
            } else {
                fputs("DEBUG HEADING: No value\n", stderr)
            }
            if let l = level, l >= 1 && l <= 6 {
                tag = "h\(l)"
                fputs("DEBUG HEADING: Using tag=h\(l)\n", stderr)
            } else {
                tag = "h"
                fputs("DEBUG HEADING: Using tag=h (no valid level)\n", stderr)
            }
            isDiv = false
            isInteractive = false
        case "AXPage":
            tag = "page"
            isDiv = true  // Treat as div so row-grouping logic applies
            isInteractive = false
        default:
            tag = "div"
            isDiv = true
            isInteractive = false
        }

        // Debug: show final tag for headings
        if role == "AXHeading" {
            fputs("DEBUG toText: AXHeading resolved tag=\(tag), isDiv=\(isDiv)\n", stderr)
        }

        // Skip elements with empty tags (like AXIncrementor)
        if tag.isEmpty {
            var output = ""
            for child in children where child.visible {
                output += child.toText(indent: indent, parentTag: parentTag)
            }
            return output
        }

        // Check if we should compress single-child divs
        // BUT preserve divs with substantial text content
        if isDiv && children.count == 1 && !hasSubstantialTextContent {
            let child = children[0]
            let childTag: String
            switch child.role {
            case "AXGroup", "AXScrollArea":
                childTag = "div"
            default:
                childTag = ""
            }
            // If this is a div and only child is also a div, skip this one
            if childTag == "div" {
                return child.toText(indent: indent, parentTag: parentTag)
            }
        }

        // Build attributes
        var attrs: [String] = []

        // Only add ID to interactive elements
        if isInteractive {
            attrs.append("id=\"\(identifier)\"")
        }

        if let n = serializationName(includeRoleFallback: isInteractive) {
            attrs.append("name=\"\(escapeXML(n))\"")
        }

        if let d = description, !d.isEmpty {
            attrs.append("alt=\"\(escapeXML(d))\"")
        }

        if !visible {
            attrs.append("hidden")
        }

        // Get text content
        var textContent = ""
        if let v = value {
            // Skip value for headings (it's the level, already in tag like h1, h2)
            // Skip value for progress (show as attribute instead)
            let skipValue = tag.hasPrefix("h") || tag == "progress"

            if !skipValue {
                if let str = v as? String, !str.isEmpty {
                    textContent = escapeXML(str)
                } else if let num = v as? NSNumber {
                    // For sliders, show value as attribute instead
                    if tag == "slider" {
                        attrs.append("value=\"\(num.stringValue)\"")
                    } else {
                        textContent = num.stringValue
                    }
                }
            }

            // For progress, add value attribute
            if tag == "progress", let num = v as? NSNumber {
                attrs.append("value=\"\(num.stringValue)\"")
            }
        }

        // For divs (AXGroup, AXScrollArea), if there's no value but there's a name with substantial content,
        // use the name as text content instead of an attribute
        // This captures email body text and other web content that's stored in the name field
        // We do this even if there are children - the name text will appear before the children
        if isDiv && textContent.isEmpty {
            if let n = name, !n.isEmpty, n.count > 100 {  // Only use name as content if it's substantial text (>100 chars)
                textContent = escapeXML(n)
                // Remove the name from attributes since we're using it as content
                attrs = attrs.filter { !$0.hasPrefix("name=") }
            }
        }

        let attrStr = attrs.isEmpty ? "" : " " + attrs.joined(separator: " ")

        // Skip empty divs (no children, no content, no useful attributes)
        if isDiv && children.isEmpty && textContent.isEmpty {
            let hasUsefulAttrs = (name != nil && !name!.isEmpty) ||
                                 (description != nil && !description!.isEmpty)
            if !hasUsefulAttrs {
                return ""  // Skip this useless empty div
            }
        }

        // Special case: Skip menu wrappers entirely - render menuitems directly at their actual positions
        // Menuitems will appear as separate clickable elements with correct screen coordinates
        if tag == "menu" {
            var output = ""
            for child in children where child.visible {
                output += child.toText(indent: indent, parentTag: parentTag)
            }
            return output
        }

        // Special case: For date/time fields, render as self-closing (skip child components)
        // The child Month/Day/Year/Hour/Minute parts are noise
        if (tag == "date" || tag == "time") && !children.isEmpty {
            return "\(indentStr)<\(tag)\(attrStr)/>\n"
        }

        // Special case: For inputs with children (e.g., secure fields), render as self-closing
        // This prevents invalid HTML like <input><button></button></input>
        if tag == "input" && !children.isEmpty {
            // Render the input as self-closing
            var output = "\(indentStr)<\(tag)\(attrStr)/>\n"
            // Then render children at the same level as siblings
            for child in children where child.visible {
                output += child.toText(indent: indent, parentTag: parentTag)
            }
            return output
        }

        // Build output
        var output = ""

        // Debug AXPage
        if role == "AXPage" {
            fputs("DEBUG: AXPage.toFormattedText() called - children.count=\(children.count), textContent.isEmpty=\(textContent.isEmpty)\n", stderr)
        }

        if children.isEmpty && textContent.isEmpty {
            // Self-closing tag
            output = "\(indentStr)<\(tag)\(attrStr)/>\n"
        } else if children.isEmpty {
            // Single line with text
            output = "\(indentStr)<\(tag)\(attrStr)>\(textContent)</\(tag)>\n"
        } else {
            // Multi-line with children
            output = "\(indentStr)<\(tag)\(attrStr)>\n"
            if !textContent.isEmpty {
                output += "\(indentStr)  \(textContent)\n"
            }

            // Detect if we should flatten based on spatial overlap
            // If descendants at different tree levels have overlapping Y positions, flatten them
            func shouldFlattenForSpatialOverlap() -> Bool {
                // Disable spatial flattening - it breaks label-input associations
                // Keep the natural tree hierarchy which preserves semantic groupings
                return false
            }

            // Get visible children - preserve natural tree order
            let visibleChildren = children.filter { $0.visible }

            // Render children directly, preserving parent-child structure
            // Each child handles its own indentation via toCompactText
            for child in visibleChildren {
                let childOutput = child.toCompactText(indent: indent + 1)
                if !childOutput.isEmpty {
                    output += childOutput
                }
            }

            output += "\(indentStr)</\(tag)>\n"
        }

        return output
    }

    func toCompactText(indent: Int = 0) -> String {
        // Render element with proper indentation and newlines
        let indentStr = String(repeating: "  ", count: indent)

        // Skip incrementors (date/time picker buttons)
        if role == "AXIncrementor" || role == "AXScrollBar" || role == "AXValueIndicator" {
            return ""
        }

        // Get visible children first
        let visibleChildren = children.filter { $0.visible }

        // For divs with single visible child that is ALSO a div, collapse the nesting
        // But keep divs that wrap non-div content (they provide semantic grouping)
        // This collapses <div><div><div>x</div></div></div> to <div>x</div>
        // But preserves <div><label/></div><div><input/></div> as separate divs
        if (role == "AXGroup" || role == "AXScrollArea") && visibleChildren.count == 1 {
            let child = visibleChildren[0]
            // Only collapse if child is also a div-like element (and this div has no useful info)
            if child.role == "AXGroup" || child.role == "AXScrollArea" {
                let hasUsefulInfo = (name != nil && !name!.isEmpty) || (description != nil && !description!.isEmpty)
                if !hasUsefulInfo {
                    return child.toCompactText(indent: indent)
                }
            }
        }

        // Map role to tag - MUST match toText() mappings
        var tag: String
        let isInteractive: Bool
        switch role {
        case "AXButton": tag = "button"; isInteractive = true
        case "AXTextField", "AXTextArea", "AXSearchField", "AXSecureTextField": tag = "input"; isInteractive = true
        case "AXPopUpButton": tag = "dropdown"; isInteractive = true
        case "AXComboBox": tag = "combobox"; isInteractive = true
        case "AXStaticText": tag = "text"; isInteractive = false
        case "AXMenu", "AXMenuBar": tag = "menu"; isInteractive = false
        case "AXMenuItem": tag = "menuitem"; isInteractive = true
        case "AXMenuBarItem", "AXMenuButton": tag = "menubutton"; isInteractive = true
        case "AXCheckBox": tag = "checkbox"; isInteractive = true
        case "AXRadioButton": tag = "radio"; isInteractive = true
        case "AXLink": tag = "link"; isInteractive = true
        case "AXSlider": tag = "slider"; isInteractive = true
        case "AXProgressIndicator": tag = "progress"; isInteractive = false
        case "AXDateField": tag = "date"; isInteractive = true
        case "AXTimeField": tag = "time"; isInteractive = true
        case "AXTable": tag = "table"; isInteractive = false
        case "AXRow": tag = "tr"; isInteractive = false
        case "AXCell": tag = "td"; isInteractive = false
        case "AXWindow": tag = "window"; isInteractive = false
        case "AXWebArea": tag = "webarea"; isInteractive = false
        case "AXHeading":
            // Use heading level from value
            if let v = value, let num = v as? NSNumber, num.intValue >= 1 && num.intValue <= 6 {
                tag = "h\(num.intValue)"
            } else {
                tag = "h"
            }
            isInteractive = false
        default: tag = "div"; isInteractive = false
        }

        // Build attributes
        var attrs: [String] = []
        if isInteractive {
            attrs.append("id=\"\(identifier)\"")
        }

        // For headings, use name as content not attribute
        let isHeading = tag.hasPrefix("h")
        if !isHeading {
            if let n = serializationName(includeRoleFallback: isInteractive) {
                attrs.append("name=\"\(escapeXML(n))\"")
            }
        }
        if let d = description, !d.isEmpty {
            attrs.append("alt=\"\(escapeXML(d))\"")
        }

        // Add value as attribute for slider/progress
        if tag == "slider" || tag == "progress" {
            if let v = value, let num = v as? NSNumber {
                attrs.append("value=\"\(num.stringValue)\"")
            }
        }

        // For radio/checkbox, show checked state as attribute instead of text
        if tag == "radio" || tag == "checkbox" {
            if let v = value, let num = v as? NSNumber {
                if num.intValue != 0 {
                    attrs.append("checked")
                }
            }
        }

        let attrStr = attrs.isEmpty ? "" : " " + attrs.joined(separator: " ")

        // Get text content
        var textContent = ""

        // For headings, use name as text content
        if isHeading {
            if let n = name, !n.isEmpty {
                textContent = escapeXML(n)
            }
        } else if tag != "slider" && tag != "progress" && tag != "radio" && tag != "checkbox" {
            // For other elements, use value (but not for slider/progress/radio/checkbox)
            if let v = value {
                if let str = v as? String, !str.isEmpty {
                    textContent = escapeXML(str)
                } else if let num = v as? NSNumber {
                    textContent = num.stringValue
                }
            }
        }

        // Check for substantial text in name (like email body)
        if (role == "AXGroup" || role == "AXScrollArea") && textContent.isEmpty {
            if let n = name, !n.isEmpty, n.count > 100 {
                textContent = escapeXML(n)
            }
        }

        // Skip empty divs with no useful content
        if tag == "div" && visibleChildren.isEmpty && textContent.isEmpty {
            let hasUsefulAttrs = attrs.contains { !$0.hasPrefix("id=") }
            if !hasUsefulAttrs {
                return ""
            }
        }

        // For date/time fields, render as self-closing (skip child components)
        if tag == "date" || tag == "time" {
            return "\(indentStr)<\(tag)\(attrStr)/>\n"
        }

        // For headings, render with name as content, skip children (they duplicate the text)
        if isHeading {
            return "\(indentStr)<\(tag)>\(textContent)</\(tag)>\n"
        }

        // Interactive elements should NOT have children - render as self-closing or with text only
        if ["radio", "checkbox", "button", "slider", "progress"].contains(tag) {
            if textContent.isEmpty {
                return "\(indentStr)<\(tag)\(attrStr)/>\n"
            } else {
                return "\(indentStr)<\(tag)\(attrStr)>\(textContent)</\(tag)>\n"
            }
        }

        // Render with proper formatting
        if visibleChildren.isEmpty && textContent.isEmpty {
            return "\(indentStr)<\(tag)\(attrStr)/>\n"
        } else if visibleChildren.isEmpty {
            return "\(indentStr)<\(tag)\(attrStr)>\(textContent)</\(tag)>\n"
        } else {
            // Has children - render with proper nesting
            var output = "\(indentStr)<\(tag)\(attrStr)>\n"
            if !textContent.isEmpty {
                output += "\(indentStr)  \(textContent)\n"
            }
            for child in visibleChildren {
                let childOutput = child.toCompactText(indent: indent + 1)
                if !childOutput.isEmpty {
                    output += childOutput
                }
            }
            output += "\(indentStr)</\(tag)>\n"
            return output
        }
    }

    func escapeXML(_ str: String) -> String {
        return str
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}

// MARK: - Main Processing

func processApp(_ pid: Int32, maxDepth: Int, globalVisIndex: [VisibleWindowInfo], targetWindow: WindowInfo?) -> [UIElement] {
    let appElement = AXUIElementCreateApplication(pid)
    activateAccessibilityForWebContent(pid: pid, root: appElement)
    requestExpandedAccessibilityTree(appElement)

    var windowsRef: AnyObject?
    let windowsResult = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRef)

    if windowsResult != .success {
//         fputs("    Failed to get windows attribute for \(appBundle), error: \(windowsResult.rawValue)\n", stderr)
        return []
    }

    guard let appWindows = windowsRef as? [AXUIElement] else {
//         fputs("    Windows attribute exists but is not an array of AXUIElement for \(appBundle)\n", stderr)
        return []
    }

    let cgEntries = globalVisIndex.filter { $0.pid == pid }
    var allUIElements: [UIElement] = []

    if appWindows.isEmpty {
//         fputs("    No windows found in accessibility tree for \(appBundle)\n", stderr)
//         fputs("    Found \(cgEntries.count) windows in CG window list:\n", stderr)
        for (idx, cgEntry) in cgEntries.enumerated() {
//             fputs("      CG Window \(idx): bounds=\(cgEntry.bounds), visible=\(cgEntry.visible.count) regions\n", stderr)
        }
        return []
    }

    let includeAllWindowsForTargetPID =
        ProcessInfo.processInfo.environment["FORM_TESTS_MODE"] == "true"
        || ProcessInfo.processInfo.environment["FORM_TESTS_INCLUDE_ALL_AX_WINDOWS"] == "true"
    var windows = appWindows
    if let targetWindow, !includeAllWindowsForTargetPID {
        var bestWindow: AXUIElement?
        var bestScore = -Double.infinity

        for axWindow in appWindows {
            guard let winPos = elementValue(elementAttribute(axWindow, kAXPositionAttribute as CFString), .cgPoint) as? CGPoint,
                  let winSize = elementValue(elementAttribute(axWindow, kAXSizeAttribute as CFString), .cgSize) as? CGSize else {
                continue
            }

            let title = (elementAttribute(axWindow, kAXTitleAttribute as CFString) as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let axRect: Rect = (winPos.x, winPos.y, winSize.width, winSize.height)
            let overlap = iou(axRect, targetWindow.bounds)
            let titleScore = title == targetWindow.name.trimmingCharacters(in: .whitespacesAndNewlines) ? 1.0 : 0.0
            let score = (titleScore * 10.0) + overlap

            if score > bestScore {
                bestScore = score
                bestWindow = axWindow
            }
        }

        if let bestWindow {
            let targetTitle = targetWindow.name.isEmpty ? "(untitled)" : targetWindow.name
            fputs("DEBUG: Restricting AX traversal to top window '\(targetTitle)' for PID \(pid)\n", stderr)
            windows = [bestWindow]
        }
    } else if includeAllWindowsForTargetPID {
        windows = appWindows.filter { axWindow in
            let title = (elementAttribute(axWindow, kAXTitleAttribute as CFString) as? String ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return title != "Background"
        }
        fputs("DEBUG: FORM_TESTS_INCLUDE_ALL_AX_WINDOWS active, processing all visible windows for PID \(pid)\n", stderr)
    }

//     fputs("  \(appBundle): Processing \(windows.count) AX windows (CG has \(cgEntries.count) visible windows)\n", stderr)

    for (winIdx, axWin) in windows.enumerated() {
        let winStartTime = Date()
        guard let winPos = elementValue(elementAttribute(axWin, kAXPositionAttribute as CFString), .cgPoint) as? CGPoint,
              let winSize = elementValue(elementAttribute(axWin, kAXSizeAttribute as CFString), .cgSize) as? CGSize else {
            continue
        }
        let axTitle = (elementAttribute(axWin, kAXTitleAttribute as CFString) as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        let xTL = winPos.x
        let yTL = winPos.y
        let wAX = winSize.width
        let hAX = winSize.height

        let axRect: Rect = (xTL, yTL, wAX, hAX)

        // Find best matching CG window
        var best: VisibleWindowInfo? = nil
        var bestScore = -Double.infinity
        var bestIOU = 0.0
        for cg in cgEntries {
            let i = iou(axRect, cg.bounds)
            let titleScore = titlesRoughlyMatch(axTitle, cg.name) ? 1.0 : 0.0
            let score = (titleScore * 10.0) + i
            if score > bestScore {
                bestScore = score
                bestIOU = i
                best = cg
            }
        }

        guard let bestMatch = best else {
//             fputs("    Window \(winIdx): No CG match found (IOU too low)\n", stderr)
            continue
        }

        if includeAllWindowsForTargetPID {
            let matchedTitle = titlesRoughlyMatch(axTitle, bestMatch.name)
            let geometryLooksPlausible = bestIOU >= 0.35
            if !matchedTitle && !geometryLooksPlausible {
                continue
            }
            if !axTitle.isEmpty && !bestMatch.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !matchedTitle {
                continue
            }
        }

        // skip not visible windows
        if bestMatch.visible.isEmpty {
//             fputs("    Window \(winIdx): Skipping - no visible regions (IOU: \(String(format: "%.2f", bestIOU)))\n", stderr)
            continue
        }

        // Keep visible rectangles in screen coords (simpler, no conversion needed)
        var visibleRectsScreen: [[Int]] = []
        for r in bestMatch.visible {
            let rx1 = safeInt(r.x)
            let ry1 = safeInt(r.y)
            let rx2 = safeInt(r.x + r.w)
            let ry2 = safeInt(r.y + r.h)

            if rx2 > rx1 && ry2 > ry1 {
                visibleRectsScreen.append([rx1, ry1, rx2, ry2])
            }
        }

        if visibleRectsScreen.isEmpty {
            continue
        }

        // Also calculate a single bounding box for backwards compatibility
        // This is used by getChildren for initial filtering
        var vx1 = Double.infinity
        var vy1 = Double.infinity
        var vx2 = -Double.infinity
        var vy2 = -Double.infinity

        for r in bestMatch.visible {
            vx1 = min(vx1, r.x)
            vy1 = min(vy1, r.y)
            vx2 = max(vx2, r.x + r.w)
            vy2 = max(vy2, r.y + r.h)
        }

        let ix1 = max(xTL, vx1)
        let iy1 = max(yTL, vy1)
        let ix2 = min(xTL + wAX, vx2)
        let iy2 = min(yTL + hAX, vy2)

        if ix2 <= ix1 || iy2 <= iy1 {
            continue
        }

        let parentsVisibleBBox = [
            safeInt(ix1 - xTL),
            safeInt(iy1 - yTL),
            safeInt(ix2 - xTL),
            safeInt(iy2 - yTL)
        ]

        // Debug: Log visible rectangles for this window
        let winTitle = elementAttribute(axWin, kAXTitleAttribute as CFString) as? String ?? "untitled"
        fputs("DEBUG WINDOW: '\(winTitle)' has \(visibleRectsScreen.count) visible rects (screen coords): \(visibleRectsScreen)\n", stderr)

        let uiWindow = UIElement(axWin, offsetX: 0, offsetY: 0, maxDepth: maxDepth, parentsVisibleBBox: parentsVisibleBBox, visibleRects: visibleRectsScreen)
        // Try to get app name from NSWorkspace, but don't fail if not found (for child processes)
        if let app = NSWorkspace.shared.runningApplications.first(where: { $0.processIdentifier == pid }) {
            uiWindow.appName = app.localizedName
        } else {
            uiWindow.appName = "PID \(pid)"
        }

        let winElapsed = Date().timeIntervalSince(winStartTime)
//         fputs("    Window \(winIdx): \(String(format: "%.2f", winElapsed))s\n", stderr)

        allUIElements.append(uiWindow)
    }

    return allUIElements
}

// MARK: - Main

guard AXIsProcessTrusted() else {
//     fputs("ERROR: Accessibility permissions not granted\n", stderr)
    exit(1)
}

let startTime = Date()

fputs("===== BINARY VERSION: 2026-03-08 22:20 - STABLE GEOMETRY IDS =====\n", stderr)

let excludedPIDs = getExcludedPIDs()
if !excludedPIDs.isEmpty {
    fputs("DEBUG: Excluding PIDs: \(excludedPIDs.map { String($0) }.joined(separator: ", "))\n", stderr)
}
let requestedTargetPID = getRequestedTargetPID()
if let requestedTargetPID {
    fputs("DEBUG: Requested target PID \(requestedTargetPID)\n", stderr)
}
let requestedScopeBounds = getRequestedScopeBounds()
if let requestedScopeBounds {
    fputs("DEBUG: Requested scope bounds x=\(requestedScopeBounds.x) y=\(requestedScopeBounds.y) w=\(requestedScopeBounds.w) h=\(requestedScopeBounds.h)\n", stderr)
}

let selectionOnly = ProcessInfo.processInfo.environment["INTERPRETER_OVERLAY_SELECTION_ONLY"] == "1"
if selectionOnly {
    let selectionContext = captureFocusedSelectionContext()
    let output: [String: Any] = [
        "selection_context": selectionContext ?? NSNull()
    ]

    if let jsonData = try? JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys]),
       let jsonString = String(data: jsonData, encoding: .utf8) {
        print(jsonString)
    }
    exit(0)
}

// Get all visible app PIDs
let allVisiblePIDs = listVisibleAppPIDs()
fputs("DEBUG: allVisiblePIDs contains \(allVisiblePIDs.count) PIDs: \(allVisiblePIDs.map { String($0) }.joined(separator: ", "))\n", stderr)
fputs("Found \(allVisiblePIDs.count) visible processes\n", stderr)

// Build global visible index for ALL PIDs to compute occlusion
let globalVisIndex = buildGlobalVisibleIndex(allVisiblePIDs, excludedPIDs: excludedPIDs)
fputs("Built visibility index with \(globalVisIndex.count) windows\n", stderr)

guard let targetWindow = getTopVisibleWindow(excludedPIDs: excludedPIDs, scopeBounds: requestedScopeBounds, targetPID: requestedTargetPID) else {
    fputs("ERROR: Could not determine top visible target window\n", stderr)
    exit(1)
}

let targetWindowName = targetWindow.name.isEmpty ? "(untitled)" : targetWindow.name
fputs("DEBUG: Target window owner='\(targetWindow.owner)' pid=\(targetWindow.pid) name='\(targetWindowName)' bounds=\(targetWindow.bounds)\n", stderr)

// Process each PID
var allUIElements: [UIElement] = []
// Modern web apps like X in Chrome can nest visible interactive content very deeply.
// Keep the limit high enough to reach tweet/action-row nodes from the top window wrapper stack.
let maxDepth = 60

let appStartTime = Date()
let elements = processApp(targetWindow.pid, maxDepth: maxDepth, globalVisIndex: globalVisIndex, targetWindow: targetWindow)
let appElapsed = Date().timeIntervalSince(appStartTime)
fputs("DEBUG: Processed target PID \(targetWindow.pid) in \(String(format: "%.2f", appElapsed))s, got \(elements.count) root elements\n", stderr)
allUIElements.append(contentsOf: elements)

let elapsed = Date().timeIntervalSince(startTime)
// fputs("Parsed \(allUIElements.count) root elements in \(String(format: "%.2f", elapsed))s\n", stderr)

// Generate JSON
let allElementsJSON = allUIElements.map { $0.toDict() }

// Generate formatted text - only include visible windows
// TODO: Remove this Stickies filter when you release the app
var formattedText = ""
for element in allUIElements where element.visible {
    // Skip Stickies app (temporary - remove this when releasing)
    if let name = element.name, name.contains("doing multiple things") {
        continue
    }
    formattedText += element.toCompactText()
}

// Output combined structure
let output: [String: Any] = [
    "elements": allElementsJSON,
    "formatted_text": formattedText
]

if let jsonData = try? JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys]),
   let jsonString = String(data: jsonData, encoding: .utf8) {
    print(jsonString)
}
