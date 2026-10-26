// Snapshots for the window's tests: Scratch, Workspaces and Agents as the
// projection draws them, with the ids the TS sidebar tests use.

import Foundation
@testable import DevHubCore

enum ShellFixtures {
    static let scratchId = "00000000-0000-4000-8000-000000000000"

    static func agent(
        _ id: String, in workspaceId: String, ordinal: Int = 1, name: String? = nil, status: AgentStatus = .idle,
        unread: AgentStatus? = nil, activity: String? = nil, control: AgentControlState = .running,
        failure: AgentFailure? = nil, health: AgentRuntimeHealth = .healthy, kind: AgentProfileKind = .claude,
        presentation: AgentPresentation = .tui, terminal: String? = nil, open: Bool = true,
        share: Double? = nil, stackedShare: Double? = nil
    ) -> AgentWire {
        AgentWire(
            controlState: control, failure: failure, displayName: name ?? id, id: id, ordinal: ordinal, profileId: "claude",
            profileKind: kind, presentation: presentation, runtimeHealth: health, status: status, unread: unread,
            activity: activity, promptCache: nil, injection: .none, automaticActions: [], workspaceId: workspaceId,
            terminal: terminal.map { AgentTerminalWire(id: $0, session: "tm-\($0)", open: open) },
            terminalShare: share, terminalStackedShare: stackedShare)
    }

    static func workspace(
        _ id: String, label: String? = nil, agents: [AgentWire] = [], groupKey: String? = nil,
        location: WorkspaceLocationWire = .local, editor: EditorAttachmentWire = .host, close: WorkspaceClose = .idle,
        state: WorkspaceState = .available, terminals: TerminalActivity? = nil, canCreateAgent: Bool = true
    ) -> WorkspaceWire {
        let root = "/work/\(label ?? id)"
        return WorkspaceWire(
            agents: agents, canCreateAgent: canCreateAgent, id: id, label: label ?? id, location: location, editor: editor,
            root: root, displayRoot: "~\(root)", key: root, groupKey: groupKey ?? root, selectedPath: root, state: state,
            close: close, lastAgentId: agents.last?.id, terminals: terminals)
    }

    static func snapshot(
        _ workspaces: [WorkspaceWire] = [], scratchAgents: [AgentWire] = [], context: ContextWire? = nil,
        presentation: SurfacePresentation = .full, layout: LayoutWire? = nil, readiness: AppReadiness = .ready,
        visibleTerminal: String? = nil, paneFocus: String? = nil, collapsed: Bool = false, splitRatio: Double = 0.55
    ) -> AppSnapshotWire {
        let scratch = workspace(scratchId, label: "Scratch", agents: scratchAgents)
        let context = context ?? .workspace(scratchId)
        let layout = layout ?? {
            switch context {
            case let .workspace(id): return .workbench(editorKey: "workspace-editor:\(id)")
            case let .agent(id):
                let owner = ([scratch] + workspaces).first { $0.agents.contains { $0.id == id } }?.id ?? scratchId
                return presentation == .beside
                    ? .split(editorKey: "workspace-editor:\(owner)", agentKey: "agent:\(id)") : .agent(agentKey: "agent:\(id)")
            }
        }()
        return AppSnapshotWire(
            editorHost: .ready, layout: layout, readiness: readiness, revision: 1,
            selection: SelectionWire(context: context, presentation: presentation), scratchWorkspaceId: scratchId,
            sidebar: SidebarSnapshot(width: 248, collapsed: collapsed), splitRatio: splitRatio, visibleTerminal: visibleTerminal,
            paneFocus: paneFocus, smartButtons: SmartButtonsPlacement(), terminalZoomOffset: 0,
            workspaces: [scratch] + workspaces, history: nil)
    }
}
