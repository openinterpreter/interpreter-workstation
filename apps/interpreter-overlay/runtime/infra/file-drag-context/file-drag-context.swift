import AppKit
import Foundation

func fileUrls(from pasteboard: NSPasteboard) -> [URL] {
    let options: [NSPasteboard.ReadingOptionKey: Any] = [
        .urlReadingFileURLsOnly: true,
    ]
    let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL] ?? []
    return urls.filter { $0.isFileURL }
}

func legacyFileUrls(from pasteboard: NSPasteboard) -> [URL] {
    guard let values = pasteboard.propertyList(forType: .init("NSFilenamesPboardType")) as? [String] else {
        return []
    }
    return values.map { URL(fileURLWithPath: $0) }
}

let pasteboards: [NSPasteboard] = [
    NSPasteboard(name: .drag),
    NSPasteboard.general,
]

var seen = Set<String>()
var paths: [String] = []

for pasteboard in pasteboards {
    for url in fileUrls(from: pasteboard) + legacyFileUrls(from: pasteboard) {
        let path = url.path
        guard !path.isEmpty && !seen.contains(path) else {
            continue
        }
        seen.insert(path)
        paths.append(path)
    }
}

let data = try JSONSerialization.data(withJSONObject: paths, options: [])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
