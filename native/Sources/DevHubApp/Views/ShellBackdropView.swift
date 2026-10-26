// Port of the window's own page: shell/AppShell.tsx's frame,
// shell/components/shell/TitleBar.tsx and SurfaceViewport.tsx. It is the
// lowest child (`shell` in the layout): the chrome every other child is laid
// over, the title bar with the Sidebar toggle, Back and Forward and the
// window's name, the band the window is dragged by, the surface's own states
// (connecting, unavailable, not supported) and the two seams — the split's and
// the Agent terminal's — which it draws and drags.

import AppKit
import DevHubCore

@MainActor
protocol BackdropHost: AnyObject {
    func backdropDispatch(_ intent: AppIntentWire)
    /// A seam drag in progress (nil: ended) and where it was let go.
    func backdropPreview(_ preview: LayoutPreview)
    func backdropCommitSplit(_ ratio: Double)
    func backdropCommitTerminal(terminalId: String, share: Double, stacked: Bool)
    func backdropRetryWorkspace(_ workspaceId: String)
    func backdropLocateWorkspace(_ workspaceId: String)
    func backdropCloseWorkspace(_ workspaceId: String)
}

@MainActor
final class ShellBackdropView: NSView {
    weak var host: BackdropHost?
    private var style: ShellStyle
    private var titleBar: TitleBarMode
    private var snapshot: AppSnapshotWire?
    private var state: LayoutState?
    private var seams: SeamGeometry?
    private var surfaceRect: CGRect = .zero
    private let stateView: SurfaceStateView
    private var title = SurfaceLabels.shellTitle
    private var hovered: TitleControl?
    private var pressedControl: TitleControl?
    private var seamHovered: SeamKind?
    private var dragging: (kind: SeamKind, value: Double)?
    private var tracking: NSTrackingArea?
    /// Whether the surface state on screen has the person's attention (its
    /// primary button takes the keys when nothing else is drawn).
    private(set) var showsState = false

    private enum TitleControl: CaseIterable { case sidebar, back, forward }
    private enum SeamKind: Equatable { case split, terminal }

    init(style: ShellStyle, titleBar: TitleBarMode) {
        self.style = style
        self.titleBar = titleBar
        stateView = SurfaceStateView(style: style)
        super.init(frame: .zero)
        stateView.isHidden = true
        addSubview(stateView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override var acceptsFirstResponder: Bool { true }

    func restyle(_ style: ShellStyle) {
        self.style = style
        stateView.restyle(style)
        needsDisplay = true
    }

    /// The state view, for the keyboard owner: `.shell` puts the keys here.
    var keyTarget: NSView { stateView.primaryButton ?? self }

    // MARK: Rendering

    func render(snapshot: AppSnapshotWire, state: LayoutState, size: LayoutSize, title: String) {
        self.snapshot = snapshot
        self.state = state
        self.title = title
        seams = ShellLayout.seams(size, state)
        surfaceRect = WindowLayout.surfaceRect(size, state).cgRect
        let content = surfaceContent(snapshot)
        if let content {
            stateView.isHidden = false
            stateView.frame = surfaceRect
            if !sameContent(stateView.content, content) { stateView.show(content) }
            showsState = true
        } else {
            stateView.isHidden = true
            showsState = false
        }
        needsDisplay = true
        window?.invalidateCursorRects(for: self)
    }

    private func sameContent(_ a: SurfaceStateContent?, _ b: SurfaceStateContent) -> Bool {
        switch (a, b) {
        case let (.waiting(x)?, .waiting(y)): return x == y
        case let (.failure(t1, d1, a1)?, .failure(t2, d2, a2)): return t1 == t2 && d1 == d2 && a1.map(\.label) == a2.map(\.label)
        case let (.empty(t1, m1, a1)?, .empty(t2, m2, a2)): return t1 == t2 && m1 == m2 && a1.map(\.label) == a2.map(\.label)
        default: return false
        }
    }

    /// `SurfaceViewport`'s body: what the surface says when nothing of its own
    /// is drawn over it.
    private func surfaceContent(_ snapshot: AppSnapshotWire) -> SurfaceStateContent? {
        let workspace = snapshot.workspace(for: snapshot.selection.context)
        if snapshot.readiness != .ready { return .waiting("Connecting…") }
        switch snapshot.layout {
        case .unavailable:
            guard let workspace else { return .failure(title: "The selected context is no longer available.", detail: nil, actions: []) }
            if case .running = workspace.close { return .waiting("Closing the workspace…") }
            if case .failed = workspace.close {
                let id = workspace.id
                return .failure(
                    title: "This Workspace could not be closed.", detail: SurfaceLabels.closeFailure(workspace.close),
                    actions: [SurfaceAction(label: "Close Workspace", primary: true) { [weak self] in self?.host?.backdropCloseWorkspace(id) }])
            }
            if case let .unavailable(reason) = workspace.state {
                let id = workspace.id
                return .failure(
                    title: "This workspace is unavailable.", detail: SurfaceLabels.closeDiagnostic(reason),
                    actions: [
                        SurfaceAction(label: "Retry", primary: true) { [weak self] in self?.host?.backdropRetryWorkspace(id) },
                        SurfaceAction(label: "Locate…") { [weak self] in self?.host?.backdropLocateWorkspace(id) },
                        SurfaceAction(label: "Close") { [weak self] in self?.host?.backdropCloseWorkspace(id) },
                    ])
            }
            return .failure(title: "This workspace is unavailable.", detail: workspace.root, actions: [])
        case .agent:
            return nil
        case .workbench, .split:
            // Terminal mode offers only what it can draw: nothing to say here.
            return nil
        }
    }

    // MARK: Geometry

    private var barHeight: CGFloat { titleBar == .shown ? CGFloat(WindowLayout.titleBarHeight) : 0 }

    private func controlRect(_ control: TitleControl) -> CGRect {
        let size = CGFloat(DevHubTheme.titlebarControlSize)
        let start = CGFloat(WindowLayout.trafficLightSpan) + CGFloat(DevHubTheme.Spacing.space2)
        let index = CGFloat(TitleControl.allCases.firstIndex(of: control) ?? 0)
        return CGRect(
            x: start + index * (size + CGFloat(DevHubTheme.Spacing.space2)), y: (barHeight - size) / 2, width: size, height: size)
    }

    private func enabled(_ control: TitleControl) -> Bool {
        switch control {
        case .sidebar: return true
        case .back: return snapshot?.history?.canGoBack ?? false
        case .forward: return snapshot?.history?.canGoForward ?? false
        }
    }

    private func seamRect(_ kind: SeamKind) -> CGRect? {
        switch kind {
        case .split: return seams?.split?.cgRect
        case .terminal: return seams?.terminal?.rect.cgRect
        }
    }

    private func seam(at point: CGPoint) -> SeamKind? {
        if let rect = seamRect(.terminal), rect.contains(point) { return .terminal }
        if let rect = seamRect(.split), rect.contains(point) { return .split }
        return nil
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        let tokens = style.tokens
        // The chrome: the title bar and everything not covered by a child.
        tokens.chrome.nsColor.setFill()
        bounds.fill()
        // The surface, and the one hairline where the chrome stops.
        tokens.surface.nsColor.setFill()
        surfaceRect.fill()
        if titleBar == .shown {
            tokens.lineStrong.nsColor.setFill()
            CGRect(x: surfaceRect.minX, y: surfaceRect.minY - 1, width: surfaceRect.width, height: 1).fill()
            drawTitleBar()
        }
        for kind in [SeamKind.split, .terminal] {
            guard let rect = seamRect(kind) else { continue }
            tokens.chrome.nsColor.setFill()
            rect.fill()
            let lit = seamHovered == kind || dragging?.kind == kind
            (lit ? tokens.accent : tokens.lineStrong).nsColor.setFill()
            let stacked = kind == .terminal && (seams?.terminal?.stacked ?? false)
            if stacked {
                CGRect(x: rect.minX, y: rect.midY.rounded(.down), width: rect.width, height: 1).fill()
            } else {
                CGRect(x: rect.midX.rounded(.down), y: rect.minY, width: 1, height: rect.height).fill()
            }
        }
    }

    private func drawTitleBar() {
        let tokens = style.tokens
        for control in TitleControl.allCases {
            let rect = controlRect(control)
            let isEnabled = enabled(control)
            if isEnabled, hovered == control {
                tokens.washStrong.nsColor.setFill()
                NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4).fill()
            }
            let ink: NSColor
            if !isEnabled {
                ink = tokens.disabledInk.nsColor
            } else if hovered == control || (control == .sidebar && !(snapshot?.sidebar.collapsed ?? false)) {
                ink = tokens.primary.nsColor
            } else {
                ink = tokens.secondary.nsColor
            }
            let glyph: ChromeGlyph = control == .sidebar ? .sidebar : control == .back ? .back : .forward
            GlyphPainter.draw(glyph, in: square(centeredOn: CGPoint(x: rect.midX, y: rect.midY), side: 16), color: ink, stroke: style.sidebar.glyphStroke)
        }
        // The name, centred on the window between the two equal insets.
        let inset = CGFloat(style.chrome.titlebarControlsInset)
        let box = CGRect(x: inset, y: 0, width: max(0, bounds.width - 2 * inset), height: barHeight)
        guard box.width > 0 else { return }
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byTruncatingTail
        let text = NSAttributedString(string: title, attributes: [
            .font: ShellStyle.font(13, ShellStyle.semibold), .foregroundColor: tokens.primary.nsColor, .paragraphStyle: paragraph,
        ])
        let height = text.size().height
        text.draw(with: CGRect(x: box.minX, y: (barHeight - height) / 2, width: box.width, height: height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    // MARK: Pointer

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(
            rect: bounds, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func resetCursorRects() {
        if let rect = seamRect(.split) { addCursorRect(rect, cursor: .resizeLeftRight) }
        if let rect = seamRect(.terminal) {
            addCursorRect(rect, cursor: (seams?.terminal?.stacked ?? false) ? .resizeUpDown : .resizeLeftRight)
        }
    }

    private func titleControl(at point: CGPoint) -> TitleControl? {
        guard titleBar == .shown, point.y < barHeight else { return nil }
        return TitleControl.allCases.first { controlRect($0).contains(point) }
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let control = titleControl(at: point)
        let seam = seam(at: point)
        if control != hovered || seam != seamHovered {
            hovered = control
            seamHovered = seam
            needsDisplay = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        if hovered != nil || seamHovered != nil {
            hovered = nil
            seamHovered = nil
            needsDisplay = true
        }
    }

    /// The band the window is dragged by: the title bar, or in the other
    /// chrome the strip the traffic lights sit in.
    private func inDragBand(_ point: CGPoint) -> Bool {
        point.y < CGFloat(WindowLayout.titleBarHeight)
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let control = titleControl(at: point) {
            if enabled(control) { pressedControl = control }
            return
        }
        if let kind = seam(at: point) {
            let start: Double
            switch kind {
            case .split: start = snapshot?.splitRatio ?? 0.55
            case .terminal: start = seams?.terminal?.share ?? AgentTerminals.defaultShare
            }
            dragging = (kind, start)
            needsDisplay = true
            return
        }
        if inDragBand(point) {
            if event.clickCount == 2 {
                // The system's own answer to a double-click on a title bar.
                let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
                if action == "Minimize" { window?.performMiniaturize(nil) } else if action != "None" { window?.performZoom(nil) }
                return
            }
            window?.performDrag(with: event)
            return
        }
        super.mouseDown(with: event)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let current = dragging, let seams else { return }
        let point = convert(event.locationInWindow, from: nil)
        switch current.kind {
        case .split:
            guard let ratio = seams.ratio(atX: Double(point.x)) else { return }
            dragging = (.split, ratio)
            host?.backdropPreview(LayoutPreview(splitRatio: ratio))
        case .terminal:
            guard let seam = seams.terminal, let share = seam.share(atX: Double(point.x), y: Double(point.y)) else { return }
            dragging = (.terminal, share)
            host?.backdropPreview(LayoutPreview(terminalShare: share))
        }
    }

    override func mouseUp(with event: NSEvent) {
        if let control = pressedControl {
            pressedControl = nil
            let point = convert(event.locationInWindow, from: nil)
            guard titleControl(at: point) == control else { return }
            switch control {
            case .sidebar: host?.backdropDispatch(.toggleSidebar)
            case .back: host?.backdropDispatch(.navigateHistory(.back))
            case .forward: host?.backdropDispatch(.navigateHistory(.forward))
            }
            return
        }
        guard let current = dragging else { return }
        dragging = nil
        needsDisplay = true
        switch current.kind {
        case .split:
            host?.backdropCommitSplit(current.value)
        case .terminal:
            if let seam = seams?.terminal {
                host?.backdropCommitTerminal(terminalId: seam.terminalId, share: current.value, stacked: seam.stacked)
            }
        }
    }

    override func layout() {
        super.layout()
        removeAllToolTips()
        if titleBar == .shown {
            // The title bar's buttons say what they do the way the TS app's
            // `title`s do; an `NSString` owner is its own tooltip.
            let words: [TitleControl: String] = [
                .sidebar: "Toggle Sidebar (Cmd+Q B)", .back: "Back (Cmd+[)", .forward: "Forward (Cmd+])",
            ]
            for control in TitleControl.allCases {
                addToolTip(controlRect(control), owner: (words[control] ?? "") as NSString, userData: nil)
            }
        }
    }
}
