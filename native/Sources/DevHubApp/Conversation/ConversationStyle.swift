// conversation.css in AppKit's terms: the conversation's size, its faces and
// inks, and each box's padding, fill, border and corners, read from the
// window's tokens (`ShellStyle`), so the transcript wears the workbench's
// theme in light and in dark with no rule of its own for either. The one
// exception is a code block's syntax colours, VS Code's own Light+ and Dark+,
// picked by the appearance the window is in.

import AppKit
import DevHubCore

@MainActor
struct ConversationStyle {
    let shell: ShellStyle
    /// `--conversation-font-size`: a step larger than the terminal's, zoom included.
    let fontSize: CGFloat

    init(_ shell: ShellStyle) {
        self.shell = shell
        fontSize = CGFloat(SurfaceWords.fontSize(terminal: shell.terminalFontSize))
    }

    var tokens: DevHubTheme { shell.tokens }
    var dark: Bool { shell.dark }

    /// One em of the conversation's size, in points.
    func em(_ value: Double) -> CGFloat { CGFloat(value) * fontSize }

    /// `--space-N` px scaled with the conversation's size (they are px in CSS; the
    /// surface's px are the conversation's at 15).
    func px(_ value: Double) -> CGFloat { CGFloat(value) * fontSize / CGFloat(SurfaceMetrics.fontPx) }

    // MARK: Faces

    func sans(_ size: CGFloat, bold: Bool = false, medium: Bool = false, italic: Bool = false) -> NSFont {
        var font = NSFont.systemFont(ofSize: size, weight: bold ? .semibold : medium ? ShellStyle.medium : .regular)
        if italic {
            let descriptor = font.fontDescriptor.withSymbolicTraits(.italic)
            font = NSFont(descriptor: descriptor, size: size) ?? font
        }
        return font
    }

    func mono(_ size: CGFloat, bold: Bool = false, italic: Bool = false) -> NSFont {
        var font = TerminalFonts.font(family: shell.terminal.fontFamily, size: size)
        var traits: NSFontDescriptor.SymbolicTraits = []
        if bold { traits.insert(.bold) }
        if italic { traits.insert(.italic) }
        if !traits.isEmpty {
            let descriptor = font.fontDescriptor.withSymbolicTraits(traits)
            font = NSFont(descriptor: descriptor, size: size) ?? font
        }
        return font
    }

    func font(_ style: DocStyle) -> NSFont {
        let size = em(style.size)
        return style.mono
            ? mono(size, bold: style.bold, italic: style.italic)
            : sans(size, bold: style.bold, medium: style.medium, italic: style.italic)
    }

    /// The conversation's own body face.
    var body: NSFont { sans(fontSize) }

    /// `74ch`: the measure's width in the body face.
    var measure: CGFloat {
        let zero = ("0" as NSString).size(withAttributes: [.font: body]).width
        return zero * CGFloat(SurfaceMetrics.measureCh)
    }

    // MARK: Inks

    func ink(_ ink: DocInk?) -> NSColor {
        let t = tokens
        switch ink ?? .primary {
        case .primary: return t.primary.nsColor
        case .secondary: return t.secondary.nsColor
        case .tertiary: return t.tertiary.nsColor
        case .accent: return t.accent.nsColor
        case .accentInk: return t.accentInk.nsColor
        case .danger: return t.danger.nsColor
        case .waiting: return t.waiting.mix(0.8, with: t.secondary).nsColor
        case .statusIdle: return t.statusIdle.nsColor
        case .statusWorking: return t.statusWorking.nsColor
        case .statusWaiting: return t.statusWaiting.nsColor
        case .statusError: return t.statusError.nsColor
        case .statusDone: return t.statusDone.nsColor
        case .statusBackground: return t.statusBackground.nsColor
        case .surface: return t.surface.nsColor
        case .line: return t.line.nsColor
        case .lineSoft: return t.lineSoft.nsColor
        case .code: return t.primary.nsColor
        }
    }

    /// A code token's colour, Light+ or Dark+ by the appearance; nil takes the text's ink.
    func code(light: String?, dark darkColour: String?) -> NSColor? {
        let css = dark ? darkColour : light
        guard let css, let colour = DevHubColor(css: css) ?? DevHubColor(hex: css) else { return nil }
        return colour.nsColor
    }

    func color(_ value: DevHubColor) -> NSColor { value.nsColor }
    var wash: NSColor { tokens.wash.nsColor }
    var washStrong: NSColor { tokens.washStrong.nsColor }
    var surface: NSColor { tokens.surface.nsColor }
    var sunken: NSColor { tokens.sunken.nsColor }
    var raised: NSColor { tokens.raised.nsColor }
    var line: NSColor { tokens.line.nsColor }
    var lineSoft: NSColor { tokens.lineSoft.nsColor }
    var lineStrong: NSColor { tokens.lineStrong.nsColor }

    /// `color-mix(in srgb, token N%, transparent)`.
    func faded(_ token: DevHubColor, _ share: Double) -> NSColor { token.faded(share) }

    /// `color-mix(in srgb, token N%, other)`.
    func mix(_ token: DevHubColor, _ share: Double, _ other: DevHubColor) -> NSColor { token.mix(share, with: other).nsColor }

    // MARK: Chips

    struct Chip {
        var fill: NSColor?
        var border: NSColor?
        var radius: CGFloat
        /// Padding around the run's glyphs: horizontal, vertical.
        var padX: CGFloat
        var padY: CGFloat
    }

    func chip(_ chip: DocChip, size: CGFloat) -> Chip {
        switch chip {
        case .code: return Chip(fill: wash, border: nil, radius: 4, padX: 0.35 * size, padY: 0.1 * size)
        case .skill:
            return Chip(fill: faded(tokens.accent, 0.16), border: faded(tokens.accent, 0.16), radius: 0.3 * size, padX: 0, padY: 0)
        case .model: return Chip(fill: wash, border: nil, radius: 999, padX: 0.5 * size, padY: 0)
        case .sandbox:
            return Chip(fill: nil, border: faded(tokens.waiting, 0.35), radius: CGFloat(DevHubTheme.Radius.control), padX: 0.4 * size, padY: 0)
        case .questionHeader: return Chip(fill: faded(tokens.accent, 0.12), border: nil, radius: 999, padX: 0.6 * size, padY: 0.05 * size)
        case .key: return Chip(fill: nil, border: nil, radius: 0, padX: 0, padY: 0)
        }
    }

    // MARK: Boxes

    struct Box {
        var padTop: CGFloat = 0
        var padBottom: CGFloat = 0
        var padLeft: CGFloat = 0
        var padRight: CGFloat = 0
        var fill: NSColor?
        var border: NSColor?
        var dashed = false
        /// Top-left, top-right, bottom-right, bottom-left.
        var radii: (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        /// A rule down the box's leading edge, its width and colour (a quote, thinking).
        var rail: (CGFloat, NSColor)?
        /// A hairline over the box (`border-top`), inside its sides.
        var topRule: NSColor?
        /// At most this wide (the bubble, a message not from the person), as a share of the column and in ch.
        var maxShare: CGFloat?
        var maxCh: CGFloat?
        /// Drawn against the column's trailing edge, as wide as its words (the bubble).
        var trailing = false
    }

    func box(_ style: DocBoxStyle, flat: Bool = false) -> Box {
        let s2 = px(8), s3 = px(12), panel = CGFloat(DevHubTheme.Radius.panel), control = CGFloat(DevHubTheme.Radius.control)
        func all(_ r: CGFloat) -> (CGFloat, CGFloat, CGFloat, CGFloat) { (r, r, r, r) }
        switch style {
        case .bubble:
            let big = em(1.1), small = em(0.35)
            return Box(padTop: s2, padBottom: s2, padLeft: s3, padRight: s3, fill: washStrong, radii: (big, big, small, big), maxShare: 0.85, maxCh: 60, trailing: true)
        case .bubbleDashed:
            let big = em(1.1), small = em(0.35)
            return Box(padTop: s2, padBottom: s2, padLeft: s3, padRight: s3, border: line, dashed: true, radii: (big, big, small, big), maxShare: 0.85, maxCh: 60, trailing: true)
        case .other:
            return Box(padTop: s2, padBottom: s2, padLeft: s3, padRight: s3, border: line, dashed: true, radii: all(panel), maxShare: 0.85, maxCh: 60)
        case .checklist:
            return Box(padTop: s2, padBottom: s2, padLeft: s3, padRight: s3, border: lineSoft, radii: all(panel))
        case .quote:
            return Box(padLeft: s3, rail: (3, line))
        case .rail:
            return Box(padLeft: s3, rail: (2, lineSoft))
        case .railDanger:
            return Box(padLeft: s3, rail: (2, faded(tokens.danger, 0.5)))
        case .toolBody:
            return Box(padTop: 0, padBottom: 0, padLeft: s3, padRight: s3, fill: sunken, border: lineSoft, radii: all(panel))
        case .diff:
            return Box(padTop: 0, padBottom: 0, padLeft: 0, padRight: 0, fill: sunken, border: lineSoft, radii: all(control))
        case .subagent:
            return flat
                ? Box(fill: raised, border: lineSoft)
                : Box(fill: raised, border: lineSoft, radii: all(panel))
        case .subagentEntries:
            return flat
                ? Box(padTop: s2, padBottom: px(12), padLeft: 0, padRight: 0, topRule: lineSoft)
                : Box(padTop: s2, padBottom: px(12), padLeft: s3, padRight: s3, topRule: lineSoft)
        case .noticeWarning:
            return Box(padTop: s2, padBottom: s2, padLeft: s3, padRight: s3, fill: mix(tokens.waiting, 0.1, tokens.surface), radii: all(panel))
        case .noticeError:
            return Box(padTop: s2, padBottom: s2, padLeft: s3, padRight: s3, fill: mix(tokens.danger, 0.1, tokens.surface), radii: all(panel))
        case .sunkenPanel:
            return Box(padTop: s2, padBottom: s2, padLeft: s3, padRight: s3, fill: sunken, border: lineSoft, radii: all(control))
        case .preview:
            return Box(padTop: s2, padBottom: s2, padLeft: s3, padRight: s3, fill: sunken, border: lineSoft, radii: all(control))
        case .footnotes:
            return Box(padTop: 0, topRule: lineSoft)
        case .plain:
            return Box()
        }
    }

    /// Where a find's matches are drawn: every match, and the current one.
    var findMatch: NSColor { faded(tokens.statusWorking, 0.3) }
    var findCurrent: NSColor { tokens.statusWorking.nsColor }
    var bandAdd: NSColor { faded(tokens.statusIdle, 0.16) }
    var bandRemove: NSColor { faded(tokens.danger, 0.16) }
}

extension DevHubColor {
    /// `#rrggbb` or `#rrggbbaa`, as a theme file writes a token colour.
    init?(hex: String) {
        var text = hex.trimmingCharacters(in: .whitespaces)
        guard text.hasPrefix("#") else { return nil }
        text.removeFirst()
        if text.count == 3 || text.count == 4 { text = text.map { "\($0)\($0)" }.joined() }
        guard text.count == 6 || text.count == 8, let value = UInt64(text, radix: 16) else { return nil }
        let hasAlpha = text.count == 8
        let r = Double((value >> (hasAlpha ? 24 : 16)) & 0xff) / 255
        let g = Double((value >> (hasAlpha ? 16 : 8)) & 0xff) / 255
        let b = Double((value >> (hasAlpha ? 8 : 0)) & 0xff) / 255
        let a = hasAlpha ? Double(value & 0xff) / 255 : 1
        self.init(red: r, green: g, blue: b, alpha: a)
    }
}
