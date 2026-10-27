// Port of apps/desktop/src/shell/agents/SmartButtons.tsx and smartButtons.css:
// what an idle Agent's pane offers to say next.
//
// A button is only ever the same act the Agent actions sheet performs: it
// fills in a template the person owns and queues it for the Agent. Only while
// the Agent is idle, and only the actions whose trigger's condition holds for
// the Workspace's repository now (`SmartButtons.triggers`). A compact stack,
// one button a line under a header that holds the drag handle and the
// automatic actions' switch. A GUI Agent's stands on its composer's top edge;
// a terminal's in the pane's bottom right corner above the queued-message
// status. Dragged by its handle (or moved with the arrow keys), it snaps to
// what it stands on within 16px and stays anchored there; the window keeps
// where per presentation. Translucent at rest, at full strength while pointed
// at, holding focus or being dragged.

import AppKit
import DevHubCore

@MainActor
final class SmartButtonsView: NSView {
    let agentId: String
    weak var views: ConversationViews?
    private var agent: AgentWire?
    private var style: ShellStyle?
    private var stored: SmartButtonsSpot?
    private var lines: [(action: ConfiguredAgentAction, active: Bool)] = []
    private var automatic: [ConfiguredAgentAction] = []
    private let box = NSView()
    private let handle = SmartHandle()
    private let bolt = ConversationButton(label: "", look: .quiet, size: 11, style: ConversationStyle(ShellStyle.initial(dark: false, titleBar: .shown)))
    private var buttons: [SmartButton] = []
    private var drag: (pointer: NSPoint, from: SmartButtonsOffset, to: SmartButtonsSpot?)?
    private var hovering = false { didSet { refreshAlpha() } }
    /// The pane under it is pointed at: a quiet box shows.
    var paneHovered = false { didSet { refreshAlpha() } }
    private var tracking: NSTrackingArea?

    init(agentId: String) {
        self.agentId = agentId
        super.init(frame: .zero)
        box.wantsLayer = true
        addSubview(box)
        box.addSubview(handle)
        box.addSubview(bolt)
        handle.onBegin = { [weak self] point in self?.beginDrag(point) }
        handle.onDrag = { [weak self] point in self?.moveDrag(point) }
        handle.onEnd = { [weak self] in self?.endDrag() }
        handle.onReset = { [weak self] in self?.place(nil) }
        handle.onStep = { [weak self] dx, dy in self?.step(dx, dy) }
        bolt.onPress = { [weak self] in self?.openAutomatic() }
        box.setAccessibilityElement(true)
        box.setAccessibilityRole(.toolbar)
        box.setAccessibilityLabel("Smart Buttons")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, box.frame.contains(point) else { return nil }
        return super.hitTest(point)
    }

    private var presentation: AgentPresentation { agent?.presentation ?? .gui }

    /// How the box meets what it stands on.
    private var spacing: SmartButtonsSpacing {
        presentation == .gui ? SmartButtonsSpacing(inset: 16, gap: 8) : SmartButtonsSpacing(inset: 0, gap: 4)
    }

    func update(_ agent: AgentWire, snapshot: AppSnapshotWire, style: ShellStyle) {
        self.agent = agent
        self.style = style
        stored = snapshot.smartButtons[agent.presentation]
        let actions = views?.agentActions?() ?? []
        let repository = views?.repository?(agent.workspaceId)
        let holding = SmartButtons.triggers(status: agent.status, repository: repository)
        let ticked = agent.automaticActions
        lines = AgentActionTrigger.ordered.flatMap { trigger in
            actions.filter { $0.enabled && $0.trigger == trigger && $0.button }.compactMap { action -> (action: ConfiguredAgentAction, active: Bool)? in
                if holding.contains(trigger) { return (action: action, active: true) }
                return AutomaticActions.isAutomatic(trigger) && ticked.contains(action.id) ? (action: action, active: false) : nil
            }
        }
        automatic = actions.filter { $0.enabled && AutomaticActions.isAutomatic($0.trigger) }
        isHidden = lines.isEmpty && automatic.isEmpty
        render()
    }

    private func render() {
        guard let style, let agent else { return }
        let conversation = ConversationStyle(style)
        let ticked = agent.automaticActions
        for button in buttons { button.removeFromSuperview() }
        buttons = lines.map { line in
            let on = ticked.contains(line.action.id)
            let button = SmartButton(title: line.action.displayName, active: line.active, automatic: on, style: style)
            let when = Self.firesWhen(line.action.trigger)
            button.toolTip = line.active
                ? "\(line.action.displayName) — sent to \(agent.displayName)\(on ? " (automatic: also sent on its own)" : "")"
                : "\(line.action.displayName) — sent to \(agent.displayName) automatically when its condition arises\(when.map { " (\($0.lowercased()))" } ?? "")"
            if line.active {
                button.onPress = { [weak self] in
                    guard let self else { return }
                    self.views?.runAgentAction?(self.agentId, line.action.id)
                }
            }
            box.addSubview(button)
            return button
        }
        bolt.style = conversation
        bolt.isHidden = automatic.isEmpty
        let count = automatic.filter { ticked.contains($0.id) }.count
        bolt.label = count > 0 ? "⚡\(count)" : "⚡"
        bolt.ink = count > 0 ? style.tokens.accent.nsColor : style.tokens.secondary.nsColor
        bolt.toolTip = count > 0
            ? "\(count) sent to \(agent.displayName) on its own — choose which"
            : "Choose actions to send to \(agent.displayName) on their own"
        bolt.setAccessibilityLabel("Automatic actions")
        handle.style = style
        handle.anchored = false
        refreshAlpha()
        needsLayout = true
    }

    static func firesWhen(_ trigger: AgentActionTrigger) -> String? {
        switch trigger {
        case .commit: return "After a turn that leaves uncommitted changes"
        case .push: return "When there are commits the branch has not pushed"
        case .unresolvedReviewComments: return "When new review comments arrive"
        case .ciFailing: return "When CI starts failing"
        default: return nil
        }
    }

    private var quiet: Bool {
        guard let agent else { return true }
        return lines.allSatisfy { !$0.active } && agent.automaticActions.isEmpty
    }

    private func refreshAlpha() {
        let strong = hovering || drag != nil || window?.firstResponder.map { ($0 as? NSView)?.isDescendant(of: box) ?? false } == true
        box.alphaValue = quiet && !paneHovered && !strong ? 0 : (strong ? 1 : 0.4)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: box.frame, options: [.mouseEnteredAndExited, .activeInKeyWindow], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    // MARK: Geometry

    private var boxSize: NSSize {
        let header: CGFloat = 20
        let widths = buttons.map { $0.intrinsicContentSize.width }
        let widest = max(widths.max() ?? 0, 60)
        let width = min(260, max(widest, bolt.isHidden ? 24 : 60), bounds.width - 24)
        return NSSize(width: width, height: header + CGFloat(buttons.count) * 22)
    }

    private var paneBox: LayoutBox {
        LayoutBox(top: 0, right: Double(bounds.width), bottom: Double(bounds.height), left: 0)
    }

    private var anchor: LayoutBox? {
        guard let rect = views?.anchor(for: agentId, in: self) else { return nil }
        return LayoutBox(top: Double(rect.minY), right: Double(rect.maxX), bottom: Double(rect.maxY), left: Double(rect.minX))
    }

    private var anchorBox: LayoutBox { SmartButtons.anchorBox(pane: paneBox, anchor: anchor, spacing: spacing) }

    private func offset(of spot: SmartButtonsSpot) -> SmartButtonsOffset {
        let size = boxSize
        let box = LayoutSize(width: Double(size.width), height: Double(size.height))
        let pane = LayoutSize(width: Double(bounds.width), height: Double(bounds.height))
        return SmartButtons.clampOffset(SmartButtons.spotOffset(spot, pane: paneBox, anchor: anchorBox, box: box, spacing: spacing), pane: pane, box: box)
    }

    private var restingSpot: SmartButtonsSpot { stored ?? SmartButtons.defaultSpot(spacing) }

    private func snapped(_ offset: SmartButtonsOffset) -> SmartButtonsSpot {
        let size = boxSize
        return SmartButtons.snapSpot(offset, pane: paneBox, anchor: anchorBox, box: LayoutSize(width: Double(size.width), height: Double(size.height)), spacing: spacing)
    }

    override func layout() {
        super.layout()
        if presentation == .gui, views?.anchor(for: agentId, in: self) == nil {
            // Nothing to stand on yet: wait, unseen, for the composer.
            box.isHidden = true
            return
        }
        box.isHidden = false
        let size = boxSize
        let spot = drag?.to ?? restingSpot
        let drawn = offset(of: spot)
        let frame = NSRect(x: bounds.width - CGFloat(drawn.right) - size.width, y: bounds.height - CGFloat(drawn.bottom) - size.height, width: size.width, height: size.height)
        box.frame = frame
        handle.anchored = drag != nil && { if case .anchored = spot { return true }; return false }()
        handle.frame = NSRect(x: presentation == .gui ? 0 : size.width - 18, y: 0, width: 18, height: 18)
        let boltSize = bolt.intrinsicContentSize
        bolt.frame = presentation == .gui
            ? NSRect(x: size.width - boltSize.width, y: 0, width: boltSize.width, height: 18)
            : NSRect(x: size.width - 18 - 4 - boltSize.width, y: 0, width: boltSize.width, height: 18)
        var y: CGFloat = 20
        for button in buttons {
            let width = presentation == .gui ? size.width : min(size.width, button.intrinsicContentSize.width)
            button.frame = NSRect(x: size.width - width, y: y, width: width, height: 20)
            y += 22
        }
        updateTrackingAreas()
    }

    // MARK: Moving

    private func beginDrag(_ point: NSPoint) {
        drag = (point, offset(of: restingSpot), nil)
        refreshAlpha()
    }

    private func moveDrag(_ point: NSPoint) {
        guard let current = drag else { return }
        let dx = point.x - current.pointer.x, dy = point.y - current.pointer.y
        // Under the threshold the handle was pressed, not moved.
        if current.to == nil, hypot(dx, dy) < CGFloat(SmartButtons.dragThreshold) { return }
        let size = boxSize
        let moved = SmartButtons.draggedOffset(
            current.from, movedX: Double(dx), movedY: Double(dy),
            pane: LayoutSize(width: Double(bounds.width), height: Double(bounds.height)),
            box: LayoutSize(width: Double(size.width), height: Double(size.height)))
        drag = (current.pointer, current.from, snapped(moved))
        needsLayout = true
    }

    private func endDrag() {
        guard let current = drag else { return }
        drag = nil
        if let to = current.to { place(to) }
        refreshAlpha()
        needsLayout = true
    }

    private func step(_ dx: CGFloat, _ dy: CGFloat) {
        let size = boxSize
        let moved = SmartButtons.draggedOffset(
            offset(of: restingSpot), movedX: Double(dx), movedY: Double(dy),
            pane: LayoutSize(width: Double(bounds.width), height: Double(bounds.height)),
            box: LayoutSize(width: Double(size.width), height: Double(size.height)))
        place(snapped(moved))
    }

    /// Where the box goes: remembered by the window; dropped on the default spot is the default spot, forgotten.
    private func place(_ spot: SmartButtonsSpot?) {
        let fallback = SmartButtons.defaultSpot(spacing)
        let keep = spot.flatMap { $0 == fallback ? nil : $0 }
        stored = keep
        views?.dispatch?(.placeSmartButtons(presentation: presentation.rawValue, spot: keep))
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.2
            context.allowsImplicitAnimation = true
            self.layoutSubtreeIfNeeded()
        }
        needsLayout = true
    }

    // MARK: Automatic

    private func openAutomatic() {
        guard let agent else { return }
        let menu = NSMenu(title: "Automatic actions for \(agent.displayName)")
        menu.autoenablesItems = false
        let intro = NSMenuItem(title: "Sent to \(agent.displayName) on its own, the moment its button would appear", action: nil, keyEquivalent: "")
        intro.isEnabled = false
        menu.addItem(intro)
        menu.addItem(.separator())
        for choice in automatic {
            let item = NSMenuItem(title: choice.displayName, action: #selector(toggleAutomatic(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = choice.id
            item.state = agent.automaticActions.contains(choice.id) ? .on : .off
            item.toolTip = Self.firesWhen(choice.trigger)
            if let when = Self.firesWhen(choice.trigger) {
                let title = NSMutableAttributedString(string: choice.displayName + "\n", attributes: [.font: ShellStyle.font(12)])
                title.append(NSAttributedString(string: when, attributes: [.font: ShellStyle.font(10.5), .foregroundColor: NSColor.secondaryLabelColor]))
                item.attributedTitle = title
            }
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: bolt.bounds.height + 2), in: bolt)
    }

    @objc private func toggleAutomatic(_ item: NSMenuItem) {
        guard let id = item.representedObject as? String, let agent else { return }
        views?.dispatch?(.setAutomaticAction(agentId: agent.id, actionId: id, automatic: item.state != .on))
    }
}

/// The handle: dragged, double-clicked to go back, arrow keys to move, Home to reset.
@MainActor
final class SmartHandle: NSView {
    var style: ShellStyle?
    var anchored = false { didSet { needsDisplay = true } }
    var onBegin: ((NSPoint) -> Void)?
    var onDrag: ((NSPoint) -> Void)?
    var onEnd: (() -> Void)?
    var onReset: (() -> Void)?
    var onStep: ((CGFloat, CGFloat) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("Move the Smart Buttons")
        toolTip = "Drag to move; near the input box it snaps to it and stays there. Double-click to put it back."
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }

    private func windowPoint(_ event: NSEvent) -> NSPoint {
        superview?.superview?.convert(event.locationInWindow, from: nil) ?? event.locationInWindow
    }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            onReset?()
            return
        }
        NSCursor.closedHand.push()
        onBegin?(windowPoint(event))
    }

    override func mouseDragged(with event: NSEvent) { onDrag?(windowPoint(event)) }

    override func mouseUp(with event: NSEvent) {
        NSCursor.pop()
        onEnd?()
    }

    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 115: onReset?()
        case 123: onStep?(-8, 0)
        case 124: onStep?(8, 0)
        case 126: onStep?(0, -8)
        case 125: onStep?(0, 8)
        default: super.keyDown(with: event)
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let style else { return }
        (anchored ? style.tokens.accent.nsColor : style.tokens.secondary.nsColor).setFill()
        let origin = NSPoint(x: (bounds.width - 10) / 2, y: (bounds.height - 6) / 2)
        for x in [1.0, 5.0, 9.0] {
            for y in [1.0, 5.0] {
                NSBezierPath(ovalIn: NSRect(x: origin.x + x - 1, y: origin.y + y - 1, width: 2, height: 2)).fill()
            }
        }
    }
}

/// One Smart Button: its own ground, so it reads over a surface of any colour.
@MainActor
final class SmartButton: NSView {
    let title: String
    let active: Bool
    let automatic: Bool
    let style: ShellStyle
    var onPress: (() -> Void)?
    private var hovering = false { didSet { needsDisplay = true } }
    private var pressing = false { didSet { needsDisplay = true } }
    private var tracking: NSTrackingArea?

    init(title: String, active: Bool, automatic: Bool, style: ShellStyle) {
        self.title = title
        self.active = active
        self.automatic = automatic
        self.style = style
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
        setAccessibilityEnabled(active)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { active }

    private var attributed: NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        return NSAttributedString(string: title, attributes: [
            .font: ShellStyle.font(11, ShellStyle.medium),
            .foregroundColor: active ? style.tokens.primary.nsColor : style.tokens.secondary.nsColor, .paragraphStyle: paragraph,
        ])
    }

    override var intrinsicContentSize: NSSize { NSSize(width: ceil(attributed.size().width) + 18, height: 20) }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = active }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseDown(with event: NSEvent) { pressing = active }
    override func mouseUp(with event: NSEvent) {
        let inside = bounds.contains(convert(event.locationInWindow, from: nil))
        pressing = false
        if inside, active { onPress?() }
    }

    override func keyDown(with event: NSEvent) {
        if active, event.keyCode == 49 || event.keyCode == 36 { onPress?() } else { super.keyDown(with: event) }
    }

    override func draw(_ dirtyRect: NSRect) {
        let t = style.tokens
        let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: rect, xRadius: CGFloat(DevHubTheme.Radius.row), yRadius: CGFloat(DevHubTheme.Radius.row))
        (pressing ? t.selection : hovering ? t.washStrong.mix(0.5, with: t.chrome) : t.chrome).nsColor.setFill()
        path.fill()
        (automatic ? t.accent : t.lineStrong).nsColor.setStroke()
        path.lineWidth = 1
        path.stroke()
        let text = attributed
        let height = text.size().height
        text.draw(with: NSRect(x: 8, y: (bounds.height - height) / 2, width: bounds.width - 16, height: height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }
}
