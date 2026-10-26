// Projections the window can be drawn from without a model behind it: the
// empty one a view stands on before the first snapshot, and the one the
// App's `--self-test` draws — Scratch, one Workspace and one Agent with its
// terminal — so the window, its layout, the Sidebar and the terminal surfaces
// are exercised on CI without a tmux server or a settings file.

import Foundation

public enum WindowFixtures {
    public static let scratchId = "00000000-0000-4000-8000-000000000000"
    public static let workspaceId = "11111111-1111-4111-8111-111111111111"
    public static let agentId = "22222222-2222-4222-8222-222222222222"
    public static let terminalId = "33333333-3333-4333-8333-333333333333"

    public static func agent(
        _ id: String, in workspaceId: String, name: String, status: AgentStatus = .idle, unread: AgentStatus? = nil,
        activity: String? = nil, terminal: String? = nil
    ) -> AgentWire {
        AgentWire(
            controlState: .running, failure: nil, displayName: name, id: id, ordinal: 1, profileId: "claude",
            profileKind: .claude, presentation: .tui, runtimeHealth: .healthy, status: status, unread: unread,
            activity: activity, promptCache: nil, injection: .none, automaticActions: [], workspaceId: workspaceId,
            terminal: terminal.map { AgentTerminalWire(id: $0, session: AgentTerminals.sessionName($0), open: true) },
            terminalShare: nil, terminalStackedShare: nil)
    }

    public static func workspace(_ id: String, label: String, root: String, agents: [AgentWire] = []) -> WorkspaceWire {
        WorkspaceWire(
            agents: agents, canCreateAgent: true, id: id, label: label, location: .local, editor: .host, root: root,
            displayRoot: root, key: root, groupKey: root, selectedPath: root, state: .available, close: .idle,
            lastAgentId: agents.last?.id, terminals: nil)
    }

    public static func snapshot(
        _ workspaces: [WorkspaceWire], context: ContextWire, presentation: SurfacePresentation = .full,
        layout: LayoutWire, visibleTerminal: String? = nil, readiness: AppReadiness = .ready, revision: Int = 1
    ) -> AppSnapshotWire {
        AppSnapshotWire(
            editorHost: .ready, layout: layout, readiness: readiness, revision: revision,
            selection: SelectionWire(context: context, presentation: presentation), scratchWorkspaceId: scratchId,
            sidebar: SidebarSnapshot(width: 248, collapsed: false), splitRatio: 0.55, visibleTerminal: visibleTerminal,
            paneFocus: nil, smartButtons: SmartButtonsPlacement(), terminalZoomOffset: 0, workspaces: workspaces,
            history: HistoryAvailability(canGoBack: false, canGoForward: false))
    }

    /// Scratch alone, before anything is known.
    public static func emptySnapshot() -> AppSnapshotWire {
        let scratch = workspace(scratchId, label: "Scratch", root: "/tmp")
        return snapshot(
            [scratch], context: .workspace(scratchId), layout: .workbench(editorKey: "workspace-editor:\(scratchId)"),
            readiness: .starting)
    }

    /// The self-test's window: Scratch, a Workspace and its Agent, the Agent
    /// selected in the given presentation, its terminal open.
    public static func selfTest(root: String, presentation: SurfacePresentation = .full, terminal: Bool = false, revision: Int = 1)
        -> AppSnapshotWire
    {
        let scratch = workspace(scratchId, label: "Scratch", root: root + "/scratch")
        let agent = agent(agentId, in: workspaceId, name: "Claude", status: .working, activity: "Self-test", terminal: terminalId)
        let widget = workspace(workspaceId, label: "widget", root: root + "/widget", agents: [agent])
        let layout: LayoutWire = presentation == .beside
            ? .split(editorKey: "workspace-editor:\(workspaceId)", agentKey: "agent:\(agentId)")
            : .agent(agentKey: "agent:\(agentId)")
        return snapshot(
            [scratch, widget], context: .agent(agentId), presentation: presentation, layout: layout,
            visibleTerminal: terminal ? terminalId : nil, revision: revision)
    }

    /// The same window with the Workspace's editor area in front.
    public static func selfTestWorkspace(root: String, revision: Int = 1) -> AppSnapshotWire {
        var snapshot = selfTest(root: root, revision: revision)
        snapshot.selection = SelectionWire(context: .workspace(workspaceId), presentation: .full)
        snapshot.layout = .workbench(editorKey: "workspace-editor:\(workspaceId)")
        return snapshot
    }
}
