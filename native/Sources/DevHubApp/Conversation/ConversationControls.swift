// The conversation's small controls (conversation.css): the quiet buttons
// under a message (`.conversation-copy`), the bordered ones of a confirmation
// (`.conversation-confirm-go`), an icon button (`.conversation-subagent-action`),
// a request's answers (`.conversation-request-choice`), and the composer's
// round Send / Stop. Each is drawn here rather than as an `NSButton`, so it
// takes the transcript's size and inks and nothing of the system's bezels.

import AppKit
import DevHubCore

@MainActor
final class ConversationButton: NSView {
    enum Look: Equatable {
        /// An icon and a word in the faintest ink, the wash under the pointer.
        case quiet
        /// A hairline box on the raised ground.
        case bordered
        /// An icon alone, in a square.
        case icon
        /// Underlined words, no box.
        case link
        /// A request's answer, toned.
        case choice(ChoiceTone)
        /// The composer's round button: Send in the accent, Stop in the primary ink.
        case round(danger: Bool)
    }

    var label: String { didSet { invalidate() } }
    var icon: DocIcon? { didSet { invalidate() } }
    var look: Look { didSet { invalidate() } }
    /// The face's size, in points.
    var size: CGFloat { didSet { invalidate() } }
    var style: ConversationStyle { didSet { needsDisplay = true } }
    var onPress: (() -> Void)?
    var isEnabled = true { didSet { needsDisplay = true } }
    /// `aria-pressed`: a toggle that is on.
    var isOn = false { didSet { needsDisplay = true } }
    /// "Copied": the word and the mark in the idle ink for a moment.
    var isDone = false { didSet { needsDisplay = true } }
    /// The digit that presses it from the keyboard (a request's first nine answers).
    var keyDigit: String? { didSet { invalidate() } }
    /// The ink for the label (nil: the look's own).
    var ink: NSColor? { didSet { needsDisplay = true } }
    private var hovering = false { didSet { needsDisplay = true } }
    private var pressing = false { didSet { needsDisplay = true } }
    private var tracking: NSTrackingArea?

    init(label: String, icon: DocIcon? = nil, look: Look, size: CGFloat, style: ConversationStyle, onPress: (() -> Void)? = nil) {
        self.label = label
        self.icon = icon
        self.look = look
        self.size = size
        self.style = style
        self.onPress = onPress
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(label)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { isEnabled }
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill() }
    override func accessibilityPerformPress() -> Bool {
        press()
        return true
    }

    private func invalidate() {
        invalidateIntrinsicContentSize()
        needsDisplay = true
        setAccessibilityLabel(label)
    }

    private var font: NSFont { style.sans(size, medium: look == .bordered) }

    private var padX: CGFloat {
        switch look {
        case .icon: return 3
        case .link: return 0
        case .round: return 0
        default: return style.px(8)
        }
    }

    private var radius: CGFloat {
        switch look {
        case .round: return bounds.height / 2
        case .link: return 0
        default: return CGFloat(DevHubTheme.Radius.control)
        }
    }

    private var gap: CGFloat { 0.4 * size }

    override var intrinsicContentSize: NSSize {
        let words = label.isEmpty || look == .icon ? 0 : (label as NSString).size(withAttributes: [.font: font]).width
        let mark = icon == nil ? 0 : size
        let digit = keyDigit.map { ($0 as NSString).size(withAttributes: [.font: style.mono(size * 0.85)]).width + gap } ?? 0
        if case .round = look { return NSSize(width: size * 2, height: size * 2) }
        let inner = words + mark + (words > 0 && mark > 0 ? gap : 0) + digit
        let height: CGFloat = look == .icon ? size + 6 : ceil(size * 1.4) + 4 + (look == .bordered || isChoice ? 2 : 0)
        return NSSize(width: ceil(inner + 2 * padX + (look == .icon ? 0 : 0)), height: height)
    }

    private var isChoice: Bool { if case .choice = look { return true }; return false }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func resetCursorRects() { addCursorRect(bounds, cursor: isEnabled ? .pointingHand : .arrow) }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        pressing = true
        var inside = true
        while let next = window?.nextEvent(matching: [.leftMouseUp, .leftMouseDragged]) {
            inside = bounds.contains(convert(next.locationInWindow, from: nil))
            pressing = inside
            if next.type == .leftMouseUp { break }
        }
        pressing = false
        if inside { press() }
    }

    override func keyDown(with event: NSEvent) {
        if event.charactersIgnoringModifiers == " " || event.keyCode == 36 { press() } else { super.keyDown(with: event) }
    }

    func press() {
        guard isEnabled else { return }
        onPress?()
    }

    override func draw(_ dirtyRect: NSRect) {
        let t = style.tokens
        var fill: NSColor?
        var border: NSColor?
        var ink = style.ink(.tertiary)
        switch look {
        case .quiet:
            if hovering || pressing { fill = style.wash; ink = style.ink(.primary) }
            if isDone { ink = style.ink(.statusIdle) }
        case .bordered:
            fill = hovering && isEnabled ? style.wash : style.raised
            border = style.line
            ink = style.ink(.primary)
        case .icon:
            if isOn { fill = style.washStrong; ink = style.ink(.primary) }
            if hovering { fill = style.wash; ink = style.ink(.primary) }
        case .link:
            ink = hovering ? style.ink(.primary) : style.ink(.secondary)
        case .choice(let tone):
            border = style.line
            fill = hovering && isEnabled ? style.wash : style.raised
            ink = style.ink(.primary)
            switch tone {
            case .allow:
                fill = hovering && isEnabled ? style.mix(t.accent, 0.85, t.primary) : t.accent.nsColor
                border = t.accent.nsColor
                ink = t.accentInk.nsColor == t.accent.nsColor ? style.surface : NSColor.white
            case .deny: ink = style.ink(.danger)
            case .neutral: break
            }
        case .round(let stop):
            fill = (stop ? t.primary : t.accent).nsColor
            if !isEnabled { fill = style.washStrong }
            ink = isEnabled ? (stop ? t.surface.nsColor : t.accentInk.nsColor) : style.ink(.tertiary)
            if !stop, isEnabled, t.accentInk == t.accent { ink = .white }
        }
        if let custom = self.ink { ink = custom }
        if !isEnabled { ink = ink.withAlphaComponent(0.5) }
        let box = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: box, xRadius: radius, yRadius: radius)
        if let fill { fill.setFill(); path.fill() }
        if let border { border.setStroke(); path.lineWidth = 1; path.stroke() }
        if pressing, look != .link { style.wash.setFill(); path.fill() }

        var x = padX
        let midY = bounds.midY
        if case .round = look {
            if let icon {
                let side = size
                GlyphPainter.draw(ConversationIcons.drawing(icon), in: CGRect(x: bounds.midX - side / 2, y: midY - side / 2, width: side, height: side), color: ink, stroke: ConversationIcons.stroke)
            }
            return
        }
        if let digit = keyDigit {
            let digitFont = style.mono(size * 0.85)
            let attributes: [NSAttributedString.Key: Any] = [.font: digitFont, .foregroundColor: ink.withAlphaComponent(0.6)]
            let width = (digit as NSString).size(withAttributes: attributes).width
            (digit as NSString).draw(at: NSPoint(x: x, y: midY - digitFont.boundingRectForFont.height / 2 + 1), withAttributes: attributes)
            x += width + gap
        }
        if let icon {
            let side = size
            let drawing = ConversationIcons.drawing(isDone && icon == .copy ? .check : icon)
            let rect = look == .icon
                ? CGRect(x: bounds.midX - side / 2, y: midY - side / 2, width: side, height: side)
                : CGRect(x: x, y: midY - side / 2, width: side, height: side)
            GlyphPainter.draw(drawing, in: rect, color: ink, stroke: ConversationIcons.stroke)
            x += side + gap
        }
        guard look != .icon, !label.isEmpty else { return }
        var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink]
        if look == .link { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        let words = (isDone && label == "Copy" ? "Copied" : label) as NSString
        let height = words.size(withAttributes: attributes).height
        words.draw(at: NSPoint(x: x, y: midY - height / 2), withAttributes: attributes)
    }
}

/// A row of controls laid out left to right, wrapping, as a flex row does.
@MainActor
final class FlowRow: NSView {
    var spacing: CGFloat = 2
    var lineSpacing: CGFloat = 4
    var align: DocAlign = .leading { didSet { needsLayout = true } }
    var items: [NSView] = [] {
        didSet {
            for view in oldValue where !items.contains(where: { $0 === view }) { view.removeFromSuperview() }
            for view in items where view.superview !== self { addSubview(view) }
            needsLayout = true
        }
    }

    override var isFlipped: Bool { true }

    /// The rows' frames for a width.
    private func arrange(_ width: CGFloat) -> (frames: [NSRect], height: CGFloat) {
        var frames: [NSRect] = []
        var lines: [[Int]] = [[]]
        var x: CGFloat = 0
        for (index, view) in items.enumerated() {
            let size = view.intrinsicContentSize
            if x > 0, x + size.width > width {
                lines.append([])
                x = 0
            }
            lines[lines.count - 1].append(index)
            frames.append(NSRect(x: x, y: 0, width: min(size.width, width), height: size.height))
            x += size.width + spacing
        }
        var y: CGFloat = 0
        for line in lines where !line.isEmpty {
            let height = line.map { frames[$0].height }.max() ?? 0
            let used = (frames[line.last!].maxX)
            let shift: CGFloat = align == .trailing ? width - used : align == .center ? (width - used) / 2 : 0
            for index in line {
                frames[index].origin.x += max(0, shift)
                frames[index].origin.y = y + (height - frames[index].height) / 2
            }
            y += height + lineSpacing
        }
        return (frames, max(0, y - lineSpacing))
    }

    func height(forWidth width: CGFloat) -> CGFloat { arrange(width).height }

    override func layout() {
        super.layout()
        let (frames, _) = arrange(bounds.width)
        for (view, frame) in zip(items, frames) { view.frame = frame }
    }
}
