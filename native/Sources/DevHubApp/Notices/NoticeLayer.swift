// Port of apps/desktop/src/shell/toasts/ (ToastsApp.tsx, ToastStack.tsx,
// NoticeCenter.tsx, autoHide.ts) and shell/styles/toast.css: the one place
// the application speaks for itself.
//
// A stack of toasts in the window's corner, the newest nearest it: a failure
// with the danger mark, a standing condition in the quiet ink. A toast hides
// itself after `general.notice_seconds` — the clock stops while the pointer is
// on it, the keyboard in it or its words selected — and what it said is kept
// in the notice center (`Cmd+Q M`), drawn in place of the stack, unread until
// somebody looked. Every word is selectable; Cmd+C with nothing selected
// copies the whole notice.
//
// The rules are Core's (`NoticeBoard`, `AutoHideClock`); this draws them.

import AppKit
import DevHubCore

@MainActor
final class NoticeLayer: NoticePresenting {
    let view: NoticeLayerView
    private(set) var board = NoticeBoard()
    private var clocks: [String: AutoHideClock] = [:]
    private var seconds = ConfigConstants.defaultNoticeSeconds
    private var timer: Timer?
    private var style: ShellStyle
    private var told = 0

    /// Try Again: the projection asked for again.
    var onRetry: (() -> Void)?
    var onOpenSettings: (() -> Void)?
    /// The stack's size changed: the window lays it out again.
    var onMeasuredChange: (() -> Void)?
    /// The center closed: the keyboard goes back to the surface.
    var onCenterClosed: (() -> Void)?

    init(style: ShellStyle) {
        self.style = style
        view = NoticeLayerView(style: style)
        view.layer_ = self
        board.onRetired = { identity, reason in
            MainLog.shared.log("[devhub] notice retired (\(reason.rawValue)): \(identity.replacingOccurrences(of: "\u{0}", with: ":"))")
        }
    }

    var measured: LayoutSize? {
        let size = view.measure()
        guard size.width > 0, size.height > 0 else { return nil }
        return LayoutSize(width: Double(size.width), height: Double(size.height))
    }

    var layerView: NSView? { view }

    func applyStyle(_ style: ShellStyle) {
        self.style = style
        view.restyle(style)
    }

    /// `general.notice_seconds`.
    func configure(noticeSeconds: Double) {
        guard noticeSeconds != seconds else { return }
        seconds = noticeSeconds
        let now = Self.now()
        for key in clocks.keys { clocks[key]?.setSeconds(noticeSeconds, now: now) }
        schedule()
    }

    static func now() -> Double { Date().timeIntervalSince1970 * 1000 }

    // MARK: NoticePresenting

    func error(_ error: AppError) {
        if error.reported { return }
        MainLog.shared.error("[devhub] \(error.summary)\(error.detail.map { ": \($0)" } ?? "")")
        board.raiseFailure(error)
        changed()
    }

    func condition(source: String, summary: String?, reason: String) {
        MainLog.shared.log("[devhub] condition \(source): \(summary ?? "cleared") (\(reason))")
        board.observeCondition(source: source, summary: summary)
        changed()
    }

    func notice(_ text: String) {
        MainLog.shared.log("[devhub] notice: \(text)")
        told += 1
        board.observeCondition(source: "told-\(told)", summary: text)
        changed()
    }

    func dismissAlert() {
        if board.dismissNewest() { retractTold() }
        changed()
    }

    func showNotifications() {
        if board.isCenterOpen {
            closeCenter()
        } else {
            board.openCenter()
            changed()
            view.focusCenter()
        }
    }

    /// The person started another action: a failure is over.
    func personStartedAction() {
        guard board.notices.contains(where: { $0.live == .alert }) else { return }
        board.clearFailure()
        changed()
    }

    // MARK: Edits from the views

    func dismiss(_ identity: String) {
        board.dismiss(identity)
        retractTold()
        changed()
    }

    func seen(_ identity: String) {
        board.seen(identity)
    }

    func remove(_ key: Int) {
        board.remove(key)
        retractTold()
        changed()
    }

    func clearAll() {
        board.clearAll()
        retractTold()
        changed()
    }

    func closeCenter() {
        guard board.isCenterOpen else { return }
        board.closeCenter()
        // Opening it was seeing them; their clocks start again now.
        let now = Self.now()
        for identity in clocks.keys { clocks[identity] = AutoHideClock(seconds: seconds, now: now) }
        changed()
        onCenterClosed?()
    }

    func perform(_ action: AppErrorAction) {
        switch action {
        case .retry: onRetry?()
        case .openSettings: onOpenSettings?()
        case .openMicrophoneSettings:
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                NSWorkspace.shared.open(url)
            }
        }
    }

    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    /// What `devhub --tell notify` said is a moment's news: once it is off
    /// the stack, it is over.
    private func retractTold() {
        let shown = Set(board.notices.map(\.identity))
        for entry in board.center where entry.current && entry.notice.identity.hasPrefix(appConditionIdentity("told-")) {
            if !shown.contains(entry.notice.identity) {
                let source = String(entry.notice.identity.dropFirst(appConditionIdentity("").count))
                board.observeCondition(source: source, summary: nil)
            }
        }
    }

    // MARK: The clocks

    func clock(_ identity: String, _ edit: (inout AutoHideClock, Double) -> Void) {
        guard var clock = clocks[identity] else { return }
        edit(&clock, Self.now())
        clocks[identity] = clock
        schedule()
    }

    private func changed() {
        let now = Self.now()
        let shown = Set(board.notices.map(\.identity))
        for identity in clocks.keys where !shown.contains(identity) { clocks[identity] = nil }
        for identity in shown where clocks[identity] == nil { clocks[identity] = AutoHideClock(seconds: seconds, now: now) }
        view.render(board)
        schedule()
        onMeasuredChange?()
    }

    private func schedule() {
        timer?.invalidate()
        timer = nil
        // The center stands in for the stack: nothing hides while it is open.
        guard !board.isCenterOpen, let next = clocks.values.compactMap(\.deadline).min() else { return }
        let delay = max(0.05, (next - Self.now()) / 1000)
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func tick() {
        let now = Self.now()
        var hid = false
        for (identity, clock) in clocks where clock.due(at: now) {
            board.hide(identity)
            hid = true
        }
        if hid {
            retractTold()
            changed()
        } else {
            schedule()
        }
    }
}

// MARK: - The layer

/// Sized by what it draws: the stack, or the center in its place.
@MainActor
final class NoticeLayerView: NSView {
    weak var layer_: NoticeLayer?
    private var style: ShellStyle
    private var toasts: [String: ToastView] = [:]
    private var order: [String] = []
    let center: NoticeCenterView

    static let maxWidth: CGFloat = 520
    static let gap: CGFloat = Space.s2

    init(style: ShellStyle) {
        self.style = style
        center = NoticeCenterView(style: style)
        super.init(frame: .zero)
        center.isHidden = true
        addSubview(center)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    func restyle(_ style: ShellStyle) {
        self.style = style
        for toast in toasts.values { toast.restyle(style) }
        center.restyle(style)
    }

    func render(_ board: NoticeBoard) {
        guard let owner = layer_ else { return }
        if board.isCenterOpen {
            for toast in toasts.values { toast.isHidden = true }
            center.isHidden = false
            center.render(board.center, unread: board.openUnread ?? [], owner: owner)
        } else {
            center.isHidden = true
            let notices = board.notices
            let identities = notices.map(\.identity)
            for (identity, toast) in toasts where !identities.contains(identity) {
                toast.removeFromSuperview()
                toasts[identity] = nil
            }
            for notice in notices {
                if let toast = toasts[notice.identity] {
                    toast.show(notice)
                } else {
                    let toast = ToastView(notice: notice, style: style, owner: owner)
                    addSubview(toast)
                    toasts[notice.identity] = toast
                }
                toasts[notice.identity]?.isHidden = false
            }
            order = identities
        }
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    /// The stack's size (`useStackSize`): out of the flow, the widest toast
    /// up to 520, or the center's 420 by its height.
    func measure() -> CGSize {
        if !center.isHidden {
            return CGSize(width: NoticeCenterView.width, height: center.preferredHeight())
        }
        let shown = order.compactMap { toasts[$0] }
        guard !shown.isEmpty else { return .zero }
        let width = min(Self.maxWidth, shown.map(\.naturalWidth).max() ?? 0)
        let height = shown.map { $0.height(width: width) }.reduce(0, +) + CGFloat(shown.count - 1) * Self.gap
        return CGSize(width: ceil(width), height: ceil(height))
    }

    override func layout() {
        super.layout()
        if !center.isHidden {
            center.frame = bounds
            return
        }
        var y: CGFloat = 0
        for identity in order {
            guard let toast = toasts[identity] else { continue }
            let height = toast.height(width: bounds.width)
            toast.frame = CGRect(x: 0, y: y, width: bounds.width, height: height)
            y += height + Self.gap
        }
    }

    func focusCenter() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let window = self.window else { return }
            window.makeFirstResponder(self.center)
        }
    }
}

// MARK: - One toast

@MainActor
final class ToastView: NSView {
    private(set) var notice: Notice
    private var style: ShellStyle
    private weak var owner: NoticeLayer?
    private let summary = WrappingLabel(selectable: true)
    private let detail = WrappingLabel(selectable: true)
    private var actions: [QuietButton] = []
    private var close: QuietButton!
    private var copyButton: QuietButton?
    private var tracking: NSTrackingArea?
    private var copiedTimer: Timer?

    init(notice: Notice, style: ShellStyle, owner: NoticeLayer) {
        self.notice = notice
        self.style = style
        self.owner = owner
        super.init(frame: .zero)
        wantsLayer = true
        close = QuietButton(title: "Dismiss", style: style, closeMark: true) { [weak self] in
            guard let self else { return }
            self.owner?.dismiss(self.notice.identity)
        }
        close.refusesFirstResponder = true
        addSubview(summary)
        addSubview(detail)
        addSubview(close)
        show(notice)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func restyle(_ style: ShellStyle) {
        self.style = style
        close.style = style
        for action in actions { action.style = style }
        show(notice)
    }

    func show(_ notice: Notice) {
        self.notice = notice
        let tokens = style.tokens
        summary.attributedStringValue = Ink.text(notice.summary, size: 13, color: tokens.primary.nsColor, lineHeight: 1.35)
        detail.attributedStringValue = Ink.text(notice.detail ?? "", size: 11, color: tokens.secondary.nsColor, lineHeight: 1.4)
        detail.isHidden = notice.detail == nil
        for action in actions { action.removeFromSuperview() }
        actions = []
        copyButton = nil
        if notice.live == .alert {
            let copy = QuietButton(title: "Copy", style: style) { [weak self] in self?.copyAll(flash: true) }
            copy.setAccessibilityLabel("Copy error message")
            copyButton = copy
            actions.append(copy)
        }
        for (action, title) in [(AppErrorAction.retry, "Try Again"), (AppErrorAction.openSettings, "Open Settings"), (AppErrorAction.openMicrophoneSettings, "Open Microphone Settings")]
        where notice.actions.contains(action) {
            actions.append(QuietButton(title: title, style: style) { [weak self] in self?.owner?.perform(action) })
        }
        for action in actions {
            action.refusesFirstResponder = true
            addSubview(action)
        }
        setAccessibilityRole(.group)
        setAccessibilityLabel(notice.summary)
        layer?.cornerRadius = 10
        layer?.borderWidth = 1
        layer?.borderColor = (notice.live == .alert ? tokens.danger.faded(0.38) : tokens.line.nsColor).cgColor
        layer?.backgroundColor = tokens.raised.cgColor
        let shadow = NSShadow()
        shadow.shadowColor = tokens.shadowRaised.color.nsColor
        shadow.shadowBlurRadius = CGFloat(tokens.shadowRaised.blur) / 2
        shadow.shadowOffset = NSSize(width: 0, height: -CGFloat(tokens.shadowRaised.offsetY))
        self.shadow = shadow
        needsLayout = true
        needsDisplay = true
    }

    private var actionsWidth: CGFloat {
        guard !actions.isEmpty else { return 0 }
        return actions.map { $0.intrinsicContentSize.width }.reduce(0, +) + CGFloat(actions.count - 1) * Space.s1
    }

    /// Padding 8/8/8/12, mark 16, gaps 8, close 20, the border.
    private var chromeWidth: CGFloat { 2 + Space.s3 + 16 + Space.s2 + Space.s2 + 20 + Space.s2 + (actions.isEmpty ? 0 : actionsWidth + Space.s2) }

    var naturalWidth: CGFloat {
        let summaryWidth = Ink.width(summary.attributedStringValue)
        let detailWidth = notice.detail == nil ? 0 : Ink.width(detail.attributedStringValue) - (actions.isEmpty ? 0 : actionsWidth + Space.s2)
        return min(NoticeLayerView.maxWidth, chromeWidth + max(summaryWidth, detailWidth, 80))
    }

    private func summaryWidth(_ width: CGFloat) -> CGFloat { max(40, width - chromeWidth) }
    private func detailWidth(_ width: CGFloat) -> CGFloat { summaryWidth(width) + (actions.isEmpty ? 0 : actionsWidth + Space.s2) }

    func height(width: CGFloat) -> CGFloat {
        let top = max(16 + 1, summary.fittingHeight(width: summaryWidth(width)), actions.isEmpty ? 0 : 22, 20)
        let below = notice.detail == nil ? 0 : Space.s2 + 2 + detail.fittingHeight(width: detailWidth(width))
        return 2 + 2 * Space.s2 + top + below
    }

    override func layout() {
        super.layout()
        let x = 1 + Space.s3 + 16 + Space.s2
        let width = summaryWidth(bounds.width)
        let summaryHeight = summary.fittingHeight(width: width)
        summary.frame = CGRect(x: x, y: 1 + Space.s2, width: width, height: summaryHeight)
        var ax = x + width + Space.s2
        for action in actions {
            let size = action.intrinsicContentSize
            action.frame = CGRect(x: ax, y: 1 + Space.s2 - 2, width: size.width, height: size.height)
            ax += size.width + Space.s1
        }
        close.frame = CGRect(x: bounds.width - 1 - Space.s2 - 20, y: 1 + Space.s2 - 1, width: 20, height: 20)
        let top = max(16 + 1, summaryHeight, actions.isEmpty ? 0 : 22, 20)
        if notice.detail != nil {
            detail.frame = CGRect(x: x, y: 1 + Space.s2 + top + Space.s2 + 2 - Space.s2, width: detailWidth(bounds.width), height: detail.fittingHeight(width: detailWidth(bounds.width)))
        }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let tokens = style.tokens
        // The mark: "!" for a failure, "i" for a condition.
        let mark = CGRect(x: 1 + Space.s3, y: 1 + Space.s2 + 1, width: 16, height: 16)
        let alert = notice.live == .alert
        (alert ? tokens.danger.faded(0.16) : tokens.wash.nsColor).setFill()
        NSBezierPath(ovalIn: mark).fill()
        let glyph = Ink.text(alert ? "!" : "i", size: 10, weight: .semibold, color: alert ? tokens.danger.nsColor : tokens.secondary.nsColor)
        let size = glyph.size()
        glyph.draw(at: CGPoint(x: mark.midX - size.width / 2, y: mark.midY - size.height / 2))
        if window?.firstResponder === self {
            let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 9, yRadius: 9)
            ring.lineWidth = 2
            tokens.focusRing.nsColor.setStroke()
            ring.stroke()
        }
    }

    // MARK: The person with it

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        owner?.clock(notice.identity) { clock, now in clock.setHovered(true, now: now) }
        owner?.seen(notice.identity)
    }

    override func mouseExited(with event: NSEvent) {
        owner?.clock(notice.identity) { clock, now in clock.setHovered(false, now: now) }
        selectionChanged()
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
    }

    override func becomeFirstResponder() -> Bool {
        owner?.clock(notice.identity) { clock, now in clock.setFocused(true, now: now) }
        owner?.seen(notice.identity)
        needsDisplay = true
        return true
    }

    override func resignFirstResponder() -> Bool {
        needsDisplay = true
        DispatchQueue.main.async { [weak self] in self?.selectionChanged() }
        return true
    }

    /// Whether the keyboard is in it (its own, or a label's field editor),
    /// and whether words in it are selected: either holds the clock.
    private func selectionChanged() {
        let responder = window?.firstResponder
        let inside = (responder as? NSView).map { $0 === self || $0.isDescendant(of: self) } ?? false
        let editor = responder as? NSTextView
        let selected = inside && (editor?.selectedRange().length ?? 0) > 0
        owner?.clock(notice.identity) { clock, now in
            clock.setFocused(inside, now: now)
            clock.setSelected(selected, now: now)
        }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 0x35 {
            owner?.dismiss(notice.identity)
            return
        }
        super.keyDown(with: event)
    }

    override func cancelOperation(_ sender: Any?) {
        owner?.dismiss(notice.identity)
    }

    /// Cmd+C with nothing selected: the whole notice.
    @objc func copy(_ sender: Any?) {
        copyAll(flash: false)
    }

    private func copyAll(flash: Bool) {
        owner?.copy(notice.text)
        guard flash, let copyButton else { return }
        copyButton.title = "Copied"
        copiedTimer?.invalidate()
        let timer = Timer(timeInterval: 1.5, repeats: false) { [weak copyButton] _ in
            MainActor.assumeIsolated { copyButton?.title = "Copy" }
        }
        RunLoop.main.add(timer, forMode: .common)
        copiedTimer = timer
    }
}

// MARK: - The notice center

@MainActor
final class NoticeCenterView: NSView {
    static let width: CGFloat = 420
    static let maxHeight: CGFloat = 480
    private var style: ShellStyle
    private weak var owner: NoticeLayer?
    private let titleLabel = NSTextField(labelWithString: "")
    private let countLabel = NSTextField(labelWithString: "")
    private var clearButton: QuietButton!
    private var closeButton: QuietButton!
    private let emptyLabel = NSTextField(labelWithString: "")
    private let scroll = NSScrollView()
    private let list = BandView()
    private var entries: [NoticeEntryView] = []
    private var keys: [Int] = []
    private(set) var active = 0

    init(style: ShellStyle) {
        self.style = style
        super.init(frame: .zero)
        wantsLayer = true
        clearButton = QuietButton(title: "Clear All", style: style) { [weak self] in
            self?.owner?.clearAll()
            if let self { self.window?.makeFirstResponder(self) }
        }
        closeButton = QuietButton(title: "Close", style: style, closeMark: true) { [weak self] in self?.owner?.closeCenter() }
        clearButton.refusesFirstResponder = true
        closeButton.refusesFirstResponder = true
        addSubview(titleLabel)
        addSubview(countLabel)
        addSubview(clearButton)
        addSubview(closeButton)
        addSubview(emptyLabel)
        scroll.documentView = list
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        addSubview(scroll)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Notifications")
        restyle(style)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    func restyle(_ style: ShellStyle) {
        self.style = style
        clearButton.style = style
        closeButton.style = style
        let tokens = style.tokens
        layer?.cornerRadius = 10
        layer?.borderWidth = 1
        layer?.borderColor = tokens.line.cgColor
        layer?.backgroundColor = tokens.raised.cgColor
        titleLabel.attributedStringValue = Ink.text("Notifications", size: 13, weight: .semibold, color: tokens.primary.nsColor)
        emptyLabel.attributedStringValue = Ink.text("No notifications", size: 12, color: tokens.secondary.nsColor)
        for entry in entries { entry.restyle(style) }
        needsDisplay = true
    }

    private let headerHeight: CGFloat = Space.s2 + 22 + Space.s2

    func render(_ center: [CenterEntry<Notice>], unread: Set<Int>, owner: NoticeLayer) {
        self.owner = owner
        let tokens = style.tokens
        let count = center.filter { unread.contains($0.key) }.count
        countLabel.attributedStringValue = Ink.text(count > 0 ? "\(count) new" : "", size: 11, color: tokens.secondary.nsColor)
        clearButton.enabled = !center.isEmpty
        for entry in entries { entry.removeFromSuperview() }
        entries = center.map { entry in
            NoticeEntryView(entry: entry, unread: unread.contains(entry.key), style: style, owner: owner)
        }
        for entry in entries { list.addSubview(entry) }
        keys = center.map(\.key)
        active = min(active, max(0, entries.count - 1))
        emptyLabel.isHidden = !center.isEmpty
        scroll.isHidden = center.isEmpty
        markActive()
        needsLayout = true
    }

    func preferredHeight() -> CGFloat {
        let content = entries.isEmpty
            ? Space.s3 * 2 + 16
            : 2 * Space.s1 + entries.map { $0.height(width: Self.width - 2 - 2 * Space.s1) }.reduce(0, +) + CGFloat(entries.count - 1) * 2
        return min(Self.maxHeight, 2 + headerHeight + 1 + content)
    }

    override func layout() {
        super.layout()
        let width = bounds.width
        titleLabel.frame = CGRect(x: 1 + Space.s3, y: 1 + Space.s2 + 3, width: 120, height: 17)
        let clear = clearButton.intrinsicContentSize
        closeButton.frame = CGRect(x: width - 1 - Space.s2 - 20, y: 1 + Space.s2 + 1, width: 20, height: 20)
        clearButton.frame = CGRect(x: closeButton.frame.minX - Space.s2 - clear.width, y: 1 + Space.s2, width: clear.width, height: 22)
        let countWidth = ceil(countLabel.attributedStringValue.size().width) + 2
        countLabel.frame = CGRect(x: clearButton.frame.minX - Space.s2 - countWidth, y: 1 + Space.s2 + 5, width: countWidth, height: 14)
        let top = 1 + headerHeight + 1
        emptyLabel.frame = CGRect(x: 1 + Space.s3, y: top + Space.s3, width: width - 2 - 2 * Space.s3, height: 16)
        scroll.frame = CGRect(x: 1, y: top, width: width - 2, height: max(0, bounds.height - top - 1))
        var y = Space.s1
        let entryWidth = scroll.frame.width - 2 * Space.s1
        for entry in entries {
            let height = entry.height(width: entryWidth)
            entry.frame = CGRect(x: Space.s1, y: y, width: entryWidth, height: height)
            y += height + 2
        }
        list.frame = CGRect(x: 0, y: 0, width: scroll.frame.width, height: max(scroll.contentSize.height, y - 2 + Space.s1))
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        style.tokens.line.nsColor.setFill()
        CGRect(x: 1, y: 1 + headerHeight, width: bounds.width - 2, height: 1).fill()
    }

    private func markActive() {
        let focused = window?.firstResponder === self
        for (index, entry) in entries.enumerated() { entry.focused = focused && index == active }
        if focused, active < entries.count { list.scrollToVisible(entries[active].frame) }
    }

    override func becomeFirstResponder() -> Bool {
        DispatchQueue.main.async { [weak self] in self?.markActive() }
        return true
    }

    override func resignFirstResponder() -> Bool {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.markActive()
            // Clicking anywhere else puts it away, as a popover does.
            guard !self.isHidden, let window = self.window else { return }
            let responder = window.firstResponder as? NSView
            if let responder, responder === self || responder.isDescendant(of: self) { return }
            if !window.isKeyWindow { return }
            self.owner?.closeCenter()
        }
        return true
    }

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection([.command, .option, .shift, .control])
        switch event.keyCode {
        case 0x35:
            owner?.closeCenter()
        case 0x7D:
            move(to: active + 1)
        case 0x7E:
            move(to: active - 1)
        case 0x73:
            move(to: 0)
        case 0x77:
            move(to: entries.count - 1)
        case 0x33, 0x75:
            guard active < keys.count else { return }
            let index = active
            owner?.remove(keys[index])
            active = min(index, max(0, entries.count - 1))
            markActive()
        default:
            if flags == .command, event.charactersIgnoringModifiers?.lowercased() == "c" {
                copy(nil)
                return
            }
            super.keyDown(with: event)
        }
    }

    override func cancelOperation(_ sender: Any?) { owner?.closeCenter() }

    @objc func copy(_ sender: Any?) {
        guard active < entries.count else { return }
        owner?.copy(entries[active].entry.notice.text)
    }

    private func move(to index: Int) {
        guard !entries.isEmpty else { return }
        active = max(0, min(index, entries.count - 1))
        markActive()
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let point = list.convert(event.locationInWindow, from: nil)
        if let index = entries.firstIndex(where: { $0.frame.contains(point) }) { move(to: index) }
    }
}

@MainActor
final class NoticeEntryView: NSView {
    let entry: CenterEntry<Notice>
    private let unread: Bool
    private var style: ShellStyle
    private weak var owner: NoticeLayer?
    private let meta = NSTextField(labelWithString: "")
    private let summary = WrappingLabel(selectable: true)
    private let detail = WrappingLabel(selectable: true)
    private var actions: [QuietButton] = []
    private var remove: QuietButton!
    var focused = false { didSet { if focused != oldValue { needsDisplay = true } } }

    init(entry: CenterEntry<Notice>, unread: Bool, style: ShellStyle, owner: NoticeLayer) {
        self.entry = entry
        self.unread = unread
        self.style = style
        self.owner = owner
        super.init(frame: .zero)
        let notice = entry.notice
        remove = QuietButton(title: "Remove", style: style, closeMark: true) { [weak owner] in owner?.remove(entry.key) }
        remove.refusesFirstResponder = true
        actions.append(QuietButton(title: "Copy", style: style) { [weak owner] in owner?.copy(notice.text) })
        if entry.current {
            for (action, title) in [(AppErrorAction.retry, "Try Again"), (AppErrorAction.openSettings, "Open Settings"), (AppErrorAction.openMicrophoneSettings, "Open Microphone Settings")]
            where notice.actions.contains(action) {
                actions.append(QuietButton(title: title, style: style) { [weak owner] in owner?.perform(action) })
            }
        }
        addSubview(meta)
        addSubview(summary)
        addSubview(detail)
        for action in actions {
            action.refusesFirstResponder = true
            addSubview(action)
        }
        addSubview(remove)
        let state = NoticeBoard.entryState(entry)
        setAccessibilityRole(.group)
        setAccessibilityLabel("\(state)\(unread ? ", new" : ""): \(notice.summary)")
        restyle(style)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    func restyle(_ style: ShellStyle) {
        self.style = style
        remove.style = style
        for action in actions { action.style = style }
        let tokens = style.tokens
        let line = NSMutableAttributedString(attributedString: Ink.text(
            "\(Self.clock.string(from: Date(timeIntervalSince1970: entry.at / 1000))) · \(NoticeBoard.entryState(entry))",
            size: 11, color: tokens.tertiary.nsColor))
        if unread { line.append(Ink.text(" · New", size: 11, weight: .semibold, color: tokens.secondary.nsColor)) }
        meta.attributedStringValue = line
        summary.attributedStringValue = Ink.text(entry.notice.summary, size: 13, color: tokens.primary.nsColor, lineHeight: 1.35)
        detail.attributedStringValue = Ink.text(entry.notice.detail ?? "", size: 11, color: tokens.secondary.nsColor, lineHeight: 1.4)
        detail.isHidden = entry.notice.detail == nil
        wantsLayer = true
        layer?.cornerRadius = 6
        layer?.backgroundColor = unread ? tokens.wash.cgColor : nil
        needsDisplay = true
    }

    private func bodyWidth(_ width: CGFloat) -> CGFloat { max(40, width - 2 * Space.s2 - 16 - 20 - 2 * Space.s2) }

    func height(width: CGFloat) -> CGFloat {
        let body = bodyWidth(width)
        var height = Space.s2 + 14 + 2 + summary.fittingHeight(width: body)
        if entry.notice.detail != nil { height += 2 + detail.fittingHeight(width: body) }
        height += Space.s1 + 22
        return height + Space.s2
    }

    override func layout() {
        super.layout()
        let body = bodyWidth(bounds.width)
        let x = Space.s2 + 16 + Space.s2
        var y = Space.s2
        meta.frame = CGRect(x: x, y: y, width: body, height: 14)
        y += 16
        let summaryHeight = summary.fittingHeight(width: body)
        summary.frame = CGRect(x: x, y: y, width: body, height: summaryHeight)
        y += summaryHeight
        if entry.notice.detail != nil {
            let detailHeight = detail.fittingHeight(width: body)
            detail.frame = CGRect(x: x, y: y + 2, width: body, height: detailHeight)
            y += 2 + detailHeight
        }
        y += Space.s1
        var ax = x
        for action in actions {
            let size = action.intrinsicContentSize
            action.frame = CGRect(x: ax, y: y, width: size.width, height: size.height)
            ax += size.width + Space.s1
        }
        remove.frame = CGRect(x: bounds.width - Space.s2 - 20, y: Space.s2, width: 20, height: 20)
    }

    override func draw(_ dirtyRect: NSRect) {
        let tokens = style.tokens
        let alert = entry.notice.live == .alert
        let mark = CGRect(x: Space.s2, y: Space.s2 + 1, width: 16, height: 16)
        (alert ? tokens.danger.faded(0.16) : tokens.wash.nsColor).setFill()
        NSBezierPath(ovalIn: mark).fill()
        let glyph = Ink.text(alert ? "!" : "i", size: 10, weight: .semibold, color: alert ? tokens.danger.nsColor : tokens.secondary.nsColor)
        let size = glyph.size()
        glyph.draw(at: CGPoint(x: mark.midX - size.width / 2, y: mark.midY - size.height / 2))
        if focused {
            let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 5, yRadius: 5)
            ring.lineWidth = 2
            tokens.focusRing.nsColor.setStroke()
            ring.stroke()
        }
    }
}
