// Port of the decisions in apps/desktop/src/shell/components/sidebar/
// Sidebar.tsx (what each row says, shows and offers), rowMenu.ts (the row
// context menus), reorder.ts (where a dragged row may land), closingExit.ts
// (the ghost of a row that finished closing) and the tree walk of the
// Sidebar's keyboard (sidebarKeyboard.test.tsx).
//
// The Sidebar draws one row per Workspace, Scratch first, each followed by its
// Agents; every row is one line. The App's view draws what this says and asks
// nothing of the model itself, so a row's words, marks, menus and drop rules
// are one composition here and are tested here.

import Foundation

// MARK: - What a row draws

/// How a Workspace row's label is inked by its state (`data-state`).
public enum WorkspaceRowState: String, Sendable, Equatable {
    case available
    /// Unavailable or closing: the secondary ink.
    case dimmed
    /// A close that stopped: the danger ink, held still.
    case closeFailed
}

/// The Issue the row is on, as its mark draws it.
public struct RowIssueMark: Equatable, Sendable {
    public var state: IssueStatus.State
    public var url: String
    public var label: String
    public var tooltip: [TooltipLine]
    /// The Projects lane's letter in its small square, and the ink it wears.
    public var laneLetter: String?
    /// A colour token name (`--status-idle`, …), or nil for the muted ink.
    public var laneInk: String?
}

/// The pull request mark at the row's trailing edge.
public struct RowPullRequestMark: Equatable, Sendable {
    public var state: PullRequestStatus.State
    public var glyph: RowGlyph
    public var url: String
    public var label: String
    public var tooltip: [TooltipLine]
    /// Somebody is waiting on an answer in it.
    public var conversationBadge: Bool
    /// What its CI says, when it failed or is still going.
    public var checksBadge: RowGlyph?
}

/// One Agent's row.
public struct AgentRowModel: Equatable, Sendable {
    public var id: String
    public var workspaceId: String
    public var selected: Bool
    public var status: AgentStatus
    public var unread: AgentStatus?
    /// Idle and unread: the row wears the unread mark and a heavier label.
    public var showsUnread: Bool
    /// What it is doing, or its name when it has not said.
    public var leading: String
    /// Its own name, when the name tells it from its siblings.
    public var naming: String?
    /// Why it may not be doing what its status says.
    public var note: String?
    public var stopping: Bool
    public var stopFailed: Bool
    /// The last of its Workspace's Agents: the connector ends in `└`.
    public var isLast: Bool
    public var description: String
    public var tooltip: [TooltipLine]
    public var promptCache: PromptCache?
    /// The status mark's own label ("Working", "Idle, unread").
    public var statusLabel: String

    /// The row's stop control: "Retry stop" or "Stop agent", and absent while stopping.
    public var stopTooltip: String? { stopping ? nil : (stopFailed ? "Retry stop" : "Stop agent") }
}

/// One Workspace's row, Scratch's included.
public struct WorkspaceRowModel: Equatable, Sendable {
    public var id: String
    public var label: String
    /// The branch beside the name — not drawn once the Issue is known.
    public var branch: String?
    public var glyph: RowGlyph
    /// Scratch: never closed, never dragged.
    public var fixed: Bool
    public var selected: Bool
    public var closing: Bool
    public var state: WorkspaceRowState
    /// What its own terminals are doing; nil when idle and read.
    public var terminals: TerminalActivity?
    /// Its terminals finished unseen: the label is set heavier.
    public var unread: Bool
    /// While the chord prefix is armed: the digit that selects it.
    public var digit: Int?
    /// The repository's page, when there is one: the glyph is its link.
    public var repositoryUrl: String?
    public var issue: RowIssueMark?
    public var pendingIssue: Int?
    public var unavailable: String?
    /// The editor's dev container, as a quiet mark (never, in terminal mode).
    public var editorFact: (text: String, spoken: String)?
    public var pullRequest: RowPullRequestMark?
    public var canCreateAgent: Bool
    /// The `+`: whether it can be pressed, and what its tooltip says.
    public var createAgentEnabled: Bool
    public var createAgentTooltip: String
    public var createAgentLabel: String
    /// Closing deletes the folder (`closingDeletesWorktree`).
    public var deletesWorktree: Bool
    public var closeTooltip: String?
    public var closeLabel: String
    public var description: String
    public var tooltip: [TooltipLine]
    public var agents: [AgentRowModel]

    public static func == (lhs: WorkspaceRowModel, rhs: WorkspaceRowModel) -> Bool {
        lhs.id == rhs.id && lhs.label == rhs.label && lhs.branch == rhs.branch && lhs.glyph == rhs.glyph
            && lhs.fixed == rhs.fixed && lhs.selected == rhs.selected && lhs.closing == rhs.closing
            && lhs.state == rhs.state && lhs.terminals == rhs.terminals && lhs.unread == rhs.unread
            && lhs.digit == rhs.digit && lhs.repositoryUrl == rhs.repositoryUrl && lhs.issue == rhs.issue
            && lhs.pendingIssue == rhs.pendingIssue && lhs.unavailable == rhs.unavailable
            && lhs.editorFact?.text == rhs.editorFact?.text && lhs.pullRequest == rhs.pullRequest
            && lhs.canCreateAgent == rhs.canCreateAgent && lhs.createAgentEnabled == rhs.createAgentEnabled
            && lhs.createAgentTooltip == rhs.createAgentTooltip && lhs.deletesWorktree == rhs.deletesWorktree
            && lhs.closeTooltip == rhs.closeTooltip && lhs.description == rhs.description
            && lhs.tooltip == rhs.tooltip && lhs.agents == rhs.agents
    }
}

/// A row that finished closing, on its way off the list (`ExitingRow`).
public struct ExitingRow: Equatable, Sendable {
    public var id: String
    public var label: String
    /// Where the row was, so the ghost stands in its own place.
    public var index: Int

    public init(id: String, label: String, index: Int) {
        self.id = id
        self.label = label
        self.index = index
    }
}

/// One entry of the list under the heading (`SidebarRowEntry`).
public enum SidebarEntry: Equatable, Sendable {
    case workspace(WorkspaceRowModel)
    case exiting(ExitingRow)
}

/// The whole Sidebar.
public struct SidebarModel: Equatable, Sendable {
    public var scratch: WorkspaceRowModel
    public var rows: [SidebarEntry]
    public var collapsed: Bool
    public var width: Double

    /// "No workspaces open", under the heading, when there are none.
    public var isEmpty: Bool { rows.isEmpty }
}

/// The agent profiles, as the `+` reads them.
public struct SidebarProfiles: Equatable, Sendable {
    public var available: Bool
    /// Display names by profile id.
    public var names: [String: String]

    public init(available: Bool, names: [String: String]) {
        self.available = available
        self.names = names
    }

    public static func of(_ config: Config?) -> SidebarProfiles {
        guard let config else { return SidebarProfiles(available: false, names: [:]) }
        var names: [String: String] = [:]
        for profile in config.agentProfiles { names[profile.id] = profile.displayName }
        return SidebarProfiles(available: true, names: names)
    }
}

public enum Sidebar {
    /// `CLOSING_EXIT_MS`: how long a ghost stands, the same number as the
    /// `row-exit` animation.
    public static let closingExitMs: Double = 180
    /// `HOVER_DELAY_MS`: how long the pointer rests on a row before its
    /// tooltip is drawn. The keyboard has no such delay.
    public static let hoverDelayMs: Double = 300
    /// `RELEASE_GRACE_MS`: how long a released tooltip is held for the pointer
    /// to arrive in it.
    public static let releaseGraceMs: Double = 150
    /// `LIVE_TICK_MS`: how often a tooltip that counts down is drawn again.
    public static let liveTickMs: Double = 1000

    /// The whole list as drawn: Scratch, then every other Workspace, ghosts
    /// put back where they were.
    public static func model(
        _ snapshot: AppSnapshotWire, repositories: RepositoryStatusWire, profiles: SidebarProfiles, armed: Bool,
        exiting: [ExitingRow] = []
    ) throws -> SidebarModel {
        let (scratch, rows) = try snapshot.sidebarWorkspaces()
        let digits = Dictionary(uniqueKeysWithValues: rows.prefix(9).enumerated().map { ($1.id, $0 + 1) })
        func build(_ workspace: WorkspaceWire, digit: Int?) -> WorkspaceRowModel {
            row(workspace, snapshot: snapshot, repository: repositories.workspace(workspace.id), profiles: profiles, digit: armed ? digit : nil)
        }
        let live = rows.map { SidebarEntry.workspace(build($0, digit: digits[$0.id])) }
        return SidebarModel(
            scratch: build(scratch, digit: 0),
            rows: merge(live, exiting),
            collapsed: snapshot.sidebar.collapsed,
            width: snapshot.sidebar.width
        )
    }

    /// One Workspace row.
    public static func row(
        _ workspace: WorkspaceWire, snapshot: AppSnapshotWire, repository: WorkspaceRepositoryWire?,
        profiles: SidebarProfiles, digit: Int?
    ) -> WorkspaceRowModel {
        let identity = RowDescription.rowIdentity(
            workspaceId: workspace.id, scratchWorkspaceId: snapshot.scratchWorkspaceId,
            remote: workspace.location != .local
        )
        let selected = snapshot.selection.context == .workspace(workspace.id)
        let closing = workspace.close.isRunning
        let closeFailed: Bool = { if case .failed = workspace.close { return true } else { return false } }()
        let deletesWorktree = repository?.closingDeletesWorktree(root: workspace.root) ?? false
        let facts = RowDescription.workspaceRowFacts(workspaceInput(workspace), repository)
        let issue = repository?.issue.map { issue -> RowIssueMark in
            let lane = ProjectStatus.primaryLane(issue.projects, repository: repository?.issueRepository?.repository)
            let letter = lane.flatMap { ProjectStatus.statusLetter($0.status) }
            return RowIssueMark(
                state: issue.state, url: issue.url, label: RowDescription.issueLabel(issue),
                tooltip: RowDescription.issueMarkLines(repository, issue),
                laneLetter: letter, laneInk: letter == nil ? nil : ProjectStatus.laneColorToken(lane?.color)
            )
        }
        let pullRequest = repository?.pullRequest.map { pr in
            RowPullRequestMark(
                state: pr.state, glyph: RowDescription.pullRequestGlyph(pr.state), url: pr.url,
                label: RowDescription.describe(RowDescription.pullRequestFacts(pr)),
                tooltip: RowDescription.markLines(RowDescription.pullRequestFacts(pr)),
                conversationBadge: RowDescription.hasUnresolvedConversations(pr),
                checksBadge: RowDescription.checksBadge(pr)
            )
        }
        let unavailableProfiles = !profiles.available || profiles.names.isEmpty
        let stateInk: WorkspaceRowState
        if closeFailed {
            stateInk = .closeFailed
        } else if closing || !workspace.state.isAvailable {
            stateInk = .dimmed
        } else {
            stateInk = .available
        }
        let selectedAgent = snapshot.selection.context.agentId
        let agents = workspace.agents.enumerated().map { index, agent in
            agentRow(
                agent, workspace: workspace, glyph: identity.glyph, profiles: profiles,
                selected: selectedAgent == agent.id, isLast: index == workspace.agents.count - 1
            )
        }
        return WorkspaceRowModel(
            id: workspace.id,
            label: workspace.label,
            branch: repository?.issue == nil ? repository?.branch.map { $0 + (repository?.unborn == true ? " · empty" : "") } : nil,
            glyph: identity.glyph,
            fixed: identity.fixed,
            selected: selected,
            closing: closing,
            state: stateInk,
            terminals: workspace.terminals,
            unread: workspace.terminals.map { $0.status == .idle && $0.unread != nil } ?? false,
            digit: digit,
            repositoryUrl: repository?.repositoryUrl,
            issue: issue,
            pendingIssue: repository?.pending?.number,
            unavailable: repository?.unavailable.map(RowDescription.unavailableText),
            // Terminal mode has no workbench to put in a container: the folder is
            // the local folder it is, and the row says nothing about a container.
            editorFact: nil,
            pullRequest: pullRequest,
            canCreateAgent: workspace.canCreateAgent && !closing,
            createAgentEnabled: !unavailableProfiles,
            createAgentTooltip: profiles.names.isEmpty ? "No enabled agent profiles" : "Create agent",
            createAgentLabel: "Create agent in \(workspace.label)\(unavailableProfiles ? ", unavailable" : "")",
            deletesWorktree: deletesWorktree,
            closeTooltip: closing || identity.fixed ? nil : closeFailed ? "Retry close" : deletesWorktree ? "Close worktree…" : "Close workspace",
            closeLabel: deletesWorktree ? "Close the worktree \(workspace.label)" : "Close \(workspace.label)",
            description: RowDescription.describe(facts),
            tooltip: RowDescription.tooltipLines(facts),
            agents: agents
        )
    }

    static func status(_ status: AgentStatus) -> ConversationAgentStatus {
        ConversationAgentStatus(rawValue: status.rawValue) ?? .unknown
    }

    static func workspaceInput(_ workspace: WorkspaceWire) -> WorkspaceRowInput {
        let terminals: WorkspaceTerminalsFact? = workspace.terminals.map { $0.status == .working ? .working : .finished }
        let host: String? = { if case let .ssh(host) = workspace.location { return host } else { return nil } }()
        return WorkspaceRowInput(
            label: workspace.label, displayRoot: workspace.displayRoot,
            closeFailure: SurfaceLabels.closeFailure(workspace.close), terminals: terminals, sshHost: host,
            editor: workspace.editor
        )
    }

    static func agentInput(_ agent: AgentWire) -> AgentRowInput {
        AgentRowInput(
            displayName: agent.displayName, status: status(agent.status), unread: agent.unread.map(status),
            activity: agent.activity, note: SurfaceLabels.agentNote(agent)
        )
    }

    /// One Agent row.
    static func agentRow(
        _ agent: AgentWire, workspace: WorkspaceWire, glyph: RowGlyph, profiles: SidebarProfiles, selected: Bool, isLast: Bool
    ) -> AgentRowModel {
        let input = agentInput(agent)
        let showsUnread = RowDescription.unreadShows(input.status, input.unread)
        // The bare kind word ("Claude") is dropped; an ordinal or a given name
        // is what tells two Agents apart, and is kept.
        let profileName = profiles.names[agent.profileId]
        let naming = agent.activity != nil && agent.displayName != profileName ? agent.displayName : nil
        let label = RowDescription.statusLabel(input.status)
        return AgentRowModel(
            id: agent.id, workspaceId: workspace.id, selected: selected, status: agent.status, unread: agent.unread,
            showsUnread: showsUnread, leading: agent.activity ?? agent.displayName, naming: naming,
            note: input.note, stopping: agent.controlState == .stopping,
            stopFailed: agent.controlState.canRetryStop, isLast: isLast,
            description: RowDescription.agentRowDescription(input, owner: (workspace.label, glyph)),
            tooltip: RowDescription.tooltipLines(RowDescription.agentTooltipFacts(input)),
            promptCache: agent.promptCache,
            statusLabel: showsUnread ? "\(label), unread" : label
        )
    }

    /// `StatusMark`'s label for a Workspace's terminals: "Terminal: Working".
    public static func terminalStatusLabel(_ activity: TerminalActivity) -> String {
        let label = RowDescription.statusLabel(status(activity.status))
        return activity.unread != nil && activity.status == .idle ? "Terminal: \(label), unread" : "Terminal: \(label)"
    }

    /// The tooltip an Agent row draws now: its facts, and its prompt cache's
    /// countdown composed at this moment.
    public static func agentTooltip(_ row: AgentRowModel, now: Double) -> [TooltipLine] {
        row.tooltip + RowDescription.tooltipLines(PromptCacheFacts.facts(row.promptCache, now: now))
    }

    // MARK: - Closing rows

    /// `rowsThatLeft`: which rows have just gone, given the list as it was
    /// (id, label, closing) and the list as it is now. Only a row that was
    /// closing when it vanished gets a ghost.
    public static func rowsThatLeft(_ before: [(id: String, label: String, closing: Bool)], _ after: [WorkspaceWire]) -> [ExitingRow] {
        let present = Set(after.map(\.id))
        return before.enumerated().compactMap { index, row in
            row.closing && !present.contains(row.id) ? ExitingRow(id: row.id, label: row.label, index: index) : nil
        }
    }

    /// `mergeExitingRows`: the live rows with the ghosts put back at the index
    /// they held, clamped.
    public static func merge(_ live: [SidebarEntry], _ exiting: [ExitingRow]) -> [SidebarEntry] {
        var entries = live
        for row in exiting.sorted(by: { $0.index < $1.index }) {
            entries.insert(.exiting(row), at: min(row.index, entries.count))
        }
        return entries
    }

    // MARK: - The tree the keyboard walks

    /// One stop of the arrow-key walk (`[data-tree-item-id]:not([disabled])`).
    public struct TreeItem: Equatable, Sendable {
        /// `workspace:<id>` or `agent:<id>`.
        public var id: String
        /// The Workspace row an Agent is under; nil for a Workspace.
        public var parent: String?
        public var context: ContextWire
    }

    /// Every row the keyboard can stand on, in order: a closing Workspace and
    /// a stopping Agent are not stops.
    public static func treeItems(_ model: SidebarModel) -> [TreeItem] {
        var items: [TreeItem] = []
        func add(_ row: WorkspaceRowModel) {
            let id = "workspace:\(row.id)"
            if !row.closing { items.append(TreeItem(id: id, parent: nil, context: .workspace(row.id))) }
            for agent in row.agents where !agent.stopping {
                items.append(TreeItem(id: "agent:\(agent.id)", parent: id, context: .agent(agent.id)))
            }
        }
        add(model.scratch)
        for entry in model.rows { if case let .workspace(row) = entry { add(row) } }
        return items
    }

    /// The stop the tree's arrow keys reach from `current` (`↑ ↓ ← → Home End`).
    public static func walk(_ items: [TreeItem], from current: String?, key: String) -> String? {
        guard !items.isEmpty else { return nil }
        let index = current.flatMap { id in items.firstIndex { $0.id == id } }
        switch key {
        case "arrowdown", "arrowup":
            guard let index else { return items[0].id }
            let delta = key == "arrowdown" ? 1 : -1
            return items[(index + delta + items.count) % items.count].id
        case "home": return items.first?.id
        case "end": return items.last?.id
        case "arrowright":
            guard let index else { return nil }
            let item = items[index]
            if item.parent != nil { return nil }
            return items.first { $0.parent == item.id }?.id
        case "arrowleft":
            guard let index else { return nil }
            return items[index].parent.flatMap { parent in items.first { $0.id == parent }?.id }
        default:
            return nil
        }
    }

    /// The row the tree's tab stop rests on: the one asked for if it is still
    /// there, else the selected row, else the first.
    public static func tabStop(_ items: [TreeItem], requested: String?, selection: ContextWire) -> String? {
        if let requested, items.contains(where: { $0.id == requested }) { return requested }
        return items.first { $0.context == selection }?.id ?? items.first?.id
    }

    // MARK: - Dragging a row (reorder.ts)

    /// What is being dragged.
    public enum DragSource: Equatable, Sendable {
        case workspace(String)
        case agent(String, workspaceId: String)

        public var id: String {
            switch self {
            case let .workspace(id), let .agent(id, _): return id
            }
        }
    }

    /// Which half of a row a pointer is over.
    public enum Half: Sendable { case top, bottom }

    /// A gap the pointer means: in front of a row, the end of the range, or
    /// a row that is not a place to drop.
    public enum Gap: Equatable, Sendable {
        case before(String)
        case end
        case none
    }

    static func agents(_ snapshot: AppSnapshotWire, _ workspaceId: String) -> [String] {
        snapshot.workspace(workspaceId)?.agents.map(\.id) ?? []
    }

    /// `dropLane`: the rows this one may be dropped among, itself included.
    public static func dropLane(_ snapshot: AppSnapshotWire, _ source: DragSource) throws -> [String] {
        switch source {
        case let .agent(_, workspaceId): return agents(snapshot, workspaceId)
        case let .workspace(id):
            return WorkspaceOrder.siblings(try snapshot.sidebarWorkspaces().rows, mainWorktreeOf: { $0.groupKey }, workspaceId: id).map(\.id)
        }
    }

    /// `gapUnder`: the top half of a row is the gap in front of it, the bottom
    /// half the gap in front of the next one — or the end of the range.
    public static func gap(_ lane: [String], rowId: String, half: Half) -> Gap {
        guard let at = lane.firstIndex(of: rowId) else { return .none }
        if half == .top { return .before(rowId) }
        return at + 1 < lane.count ? .before(lane[at + 1]) : .end
    }

    /// `dropIntent`: the intent a drop comes to, or nothing for a row let go
    /// in the gap it was already in.
    public static func dropIntent(_ snapshot: AppSnapshotWire, _ source: DragSource, before: String?) throws -> AppIntentWire? {
        switch source {
        case let .agent(id, workspaceId):
            return WorkspaceOrder.placeAgent(agents(snapshot, workspaceId), agentId: id, before: before)
                .map { .reorderAgents(workspaceId: workspaceId, order: $0) }
        case let .workspace(id):
            return WorkspaceOrder.place(try snapshot.sidebarWorkspaces().rows, mainWorktreeOf: { $0.groupKey }, workspaceId: id, before: before)
                .map { .reorderWorkspaces($0) }
        }
    }

    /// `sourceOfTreeItem`.
    public static func source(ofTreeItem id: String, _ snapshot: AppSnapshotWire) -> DragSource? {
        guard let colon = id.firstIndex(of: ":") else { return nil }
        let kind = id[..<colon]
        let rest = String(id[id.index(after: colon)...])
        if kind == "workspace" { return .workspace(rest) }
        guard kind == "agent", let owner = snapshot.workspaces.first(where: { $0.agents.contains { $0.id == rest } }) else { return nil }
        return .agent(rest, workspaceId: owner.id)
    }

    /// `moveIntent`: one step up or down, as the intent it comes to; nothing at
    /// the ends of the range (a no-op, not a wrap).
    public static func moveIntent(_ snapshot: AppSnapshotWire, _ source: DragSource, _ direction: MoveDirection) throws -> AppIntentWire? {
        switch source {
        case let .agent(id, workspaceId):
            return WorkspaceOrder.moveAgent(agents(snapshot, workspaceId), agentId: id, direction: direction)
                .map { .reorderAgents(workspaceId: workspaceId, order: $0) }
        case let .workspace(id):
            return WorkspaceOrder.move(try snapshot.sidebarWorkspaces().rows, mainWorktreeOf: { $0.groupKey }, workspaceId: id, direction: direction)
                .map { .reorderWorkspaces($0) }
        }
    }

    // MARK: - The row menus (rowMenu.ts)

    /// What a menu item does, for the view to carry out.
    public enum MenuAction: Equatable, Sendable {
        case rename(agentId: String)
        case intent(AppIntentWire)
        case continueAgent(agentId: String)
        case closeWorkspace(workspaceId: String)
    }

    public struct MenuItem: Equatable, Sendable {
        public var id: String
        public var label: String
        /// Stands apart from what is above: the destructive items, last.
        public var separated: Bool
        public var action: MenuAction
    }

    /// What a right-click on a Workspace offers: in terminal mode, the close
    /// alone — on every Workspace but Scratch. Empty for Scratch.
    public static func workspaceMenu(_ row: WorkspaceRowModel) -> [MenuItem] {
        if row.fixed || row.closing { return [] }
        return [MenuItem(
            id: "close-workspace", label: row.deletesWorktree ? "Close Worktree…" : "Close Workspace…",
            separated: true, action: .closeWorkspace(workspaceId: row.id)
        )]
    }

    /// What a right-click on an Agent offers.
    public static func agentMenu(_ agent: AgentWire) -> [MenuItem] {
        var items = [MenuItem(id: "rename", label: "Rename…", separated: false, action: .rename(agentId: agent.id))]
        if agent.unread == nil {
            items.append(MenuItem(id: "unread", label: "Mark as Unread", separated: false, action: .intent(.markAgentUnread(agentId: agent.id))))
        }
        if agent.controlState == .running,
           AgentRules.restart(displayName: agent.displayName, presentation: agent.presentation, profileKind: agent.profileKind, failure: agent.failure) == .available
        {
            items.append(MenuItem(id: "restart", label: "Restart Session", separated: false, action: .intent(.restartAgent(agentId: agent.id))))
        }
        if let continuation = AgentRules.continuation(
            presentation: agent.presentation, profileKind: agent.profileKind, controlState: agent.controlState, failure: agent.failure
        ) {
            items.append(MenuItem(
                id: "continue", label: continuation == .tui ? "Continue in Terminal" : "Continue in GUI", separated: false,
                action: .continueAgent(agentId: agent.id)
            ))
        }
        if agent.controlState != .stopping {
            let failed = agent.controlState.canRetryStop
            items.append(MenuItem(
                id: "stop", label: failed ? "Retry Stop" : "Stop Agent", separated: true,
                action: .intent(failed ? .retryStopAgent(agentId: agent.id) : .stopAgent(agentId: agent.id))
            ))
        }
        return items
    }
}
