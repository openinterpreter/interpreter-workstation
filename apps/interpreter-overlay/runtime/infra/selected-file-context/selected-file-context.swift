import AppKit
import ApplicationServices
import Foundation

func attribute(_ element: AXUIElement, _ name: CFString) -> Any? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, name, &value)
    guard result == .success else { return nil }
    return value
}

func attributeNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    let result = AXUIElementCopyAttributeNames(element, &names)
    guard result == .success, let names else { return [] }
    return (names as NSArray).compactMap { $0 as? String }
}

func stringValue(_ value: Any?) -> String? {
    if let string = value as? String {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    if let url = value as? URL {
        return url.isFileURL ? url.path : url.absoluteString
    }
    if let value, CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID() {
        return nil
    }
    return nil
}

func filePathValue(_ value: Any?) -> String? {
    if let url = value as? URL, url.isFileURL {
        return url.path
    }
    guard let string = stringValue(value) else { return nil }
    if string.hasPrefix("file://"), let url = URL(string: string), url.isFileURL {
        return url.path
    }
    if string.hasPrefix("/") {
        return string
    }
    return nil
}

func elementName(_ element: AXUIElement) -> String? {
    for attr in [
        "AXFilename",
        kAXTitleAttribute as String,
        kAXDescriptionAttribute as String,
        kAXValueAttribute as String,
        kAXHelpAttribute as String,
    ] {
        if let name = stringValue(attribute(element, attr as CFString)) {
            return name
        }
    }
    return nil
}

func elementDirectFilePath(_ element: AXUIElement) -> String? {
    for attr in [
        "AXURL",
        "AXFilename",
        "AXPath",
        "AXFilePath",
        kAXDocumentAttribute as String,
        kAXValueAttribute as String,
    ] {
        if let path = filePathValue(attribute(element, attr as CFString)) {
            return path
        }
    }
    return nil
}

func elementBounds(_ element: AXUIElement) -> [String: Double]? {
    guard let rawPosition = attribute(element, kAXPositionAttribute as CFString),
          let rawSize = attribute(element, kAXSizeAttribute as CFString),
          CFGetTypeID(rawPosition as CFTypeRef) == AXValueGetTypeID(),
          CFGetTypeID(rawSize as CFTypeRef) == AXValueGetTypeID() else {
        return nil
    }

    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(rawPosition as! AXValue, .cgPoint, &position),
          AXValueGetValue(rawSize as! AXValue, .cgSize, &size),
          size.width > 0,
          size.height > 0 else {
        return nil
    }

    return [
        "x": Double(position.x),
        "y": Double(position.y),
        "width": Double(size.width),
        "height": Double(size.height),
    ]
}

func windowFolderPath(_ window: AXUIElement) -> String? {
    for attr in [
        kAXDocumentAttribute as String,
        "AXURL",
        "AXRepresentedURL",
    ] {
        if let path = filePathValue(attribute(window, attr as CFString)) {
            var isDirectory = ObjCBool(false)
            if FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) {
                return isDirectory.boolValue ? path : URL(fileURLWithPath: path).deletingLastPathComponent().path
            }
            return path
        }
    }

    guard let title = stringValue(attribute(window, kAXTitleAttribute as CFString)) else {
        return nil
    }

    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let temp = NSTemporaryDirectory()
    let candidateDirectories = [
        URL(fileURLWithPath: title).path,
        URL(fileURLWithPath: temp).appendingPathComponent(title).path,
        URL(fileURLWithPath: home).appendingPathComponent(title).path,
        URL(fileURLWithPath: home).appendingPathComponent("Desktop").appendingPathComponent(title).path,
        URL(fileURLWithPath: home).appendingPathComponent("Documents").appendingPathComponent(title).path,
        URL(fileURLWithPath: home).appendingPathComponent("Downloads").appendingPathComponent(title).path,
    ]

    for candidate in candidateDirectories {
        var isDirectory = ObjCBool(false)
        if FileManager.default.fileExists(atPath: candidate, isDirectory: &isDirectory),
           isDirectory.boolValue {
            return candidate
        }
    }

    return nil
}

func selectedChildren(_ element: AXUIElement) -> [AXUIElement] {
    let children = attribute(element, kAXSelectedChildrenAttribute as CFString) as? [AXUIElement] ?? []
    if !children.isEmpty { return children }
    let selected = attribute(element, "AXSelected" as CFString) as? Bool ?? false
    return selected ? [element] : []
}

func childElements(_ element: AXUIElement) -> [AXUIElement] {
    return attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

func collectSelectedElements(_ element: AXUIElement, into output: inout [AXUIElement], depth: Int = 0) {
    guard depth < 30 else { return }
    output.append(contentsOf: selectedChildren(element))
    for child in childElements(element) {
        collectSelectedElements(child, into: &output, depth: depth + 1)
    }
}

func selectedFinderFiles() -> [[String: Any]] {
    guard let finder = NSWorkspace.shared.runningApplications.first(where: {
        $0.bundleIdentifier == "com.apple.finder"
    }) else {
        return []
    }

    let app = AXUIElementCreateApplication(finder.processIdentifier)
    let focusedWindow = attribute(app, kAXFocusedWindowAttribute as CFString).map { $0 as! AXUIElement }
    let mainWindow = attribute(app, kAXMainWindowAttribute as CFString).map { $0 as! AXUIElement }
    let windows = attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
    let roots = ([focusedWindow, mainWindow].compactMap { $0 } + windows)

    var seen = Set<String>()
    var files: [[String: Any]] = []
    for window in roots {
        let folderPath = windowFolderPath(window)
        var selected: [AXUIElement] = []
        collectSelectedElements(window, into: &selected)

        for element in selected {
            var path = elementDirectFilePath(element)
            if path == nil, let folderPath, let name = elementName(element) {
                path = URL(fileURLWithPath: folderPath).appendingPathComponent(name).path
            }
            guard let path,
                  !seen.contains(path),
                  FileManager.default.fileExists(atPath: path) else {
                continue
            }
            seen.insert(path)
            var file: [String: Any] = [
                "path": path,
            ]
            if let bounds = elementBounds(element) {
                file["bounds"] = bounds
            }
            files.append(file)
        }
    }
    return files
}

let data = try JSONSerialization.data(withJSONObject: selectedFinderFiles(), options: [])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
