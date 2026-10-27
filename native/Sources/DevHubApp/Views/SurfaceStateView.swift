// Port of shell/components/shell/SurfaceState.tsx (`Waiting`, `Failure`,
// `Empty`) and the `.mac-empty` / `.mac-button` / `.mac-spinner` rules of
// shell/styles/macos.css: what a pane draws when it has nothing of its own to
// show — the spinner with a word, or a mark, a title, a sentence and the
// buttons that are the way out.

import AppKit
import DevHubCore

/// One button of a surface state.
struct SurfaceAction {
    var label: String
    var primary: Bool = false
    var run: () -> Void
}

/// What a surface state says.
enum SurfaceStateContent {
    /// `Waiting`: a spinner and a word.
    case waiting(String)
    /// `Failure`: the danger mark, a title in the primary ink, the reason.
    case failure(title: String, detail: String?, actions: [SurfaceAction])
    /// `Empty`: the folder mark and a quiet title.
    case empty(title: String, message: String?, actions: [SurfaceAction])
}

/// `.mac-button`: a bordered, raised push button in the window's own tokens.
@MainActor
final class DevHubButton: NSControl {
    var title: String { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    var isDefault: Bool { didSet { needsDisplay = true } }
    var style: ShellStyle { didSet { needsDisplay = true } }
    var onPress: (() -> Void)?
    private var hovering = false
    private var pressing = false
    private var tracking: NSTrackingArea?

    init(title: String, isDefault: Bool, style: ShellStyle, onPress: @escaping () -> Void) {
        self.title = title
        self.isDefault = isDefault
        self.style = style
        self.onPress = onPress
        super.init(frame: .zero)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { isEnabled }
    override var mouseDownCanMoveWindow: Bool { false }
    override var isEnabled: Bool { didSet { needsDisplay = true } }

    private var labelFont: NSFont { ShellStyle.font(13, isDefault ? .medium : .regular) }

    override var intrinsicContentSize: NSSize {
        let text = (title as NSString).size(withAttributes: [.font: labelFont])
        return NSSize(width: ceil(text.width) + 26 + 2, height: max(22, ceil(text.height) + 4 + 2))
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        pressing = true
        needsDisplay = true
        guard let window else { return }
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
        if isEnabled, event.keyCode == 0x24 || event.keyCode == 0x31 || event.keyCode == 0x4C {
            onPress?()
            return
        }
        super.keyDown(with: event)
    }

    override func draw(_ dirtyRect: NSRect) {
        let tokens = style.tokens
        // Disabled: the whole button at half strength.
        if !isEnabled { NSGraphicsContext.current?.cgContext.setAlpha(0.5) }
        let box = bounds.insetBy(dx: 0.5, dy: 0.5)
        let shape = NSBezierPath(roundedRect: box, xRadius: 5, yRadius: 5)
        if isDefault {
            var fill = tokens.accent.nsColor
            if hovering { fill = fill.blended(withFraction: 0.08, of: .white) ?? fill }
            fill.setFill()
            shape.fill()
        } else {
            tokens.raised.nsColor.setFill()
            shape.fill()
            if pressing { tokens.washStrong.nsColor.setFill(); shape.fill() } else if hovering { tokens.wash.nsColor.setFill(); shape.fill() }
            tokens.lineStrong.nsColor.setStroke()
            shape.lineWidth = 1
            shape.stroke()
        }
        if window?.firstResponder === self {
            let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: -1, dy: -1), xRadius: 6, yRadius: 6)
            tokens.focusRing.nsColor.setStroke()
            ring.lineWidth = 2
            ring.stroke()
        }
        let ink = isDefault ? tokens.accentInk.nsColor : tokens.primary.nsColor
        let attributes: [NSAttributedString.Key: Any] = [.font: labelFont, .foregroundColor: ink]
        let size = (title as NSString).size(withAttributes: attributes)
        (title as NSString).draw(
            at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: attributes)
    }

    override func becomeFirstResponder() -> Bool { needsDisplay = true; return true }
    override func resignFirstResponder() -> Bool { needsDisplay = true; return true }
}

/// `.mac-spinner`: a ring with its top quarter missing, turning every 720ms.
@MainActor
final class SpinnerView: NSView {
    var color: NSColor = .tertiaryLabelColor { didSet { ring.strokeColor = color.cgColor } }
    private let ring = CAShapeLayer()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        ring.fillColor = nil
        ring.lineWidth = 2
        ring.strokeStart = 0
        ring.strokeEnd = 0.75
        layer?.addSublayer(ring)
        let spin = CABasicAnimation(keyPath: "transform.rotation.z")
        spin.fromValue = 0
        spin.toValue = -2 * Double.pi
        spin.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 2.4 : 0.72
        spin.repeatCount = .infinity
        ring.add(spin, forKey: "spin")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var intrinsicContentSize: NSSize { NSSize(width: 16, height: 16) }

    override func layout() {
        super.layout()
        ring.frame = bounds
        ring.bounds = bounds
        ring.position = CGPoint(x: bounds.midX, y: bounds.midY)
        ring.path = CGPath(ellipseIn: bounds.insetBy(dx: 1, dy: 1), transform: nil)
    }
}

/// A mark from `ChromeGlyph`, drawn at 44pt in the state's ink.
@MainActor
private final class StateGlyphView: NSView {
    var glyph: ChromeGlyph = .empty { didSet { needsDisplay = true } }
    var ink: NSColor = .tertiaryLabelColor { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }
    override var intrinsicContentSize: NSSize { NSSize(width: 44, height: 44) }
    override func draw(_ dirtyRect: NSRect) {
        GlyphPainter.draw(glyph, in: bounds, color: ink, stroke: 1.2)
    }
}

/// `.mac-empty`: the content, centred in the view, over the surface colour.
@MainActor
final class SurfaceStateView: NSView {
    private(set) var content: SurfaceStateContent?
    private var style: ShellStyle
    private let stack = NSStackView()
    private let glyph = StateGlyphView()
    private let spinner = SpinnerView()
    private let title = NSTextField(wrappingLabelWithString: "")
    private let message = NSTextField(wrappingLabelWithString: "")
    private let actions = NSStackView()
    /// Its buttons, in order: keyboard stops of the page it is on.
    var buttons: [NSView] { actions.arrangedSubviews.filter { $0 is DevHubButton } }
    /// Paint the surface colour under the content (a pane's cover).
    var paintsSurface = true { didSet { needsDisplay = true } }

    init(style: ShellStyle) {
        self.style = style
        super.init(frame: .zero)
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = CGFloat(DevHubTheme.Spacing.space3)
        stack.translatesAutoresizingMaskIntoConstraints = false
        actions.orientation = .horizontal
        actions.spacing = CGFloat(DevHubTheme.Spacing.space2)
        for label in [title, message] {
            label.alignment = .center
            label.isSelectable = false
            label.drawsBackground = false
            label.isBordered = false
        }
        message.isSelectable = true
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: CGFloat(DevHubTheme.Spacing.space8)),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -CGFloat(DevHubTheme.Spacing.space8)),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    func restyle(_ style: ShellStyle) {
        self.style = style
        if let content { show(content) }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard paintsSurface else { return }
        style.tokens.surface.nsColor.setFill()
        bounds.fill()
    }

    /// The text width a sentence keeps to (`max-width: 42ch / 52ch`), in points.
    private func measure(_ characters: Int, font: NSFont) -> CGFloat {
        CGFloat(characters) * ("0" as NSString).size(withAttributes: [.font: font]).width
    }

    func show(_ content: SurfaceStateContent) {
        self.content = content
        for view in stack.arrangedSubviews { stack.removeArrangedSubview(view); view.removeFromSuperview() }
        for view in actions.arrangedSubviews { actions.removeArrangedSubview(view); view.removeFromSuperview() }
        let tokens = style.tokens
        var primary: DevHubButton?
        func addButtons(_ list: [SurfaceAction]) {
            guard !list.isEmpty else { return }
            for action in list {
                let button = DevHubButton(title: action.label, isDefault: action.primary, style: style, onPress: action.run)
                actions.addArrangedSubview(button)
                if action.primary { primary = button }
            }
            stack.addArrangedSubview(actions)
            stack.setCustomSpacing(CGFloat(DevHubTheme.Spacing.space3 + DevHubTheme.Spacing.space2), after: stack.arrangedSubviews[max(0, stack.arrangedSubviews.count - 2)])
        }
        func setMessage(_ text: String?, color: NSColor, characters: Int) {
            guard let text, !text.isEmpty else { return }
            let font = ShellStyle.font(13)
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center
            // `line-height: 1.4`.
            paragraph.minimumLineHeight = 13 * 1.4
            paragraph.maximumLineHeight = 13 * 1.4
            message.attributedStringValue = NSAttributedString(
                string: text, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph])
            message.preferredMaxLayoutWidth = measure(characters, font: font)
            stack.addArrangedSubview(message)
        }
        switch content {
        case let .waiting(label):
            spinner.color = tokens.tertiary.nsColor
            stack.addArrangedSubview(spinner)
            setMessage(label, color: tokens.tertiary.nsColor, characters: 42)
        case let .failure(titleText, detail, list):
            glyph.glyph = .failure
            glyph.ink = tokens.danger.nsColor
            stack.addArrangedSubview(glyph)
            title.attributedStringValue = NSAttributedString(
                string: titleText, attributes: [.font: ShellStyle.font(15, .semibold), .foregroundColor: tokens.primary.nsColor])
            title.preferredMaxLayoutWidth = measure(36, font: ShellStyle.font(15, .semibold))
            stack.addArrangedSubview(title)
            setMessage(detail, color: tokens.secondary.nsColor, characters: 52)
            addButtons(list)
        case let .empty(titleText, text, list):
            glyph.glyph = .empty
            glyph.ink = tokens.tertiary.nsColor
            stack.addArrangedSubview(glyph)
            title.attributedStringValue = NSAttributedString(
                string: titleText, attributes: [.font: ShellStyle.font(15, .semibold), .foregroundColor: tokens.secondary.nsColor])
            title.preferredMaxLayoutWidth = measure(42, font: ShellStyle.font(15, .semibold))
            stack.addArrangedSubview(title)
            setMessage(text, color: tokens.tertiary.nsColor, characters: 42)
            addButtons(list)
        }
        setAccessibilityRole(.group)
        if case .failure = content { setAccessibilityLabel("Alert") }
        // `primary.current?.focus()`: the way out is where the keyboard is.
        if let primary, let window, !isHidden {
            DispatchQueue.main.async { [weak window] in
                guard let window, window.firstResponder == nil || window.firstResponder === window else { return }
                window.makeFirstResponder(primary)
            }
        }
    }

    /// The primary button, for the keyboard to land on.
    var primaryButton: NSView? {
        actions.arrangedSubviews.first { ($0 as? DevHubButton)?.isDefault == true }
    }
}
