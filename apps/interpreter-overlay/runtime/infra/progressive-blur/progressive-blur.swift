#!/usr/bin/env swift
import AppKit
import Foundation

private struct BlurLayerSpec: Equatable {
    let heightMultiplier: CGFloat
    let targetAlpha: CGFloat
    let zeroOpacitySide: CGFloat
    let zeroOpacityDroop: CGFloat
    let fullOpacitySide: CGFloat
    let fullOpacityDroop: CGFloat
}

private struct MaterialSpec {
    let name: String
    let material: NSVisualEffectView.Material
}

private struct PreviewParameters: Codable {
    var heightRatio: CGFloat
    var layerCount: Int
    var opacityExponent: CGFloat
    var curveExponent: CGFloat
    var materialName: String

    var tallestHeightMultiplier: CGFloat
    var shortestHeightMultiplier: CGFloat
    var tallestAlpha: CGFloat
    var shortestAlpha: CGFloat

    var tallestZeroOpacitySide: CGFloat
    var shortestZeroOpacitySide: CGFloat
    var tallestZeroOpacityDroop: CGFloat
    var shortestZeroOpacityDroop: CGFloat

    var tallestFullOpacitySide: CGFloat
    var shortestFullOpacitySide: CGFloat
    var tallestFullOpacityDroop: CGFloat
    var shortestFullOpacityDroop: CGFloat
}

private enum SliderKey: Hashable {
    case heightRatio
    case layerCount
    case opacityExponent
    case curveExponent
    case tallestHeightMultiplier
    case shortestHeightMultiplier
    case tallestAlpha
    case shortestAlpha
    case tallestZeroOpacitySide
    case shortestZeroOpacitySide
    case tallestZeroOpacityDroop
    case shortestZeroOpacityDroop
    case tallestFullOpacitySide
    case shortestFullOpacitySide
    case tallestFullOpacityDroop
    case shortestFullOpacityDroop
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

private final class BlurWindowLayer {
    private static let opacityAnimationKey = "progressive-blur.opacity"
    private(set) var spec: BlurLayerSpec
    private let window: NSWindow
    private let visualEffect: NSVisualEffectView
    private var targetFrame: NSRect
    private var isPresented = false
    private var opacityExponent: CGFloat = 1.4
    private var curveExponent: CGFloat = 1.0

    private func freezePresentationState() {
        let currentAlpha = currentPresentationAlpha()
        visualEffect.layer?.removeAnimation(forKey: Self.opacityAnimationKey)
        setAlpha(currentAlpha)
    }

    private func currentPresentationAlpha() -> CGFloat {
        if let presentationLayer = visualEffect.layer?.presentation() {
            return CGFloat(presentationLayer.opacity)
        }

        if let layer = visualEffect.layer {
            return CGFloat(layer.opacity)
        }

        return visualEffect.alphaValue
    }

    private func setAlpha(_ alpha: CGFloat) {
        visualEffect.alphaValue = alpha
        visualEffect.layer?.opacity = Float(alpha)
    }

    private func animateOpacity(
        to targetAlpha: CGFloat,
        duration: TimeInterval,
        timingFunctionName: CAMediaTimingFunctionName
    ) {
        let startingAlpha = currentPresentationAlpha()
        setAlpha(targetAlpha)

        guard let layer = visualEffect.layer else {
            return
        }

        let animation = CABasicAnimation(keyPath: "opacity")
        animation.fromValue = Float(startingAlpha)
        animation.toValue = Float(targetAlpha)
        animation.duration = duration
        animation.timingFunction = CAMediaTimingFunction(name: timingFunctionName)
        animation.isRemovedOnCompletion = true
        layer.add(animation, forKey: Self.opacityAnimationKey)
    }

    init(frame: NSRect, spec: BlurLayerSpec, material: NSVisualEffectView.Material) {
        self.spec = spec
        self.targetFrame = frame
        self.window = NSWindow(
            contentRect: Self.hiddenFrame(for: frame),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        self.visualEffect = NSVisualEffectView(frame: NSRect(origin: .zero, size: frame.size))

        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .floating
        window.ignoresMouseEvents = true
        // `moveToActiveSpace` and `stationary` raise on current macOS builds for these
        // auxiliary blur windows and prevent the helper from reaching its ready state.
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none

        visualEffect.autoresizingMask = [.width, .height]
        visualEffect.blendingMode = .behindWindow
        visualEffect.state = .active
        visualEffect.material = material
        visualEffect.alphaValue = 0
        visualEffect.wantsLayer = true

        window.contentView = visualEffect
        applyMask()
    }

    func update(
        spec: BlurLayerSpec,
        frame: NSRect,
        material: NSVisualEffectView.Material,
        opacityExponent: CGFloat,
        curveExponent: CGFloat
    ) {
        let previousFrame = targetFrame
        let frameChanged = previousFrame != frame
        let specChanged = self.spec != spec
        let opacityChanged = self.opacityExponent != opacityExponent || self.curveExponent != curveExponent
        let materialChanged = visualEffect.material != material

        self.spec = spec
        self.targetFrame = frame
        self.opacityExponent = opacityExponent
        self.curveExponent = curveExponent
        if materialChanged {
            visualEffect.material = material
        }

        let destinationFrame = (isPresented || window.isVisible) ? frame : Self.hiddenFrame(for: frame)
        if window.frame != destinationFrame {
            window.setFrame(destinationFrame, display: true, animate: false)
        }

        if frameChanged && visualEffect.frame.size != frame.size {
            visualEffect.frame = NSRect(origin: .zero, size: frame.size)
        }

        if specChanged || frameChanged || opacityChanged {
            applyMask()
        }
    }

    func show(
        alpha: CGFloat,
        animated: Bool,
        duration: TimeInterval,
        timingFunctionName: CAMediaTimingFunctionName
    ) {
        let wasWindowVisible = window.isVisible
        freezePresentationState()
        if !wasWindowVisible {
            window.setFrame(targetFrame, display: false, animate: false)
            setAlpha(0)
        }
        window.orderFrontRegardless()
        isPresented = true
        if animated {
            animateOpacity(to: alpha, duration: duration, timingFunctionName: timingFunctionName)
        } else {
            window.setFrame(targetFrame, display: true, animate: false)
            setAlpha(alpha)
        }
    }

    func hide(
        animated: Bool,
        duration: TimeInterval,
        timingFunctionName: CAMediaTimingFunctionName
    ) {
        freezePresentationState()
        isPresented = false
        if animated {
            animateOpacity(to: 0, duration: duration, timingFunctionName: timingFunctionName)
        } else {
            setAlpha(0)
            orderOutIfHidden()
        }
    }

    func orderOutIfHidden() {
        guard isPresented == false, currentPresentationAlpha() <= 0.0001 else {
            return
        }

        window.orderOut(nil)
        let nextHiddenFrame = Self.hiddenFrame(for: targetFrame)
        if window.frame != nextHiddenFrame {
            window.setFrame(nextHiddenFrame, display: false, animate: false)
        }
    }

    func prime() {
        freezePresentationState()
        window.setFrame(targetFrame, display: false, animate: false)
        setAlpha(0)
        window.orderFrontRegardless()
        // Warm the blur stack once, but do not leave the hidden windows pinned
        // to whichever Space was active when the helper launched.
        window.orderOut(nil)
        isPresented = false
    }

    func dispose() {
        window.orderOut(nil)
        window.close()
    }

    private static func hiddenFrame(for frame: NSRect) -> NSRect {
        let travel = min(max(frame.height * 0.16, 26), 96)
        return NSRect(
            x: frame.minX,
            y: frame.minY - travel,
            width: frame.width,
            height: frame.height
        )
    }

    private func applyMask() {
        let maskLayer = CALayer()
        maskLayer.frame = visualEffect.bounds
        maskLayer.contentsGravity = .resize
        maskLayer.contentsScale = max(window.backingScaleFactor, 1)
        maskLayer.contents = makeCurvedFeatherMaskImage(
            size: CGSize(
                width: max(maskLayer.bounds.width * maskLayer.contentsScale, 1),
                height: max(maskLayer.bounds.height * maskLayer.contentsScale, 1)
            )
        )
        visualEffect.layer?.mask = maskLayer
    }

    private func makeCurvedFeatherMaskImage(size: CGSize) -> CGImage? {
        let width = max(Int(size.width.rounded(.up)), 1)
        let height = max(Int(size.height.rounded(.up)), 1)
        let bytesPerPixel = 4
        let bytesPerRow = width * bytesPerPixel
        var pixels = [UInt8](repeating: 0, count: height * bytesPerRow)

        for row in 0..<height {
            let yFromBottom = CGFloat(height - 1 - row) / CGFloat(max(height - 1, 1))

            for column in 0..<width {
                let x = CGFloat(column) / CGFloat(max(width - 1, 1))
                let centeredX = (x * 2) - 1
                let smileWeight = 1 - pow(centeredX * centeredX, max(curveExponent, 0.2))

                let zeroOpacityBoundary = clamp(
                    spec.zeroOpacitySide - (spec.zeroOpacityDroop * smileWeight),
                    min: 0.05,
                    max: 0.995
                )
                let fullOpacityBoundary = clamp(
                    spec.fullOpacitySide - (spec.fullOpacityDroop * smileWeight),
                    min: 0,
                    max: zeroOpacityBoundary - 0.04
                )

                let alpha: CGFloat
                if yFromBottom >= zeroOpacityBoundary {
                    alpha = 0
                } else if yFromBottom <= fullOpacityBoundary {
                    alpha = 1
                } else {
                    let progress = 1 - (
                        (yFromBottom - fullOpacityBoundary)
                        / max(zeroOpacityBoundary - fullOpacityBoundary, 0.0001)
                    )
                    alpha = pow(clamp(progress, min: 0, max: 1), max(opacityExponent, 0.2))
                }

                let offset = row * bytesPerRow + column * bytesPerPixel
                let alphaByte = UInt8(clamp(alpha, min: 0, max: 1) * 255)
                pixels[offset] = 255
                pixels[offset + 1] = 255
                pixels[offset + 2] = 255
                pixels[offset + 3] = alphaByte
            }
        }

        guard let provider = CGDataProvider(data: Data(pixels) as CFData) else {
            return nil
        }

        return CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: true,
            intent: .defaultIntent
        )
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private static let materials: [MaterialSpec] = [
        MaterialSpec(name: "appearanceBased", material: .appearanceBased),
        MaterialSpec(name: "light", material: .light),
        MaterialSpec(name: "dark", material: .dark),
        MaterialSpec(name: "mediumLight", material: .mediumLight),
        MaterialSpec(name: "ultraDark", material: .ultraDark),
    ]

    private let shouldShowTuningUI = CommandLine.arguments.contains("--tuning-ui")
    private let blurShowAnimationDuration: TimeInterval = 0.05
    private let blurHideAnimationDuration: TimeInterval = 0.065
    private var inputBuffer = Data()
    private var parameters: PreviewParameters
    private var blurLayers: [BlurWindowLayer] = []
    private var isBlurVisible = false
    private var latestVisibilityCommandId = 0

    private var tuningWindow: NSWindow?
    private var tuningDocumentView: FlippedView?
    private var sliderBindings: [ObjectIdentifier: SliderKey] = [:]
    private var valueLabels: [SliderKey: NSTextField] = [:]
    private var materialPopup: NSPopUpButton?

    override init() {
        self.parameters = Self.defaultParameters(heightRatio: Self.parseHeightRatio())
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let screen = Self.screenUnderCursor() else {
            fputs("error: could not resolve active screen\n", stderr)
            NSApp.terminate(nil)
            return
        }

        applyCurrentParameters(animated: false)

        if shouldShowTuningUI {
            tuningWindow = makeTuningWindow(for: screen)
            tuningWindow?.makeKeyAndOrderFront(nil)
            tuningWindow?.orderFrontRegardless()
            NSApp.activate(ignoringOtherApps: true)
            showBlur(animated: false)
        } else {
            for layer in blurLayers {
                layer.prime()
            }
        }

        startCommandListener()
        emitStdout("ready")
    }

    private static func defaultParameters(heightRatio: CGFloat) -> PreviewParameters {
        PreviewParameters(
            heightRatio: heightRatio,
            layerCount: 8,
            opacityExponent: 1.8201525497291484,
            curveExponent: 0.9843073974565228,
            materialName: "dark",
            tallestHeightMultiplier: 1.1734517967402227,
            shortestHeightMultiplier: 0.15189505887539573,
            tallestAlpha: 0.5622468922151332,
            shortestAlpha: 0.862179504076226,
            tallestZeroOpacitySide: 0.803404042647185,
            shortestZeroOpacitySide: 0.41244045076510294,
            tallestZeroOpacityDroop: 0.09281168863378668,
            shortestZeroOpacityDroop: 0.10515262019801101,
            tallestFullOpacitySide: 0.23064220302315439,
            shortestFullOpacitySide: 0.034374099173501545,
            tallestFullOpacityDroop: 0.07833875256530871,
            shortestFullOpacityDroop: 0.02625202571267625
        )
    }

    private func material(for name: String) -> NSVisualEffectView.Material {
        Self.materials.first(where: { $0.name == name })?.material ?? .dark
    }

    private func activeLayerSpecs() -> [BlurLayerSpec] {
        let count = max(parameters.layerCount, 1)
        return (0..<count).map { index in
            let t = CGFloat(index) / CGFloat(max(count - 1, 1))
            return derivedSpec(progress: t)
        }
    }

    private func derivedSpec(progress t: CGFloat) -> BlurLayerSpec {
        let unclampedSpec = BlurLayerSpec(
            heightMultiplier: lerp(parameters.tallestHeightMultiplier, parameters.shortestHeightMultiplier, t),
            targetAlpha: lerp(parameters.tallestAlpha, parameters.shortestAlpha, t),
            zeroOpacitySide: lerp(parameters.tallestZeroOpacitySide, parameters.shortestZeroOpacitySide, t),
            zeroOpacityDroop: lerp(parameters.tallestZeroOpacityDroop, parameters.shortestZeroOpacityDroop, t),
            fullOpacitySide: lerp(parameters.tallestFullOpacitySide, parameters.shortestFullOpacitySide, t),
            fullOpacityDroop: lerp(parameters.tallestFullOpacityDroop, parameters.shortestFullOpacityDroop, t)
        )

        let zeroOpacitySide = clamp(unclampedSpec.zeroOpacitySide, min: 0.08, max: 0.995)
        let zeroOpacityDroop = clamp(unclampedSpec.zeroOpacityDroop, min: 0, max: zeroOpacitySide - 0.05)

        var fullOpacitySide = clamp(unclampedSpec.fullOpacitySide, min: 0, max: zeroOpacitySide - 0.05)
        var fullOpacityDroop = clamp(unclampedSpec.fullOpacityDroop, min: 0, max: fullOpacitySide)

        let zeroOpacityCenter = zeroOpacitySide - zeroOpacityDroop
        let minimumCenterGap: CGFloat = 0.05
        let fullOpacityCenter = fullOpacitySide - fullOpacityDroop

        if fullOpacityCenter > zeroOpacityCenter - minimumCenterGap {
            fullOpacityDroop = max(0, fullOpacitySide - (zeroOpacityCenter - minimumCenterGap))
        }

        if fullOpacitySide > zeroOpacitySide - minimumCenterGap {
            fullOpacitySide = zeroOpacitySide - minimumCenterGap
            fullOpacityDroop = min(fullOpacityDroop, fullOpacitySide)
        }

        return BlurLayerSpec(
            heightMultiplier: clamp(unclampedSpec.heightMultiplier, min: 0.08, max: 1.8),
            targetAlpha: clamp(unclampedSpec.targetAlpha, min: 0, max: 1),
            zeroOpacitySide: zeroOpacitySide,
            zeroOpacityDroop: zeroOpacityDroop,
            fullOpacitySide: max(0, fullOpacitySide),
            fullOpacityDroop: max(0, fullOpacityDroop)
        )
    }

    private func frame(for screen: NSScreen, heightMultiplier: CGFloat) -> NSRect {
        let screenFrame = screen.frame
        let blurHeight = max(1, screenFrame.height * parameters.heightRatio * heightMultiplier)
        return NSRect(
            x: screenFrame.minX,
            y: screenFrame.minY,
            width: screenFrame.width,
            height: blurHeight
        )
    }

    private func showBlur(animated: Bool, completion: (() -> Void)? = nil) {
        isBlurVisible = true
        applyCurrentParameters(animated: animated, completion: completion)
    }

    private func hideBlur(animated: Bool, completion: (() -> Void)? = nil) {
        isBlurVisible = false
        if animated {
            runOpacityAnimationTransaction(completion: {
                for layer in self.blurLayers {
                    layer.orderOutIfHidden()
                }
                completion?()
            }) {
                for layer in blurLayers {
                    layer.hide(
                        animated: true,
                        duration: blurHideAnimationDuration,
                        timingFunctionName: .easeInEaseOut
                    )
                }
            }
        } else {
            for layer in blurLayers {
                layer.hide(
                    animated: false,
                    duration: blurHideAnimationDuration,
                    timingFunctionName: .easeInEaseOut
                )
            }
            completion?()
        }
    }

    private func applyCurrentParameters(animated: Bool, completion: (() -> Void)? = nil) {
        guard let screen = Self.screenUnderCursor() else {
            completion?()
            return
        }

        parameters = sanitize(parameters)
        let specs = activeLayerSpecs()
        let material = material(for: parameters.materialName)

        while blurLayers.count < specs.count {
            let spec = specs[blurLayers.count]
            blurLayers.append(
                BlurWindowLayer(
                    frame: frame(for: screen, heightMultiplier: spec.heightMultiplier),
                    spec: spec,
                    material: material
                )
            )
        }

        while blurLayers.count > specs.count {
            blurLayers.removeLast().dispose()
        }

        for (index, spec) in specs.enumerated() {
            blurLayers[index].update(
                spec: spec,
                frame: frame(for: screen, heightMultiplier: spec.heightMultiplier),
                material: material,
                opacityExponent: parameters.opacityExponent,
                curveExponent: parameters.curveExponent
            )
        }

        guard isBlurVisible else {
            completion?()
            return
        }

        if animated {
            runOpacityAnimationTransaction(completion: completion) {
                for (index, spec) in specs.enumerated() {
                    blurLayers[index].show(
                        alpha: spec.targetAlpha,
                        animated: true,
                        duration: blurShowAnimationDuration,
                        timingFunctionName: .easeInEaseOut
                    )
                }
            }
        } else {
            for (index, spec) in specs.enumerated() {
                blurLayers[index].show(
                    alpha: spec.targetAlpha,
                    animated: false,
                    duration: blurShowAnimationDuration,
                    timingFunctionName: .easeInEaseOut
                )
            }
            completion?()
        }
    }

    private func runOpacityAnimationTransaction(
        completion: (() -> Void)? = nil,
        updates: () -> Void
    ) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        CATransaction.setCompletionBlock(completion)
        updates()
        CATransaction.commit()
    }

    private func sanitize(_ input: PreviewParameters) -> PreviewParameters {
        var output = input
        output.heightRatio = clamp(output.heightRatio, min: 0.05, max: 1.8)
        output.layerCount = Int(clamp(CGFloat(output.layerCount), min: 1, max: 10))
        output.opacityExponent = clamp(output.opacityExponent, min: 0.2, max: 4.0)
        output.curveExponent = clamp(output.curveExponent, min: 0.2, max: 3.0)

        if Self.materials.contains(where: { $0.name == output.materialName }) == false {
            output.materialName = "dark"
        }

        output.tallestHeightMultiplier = clamp(output.tallestHeightMultiplier, min: 0.08, max: 1.8)
        output.shortestHeightMultiplier = clamp(output.shortestHeightMultiplier, min: 0.08, max: 1.8)
        if output.tallestHeightMultiplier < output.shortestHeightMultiplier {
            swap(&output.tallestHeightMultiplier, &output.shortestHeightMultiplier)
        }

        output.tallestAlpha = clamp(output.tallestAlpha, min: 0, max: 1)
        output.shortestAlpha = clamp(output.shortestAlpha, min: 0, max: 1)

        output.tallestZeroOpacitySide = clamp(output.tallestZeroOpacitySide, min: 0.12, max: 0.995)
        output.shortestZeroOpacitySide = clamp(output.shortestZeroOpacitySide, min: 0.12, max: 0.995)
        output.tallestZeroOpacityDroop = clamp(output.tallestZeroOpacityDroop, min: 0, max: output.tallestZeroOpacitySide - 0.05)
        output.shortestZeroOpacityDroop = clamp(output.shortestZeroOpacityDroop, min: 0, max: output.shortestZeroOpacitySide - 0.05)

        output.tallestFullOpacitySide = clamp(output.tallestFullOpacitySide, min: 0, max: output.tallestZeroOpacitySide - 0.05)
        output.shortestFullOpacitySide = clamp(output.shortestFullOpacitySide, min: 0, max: output.shortestZeroOpacitySide - 0.05)
        output.tallestFullOpacityDroop = clamp(output.tallestFullOpacityDroop, min: 0, max: output.tallestFullOpacitySide)
        output.shortestFullOpacityDroop = clamp(output.shortestFullOpacityDroop, min: 0, max: output.shortestFullOpacitySide)

        return output
    }

    private func makeTuningWindow(for screen: NSScreen) -> NSWindow {
        let window = NSPanel(
            contentRect: NSRect(
                x: screen.frame.minX + 24,
                y: screen.frame.maxY - 760,
                width: 620,
                height: 720
            ),
            styleMask: [.titled, .closable, .resizable, .utilityWindow],
            backing: .buffered,
            defer: false
        )

        window.title = "Progressive Blur Tuner"
        window.level = .statusBar
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.hidesOnDeactivate = false
        window.isFloatingPanel = true
        window.becomesKeyOnlyIfNeeded = false

        let scrollView = NSScrollView(frame: window.contentView?.bounds ?? .zero)
        scrollView.autoresizingMask = [.width, .height]
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false

        let documentView = FlippedView(frame: NSRect(x: 0, y: 0, width: 600, height: 1000))
        scrollView.documentView = documentView
        window.contentView = scrollView
        tuningDocumentView = documentView

        rebuildTuningControls()
        return window
    }

    private func rebuildTuningControls() {
        guard let documentView = tuningDocumentView else {
            return
        }

        documentView.subviews.forEach { $0.removeFromSuperview() }
        sliderBindings.removeAll()
        valueLabels.removeAll()

        let contentWidth = max(documentView.bounds.width, 580)
        var y: CGFloat = 16

        let buttonRow = NSView(frame: NSRect(x: 16, y: y, width: contentWidth - 32, height: 32))
        let randomizeButton = NSButton(title: "Randomize", target: self, action: #selector(handleRandomize(_:)))
        randomizeButton.frame = NSRect(x: 0, y: 0, width: 112, height: 32)
        let copyButton = NSButton(title: "Copy Params", target: self, action: #selector(handleCopy(_:)))
        copyButton.frame = NSRect(x: 124, y: 0, width: 120, height: 32)
        buttonRow.addSubview(randomizeButton)
        buttonRow.addSubview(copyButton)
        documentView.addSubview(buttonRow)
        y += 44

        addMaterialPopupRow(in: documentView, y: &y, width: contentWidth - 32)
        addSliderRow(title: "Height Ratio", key: .heightRatio, value: Double(parameters.heightRatio), range: 0.05...1.8, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)
        addSliderRow(title: "Layer Count", key: .layerCount, value: Double(parameters.layerCount), range: 1...10, integerOnly: true, in: documentView, y: &y, width: contentWidth - 32)
        addSliderRow(title: "Opacity Exponent", key: .opacityExponent, value: Double(parameters.opacityExponent), range: 0.2...4.0, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)
        addSliderRow(title: "Curve Exponent", key: .curveExponent, value: Double(parameters.curveExponent), range: 0.2...3.0, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)

        addSectionHeader("Layer Generator", in: documentView, y: &y)
        addSliderRow(title: "Tallest Layer Height", key: .tallestHeightMultiplier, value: Double(parameters.tallestHeightMultiplier), range: 0.08...1.8, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)
        addSliderRow(title: "Shortest Layer Height", key: .shortestHeightMultiplier, value: Double(parameters.shortestHeightMultiplier), range: 0.08...1.8, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)
        addSliderRow(title: "Tallest Layer Alpha", key: .tallestAlpha, value: Double(parameters.tallestAlpha), range: 0...1, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)
        addSliderRow(title: "Shortest Layer Alpha", key: .shortestAlpha, value: Double(parameters.shortestAlpha), range: 0...1, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)

        addSectionHeader("0% Opacity Curve", in: documentView, y: &y)
        addSliderRow(title: "Tallest Side Height", key: .tallestZeroOpacitySide, value: Double(parameters.tallestZeroOpacitySide), range: 0.12...0.995, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)
        addSliderRow(title: "Shortest Side Height", key: .shortestZeroOpacitySide, value: Double(parameters.shortestZeroOpacitySide), range: 0.12...0.995, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)
        addSliderRow(title: "Tallest Center Droop", key: .tallestZeroOpacityDroop, value: Double(parameters.tallestZeroOpacityDroop), range: 0...0.45, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)
        addSliderRow(title: "Shortest Center Droop", key: .shortestZeroOpacityDroop, value: Double(parameters.shortestZeroOpacityDroop), range: 0...0.45, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)

        addSectionHeader("100% Opacity Curve", in: documentView, y: &y)
        addSliderRow(title: "Tallest Side Height", key: .tallestFullOpacitySide, value: Double(parameters.tallestFullOpacitySide), range: 0...0.9, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)
        addSliderRow(title: "Shortest Side Height", key: .shortestFullOpacitySide, value: Double(parameters.shortestFullOpacitySide), range: 0...0.9, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)
        addSliderRow(title: "Tallest Center Droop", key: .tallestFullOpacityDroop, value: Double(parameters.tallestFullOpacityDroop), range: 0...0.45, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)
        addSliderRow(title: "Shortest Center Droop", key: .shortestFullOpacityDroop, value: Double(parameters.shortestFullOpacityDroop), range: 0...0.45, integerOnly: false, in: documentView, y: &y, width: contentWidth - 32)

        documentView.frame = NSRect(x: 0, y: 0, width: contentWidth, height: y + 24)
    }

    private func addSectionHeader(_ title: String, in documentView: NSView, y: inout CGFloat) {
        let header = NSTextField(labelWithString: title)
        header.frame = NSRect(x: 16, y: y + 4, width: 240, height: 20)
        header.font = NSFont.boldSystemFont(ofSize: 13)
        documentView.addSubview(header)
        y += 28
    }

    private func addMaterialPopupRow(in documentView: NSView, y: inout CGFloat, width: CGFloat) {
        let title = NSTextField(labelWithString: "Material")
        title.frame = NSRect(x: 16, y: y + 6, width: 100, height: 20)
        documentView.addSubview(title)

        let popup = NSPopUpButton(frame: NSRect(x: 130, y: y, width: width - 130, height: 28), pullsDown: false)
        popup.addItems(withTitles: Self.materials.map(\.name))
        popup.selectItem(withTitle: parameters.materialName)
        popup.target = self
        popup.action = #selector(handleMaterialChange(_:))
        documentView.addSubview(popup)
        materialPopup = popup
        y += 40
    }

    private func addSliderRow(
        title: String,
        key: SliderKey,
        value: Double,
        range: ClosedRange<Double>,
        integerOnly: Bool,
        in documentView: NSView,
        y: inout CGFloat,
        width: CGFloat
    ) {
        let titleField = NSTextField(labelWithString: title)
        titleField.frame = NSRect(x: 16, y: y + 4, width: 190, height: 18)
        documentView.addSubview(titleField)

        let slider = NSSlider(
            value: value,
            minValue: range.lowerBound,
            maxValue: range.upperBound,
            target: self,
            action: #selector(handleSliderChange(_:))
        )
        slider.frame = NSRect(x: 210, y: y, width: width - 300, height: 24)
        slider.isContinuous = true
        if integerOnly {
            slider.numberOfTickMarks = Int(range.upperBound - range.lowerBound) + 1
            slider.allowsTickMarkValuesOnly = true
        }
        documentView.addSubview(slider)
        sliderBindings[ObjectIdentifier(slider)] = key

        let valueField = NSTextField(labelWithString: formattedValue(value, integerOnly: integerOnly))
        valueField.frame = NSRect(x: width - 72, y: y + 4, width: 56, height: 18)
        valueField.alignment = .right
        valueField.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        documentView.addSubview(valueField)
        valueLabels[key] = valueField

        y += 32
    }

    private func formattedValue(_ value: Double, integerOnly: Bool) -> String {
        integerOnly ? String(Int(value.rounded())) : String(format: "%.3f", value)
    }

    @objc private func handleSliderChange(_ sender: NSSlider) {
        guard let key = sliderBindings[ObjectIdentifier(sender)] else {
            return
        }

        let newValue = sender.allowsTickMarkValuesOnly ? sender.doubleValue.rounded() : sender.doubleValue
        updateParameter(for: key, value: CGFloat(newValue))
        parameters = sanitize(parameters)
        valueLabels[key]?.stringValue = formattedValue(Double(valueForKey(key)), integerOnly: sender.allowsTickMarkValuesOnly)
        applyCurrentParameters(animated: false)
    }

    @objc private func handleMaterialChange(_ sender: NSPopUpButton) {
        guard let selected = sender.selectedItem?.title else {
            return
        }

        parameters.materialName = selected
        applyCurrentParameters(animated: false)
    }

    @objc private func handleRandomize(_ sender: NSButton) {
        parameters = randomParameters(baseHeightRatio: parameters.heightRatio, materialName: parameters.materialName)
        rebuildTuningControls()
        applyCurrentParameters(animated: false)
    }

    @objc private func handleCopy(_ sender: NSButton) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(parameters), let text = String(data: data, encoding: .utf8) {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            emitStdout("copied")
        }
    }

    private func randomParameters(baseHeightRatio: CGFloat, materialName: String) -> PreviewParameters {
        sanitize(
            PreviewParameters(
                heightRatio: clamp(baseHeightRatio + CGFloat.random(in: -0.05...0.08), min: 0.08, max: 1.5),
                layerCount: Int.random(in: 1...10),
                opacityExponent: CGFloat.random(in: 0.9...2.2),
                curveExponent: CGFloat.random(in: 0.8...1.8),
                materialName: materialName,
                tallestHeightMultiplier: CGFloat.random(in: 1.05...1.60),
                shortestHeightMultiplier: CGFloat.random(in: 0.14...0.82),
                tallestAlpha: CGFloat.random(in: 0.28...0.85),
                shortestAlpha: CGFloat.random(in: 0.65...1.0),
                tallestZeroOpacitySide: CGFloat.random(in: 0.78...0.96),
                shortestZeroOpacitySide: CGFloat.random(in: 0.20...0.65),
                tallestZeroOpacityDroop: CGFloat.random(in: 0.08...0.28),
                shortestZeroOpacityDroop: CGFloat.random(in: 0.03...0.18),
                tallestFullOpacitySide: CGFloat.random(in: 0.12...0.26),
                shortestFullOpacitySide: CGFloat.random(in: 0.01...0.12),
                tallestFullOpacityDroop: CGFloat.random(in: 0.03...0.12),
                shortestFullOpacityDroop: CGFloat.random(in: 0.01...0.08)
            )
        )
    }

    private func updateParameter(for key: SliderKey, value: CGFloat) {
        switch key {
        case .heightRatio:
            parameters.heightRatio = value
        case .layerCount:
            parameters.layerCount = Int(value.rounded())
        case .opacityExponent:
            parameters.opacityExponent = value
        case .curveExponent:
            parameters.curveExponent = value
        case .tallestHeightMultiplier:
            parameters.tallestHeightMultiplier = value
        case .shortestHeightMultiplier:
            parameters.shortestHeightMultiplier = value
        case .tallestAlpha:
            parameters.tallestAlpha = value
        case .shortestAlpha:
            parameters.shortestAlpha = value
        case .tallestZeroOpacitySide:
            parameters.tallestZeroOpacitySide = value
        case .shortestZeroOpacitySide:
            parameters.shortestZeroOpacitySide = value
        case .tallestZeroOpacityDroop:
            parameters.tallestZeroOpacityDroop = value
        case .shortestZeroOpacityDroop:
            parameters.shortestZeroOpacityDroop = value
        case .tallestFullOpacitySide:
            parameters.tallestFullOpacitySide = value
        case .shortestFullOpacitySide:
            parameters.shortestFullOpacitySide = value
        case .tallestFullOpacityDroop:
            parameters.tallestFullOpacityDroop = value
        case .shortestFullOpacityDroop:
            parameters.shortestFullOpacityDroop = value
        }
    }

    private func valueForKey(_ key: SliderKey) -> CGFloat {
        switch key {
        case .heightRatio:
            return parameters.heightRatio
        case .layerCount:
            return CGFloat(parameters.layerCount)
        case .opacityExponent:
            return parameters.opacityExponent
        case .curveExponent:
            return parameters.curveExponent
        case .tallestHeightMultiplier:
            return parameters.tallestHeightMultiplier
        case .shortestHeightMultiplier:
            return parameters.shortestHeightMultiplier
        case .tallestAlpha:
            return parameters.tallestAlpha
        case .shortestAlpha:
            return parameters.shortestAlpha
        case .tallestZeroOpacitySide:
            return parameters.tallestZeroOpacitySide
        case .shortestZeroOpacitySide:
            return parameters.shortestZeroOpacitySide
        case .tallestZeroOpacityDroop:
            return parameters.tallestZeroOpacityDroop
        case .shortestZeroOpacityDroop:
            return parameters.shortestZeroOpacityDroop
        case .tallestFullOpacitySide:
            return parameters.tallestFullOpacitySide
        case .shortestFullOpacitySide:
            return parameters.shortestFullOpacitySide
        case .tallestFullOpacityDroop:
            return parameters.tallestFullOpacityDroop
        case .shortestFullOpacityDroop:
            return parameters.shortestFullOpacityDroop
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
        let parts = command.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard let verb = parts.first.map(String.init) else {
            return
        }
        let commandId = parts.count > 1 ? Int(parts[1]) : nil

        switch verb {
        case "show":
            guard let commandId else {
                fputs("error: show command requires id\n", stderr)
                return
            }
            latestVisibilityCommandId = commandId
            showBlur(animated: true) {
                guard commandId == self.latestVisibilityCommandId, self.isBlurVisible else {
                    return
                }
                emitStdout("shown \(commandId)")
            }
        case "hide":
            guard let commandId else {
                fputs("error: hide command requires id\n", stderr)
                return
            }
            latestVisibilityCommandId = commandId
            hideBlur(animated: true) {
                guard commandId == self.latestVisibilityCommandId, self.isBlurVisible == false else {
                    return
                }
                emitStdout("hidden \(commandId)")
            }
        case "randomize":
            parameters = randomParameters(baseHeightRatio: parameters.heightRatio, materialName: parameters.materialName)
            if shouldShowTuningUI {
                rebuildTuningControls()
            }
            applyCurrentParameters(animated: false)
        case "copy":
            handleCopy(NSButton())
        case "exit":
            NSApp.terminate(nil)
        default:
            fputs("error: unknown command \(command)\n", stderr)
        }
    }

    private static func parseHeightRatio() -> CGFloat {
        for argument in CommandLine.arguments.dropFirst() {
            if let ratio = Double(argument) {
                return CGFloat(min(max(ratio, 0.05), 1.8))
            }
        }

        return 0.525638483451528
    }

    private static func screenUnderCursor() -> NSScreen? {
        let cursorLocation = NSEvent.mouseLocation

        if let screen = NSScreen.screens.first(where: { NSMouseInRect(cursorLocation, $0.frame, false) }) {
            return screen
        }

        return NSScreen.main ?? NSScreen.screens.first
    }
}

private func clamp(_ value: CGFloat, min minimum: CGFloat, max maximum: CGFloat) -> CGFloat {
    Swift.max(minimum, Swift.min(maximum, value))
}

private func lerp(_ start: CGFloat, _ end: CGFloat, _ t: CGFloat) -> CGFloat {
    start + ((end - start) * t)
}

private func emitStdout(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

let app = NSApplication.shared
let shouldShowTuningUI = CommandLine.arguments.contains("--tuning-ui")
app.setActivationPolicy(shouldShowTuningUI ? .accessory : .prohibited)

let delegate = AppDelegate()
app.delegate = delegate
app.run()
