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
    private let bolt = AutomaticToggle()
    private var buttons: [SmartButton] = []
    /// The lines drawn last, by action id: what is new is what arrived.
    private var drawnIds: [String] = []
    private var rendered = false
    /// The automatic actions' panel, while it is open.
    private var panel: AutomaticPanel?
    private var panelMonitor: Any?
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
        bolt.onPress = { [weak self] in self?.toggleAutomatic() }
        box.setAccessibilityElement(true)
        box.setAccessibilityRole(.toolbar)
        box.setAccessibilityLabel("Smart Buttons")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden else { return nil }
        if let panel, panel.frame.contains(point) { return super.hitTest(point) }
        guard box.frame.contains(point) else { return nil }
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
        let ticked = agent.automaticActions
        let ids = lines.map(\.action.id)
        var kept: [String: SmartButton] = [:]
        for button in buttons { kept[button.actionId] = button }
        var next: [SmartButton] = []
        var arrived: [SmartButton] = []
        for line in lines {
            let on = ticked.contains(line.action.id)
            let button: SmartButton
            let old = kept.removeValue(forKey: line.action.id)
            if let old, old.title == line.action.displayName, old.active == line.active, old.automatic == on, old.style.tokens == style.tokens {
                button = old
            } else {
                old?.removeFromSuperview()
                button = SmartButton(actionId: line.action.id, title: line.action.displayName, active: line.active, automatic: on, style: style)
                box.addSubview(button)
                if rendered, !drawnIds.contains(line.action.id) { arrived.append(button) }
            }
            let when = Self.firesWhen(line.action.trigger)
            button.toolTip = line.active
                ? "\(line.action.displayName) — sent to \(agent.displayName)\(on ? " (automatic: also sent on its own)" : "")"
                : "\(line.action.displayName) — sent to \(agent.displayName) automatically when its condition arises\(when.map { " (\($0.lowercased()))" } ?? "")"
            if line.active {
                button.onPress = { [weak self] in
                    guard let self else { return }
                    self.views?.runAgentAction?(self.agentId, line.action.id)
                }
            } else {
                button.onPress = nil
            }
            next.append(button)
        }
        // A line that went: it leaves where it was, as it closes up (`smart-button-exit`).
        for (_, gone) in kept { leave(gone) }
        buttons = next
        let count = automatic.filter { ticked.contains($0.id) }.count
        bolt.isHidden = automatic.isEmpty
        bolt.style = style
        bolt.count = count
        bolt.toolTip = count > 0
            ? "\(count) sent to \(agent.displayName) on its own — choose which"
            : "Choose actions to send to \(agent.displayName) on their own"
        bolt.setAccessibilityLabel("Automatic actions")
        handle.style = style
        handle.anchored = false
        panel?.update(agent: agent, choices: automatic, ticked: ticked, style: style)
        if automatic.isEmpty { closeAutomatic() }
        refreshAlpha()
        let changed = rendered && ids != drawnIds
        drawnIds = ids
        rendered = true
        if changed, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            // The stack closes up, or opens, rather than jumping.
            layoutSubtreeIfNeeded()
            needsLayout = true
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.2
                context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
                context.allowsImplicitAnimation = true
                self.layoutSubtreeIfNeeded()
            }
            for button in arrived { enter(button) }
        } else {
            needsLayout = true
        }
    }

    /// `smart-button-enter`: up from 6px below, from transparent.
    private func enter(_ button: SmartButton) {
        button.wantsLayer = true
        guard let layer = button.layer else { return }
        let move = CABasicAnimation(keyPath: "transform.translation.y")
        move.fromValue = box.isFlipped ? 6 : -6
        move.toValue = 0
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        let group = CAAnimationGroup()
        group.animations = [move, fade]
        group.duration = 0.2
        group.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
        layer.add(group, forKey: "smart-button-enter")
    }

    /// `smart-button-exit`: a line that went fades down and out where it stood.
    private func leave(_ button: SmartButton) {
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, button.superview != nil, button.frame.height > 0 else {
            button.removeFromSuperview()
            return
        }
        button.onPress = nil
        button.isLeaving = true
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.2
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
            context.allowsImplicitAnimation = true
            button.animator().alphaValue = 0
            button.animator().frame.origin.y += 6
        }, completionHandler: {
            MainActor.assumeIsolated { button.removeFromSuperview() }
        })
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
        let strong = hovering || drag != nil || panel != nil
            || window?.firstResponder.map { ($0 as? NSView)?.isDescendant(of: box) ?? false } == true
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
        let to = snapped(moved)
        let was = current.to?.isAnchored
        drag = (current.pointer, current.from, to)
        if let was, was != to.isAnchored, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            // Entering or leaving a snap glides for a moment; otherwise the box tracks the pointer.
            needsLayout = true
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
                context.allowsImplicitAnimation = true
                self.layoutSubtreeIfNeeded()
            }
        } else {
            needsLayout = true
        }
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

    private func toggleAutomatic() {
        if panel != nil { closeAutomatic() } else { openAutomatic() }
    }

    /// The bolt's panel: a switch for every action that may be automatic, each with what makes it
    /// fire. It stays where it opened while switches are flipped, until a click elsewhere or Escape.
    private func openAutomatic() {
        guard let agent, let style, panel == nil else { return }
        let made = AutomaticPanel()
        made.onToggle = { [weak self] id, on in
            guard let self, let agent = self.agent else { return }
            self.views?.dispatch?(.setAutomaticAction(agentId: agent.id, actionId: id, automatic: on))
        }
        made.update(agent: agent, choices: automatic, ticked: agent.automaticActions, style: style)
        addSubview(made)
        panel = made
        bolt.open = true
        // Frozen where it opened, over the box: left-aligned on a conversation, right on a terminal.
        let size = made.fittingSize
        let boxFrame = box.frame
        var x = presentation == .gui ? boxFrame.minX : boxFrame.maxX - size.width
        x = min(max(4, x), max(4, bounds.width - size.width - 4))
        let y = max(4, boxFrame.minY - 4 - size.height)
        made.frame = NSRect(x: x, y: y, width: size.width, height: size.height)
        Arrival.riseIn(made, duration: DevHubTheme.Motion.fast)
        panelMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown]) { [weak self] event in
            nonisolated(unsafe) let incoming = event
            let consumed = MainActor.assumeIsolated { self?.panelEvent(incoming) ?? false }
            return consumed ? nil : event
        }
        refreshAlpha()
    }

    private func panelEvent(_ event: NSEvent) -> Bool {
        guard let panel, event.window === window else { return false }
        if event.type == .keyDown {
            if event.keyCode == 53 {
                closeAutomatic()
                return true
            }
            return false
        }
        let point = convert(event.locationInWindow, from: nil)
        let onBolt = bolt.convert(bolt.bounds, to: self).contains(point)
        if !panel.frame.contains(point), !onBolt { closeAutomatic() }
        return false
    }

    private func closeAutomatic() {
        if let panelMonitor { NSEvent.removeMonitor(panelMonitor) }
        panelMonitor = nil
        panel?.removeFromSuperview()
        panel = nil
        bolt.open = false
        refreshAlpha()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { closeAutomatic() }
    }
}

/// The header's bolt (`.smart-buttons-auto`): the automatic actions' switch,
/// with how many are on; edged in the accent while any is.
@MainActor
final class AutomaticToggle: NSView {
    var style: ShellStyle? { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    var count = 0 { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    var open = false { didSet { needsDisplay = true } }
    var onPress: (() -> Void)?
    private var hovering = false { didSet { needsDisplay = true } }
    private var pressing = false { didSet { needsDisplay = true } }
    private var tracking: NSTrackingArea?

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.menuButton)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    private var countText: NSAttributedString? {
        guard count > 0, let style else { return nil }
        return NSAttributedString(string: "\(count)", attributes: [.font: ShellStyle.font(11, ShellStyle.medium), .foregroundColor: style.tokens.accent.nsColor])
    }

    override var intrinsicContentSize: NSSize {
        let text = countText.map { ceil($0.size().width) + 2 } ?? 0
        return NSSize(width: 5 + 10 + text + 5 + 2, height: 20)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseDown(with event: NSEvent) { pressing = true }
    override func mouseUp(with event: NSEvent) {
        pressing = false
        if bounds.contains(convert(event.locationInWindow, from: nil)) { onPress?() }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 49 || event.keyCode == 36 { onPress?() } else { super.keyDown(with: event) }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let style else { return }
        let t = style.tokens
        let armed = count > 0
        let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let shape = NSBezierPath(roundedRect: rect, xRadius: CGFloat(DevHubTheme.Radius.row), yRadius: CGFloat(DevHubTheme.Radius.row))
        if pressing {
            t.selection.nsColor.setFill()
            shape.fill()
        } else if hovering || open {
            t.washStrong.nsColor.setFill()
            shape.fill()
        } else if armed {
            t.chrome.nsColor.setFill()
            shape.fill()
        }
        if armed {
            t.accent.nsColor.setStroke()
            shape.lineWidth = 1
            shape.stroke()
        }
        // `BoltIcon`: viewBox 0 0 10 12, "M6 0 0 7h4l-1 5 6-7H5z", filled.
        let ink = armed ? t.accent.nsColor : t.secondary.nsColor
        let origin = NSPoint(x: 5, y: (bounds.height - 12) / 2)
        let bolt = NSBezierPath()
        func at(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: origin.x + x, y: origin.y + y) }
        bolt.move(to: at(6, 0))
        bolt.line(to: at(0, 7))
        bolt.line(to: at(4, 7))
        bolt.line(to: at(3, 12))
        bolt.line(to: at(9, 5))
        bolt.line(to: at(5, 5))
        bolt.close()
        ink.setFill()
        bolt.fill()
        if let text = countText {
            let size = text.size()
            text.draw(at: NSPoint(x: origin.x + 10 + 2, y: (bounds.height - size.height) / 2))
        }
    }
}

/// The bolt's panel (`.smart-buttons-menu`): what it is for, then a switch per
/// action that may be automatic, its name and what makes it fire.
@MainActor
final class AutomaticPanel: NSView {
    private var style: ShellStyle?
    private var choices: [ConfiguredAgentAction] = []
    private var ticked: [String] = []
    private var intro = ""
    private var hovered: Int?
    private var tracking: NSTrackingArea?
    var onToggle: ((String, Bool) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.menu)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func update(agent: AgentWire, choices: [ConfiguredAgentAction], ticked: [String], style: ShellStyle) {
        self.choices = choices
        self.ticked = ticked
        self.style = style
        intro = "Sent to \(agent.displayName) on its own, the moment its button would appear"
        setAccessibilityLabel("Automatic actions for \(agent.displayName)")
        layer?.cornerRadius = CGFloat(DevHubTheme.Radius.row)
        layer?.borderWidth = 1
        layer?.borderColor = style.tokens.lineStrong.nsColor.cgColor
        layer?.backgroundColor = style.tokens.chrome.nsColor.cgColor
        shadow = {
            let shadow = NSShadow()
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.25)
            shadow.shadowBlurRadius = 8
            shadow.shadowOffset = NSSize(width: 0, height: -4)
            return shadow
        }()
        needsDisplay = true
        needsLayout = true
    }

    private static let width: CGFloat = 260
    private var pad: CGFloat { 4 }
    private var inner: CGFloat { Self.width - 2 * pad - 2 * 8 }

    private var introText: NSAttributedString {
        NSAttributedString(string: intro, attributes: [.font: ShellStyle.font(11), .foregroundColor: style?.tokens.secondary.nsColor ?? .secondaryLabelColor])
    }

    private func nameText(_ choice: ConfiguredAgentAction) -> NSAttributedString {
        NSAttributedString(string: choice.displayName, attributes: [.font: ShellStyle.font(12), .foregroundColor: style?.tokens.primary.nsColor ?? .labelColor])
    }

    private func whenText(_ choice: ConfiguredAgentAction) -> NSAttributedString? {
        SmartButtonsView.firesWhen(choice.trigger).map {
            NSAttributedString(string: $0, attributes: [.font: ShellStyle.font(11), .foregroundColor: style?.tokens.secondary.nsColor ?? .secondaryLabelColor])
        }
    }

    private func height(_ text: NSAttributedString, _ width: CGFloat) -> CGFloat {
        ceil(text.boundingRect(with: NSSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).height)
    }

    private var textWidth: CGFloat { inner - 22 - 8 }

    /// Each item's rect, under the intro.
    private var itemRects: [NSRect] {
        var y = pad + 2 + height(introText, inner) + pad
        return choices.map { choice in
            var h = 4 + height(nameText(choice), textWidth) + 4
            if let when = whenText(choice) { h += height(when, textWidth) }
            defer { y += h }
            return NSRect(x: pad, y: y, width: Self.width - 2 * pad, height: h)
        }
    }

    override var fittingSize: NSSize {
        NSSize(width: Self.width, height: (itemRects.last?.maxY ?? (pad + 2 + height(introText, inner) + pad)) + pad)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let index = itemRects.firstIndex { $0.contains(point) }
        if index != hovered {
            hovered = index
            needsDisplay = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        hovered = nil
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard let index = itemRects.firstIndex(where: { $0.contains(point) }), index < choices.count else { return }
        let id = choices[index].id
        onToggle?(id, !ticked.contains(id))
    }

    override func mouseDown(with event: NSEvent) {}

    override func layout() {
        super.layout()
        removeAllToolTips()
        for (rect, choice) in zip(itemRects, choices) {
            if let when = SmartButtonsView.firesWhen(choice.trigger) { addToolTip(rect, owner: when as NSString, userData: nil) }
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let style else { return }
        let t = style.tokens
        introText.draw(with: NSRect(x: pad + 8, y: pad + 2, width: inner, height: height(introText, inner)), options: [.usesLineFragmentOrigin])
        for (index, (rect, choice)) in zip(itemRects, choices).enumerated() {
            if hovered == index {
                t.washStrong.nsColor.setFill()
                NSBezierPath(roundedRect: rect, xRadius: CGFloat(DevHubTheme.Radius.row), yRadius: CGFloat(DevHubTheme.Radius.row)).fill()
            }
            let on = ticked.contains(choice.id)
            // A switch, not a tick: on is the accent, the knob to the right.
            let track = NSRect(x: rect.minX + 8, y: rect.minY + 4 + 2, width: 22, height: 12)
            (on ? t.accent : t.lineStrong).nsColor.setFill()
            NSBezierPath(roundedRect: track, xRadius: 6, yRadius: 6).fill()
            t.chrome.nsColor.setFill()
            NSBezierPath(ovalIn: NSRect(x: track.minX + 2 + (on ? 10 : 0), y: track.minY + 2, width: 8, height: 8)).fill()
            let x = track.maxX + 8
            let name = nameText(choice)
            let nameHeight = height(name, textWidth)
            name.draw(with: NSRect(x: x, y: rect.minY + 4, width: textWidth, height: nameHeight), options: [.usesLineFragmentOrigin])
            if let when = whenText(choice) {
                when.draw(with: NSRect(x: x, y: rect.minY + 4 + nameHeight, width: textWidth, height: height(when, textWidth)), options: [.usesLineFragmentOrigin])
            }
        }
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
    let actionId: String
    let title: String
    let active: Bool
    let automatic: Bool
    let style: ShellStyle
    /// On its way out: laid out no more, pressed no more.
    var isLeaving = false
    var onPress: (() -> Void)?
    private var hovering = false { didSet { needsDisplay = true } }
    private var pressing = false { didSet { needsDisplay = true } }
    private var tracking: NSTrackingArea?

    init(actionId: String, title: String, active: Bool, automatic: Bool, style: ShellStyle) {
        self.actionId = actionId
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
