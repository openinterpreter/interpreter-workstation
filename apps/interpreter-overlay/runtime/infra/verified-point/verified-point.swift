#!/usr/bin/env swift
import Cocoa
import ApplicationServices

guard CommandLine.arguments.count >= 6 else {
  print("error: usage: verified-point <target-id> <x> <y> <width> <height>")
  exit(1)
}

let targetId = CommandLine.arguments[1]

guard let bboxX = Int(CommandLine.arguments[2]),
      let bboxY = Int(CommandLine.arguments[3]),
      let bboxWidth = Int(CommandLine.arguments[4]),
      let bboxHeight = Int(CommandLine.arguments[5]) else {
  print("error: invalid bbox")
  exit(1)
}

func getExcludedPIDs() -> Set<pid_t> {
  guard let raw = ProcessInfo.processInfo.environment["INTERPRETER_OVERLAY_EXCLUDED_PID"],
        let pid = Int32(raw) else {
    return []
  }
  return [pid]
}

func safeInt(_ value: Double) -> Int {
  if value.isNaN || value.isInfinite {
    return 0
  }
  return Int(value)
}

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
  return lowered.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
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
    normalizedSemanticIdentifierComponent(roleDescription),
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

func copyAXAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
  var value: CFTypeRef?
  let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
  guard result == .success else {
    return nil
  }
  return value
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

func rectFromElement(_ element: AXUIElement) -> CGRect? {
  guard let position = pointFromAXValue(copyAXAttribute(element, kAXPositionAttribute)),
        let size = sizeFromAXValue(copyAXAttribute(element, kAXSizeAttribute)) else {
    return nil
  }

  return CGRect(x: position.x, y: position.y, width: size.width, height: size.height)
}

func rectIntersection(_ left: CGRect, _ right: CGRect) -> CGRect? {
  let intersection = left.intersection(right)
  return intersection.isNull ? nil : intersection
}

func rectIou(_ left: CGRect, _ right: CGRect) -> Double {
  guard let intersection = rectIntersection(left, right) else {
    return 0
  }

  let intersectionArea = intersection.width * intersection.height
  if intersectionArea <= 0 {
    return 0
  }

  let leftArea = left.width * left.height
  let rightArea = right.width * right.height
  return intersectionArea / (leftArea + rightArea - intersectionArea)
}

func rectContainment(_ left: CGRect, _ right: CGRect) -> Double {
  guard let intersection = rectIntersection(left, right) else {
    return 0
  }

  let intersectionArea = intersection.width * intersection.height
  if intersectionArea <= 0 {
    return 0
  }

  let minArea = max(1, min(left.width * left.height, right.width * right.height))
  return intersectionArea / minArea
}

func rectCenterDistance(_ left: CGRect, _ right: CGRect) -> Double {
  let leftCenter = CGPoint(x: left.midX, y: left.midY)
  let rightCenter = CGPoint(x: right.midX, y: right.midY)
  return hypot(leftCenter.x - rightCenter.x, leftCenter.y - rightCenter.y)
}

func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
  copyAXAttribute(element, attribute) as? String
}

func pidForElement(_ element: AXUIElement) -> pid_t? {
  var pid: pid_t = 0
  let result = AXUIElementGetPid(element, &pid)
  guard result == .success else {
    return nil
  }
  return pid
}

func valueString(_ element: AXUIElement) -> String? {
  if let value = copyAXAttribute(element, kAXValueAttribute) as? String {
    return value
  }
  return nil
}

func rectToBBoxArray(_ rect: CGRect?) -> [Int]? {
  guard let rect else {
    return nil
  }
  return [
    safeInt(rect.minX),
    safeInt(rect.minY),
    safeInt(rect.maxX),
    safeInt(rect.maxY),
  ]
}

func isActionableRole(_ role: String) -> Bool {
  switch role {
  case kAXButtonRole,
       kAXTextFieldRole,
       kAXTextAreaRole,
       kAXComboBoxRole,
       kAXPopUpButtonRole,
       kAXMenuButtonRole,
       kAXCheckBoxRole,
       kAXRadioButtonRole:
    return true
  default:
    return false
  }
}

func hasMeaningfulLabel(_ element: AXUIElement) -> Bool {
  let candidates = [
    stringAttribute(element, kAXTitleAttribute),
    stringAttribute(element, kAXDescriptionAttribute),
    stringAttribute(element, kAXRoleDescriptionAttribute),
    valueString(element),
  ]

  for candidate in candidates {
    if let candidate, !candidate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return true
    }
  }

  return false
}

func preferredReportingElement(from chain: [AXUIElement]) -> AXUIElement {
  guard let first = chain.first else {
    fatalError("preferredReportingElement requires at least one element")
  }

  for candidate in chain {
    let role = stringAttribute(candidate, kAXRoleAttribute) ?? ""
    if isActionableRole(role) || hasMeaningfulLabel(candidate) {
      return candidate
    }
  }

  return first
}

func serializeHitElement(_ element: AXUIElement) -> [String: Any] {
  let role = stringAttribute(element, kAXRoleAttribute) ?? "Unknown"
  let title = stringAttribute(element, kAXTitleAttribute) ?? ""
  let description = stringAttribute(element, kAXDescriptionAttribute) ?? ""
  let roleDescription = stringAttribute(element, kAXRoleDescriptionAttribute) ?? ""
  let value = valueString(element) ?? ""
  let label = [title, description, roleDescription]
    .first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? ""

  var payload: [String: Any] = [
    "id": elementStableIdentifier(element),
    "role": role,
    "label": label,
  ]

  if !value.isEmpty {
    payload["value"] = value
  }

  if let bbox = rectToBBoxArray(rectFromElement(element)) {
    payload["bbox"] = bbox
  }

  return payload
}

func printJSONObject(_ object: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(object),
        let data = try? JSONSerialization.data(withJSONObject: object),
        let text = String(data: data, encoding: .utf8) else {
    print("no_match")
    exit(0)
  }

  print(text)
}

func elementStableIdentifier(_ element: AXUIElement) -> String {
  let role = (copyAXAttribute(element, kAXRoleAttribute) as? String) ?? "No role"
  let name = copyAXAttribute(element, kAXTitleAttribute) as? String
  let description = copyAXAttribute(element, kAXDescriptionAttribute) as? String
  let roleDescription = copyAXAttribute(element, kAXRoleDescriptionAttribute) as? String
  let nativeIdentifier = copyAXAttribute(element, kAXIdentifierAttribute) as? String
  let position = pointFromAXValue(copyAXAttribute(element, kAXPositionAttribute))
  let size = sizeFromAXValue(copyAXAttribute(element, kAXSizeAttribute))
  let bbox: [Int]? = {
    guard let position, let size else {
      return nil
    }
    return [
      safeInt(position.x),
      safeInt(position.y),
      safeInt(position.x + size.width),
      safeInt(position.y + size.height),
    ]
  }()

  return stableElementIdentifier(
    role: role,
    nativeIdentifier: nativeIdentifier,
    bbox: bbox,
    position: position,
    size: size,
    name: name,
    description: description,
    roleDescription: roleDescription
  )
}

func ancestorChain(for element: AXUIElement, maxDepth: Int = 12) -> [AXUIElement] {
  var result: [AXUIElement] = []
  var current: AXUIElement? = element
  var seen = Set<UInt>()

  while let node = current, result.count < maxDepth {
    let hash = CFHash(node)
    if seen.contains(hash) {
      break
    }
    seen.insert(hash)
    result.append(node)
    if let parent = copyAXAttribute(node, kAXParentAttribute) {
      current = (parent as! AXUIElement)
    } else {
      current = nil
    }
  }

  return result
}

func pointInsideRect(_ point: CGPoint, _ rect: CGRect) -> Bool {
  rect.contains(point)
}

func topmostNonExcludedWindowPID(at point: CGPoint, excludedPIDs: Set<pid_t>) -> pid_t? {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let windowInfo = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    return nil
  }

  for window in windowInfo {
    guard let pid = window[kCGWindowOwnerPID as String] as? pid_t else {
      continue
    }
    if excludedPIDs.contains(pid) {
      continue
    }

    let alpha = window[kCGWindowAlpha as String] as? CGFloat ?? 1
    if alpha < 0.01 {
      continue
    }

    let layer = window[kCGWindowLayer as String] as? Int ?? 0
    if layer > 10 || layer >= 24 {
      continue
    }

    guard let boundsDict = window[kCGWindowBounds as String] as? [String: CGFloat] else {
      continue
    }

    let bounds = CGRect(
      x: boundsDict["X"] ?? 0,
      y: boundsDict["Y"] ?? 0,
      width: boundsDict["Width"] ?? 0,
      height: boundsDict["Height"] ?? 0
    )

    if pointInsideRect(point, bounds) {
      return pid
    }
  }

  return nil
}

func hitTest(at point: CGPoint, excludedPIDs: Set<pid_t>) -> AXUIElement? {
  let systemWide = AXUIElementCreateSystemWide()
  var hit: AXUIElement?
  let systemResult = AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &hit)
  if systemResult == .success, let hit, let pid = pidForElement(hit), !excludedPIDs.contains(pid) {
    return hit
  }

  guard let pid = topmostNonExcludedWindowPID(at: point, excludedPIDs: excludedPIDs) else {
    return nil
  }

  let app = AXUIElementCreateApplication(pid)
  var appHit: AXUIElement?
  let appResult = AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &appHit)
  guard appResult == .success else {
    return nil
  }
  return appHit
}

func probePoint(_ point: CGPoint, targetId: String, excludedPIDs: Set<pid_t>) -> [String: Any]? {
  guard let hit = hitTest(at: point, excludedPIDs: excludedPIDs) else {
    return nil
  }

  let chain = ancestorChain(for: hit)
  for candidate in chain {
    if elementStableIdentifier(candidate) == targetId {
      return [
        "status": "match",
        "x": safeInt(point.x),
        "y": safeInt(point.y),
      ]
    }
  }

  let reportElement = preferredReportingElement(from: chain)
  return [
    "status": "blocked",
    "x": safeInt(point.x),
    "y": safeInt(point.y),
    "hit": serializeHitElement(reportElement),
  ]
}

func uniqueCandidatePoints(x: Int, y: Int, width: Int, height: Int) -> [CGPoint] {
  let minX = x
  let maxX = x + max(1, width)
  let minY = y
  let maxY = y + max(1, height)
  var points: [CGPoint] = []
  var seen = Set<String>()

  func scalar(_ start: Int, _ end: Int, _ fraction: Double) -> Int {
    if end <= start {
      return start
    }
    return start + Int(round(Double(end - start) * fraction))
  }

  let fractions: [(Double, Double)] = [
    (0.5, 0.5),
    (0.1, 0.1),
    (0.9, 0.1),
    (0.1, 0.9),
    (0.9, 0.9),
  ]

  for (xFraction, yFraction) in fractions {
    let px = scalar(minX, maxX, xFraction)
    let py = scalar(minY, maxY, yFraction)
    let key = "\(px),\(py)"
    if seen.insert(key).inserted {
      points.append(CGPoint(x: px, y: py))
    }
  }

  return points
}

let excludedPIDs = getExcludedPIDs()
var blockedReport: [String: Any]? = nil
for point in uniqueCandidatePoints(x: bboxX, y: bboxY, width: bboxWidth, height: bboxHeight) {
  guard let result = probePoint(point, targetId: targetId, excludedPIDs: excludedPIDs) else {
    continue
  }

  if let status = result["status"] as? String, status == "match" {
    printJSONObject(result)
    exit(0)
  }

  if blockedReport == nil {
    blockedReport = result
  }
}

if let blockedReport {
  printJSONObject(blockedReport)
  exit(0)
}

print("no_match")
exit(0)
