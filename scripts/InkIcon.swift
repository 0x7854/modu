import AppKit
import CoreGraphics
import CoreText
import Foundation

// Draws the same ink-seal mark as public/favicon.svg entirely with AppKit and
// CoreGraphics primitives. No bitmap source artwork is used.
let cream = NSColor(srgbRed: 0xF6 / 255.0, green: 0xF0 / 255.0, blue: 0xE3 / 255.0, alpha: 1.0)
let sealGreen = NSColor(srgbRed: 0x55 / 255.0, green: 0x72 / 255.0, blue: 0x5B / 255.0, alpha: 1.0)
let borderCream = NSColor(srgbRed: 0xF6 / 255.0, green: 0xF0 / 255.0, blue: 0xE3 / 255.0, alpha: 0.35)

func sealFont(size: CGFloat) -> CTFont {
    let candidates = ["STSongti-SC-Bold", "Songti SC Bold", "STSong"]
    for name in candidates {
        let font = CTFontCreateWithName(name as CFString, size, nil)
        let actual = CTFontCopyPostScriptName(font) as String
        if actual == name || actual.contains("Songti") || actual == "STSong" {
            return font
        }
    }
    return CTFontCreateWithName("Times New Roman Bold" as CFString, size, nil)
}

func drawSeal(size: Int, destination: String) throws {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw NSError(domain: "InkIcon", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法创建位图"])
    }

    guard let graphicsContext = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw NSError(domain: "InkIcon", code: 2, userInfo: [NSLocalizedDescriptionKey: "无法创建绘图上下文"])
    }

    let s = CGFloat(size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphicsContext
    let cg = graphicsContext.cgContext
    cg.setShouldAntialias(true)
    cg.setAllowsAntialiasing(true)
    cg.interpolationQuality = .high
    cg.clear(CGRect(x: 0, y: 0, width: s, height: s))

    // Outer paper tile: favicon 64px rect rx=14.
    let outer = NSBezierPath(
        roundedRect: NSRect(x: 0, y: 0, width: s, height: s),
        xRadius: s * 14.0 / 64.0,
        yRadius: s * 14.0 / 64.0
    )
    cream.setFill()
    outer.fill()

    // Green seal: favicon x/y=8, side=48, rx=7.
    let sealRect = NSRect(x: s * 8.0 / 64.0, y: s * 8.0 / 64.0, width: s * 48.0 / 64.0, height: s * 48.0 / 64.0)
    let seal = NSBezierPath(
        roundedRect: sealRect,
        xRadius: s * 7.0 / 64.0,
        yRadius: s * 7.0 / 64.0
    )
    sealGreen.setFill()
    seal.fill()

    // Inner keyline: favicon x/y=12, side=40, rx=4, 35% cream.
    let keylineInset = s * 12.0 / 64.0
    let keyline = NSBezierPath(
        roundedRect: NSRect(
            x: keylineInset,
            y: keylineInset,
            width: s - keylineInset * 2.0,
            height: s - keylineInset * 2.0
        ),
        xRadius: s * 4.0 / 64.0,
        yRadius: s * 4.0 / 64.0
    )
    keyline.lineWidth = max(1.0, s * 0.75 / 64.0)
    borderCream.setStroke()
    keyline.stroke()

    // 墨: favicon 34px Songti at 64px, centered on x=32, baseline y=44 from top.
    let font = sealFont(size: s * 34.0 / 64.0)
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(rawValue: kCTFontAttributeName as String): font,
        NSAttributedString.Key(rawValue: kCTForegroundColorAttributeName as String): cream.cgColor,
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: "墨", attributes: attributes))
    let bounds = CTLineGetBoundsWithOptions(line, [.useOpticalBounds])
    let baselineX = (s - bounds.width) * 0.5 - bounds.minX
    let baselineY = s * 20.0 / 64.0
    cg.textMatrix = .identity
    cg.textPosition = CGPoint(x: baselineX, y: baselineY)
    CTLineDraw(line, cg)

    NSGraphicsContext.restoreGraphicsState()

    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "InkIcon", code: 3, userInfo: [NSLocalizedDescriptionKey: "无法编码 PNG"])
    }
    try png.write(to: URL(fileURLWithPath: destination))
}

let arguments = CommandLine.arguments
guard arguments.count == 3, let pixelSize = Int(arguments[1]) else {
    fputs("用法: InkIcon <像素尺寸> <输出 PNG>\n", stderr)
    exit(64)
}
do {
    try drawSeal(size: pixelSize, destination: arguments[2])
} catch {
    fputs("绘制图标失败: \(error)\n", stderr)
    exit(1)
}
