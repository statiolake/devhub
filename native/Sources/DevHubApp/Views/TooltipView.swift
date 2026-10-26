// Port of shell/tooltip/TooltipApp.tsx and tooltipPage.css: the one tooltip
// the window draws, on its own layer above every other child (the layout's
// `tooltip` child), so a 44pt rail cannot clip it. It is a box of lines — a
// fact behind its mark, the name line larger, a meter as a bar — that the
// pointer can move into, and whose place-facts are links.

import AppKit
import DevHubCore

@MainActor
final class TooltipView: NSView {
    /// `--tooltip-max-width`.
    static let maxWidth: CGFloat = 480
    private static let padX: CGFloat = 7
    private static let padY: CGFloat = 4
    private static let markSide: CGFloat = 13
    private static let markGap: CGFloat = 5
    private static let meterWidth: CGFloat = 200

    private var style: ShellStyle
    private(set) var lines: [TooltipLine] = []
    /// Where it is about, in the window's coordinates.
    private(set) var anchor: CGRect?
    private var laidOut: [Placed] = []
    private(set) var measured: CGSize = .zero
    private var hoveredLink: Int?
    private var tracking: NSTrackingArea?
    /// The pointer came into the box or left it (`reportTooltipPointer`).
    var onPointer: ((Bool) -> Void)?
    /// A place-fact was clicked.
    var onLink: ((String) -> Void)?
    /// `Date.now()` for the meters.
    var now: () -> Double = { Date().timeIntervalSince1970 * 1000 }

    private struct Placed {
        var line: TooltipLine
        var frame: CGRect
        var text: NSAttributedString?
        var textFrame: CGRect = .zero
        var href: String?
    }

    init(style: ShellStyle) {
        self.style = style
        super.init(frame: .zero)
        isHidden = true
        setAccessibilityElement(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    func restyle(_ style: ShellStyle) {
        self.style = style
        if !lines.isEmpty { relayout() }
        needsDisplay = true
    }

    var isShowing: Bool { !lines.isEmpty && anchor != nil }

    /// What the layout owner places: the anchor and the measured size.
    var placement: TooltipPlacement? {
        guard let anchor, !lines.isEmpty else { return nil }
        return TooltipPlacement(anchor: anchor.layoutRect, size: LayoutSize(width: Double(measured.width), height: Double(measured.height)))
    }

    func show(_ lines: [TooltipLine], anchor: CGRect) {
        self.lines = lines
        self.anchor = anchor
        relayout()
        needsDisplay = true
    }

    /// Draw the same lines again (a countdown's tick).
    func redraw() {
        guard !lines.isEmpty else { return }
        relayout()
        needsDisplay = true
    }

    func hide() {
        lines = []
        anchor = nil
        laidOut = []
        hoveredLink = nil
        measured = .zero
    }

    // MARK: Layout

    private func attributes(_ size: CGFloat, _ weight: NSFont.Weight, _ color: NSColor, underline: Bool = false) -> [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = (size * 1.35).rounded()
        paragraph.maximumLineHeight = (size * 1.35).rounded()
        paragraph.lineBreakMode = .byCharWrapping
        var result: [NSAttributedString.Key: Any] = [
            .font: ShellStyle.font(size, weight), .foregroundColor: color, .paragraphStyle: paragraph,
        ]
        if underline {
            result[.underlineStyle] = NSUnderlineStyle.single.rawValue
            result[.underlineColor] = style.tokens.lineStrong.nsColor
        }
        return result
    }

    private func textColor(_ fact: TooltipFact) -> NSColor {
        let tokens = style.tokens
        switch fact.style {
        case .muted: return tokens.secondary.nsColor
        case .note: return tokens.primary.nsColor
        case .danger: return tokens.danger.nsColor
        default: return tokens.primary.nsColor
        }
    }

    /// `.tooltip-line-mark[data-mark]` and `[data-tone]`.
    private func markColor(_ fact: TooltipFact) -> NSColor {
        let tokens = style.tokens
        if fact.style == .danger { return tokens.danger.nsColor }
        if let tone = fact.tone {
            switch tone {
            case .working: return tokens.statusWorking.nsColor
            case .background: return tokens.statusBackground.nsColor
            case .waiting: return tokens.statusWaiting.nsColor
            case .idle: return tokens.statusIdle.nsColor
            case .error: return tokens.statusError.nsColor
            case .unknown: return tokens.secondary.nsColor
            }
        }
        switch fact.icon {
        case .repository?, .branch?, .worktree?, .folder?, .remote?, .container?: return tokens.accent.nsColor
        case .issueOpen?, .pullRequest?, .checksPassing?: return tokens.statusIdle.nsColor
        case .issueClosed?, .pullRequestMerged?: return tokens.statusDone.nsColor
        case .pullRequestClosed?: return tokens.danger.nsColor
        case .conversation?: return tokens.statusWaiting.nsColor
        case .checksFailing?: return tokens.statusError.nsColor
        case .checksPending?: return tokens.statusWorking.nsColor
        default: return tokens.tertiary.nsColor
        }
    }

    private func relayout() {
        let inner = Self.maxWidth - 2 * Self.padX - 2
        var placed: [Placed] = []
        var y = Self.padY + 1
        var width: CGFloat = 0
        var previous: TooltipLine?
        for line in lines {
            switch line {
            case let .fact(fact):
                let name = fact.style == .name
                if name, let previous {
                    if case .meter = previous { y += 6 } else if case let .fact(before) = previous, before.style == .note { y += 6 }
                }
                let size: CGFloat = name ? 12 : 11
                let text = NSAttributedString(
                    string: fact.text,
                    attributes: attributes(size, name ? .semibold : .regular, textColor(fact), underline: fact.href != nil))
                let lead = fact.icon == nil ? 0 : Self.markSide + Self.markGap
                let bounds = text.boundingRect(
                    with: NSSize(width: inner - lead, height: 10_000), options: [.usesLineFragmentOrigin, .usesFontLeading])
                let textWidth = ceil(bounds.width)
                let textHeight = max(ceil(bounds.height), (size * 1.35).rounded())
                let frame = CGRect(x: Self.padX + 1, y: y, width: lead + textWidth, height: textHeight)
                var entry = Placed(line: line, frame: frame, text: text, href: fact.href)
                entry.textFrame = CGRect(x: frame.minX + lead, y: y, width: textWidth, height: textHeight)
                placed.append(entry)
                width = max(width, lead + textWidth)
                y += textHeight
            case .meter:
                // `.tooltip-meter`: 3px over, the head line, a 4px bar with 3+2
                // around it, the 10px reset line, 2px under.
                let height: CGFloat = 3 + 15 + 3 + 4 + 2 + 14 + 2
                placed.append(Placed(line: line, frame: CGRect(x: Self.padX + 1, y: y, width: Self.meterWidth, height: height)))
                width = max(width, Self.meterWidth)
                y += height
            }
            previous = line
        }
        laidOut = placed
        measured = CGSize(width: ceil(width + 2 * Self.padX + 2), height: ceil(y + Self.padY + 1))
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard !laidOut.isEmpty else { return }
        let tokens = style.tokens
        let box = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 5, yRadius: 5)
        tokens.chrome.nsColor.setFill()
        box.fill()
        tokens.lineStrong.nsColor.setStroke()
        box.lineWidth = 1
        box.stroke()
        for (index, entry) in laidOut.enumerated() {
            switch entry.line {
            case let .fact(fact):
                if let icon = fact.icon {
                    let mark = CGRect(x: entry.frame.minX, y: entry.frame.minY + 2, width: Self.markSide, height: Self.markSide)
                    GlyphPainter.draw(icon, in: mark, color: markColor(fact), stroke: 1.5)
                }
                if let text = entry.text {
                    var drawn = text
                    if index == hoveredLink {
                        let bright = NSMutableAttributedString(attributedString: text)
                        bright.addAttributes(
                            [.foregroundColor: tokens.primary.nsColor, .underlineColor: tokens.primary.nsColor],
                            range: NSRange(location: 0, length: bright.length))
                        drawn = bright
                    }
                    drawn.draw(with: entry.textFrame, options: [.usesLineFragmentOrigin, .usesFontLeading])
                }
            case let .meter(meter):
                drawMeter(meter, in: entry.frame)
            }
        }
    }

    private func drawMeter(_ meter: TooltipMeter, in frame: CGRect) {
        let tokens = style.tokens
        let at = now()
        let stale = meter.resetsAt.map { $0 <= at } ?? false
        let level = stale ? UsageLevel.calm : UsageLevel(percent: meter.usedPercent)
        let alpha: CGFloat = stale ? 0.5 : 1
        let levelInk: NSColor? = level == .near ? tokens.waiting.nsColor : level == .at ? tokens.danger.nsColor : nil
        var y = frame.minY + 3
        let label = NSAttributedString(string: meter.label, attributes: attributes(11, .regular, tokens.secondary.nsColor.withAlphaComponent(alpha)))
        label.draw(at: CGPoint(x: frame.minX, y: y))
        let valueText = meter.usedPercent.map { "\(Int($0.rounded()))%" } ?? "not reported"
        let valueColor = meter.usedPercent == nil ? tokens.tertiary.nsColor : (levelInk ?? tokens.primary.nsColor)
        let value = NSAttributedString(
            string: valueText,
            attributes: attributes(11, meter.usedPercent == nil ? .regular : .semibold, valueColor.withAlphaComponent(alpha)))
        value.draw(at: CGPoint(x: frame.maxX - value.size().width, y: y))
        y += 15 + 3
        let track = CGRect(x: frame.minX, y: y, width: frame.width, height: 4)
        tokens.washStrong.nsColor.withAlphaComponent(alpha * tokens.washStrong.nsColor.alphaComponent).setFill()
        NSBezierPath(roundedRect: track, xRadius: 2, yRadius: 2).fill()
        let share = CGFloat(min(max(meter.usedPercent ?? 0, 0), 100) / 100)
        if share > 0 {
            (levelInk ?? tokens.secondary.nsColor).withAlphaComponent(alpha).setFill()
            NSBezierPath(roundedRect: CGRect(x: track.minX, y: track.minY, width: track.width * share, height: 4), xRadius: 2, yRadius: 2).fill()
        }
        y += 4 + 2
        let words: String
        if let resetsAt = meter.resetsAt {
            let time = ResetTime.resetTime(resetsAt, now: at)
            words = resetsAt <= at ? "Reset \(time) · nothing reported since" : "Resets \(ResetTime.resetsIn(resetsAt, now: at)) · \(time)"
        } else {
            words = "Reset time not reported"
        }
        NSAttributedString(string: words, attributes: attributes(10, .regular, tokens.tertiary.nsColor.withAlphaComponent(alpha)))
            .draw(at: CGPoint(x: frame.minX, y: y))
    }

    // MARK: Pointer

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(
            rect: bounds, options: [.mouseEnteredAndExited, .mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { onPointer?(true) }

    override func mouseExited(with event: NSEvent) {
        if hoveredLink != nil { hoveredLink = nil; needsDisplay = true }
        onPointer?(false)
    }

    private func link(at point: CGPoint) -> Int? {
        laidOut.firstIndex { $0.href != nil && $0.textFrame.contains(point) }
    }

    override func mouseMoved(with event: NSEvent) {
        let hit = link(at: convert(event.locationInWindow, from: nil))
        if hit != hoveredLink {
            hoveredLink = hit
            needsDisplay = true
        }
    }

    override func resetCursorRects() {
        for entry in laidOut where entry.href != nil { addCursorRect(entry.textFrame, cursor: .pointingHand) }
    }

    override func mouseDown(with event: NSEvent) {
        guard let index = link(at: convert(event.locationInWindow, from: nil)), let href = laidOut[index].href else { return }
        onLink?(href)
    }
}
