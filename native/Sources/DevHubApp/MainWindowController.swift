// Port of main/shell/shellWindow.ts and layerView.ts: the one window, and the
// one place that sets its children's frames. Every child — the window's own
// view, the Sidebar, the editor areas, the Agents, the Agent terminals, the
// notices, the questions, the tooltip — is where `WindowLayout.compute` says,
// stacked in its order, shown or hidden as it says; and the keyboard is in the
// child `WindowLayout.keyboardChild` names, placed again whenever that answer
// changes (and when asked).
//
// Closing the window hides it (the process, its Agents and every tmux session
// keep running); it comes back exactly as it was from the Dock.

import AppKit
import DevHubCore

/// The window's root: flipped, so a layout rectangle is a frame as it is.
@MainActor
final class ShellRootView: NSView {
    var onLayout: (() -> Void)?
    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func layout() {
        super.layout()
        onLayout?()
    }
}

@MainActor
final class MainWindowController: NSWindowController, NSWindowDelegate {
    weak var shell: ShellController?
    let titleBar: TitleBarMode
    private var style: ShellStyle
    private let transport: TerminalAttachTransport
    let root = ShellRootView()
    let backdrop: ShellBackdropView
    let sidebar: SidebarView
    let agents: AgentsView
    let tooltip: TooltipController
    private(set) var editorTerminals: [String: TerminalPaneView] = [:]
    private(set) var agentTerminals: [String: TerminalPaneView] = [:]
    private var snapshot: AppSnapshotWire?
    private var arrangement: ShellArrangement?
    private var lastKeyboardChild: ChildIdentity?
    private var lastChildren: [LayoutChild] = []
    private var responderObservation: NSKeyValueObservation?
    private var reportedFocus: ContentFocus?

    init(titleBar: TitleBarMode, style: ShellStyle, transport: TerminalAttachTransport, conversations: ConversationViewProviding) {
        self.titleBar = titleBar
        self.style = style
        self.transport = transport
        backdrop = ShellBackdropView(style: style, titleBar: titleBar)
        sidebar = SidebarView(style: style)
        agents = AgentsView(style: style, transport: transport, conversations: conversations)
        let tooltipView = TooltipView(style: style)
        tooltip = TooltipController(view: tooltipView)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = SurfaceLabels.shellTitle
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 640, height: 400)
        window.tabbingMode = .disallowed
        window.isReleasedWhenClosed = false
        window.collectionBehavior.insert(.fullScreenPrimary)
        super.init(window: window)
        window.delegate = self
        window.setFrameAutosaveName("DevHubMainWindow")
        if !window.setFrameUsingName("DevHubMainWindow") { window.center() }
        root.wantsLayer = true
        root.frame = window.contentLayoutRect
        window.contentView = root
        root.addSubview(backdrop)
        root.addSubview(sidebar)
        root.addSubview(agents)
        root.addSubview(tooltipView)
        root.onLayout = { [weak self] in self?.applyLayout() }
        tooltip.onLayoutChange = { [weak self] in self?.applyLayout() }
        agents.onTerminalPane = { [weak self] pane in self?.wire(pane) }
        responderObservation = window.observe(\.firstResponder, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.firstResponderChanged() }
        }
        applyStyle()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: Style

    func restyle(_ style: ShellStyle) {
        self.style = style
        applyStyle()
        backdrop.restyle(style)
        sidebar.restyle(style)
        agents.restyle(style)
        tooltip.view.restyle(style)
        for pane in editorTerminals.values { pane.applyStyle(style) }
        for pane in agentTerminals.values { pane.applyStyle(style) }
        shell?.modals.applyStyle(style)
        shell?.notices.applyStyle(style)
        applyLayout()
    }

    private func applyStyle() {
        guard let window else { return }
        window.backgroundColor = style.tokens.chrome.nsColor
        root.layer?.backgroundColor = style.tokens.chrome.cgColor
        window.appearance = style.tokens.palette.base == .dark ? NSAppearance(named: .darkAqua) : NSAppearance(named: .aqua)
    }

    // MARK: The children

    private func wire(_ pane: TerminalPaneView) {
        pane.onOpenLink = { [weak self] link in self?.shell?.openExternal(link) }
        let key = pane.surfaceKey
        pane.onLog = { line in MainLog.shared.warn("[devhub] \(key): \(line)") }
    }

    private func makePane(role: TerminalPaneRole, surfaceKey: String, label: String, viewLabel: String) -> TerminalPaneView {
        let pane = TerminalPaneView(role: role, surfaceKey: surfaceKey, label: label, viewLabel: viewLabel, transport: transport, style: style)
        wire(pane)
        pane.isHidden = true
        return pane
    }

    /// The views there should be for the arrangement: one per Agent terminal,
    /// one per Workspace editor area shown so far.
    private func reconcileTerminals(_ arrangement: ShellArrangement, snapshot: AppSnapshotWire) {
        let terminalIds = Set(arrangement.terminals)
        for (id, pane) in agentTerminals where !terminalIds.contains(id) {
            pane.dispose()
            pane.removeFromSuperview()
            agentTerminals[id] = nil
        }
        for id in arrangement.terminals where agentTerminals[id] == nil {
            let owner = snapshot.workspaces.lazy.flatMap(\.agents).first { $0.terminal?.id == id }
            let pane = makePane(
                role: .agentTerminal(terminalId: id), surfaceKey: TerminalSurfaceKeys.paneTerminal(id),
                label: owner.map { "\($0.displayName) terminal" } ?? "Terminal", viewLabel: "pane")
            root.addSubview(pane)
            agentTerminals[id] = pane
            pane.frame = WindowLayout.surfaceRect(layoutSize, arrangement.state).cgRect
            pane.start()
        }
        let editorKeys = Set(arrangement.editorTerminals.map(\.editorKey))
        for (key, pane) in editorTerminals where !editorKeys.contains(key) {
            pane.dispose()
            pane.removeFromSuperview()
            editorTerminals[key] = nil
        }
        for entry in arrangement.editorTerminals where editorTerminals[entry.editorKey] == nil {
            let label = snapshot.workspace(entry.workspaceId)?.label ?? "Workspace"
            let pane = makePane(
                role: .editor(workspaceId: entry.workspaceId), surfaceKey: entry.surfaceKey, label: label, viewLabel: "editor")
            root.addSubview(pane)
            editorTerminals[entry.editorKey] = pane
            pane.frame = WindowLayout.workbenchRect(layoutSize, arrangement.state).cgRect
            pane.start()
        }
    }

    /// Start a Workspace's editor-area terminal over, in place (terminal
    /// mode, `restartEditorTerminal`): the pane attaches again, which makes a
    /// fresh `ws-` session. Nothing is done for a Workspace with no pane.
    func restartEditorTerminal(_ workspaceId: String) {
        for pane in editorTerminals.values where pane.role == .editor(workspaceId: workspaceId) { pane.startOver() }
    }

    // MARK: Rendering

    func render(snapshot: AppSnapshotWire, arrangement: ShellArrangement, sidebar model: SidebarModel?) {
        self.snapshot = snapshot
        self.arrangement = arrangement
        window?.title = SurfaceLabels.windowTitle(snapshot)
        reconcileTerminals(arrangement, snapshot: snapshot)
        if let model { sidebar.render(model, snapshot: snapshot) }
        sidebar.list.takesKeyboard = shell?.keyboardInSidebar ?? false
        let agentsShown = arrangement.state.surface == .agent || {
            if case .split = arrangement.state.surface { return true }
            return false
        }()
        agents.render(snapshot, visible: agentsShown)
        applyLayout()
    }

    var layoutSize: LayoutSize {
        LayoutSize(width: Double(root.bounds.width), height: Double(root.bounds.height))
    }

    /// The layout input for the arrangement on screen now.
    func layoutInput() -> LayoutInput? {
        guard let arrangement else { return nil }
        let modals = shell?.modals
        return LayoutInput(
            windowSize: layoutSize, state: arrangement.state, toasts: shell?.notices.measured,
            picker: (modals?.isPresenting ?? false) ? (modals?.scope ?? .none) : .none,
            tooltip: tooltip.view.placement, terminals: arrangement.terminals,
            editorTerminals: arrangement.editorTerminals.map(\.editorKey))
    }

    private func view(for identity: ChildIdentity) -> NSView? {
        switch identity {
        case .shell: return backdrop
        case .sidebar: return sidebar
        case .agents: return agents
        case let .terminal(terminalId): return agentTerminals[terminalId]
        case let .editorTerminal(editorKey): return editorTerminals[editorKey]
        case .toasts: return shell?.notices.layerView
        case .picker: return shell?.modals.layerView
        case .tooltip: return tooltip.view
        case .editor, .attached: return nil
        }
    }

    /// `applyLayout`: every child's frame, visibility and place in the stack.
    func applyLayout() {
        guard let input = layoutInput(), let snapshot, let arrangement else { return }
        let children = WindowLayout.compute(input)
        var ordered: [NSView] = []
        for child in children {
            guard let view = view(for: child.identity) else { continue }
            if view.superview !== root { root.addSubview(view) }
            let frame = child.rect.cgRect
            if view.frame != frame { view.frame = frame }
            switch view {
            case let pane as TerminalPaneView: pane.setShown(child.visible)
            default: view.isHidden = !child.visible
            }
            ordered.append(view)
        }
        restack(ordered)
        lastChildren = children
        backdrop.render(
            snapshot: snapshot, state: arrangement.state, size: input.windowSize, title: SurfaceLabels.windowTitle(snapshot))
        positionTrafficLights()
        let keyboard = WindowLayout.keyboardChild(input)
        if keyboard != lastKeyboardChild {
            lastKeyboardChild = keyboard
            place(keyboard, landing: nil)
        }
    }

    /// The children in the stack's order, moving only what is out of place.
    private func restack(_ ordered: [NSView]) {
        let current = root.subviews.filter { view in ordered.contains { $0 === view } }
        if current.elementsEqual(ordered, by: ===) { return }
        for view in ordered {
            root.addSubview(view, positioned: .above, relativeTo: nil)
        }
    }

    /// The children as laid out last, for the self-test.
    var children: [LayoutChild] { lastChildren }

    // MARK: The keyboard (`placeKeyboardIn`)

    func placeKeyboard(force: Bool, landing: Landing?) {
        applyLayout()
        guard let input = layoutInput() else { return }
        let keyboard = WindowLayout.keyboardChild(input)
        lastKeyboardChild = keyboard
        place(keyboard, landing: landing)
    }

    private func place(_ child: ChildIdentity, landing: Landing?) {
        guard let window else { return }
        if landing == .editor, let input = layoutInput(), let key = WindowLayout.onScreenEditorTerminal(input), let pane = editorTerminals[key] {
            pane.focus()
            return
        }
        switch child {
        case .sidebar:
            sidebar.focusTree()
        case let .terminal(terminalId):
            agentTerminals[terminalId]?.focus()
        case let .editorTerminal(editorKey):
            editorTerminals[editorKey]?.focus()
        case .agents:
            agents.focusActive()
        case .shell:
            window.makeFirstResponder(backdrop.keyTarget)
        case .picker:
            if let view = shell?.modals.layerView { window.makeFirstResponder(view) }
        case .tooltip, .toasts, .editor, .attached:
            return
        }
    }

    /// The keyboard moved inside the window: a click into a pane is the
    /// person choosing it (`paneFocused`).
    private func firstResponderChanged() {
        guard let responder = window?.firstResponder else { return }
        if let pane = pane(containing: responder) {
            let focus = pane.role.focus
            if focus != reportedFocus {
                reportedFocus = focus
                shell?.paneFocused(focus)
            }
            return
        }
        if agents.owns(responder) {
            if reportedFocus != .agents {
                reportedFocus = .agents
                shell?.paneFocused(.agents)
            }
            return
        }
        reportedFocus = nil
    }

    private func pane(containing responder: NSResponder?) -> TerminalPaneView? {
        for pane in agentTerminals.values where pane.owns(responder) { return pane }
        for pane in editorTerminals.values where pane.owns(responder) { return pane }
        return agents.terminalPane(containing: responder)
    }

    func focusedTerminalPane() -> TerminalPaneView? {
        guard let window, window.isKeyWindow else { return nil }
        return pane(containing: window.firstResponder)
    }

    /// `keyboard.ts`'s URL test: which surface a key in `nsWindow` is on.
    func keySurface(for nsWindow: NSWindow?) -> KeySurface {
        guard let nsWindow else { return .other }
        guard nsWindow === window else {
            if nsWindow.identifier?.rawValue == "devhub.settings" { return .settings }
            return .other
        }
        let responder = nsWindow.firstResponder
        if let pane = pane(containing: responder) { return pane.role.keySurface }
        if agents.owns(responder) { return .agents }
        if let view = responder as? NSView {
            if view === sidebar || view.isDescendant(of: sidebar) { return .sidebar }
            if let picker = shell?.modals.layerView, view.isDescendant(of: picker) { return .picker }
            if let toasts = shell?.notices.layerView, view.isDescendant(of: toasts) { return .toasts }
        }
        return .shell
    }

    // MARK: The traffic lights

    /// `trafficLightPosition`: the lights centred in the 32pt band, 9pt in.
    func positionTrafficLights() {
        guard let window, !window.styleMask.contains(.fullScreen) else { return }
        let position = WindowLayout.trafficLightPosition()
        let band = CGFloat(WindowLayout.titleBarHeight)
        guard let close = window.standardWindowButton(.closeButton), let container = close.superview?.superview else { return }
        let height = container.superview?.bounds.height ?? window.frame.height
        var frame = container.frame
        if frame.height != band || frame.minY != height - band {
            frame.size.height = band
            frame.origin.y = height - band
            container.frame = frame
        }
        let buttons: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        for (index, type) in buttons.enumerated() {
            guard let button = window.standardWindowButton(type) else { continue }
            let size = button.frame.size
            let origin = NSPoint(
                x: CGFloat(position.x) + CGFloat(index) * (CGFloat(WindowLayout.trafficLightSize) + 6),
                y: (band - size.height) / 2)
            if button.frame.origin != origin { button.setFrameOrigin(origin) }
        }
    }

    // MARK: NSWindowDelegate

    /// Closing the window hides it: everything in it keeps running.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func windowDidBecomeKey(_ notification: Notification) {
        shell?.windowFocusChanged(true)
        sidebar.list.needsDisplay = true
    }

    func windowDidResignKey(_ notification: Notification) {
        shell?.windowFocusChanged(false)
        sidebar.list.needsDisplay = true
    }

    func windowDidResize(_ notification: Notification) {
        tooltip.hideNow()
        positionTrafficLights()
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        positionTrafficLights()
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        positionTrafficLights()
    }

    func disposeAll() {
        for pane in editorTerminals.values { pane.dispose() }
        for pane in agentTerminals.values { pane.dispose() }
        agents.disposeAll()
    }
}

/// The one tooltip (`tooltipView.ts`): shown by whoever is pointed at,
/// released with a grace the pointer can use to move into it, hidden at once
/// on a scroll, a resize, a blur or a question.
@MainActor
final class TooltipController {
    let view: TooltipView
    private var pointerInside = false
    private var releaseTimer: Timer?
    var onLayoutChange: (() -> Void)?

    init(view: TooltipView) {
        self.view = view
        view.onPointer = { [weak self] inside in self?.pointer(inside) }
    }

    func show(_ lines: [TooltipLine], anchor: CGRect) {
        releaseTimer?.invalidate()
        releaseTimer = nil
        view.show(lines, anchor: anchor)
        onLayoutChange?()
    }

    /// `releaseTooltip`: hide after the grace, unless the pointer is in it.
    func release() {
        guard view.isShowing else { return }
        releaseTimer?.invalidate()
        let timer = Timer(timeInterval: Sidebar.releaseGraceMs / 1000, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.pointerInside else { return }
                self.hideNow()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        releaseTimer = timer
    }

    func hideNow() {
        releaseTimer?.invalidate()
        releaseTimer = nil
        pointerInside = false
        guard view.isShowing else { return }
        view.hide()
        onLayoutChange?()
    }

    private func pointer(_ inside: Bool) {
        pointerInside = inside
        if !inside { release() }
    }
}
