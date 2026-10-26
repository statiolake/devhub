// Port of the window half of apps/desktop/src/main/shell/appController.ts
// (`publishLayoutState`, `editorTerminalViews`, `paneFocused`,
// `editorKeyForSurfaceKey`) and of `ShellWindow.workbenchArea`
// (main/shell/shellWindow.ts), as pure functions of the projection.
//
// Everything the layout is a function of that is not the window's own size,
// read off the projection in one breath so no half of it can be newer than the
// other. The App's window controller holds the four facts that are not the
// model's — the window's chrome, whether the person asked for the Sidebar, a
// drag in progress, and which editor areas have been on screen — and asks
// this for the `LayoutState` that `WindowLayout.compute` lays out.

import Foundation

/// A drag in progress, in the window's own hand: the number the person is
/// dragging to, forgotten when the model has it (`CHANNELS.previewLayout`).
public struct LayoutPreview: Equatable, Sendable {
    public var sidebarWidth: Double?
    public var splitRatio: Double?
    /// The divider between an Agent and its terminal.
    public var terminalShare: Double?

    public init(sidebarWidth: Double? = nil, splitRatio: Double? = nil, terminalShare: Double? = nil) {
        self.sidebarWidth = sidebarWidth
        self.splitRatio = splitRatio
        self.terminalShare = terminalShare
    }
}

/// Terminal mode's editor area for one Workspace: a view on its own `ws-`
/// session, filed under the editor key a workbench would have had.
public struct EditorTerminalEntry: Hashable, Sendable {
    public var editorKey: String
    public var workspaceId: String

    public init(editorKey: String, workspaceId: String) {
        self.editorKey = editorKey
        self.workspaceId = workspaceId
    }

    /// `workspaceTerminalSurfaceKey`.
    public var surfaceKey: String { TerminalSurfaceKeys.workspace(workspaceId) }
}

/// Which of the content area's views took the keyboard by itself — a click
/// (`ContentFocus`).
public enum ContentFocus: Hashable, Sendable {
    case editor
    case agents
    case terminal(String)
}

/// The seams no view covers, as the window's own view draws them
/// (`WorkbenchAreaWire`).
public struct SeamGeometry: Equatable, Sendable {
    /// The rectangle the editor area is laid into.
    public var workbench: LayoutRect
    /// How wide the content area around it is: what the split ratio is a ratio of.
    public var contentWidth: Double
    /// The split's divider, when there is a split.
    public var split: LayoutRect?
    public var terminal: TerminalSeam?

    public struct TerminalSeam: Equatable, Sendable {
        public var rect: LayoutRect
        public var terminalId: String
        public var share: Double
        /// Under a split's Agent (level), or right of a full one (upright).
        public var stacked: Bool
        /// What the terminal shares with its Agent.
        public var extent: LayoutRect

        /// `shareAt`: the share a pointer at this point asks for, or nothing
        /// when there is no room to share.
        public func share(atX x: Double, y: Double) -> Double? {
            if stacked {
                let available = extent.height - rect.height
                if available <= 0 { return nil }
                let below = extent.y + extent.height - (y + rect.height / 2)
                return AgentTerminals.clampShare(below / available)
            }
            let available = extent.width - rect.width
            if available <= 0 { return nil }
            let right = extent.x + extent.width - (x + rect.width / 2)
            return AgentTerminals.clampShare(right / available)
        }
    }

    /// `ratioAt`: the split ratio a pointer at `x` asks for.
    public func ratio(atX x: Double) -> Double? {
        if contentWidth <= 0 { return nil }
        return Projection.clampSplitRatio((x - workbench.x) / contentWidth)
    }
}

/// `workspaceTerminalSurfaceKey`, `paneTerminalSurfaceKey`, `agentSurfaceKey`
/// (ipc/terminal.ts): the names a terminal surface attaches by.
public enum TerminalSurfaceKeys {
    public static let workspacePrefix = "workspace-terminal:"
    public static let agentPrefix = "agent:"
    public static let paneTerminalPrefix = "terminal:"

    public static func workspace(_ workspaceId: String) -> String { workspacePrefix + workspaceId }
    public static func agent(_ agentId: String) -> String { agentPrefix + agentId }
    public static func paneTerminal(_ terminalId: String) -> String { paneTerminalPrefix + terminalId }
}

extension WorkspaceWire {
    /// `terminalModeSupports`, on the projection: a folder on this Mac whose
    /// editor is not in a dev container.
    public var terminalModeSupported: Bool {
        location == .local && editor == .host
    }

    /// `terminalModeUnsupported`, on the projection.
    public var terminalModeUnsupportedSentence: String {
        location == .local
            ? "Terminal mode does not support Workspaces whose editor is in a dev container yet."
            : "Terminal mode does not support Workspaces on SSH hosts yet."
    }
}

/// The Workspaces whose editor-area terminal has been on screen, by editor key
/// (`editorTerminalsShown`). Each keeps its view — attached, hidden — once it
/// has been shown; one whose Workspace has gone, or cannot have one, is dropped.
public struct EditorTerminalsShown: Equatable, Sendable {
    public private(set) var keys: Set<String> = []

    public init() {}

    /// `editorTerminalViews`: the views there should be, now that `onScreen`
    /// is (or nothing is) in the editor area.
    public mutating func entries(onScreen: String?, snapshot: AppSnapshotWire) -> [EditorTerminalEntry] {
        if let onScreen { keys.insert(onScreen) }
        var entries: [EditorTerminalEntry] = []
        for workspace in snapshot.workspaces where keys.contains(workspace.key) && workspace.terminalModeSupported {
            entries.append(EditorTerminalEntry(editorKey: workspace.key, workspaceId: workspace.id))
        }
        keys = Set(entries.map(\.editorKey))
        return entries
    }
}

/// What the window's own chrome is, as the settings say it.
public struct ShellChrome: Equatable, Sendable {
    public var titleBar: TitleBarMode
    public var density: DevHubTheme.Density

    public init(titleBar: TitleBarMode = .shown, density: DevHubTheme.Density = .compact) {
        self.titleBar = titleBar
        self.density = density
    }
}

/// One reading of the arrangement.
public struct ShellArrangement: Equatable, Sendable {
    public var state: LayoutState
    /// Every Agent terminal there is: each has a view, shown or hidden.
    public var terminals: [String]
    /// Terminal mode's editor areas that have a view.
    public var editorTerminals: [EditorTerminalEntry]
}

public enum ShellLayout {
    /// `editorKeyForSurfaceKey`: the projection names an editor by its surface
    /// key; the window's children are filed by the Workspace's folder key.
    public static func editorKey(forSurfaceKey surfaceKey: String, in snapshot: AppSnapshotWire) -> String? {
        let prefix = "workspace-editor:"
        guard surfaceKey.hasPrefix(prefix) else { return nil }
        return snapshot.workspace(String(surfaceKey.dropFirst(prefix.count)))?.key
    }

    /// The Workspace an editor key is, if one is open.
    public static func workspace(forEditorKey key: String, in snapshot: AppSnapshotWire) -> WorkspaceWire? {
        snapshot.workspaces.first { $0.key == key }
    }

    /// The share an Agent's terminal takes beside it, or under it in a split.
    static func share(_ agent: AgentWire, stacked: Bool) -> Double {
        (stacked ? agent.terminalStackedShare : agent.terminalShare) ?? AgentTerminals.defaultShare
    }

    /// `publishLayoutState`'s reading.
    public static func arrangement(
        _ snapshot: AppSnapshotWire, chrome: ShellChrome, keyboardInSidebar: Bool, preview: LayoutPreview,
        shown: inout EditorTerminalsShown
    ) -> ShellArrangement {
        let layout = snapshot.layout
        let editorKey: String?
        switch layout {
        case let .workbench(key), let .split(key, _): editorKey = self.editorKey(forSurfaceKey: key, in: snapshot)
        default: editorKey = nil
        }
        var surface: SurfaceArrangement
        if snapshot.readiness != .ready {
            surface = .none
        } else {
            switch layout {
            case .agent: surface = .agent
            case .split:
                surface = editorKey.map { .split(editorKey: $0, ratio: preview.splitRatio ?? snapshot.splitRatio) } ?? .none
            case .workbench:
                surface = editorKey.map { .editor(editorKey: $0) } ?? .none
            case .unavailable:
                surface = .none
            }
        }
        // The view's Agent's terminal, laid out with its Agent — right of a full
        // one, under a split's — and never with the editor alone.
        var terminal: (terminalId: String, share: Double)?
        if let visible = snapshot.visibleTerminal, surface.isAgent || surface.isSplit,
           let agent = snapshot.workspaces.lazy.flatMap(\.agents).first(where: { $0.terminal?.id == visible })
        {
            terminal = (visible, preview.terminalShare ?? share(agent, stacked: surface.isSplit))
        }
        let terminals = snapshot.workspaces.flatMap(\.agents).compactMap { $0.terminal?.id }
        // Terminal mode's editor area: a view for every Workspace shown so far.
        let onScreen: String? = {
            switch surface {
            case let .editor(key, _), let .split(key, _, _): return key
            default: return nil
            }
        }()
        let editorTerminals = shown.entries(onScreen: onScreen, snapshot: snapshot)
        let keyboard: KeyboardHalf
        if keyboardInSidebar {
            keyboard = .sidebar
        } else if let pane = snapshot.paneFocus {
            keyboard = .terminal(pane)
        } else {
            switch surface {
            case .editor: keyboard = .editor
            case .split: keyboard = snapshot.selection.context.agentId == nil ? .editor : .agents
            default: keyboard = .agents
            }
        }
        let state = LayoutState(
            titleBar: chrome.titleBar, density: chrome.density,
            sidebarWidth: preview.sidebarWidth ?? snapshot.sidebar.width, sidebarCollapsed: snapshot.sidebar.collapsed,
            surface: surface, keyboard: keyboard, terminal: terminal
        )
        return ShellArrangement(state: state, terminals: terminals, editorTerminals: editorTerminals)
    }

    /// `workbenchArea`: the seams, for the window's own view to draw and drag.
    public static func seams(_ windowSize: LayoutSize, _ state: LayoutState) -> SeamGeometry {
        let workbench = WindowLayout.workbenchRect(windowSize, state)
        var terminal: SeamGeometry.TerminalSeam?
        if let seam = WindowLayout.terminalSeam(windowSize, state),
           let extent = WindowLayout.terminalExtent(windowSize, state),
           let shown = state.terminal
        {
            terminal = SeamGeometry.TerminalSeam(
                rect: seam, terminalId: shown.terminalId, share: shown.share,
                stacked: WindowLayout.terminalStacked(state), extent: extent
            )
        }
        return SeamGeometry(
            workbench: workbench, contentWidth: WindowLayout.surfaceRect(windowSize, state).width,
            split: WindowLayout.splitSeam(windowSize, state), terminal: terminal
        )
    }

    /// `paneFocused`: the intents a click into one of the content area's
    /// views comes to. The model is told which pane, so `Cmd+Q X` and
    /// `Cmd+Q O` start from it; a click into the other half of a split moves
    /// the selection's half. A focus DevHub placed itself changes nothing.
    public static func paneFocused(_ pane: ContentFocus, _ snapshot: AppSnapshotWire) -> [UserIntent] {
        if case let .terminal(terminalId) = pane {
            if snapshot.paneFocus == terminalId { return [] }
            return [.focusPane(.terminal(terminalId: terminalId))]
        }
        guard snapshot.paneFocus != nil else { return [] }
        var intents: [UserIntent] = [.focusPane(.content)]
        guard snapshot.selection.presentation == .beside else { return intents }
        let agentHalf = snapshot.selection.context.agentId != nil
        if agentHalf != (pane == .agents) { intents.append(.swapSplitFocus) }
        return intents
    }

    /// `createSurfaceResolver`: the terminal a surface key attaches to, on the
    /// model as it is now. A Workspace that is closing refuses.
    public static func target(forSurfaceKey key: String, model: AppModel) throws -> TerminalTarget? {
        func machine(_ workspace: Workspace) throws -> RuntimeId {
            try RuntimeId.parse(workspace.location.runtimeId)
        }
        func refuseIfClosing(_ workspace: Workspace) throws {
            if workspace.close.isRunning { throw TerminalFailure(.workspaceClosing) }
        }
        if key.hasPrefix(TerminalSurfaceKeys.agentPrefix) {
            guard let agent = try? AgentId(String(key.dropFirst(TerminalSurfaceKeys.agentPrefix.count))),
                  let workspace = model.workspaceForAgent(agent) else { return nil }
            try refuseIfClosing(workspace)
            return .agent(machine: try machine(workspace), agentId: agent.rawValue, workspaceId: workspace.id.rawValue, root: workspace.root)
        }
        if key.hasPrefix(TerminalSurfaceKeys.paneTerminalPrefix) {
            let id = String(key.dropFirst(TerminalSurfaceKeys.paneTerminalPrefix.count))
            guard let terminal = model.agentTerminals().first(where: { $0.terminalId == id }),
                  let workspace = model.workspaceForAgent(terminal.agentId) else { return nil }
            try refuseIfClosing(workspace)
            return .terminal(machine: try machine(workspace), terminalId: id, workspaceId: workspace.id.rawValue, root: workspace.root)
        }
        guard key.hasPrefix(TerminalSurfaceKeys.workspacePrefix),
              let id = try? WorkspaceId(String(key.dropFirst(TerminalSurfaceKeys.workspacePrefix.count))),
              let workspace = model.workspace(id) else { return nil }
        try refuseIfClosing(workspace)
        return .workspace(machine: try machine(workspace), workspaceId: workspace.id.rawValue, root: workspace.root)
    }
}
