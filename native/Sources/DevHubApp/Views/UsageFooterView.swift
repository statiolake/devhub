// Port of apps/desktop/src/shell/components/sidebar/UsageLimits.tsx (S-12)
// and its `.sidebar-usage*` rules: the foot of the Sidebar, one slim row per
// CLI — name, bar, percentage, when it resets — in the column's quiet ink,
// coloured only near the limit; on the rail, the bars alone. The tooltip
// says every window of every CLI. Read again each minute, so "until 16:50"
// turns into "reset" on time.

import AppKit
import DevHubCore

@MainActor
final class UsageFooterView: NSView {
    private var style: ShellStyle
    private var limits: UsageLimitsWire?
    private(set) var readout: UsageReadout?
    private(set) var lines: [UsageFooter.Line] = []
    var collapsed = false { didSet { if collapsed != oldValue { refresh() } } }
    private var minute: Timer?
    private var tracking: NSTrackingArea?
    var onTooltip: (([TooltipLine], CGRect) -> Void)?
    var onTooltipRelease: (() -> Void)?
    /// The foot's height changed: the column lays out again.
    var onHeightChange: (() -> Void)?

    init(style: ShellStyle) {
        self.style = style
        super.init(frame: .zero)
        let timer = Timer(timeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        minute = timer
        setAccessibilityRole(.group)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func restyle(_ style: ShellStyle) {
        self.style = style
        needsDisplay = true
    }

    func update(_ limits: UsageLimitsWire) {
        self.limits = limits
        refresh()
    }

    private func refresh() {
        let before = height
        readout = limits.flatMap { UsageReadout.of($0, now: Date().timeIntervalSince1970 * 1000) }
        lines = UsageFooter.lines(readout, collapsed: collapsed)
        setAccessibilityLabel(readout?.spoken ?? "")
        isHidden = lines.isEmpty
        needsDisplay = true
        if height != before { onHeightChange?() }
    }

    var height: CGFloat { CGFloat(UsageFooter.height(lines, collapsed: collapsed)) }

    private func ink(_ token: String) -> NSColor {
        style.color(token: token) ?? style.tokens.tertiary.nsColor
    }

    override func draw(_ dirtyRect: NSRect) {
        let tokens = style.tokens
        // `font-variant-numeric: tabular-nums`.
        let font = NSFont.monospacedDigitSystemFont(ofSize: CGFloat(UsageFooter.fontSize), weight: .regular)
        let caption = NSFont.monospacedDigitSystemFont(ofSize: CGFloat(UsageFooter.captionFontSize), weight: .regular)
        func attributes(_ font: NSFont, _ color: NSColor) -> [NSAttributedString.Key: Any] {
            [.font: font, .foregroundColor: color]
        }
        func bar(_ rect: CGRect, fill: Double, color: NSColor) {
            let track = NSBezierPath(roundedRect: rect, xRadius: 2, yRadius: 2)
            tokens.washStrong.nsColor.setFill()
            track.fill()
            let width = rect.width * CGFloat(max(0, min(1, fill)))
            guard width > 0 else { return }
            NSGraphicsContext.saveGraphicsState()
            track.addClip()
            color.setFill()
            CGRect(x: rect.minX, y: rect.minY, width: width, height: rect.height).fill()
            NSGraphicsContext.restoreGraphicsState()
        }
        if collapsed {
            var y = CGFloat(UsageFooter.padTop)
            let x = (bounds.width - CGFloat(UsageFooter.railBarWidth)) / 2
            for line in lines {
                guard case let .meter(row) = line else { continue }
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current?.cgContext.setAlpha(CGFloat(UsageFooter.opacity(row)))
                bar(CGRect(x: x, y: y, width: CGFloat(UsageFooter.railBarWidth), height: CGFloat(UsageFooter.railBarHeight)),
                    fill: row.fill, color: ink(UsageFooter.fillInk(row.shown.level)))
                NSGraphicsContext.restoreGraphicsState()
                y += CGFloat(UsageFooter.railBarHeight + UsageFooter.railRowGap)
            }
            return
        }
        let left = CGFloat(UsageFooter.padLeading)
        let right = bounds.width - CGFloat(UsageFooter.padTrailing)
        let gap = CGFloat(UsageFooter.columnGap)
        let nameWidth = CGFloat(UsageFooter.nameColumn)
        let valueWidth = CGFloat(UsageFooter.valueColumn)
        // The reset column is as wide as its widest entry, so every bar has
        // the same edges whatever the words beside it.
        let resetWidth = lines.reduce(CGFloat(0)) { widest, line in
            guard case let .meter(row) = line, let text = UsageFooter.resetText(row) else { return widest }
            return max(widest, ceil((text as NSString).size(withAttributes: attributes(font, tokens.tertiary.nsColor)).width))
        }
        let barWidth = CGFloat(UsageFooter.barWidth(columnWidth: Double(bounds.width), resetWidth: Double(resetWidth)))
        let barX = left + nameWidth + gap
        var y = CGFloat(UsageFooter.padTop)
        let rowHeight = CGFloat(UsageFooter.rowHeight)
        for line in lines {
            switch line {
            case let .meter(row):
                let color = ink(UsageFooter.ink(row.shown.level))
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current?.cgContext.setAlpha(CGFloat(UsageFooter.opacity(row)))
                Ink.drawLine(NSAttributedString(string: row.name, attributes: attributes(font, color)), in: CGRect(x: left, y: y, width: nameWidth, height: rowHeight))
                bar(CGRect(x: barX, y: y + (rowHeight - 3) / 2, width: barWidth, height: 3), fill: row.fill, color: ink(UsageFooter.fillInk(row.shown.level)))
                let value = NSAttributedString(string: row.value, attributes: attributes(font, color))
                let valueX = barX + barWidth + gap
                value.draw(at: CGPoint(x: valueX + valueWidth - ceil(value.size().width), y: y))
                if let reset = UsageFooter.resetText(row) {
                    // Closer to its percentage than the row's gap: one reading.
                    let x = valueX + valueWidth + Space.s1
                    Ink.drawLine(NSAttributedString(string: reset, attributes: attributes(font, color)), in: CGRect(x: x, y: y, width: max(0, right - x), height: rowHeight))
                }
                y += rowHeight
                if let text = row.shown.caption {
                    Ink.drawLine(NSAttributedString(string: text, attributes: attributes(caption, color)),
                                 in: CGRect(x: barX, y: y, width: max(0, right - barX), height: CGFloat(UsageFooter.captionHeight)))
                    y += CGFloat(UsageFooter.captionHeight)
                }
                NSGraphicsContext.restoreGraphicsState()
            case let .planless(planless):
                let color = tokens.tertiary.nsColor
                Ink.drawLine(NSAttributedString(string: planless.name, attributes: attributes(font, color)), in: CGRect(x: left, y: y, width: nameWidth, height: rowHeight))
                Ink.drawLine(NSAttributedString(string: planless.note, attributes: attributes(font, color)), in: CGRect(x: barX, y: y, width: max(0, right - barX), height: rowHeight))
                y += rowHeight
            }
            y += CGFloat(UsageFooter.rowGap)
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        guard let readout, !readout.tooltip.isEmpty, let window else { return }
        onTooltip?(readout.tooltip, convert(bounds, to: window.contentView))
    }

    override func mouseExited(with event: NSEvent) {
        onTooltipRelease?()
    }
}
