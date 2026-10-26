// Port of apps/desktop/src/main/shell/windowLayout.ts, as pure Core.
//
// Where everything in the one window is, decided in one place.
//
// The window is a tree of child views over one rectangle: the window's own
// view, the Sidebar, the editor area per Workspace, the Agents, the Agent
// terminals, the notices, the questions, the tooltip. Every one of them needs
// a rectangle, a visibility and a place in the child list, and those three
// answers have to agree with each other.
//
// So there is one function that answers all three, and it is pure. It takes
// the projection, the window's size and the two appearance settings that move
// the chrome, and it returns the child list. The App's window controller is
// the only code that applies it (sets frames, visibility, first responder).
//
// The numbers are the counterparts of the tokens of the TS app's
// `shell/styles/tokens.css`, and they are named after them.
//
// The workbench (VS Code) arrangement is kept in the vocabulary — terminal
// mode's editor area takes exactly a workbench's place — so the layout
// cases of the TS tests read the same; native DevHub passes no `editors`,
// only `editorTerminals`.

import Foundation

public struct LayoutRect: Hashable, Sendable, CustomStringConvertible {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var description: String { "(\(x), \(y), \(width)×\(height))" }
}

/// What the content area holds, as read off the model.
public enum SurfaceArrangement: Hashable, Sendable {
    /// One editor area, the whole content area.
    case editor(editorKey: String, hidden: Bool = false)
    /// An editor area and an Agent's pane, split at `ratio` of the area.
    case split(editorKey: String, ratio: Double, hidden: Bool = false)
    /// An Agent over the whole area: the editor areas stay built, none shown.
    case agent
    /// Nothing to show — starting, or a folder that is gone.
    case none

    var editorKey: String? {
        switch self {
        case let .editor(key, _), let .split(key, _, _): return key
        default: return nil
        }
    }

    var hidden: Bool {
        switch self {
        case let .editor(_, hidden), let .split(_, _, hidden): return hidden
        default: return false
        }
    }

    var isSplit: Bool { if case .split = self { return true } else { return false } }
    var isAgent: Bool { self == .agent }
}

/// Which child the keyboard belongs to.
public enum KeyboardHalf: Hashable, Sendable {
    case editor
    case agents
    case sidebar
    /// The Agent's terminal, beside it.
    case terminal(String)
}

/// Whether the questions layer covers the window or one editor.
public enum PickerScope: String, Hashable, Sendable {
    case none, window, workbench
}

/// Everything about the arrangement that is not the window's own size.
public struct LayoutState: Hashable, Sendable {
    public var titleBar: TitleBarMode
    public var density: DevHubTheme.Density
    public var sidebarWidth: Double
    public var sidebarCollapsed: Bool
    public var surface: SurfaceArrangement
    public var keyboard: KeyboardHalf
    /// The Agent terminal drawn with the Agent `surface` shows, and its share.
    public var terminal: (terminalId: String, share: Double)? {
        get { terminalId.map { ($0, terminalShare) } }
        set {
            terminalId = newValue?.terminalId
            terminalShare = newValue?.share ?? 0
        }
    }
    private var terminalId: String?
    private var terminalShare: Double = 0

    public init(
        titleBar: TitleBarMode = .shown, density: DevHubTheme.Density = .compact, sidebarWidth: Double = 248,
        sidebarCollapsed: Bool = false, surface: SurfaceArrangement, keyboard: KeyboardHalf,
        terminal: (terminalId: String, share: Double)? = nil
    ) {
        self.titleBar = titleBar
        self.density = density
        self.sidebarWidth = sidebarWidth
        self.sidebarCollapsed = sidebarCollapsed
        self.surface = surface
        self.keyboard = keyboard
        self.terminal = terminal
    }

    public static func == (lhs: LayoutState, rhs: LayoutState) -> Bool {
        lhs.titleBar == rhs.titleBar && lhs.density == rhs.density && lhs.sidebarWidth == rhs.sidebarWidth
            && lhs.sidebarCollapsed == rhs.sidebarCollapsed && lhs.surface == rhs.surface && lhs.keyboard == rhs.keyboard
            && lhs.terminalId == rhs.terminalId && lhs.terminalShare == rhs.terminalShare
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(surface)
        hasher.combine(keyboard)
        hasher.combine(terminalId)
    }
}

/// A view a workbench attached to itself (kept for the TS vocabulary).
public struct AttachedPlacement: Hashable, Sendable {
    public var id: Int
    public var editorKey: String
    public var rect: LayoutRect
    public var visible: Bool

    public init(id: Int, editorKey: String, rect: LayoutRect, visible: Bool) {
        self.id = id
        self.editorKey = editorKey
        self.rect = rect
        self.visible = visible
    }
}

/// Everything needed to place a tooltip: the anchor in the window's
/// coordinates, and the size the panel measured.
public struct TooltipPlacement: Hashable, Sendable {
    public var anchor: LayoutRect
    public var size: LayoutSize

    public init(anchor: LayoutRect, size: LayoutSize) {
        self.anchor = anchor
        self.size = size
    }
}

public struct LayoutInput: Hashable, Sendable {
    public var windowSize: LayoutSize
    public var state: LayoutState
    /// Every workbench that exists, by folder key, in the order it was made.
    /// Always empty in the native app.
    public var editors: [String]
    /// The workbench that has stopped to ask something, if one has.
    public var asking: String?
    /// How big the notices are, as their view measured its own stack.
    public var toasts: LayoutSize?
    public var picker: PickerScope
    public var tooltip: TooltipPlacement?
    public var attached: [AttachedPlacement]
    /// Every Agent terminal that has a view, by id.
    public var terminals: [String]
    /// Terminal mode's editor area: every Workspace terminal that has a view,
    /// by the editor key a workbench would have had.
    public var editorTerminals: [String]

    public init(
        windowSize: LayoutSize, state: LayoutState, editors: [String] = [], asking: String? = nil,
        toasts: LayoutSize? = nil, picker: PickerScope = .none, tooltip: TooltipPlacement? = nil,
        attached: [AttachedPlacement] = [], terminals: [String] = [], editorTerminals: [String] = []
    ) {
        self.windowSize = windowSize
        self.state = state
        self.editors = editors
        self.asking = asking
        self.toasts = toasts
        self.picker = picker
        self.tooltip = tooltip
        self.attached = attached
        self.terminals = terminals
        self.editorTerminals = editorTerminals
    }
}

public enum ChildIdentity: Hashable, Sendable {
    case shell
    case sidebar
    case agents
    case editor(editorKey: String)
    case attached(editorKey: String, id: Int)
    /// An Agent's terminal, with its Agent.
    case terminal(terminalId: String)
    /// Terminal mode's editor area: a Workspace's own tmux session.
    case editorTerminal(editorKey: String)
    case toasts
    case picker
    case tooltip
}

public struct LayoutChild: Hashable, Sendable {
    public var identity: ChildIdentity
    public var rect: LayoutRect
    public var visible: Bool
}

public enum WindowLayout {
    /// `--titlebar-height`: the band the traffic lights sit in, either chrome.
    public static let titleBarHeight: Double = 32
    /// One traffic light's frame, square.
    public static let trafficLightSize: Double = 14
    /// `--traffic-light-span`: how far the lights reach from the leading edge.
    public static let trafficLightSpan: Double = 76
    /// `--space-3`: the margin the rail leaves each side of its glyph column.
    public static let sidebarRailMargin: Double = 12
    /// `--sidebar-glyph-width`, per density.
    public static func sidebarGlyphWidth(_ density: DevHubTheme.Density) -> Double { density == .compact ? 16 : 18 }
    /// The line between the content area and the title bar above it.
    public static let hairline: Double = 1
    /// `.split-divider`'s own width. The seam is a view, not a border.
    public static let splitDivider: Double = 6
    /// How far the notices sit from the window's corner.
    public static let toastsMargin: Double = 12
    /// Between a tooltip and the row it is about.
    public static let tooltipGap: Double = 6
    /// How close a tooltip may come to the window's own edges.
    public static let tooltipMargin: Double = 4

    /// `trafficLightPosition`: centred in the title bar, and as far from the
    /// leading edge as from the top.
    public static func trafficLightPosition() -> (x: Double, y: Double) {
        let inset = (titleBarHeight - trafficLightSize) / 2
        return (inset, inset)
    }

    /// `sidebarColumnWidth`: how wide the Sidebar's column is, hairline included.
    public static func sidebarColumnWidth(_ state: LayoutState) -> Double {
        if !state.sidebarCollapsed { return jsRoundDouble(state.sidebarWidth) }
        return state.titleBar == .hidden ? trafficLightSpan : sidebarGlyphWidth(state.density) + 2 * sidebarRailMargin
    }

    /// `surfaceRect`: everything that is not the Sidebar and not the title bar.
    public static func surfaceRect(_ windowSize: LayoutSize, _ state: LayoutState) -> LayoutRect {
        let bar = state.titleBar == .shown ? titleBarHeight + hairline : 0
        let x = sidebarColumnWidth(state)
        return LayoutRect(x: x, y: bar, width: max(0, windowSize.width - x), height: max(0, windowSize.height - bar))
    }

    /// `sidebarRect`: the leading column, under the band the window is dragged by.
    public static func sidebarRect(_ windowSize: LayoutSize, _ state: LayoutState) -> LayoutRect {
        let band = state.titleBar == .shown ? titleBarHeight + hairline : titleBarHeight
        return LayoutRect(x: 0, y: band, width: sidebarColumnWidth(state), height: max(0, windowSize.height - band))
    }

    /// `terminalPlacement`: where the Agent and its terminal go, when one is shown.
    public static func terminalPlacement(_ windowSize: LayoutSize, _ state: LayoutState) -> TerminalPlacement? {
        guard let extent = terminalExtent(windowSize, state), let terminal = state.terminal else { return nil }
        return terminalStacked(state)
            ? AgentTerminals.placeBelow(extent, share: terminal.share, gap: splitDivider)
            : AgentTerminals.place(extent, share: terminal.share, gap: splitDivider)
    }

    /// `terminalExtent`: what the terminal shares with its Agent.
    public static func terminalExtent(_ windowSize: LayoutSize, _ state: LayoutState) -> LayoutRect? {
        guard state.terminal != nil else { return nil }
        if state.surface.isAgent { return surfaceRect(windowSize, state) }
        if state.surface.isSplit { return splitAgentHalf(windowSize, state) }
        return nil
    }

    /// `terminalStacked`: whether the terminal on screen is under its Agent.
    public static func terminalStacked(_ state: LayoutState) -> Bool { state.surface.isSplit }

    /// `contentRect`: the selection's own pane.
    public static func contentRect(_ windowSize: LayoutSize, _ state: LayoutState) -> LayoutRect {
        let placement = state.surface.isAgent ? terminalPlacement(windowSize, state) : nil
        return placement?.content ?? surfaceRect(windowSize, state)
    }

    /// `terminalSeam`.
    public static func terminalSeam(_ windowSize: LayoutSize, _ state: LayoutState) -> LayoutRect? {
        terminalPlacement(windowSize, state)?.seam
    }

    /// `agentsRect`: the rectangle the Agents' view is laid into.
    public static func agentsRect(_ windowSize: LayoutSize, _ state: LayoutState) -> LayoutRect {
        if !state.surface.isSplit { return contentRect(windowSize, state) }
        return terminalPlacement(windowSize, state)?.content ?? splitAgentHalf(windowSize, state)
    }

    /// A split's whole right half: the Agent, and its terminal under it if any.
    static func splitAgentHalf(_ windowSize: LayoutSize, _ state: LayoutState) -> LayoutRect {
        let surface = contentRect(windowSize, state)
        let workbench = workbenchRect(windowSize, state)
        let x = workbench.x + workbench.width + splitDivider
        return LayoutRect(x: x, y: surface.y, width: max(0, surface.x + surface.width - x), height: surface.height)
    }

    /// The seam between the editor and the Agent in a split, for the window's
    /// own view to draw the divider in.
    public static func splitSeam(_ windowSize: LayoutSize, _ state: LayoutState) -> LayoutRect? {
        guard state.surface.isSplit else { return nil }
        let workbench = workbenchRect(windowSize, state)
        return LayoutRect(x: workbench.x + workbench.width, y: workbench.y, width: splitDivider, height: workbench.height)
    }

    /// `workbenchRect`: the rectangle the editor area is laid into.
    public static func workbenchRect(_ windowSize: LayoutSize, _ state: LayoutState) -> LayoutRect {
        let surface = contentRect(windowSize, state)
        guard case let .split(_, ratio, _) = state.surface else { return surface }
        let available = max(0, surface.width - splitDivider)
        return LayoutRect(x: surface.x, y: surface.y, width: max(0, jsRoundDouble(available * ratio)), height: surface.height)
    }

    /// `insideRect`: a rectangle given in `container`'s coordinates, placed in
    /// the window's and held inside it.
    public static func insideRect(_ container: LayoutRect, _ local: LayoutRect) -> LayoutRect {
        let x = clamp(container.x + jsRoundDouble(local.x), container.x, container.x + container.width)
        let y = clamp(container.y + jsRoundDouble(local.y), container.y, container.y + container.height)
        let right = min(container.x + container.width, container.x + jsRoundDouble(local.x) + jsRoundDouble(local.width))
        let bottom = min(container.y + container.height, container.y + jsRoundDouble(local.y) + jsRoundDouble(local.height))
        return LayoutRect(x: x, y: y, width: max(0, right - x), height: max(0, bottom - y))
    }

    private static func toastsRect(_ windowSize: LayoutSize, _ size: LayoutSize) -> LayoutRect {
        let width = min(jsRoundDouble(size.width), windowSize.width)
        let height = min(jsRoundDouble(size.height), windowSize.height)
        return LayoutRect(
            x: max(0, windowSize.width - width - toastsMargin), y: max(0, windowSize.height - height - toastsMargin),
            width: width, height: height
        )
    }

    /// Hold `value` inside `[low, high]`, `low` held under `high` first.
    static func clamp(_ value: Double, _ low: Double, _ high: Double) -> Double {
        max(min(low, high), min(value, high))
    }

    /// `tooltipRect`: beside the row it is about, inside the window. Flip to
    /// the leading side when the trailing side has no room; clamp to the window.
    public static func tooltipRect(_ windowSize: LayoutSize, _ placement: TooltipPlacement) -> LayoutRect {
        let anchor = placement.anchor
        let width = min(jsRoundDouble(placement.size.width), windowSize.width)
        let height = min(jsRoundDouble(placement.size.height), windowSize.height)
        let lastX = max(0, windowSize.width - width - tooltipMargin)
        let lastY = max(0, windowSize.height - height - tooltipMargin)
        let right = anchor.x + anchor.width + tooltipGap
        let x = right > lastX ? anchor.x - tooltipGap - width : right
        return LayoutRect(x: clamp(x, tooltipMargin, lastX), y: clamp(anchor.y, tooltipMargin, lastY), width: width, height: height)
    }

    /// `onScreenEditor`: which workbench is on screen, if any.
    public static func onScreenEditor(_ input: LayoutInput) -> String? {
        if let asking = input.asking, input.editors.contains(asking) { return asking }
        guard let key = input.state.surface.editorKey, !input.state.surface.hidden, input.editors.contains(key) else { return nil }
        return key
    }

    /// `onScreenEditorTerminal`: which Workspace terminal is in the editor area.
    public static func onScreenEditorTerminal(_ input: LayoutInput) -> String? {
        guard let key = input.state.surface.editorKey, !input.state.surface.hidden, input.editorTerminals.contains(key) else {
            return nil
        }
        return key
    }

    private static func editorChild(_ input: LayoutInput) -> ChildIdentity? {
        if let key = onScreenEditor(input) { return .editor(editorKey: key) }
        return onScreenEditorTerminal(input).map { .editorTerminal(editorKey: $0) }
    }

    /// `keyboardChild`: which child the keys go to — by identity. A standing
    /// question owns the keyboard; then the half the state names, falling back
    /// to what is actually drawn.
    public static func keyboardChild(_ input: LayoutInput) -> ChildIdentity {
        if input.picker != .none { return .picker }
        if let asking = input.asking, input.editors.contains(asking) { return .editor(editorKey: asking) }
        switch input.state.keyboard {
        case .sidebar:
            return .sidebar
        case let .terminal(terminalId):
            let placed = input.terminals.contains(terminalId) && input.state.terminal?.terminalId == terminalId
                && terminalPlacement(input.windowSize, input.state) != nil
            if placed { return .terminal(terminalId: terminalId) }
            if let editor = editorChild(input), !input.state.surface.isAgent { return editor }
            return agentsVisible(input.state) ? .agents : .shell
        case .agents:
            return agentsVisible(input.state) ? .agents : .shell
        case .editor:
            return editorChild(input) ?? .shell
        }
    }

    static func agentsVisible(_ state: LayoutState) -> Bool { state.surface.isAgent || state.surface.isSplit }

    /// `parkedRect`: where a layer waits while it has nothing to show.
    public static func parkedRect(_ windowSize: LayoutSize) -> LayoutRect {
        LayoutRect(x: windowSize.width - 1, y: windowSize.height - 1, width: windowSize.width, height: windowSize.height)
    }

    private static func layer(_ identity: ChildIdentity, _ windowSize: LayoutSize, _ rect: LayoutRect?) -> LayoutChild {
        LayoutChild(identity: identity, rect: rect ?? parkedRect(windowSize), visible: rect != nil)
    }

    /// `windowLayout`: the window's children, in the order they are stacked
    /// (lowest first): the window's own view, the Sidebar, the editor areas
    /// (the one on screen last), the Agents, the Agent terminals, the notices,
    /// the questions, the tooltip.
    public static func compute(_ input: LayoutInput) -> [LayoutChild] {
        let windowSize = input.windowSize
        let state = input.state
        let shellRect = LayoutRect(x: 0, y: 0, width: windowSize.width, height: windowSize.height)
        let editorRect = workbenchRect(windowSize, state)
        let onScreen = onScreenEditor(input)

        var children: [LayoutChild] = [
            LayoutChild(identity: .shell, rect: shellRect, visible: true),
            LayoutChild(identity: .sidebar, rect: sidebarRect(windowSize, state), visible: true),
        ]
        for key in input.editors where key != onScreen {
            children.append(LayoutChild(identity: .editor(editorKey: key), rect: editorRect, visible: false))
        }
        if let onScreen {
            children.append(LayoutChild(identity: .editor(editorKey: onScreen), rect: editorRect, visible: true))
        }
        for child in input.attached where child.editorKey != onScreen {
            children.append(LayoutChild(
                identity: .attached(editorKey: child.editorKey, id: child.id), rect: insideRect(editorRect, child.rect), visible: false
            ))
        }
        for child in input.attached where child.editorKey == onScreen {
            children.append(LayoutChild(
                identity: .attached(editorKey: child.editorKey, id: child.id), rect: insideRect(editorRect, child.rect),
                visible: child.visible
            ))
        }
        let onScreenTerminal = onScreenEditorTerminal(input)
        for key in input.editorTerminals where key != onScreenTerminal {
            children.append(LayoutChild(identity: .editorTerminal(editorKey: key), rect: editorRect, visible: false))
        }
        if let onScreenTerminal {
            children.append(LayoutChild(identity: .editorTerminal(editorKey: onScreenTerminal), rect: editorRect, visible: true))
        }
        children.append(LayoutChild(identity: .agents, rect: agentsRect(windowSize, state), visible: agentsVisible(state)))
        let placement = terminalPlacement(windowSize, state)
        for terminalId in input.terminals {
            let shown = placement != nil && state.terminal?.terminalId == terminalId
            children.append(LayoutChild(
                identity: .terminal(terminalId: terminalId),
                rect: shown ? placement!.terminal : surfaceRect(windowSize, state),
                visible: shown
            ))
        }
        let toasts = input.toasts.flatMap { $0.width > 0 && $0.height > 0 ? toastsRect(windowSize, $0) : nil }
        children.append(layer(.toasts, windowSize, toasts))
        let pickerRect: LayoutRect? = input.picker == .none ? nil : input.picker == .workbench ? editorRect : shellRect
        children.append(layer(.picker, windowSize, pickerRect))
        children.append(layer(.tooltip, windowSize, input.tooltip.map { tooltipRect(windowSize, $0) }))
        return children
    }

    // MARK: - Reading the model

    /// The arrangement the model's layout asks for, as the window lays it out
    /// (`publishLayoutState`'s reading in terminal mode): a split carries the
    /// model's ratio, an unavailable layout draws nothing.
    public static func arrangement(_ snapshot: AppSnapshot) -> SurfaceArrangement {
        switch snapshot.layout {
        case let .workbench(editor): return .editor(editorKey: editorKey(editor))
        case let .split(editor, _): return .split(editorKey: editorKey(editor), ratio: snapshot.splitRatio)
        case .agent: return .agent
        case .unavailable: return .none
        }
    }

    /// The key an editor area is filed under: the surface key's name.
    public static func editorKey(_ key: SurfaceKey) -> String { key.name }

    /// The terminal on screen and its share — beside a full Agent, or under a
    /// split's — off the model.
    public static func terminal(_ snapshot: AppSnapshot) -> (terminalId: String, share: Double)? {
        guard let visible = snapshot.visibleTerminal,
              let agent = snapshot.workspaces.lazy.flatMap(\.agents).first(where: { $0.id == visible.agentId }) else { return nil }
        let stacked = snapshot.layout.isSplit
        return (visible.terminalId, stacked ? agent.terminalStackedShare : agent.terminalShare)
    }
}
