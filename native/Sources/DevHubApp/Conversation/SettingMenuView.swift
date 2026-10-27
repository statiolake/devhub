// Port of the list half of apps/desktop/src/shell/conversation/SettingPickers.tsx
// (`SettingPicker`'s `.conversation-setting-menu`): the session's choices for
// one setting, opened from its face under the composer and drawn above it.
//
// DevHub's list rows (`mac-list-row`): the current choice ticked, the
// highlighted row in the accent. At a row's right end, the CLI's default for
// new sessions: "Default" on the default's row, and on every other a "Make
// default" that makes it the default — seen where the row is pointed at or
// highlighted, pressed with a click or ⌥Return, and leaving the list open so
// what changed can be read back. The keyboard stays on the face: ↑ ↓ Home
// End move, Return or Space takes the row, Escape closes the list (and does
// not stop the turn), and the face losing the keyboard closes it.

import AppKit
import DevHubCore

@MainActor
final class SettingMenuView: NSView {
    /// One row: the choice, and what its right end says.
    struct Row {
        let choice: SettingChoice
        let current: Bool
        let isDefault: Bool
        /// The "Default" mark's tooltip.
        let defaultTip: String?
        /// Whether a "Make default" is offered (the CLI has defaults for this setting).
        let offersDefault: Bool
        /// Why it cannot be made the default, if it cannot.
        let refusal: String?
        /// The "Make default" tooltip.
        let makeDefaultTip: String?
    }

    var style: ConversationStyle! { didSet { needsDisplay = true } }
    /// The face the list is open from; its frame is the list's anchor.
    private(set) weak var face: SettingFace?
    private(set) var rows: [Row] = []
    private(set) var highlighted = 0
    private var hovered: Int?
    private var pointingAtDefault = false
    private var scrollTop: CGFloat = 0
    private var tracking: NSTrackingArea?
    var onChange: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        isHidden = true
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.list)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    var isOpen: Bool { !isHidden }

    func isOpen(for face: SettingFace) -> Bool { isOpen && self.face === face }

    // MARK: Opening and closing

    func open(from face: SettingFace, rows: [Row], label: String) {
        let reopening = isOpen && self.face === face
        self.face = face
        self.rows = rows
        if !reopening {
            highlighted = max(0, rows.firstIndex { $0.current } ?? 0)
            scrollTop = 0
            hovered = nil
        }
        highlighted = min(highlighted, max(0, rows.count - 1))
        setAccessibilityLabel(label)
        let wasHidden = isHidden
        isHidden = false
        needsDisplay = true
        onChange?()
        if wasHidden { Arrival.riseIn(self, duration: DevHubTheme.Motion.fast) }
    }

    /// The face's facts changed while the list is open (a default was made): the rows again, the place kept.
    func refresh(_ rows: [Row]) {
        guard isOpen else { return }
        self.rows = rows
        highlighted = min(highlighted, max(0, rows.count - 1))
        needsDisplay = true
        onChange?()
    }

    func close() {
        guard isOpen else { return }
        isHidden = true
        let face = self.face
        self.face = nil
        hovered = nil
        face?.menuClosed()
        onChange?()
    }

    // MARK: The keyboard (from the face)

    func move(_ step: Int) {
        guard !rows.isEmpty else { return }
        highlighted = (highlighted + step + rows.count) % rows.count
        keepHighlightedInView()
        needsDisplay = true
    }

    func moveToEnd(_ last: Bool) {
        guard !rows.isEmpty else { return }
        highlighted = last ? rows.count - 1 : 0
        keepHighlightedInView()
        needsDisplay = true
    }

    func takeHighlighted() {
        guard highlighted < rows.count else { return }
        take(rows[highlighted])
    }

    func makeHighlightedDefault() {
        guard highlighted < rows.count else { return }
        makeDefault(rows[highlighted])
    }

    private func take(_ row: Row) {
        let face = self.face
        close()
        face?.chose(row.choice.id)
    }

    private func makeDefault(_ row: Row) {
        guard row.offersDefault, !row.isDefault, row.refusal == nil else { return }
        face?.madeDefault(row.choice.id)
    }

    // MARK: Geometry

    private var pad: CGFloat { 4 }
    private var rowHeight: CGFloat { 30 }
    private var titleFont: NSFont { ShellStyle.font(13) }
    private var captionFont: NSFont { ShellStyle.font(11) }
    private static let makeDefaultWords = "Make default"
    private static let defaultWords = "Default"

    /// The width the rows want, and the height they take, at most `most` tall.
    func preferredSize(minWidth: CGFloat, maxWidth: CGFloat, most: CGFloat) -> NSSize {
        let caption = rows.contains { $0.offersDefault }
            ? ceil(max(width(Self.makeDefaultWords, captionFont), width(Self.defaultWords, captionFont))) + 12 : 0
        let widest = rows.map { ceil(width($0.choice.label, titleFont)) }.max() ?? 0
        let wanted = 2 * pad + 12 + 16 + 8 + widest + caption + 12
        let height = min(most, CGFloat(rows.count) * rowHeight + 2 * pad)
        return NSSize(width: min(maxWidth, max(minWidth, wanted)), height: height)
    }

    private func width(_ text: String, _ font: NSFont) -> CGFloat {
        (text as NSString).size(withAttributes: [.font: font]).width
    }

    private func rowRect(_ index: Int) -> NSRect {
        NSRect(x: pad, y: pad + CGFloat(index) * rowHeight - scrollTop, width: bounds.width - 2 * pad, height: rowHeight)
    }

    private func row(at point: NSPoint) -> Int? {
        guard point.y >= pad, point.y < bounds.height - pad else { return nil }
        let index = Int(floor((point.y - pad + scrollTop) / rowHeight))
        return index >= 0 && index < rows.count ? index : nil
    }

    /// The right end's words of a row, where they are drawn.
    private func captionRect(_ index: Int) -> NSRect? {
        let row = rows[index]
        guard row.offersDefault else { return nil }
        let words = row.isDefault ? Self.defaultWords : Self.makeDefaultWords
        let size = (words as NSString).size(withAttributes: [.font: captionFont])
        let rect = rowRect(index)
        return NSRect(x: rect.maxX - 12 - ceil(size.width), y: rect.midY - ceil(size.height) / 2, width: ceil(size.width), height: ceil(size.height))
    }

    private func keepHighlightedInView() {
        let visible = bounds.height - 2 * pad
        let top = CGFloat(highlighted) * rowHeight
        if top < scrollTop { scrollTop = top }
        if top + rowHeight > scrollTop + visible { scrollTop = top + rowHeight - visible }
    }

    override func layout() {
        super.layout()
        keepHighlightedInView()
        layer?.cornerRadius = CGFloat(DevHubTheme.Radius.panel)
        shadow = {
            let shadow = NSShadow()
            let dialog = style?.tokens.shadowDialog
            shadow.shadowColor = dialog?.color.nsColor ?? NSColor.black.withAlphaComponent(0.25)
            shadow.shadowBlurRadius = CGFloat(dialog?.blur ?? 24) / 2
            shadow.shadowOffset = NSSize(width: 0, height: -CGFloat(dialog?.offsetY ?? 8) / 2)
            return shadow
        }()
        removeAllToolTips()
        for index in rows.indices {
            let row = rows[index]
            if let caption = captionRect(index) {
                let tip = row.isDefault ? row.defaultTip : (row.refusal ?? row.makeDefaultTip)
                if let tip { addToolTip(caption, owner: tip as NSString, userData: nil) }
                var rest = rowRect(index)
                rest.size.width = caption.minX - rest.minX
                if let detail = row.choice.detail, !detail.isEmpty { addToolTip(rest, owner: detail as NSString, userData: nil) }
            } else if let detail = row.choice.detail, !detail.isEmpty {
                addToolTip(rowRect(index), owner: detail as NSString, userData: nil)
            }
        }
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let style else { return }
        let tokens = style.tokens
        let radius = CGFloat(DevHubTheme.Radius.panel)
        let outline = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
        tokens.raised.nsColor.setFill()
        outline.fill()
        tokens.line.nsColor.setStroke()
        outline.lineWidth = 1
        outline.stroke()
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: NSRect(x: 0, y: pad, width: bounds.width, height: max(0, bounds.height - 2 * pad))).addClip()
        for index in rows.indices {
            let rect = rowRect(index)
            guard rect.maxY > 0, rect.minY < bounds.height else { continue }
            let row = rows[index]
            let selected = index == highlighted
            let shape = NSBezierPath(roundedRect: rect, xRadius: CGFloat(DevHubTheme.Radius.row), yRadius: CGFloat(DevHubTheme.Radius.row))
            if selected {
                tokens.accent.nsColor.setFill()
                shape.fill()
            } else if hovered == index {
                tokens.wash.nsColor.setFill()
                shape.fill()
            }
            let titleInk = selected ? tokens.accentInk.nsColor : tokens.primary.nsColor
            let captionInk = selected ? tokens.accentInk.faded(0.78) : tokens.secondary.nsColor
            var x = rect.minX + 12
            if row.current {
                let glyph = NSRect(x: x + 1, y: rect.midY - 7, width: 14, height: 14)
                GlyphPainter.draw(ConversationIcons.drawing(.check), in: glyph, color: selected ? tokens.accentInk.nsColor : tokens.accent.nsColor, stroke: 1.4)
            }
            x += 16 + 8
            var trailing = rect.maxX - 12
            if let caption = captionRect(index) {
                // "Default" always; "Make default" where the row is pointed at or highlighted.
                let shows = row.isDefault || selected || hovered == index
                if shows {
                    let words = row.isDefault ? Self.defaultWords : Self.makeDefaultWords
                    var attributes: [NSAttributedString.Key: Any] = [.font: captionFont, .foregroundColor: captionInk]
                    if !row.isDefault {
                        if row.refusal != nil {
                            attributes[.foregroundColor] = captionInk.withAlphaComponent(captionInk.alphaComponent * 0.5)
                        } else if pointingAtDefault, hovered == index {
                            attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
                        }
                    }
                    (words as NSString).draw(at: caption.origin, withAttributes: attributes)
                }
                trailing = caption.minX - 12
            }
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byTruncatingTail
            let title = NSAttributedString(string: row.choice.label, attributes: [.font: titleFont, .foregroundColor: titleInk, .paragraphStyle: paragraph])
            let height = ceil(title.size().height)
            title.draw(with: NSRect(x: x, y: rect.midY - height / 2, width: max(0, trailing - x), height: height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        }
        NSGraphicsContext.restoreGraphicsState()
    }

    // MARK: The pointer

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let index = row(at: point)
        let onDefault = index.flatMap { captionRect($0) }.map { $0.insetBy(dx: -4, dy: -4).contains(point) } ?? false
        if index != hovered || onDefault != pointingAtDefault {
            hovered = index
            pointingAtDefault = onDefault
            // The pointer moving over a row highlights it, as the list's keys do.
            if let index { highlighted = index }
            needsDisplay = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        hovered = nil
        pointingAtDefault = false
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard let index = row(at: point) else { return }
        let row = rows[index]
        if !row.isDefault, row.offersDefault, let caption = captionRect(index), caption.insetBy(dx: -4, dy: -4).contains(point) {
            makeDefault(row)
            return
        }
        take(row)
    }

    override func scrollWheel(with event: NSEvent) {
        let most = max(0, CGFloat(rows.count) * rowHeight - (bounds.height - 2 * pad))
        scrollTop = min(most, max(0, scrollTop - event.scrollingDeltaY))
        needsDisplay = true
        needsLayout = true
    }
}

/// What appears after the transcript is drawn eases in (`conversation-rise-in`,
/// the `@starting-style` transitions): up from `--motion-rise` below its place,
/// from transparent, on the view's layer. Nothing when less motion is asked for.
@MainActor
enum Arrival {
    static func riseIn(_ view: NSView, duration: Double = DevHubTheme.Motion.base) {
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        view.wantsLayer = true
        guard let layer = view.layer else { return }
        let rise = CGFloat(DevHubTheme.Motion.rise)
        // A layer's y runs the way its superview's does.
        let below = (view.superview?.isFlipped ?? true) ? rise : -rise
        let move = CABasicAnimation(keyPath: "transform.translation.y")
        move.fromValue = below
        move.toValue = 0
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        let group = CAAnimationGroup()
        group.animations = [move, fade]
        group.duration = duration
        group.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
        layer.add(group, forKey: "devhub-rise-in")
    }
}
