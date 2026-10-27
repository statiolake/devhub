// The `.mac-scrim` / `.mac-sheet` rules of shell/styles/macos.css in AppKit:
// the questions layer over the window (dimmed, a click outside a sheet is
// Escape), the sheet itself (the raised material, attached to the window's top
// edge with its lower corners rounded, the dialog shadow, sliding in from 12pt
// above), and the small pieces every sheet draws with — a band, a caption, a
// keycap, a row glyph.

import AppKit
import DevHubCore

/// The 4pt grid (`--space-N`).
enum Space {
    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s5: CGFloat = 20
    static let s6: CGFloat = 24
    static let s8: CGFloat = 32
}

/// Text in the window's tokens, as attributed strings.
@MainActor
enum Ink {
    static func text(
        _ string: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor, lineHeight: CGFloat? = nil,
        alignment: NSTextAlignment = .natural, breaking: NSLineBreakMode = .byWordWrapping, mono: Bool = false
    ) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        paragraph.lineBreakMode = breaking
        if let lineHeight {
            paragraph.minimumLineHeight = size * lineHeight
            paragraph.maximumLineHeight = size * lineHeight
        }
        let font = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : ShellStyle.font(size, weight)
        return NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph])
    }

    /// How tall `text` is laid out `width` wide.
    static func height(_ text: NSAttributedString, width: CGFloat) -> CGFloat {
        guard text.length > 0 else { return 0 }
        let box = text.boundingRect(
            with: NSSize(width: max(1, width), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading])
        return ceil(box.height)
    }

    static func width(_ text: NSAttributedString) -> CGFloat {
        ceil(text.size().width)
    }

    /// One line, cut at the end when it does not fit.
    static func drawLine(_ text: NSAttributedString, in rect: CGRect) {
        let line = NSMutableAttributedString(attributedString: text)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        line.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: line.length))
        line.draw(with: rect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    /// `PathLabel`: the head gives way, the last segment survives.
    static func drawPath(_ path: String, suffix: String?, font: NSFont, color: NSColor, in rect: CGRect) {
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        let (head, tail) = PathLabel.split(path)
        let tailText = NSAttributedString(string: tail + (suffix ?? ""), attributes: attributes)
        let tailWidth = min(rect.width, ceil(tailText.size().width))
        let headWidth = max(0, rect.width - tailWidth)
        if !head.isEmpty, headWidth > 0 {
            drawLine(NSAttributedString(string: head, attributes: attributes), in: CGRect(x: rect.minX, y: rect.minY, width: headWidth, height: rect.height))
        }
        let headDrawn = head.isEmpty ? 0 : min(headWidth, ceil(NSAttributedString(string: head, attributes: attributes).size().width))
        drawLine(tailText, in: CGRect(x: rect.minX + headDrawn, y: rect.minY, width: tailWidth, height: rect.height))
    }
}

/// A row glyph (`mac-list-glyph`), as an SF Symbol in the row's ink.
@MainActor
enum PickerGlyphs {
    static func symbol(_ glyph: PickerGlyph) -> String {
        switch glyph {
        case .plus: return "plus"
        case .clone: return "square.and.arrow.down"
        case .ellipsis: return "ellipsis"
        case .folder: return "folder"
        case .host: return "server.rack"
        case .agent: return "sparkles"
        case .session: return "clock.arrow.circlepath"
        case .command: return "command"
        case .workspace: return "macwindow"
        case .action: return "paperplane"
        case .issue: return "smallcircle.filled.circle"
        case .branch: return "arrow.triangle.branch"
        }
    }

    static func draw(_ glyph: PickerGlyph, in rect: CGRect, color: NSColor) {
        let configuration = NSImage.SymbolConfiguration(pointSize: 12, weight: .regular)
            .applying(NSImage.SymbolConfiguration(paletteColors: [color]))
        guard let image = NSImage(systemSymbolName: symbol(glyph), accessibilityDescription: nil)?
            .withSymbolConfiguration(configuration) else { return }
        let size = image.size
        let scale = min(1, min(rect.width / max(1, size.width), rect.height / max(1, size.height)))
        let drawn = CGSize(width: size.width * scale, height: size.height * scale)
        let target = CGRect(x: rect.midX - drawn.width / 2, y: rect.midY - drawn.height / 2, width: drawn.width, height: drawn.height)
        image.draw(in: target, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }
}

/// `kbd`: a chord's key, as a keycap.
@MainActor
enum Keycap {
    static let font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)

    static func width(_ key: String) -> CGFloat {
        ceil((key as NSString).size(withAttributes: [.font: font]).width) + 10 + 2
    }

    /// Drawn with its top-left at `origin`; answers its width.
    @discardableResult
    static func draw(_ key: String, at origin: CGPoint, tokens: DevHubTheme, ink: NSColor) -> CGFloat {
        let width = Self.width(key)
        let box = CGRect(x: origin.x, y: origin.y, width: width, height: 17).insetBy(dx: 0.5, dy: 0.5)
        let shape = NSBezierPath(roundedRect: box, xRadius: 4, yRadius: 4)
        tokens.chrome.nsColor.setFill()
        shape.fill()
        tokens.lineSoft.nsColor.setStroke()
        shape.lineWidth = 1
        shape.stroke()
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink]
        let size = (key as NSString).size(withAttributes: attributes)
        (key as NSString).draw(at: CGPoint(x: origin.x + (width - size.width) / 2, y: origin.y + (17 - size.height) / 2), withAttributes: attributes)
        return width
    }
}

/// A plain flipped container that paints one colour (a band of a sheet).
@MainActor
class BandView: NSView {
    var fill: NSColor? { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        guard let fill else { return }
        fill.setFill()
        bounds.fill()
    }
}

/// A label that can be selected (a notice's words, a sheet's failure) but
/// never edited, sized to wrap at the width it is given.
@MainActor
final class WrappingLabel: NSTextField {
    init(selectable: Bool = false) {
        super.init(frame: .zero)
        isEditable = false
        isSelectable = selectable
        isBordered = false
        drawsBackground = false
        lineBreakMode = .byWordWrapping
        maximumNumberOfLines = 0
        cell?.wraps = true
        cell?.isScrollable = false
        focusRingType = .none
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    /// The height its text takes at `width`.
    func fittingHeight(width: CGFloat) -> CGFloat {
        guard attributedStringValue.length > 0 else { return 0 }
        preferredMaxLayoutWidth = width
        return ceil(cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: width, height: .greatestFiniteMagnitude)).height ?? 0)
    }
}

/// `.toast-action`: the quiet bordered button notices and the center use.
@MainActor
final class QuietButton: NSControl {
    var title: String { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    var style: ShellStyle { didSet { needsDisplay = true } }
    var onPress: (() -> Void)?
    /// The close mark (`toast-close`) instead of a word.
    var isCloseMark = false
    var enabled = true { didSet { needsDisplay = true } }
    private var hovering = false
    private var pressing = false
    private var tracking: NSTrackingArea?

    init(title: String, style: ShellStyle, closeMark: Bool = false, onPress: @escaping () -> Void) {
        self.title = title
        self.style = style
        self.onPress = onPress
        isCloseMark = closeMark
        super.init(frame: .zero)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { enabled }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private static let font = ShellStyle.font(12)

    override var intrinsicContentSize: NSSize {
        if isCloseMark { return NSSize(width: 20, height: 20) }
        let size = (title as NSString).size(withAttributes: [.font: Self.font])
        return NSSize(width: ceil(size.width) + 2 * Space.s2 + 2, height: 22)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }

    override func mouseDown(with event: NSEvent) {
        guard enabled, let window else { return }
        pressing = true
        needsDisplay = true
        while let next = window.nextEvent(matching: [.leftMouseUp, .leftMouseDragged]) {
            let inside = bounds.contains(convert(next.locationInWindow, from: nil))
            if next.type == .leftMouseUp {
                pressing = false
                needsDisplay = true
                if inside { onPress?() }
                return
            }
            if pressing != inside {
                pressing = inside
                needsDisplay = true
            }
        }
    }

    override func keyDown(with event: NSEvent) {
        if enabled, event.keyCode == 0x24 || event.keyCode == 0x31 || event.keyCode == 0x4C {
            onPress?()
            return
        }
        super.keyDown(with: event)
    }

    override func becomeFirstResponder() -> Bool { needsDisplay = true; return true }
    override func resignFirstResponder() -> Bool { needsDisplay = true; return true }

    override func draw(_ dirtyRect: NSRect) {
        let tokens = style.tokens
        let box = bounds.insetBy(dx: 0.5, dy: 0.5)
        let shape = NSBezierPath(roundedRect: box, xRadius: 6, yRadius: 6)
        if enabled {
            if pressing { tokens.washStrong.nsColor.setFill(); shape.fill() } else if hovering { tokens.wash.nsColor.setFill(); shape.fill() }
        }
        if !isCloseMark {
            tokens.line.nsColor.setStroke()
            shape.lineWidth = 1
            shape.stroke()
        }
        if window?.firstResponder === self {
            let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: -1, dy: -1), xRadius: 7, yRadius: 7)
            tokens.focusRing.nsColor.setStroke()
            ring.lineWidth = 2
            ring.stroke()
        }
        let alpha: CGFloat = enabled ? 1 : 0.4
        if isCloseMark {
            let ink = (hovering ? tokens.primary.nsColor : tokens.tertiary.nsColor).withAlphaComponent(alpha)
            let mark = NSBezierPath()
            let c = CGPoint(x: bounds.midX, y: bounds.midY)
            mark.move(to: CGPoint(x: c.x - 3, y: c.y - 3))
            mark.line(to: CGPoint(x: c.x + 3, y: c.y + 3))
            mark.move(to: CGPoint(x: c.x + 3, y: c.y - 3))
            mark.line(to: CGPoint(x: c.x - 3, y: c.y + 3))
            mark.lineWidth = 1.5
            mark.lineCapStyle = .round
            ink.setStroke()
            mark.stroke()
            return
        }
        let attributes: [NSAttributedString.Key: Any] = [.font: Self.font, .foregroundColor: tokens.primary.nsColor.withAlphaComponent(alpha)]
        let size = (title as NSString).size(withAttributes: attributes)
        (title as NSString).draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: attributes)
    }
}

/// One sheet: the raised material under its content, attached to the top
/// edge, the lower corners rounded, the dialog shadow.
@MainActor
final class SheetCard: NSView {
    let content: NSView
    /// The width the sheet asks for (`min(560px, 92vw)`, 840 with an aside).
    var preferredWidth: CGFloat
    /// What the content wants to be at a width (it lays itself out in it).
    var contentHeight: (CGFloat) -> CGFloat
    /// Where the keyboard goes when this sheet is on top.
    weak var keyView: NSView?
    /// Escape, and a click on the scrim.
    var onCancel: (() -> Void)?
    /// What drives the sheet, kept for as long as the sheet stands.
    var owner: AnyObject?
    private var style: ShellStyle
    private let clip = BandView()

    init(content: NSView, width: CGFloat, style: ShellStyle, height: @escaping (CGFloat) -> CGFloat) {
        self.content = content
        preferredWidth = width
        contentHeight = height
        self.style = style
        super.init(frame: .zero)
        wantsLayer = true
        clip.wantsLayer = true
        clip.layer?.masksToBounds = true
        clip.layer?.cornerRadius = 12
        clip.layer?.maskedCorners = [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
        addSubview(clip)
        clip.addSubview(content)
        restyle(style)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    func restyle(_ style: ShellStyle) {
        self.style = style
        clip.fill = style.tokens.raised.nsColor
        let shadow = NSShadow()
        let dialog = style.tokens.shadowDialog
        shadow.shadowColor = dialog.color.nsColor
        shadow.shadowBlurRadius = CGFloat(dialog.blur) / 2
        shadow.shadowOffset = NSSize(width: 0, height: -CGFloat(dialog.offsetY) / 2)
        self.shadow = shadow
    }

    override func layout() {
        super.layout()
        clip.frame = bounds
        content.frame = clip.bounds
    }

    /// The sheet's frame in a layer `size` big.
    func frame(in size: CGSize) -> CGRect {
        let width = min(preferredWidth, floor(size.width * (preferredWidth > 600 ? 0.94 : 0.92)))
        let cap = min(sheetMaxHeight, floor(size.height * 0.76))
        let height = min(cap, ceil(contentHeight(width)))
        return CGRect(x: floor((size.width - width) / 2), y: 0, width: width, height: height)
    }

    /// `max-height: min(520px, 76vh)`, a chord help's 640.
    var sheetMaxHeight: CGFloat = 520
}

/// A sheet's view that holds something to let go of when it goes.
@MainActor
protocol DisposableSheetContent: AnyObject {
    func dispose()
}

/// A sheet's view that redraws in a new appearance.
@MainActor
protocol RestylableSheetContent: AnyObject {
    func restyle(_ style: ShellStyle)
}

/// The questions layer (`picker` in the layout): the scrim and the stack of
/// sheets on it, the top one live.
@MainActor
final class SheetLayerView: NSView {
    private(set) var cards: [SheetCard] = []
    private var style: ShellStyle

    init(style: ShellStyle) {
        self.style = style
        super.init(frame: .zero)
        wantsLayer = true
        restyle(style)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override var acceptsFirstResponder: Bool { true }

    func restyle(_ style: ShellStyle) {
        self.style = style
        // `light-dark(rgba(0,0,0,.16), rgba(0,0,0,.42))`.
        let reduced = NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
        let alpha: CGFloat = style.tokens.palette.base == .dark ? (reduced ? 0.6 : 0.42) : (reduced ? 0.35 : 0.16)
        layer?.backgroundColor = NSColor.black.withAlphaComponent(alpha).cgColor
        for card in cards {
            card.restyle(style)
            func walk(_ view: NSView) {
                if let content = view as? RestylableSheetContent { content.restyle(style) }
                for child in view.subviews { walk(child) }
            }
            walk(card.content)
        }
    }

    /// The keyboard came to the layer: it goes on to the top sheet's field.
    override func becomeFirstResponder() -> Bool {
        if let key = cards.last?.keyView {
            DispatchQueue.main.async { [weak self, weak key] in
                guard let key, let window = self?.window, self?.cards.last?.keyView === key else { return }
                if window.firstResponder !== key { window.makeFirstResponder(key) }
            }
        }
        return true
    }

    func push(_ card: SheetCard, animated: Bool = true) {
        cards.last?.isHidden = true
        cards.append(card)
        addSubview(card)
        layoutCards()
        if animated, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, let layer = card.layer {
            // `mac-sheet-in`: from 12pt above and transparent, 160ms ease-out.
            let move = CABasicAnimation(keyPath: "transform.translation.y")
            move.fromValue = isFlipped ? -12 : 12
            move.toValue = 0
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0
            fade.toValue = 1
            let group = CAAnimationGroup()
            group.animations = [move, fade]
            group.duration = 0.16
            group.timingFunction = CAMediaTimingFunction(name: .easeOut)
            layer.add(group, forKey: "sheet-in")
        }
        focusTop()
    }

    /// Put `card` in place of the top one (the next question of a flow).
    func replaceTop(with card: SheetCard) {
        if let top = cards.popLast() { top.removeFromSuperview() }
        cards.append(card)
        addSubview(card)
        layoutCards()
        focusTop()
    }

    /// One sheet in place of another, wherever it stands in the stack.
    func replace(_ old: SheetCard, with card: SheetCard) {
        guard let index = cards.firstIndex(where: { $0 === old }) else { return push(card) }
        let top = index == cards.count - 1
        cards[index] = card
        Self.dispose(old)
        old.removeFromSuperview()
        addSubview(card)
        card.isHidden = !top
        layoutCards()
        if top { focusTop() }
    }

    /// Whatever a sheet's views hold onto (a key monitor, a timer).
    static func dispose(_ card: SheetCard) {
        func walk(_ view: NSView) {
            if let disposable = view as? DisposableSheetContent { disposable.dispose() }
            for child in view.subviews { walk(child) }
        }
        walk(card.content)
        card.owner = nil
    }

    func remove(_ card: SheetCard) {
        cards.removeAll { $0 === card }
        Self.dispose(card)
        card.removeFromSuperview()
        cards.last?.isHidden = false
        layoutCards()
        focusTop()
    }

    func focusTop() {
        guard let key = cards.last?.keyView else { return }
        DispatchQueue.main.async { [weak self, weak key] in
            guard let key, let window = self?.window else { return }
            window.makeFirstResponder(key)
        }
    }

    func layoutCards() {
        for card in cards {
            let frame = card.frame(in: bounds.size)
            if card.frame != frame { card.frame = frame }
            card.needsLayout = true
        }
    }

    override func layout() {
        super.layout()
        layoutCards()
    }

    override func resizeSubviews(withOldSize oldSize: NSSize) {
        super.resizeSubviews(withOldSize: oldSize)
        layoutCards()
    }

    /// A click on the scrim, outside every sheet, is Escape.
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard let top = cards.last, !top.frame.contains(point) else { return }
        top.onCancel?()
    }

    override func scrollWheel(with event: NSEvent) {}
}
