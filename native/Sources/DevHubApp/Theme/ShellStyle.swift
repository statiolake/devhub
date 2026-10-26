// The window's tokens in AppKit's terms, in one place every view reads from:
// the palette as `NSColor`s, the type scale the TS app's CSS sets (13px body,
// 11px quiet, the 590/510/600 weights), and the Sidebar's marks as Core
// Graphics paths read from Core's path data (`Glyphs`).
//
// DevHub always has a palette, so the window wears it the way the TS app does
// with `data-window-material="none"`: the Sidebar and the title bar painted
// `chrome`, the body `canvas`, the panes `surface`.

import AppKit
import DevHubCore

/// What every view paints with, as of the last appearance change.
@MainActor
final class ShellStyle {
    private(set) var tokens: DevHubTheme
    private(set) var terminal: TerminalAppearance
    /// Whether the window is in a dark appearance now.
    private(set) var dark: Bool
    /// The terminal font size the panes are told (the setting plus the zoom).
    private(set) var terminalFontSize: Double

    init(tokens: DevHubTheme, terminal: TerminalAppearance, dark: Bool, terminalFontSize: Double) {
        self.tokens = tokens
        self.terminal = terminal
        self.dark = dark
        self.terminalFontSize = terminalFontSize
    }

    /// A style before any settings have been read: the built-in palette.
    static func initial(dark: Bool, titleBar: DevHubTheme.TitleBar) -> ShellStyle {
        let palette = DevHubTheme.fallbackPalette(dark ? .dark : .light)
        let tokens = DevHubTheme(palette: palette, titleBar: titleBar)
        let terminal = TerminalAppearance(
            fontFamily: TerminalFontStack.defaultFamily, fontSize: 13, lineHeight: 1, scrollSensitivity: 1,
            margin: TerminalAppearance.defaultMargin, theme: .defaults)
        return ShellStyle(tokens: tokens, terminal: terminal, dark: dark, terminalFontSize: 13)
    }

    func update(tokens: DevHubTheme, terminal: TerminalAppearance, dark: Bool, terminalFontSize: Double) {
        self.tokens = tokens
        self.terminal = terminal
        self.dark = dark
        self.terminalFontSize = terminalFontSize
    }

    var sidebar: DevHubTheme.SidebarMetrics { tokens.sidebar }
    var chrome: DevHubTheme.ChromeMetrics { tokens.chromeMetrics }

    // MARK: Type

    /// `font-weight: 590`, the system's title weight.
    static let semibold = NSFont.Weight(rawValue: 0.3)
    /// `font-weight: 510`.
    static let medium = NSFont.Weight(rawValue: 0.23)

    static func font(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        NSFont.systemFont(ofSize: size, weight: weight)
    }

    /// The terminal's font at the size the panes are told.
    func terminalFont() -> NSFont {
        TerminalFonts.font(family: terminal.fontFamily, size: CGFloat(terminalFontSize))
    }

    /// The ANSI palette the window's scheme asks for.
    func terminalPalette() -> TerminalPalette {
        terminal.palette(dark: dark)
    }

    // MARK: Colour tokens by name

    /// A `var(--token)` the model names (a Project lane's ink), as a colour.
    func color(token name: String) -> NSColor? {
        let key = name.hasPrefix("--") ? name : "--\(name)"
        guard let css = tokens.cssVariables[key], let color = DevHubColor(css: css) else { return nil }
        return color.nsColor
    }
}

extension DevHubColor {
    /// The same colour at a share of its alpha (`color-mix(... N%, transparent)`).
    func faded(_ share: Double) -> NSColor {
        DevHubColor(red: red, green: green, blue: blue, alpha: alpha * share).nsColor
    }
}

extension TerminalPalette {
    /// One of the palette's CSS colours as an `NSColor`.
    static func ns(_ css: String?) -> NSColor? {
        guard let css, let color = DevHubColor(css: css) else { return nil }
        return color.nsColor
    }
}

// MARK: - Glyphs as paths

/// A Sidebar or chrome mark, drawn with Core Graphics from Core's path data.
enum GlyphPainter {
    /// Parsed outlines, by their path data, so a row redraw does not re-read them.
    @MainActor private static var cache: [String: CGPath] = [:]

    @MainActor
    static func path(_ data: String) -> CGPath {
        if let hit = cache[data] { return hit }
        let path = CGMutablePath()
        for command in (try? PathData.parse(data)) ?? [] {
            switch command {
            case let .move(x, y): path.move(to: CGPoint(x: x, y: y))
            case let .line(x, y): path.addLine(to: CGPoint(x: x, y: y))
            case let .cubic(x1, y1, x2, y2, x, y):
                path.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2))
            case .close: path.closeSubpath()
            }
        }
        cache[data] = path
        return path
    }

    /// Draw `drawing` into `rect` (a square) in `color`, stroked at `stroke`
    /// units of its own box, in a flipped context (y grows downwards, as the
    /// SVG it came from does). `rotation` turns it about its centre.
    @MainActor
    static func draw(
        _ drawing: GlyphDrawing, in rect: CGRect, color: NSColor, stroke: Double, rotation: CGFloat = 0,
        context: CGContext? = NSGraphicsContext.current?.cgContext
    ) {
        guard let context else { return }
        context.saveGState()
        defer { context.restoreGState() }
        let scale = rect.width / CGFloat(drawing.box)
        context.translateBy(x: rect.minX, y: rect.minY)
        if rotation != 0 {
            context.translateBy(x: rect.width / 2, y: rect.height / 2)
            context.rotate(by: rotation)
            context.translateBy(x: -rect.width / 2, y: -rect.height / 2)
        }
        context.scaleBy(x: scale, y: scale)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        context.setLineWidth(CGFloat(stroke))
        context.setStrokeColor(color.cgColor)
        context.setFillColor(color.cgColor)
        for shape in drawing.shapes {
            switch shape {
            case let .path(data, filled):
                context.addPath(path(data))
                if filled { context.fillPath() } else { context.strokePath() }
            case let .circle(cx, cy, r, filled):
                let circle = CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r)
                if filled { context.fillEllipse(in: circle) } else { context.strokeEllipse(in: circle) }
            case let .rect(x, y, width, height, radius):
                let box = CGRect(x: x, y: y, width: width, height: height)
                context.addPath(CGPath(roundedRect: box, cornerWidth: radius, cornerHeight: radius, transform: nil))
                context.strokePath()
            }
        }
    }

    @MainActor
    static func draw(
        _ glyph: RowGlyph, in rect: CGRect, color: NSColor, stroke: Double, rotation: CGFloat = 0
    ) {
        draw(Glyphs.drawing(glyph), in: rect, color: color, stroke: stroke, rotation: rotation)
    }

    @MainActor
    static func draw(_ glyph: ChromeGlyph, in rect: CGRect, color: NSColor, stroke: Double) {
        draw(Glyphs.drawing(glyph), in: rect, color: color, stroke: stroke)
    }
}

/// A square that is centred on `point`.
func square(centeredOn point: CGPoint, side: CGFloat) -> CGRect {
    CGRect(x: point.x - side / 2, y: point.y - side / 2, width: side, height: side)
}

extension LayoutRect {
    var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

extension CGRect {
    var layoutRect: LayoutRect { LayoutRect(x: Double(minX), y: Double(minY), width: Double(width), height: Double(height)) }
}
