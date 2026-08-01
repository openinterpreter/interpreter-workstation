#!/usr/bin/env swift
import AppKit
import Foundation
import QuartzCore

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let heightRatio = AppDelegate.parseHeightRatio()
    private var inputBuffer = Data()
    private var window: NSWindow?
    private var visualEffect: NSVisualEffectView?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let screen = Self.screenUnderCursor() else {
            fputs("error: could not resolve active screen\n", stderr)
            NSApp.terminate(nil)
            return
        }

        self.window = makeWindow(for: screen)
        self.visualEffect?.alphaValue = 0
        self.window?.orderFrontRegardless()
        startCommandListener()
        print("ready")
        fflush(stdout)
    }

    private func makeWindow(for screen: NSScreen) -> NSWindow {
        let window = NSWindow(
            contentRect: frame(for: screen),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )

        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .floating
        window.ignoresMouseEvents = true
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none

        let visualEffect = NSVisualEffectView(frame: NSRect(origin: .zero, size: window.frame.size))
        visualEffect.autoresizingMask = [.width, .height]
        visualEffect.blendingMode = .behindWindow
        visualEffect.state = .active
        visualEffect.material = .fullScreenUI
        visualEffect.alphaValue = 0

        let maskLayer = CAGradientLayer()
        maskLayer.frame = visualEffect.bounds
        maskLayer.colors = [
            NSColor.clear.cgColor,
            NSColor.white.withAlphaComponent(0.18).cgColor,
            NSColor.white.withAlphaComponent(0.58).cgColor,
            NSColor.white.cgColor,
        ]
        maskLayer.locations = [0.0, 0.42, 0.76, 1.0]
        maskLayer.startPoint = CGPoint(x: 0.5, y: 0.0)
        maskLayer.endPoint = CGPoint(x: 0.5, y: 1.0)

        visualEffect.wantsLayer = true
        visualEffect.layer?.mask = maskLayer

        window.contentView = visualEffect
        self.visualEffect = visualEffect
        return window
    }

    private func frame(for screen: NSScreen) -> NSRect {
        let screenFrame = screen.frame
        let blurHeight = max(1, screenFrame.height * heightRatio)

        return NSRect(
            x: screenFrame.minX,
            y: screenFrame.minY,
            width: screenFrame.width,
            height: blurHeight
        )
    }

    private func showBlur() {
        guard let screen = Self.screenUnderCursor() else {
            return
        }

        if window == nil {
            window = makeWindow(for: screen)
        }

        window?.setFrame(frame(for: screen), display: true, animate: false)
        window?.orderFrontRegardless()

        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.2
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            visualEffect?.animator().alphaValue = 1
        }
    }

    private func hideBlur() {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            visualEffect?.animator().alphaValue = 0
        }
    }

    private func startCommandListener() {
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            guard let self else {
                return
            }

            let data = handle.availableData
            if data.isEmpty {
                DispatchQueue.main.async {
                    NSApp.terminate(nil)
                }
                return
            }

            self.inputBuffer.append(data)

            while let newlineRange = self.inputBuffer.firstRange(of: Data([0x0A])) {
                let lineData = self.inputBuffer.subdata(in: 0..<newlineRange.lowerBound)
                self.inputBuffer.removeSubrange(0...newlineRange.lowerBound)

                guard let line = String(data: lineData, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                    !line.isEmpty else {
                    continue
                }

                DispatchQueue.main.async {
                    self.handle(command: line)
                }
            }
        }
    }

    private func handle(command: String) {
        switch command {
        case "show":
            showBlur()
            print("shown")
            fflush(stdout)
        case "hide":
            hideBlur()
            print("hidden")
            fflush(stdout)
        case "exit":
            NSApp.terminate(nil)
        default:
            fputs("error: unknown command \(command)\n", stderr)
        }
    }

    private static func parseHeightRatio() -> CGFloat {
        guard CommandLine.arguments.count >= 2,
              let ratio = Double(CommandLine.arguments[1]) else {
            return 0.42
        }

        return CGFloat(min(max(ratio, 0.05), 1.0))
    }

    private static func screenUnderCursor() -> NSScreen? {
        let cursorLocation = NSEvent.mouseLocation

        if let screen = NSScreen.screens.first(where: { NSMouseInRect(cursorLocation, $0.frame, false) }) {
            return screen
        }

        return NSScreen.main ?? NSScreen.screens.first
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let delegate = AppDelegate()
app.delegate = delegate
app.run()
