// A transcript in its scroll (followScroll.ts, freshEntries.ts): it follows
// the end while the end is in view, and stays where it is when the person
// scrolled up — saying "New output" when some arrived since, "Latest"
// otherwise, on a button that goes back down. Entries that arrive while it is
// shown rise in; a transcript loaded, or a pane shown again, is drawn as it is.

import AppKit
import DevHubCore

@MainActor
final class TranscriptScroller: NSView {
    let scroll = NSScrollView()
    let text: TranscriptTextView
    private var style: ConversationStyle
    private let latest: ConversationButton
    private(set) var following = true
    private var unseen = false
    private var fresh = FreshEntries()
    private var adjusting = false
    /// The column's measure: the text is centred in it, gutters either side.
    var measured = true { didSet { needsLayout = true } }
    /// Drawn, or kept hidden in the pool: what arrives while hidden is not news.
    var shown = false

    init(style: ConversationStyle) {
        self.style = style
        text = TranscriptTextView.make(style: style)
        latest = ConversationButton(label: SurfaceWords.latest, icon: .arrowDown, look: .bordered, size: style.em(0.85), style: style)
        super.init(frame: .zero)
        scroll.documentView = text
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = true
        scroll.backgroundColor = style.surface
        scroll.borderType = .noBorder
        scroll.scrollerStyle = .overlay
        scroll.automaticallyAdjustsContentInsets = false
        addSubview(scroll)
        latest.isHidden = true
        latest.onPress = { [weak self] in self?.jumpToLatest() }
        latest.wantsLayer = true
        latest.shadow = {
            let shadow = NSShadow()
            shadow.shadowBlurRadius = 8
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.18)
            shadow.shadowOffset = NSSize(width: 0, height: -2)
            return shadow
        }()
        addSubview(latest)
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func applyStyle(_ style: ConversationStyle) {
        self.style = style
        scroll.backgroundColor = style.surface
        text.applyStyle(style)
        latest.style = style
        latest.size = style.em(0.85)
        text.rerender()
        needsLayout = true
    }

    // MARK: Following

    private var atBottom: Bool {
        let visible = scroll.contentView.bounds
        let height = scroll.documentView?.frame.height ?? 0
        return isAtBottom(scrollTop: Double(visible.minY), scrollHeight: Double(height), clientHeight: Double(visible.height))
    }

    @objc private func scrolled() {
        if adjusting { return }
        let now = atBottom
        if now != following {
            following = now
            if following { unseen = false }
            refreshLatest()
        }
    }

    private func refreshLatest() {
        latest.isHidden = following
        latest.label = unseen ? SurfaceWords.newOutput : SurfaceWords.latest
        needsLayout = true
    }

    func jumpToLatest() {
        following = true
        unseen = false
        scrollToEnd()
        refreshLatest()
    }

    func scrollToEnd() {
        guard let layout = text.textLayoutManager else { return }
        adjusting = true
        layout.ensureLayout(for: NSTextRange(location: layout.documentRange.endLocation))
        text.scrollToEndOfDocument(nil)
        let height = text.frame.height
        scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, height - scroll.contentView.bounds.height)))
        scroll.reflectScrolledClipView(scroll.contentView)
        adjusting = false
    }

    /// Where the view is in the text: a section, a place in it, and how far down the view its line stands.
    private func anchor() -> (section: String, offset: Int, dy: CGFloat)? {
        guard let layout = text.textLayoutManager else { return nil }
        let visible = scroll.contentView.bounds
        let origin = text.textContainerOrigin
        guard let fragment = layout.textLayoutFragment(for: CGPoint(x: 1, y: max(0, visible.minY - origin.y + 1))) else { return nil }
        let index = text.offset(fragment.rangeInElement.location)
        guard let section = text.section(at: index), let start = text.range(ofSection: section)?.location else { return nil }
        return (section, index - start, fragment.layoutFragmentFrame.minY + origin.y - visible.minY)
    }

    private func restore(_ anchor: (section: String, offset: Int, dy: CGFloat)) {
        guard let layout = text.textLayoutManager, let range = text.range(ofSection: anchor.section),
              let location = text.textRange(NSRange(location: range.location + min(anchor.offset, max(0, range.length - 1)), length: 0))?.location
        else { return }
        layout.ensureLayout(for: NSTextRange(location: location))
        guard let fragment = layout.textLayoutFragment(for: location) else { return }
        let y = fragment.layoutFragmentFrame.minY + text.textContainerOrigin.y - anchor.dy
        adjusting = true
        scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, y)))
        scroll.reflectScrolledClipView(scroll.contentView)
        adjusting = false
    }

    /// Keep `rect` (in the text) where it is on screen while what is above it changes: run `change`, then put it back.
    func holding(_ key: (section: String, key: String)?, _ change: () -> Void) {
        let held = anchor()
        change()
        if following { scrollToEnd() } else if let held { restore(held) }
    }

    // MARK: Content

    /// The sections now. Those that arrived while shown rise in.
    func show(_ sections: [DocSection]) {
        let present = sections.map { (id: $0.id, kind: $0.kind) }
        var arrived: Set<String> = []
        if shown { arrived = fresh.drawn(present) } else { fresh.settle(present.map(\.id)) }
        let before = text.rendered.map(\.identity)
        let held = following ? nil : anchor()
        text.show(sections)
        sizeText()
        let changed = before != text.rendered.map(\.identity)
        if following {
            scrollToEnd()
        } else if let held {
            restore(held)
            if changed {
                unseen = true
                refreshLatest()
            }
        }
        if !arrived.isEmpty, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            for id in arrived { riseIn(id) }
        }
    }

    /// Hidden while things arrived: everything there now is known, nothing is fresh.
    func settle() {
        fresh.settle(text.rendered.map(\.id))
    }

    private func riseIn(_ id: String) {
        guard let range = text.range(ofSection: id), let rect = text.rect(of: range) else { return }
        let veil = FreshVeil(frame: NSRect(x: 0, y: rect.minY - 2, width: text.bounds.width, height: rect.height + 4))
        veil.wantsLayer = true
        veil.layer?.backgroundColor = style.surface.cgColor
        text.addSubview(veil)
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = DevHubTheme.Motion.slow
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
            veil.animator().alphaValue = 0
        }, completionHandler: {
            MainActor.assumeIsolated { veil.removeFromSuperview() }
        })
    }

    private func sizeText() {
        let width = scroll.contentSize.width
        if abs(text.frame.width - width) > 0.5 { text.frame.size.width = width }
    }

    override func layout() {
        let wasFollowing = following
        let held = wasFollowing ? nil : anchor()
        super.layout()
        scroll.frame = bounds
        let width = scroll.contentSize.width
        let gutter = CGFloat(SurfaceMetrics.gutterPx)
        let inset = measured ? max(gutter, (width - style.measure) / 2) : style.px(12)
        let insetChanged = abs(text.textContainerInset.width - inset) > 0.5 || abs(text.frame.width - width) > 0.5
        if insetChanged {
            text.textContainerInset = NSSize(width: inset, height: measured ? CGFloat(SurfaceMetrics.paddingTop) : style.px(8))
            text.frame.size.width = width
            text.reshow()
            if wasFollowing { scrollToEnd() } else if let held { restore(held) }
        }
        let size = latest.intrinsicContentSize
        latest.frame = NSRect(x: (bounds.width - size.width) / 2, y: bounds.height - size.height - style.px(16), width: size.width, height: size.height)
        latest.layer?.cornerRadius = size.height / 2
    }

    /// Bring a range into view, centred.
    func reveal(_ range: NSRange) {
        guard let layout = text.textLayoutManager, let start = text.textRange(range)?.location else { return }
        layout.ensureLayout(for: NSTextRange(location: start))
        guard let rect = text.rect(of: range) else { return }
        let visible = scroll.contentView.bounds
        let y = max(0, rect.midY - visible.height / 2)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: y))
        scroll.reflectScrolledClipView(scroll.contentView)
        scrolled()
    }
}

/// A section's veil while it rises in: lifted away, it takes no pointer.
final class FreshVeil: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
