import AppKit
import Foundation
import UniformTypeIdentifiers

let arguments = CommandLine.arguments

guard arguments.count == 3 else {
  fputs("usage: export-file-icon.swift <kind> <target>\n", stderr)
  exit(1)
}

let kind = arguments[1]
let targetURL = URL(fileURLWithPath: arguments[2])

let contentType: UTType
switch kind {
case "md":
  contentType = .plainText
case "pdf":
  contentType = .pdf
default:
  contentType = .data
}

let icon = NSWorkspace.shared.icon(for: contentType)
icon.size = NSSize(width: 128, height: 128)

guard
  let tiff = icon.tiffRepresentation,
  let bitmap = NSBitmapImageRep(data: tiff),
  let png = bitmap.representation(using: .png, properties: [:])
else {
  fputs("failed to export icon\n", stderr)
  exit(1)
}

try png.write(to: targetURL)
