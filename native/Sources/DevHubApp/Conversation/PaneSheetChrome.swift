// A sheet over one Agent's pane, drawn the way DevHub's pickers are
// (`.mac-scrim` / `.mac-sheet picker` of shell/styles/macos.css): the pane
// dimmed under it, the raised material, a heading band in the chrome with
// the title and the question under it, the sheet's own body, and a footer
// band in the chrome with a note and the buttons at its trailing end — a
// hairline between every two bands. Attached to the pane's top edge with its
// lower corners rounded (the MCP panel), or centred with every corner
// rounded (the failure sheet, `.agent-failure-scrim`). It slides in from
// 12pt above, as a picker does; a click on the scrim is its Cancel, and so
// is Escape.

import AppKit
import DevHubCore

@MainActor
class PaneSheetFrame: NSView {
    enum Placement { case top, centred }

    private(set) var style: ShellStyle
    let placement: Placement
    /// `min(560px, 92vw)`, 840 with an aside, 520 for a failure.
    var preferredWidth: CGFloat
    /// The sheet: its shadow, and inside it the material, clipped to its corners, with the bands.
    let card = BandView()
    private let material = BandView()
    let header = BandView()
    let titleLabel = WrappingLabel(selectable: false)
    let questionLabel = WrappingLabel(selectable: true)
    /// The sheet's own content, between the heading and the footer.
    let body = BandView()
    let footer = BandView()
    let noteLabel = WrappingLabel(selectable: true)
    private(set) var buttons: [DevHubButton] = []
    private var seams: [CGRect] = []
    private var animated = false
    var onCancel: (() -> Void)?
    /// The title wraps (a failure's) rather than being cut.
    var titleWraps = false

    init(style: ShellStyle, placement: Placement, width: CGFloat) {
        self.style = style
        self.placement = placement
        preferredWidth = width
        super.init(frame: .zero)
        wantsLayer = true
        card.wantsLayer = true
        material.wantsLayer = true
        material.layer?.masksToBounds = true
        addSubview(card)
        card.addSubview(material)
        material.addSubview(header)
        header.addSubview(titleLabel)
        header.addSubview(questionLabel)
        material.addSubview(body)
        material.addSubview(footer)
        footer.addSubview(noteLabel)
        setAccessibilityElement(true)
        setAccessibilityRole(.sheet)
        restyleFrame(style)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    func restyleFrame(_ style: ShellStyle) {
        self.style = style
        let tokens = style.tokens
        // `light-dark(rgba(0,0,0,.16), rgba(0,0,0,.42))`.
        layer?.backgroundColor = NSColor.black.withAlphaComponent(tokens.palette.base == .dark ? 0.42 : 0.16).cgColor
        material.fill = tokens.raised.nsColor
        header.fill = tokens.chrome.nsColor
        footer.fill = tokens.chrome.nsColor
        body.fill = nil
        for button in buttons { button.style = style }
        needsLayout = true
        needsDisplay = true
    }

    /// The heading's words.
    func setHeading(title: String, question: String) {
        let tokens = style.tokens
        titleLabel.attributedStringValue = Ink.text(
            title, size: 13, weight: .semibold, color: tokens.primary.nsColor, breaking: titleWraps ? .byWordWrapping : .byTruncatingTail)
        questionLabel.attributedStringValue = Ink.text(question, size: 11, color: tokens.secondary.nsColor, lineHeight: 1.3)
        questionLabel.isHidden = question.isEmpty
        setAccessibilityLabel(title)
        needsLayout = true
    }

    /// The footer's note: guidance in the quiet ink, a failure in the danger ink.
    func setNote(_ lines: [(text: String, failure: Bool)]) {
        let tokens = style.tokens
        let note = NSMutableAttributedString()
        for (index, line) in lines.enumerated() {
            note.append(Ink.text((index == 0 ? "" : "\n") + line.text, size: 11, color: line.failure ? tokens.danger.nsColor : tokens.secondary.nsColor, lineHeight: 1.3))
        }
        noteLabel.attributedStringValue = note
        noteLabel.isHidden = note.length == 0
        needsLayout = true
    }

    /// The footer's buttons, in order, the default one last.
    func setButtons(_ specs: [(title: String, isDefault: Bool, enabled: Bool, run: () -> Void)]) {
        for button in buttons { button.removeFromSuperview() }
        buttons = specs.map { spec in
            let button = DevHubButton(title: spec.title, isDefault: spec.isDefault, style: style, onPress: spec.run)
            button.isEnabled = spec.enabled
            footer.addSubview(button)
            return button
        }
        needsLayout = true
    }

    // MARK: Geometry

    private let inset = Space.s4

    private func headerHeight(_ width: CGFloat) -> CGFloat {
        let inner = width - 2 * inset
        let title = titleWraps ? titleLabel.fittingHeight(width: inner) : 17
        let question = questionLabel.isHidden ? 0 : 2 + questionLabel.fittingHeight(width: inner)
        return Space.s3 + title + question + Space.s3
    }

    private func footerHeight(_ width: CGFloat) -> CGFloat {
        var parts: [CGFloat] = []
        if !noteLabel.isHidden { parts.append(noteLabel.fittingHeight(width: width - 2 * inset)) }
        if !buttons.isEmpty { parts.append(22) }
        guard !parts.isEmpty else { return 0 }
        return Space.s3 + parts.reduce(0, +) + CGFloat(parts.count - 1) * Space.s2 + Space.s3
    }

    /// What the body wants at `width` (subclasses say).
    func bodyHeight(forWidth width: CGFloat) -> CGFloat { 0 }

    /// Lay the body's content out in `body.bounds` (subclasses do).
    func layoutBody() {}

    /// The sheet's frame in the pane.
    private func cardFrame() -> CGRect {
        let margin: CGFloat = placement == .centred ? Space.s4 : 0
        let width = min(preferredWidth, floor((bounds.width - 2 * margin) * (placement == .top ? (preferredWidth > 600 ? 0.94 : 0.92) : 1)))
        let cap = placement == .top ? min(560, floor(bounds.height * 0.76)) : bounds.height - 2 * margin
        let wanted = headerHeight(width) + 1 + bodyHeight(forWidth: width) + (footerHeight(width) > 0 ? 1 + footerHeight(width) : 0)
        let height = min(cap, ceil(wanted))
        let y = placement == .top ? 0 : max(margin, floor((bounds.height - height) / 2))
        return CGRect(x: floor((bounds.width - width) / 2), y: y, width: width, height: height)
    }

    override func layout() {
        super.layout()
        let frame = cardFrame()
        card.frame = frame
        material.frame = card.bounds
        material.layer?.cornerRadius = 12
        material.layer?.maskedCorners = placement == .top
            ? [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
            : [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner]
        let width = frame.width
        let inner = width - 2 * inset
        seams = []
        var y: CGFloat = 0
        let headerH = headerHeight(width)
        header.frame = CGRect(x: 0, y: y, width: width, height: headerH)
        let titleH = titleWraps ? titleLabel.fittingHeight(width: inner) : 17
        titleLabel.frame = CGRect(x: inset, y: Space.s3, width: inner, height: titleH)
        questionLabel.frame = CGRect(x: inset, y: Space.s3 + titleH + 2, width: inner, height: questionLabel.fittingHeight(width: inner))
        y += headerH
        seams.append(CGRect(x: 0, y: y, width: width, height: 1))
        y += 1
        let footerH = footerHeight(width)
        let bodyH = max(0, frame.height - y - (footerH > 0 ? footerH + 1 : 0))
        body.frame = CGRect(x: 0, y: y, width: width, height: bodyH)
        layoutBody()
        y += bodyH
        footer.isHidden = footerH == 0
        if footerH > 0 {
            seams.append(CGRect(x: 0, y: y, width: width, height: 1))
            y += 1
            footer.frame = CGRect(x: 0, y: y, width: width, height: footerH)
            var fy = Space.s3
            if !noteLabel.isHidden {
                let h = noteLabel.fittingHeight(width: inner)
                noteLabel.frame = CGRect(x: inset, y: fy, width: inner, height: h)
                fy += h + Space.s2
            }
            var x = width - inset
            for button in buttons.reversed() {
                let size = button.intrinsicContentSize
                x -= size.width
                button.frame = CGRect(x: x, y: fy, width: size.width, height: 22)
                x -= Space.s2
            }
        }
        // The dialog shadow, outside the clipped material.
        let dialog = style.tokens.shadowDialog
        layer?.shadowPath = nil
        card.shadow = {
            let shadow = NSShadow()
            shadow.shadowColor = dialog.color.nsColor
            shadow.shadowBlurRadius = CGFloat(dialog.blur) / 2
            shadow.shadowOffset = NSSize(width: 0, height: -CGFloat(dialog.offsetY) / 2)
            return shadow
        }()
        drawSeams()
        if !animated, window != nil {
            animated = true
            slideIn()
        }
    }

    /// `mac-sheet-in`: from 12pt above and transparent, 160ms ease-out.
    private func slideIn() {
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, let layer = card.layer else { return }
        let move = CABasicAnimation(keyPath: "transform.translation.y")
        move.fromValue = -12
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

    // MARK: Cancel

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if !card.frame.contains(point) { onCancel?() }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onCancel?() } else { super.keyDown(with: event) }
    }

    override func cancelOperation(_ sender: Any?) { onCancel?() }

    /// The hairlines between the bands, drawn over the card.
    final class Seams: NSView {
        var rects: [CGRect] = [] { didSet { needsDisplay = true } }
        var ink: NSColor = .separatorColor { didSet { needsDisplay = true } }
        override var isFlipped: Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func draw(_ dirtyRect: NSRect) {
            ink.setFill()
            for rect in rects { rect.fill() }
        }
    }

    private let seamView = Seams()

    /// The hairlines, over the bands.
    private func drawSeams() {
        if seamView.superview !== material || material.subviews.last !== seamView {
            material.addSubview(seamView, positioned: .above, relativeTo: nil)
        }
        seamView.frame = material.bounds
        seamView.ink = style.tokens.lineSoft.nsColor
        seamView.rects = seams
    }
}
