// Vector artwork shared by the app icon and native 1x/2x menu-bar symbols.
// Run from the repository root: swift scripts/generate-icons.swift
import AppKit

let assets = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("assets")
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: alpha)
}
func mark(_ ink: NSColor, _ accent: NSColor) {
    ink.setStroke()
    let body = NSBezierPath(roundedRect: NSRect(x: 5, y: 4.5, width: 12, height: 15), xRadius: 2, yRadius: 2)
    body.lineWidth = 1.6
    body.stroke()
    accent.setFill()
    NSBezierPath(roundedRect: NSRect(x: 8, y: 2, width: 6, height: 4), xRadius: 1.3, yRadius: 1.3).fill()
    let n = NSBezierPath()
    n.move(to: NSPoint(x: 8.2, y: 15.8))
    n.line(to: NSPoint(x: 8.2, y: 9))
    n.line(to: NSPoint(x: 13.8, y: 15.8))
    n.line(to: NSPoint(x: 13.8, y: 9))
    n.lineWidth = 1.65
    n.lineCapStyle = .round
    n.lineJoinStyle = .round
    accent.setStroke()
    n.stroke()
}
func render(_ name: String, points: Int, scale: Int, draw: () -> Void) throws {
    let pixels = points * scale
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let transform = NSAffineTransform()
    transform.translateX(by: 0, yBy: CGFloat(pixels))
    transform.scaleX(by: CGFloat(scale), yBy: -CGFloat(scale))
    transform.concat()
    draw()
    NSGraphicsContext.restoreGraphicsState()
    // Set DPI metadata after drawing; doing this earlier scales the context twice.
    bitmap.size = NSSize(width: points, height: points)
    try bitmap.representation(using: .png, properties: [:])!.write(to: assets.appendingPathComponent(name))
}
try render("icon.png", points: 1024, scale: 1) {
    let tile = NSBezierPath(roundedRect: NSRect(x: 64, y: 64, width: 896, height: 896), xRadius: 204, yRadius: 204)
    NSGradient(colors: [color(57, 83, 191), color(25, 32, 79), color(12, 18, 39)])!.draw(in: tile, angle: 45)
    color(187, 215, 255, 0.22).setStroke()
    tile.lineWidth = 3
    tile.stroke()
    let transform = NSAffineTransform()
    transform.translateX(by: 116, yBy: 116)
    transform.scale(by: 36)
    transform.concat()
    mark(color(240, 246, 255), color(98, 231, 233))
}
for scale in [1, 2] {
    for (suffix, today, overdue) in [("", false, false), ("-today", true, false), ("-overdue", false, true), ("-both", true, true)] {
        let name = "tray\(suffix)Template\(scale == 2 ? "@2x" : "").png"
        try render(name, points: 22, scale: scale) {
            mark(.black, .black)
            NSColor.black.setFill()
            if overdue { NSBezierPath(ovalIn: NSRect(x: 0.5, y: 15, width: 2.5, height: 2.5)).fill() }
            if today { NSBezierPath(ovalIn: NSRect(x: 19, y: 15, width: 2.5, height: 2.5)).fill() }
        }
    }
}
print("Generated app artwork and 1x/2x menu-bar template icons.")
