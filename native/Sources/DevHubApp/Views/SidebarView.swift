// Port of shell/components/sidebar/Sidebar.tsx, StatusMark.tsx, useReorder.ts,
// rowMenu.ts's native menu (main/shell/contextMenu.ts) and the Sidebar's rules
// of shell/styles/shell.css: the tree of Scratch, the Workspaces and their
// Agents, drawn row by row in the theme's tokens, in its two widths (the
// column and the rail) and its two densities.
//
// What a row says is Core's (`Sidebar.model`, `SidebarModel`): this view only
// lays the rows out, draws them, and turns the pointer and the keyboard into
// the intents and requests the host carries out.

import AppKit
import DevHubCore

/// What the Sidebar asks the window to do.
@MainActor
protocol SidebarHost: AnyObject {
    /// A row was chosen. `byPointer`: the keys go to what was chosen.
    func sidebarSelect(_ context: ContextWire, split: Bool, byPointer: Bool)
    func sidebarDispatch(_ intent: AppIntentWire)
    func sidebarCreateAgent(_ workspaceId: String)
    func sidebarCloseWorkspace(_ workspaceId: String)
    func sidebarMenu(_ action: Sidebar.MenuAction)
    func sidebarOpenURL(_ url: String)
    func sidebarOpenWorkspacePicker()
    func sidebarOpenIssueAssignment()
    /// A resize in progress (nil: none), and the width it ended on.
    func sidebarPreviewWidth(_ width: Double?)
    func sidebarCommitWidth(_ width: Double)
    /// Escape: the keys back to the surface.
    func sidebarLeave()
    func sidebarShowTooltip(_ lines: [TooltipLine], anchor: CGRect)
    func sidebarReleaseTooltip()
    func sidebarHideTooltip()
}

/// The Sidebar's column: its chrome, the scrolling tree, the resize handle.
@MainActor
final class SidebarView: NSView {
    let list: SidebarListView
    private let scroll = NSScrollView()
    private var style: ShellStyle
    private var collapsed = false
    private var width: Double = DevHubTheme.sidebarWidth
    private var resizeOrigin: (x: CGFloat, width: Double)?
    private var resizePreview: Double?
    private var handleHovered = false
    private var tracking: NSTrackingArea?
    weak var host: SidebarHost? { didSet { list.host = host } }

    /// `.sidebar-resize-handle`: 10pt straddling the edge; the half inside is ours.
    static let handleWidth: CGFloat = 5

    init(style: ShellStyle) {
        self.style = style
        list = SidebarListView(style: style)
        super.init(frame: .zero)
        wantsLayer = true
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.borderType = .noBorder
        scroll.documentView = list
        scroll.contentView.postsBoundsChangedNotifications = true
        addSubview(scroll)
        NotificationCenter.default.addObserver(
            self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Workspace navigation")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    @objc private func scrolled() {
        // `window.addEventListener("scroll", hide, true)`.
        host?.sidebarHideTooltip()
    }

    func restyle(_ style: ShellStyle) {
        self.style = style
        list.restyle(style)
        needsDisplay = true
        needsLayout = true
    }

    func render(_ model: SidebarModel, snapshot: AppSnapshotWire) {
        collapsed = model.collapsed
        width = model.width
        list.render(model, snapshot: snapshot)
        needsLayout = true
        needsDisplay = true
    }

    override func layout() {
        super.layout()
        scroll.frame = bounds
        list.frame.size.width = scroll.contentSize.width
        list.relayout()
    }

    override func draw(_ dirtyRect: NSRect) {
        let tokens = style.tokens
        tokens.chrome.nsColor.setFill()
        bounds.fill()
        // `border-right: var(--sidebar-edge) solid var(--line-strong)`.
        tokens.lineStrong.nsColor.setFill()
        NSRect(x: bounds.maxX - 1, y: 0, width: 1, height: bounds.height).fill()
        if !collapsed, handleHovered || resizeOrigin != nil {
            tokens.accent.nsColor.setFill()
            NSRect(x: bounds.maxX - 1, y: 0, width: 1, height: bounds.height).fill()
        }
    }

    // MARK: The resize handle

    private var handleRect: NSRect {
        NSRect(x: bounds.maxX - Self.handleWidth, y: 0, width: Self.handleWidth, height: bounds.height)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(
            rect: bounds, options: [.mouseEnteredAndExited, .mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func resetCursorRects() {
        if !collapsed { addCursorRect(handleRect, cursor: .resizeLeftRight) }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let superview else { return super.hitTest(point) }
        let local = convert(point, from: superview)
        if !collapsed, handleRect.contains(local), bounds.contains(local) { return self }
        return super.hitTest(point)
    }

    override func mouseMoved(with event: NSEvent) {
        let inside = !collapsed && handleRect.contains(convert(event.locationInWindow, from: nil))
        if inside != handleHovered {
            handleHovered = inside
            needsDisplay = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        if handleHovered { handleHovered = false; needsDisplay = true }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard !collapsed, handleRect.contains(point) else { return super.mouseDown(with: event) }
        resizeOrigin = (event.locationInWindow.x, width)
        resizePreview = width
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard let origin = resizeOrigin else { return }
        let next = Projection.clampSidebarWidth(origin.width + Double(event.locationInWindow.x - origin.x))
        resizePreview = next
        host?.sidebarPreviewWidth(next)
    }

    override func mouseUp(with event: NSEvent) {
        guard resizeOrigin != nil else { return }
        resizeOrigin = nil
        if let preview = resizePreview { host?.sidebarCommitWidth(preview) }
        resizePreview = nil
        needsDisplay = true
    }

    /// Put the keyboard in the tree, on its tab stop (`focusSidebar`).
    func focusTree() {
        window?.makeFirstResponder(list)
        list.focusTabStop()
    }
}

// MARK: - The tree

/// One drawn thing in the list.
private enum SidebarItemKind {
    case workspace(WorkspaceRowModel)
    case agent(AgentRowModel, owner: WorkspaceRowModel)
    case heading
    case empty
    case ghost(ExitingRow)
}

/// What a press on part of a row means.
private enum SidebarControl: Equatable {
    case select
    case link(String)
    case createAgent(String)
    case closeWorkspace(String)
    case stopAgent(String, retry: Bool)
    case assignIssue
    case openPicker
    /// A mark that says something and does nothing.
    case mark
}

private struct ControlBox {
    var control: SidebarControl
    var rect: CGRect
    var tooltip: [TooltipLine]?
    var enabled = true
    /// Drawn only while the row is hovered or focused (`opacity: 0`).
    var hoverOnly = false
}

private struct SidebarItem {
    var kind: SidebarItemKind
    var rect: CGRect
    var controls: [ControlBox] = []
    /// Where the words go, and the column the words fade out at.
    var textRect: CGRect = .zero
    var treeId: String?

    var workspaceId: String? {
        switch kind {
        case let .workspace(row): return row.id
        case let .agent(agent, _): return agent.workspaceId
        default: return nil
        }
    }

    var tooltip: [TooltipLine]? {
        switch kind {
        case let .workspace(row): return row.tooltip.isEmpty ? nil : row.tooltip
        case let .agent(agent, _): return agent.tooltip.isEmpty ? nil : agent.tooltip
        default: return nil
        }
    }
}

/// A row being dragged (`useReorder`).
private struct DragState {
    var source: Sidebar.DragSource
    var origin: CGPoint
    var lane: [String]
    var active = false
    var gap: Sidebar.Gap = .none
}

@MainActor
final class SidebarListView: NSView {
    weak var host: SidebarHost?
    private var style: ShellStyle
    private var model: SidebarModel?
    private var snapshot: AppSnapshotWire?
    private var items: [SidebarItem] = []
    private var hoveredRow: Int?
    private var hoveredControl: (row: Int, index: Int)?
    private var pressed: (row: Int, control: SidebarControl)?
    private var drag: DragState?
    /// The tree's tab stop and the row the keyboard stands on.
    private var focusId: String?
    private var keyboardFocused = false
    private var tracking: NSTrackingArea?
    /// The tooltip's anchor and the timer that waits on a resting pointer.
    private var tooltipAnchor: (row: Int, control: Int?)?
    private var restTimer: Timer?
    private var liveTimer: Timer?
    private var animationTimer: Timer?
    private var animationStart = CACurrentMediaTime()

    init(style: ShellStyle) {
        self.style = style
        super.init(frame: NSRect(x: 0, y: 0, width: 248, height: 400))
        setAccessibilityRole(.outline)
        setAccessibilityLabel("Open workspaces")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    /// Only while the person asked for the Sidebar (`focus_sidebar`): a click
    /// on a row hands the keys to what was chosen, not to the list.
    var takesKeyboard = false
    override var acceptsFirstResponder: Bool { takesKeyboard }
    override var mouseDownCanMoveWindow: Bool { false }

    override func becomeFirstResponder() -> Bool {
        keyboardFocused = true
        if focusId == nil { focusTabStop() }
        showKeyboardTooltip()
        needsDisplay = true
        return true
    }

    override func resignFirstResponder() -> Bool {
        keyboardFocused = false
        host?.sidebarHideTooltip()
        needsDisplay = true
        return true
    }

    func restyle(_ style: ShellStyle) {
        self.style = style
        relayout()
    }

    var metrics: DevHubTheme.SidebarMetrics { style.sidebar }

    /// Every row the tree draws that the keyboard can stand on, in order.
    var treeIds: [String] { items.compactMap(\.treeId) }

    /// How many entries are drawn (rows, the heading, ghosts, the empty line).
    var drawnCount: Int { items.count }
    private var collapsed: Bool { model?.collapsed ?? false }

    func render(_ model: SidebarModel, snapshot: AppSnapshotWire) {
        self.model = model
        self.snapshot = snapshot
        relayout()
        let ids = Sidebar.treeItems(model)
        focusId = Sidebar.tabStop(ids, requested: focusId, selection: snapshot.selection.context)
        updateAnimation()
        if let anchor = tooltipAnchor, anchor.row >= items.count { host?.sidebarHideTooltip(); tooltipAnchor = nil }
    }

    /// The tab stop, as the tree's own focus.
    func focusTabStop() {
        guard let model, let snapshot else { return }
        focusId = Sidebar.tabStop(Sidebar.treeItems(model), requested: focusId, selection: snapshot.selection.context)
        scrollToFocus()
        needsDisplay = true
    }

    // MARK: Layout

    func relayout() {
        guard let model else { items = []; needsDisplay = true; return }
        let m = metrics
        let width = bounds.width
        var built: [SidebarItem] = []
        let inset = CGFloat(m.scrollInset)
        let rowHeight = CGFloat(m.rowHeight)
        var y = inset
        let railEntry = CGFloat(m.railEntry)
        let rowX: CGFloat
        let rowWidth: CGFloat
        if collapsed {
            // `--sidebar-rail-air`, and the edge taken off the trailing half.
            let air = (width - railEntry) / 2
            rowX = air
            rowWidth = railEntry
        } else {
            rowX = inset
            rowWidth = max(0, width - 2 * inset)
        }

        func addWorkspace(_ row: WorkspaceRowModel) {
            let rect = CGRect(x: rowX, y: y, width: rowWidth, height: rowHeight)
            var item = SidebarItem(kind: .workspace(row), rect: rect, treeId: row.closing ? nil : "workspace:\(row.id)")
            layoutWorkspace(&item, row)
            built.append(item)
            y += rowHeight
            for agent in row.agents {
                let agentRect = CGRect(x: rowX, y: y, width: rowWidth, height: rowHeight)
                var entry = SidebarItem(
                    kind: .agent(agent, owner: row), rect: agentRect, treeId: agent.stopping ? nil : "agent:\(agent.id)")
                layoutAgent(&entry, agent)
                built.append(entry)
                y += rowHeight
            }
        }

        addWorkspace(model.scratch)
        // The heading: a row's height, after the section gap; a 1pt line in the rail.
        if collapsed {
            y += CGFloat(m.sectionGap)
            built.append(SidebarItem(kind: .heading, rect: CGRect(x: rowX + 8, y: y, width: max(0, rowWidth - 16), height: 1)))
            y += 1 + CGFloat(m.sectionGap)
        } else {
            y += CGFloat(m.sectionGap)
            var heading = SidebarItem(kind: .heading, rect: CGRect(x: rowX, y: y, width: rowWidth, height: rowHeight))
            let side: CGFloat = 20
            let right = rect(heading.rect).maxX - 2
            let plus = CGRect(x: right - side, y: y + (rowHeight - side) / 2, width: side, height: side)
            let assign = plus.offsetBy(dx: -side, dy: 0)
            heading.controls = [
                ControlBox(control: .assignIssue, rect: assign, tooltip: [.fact(TooltipFact(text: "Assign issue"))]),
                ControlBox(control: .openPicker, rect: plus, tooltip: [.fact(TooltipFact(text: "Open workspace picker"))]),
            ]
            built.append(heading)
            y += rowHeight
        }
        if model.rows.isEmpty {
            if !collapsed {
                built.append(SidebarItem(kind: .empty, rect: CGRect(x: rowX, y: y, width: rowWidth, height: 12 + 16 + 12)))
                y += 40
            }
        } else {
            for entry in model.rows {
                switch entry {
                case let .workspace(row): addWorkspace(row)
                case let .exiting(ghost):
                    built.append(SidebarItem(kind: .ghost(ghost), rect: CGRect(x: rowX, y: y, width: rowWidth, height: rowHeight)))
                    y += rowHeight
                }
            }
        }
        y += CGFloat(DevHubTheme.Spacing.space4)
        items = built
        let height = max(y, enclosingScrollView?.contentSize.height ?? y)
        if frame.height != height { setFrameSize(NSSize(width: frame.width, height: height)) }
        needsDisplay = true
        window?.invalidateCursorRects(for: self)
    }

    private func rect(_ r: CGRect) -> CGRect { r }

    private func textWidth(_ text: String, _ font: NSFont) -> CGFloat {
        ceil((text as NSString).size(withAttributes: [.font: font]).width)
    }

    /// Lay a Workspace row's columns out, right to left from its trailing edge.
    private func layoutWorkspace(_ item: inout SidebarItem, _ row: WorkspaceRowModel) {
        let m = metrics
        let rect = item.rect
        let glyph = CGFloat(m.glyphWidth)
        let mid = rect.midY
        if collapsed {
            item.controls = [ControlBox(control: .select, rect: rect, tooltip: row.tooltip)]
            return
        }
        var right = rect.maxX
        var controls: [ControlBox] = []
        let button: CGFloat = 20
        // The close, then the `+`, each 20 wide with 2 after (`margin-right: 2px`).
        if let tip = row.closeTooltip {
            let box = CGRect(x: right - 2 - button, y: mid - button / 2, width: button, height: button)
            controls.append(ControlBox(control: .closeWorkspace(row.id), rect: box, tooltip: [.fact(TooltipFact(text: tip))], hoverOnly: true))
            right = box.minX
        }
        if row.canCreateAgent {
            let box = CGRect(x: right - 2 - button, y: mid - button / 2, width: button, height: button)
            controls.append(ControlBox(
                control: .createAgent(row.id), rect: box, tooltip: [.fact(TooltipFact(text: row.createAgentTooltip))],
                enabled: row.createAgentEnabled, hoverOnly: true))
            right = box.minX
        }
        // `.row-marks`: the pull request last, the failure before it, the
        // spinner — 1pt apart. (Terminal mode has no editor elsewhere to mark.)
        let narrow = rect.width <= 190
        if let pr = row.pullRequest {
            let box = CGRect(x: right - button, y: mid - button / 2, width: button, height: button)
            controls.append(ControlBox(control: .link(pr.url), rect: box, tooltip: pr.tooltip))
            right = box.minX - 1
        }
        if let unavailable = row.unavailable {
            let box = CGRect(x: right - button, y: mid - button / 2, width: button, height: button)
            controls.append(ControlBox(control: .mark, rect: box, tooltip: [.fact(TooltipFact(text: unavailable))]))
            right = box.minX - 1
        }
        if let pending = row.pendingIssue {
            let box = CGRect(x: right - 3 - 14, y: mid - 7, width: 14, height: 14)
            controls.append(ControlBox(control: .mark, rect: box, tooltip: [.fact(TooltipFact(text: "Reading #\(pending)"))]))
            right = box.minX - 3
        }
        if let terminals = row.terminals {
            let box = CGRect(x: right - glyph, y: mid - glyph / 2, width: glyph, height: glyph)
            controls.append(ControlBox(control: .mark, rect: box, tooltip: [.fact(TooltipFact(text: Sidebar.terminalStatusLabel(terminals)))]))
            right = box.minX
        }
        // The glyph column, a link to the repository when there is one.
        let glyphBox = CGRect(x: rect.minX + CGFloat(m.rowInset), y: rect.minY, width: glyph, height: rect.height)
        if let url = row.repositoryUrl {
            let shown = url.hasPrefix("https://") ? String(url.dropFirst("https://".count)) : url
            controls.append(ControlBox(control: .link(url), rect: glyphBox, tooltip: [.fact(TooltipFact(text: "Open \(shown) on GitHub"))]))
        }
        // The words: after the glyph and the button's 8pt padding.
        let textStart = rect.minX + CGFloat(m.textInset)
        var textEnd = right - 8
        if let issue = row.issue, !narrow {
            // `.row-issue-title`: right after the name, 4pt padding each side.
            let labelFont = labelFont(workspace: row)
            let labelWidth = textWidth(row.label, labelFont)
            let badge: CGFloat = issue.laneLetter == nil ? 0 : 14 + 4
            let width = 4 + 14 + badge + 4
            let x = min(textStart + labelWidth + 8, right - width)
            let box = CGRect(x: x, y: rect.minY, width: width, height: rect.height)
            controls.append(ControlBox(control: .link(issue.url), rect: box, tooltip: issue.tooltip))
            textEnd = x - 8
        }
        item.textRect = CGRect(x: textStart, y: rect.minY, width: max(0, textEnd - textStart), height: rect.height)
        controls.append(ControlBox(control: .select, rect: rect, tooltip: row.tooltip))
        item.controls = controls
    }

    private func layoutAgent(_ item: inout SidebarItem, _ agent: AgentRowModel) {
        let m = metrics
        let rect = item.rect
        if collapsed {
            item.controls = [ControlBox(control: .select, rect: rect, tooltip: agent.tooltip)]
            return
        }
        let mid = rect.midY
        var right = rect.maxX
        var controls: [ControlBox] = []
        if let tip = agent.stopTooltip {
            let box = CGRect(x: right - 2 - 20, y: mid - 10, width: 20, height: 20)
            controls.append(ControlBox(
                control: .stopAgent(agent.id, retry: agent.stopFailed), rect: box, tooltip: [.fact(TooltipFact(text: tip))], hoverOnly: true))
            right = box.minX
        }
        let glyph = CGFloat(m.glyphWidth)
        let mark = CGRect(x: rect.minX + CGFloat(m.agentGlyphInset), y: mid - glyph / 2, width: glyph, height: glyph)
        controls.append(ControlBox(control: .mark, rect: mark, tooltip: [.fact(TooltipFact(text: agent.statusLabel))]))
        let textStart = rect.minX + CGFloat(m.agentTextInset)
        item.textRect = CGRect(x: textStart, y: rect.minY, width: max(0, right - 8 - textStart), height: rect.height)
        controls.append(ControlBox(control: .select, rect: rect, tooltip: agent.tooltip))
        item.controls = controls
    }

    // MARK: Drawing

    private func labelFont(workspace row: WorkspaceRowModel) -> NSFont {
        if row.selected { return ShellStyle.font(13, ShellStyle.semibold) }
        if row.unread { return ShellStyle.font(13, .semibold) }
        return ShellStyle.font(13, ShellStyle.medium)
    }

    private func labelFont(agent: AgentRowModel) -> NSFont {
        if agent.selected { return ShellStyle.font(13, ShellStyle.semibold) }
        if agent.showsUnread { return ShellStyle.font(13, .semibold) }
        return ShellStyle.font(13)
    }

    private var windowActive: Bool { window?.isKeyWindow ?? true }

    private func isRowHot(_ index: Int) -> Bool {
        if hoveredRow == index { return true }
        if keyboardFocused, let id = items[index].treeId, id == focusId { return true }
        return false
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let tokens = style.tokens
        let elapsed = CACurrentMediaTime() - animationStart
        let breathe = 0.425 + 0.125 * cos(elapsed * 2 * Double.pi / 1.8)
        for (index, item) in items.enumerated() where item.rect.intersects(dirtyRect.insetBy(dx: 0, dy: -40)) {
            switch item.kind {
            case .heading:
                drawHeading(item, index: index)
            case .empty:
                let text = NSAttributedString(
                    string: "No workspaces open", attributes: [.font: ShellStyle.font(12), .foregroundColor: tokens.tertiary.nsColor])
                text.draw(at: CGPoint(x: item.rect.minX + 12, y: item.rect.minY + 12))
            case let .ghost(ghost):
                context.saveGState()
                context.setAlpha(0.55)
                drawText([(ghost.label, ShellStyle.font(13, ShellStyle.medium), tokens.primary.nsColor)], in: CGRect(
                    x: item.rect.minX + CGFloat(metrics.textInset), y: item.rect.minY,
                    width: max(0, item.rect.width - CGFloat(metrics.textInset)), height: item.rect.height))
                context.restoreGState()
            case let .workspace(row):
                context.saveGState()
                if row.closing {
                    context.setAlpha(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0.55 : CGFloat(breathe))
                }
                drawWorkspace(item, row, index: index, elapsed: elapsed)
                context.restoreGState()
            case let .agent(agent, owner):
                context.saveGState()
                if agent.stopping || owner.closing {
                    context.setAlpha(owner.closing ? CGFloat(breathe) : 0.55)
                }
                drawAgent(item, agent, index: index, elapsed: elapsed)
                context.restoreGState()
            }
        }
        if let drag, drag.active { drawDropLine(drag) }
    }

    private func drawRowBackground(_ item: SidebarItem, selected: Bool, index: Int) {
        let tokens = style.tokens
        let shape = NSBezierPath(roundedRect: item.rect, xRadius: CGFloat(DevHubTheme.Radius.row), yRadius: CGFloat(DevHubTheme.Radius.row))
        if selected {
            (windowActive ? tokens.selection : tokens.selectionInactive).nsColor.setFill()
            shape.fill()
        } else if hoveredRow == index, drag?.active != true {
            tokens.wash.nsColor.setFill()
            shape.fill()
        }
        if keyboardFocused, let id = item.treeId, id == focusId {
            tokens.focusRing.nsColor.setStroke()
            let ring = NSBezierPath(
                roundedRect: item.rect.insetBy(dx: 1, dy: 1), xRadius: CGFloat(DevHubTheme.Radius.row) - 1,
                yRadius: CGFloat(DevHubTheme.Radius.row) - 1)
            ring.lineWidth = 2
            ring.stroke()
        }
    }

    private func drawHeading(_ item: SidebarItem, index: Int) {
        let tokens = style.tokens
        if collapsed {
            tokens.line.nsColor.setFill()
            item.rect.fill()
            return
        }
        // 11px, 590, uppercase, .04em tracking, in the tertiary ink.
        let font = ShellStyle.font(11, ShellStyle.semibold)
        let text = NSAttributedString(string: "WORKSPACES", attributes: [
            .font: font, .foregroundColor: tokens.tertiary.nsColor, .kern: 11 * 0.04,
        ])
        let size = text.size()
        text.draw(at: CGPoint(x: item.rect.minX + CGFloat(metrics.textInset), y: item.rect.midY - size.height / 2))
        for (offset, box) in item.controls.enumerated() {
            let hot = hoveredControl.map { $0.row == index && $0.index == offset } ?? false
            if hot {
                tokens.washStrong.nsColor.setFill()
                NSBezierPath(roundedRect: box.rect, xRadius: 4, yRadius: 4).fill()
            }
            let glyph: RowGlyph = box.control == .assignIssue ? .openIssue : .plus
            GlyphPainter.draw(glyph, in: square(centeredOn: CGPoint(x: box.rect.midX, y: box.rect.midY), side: 14),
                              color: tokens.secondary.nsColor, stroke: metrics.glyphStroke)
        }
    }

    /// The status mark (`StatusMark`), at `rect` (the glyph column's square).
    private func drawStatus(_ status: AgentStatus, unread: Bool, in rect: CGRect, elapsed: Double) {
        let tokens = style.tokens
        let showsUnread = unread && status == .idle
        let ink: NSColor
        switch status {
        case .working: ink = tokens.statusWorking.nsColor
        case .background: ink = tokens.statusBackground.nsColor
        case .waiting: ink = tokens.statusWaiting.nsColor
        case .idle: ink = tokens.statusIdle.nsColor
        case .error: ink = tokens.statusError.nsColor
        case .unknown: ink = tokens.secondary.nsColor
        }
        let shifted = rect.offsetBy(dx: 0, dy: CGFloat(DevHubTheme.sidebarGlyphOpticalShift))
        if status == .waiting, !showsUnread {
            tokens.statusWaiting.faded(0.16).setFill()
            NSBezierPath(ovalIn: shifted).fill()
        }
        var rotation: CGFloat = 0
        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            if status == .working { rotation = CGFloat((elapsed.truncatingRemainder(dividingBy: 1.5)) / 1.5 * 2 * Double.pi) }
            if status == .background { rotation = CGFloat((elapsed.truncatingRemainder(dividingBy: 4.5)) / 4.5 * 2 * Double.pi) }
        }
        let side = CGFloat(metrics.glyphInk)
        GlyphPainter.draw(
            Glyphs.status(status, unread: showsUnread),
            in: square(centeredOn: CGPoint(x: shifted.midX, y: shifted.midY), side: side),
            color: showsUnread ? tokens.statusWaiting.nsColor : ink, stroke: metrics.glyphStroke, rotation: rotation)
    }

    /// Words on one line, baseline-aligned, 8pt apart, fading out over their
    /// last 20pt when they do not fit (`.row-text`'s mask).
    private func drawText(_ runs: [(String, NSFont, NSColor)], in rect: CGRect) {
        guard let context = NSGraphicsContext.current?.cgContext, rect.width > 0 else { return }
        let baseFont = runs.first?.1 ?? ShellStyle.font(13)
        let baseline = rect.midY + (baseFont.ascender + baseFont.descender) / 2
        var x = rect.minX
        var total: CGFloat = 0
        for (index, run) in runs.enumerated() {
            total += textWidth(run.0, run.1) + (index == 0 ? 0 : 8)
        }
        let overflows = total > rect.width
        context.saveGState()
        context.clip(to: rect)
        if overflows { context.beginTransparencyLayer(auxiliaryInfo: nil) }
        for (index, run) in runs.enumerated() {
            if index > 0 { x += 8 }
            let text = NSAttributedString(string: run.0, attributes: [.font: run.1, .foregroundColor: run.2])
            text.draw(at: CGPoint(x: x, y: baseline - run.1.ascender))
            x += textWidth(run.0, run.1)
            if x > rect.maxX { break }
        }
        if overflows {
            let fade = CGRect(x: rect.maxX - 20, y: rect.minY, width: 20, height: rect.height)
            context.setBlendMode(.destinationOut)
            let space = CGColorSpaceCreateDeviceRGB()
            if let gradient = CGGradient(
                colorsSpace: space, colors: [NSColor.black.withAlphaComponent(0).cgColor, NSColor.black.cgColor] as CFArray,
                locations: [0, 1])
            {
                context.clip(to: fade)
                context.drawLinearGradient(
                    gradient, start: CGPoint(x: fade.minX, y: 0), end: CGPoint(x: fade.maxX, y: 0), options: [])
            }
            context.endTransparencyLayer()
        }
        context.restoreGState()
    }

    private func drawWorkspace(_ item: SidebarItem, _ row: WorkspaceRowModel, index: Int, elapsed: Double) {
        let tokens = style.tokens
        let m = metrics
        drawRowBackground(item, selected: row.selected, index: index)
        let hot = isRowHot(index)
        let glyphSide = CGFloat(m.glyphWidth)
        let glyphX = collapsed ? item.rect.minX + (item.rect.width - glyphSide) / 2 : item.rect.minX + CGFloat(m.rowInset)
        let glyphColumn = CGRect(x: glyphX, y: item.rect.midY - glyphSide / 2, width: glyphSide, height: glyphSide)
        // The digit while the prefix is armed, else the row's mark.
        if let digit = row.digit {
            let font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
            let text = NSAttributedString(string: "\(digit)", attributes: [.font: font, .foregroundColor: tokens.accent.nsColor])
            let size = text.size()
            text.draw(at: CGPoint(x: glyphColumn.midX - size.width / 2, y: glyphColumn.midY - size.height / 2 + CGFloat(DevHubTheme.sidebarGlyphOpticalShift)))
        } else {
            let linked = row.repositoryUrl != nil && !collapsed
            let ink = linked && hot ? tokens.accent.nsColor : tokens.rowGlyphInk.nsColor
            let ink2 = square(centeredOn: CGPoint(x: glyphColumn.midX, y: glyphColumn.midY + CGFloat(DevHubTheme.sidebarGlyphOpticalShift)), side: CGFloat(m.glyphInk))
            GlyphPainter.draw(row.glyph, in: ink2, color: ink, stroke: m.glyphStroke)
        }
        if collapsed { return }
        // The words.
        let labelColor: NSColor
        switch row.state {
        case .available: labelColor = tokens.primary.nsColor
        case .dimmed: labelColor = tokens.secondary.nsColor
        case .closeFailed: labelColor = tokens.danger.nsColor
        }
        var runs: [(String, NSFont, NSColor)] = [(row.label, labelFont(workspace: row), labelColor)]
        if let branch = row.branch { runs.append((branch, ShellStyle.font(11), tokens.tertiary.nsColor)) }
        drawText(runs, in: item.textRect)
        // The controls and the marks.
        for (offset, box) in item.controls.enumerated() {
            let pointed = hoveredControl.map { $0.row == index && $0.index == offset } ?? false
            switch box.control {
            case let .closeWorkspace(id) where id == row.id:
                drawActionButton(box, glyph: .close, rowHot: hot, pointed: pointed)
            case .createAgent:
                drawActionButton(box, glyph: .plus, rowHot: hot, pointed: pointed)
            case let .link(url):
                if url == row.pullRequest?.url, let pr = row.pullRequest, box.rect.width == 20 {
                    drawPullRequest(box, pr, rowHot: hot, pointed: pointed)
                } else if url == row.issue?.url, let issue = row.issue {
                    drawIssue(box, issue, rowHot: hot)
                }
            case .mark:
                if box.rect.width == CGFloat(m.glyphWidth), let terminals = row.terminals {
                    drawStatus(terminals.status, unread: terminals.unread != nil, in: box.rect, elapsed: elapsed)
                } else if box.rect.width == 14 {
                    drawSpinner(in: box.rect, elapsed: elapsed)
                } else if let tip = box.tooltip, case let .fact(fact)? = tip.first, fact.text == row.unavailable {
                    GlyphPainter.draw(.statusError, in: square(centeredOn: CGPoint(x: box.rect.midX, y: box.rect.midY), side: 14),
                                      color: tokens.danger.nsColor, stroke: m.glyphStroke)
                } else {
                    GlyphPainter.draw(.container, in: square(centeredOn: CGPoint(x: box.rect.midX, y: box.rect.midY), side: 14),
                                      color: tokens.rowGlyphInk.faded(0.7), stroke: m.glyphStroke)
                }
            default:
                break
            }
        }
    }

    private func drawSpinner(in rect: CGRect, elapsed: Double) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let tokens = style.tokens
        context.saveGState()
        context.translateBy(x: rect.midX, y: rect.midY)
        context.rotate(by: CGFloat(elapsed.truncatingRemainder(dividingBy: 0.72) / 0.72 * 2 * Double.pi))
        context.setStrokeColor(tokens.tertiary.cgColor)
        context.setLineWidth(1.5)
        context.addArc(center: .zero, radius: rect.width / 2 - 0.75, startAngle: 0, endAngle: 1.5 * .pi, clockwise: false)
        context.strokePath()
        context.restoreGState()
    }

    private func drawActionButton(_ box: ControlBox, glyph: RowGlyph, rowHot: Bool, pointed: Bool) {
        let tokens = style.tokens
        if !rowHot { return }
        if !box.enabled {
            GlyphPainter.draw(glyph, in: square(centeredOn: CGPoint(x: box.rect.midX, y: box.rect.midY), side: 14),
                              color: tokens.secondary.faded(0.35), stroke: metrics.glyphStroke)
            return
        }
        if pointed {
            let pressedNow = pressed.map { $0.control == box.control } ?? false
            (pressedNow ? tokens.selection : tokens.washStrong).nsColor.setFill()
            NSBezierPath(roundedRect: box.rect, xRadius: 4, yRadius: 4).fill()
        }
        GlyphPainter.draw(glyph, in: square(centeredOn: CGPoint(x: box.rect.midX, y: box.rect.midY), side: 14),
                          color: pointed ? tokens.primary.nsColor : tokens.secondary.nsColor, stroke: metrics.glyphStroke)
    }

    private func stateInk(issue state: IssueStatus.State) -> NSColor {
        state == .open ? style.tokens.statusIdle.nsColor : style.tokens.statusDone.nsColor
    }

    private func stateInk(pullRequest state: PullRequestStatus.State) -> NSColor? {
        switch state {
        case .open: return style.tokens.statusIdle.nsColor
        case .merged: return style.tokens.statusDone.nsColor
        case .closed: return style.tokens.danger.nsColor
        case .draft: return nil
        }
    }

    private func drawIssue(_ box: ControlBox, _ issue: RowIssueMark, rowHot: Bool) {
        let tokens = style.tokens
        let ink = rowHot ? stateInk(issue: issue.state) : tokens.rowGlyphInk.nsColor
        let glyph: RowGlyph = issue.state == .closed ? .issueClosed : .issueOpen
        let mark = CGRect(x: box.rect.minX + 4, y: box.rect.midY - 7, width: 14, height: 14)
        GlyphPainter.draw(glyph, in: mark, color: ink, stroke: metrics.glyphStroke)
        if let letter = issue.laneLetter {
            let badge = CGRect(x: mark.maxX + 4, y: mark.minY, width: 14, height: 14)
            let badgeInk = (issue.laneInk.flatMap { style.color(token: $0) } ?? ink).withAlphaComponent(0.85)
            badgeInk.setStroke()
            let frame = NSBezierPath(roundedRect: badge.insetBy(dx: 0.5, dy: 0.5), xRadius: 4, yRadius: 4)
            frame.lineWidth = 1
            frame.stroke()
            let text = NSAttributedString(string: letter, attributes: [.font: ShellStyle.font(9, .semibold), .foregroundColor: badgeInk])
            let size = text.size()
            text.draw(at: CGPoint(x: badge.midX - size.width / 2, y: badge.midY - size.height / 2))
        }
    }

    private func drawPullRequest(_ box: ControlBox, _ pr: RowPullRequestMark, rowHot: Bool, pointed: Bool) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let tokens = style.tokens
        if pointed {
            tokens.washStrong.nsColor.setFill()
            NSBezierPath(roundedRect: box.rect, xRadius: 4, yRadius: 4).fill()
        }
        let ink = rowHot ? (stateInk(pullRequest: pr.state) ?? tokens.rowGlyphInk.nsColor) : tokens.rowGlyphInk.nsColor
        let mark = CGRect(x: box.rect.midX - 7, y: box.rect.midY - 7, width: 14, height: 14)
        let badged = pr.conversationBadge || pr.checksBadge != nil
        if badged {
            // The mark is cut where a badge sits, so the badge reads on its own.
            context.saveGState()
            context.beginTransparencyLayer(auxiliaryInfo: nil)
            GlyphPainter.draw(pr.glyph, in: mark, color: ink, stroke: metrics.glyphStroke)
            context.setBlendMode(.destinationOut)
            NSColor.black.setFill()
            if pr.conversationBadge {
                NSBezierPath(ovalIn: CGRect(x: mark.maxX - 11 + 3.5 - 1, y: mark.minY - 3 - 1, width: 13, height: 13)).fill()
            }
            if pr.checksBadge != nil {
                NSBezierPath(ovalIn: CGRect(x: mark.maxX - 9 + 3 - 1, y: mark.maxY - 9 + 2 - 1, width: 11, height: 11)).fill()
            }
            context.endTransparencyLayer()
            context.restoreGState()
        } else {
            GlyphPainter.draw(pr.glyph, in: mark, color: ink, stroke: metrics.glyphStroke)
        }
        if pr.conversationBadge {
            GlyphPainter.draw(.conversation, in: CGRect(x: mark.maxX - 11 + 3.5, y: mark.minY - 3, width: 11, height: 11),
                              color: tokens.statusWaiting.nsColor, stroke: metrics.glyphStroke)
        }
        if let checks = pr.checksBadge {
            let color = checks == .checksFailing ? tokens.statusError.nsColor : tokens.statusWorking.nsColor
            GlyphPainter.draw(checks, in: CGRect(x: mark.maxX - 9 + 3, y: mark.maxY - 9 + 2, width: 9, height: 9), color: color, stroke: 3)
        }
    }

    private func drawAgent(_ item: SidebarItem, _ agent: AgentRowModel, index: Int, elapsed: Double) {
        let tokens = style.tokens
        let m = metrics
        drawRowBackground(item, selected: agent.selected, index: index)
        let glyph = CGFloat(m.glyphWidth)
        if collapsed {
            let column = CGRect(x: item.rect.minX + (item.rect.width - glyph) / 2, y: item.rect.midY - glyph / 2, width: glyph, height: glyph)
            drawStatus(agent.status, unread: agent.unread != nil, in: column, elapsed: elapsed)
            return
        }
        // The tree's connector: down the Workspace's glyph column, an elbow
        // into this Agent's mark at the row's centre line.
        let line = tokens.line.nsColor
        line.setFill()
        let treeX = item.rect.minX + CGFloat(m.treeLine)
        let half = CGFloat(m.rowHeight) / 2
        NSRect(x: treeX, y: item.rect.minY, width: 1, height: agent.isLast ? half : item.rect.height).fill()
        let elbowEnd = item.rect.minX + CGFloat(m.agentGlyphInset - m.treeGap)
        NSRect(x: treeX, y: item.rect.minY + half, width: max(0, elbowEnd - treeX), height: 1).fill()
        let mark = CGRect(x: item.rect.minX + CGFloat(m.agentGlyphInset), y: item.rect.midY - glyph / 2, width: glyph, height: glyph)
        drawStatus(agent.status, unread: agent.unread != nil, in: mark, elapsed: elapsed)
        var runs: [(String, NSFont, NSColor)] = [(agent.leading, labelFont(agent: agent), tokens.primary.nsColor)]
        if let naming = agent.naming { runs.append((naming, ShellStyle.font(11), tokens.tertiary.nsColor)) }
        if let note = agent.note { runs.append((note, ShellStyle.font(11), tokens.secondary.nsColor)) }
        drawText(runs, in: item.textRect)
        let hot = isRowHot(index)
        for (offset, box) in item.controls.enumerated() {
            if case .stopAgent = box.control {
                let pointed = hoveredControl.map { $0.row == index && $0.index == offset } ?? false
                drawActionButton(box, glyph: .close, rowHot: hot, pointed: pointed)
            }
        }
    }

    private func drawDropLine(_ drag: DragState) {
        let tokens = style.tokens
        var y: CGFloat?
        var x = metrics.textInset
        switch drag.gap {
        case let .before(id):
            if let item = items.first(where: { rowId($0) == id }) { y = item.rect.minY }
        case .end:
            if let last = drag.lane.last {
                let owned = items.indices.filter { index in
                    rowId(items[index]) == last || (drag.source.isWorkspace && isAgentItem(items[index]) && items[index].workspaceId == last)
                }
                if let lastIndex = owned.last { y = items[lastIndex].rect.maxY }
            }
        case .none:
            y = nil
        }
        if case .agent = drag.source { x = metrics.agentTextInset - Double(metrics.glyphWidth) - 8 }
        guard let y else { return }
        tokens.accent.nsColor.setFill()
        let start = (items.first?.rect.minX ?? 0) + CGFloat(x)
        NSBezierPath(roundedRect: CGRect(x: start, y: y - 1, width: max(0, bounds.width - start - CGFloat(metrics.scrollInset)), height: 2), xRadius: 1, yRadius: 1).fill()
    }

    private func isAgentItem(_ item: SidebarItem) -> Bool {
        if case .agent = item.kind { return true }
        return false
    }

    /// The id a drag lane names a row by.
    private func rowId(_ item: SidebarItem) -> String? {
        switch item.kind {
        case let .workspace(row): return row.id
        case let .agent(agent, _): return agent.id
        default: return nil
        }
    }

    // MARK: Animation

    private var animates: Bool {
        guard let model, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return false }
        func spins(_ row: WorkspaceRowModel) -> Bool {
            row.closing || row.pendingIssue != nil || row.terminals?.status == .working
                || row.agents.contains { $0.status == .working || $0.status == .background }
        }
        if spins(model.scratch) { return true }
        return model.rows.contains { entry in
            if case let .workspace(row) = entry { return spins(row) }
            return false
        }
    }

    private func updateAnimation() {
        if animates {
            if animationTimer == nil {
                let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.needsDisplay = true }
                }
                RunLoop.main.add(timer, forMode: .common)
                animationTimer = timer
            }
        } else {
            animationTimer?.invalidate()
            animationTimer = nil
        }
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

    private func hit(_ point: CGPoint) -> (row: Int, control: Int?)? {
        for (index, item) in items.enumerated() where item.rect.contains(point) || item.controls.contains(where: { $0.rect.contains(point) }) {
            // The row's own controls are raised above its select area.
            if let control = item.controls.firstIndex(where: { $0.control != .select && $0.rect.contains(point) }) {
                let box = item.controls[control]
                if box.hoverOnly && !box.enabled { return (index, nil) }
                return (index, control)
            }
            return (index, item.controls.firstIndex { $0.control == .select })
        }
        return nil
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let found = hit(point)
        let row = found?.row
        let control = found.flatMap { found in found.control.map { (found.row, $0) } }
        if row != hoveredRow || control.map({ "\($0.0):\($0.1)" }) != hoveredControl.map({ "\($0.row):\($0.index)" }) {
            hoveredRow = row
            hoveredControl = control.map { (row: $0.0, index: $0.1) }
            needsDisplay = true
            pointerMovedTo(found)
        }
    }

    override func mouseExited(with event: NSEvent) {
        hoveredRow = nil
        hoveredControl = nil
        needsDisplay = true
        pointerMovedTo(nil)
    }

    /// `pointerover` / `pointerout`: rest 300ms on a thing with a tooltip.
    private func pointerMovedTo(_ found: (row: Int, control: Int?)?) {
        restTimer?.invalidate()
        restTimer = nil
        let next = found.flatMap { found -> (row: Int, control: Int?)? in
            guard let control = found.control else { return nil }
            return items[found.row].controls[control].tooltip == nil ? nil : (found.row, control)
        }
        let same = next.map { "\($0.row):\($0.control ?? -1)" } == tooltipAnchor.map { "\($0.row):\($0.control ?? -1)" }
        if same { return }
        if tooltipAnchor != nil {
            tooltipAnchor = nil
            liveTimer?.invalidate()
            liveTimer = nil
            host?.sidebarReleaseTooltip()
        }
        guard let next, drag?.active != true else { return }
        tooltipAnchor = next
        let timer = Timer(timeInterval: Sidebar.hoverDelayMs / 1000, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.showTooltip(next) }
        }
        RunLoop.main.add(timer, forMode: .common)
        restTimer = timer
    }

    private func tooltipLines(_ anchor: (row: Int, control: Int?)) -> [TooltipLine]? {
        guard anchor.row < items.count else { return nil }
        let item = items[anchor.row]
        guard let control = anchor.control, control < item.controls.count else { return item.tooltip }
        let box = item.controls[control]
        if box.control == .select, case let .agent(agent, _) = item.kind {
            // An Agent's row counts its cache down (`LIVE_TICK_MS`).
            return Sidebar.agentTooltip(agent, now: Date().timeIntervalSince1970 * 1000)
        }
        return box.tooltip
    }

    private func showTooltip(_ anchor: (row: Int, control: Int?)) {
        guard let lines = tooltipLines(anchor), !lines.isEmpty, anchor.row < items.count else { return }
        let item = items[anchor.row]
        let local = anchor.control.map { item.controls[$0].control == .select ? item.rect : item.controls[$0].rect } ?? item.rect
        guard let window, let scroll = enclosingScrollView else { return }
        // Held inside the Sidebar's visible area (`RowTooltip`'s clamp).
        let visible = convert(scroll.contentView.documentVisibleRect, to: nil)
        var inWindow = convert(local, to: nil)
        let top = max(visible.minY, min(inWindow.minY, visible.maxY))
        let bottom = max(visible.minY, min(inWindow.maxY, visible.maxY))
        guard bottom > top else { return }
        inWindow = CGRect(x: inWindow.minX, y: top, width: inWindow.width, height: bottom - top)
        // The window's coordinates, top-left origin, as the layout reads them.
        let height = window.contentView?.bounds.height ?? 0
        let anchorRect = CGRect(x: inWindow.minX, y: height - inWindow.maxY, width: inWindow.width, height: inWindow.height)
        host?.sidebarShowTooltip(lines, anchor: anchorRect)
        liveTimer?.invalidate()
        liveTimer = nil
        if case .agent(let agent, _) = item.kind, agent.promptCache != nil {
            let timer = Timer(timeInterval: Sidebar.liveTickMs / 1000, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, let current = self.tooltipAnchor, current.row == anchor.row, current.control == anchor.control else { return }
                    self.showTooltip(current)
                }
            }
            RunLoop.main.add(timer, forMode: .common)
            liveTimer = timer
        }
    }

    /// `focusin`: the keyboard's row shows its tooltip at once.
    private func showKeyboardTooltip() {
        guard keyboardFocused, let focusId, let index = items.firstIndex(where: { $0.treeId == focusId }) else { return }
        let select = items[index].controls.firstIndex { $0.control == .select }
        tooltipAnchor = (index, select)
        showTooltip((index, select))
    }

    override func mouseDown(with event: NSEvent) {
        host?.sidebarHideTooltip()
        tooltipAnchor = nil
        let point = convert(event.locationInWindow, from: nil)
        guard let found = hit(point), let controlIndex = found.control else { return }
        let item = items[found.row]
        let box = item.controls[controlIndex]
        if box.control == .select {
            // A row press is a select, or the start of a drag.
            if let source = dragSource(item) {
                let lane = (try? snapshot.map { try Sidebar.dropLane($0, source) }) ?? nil
                drag = DragState(source: source, origin: point, lane: lane ?? [])
            }
            pressed = (found.row, .select)
            return
        }
        if !box.enabled || box.control == .mark { return }
        pressed = (found.row, box.control)
        needsDisplay = true
    }

    private func dragSource(_ item: SidebarItem) -> Sidebar.DragSource? {
        switch item.kind {
        case let .workspace(row): return row.fixed || row.closing ? nil : .workspace(row.id)
        case let .agent(agent, owner): return owner.closing ? nil : .agent(agent.id, workspaceId: agent.workspaceId)
        default: return nil
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard var state = drag else { return }
        let point = convert(event.locationInWindow, from: nil)
        if !state.active {
            if hypot(point.x - state.origin.x, point.y - state.origin.y) < 4 { return }
            state.active = true
            host?.sidebarHideTooltip()
            NSCursor.closedHand.push()
        }
        state.gap = .none
        if let index = items.firstIndex(where: { $0.rect.minY <= point.y && point.y < $0.rect.maxY }), let id = rowId(items[index]) {
            let half: Sidebar.Half = point.y < items[index].rect.midY ? .top : .bottom
            if state.lane.contains(id) {
                state.gap = Sidebar.gap(state.lane, rowId: id, half: half)
            } else if case .workspace = state.source, case let .agent(_, owner) = items[index].kind, state.lane.contains(owner.id) {
                // An Agent row under a lane's Workspace is that Workspace's bottom half.
                state.gap = Sidebar.gap(state.lane, rowId: owner.id, half: .bottom)
            }
        }
        drag = state
        _ = autoscroll(with: event)
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        defer {
            pressed = nil
            needsDisplay = true
        }
        if let state = drag {
            drag = nil
            if state.active {
                NSCursor.pop()
                let before: String?? = {
                    switch state.gap {
                    case let .before(id): return .some(id)
                    case .end: return .some(nil)
                    case .none: return nil
                    }
                }()
                if let before, let snapshot, let intent = try? Sidebar.dropIntent(snapshot, state.source, before: before) {
                    host?.sidebarDispatch(intent)
                }
                return
            }
        }
        let point = convert(event.locationInWindow, from: nil)
        guard let pressed, let found = hit(point), found.row == pressed.row, let control = found.control else { return }
        let item = items[found.row]
        guard item.controls[control].control == pressed.control else { return }
        perform(pressed.control, item: item, event: event)
    }

    private func perform(_ control: SidebarControl, item: SidebarItem, event: NSEvent) {
        switch control {
        case .select:
            switch item.kind {
            case let .workspace(row):
                if row.closing { return }
                focusId = item.treeId
                host?.sidebarSelect(.workspace(row.id), split: false, byPointer: true)
            case let .agent(agent, _):
                if agent.stopping { return }
                focusId = item.treeId
                host?.sidebarSelect(.agent(agent.id), split: event.modifierFlags.contains(.option), byPointer: true)
            default:
                return
            }
        case let .link(url): host?.sidebarOpenURL(url)
        case let .createAgent(id): host?.sidebarCreateAgent(id)
        case let .closeWorkspace(id): host?.sidebarCloseWorkspace(id)
        case let .stopAgent(id, retry): host?.sidebarDispatch(retry ? .retryStopAgent(agentId: id) : .stopAgent(agentId: id))
        case .assignIssue: host?.sidebarOpenIssueAssignment()
        case .openPicker: host?.sidebarOpenWorkspacePicker()
        case .mark: return
        }
    }

    // MARK: The row menus (native NSMenu)

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        guard let found = hit(point), let snapshot else { return nil }
        let item = items[found.row]
        let entries: [Sidebar.MenuItem]
        switch item.kind {
        case let .workspace(row): entries = Sidebar.workspaceMenu(row)
        case let .agent(agent, _):
            guard let wire = snapshot.workspace(agent.workspaceId)?.agents.first(where: { $0.id == agent.id }) else { return nil }
            entries = Sidebar.agentMenu(wire)
        default: return nil
        }
        guard !entries.isEmpty else { return nil }
        host?.sidebarHideTooltip()
        let menu = NSMenu()
        menu.autoenablesItems = false
        for entry in entries {
            if entry.separated, !menu.items.isEmpty { menu.addItem(.separator()) }
            let menuItem = SidebarMenuItem(title: entry.label, action: #selector(menuChosen(_:)), keyEquivalent: "")
            menuItem.target = self
            menuItem.payload = entry.action
            menu.addItem(menuItem)
        }
        return menu
    }

    @objc private func menuChosen(_ sender: NSMenuItem) {
        guard let action = (sender as? SidebarMenuItem)?.payload else { return }
        host?.sidebarMenu(action)
    }

    // MARK: Keyboard (`sidebarKeyboard`)

    private func scrollToFocus() {
        guard let focusId, let item = items.first(where: { $0.treeId == focusId }) else { return }
        scrollToVisible(item.rect.insetBy(dx: 0, dy: -4))
    }

    override func keyDown(with event: NSEvent) {
        guard let model, let snapshot else { return super.keyDown(with: event) }
        if event.modifierFlags.contains(.command) { return super.keyDown(with: event) }
        let key = MacKeys.key(characters: event.charactersIgnoringModifiers, keyCode: event.keyCode).lowercased()
        let tree = Sidebar.treeItems(model)
        switch key {
        case "escape":
            host?.sidebarLeave()
            return
        case "arrowup", "arrowdown":
            if event.modifierFlags.contains(.option) {
                // `Alt+↑/↓` moves the row, the same rule a drag follows.
                if let focusId, let source = Sidebar.source(ofTreeItem: focusId, snapshot),
                   let intent = try? Sidebar.moveIntent(snapshot, source, key == "arrowdown" ? .down : .up)
                {
                    host?.sidebarDispatch(intent)
                }
                return
            }
            moveFocus(Sidebar.walk(tree, from: focusId, key: key))
            return
        case "home", "end", "arrowleft", "arrowright":
            if let next = Sidebar.walk(tree, from: focusId, key: key) { moveFocus(next) }
            return
        case "enter", " ":
            // Return chooses a row without leaving the list.
            if let focusId, let entry = tree.first(where: { $0.id == focusId }) {
                host?.sidebarSelect(entry.context, split: false, byPointer: false)
            }
            return
        default:
            super.keyDown(with: event)
        }
    }

    private func moveFocus(_ id: String?) {
        guard let id else { return }
        focusId = id
        scrollToFocus()
        host?.sidebarHideTooltip()
        showKeyboardTooltip()
        needsDisplay = true
    }

    // MARK: Accessibility

    override func accessibilityChildren() -> [Any]? {
        guard let window else { return [] }
        return items.compactMap { item -> NSAccessibilityElement? in
            let label: String
            let selected: Bool
            switch item.kind {
            case let .workspace(row): label = row.description; selected = row.selected
            case let .agent(agent, _): label = agent.description; selected = agent.selected
            default: return nil
            }
            let screen = window.convertToScreen(convert(item.rect, to: nil))
            guard let element = NSAccessibilityElement.element(withRole: .row, frame: screen, label: label, parent: self)
                as? NSAccessibilityElement else { return nil }
            element.setAccessibilitySelected(selected)
            return element
        }
    }
}

private final class SidebarMenuItem: NSMenuItem {
    var payload: Sidebar.MenuAction?
}

private extension Sidebar.DragSource {
    var isWorkspace: Bool {
        if case .workspace = self { return true }
        return false
    }
}
