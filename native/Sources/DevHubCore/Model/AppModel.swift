// Port of apps/desktop/src/model/appModel.ts (with `tabOrder` / `tabPosition`
// from apps/desktop/src/ipc/appShell.ts)
//
// The revision-numbered application model and its immutable projection.
//
// A port of `crates/devhub-app-core/src/snapshot.rs`. `AppModel` owns the
// Workspaces, their Agents, the selection and the sidebar; `snapshot()` is the
// only way anything else reads them. Every mutation that changes anything
// bumps the revision, which is what lets the UI drop a projection it has
// already seen.
//
// A value type: every mutation is `mutating`, and a copy is the TS `clone()`.

import Foundation

/// What the Sidebar calls Scratch (`SCRATCH_NAME`, ipc/windowTitles.ts).
public let scratchName = "Scratch"

/// The selection: what is selected, and how it is being shown.
public struct NavigationSelection: Hashable, Sendable {
    public var context: NavigationContext
    public var presentation: SurfacePresentation

    public init(context: NavigationContext, presentation: SurfacePresentation = .full) {
        self.context = context
        self.presentation = presentation
    }
}

/// Which pane has the keyboard, when it is not the selection's own.
public enum PaneFocusTarget: Hashable, Sendable {
    case content
    case terminal(terminalId: String)
}

public struct SidebarSnapshot: Hashable, Sendable {
    public var width: Double
    /// Shown as its icon rail. The width is what it goes back to.
    public var collapsed: Bool
}

public struct AgentSnapshot: Equatable, Sendable {
    public var id: AgentId
    public var workspaceId: WorkspaceId
    public var profile: AgentProfile
    /// How it was launched to be shown.
    public var presentation: AgentPresentation
    public var profileId: String { profile.id }
    public var profileKind: AgentProfileKind { profile.kind }
    public var profileDisplayName: String { profile.displayName }
    /// The shortest name that tells it apart from its siblings.
    public var displayName: String
    public var ordinal: Int
    public var status: AgentStatus
    public var runtimeHealth: AgentRuntimeHealth
    public var controlState: AgentControlState
    public var unread: UnreadReason?
    public var activity: String?
    public var promptCache: PromptCache?
    public var injection: AgentInjection
    public var automaticActions: [String]
    public var failure: AgentFailure?
    /// Its own terminal, while its session is up — shown or hidden.
    public var terminal: AgentTerminal?
    /// The terminal pane's share of the content area's width, when shown.
    public var terminalShare: Double
    /// Its share of the split's right half's height, when shown under it.
    public var terminalStackedShare: Double
}

public struct WorkspaceSnapshot: Equatable, Sendable {
    public var id: WorkspaceId
    public var label: String
    public var location: WorkspaceLocation
    public var root: String { location.path }
    public var selectedPath: String
    public var key: String { location.key }
    public var editor: EditorAttachment
    public var startedContainer: String?
    public var repositoryId: RepositoryId?
    public var state: WorkspaceState
    public var close: WorkspaceClose
    public var agents: [AgentSnapshot]
    public var canCreateAgent: Bool
    /// The Agent last selected here, if it is still running.
    public var lastAgentId: AgentId?
    /// What its own terminals are doing.
    public var terminals: TerminalActivity
}

extension WorkspaceSnapshot: OrderableWorkspace {
    public var orderId: String { id.rawValue }
    public var orderLabel: String { label }
    public var orderKey: String { key }
}

/// Whether the app has an editor host to draw against.
public enum EditorHostState: Hashable, Sendable {
    case starting
    case ready
    case failed(summary: String, detail: String?)
}

public struct HistoryAvailability: Hashable, Sendable {
    public var canGoBack: Bool
    public var canGoForward: Bool
}

public struct AppSnapshot: Equatable, Sendable {
    public static let schemaVersion = 1

    public var schemaVersion: Int
    public var revision: Int
    public var selection: NavigationSelection
    /// The Workspace that is Scratch: today's daily folder. Always one of
    /// `workspaces`.
    public var scratchWorkspaceId: WorkspaceId
    /// What the content area holds for that selection.
    public var layout: SurfaceLayout
    public var workspaces: [WorkspaceSnapshot]
    public var sidebar: SidebarSnapshot
    /// The order the person put the top-level rows in, if they have.
    public var workspaceOrder: [WorkspaceId]
    /// Where the divider sits when the layout is a split.
    public var splitRatio: Double
    /// The Agent terminal on screen, if one is.
    public var visibleTerminal: AgentTerminal?
    /// The terminal pane's id when it has the keyboard.
    public var paneFocus: String?
    /// How far the Agent panes' text has been zoomed from the setting.
    public var terminalZoomOffset: Int
    public var smartButtons: SmartButtonsPlacement
    public var editorHost: EditorHostState
    /// Whether Back and Forward would go anywhere.
    public var history: HistoryAvailability

    public func workspace(_ id: WorkspaceId) -> WorkspaceSnapshot? { workspaces.first { $0.id == id } }
}

/// What a rolled-back close has to put back, exactly where it was.
public struct WorkspaceCloseRollback: Equatable, Sendable {
    public var workspace: Workspace
    public var index: Int
    public var selectionBefore: NavigationSelection
    public var selectionAfter: NavigationSelection
}

/// The Agent a workspace is paired with: the one it was last in, else its
/// first. The one answer to "this workspace's other half".
public func pairedAgentId<Id>(lastAgentId: Id?, agentIds: [Id]) -> Id? {
    lastAgentId ?? agentIds.first
}

// MARK: - The tab order (ipc/appShell.ts)

public enum TabOrder {
    /// `tabOrder`: every row of the tree, each Workspace followed by its Agents.
    public static func of(_ workspaces: [(id: WorkspaceId, agents: [AgentId])]) -> [NavigationContext] {
        workspaces.flatMap { workspace in
            [NavigationContext.workspace(workspace.id)] + workspace.agents.map { NavigationContext.agent($0) }
        }
    }

    /// `tabPosition`: a tab that is not in the list is a caller reading a list
    /// that no longer exists, and it throws.
    public static func position(_ tabs: [NavigationContext], _ tab: NavigationContext) throws -> Int {
        guard let at = tabs.firstIndex(of: tab) else {
            throw InvariantViolation("\(tab) is not a row of the tab order")
        }
        return at
    }
}

public struct AppModel: Sendable {
    public static let sidebarMinWidth: Double = 200
    public static let sidebarMaxWidth: Double = 400
    public static let sidebarDefaultWidth: Double = 248
    /// How much of the content area the editor takes when split.
    public static let splitMinRatio = 0.25
    public static let splitMaxRatio = 0.85
    public static let splitDefaultRatio = 0.55
    static let maxSafeInteger = 9_007_199_254_740_991

    private var workspaceList: [Workspace] = []
    private var repositoryMap: [RepositoryId: Repository] = [:]
    private var repositoryOrder: [RepositoryId] = []
    private var nextAgentOrdinals: [String: Int] = [:]
    public private(set) var scratchWorkspaceId: WorkspaceId
    public private(set) var selection: NavigationSelection
    public private(set) var sidebarWidth: Double = AppModel.sidebarDefaultWidth
    /// Whether the Sidebar is shown as its icon rail.
    public private(set) var sidebarCollapsed = false
    /// The order the person put the top-level rows in.
    public private(set) var workspaceOrder: [WorkspaceId] = []
    /// Whether the DevHub window has the person in front of it.
    public private(set) var windowFocused = true
    /// The Agent last selected in each workspace.
    private var lastAgentByWorkspace: [WorkspaceId: AgentId] = [:]
    /// Where `toggle_scratch` jumped out of, whole. In memory only.
    private var scratchReturn: NavigationSelection?
    /// Each Agent's own terminal, while its session is up.
    private var agentTerminalsValue: [AgentId: AgentTerminal] = [:]
    private var agentTerminalOrder: [AgentId] = []
    private var terminalShares: [AgentId: Double] = [:]
    private var terminalStackedShares: [AgentId: Double] = [:]
    /// The keyboard is in the terminal pane on screen.
    private var terminalFocus = false
    public private(set) var splitRatio = AppModel.splitDefaultRatio
    public private(set) var terminalZoomOffset = 0
    public private(set) var smartButtons = SmartButtonsPlacement()
    public private(set) var editorHostState: EditorHostState = .starting
    public private(set) var revision = 0
    /// Every selection this window has shown, for Back and Forward.
    private var history: NavigationHistory<NavigationSelection>

    public init(scratch: Workspace) {
        workspaceList = [scratch]
        scratchWorkspaceId = scratch.id
        selection = NavigationSelection(context: .workspace(scratch.id), presentation: .full)
        history = NavigationHistory(selection, same: { $0 == $1 })
    }

    // MARK: Reading

    public var workspaces: [Workspace] { workspaceList }

    public func workspace(_ id: WorkspaceId) -> Workspace? { workspaceList.first { $0.id == id } }

    public func workspaceForAgent(_ id: AgentId) -> Workspace? { workspaceList.first { $0.agent(id) != nil } }

    public func agent(_ id: AgentId) -> Agent? {
        for workspace in workspaceList {
            if let agent = workspace.agent(id) { return agent }
        }
        return nil
    }

    public func repository(_ id: RepositoryId) -> Repository? { repositoryMap[id] }

    public func snapshot() -> AppSnapshot {
        AppSnapshot(
            schemaVersion: AppSnapshot.schemaVersion,
            revision: revision,
            selection: selection,
            scratchWorkspaceId: scratchWorkspaceId,
            layout: resolveLayout(selection),
            workspaces: workspaceSnapshots(),
            sidebar: SidebarSnapshot(width: sidebarWidth, collapsed: sidebarCollapsed),
            workspaceOrder: workspaceOrder,
            splitRatio: splitRatio,
            visibleTerminal: visibleTerminal(),
            paneFocus: paneFocus,
            terminalZoomOffset: terminalZoomOffset,
            smartButtons: smartButtons,
            editorHost: editorHostState,
            history: HistoryAvailability(canGoBack: canNavigate(.back), canGoForward: canNavigate(.forward))
        )
    }

    /// Whether Back (or Forward) would select anything.
    public func canNavigate(_ direction: NavigationDirection) -> Bool {
        history.can(direction) { contextExists($0.context) }
    }

    /// For tests and for reading: the history's entries and cursor.
    public var historyEntries: (list: [NavigationSelection], position: Int) { (history.list, history.position) }

    // MARK: Scratch and history

    /// Today's daily folder becomes Scratch. If a Workspace for that folder is
    /// already open it is the one that becomes Scratch and `day` is dropped;
    /// otherwise `day` is added.
    @discardableResult
    public mutating func adoptScratchDay(_ day: Workspace) throws -> Bool {
        let existing = workspaceList.first { $0.key == day.key }
        if existing == nil { try addWorkspace(day) }
        let id = existing?.id ?? day.id
        if id == scratchWorkspaceId { return false }
        scratchWorkspaceId = id
        bumpRevision()
        return true
    }

    /// Back or Forward: select the nearest earlier (or later) place that still
    /// exists, and answer whether there was one.
    @discardableResult
    public mutating func navigateHistory(_ direction: NavigationDirection) throws -> Bool {
        let model = self
        guard let target = history.go(direction, exists: { model.contextExists($0.context) }) else { return false }
        // A `beside` with no pair any more is shown `full`, corrected *before*
        // the selection moves.
        let presentation = canPresentBeside(target.context) ? target.presentation : .full
        history.visit(NavigationSelection(context: target.context, presentation: presentation), replace: true)
        try selectContext(target.context, presentation: presentation)
        // The arrows' enabled state moved even when the selection did not.
        bumpRevision()
        return true
    }

    /// Start the history again from the selection as it is now.
    public mutating func resetHistory() { history.reset(selection) }

    @discardableResult
    public mutating func setEditorHostState(_ state: EditorHostState) -> Bool {
        if editorHostState == state { return false }
        editorHostState = state
        return true
    }

    /// The Agent last selected in this workspace, if it is still running.
    public func lastAgentIn(_ workspaceId: WorkspaceId) -> AgentId? {
        guard let remembered = lastAgentByWorkspace[workspaceId] else { return nil }
        return workspace(workspaceId)?.agent(remembered) != nil ? remembered : nil
    }

    /// Put back the Agent a workspace was last in, from the state file.
    public mutating func restoreLastAgent(_ workspaceId: WorkspaceId, _ agentId: AgentId) {
        lastAgentByWorkspace[workspaceId] = agentId
    }

    // MARK: Sidebar, order, split, zoom, Smart Buttons

    @discardableResult
    public mutating func restoreSidebar(width: Double, collapsed: Bool) throws -> Bool {
        if width < Self.sidebarMinWidth || width > Self.sidebarMaxWidth { throw domainFail(.invalidSidebarWidth) }
        if sidebarWidth == width && sidebarCollapsed == collapsed { return false }
        sidebarWidth = width
        sidebarCollapsed = collapsed
        bumpRevision()
        return true
    }

    /// Write down where the rows go: the whole list, always.
    @discardableResult
    public mutating func setWorkspaceOrder(_ order: [WorkspaceId]) -> Bool {
        if workspaceOrder == order { return false }
        workspaceOrder = order
        bumpRevision()
        return true
    }

    @discardableResult
    public mutating func restoreWorkspaceOrder(_ order: [WorkspaceId]) -> Bool { setWorkspaceOrder(order) }

    /// Attach a Workspace's editor somewhere else.
    @discardableResult
    public mutating func attachEditor(_ workspaceId: WorkspaceId, _ editor: EditorAttachment) throws -> Bool {
        guard let changed = withWorkspace(workspaceId, { $0.attachEditor(editor) }) else { throw domainFail(.unknownWorkspace) }
        if !changed { return false }
        bumpRevision()
        return true
    }

    @discardableResult
    public mutating func noteEditorContainerStarted(_ workspaceId: WorkspaceId, _ containerId: String) throws -> Bool {
        guard let changed = try withWorkspace(workspaceId, { try $0.noteStartedContainer(containerId) }) else {
            throw domainFail(.unknownWorkspace)
        }
        if !changed { return false }
        bumpRevision()
        return true
    }

    /// Put a workspace's Agents in the order a person arranged them.
    @discardableResult
    public mutating func setAgentOrder(_ workspaceId: WorkspaceId, _ order: [AgentId]) throws -> Bool {
        guard let workspace = workspace(workspaceId) else { throw domainFail(.unknownWorkspace) }
        if workspace.agents.map(\.id) == order { return false }
        try withWorkspace(workspaceId) { try $0.reorderAgents(order) }
        bumpRevision()
        return true
    }

    /// The rail, or the width back.
    @discardableResult
    public mutating func toggleSidebar() -> Bool {
        sidebarCollapsed.toggle()
        bumpRevision()
        return true
    }

    @discardableResult
    public mutating func setSidebarWidth(_ width: Double) throws -> Bool {
        if width < Self.sidebarMinWidth || width > Self.sidebarMaxWidth { throw domainFail(.invalidSidebarWidth) }
        if sidebarWidth == width { return false }
        sidebarWidth = width
        bumpRevision()
        return true
    }

    /// Move the divider. Out-of-range is a bug in the caller.
    @discardableResult
    public mutating func setSplitRatio(_ ratio: Double) throws -> Bool {
        if !(ratio >= Self.splitMinRatio && ratio <= Self.splitMaxRatio) { throw domainFail(.invalidSplitRatio) }
        if splitRatio == ratio { return false }
        splitRatio = ratio
        bumpRevision()
        return true
    }

    @discardableResult
    public mutating func restoreSplitRatio(_ ratio: Double) throws -> Bool { try setSplitRatio(ratio) }

    /// Put one presentation's Smart Buttons where they were dragged, or back in
    /// their default spot (`spot` nil).
    @discardableResult
    public mutating func placeSmartButtons(_ presentation: AgentPresentation, _ spot: SmartButtonsSpot?) throws -> Bool {
        if let spot, !SmartButtons.isSpot(spot) { throw domainFail(.invalidSmartButtonsOffset) }
        if smartButtons[presentation] == spot { return false }
        smartButtons[presentation] = spot
        bumpRevision()
        return true
    }

    public mutating func restoreSmartButtons(_ placement: SmartButtonsPlacement) throws {
        for presentation in AgentPresentation.allCases {
            try placeSmartButtons(presentation, placement[presentation])
        }
    }

    /// Zoom the Agent panes one step, or forget the zoom. `base` is the size
    /// `settings.toml` names.
    @discardableResult
    public mutating func zoomTerminal(base: Double, direction: TerminalZoom.Direction) throws -> Bool {
        try setTerminalZoomOffset(TerminalZoom.nextOffset(base: base, offset: terminalZoomOffset, direction: direction))
    }

    private mutating func setTerminalZoomOffset(_ offset: Int) throws -> Bool {
        guard TerminalZoom.isOffset(offset) else { throw domainFail(.invalidTerminalZoom) }
        if terminalZoomOffset == offset { return false }
        terminalZoomOffset = offset
        bumpRevision()
        return true
    }

    @discardableResult
    public mutating func restoreTerminalZoom(_ offset: Int) throws -> Bool { try setTerminalZoomOffset(offset) }

    // MARK: Repositories and workspaces

    public mutating func registerRepository(_ repository: Repository) throws {
        if let existing = repositoryMap[repository.id] {
            if existing == repository { return }
            throw domainFail(.repositoryIdentityConflict)
        }
        for id in repositoryOrder {
            let candidate = repositoryMap[id]!
            if repository.aliases.contains(where: { candidate.matchesRemote($0) }) {
                throw domainFail(.repositoryRemoteConflict)
            }
        }
        repositoryMap[repository.id] = repository
        repositoryOrder.append(repository.id)
    }

    public mutating func addWorkspace(_ workspace: Workspace) throws {
        if self.workspace(workspace.id) != nil { throw domainFail(.duplicateWorkspace) }
        if workspaceList.contains(where: { $0.key == workspace.key }) { throw domainFail(.duplicateWorkspaceRoot) }
        if let repository = workspace.repositoryId, repositoryMap[repository] == nil { throw domainFail(.unknownRepository) }
        workspaceList.append(workspace)
        bumpRevision()
    }

    public mutating func associateRepository(_ id: WorkspaceId, _ repository: RepositoryId?) throws {
        if let repository, repositoryMap[repository] == nil { throw domainFail(.unknownRepository) }
        guard let changed = withWorkspace(id, { $0.setRepositoryId(repository) }) else { throw domainFail(.unknownWorkspace) }
        if changed { bumpRevision() }
    }

    // MARK: Agents

    /// Add an Agent and select it, shown the way the person asked for.
    public mutating func addAgent(
        owner: WorkspaceId, id: AgentId, profile: AgentProfile, agentPresentation: AgentPresentation,
        presentation: SurfacePresentation = .full
    ) throws {
        if agent(id) != nil { throw domainFail(.duplicateAgent) }
        let key = Self.ordinalKey(owner, profile.id)
        let ordinal = nextAgentOrdinals[key] ?? 1
        if ordinal == Self.maxSafeInteger { throw domainFail(.ordinalExhausted) }
        guard workspace(owner) != nil else { throw domainFail(.unknownWorkspace) }
        let created = try Agent.create(id: id, owner: owner, profile: profile, ordinal: ordinal, presentation: agentPresentation)
        try withWorkspace(owner) { try $0.addAgent(created) }
        nextAgentOrdinals[key] = ordinal + 1
        selection = NavigationSelection(context: .agent(id), presentation: presentation)
        bumpRevision()
    }

    public mutating func restoreAgent(_ record: AgentRestoreRecord) throws {
        guard workspace(record.workspaceId) != nil else { throw domainFail(.unknownWorkspace) }
        if agent(record.id) != nil { throw domainFail(.duplicateAgent) }
        let restored = try Agent.restore(record)
        if restored.workspaceId != record.workspaceId { throw domainFail(.agentWorkspaceMismatch) }
        if restored.ordinal == Self.maxSafeInteger { throw domainFail(.ordinalExhausted) }
        let key = Self.ordinalKey(record.workspaceId, restored.profile.id)
        try withWorkspace(record.workspaceId) { try $0.restoreAgent(restored) }
        let next = restored.ordinal + 1
        nextAgentOrdinals[key] = max(nextAgentOrdinals[key] ?? next, next)
        bumpRevision()
    }

    /// Tick or untick an action as automatic for an Agent.
    public mutating func setAgentAutomaticAction(_ id: AgentId, actionId: String, automatic: Bool) throws {
        if try requireAgent(id, { $0.setAutomaticAction(actionId, automatic: automatic) }) { bumpRevision() }
    }

    public mutating func renameAgent(_ id: AgentId, _ displayName: String) throws {
        if try requireAgent(id, { try $0.rename(displayName) }) { bumpRevision() }
    }

    public mutating func resetAgentName(_ id: AgentId) throws {
        if try requireAgent(id, { $0.resetName() }) { bumpRevision() }
    }

    /// Whether a status change is one the person would want to be told about.
    /// **One predicate, and this is it.** An Agent that was moving on its own
    /// coming to a stop that is the person's turn.
    public static func wantsAttention(previous: AgentStatus, next: AgentStatus) -> Bool {
        (previous == .working || previous == .background) && (next == .idle || next == .waiting || next == .error)
    }

    /// Set an Agent's status, and raise its unread mark if it wanted you.
    public mutating func setAgentStatus(_ id: AgentId, _ status: AgentStatus, failure: AgentFailure? = nil) throws {
        guard let current = agent(id) else { throw domainFail(.unknownAgent) }
        let attention = Self.wantsAttention(previous: current.status, next: status)
        let visible = isAgentVisible(id)
        let changed = try requireAgent(id) { agent -> Bool in
            // Reading the Agent is what retires its last refusal, and the only
            // thing that does. A reading that itself says the Agent is failing
            // puts that failure in its place instead.
            var changed = failure == nil ? agent.clearFailure() : agent.fail(failure!)
            if agent.setStatus(status) { changed = true }
            if attention && !visible && agent.setUnread(status) { changed = true }
            return changed
        }
        if changed { bumpRevision() }
    }

    /// Put an Agent back in the unread pile by hand.
    public mutating func markAgentUnread(_ id: AgentId) throws {
        if try requireAgent(id, { $0.setUnread($0.status) }) { bumpRevision() }
    }

    /// Whether the person can see this Agent right now. **One predicate.**
    public func isAgentVisible(_ id: AgentId) -> Bool { visibleAgentId() == id }

    private func visibleAgentId() -> AgentId? {
        guard windowFocused else { return nil }
        switch resolveLayout(selection) {
        case let .agent(.agent(id)), let .split(_, .agent(id)): return id
        default: return nil
        }
    }

    /// Tell the model whether DevHub is the window in front.
    public mutating func setWindowFocused(_ focused: Bool) {
        if windowFocused == focused { return }
        windowFocused = focused
        _ = readVisibleAgent()
        _ = readVisibleTerminals()
        bumpRevision()
    }

    /// Clear the unread mark on whatever is being looked at.
    private mutating func readVisibleAgent() -> Bool {
        guard let visible = visibleAgentId() else { return false }
        return withAgent(visible) { $0.setUnread(nil) } ?? false
    }

    /// Whether the person can see this Workspace's editor area right now.
    public func isWorkspaceVisible(_ id: WorkspaceId) -> Bool {
        guard windowFocused else { return false }
        switch resolveLayout(selection) {
        case let .workbench(.workspaceEditor(editor)), let .split(.workspaceEditor(editor), _): return editor == id
        default: return false
        }
    }

    /// One round's reading of the terminals on one machine.
    public mutating func observeTerminalActivity(_ observations: [WorkspaceTerminalObservation]) {
        var changed = false
        for observation in observations {
            guard let index = workspaceList.firstIndex(where: { $0.id.rawValue == observation.workspaceId }) else { continue }
            let visible = isWorkspaceVisible(workspaceList[index].id)
            if workspaceList[index].terminals.observe(observation.panes, workspaceVisible: visible) { changed = true }
        }
        if changed { bumpRevision() }
    }

    private mutating func readVisibleTerminals() -> Bool {
        var changed = false
        for index in workspaceList.indices where isWorkspaceVisible(workspaceList[index].id) {
            if workspaceList[index].terminals.read() { changed = true }
        }
        return changed
    }

    public mutating func setAgentInjection(_ id: AgentId, _ injection: AgentInjection) throws {
        if try requireAgent(id, { $0.setInjection(injection) }) { bumpRevision() }
    }

    /// What the Agent says it is doing, as of the round that read its pane.
    public mutating func setAgentActivity(_ id: AgentId, _ activity: String?) throws {
        if try requireAgent(id, { $0.setActivity(activity) }) { bumpRevision() }
    }

    public mutating func setAgentRuntimeHealth(_ id: AgentId, _ health: AgentRuntimeHealth) throws {
        if try requireAgent(id, { $0.setRuntimeHealth(health) }) { bumpRevision() }
    }

    public mutating func reconcileAgents(_ reconciliation: AgentReconciliation) throws {
        for observation in reconciliation.observations where agent(observation.agentId) == nil {
            throw domainFail(.unknownAgent)
        }
        let exited = Set(reconciliation.exited)
        for id in exited where agent(id) == nil { throw domainFail(.unknownAgent) }
        for observation in reconciliation.observations where !exited.contains(observation.agentId) {
            try setAgentStatus(observation.agentId, observation.status, failure: observation.failure)
            try setAgentActivity(observation.agentId, observation.activity)
            if try requireAgent(observation.agentId, { $0.setPromptCache(observation.promptCache) }) { bumpRevision() }
            try setAgentInjection(observation.agentId, observation.injection)
            try setAgentRuntimeHealth(observation.agentId, observation.runtimeHealth)
        }
        for id in exited.sorted() { try agentExited(id) }
    }

    public mutating func requestAgentStop(_ id: AgentId) throws {
        if try requireAgent(id, { $0.requestStop() }) { bumpRevision() }
    }

    public mutating func retryAgentStop(_ id: AgentId) throws {
        guard let found = agent(id) else { throw domainFail(.unknownAgent) }
        if found.controlState == .stopping { return }
        guard found.canRetryStop else { throw domainFail(.invalidAgentControlTransition) }
        if try requireAgent(id, { $0.requestStop() }) { bumpRevision() }
    }

    public mutating func markAgentStopFailed(_ id: AgentId, _ diagnostic: DiagnosticCode) throws {
        if try requireAgent(id, { try $0.markStopFailed(diagnostic) }) { bumpRevision() }
    }

    public mutating func returnAgentToRunning(_ id: AgentId) throws {
        if try requireAgent(id, { $0.returnToRunning() }) { bumpRevision() }
    }

    /// An operation on this Agent was refused. It shows in the Agent's own pane.
    public mutating func markAgentFailed(_ id: AgentId, _ failure: AgentFailure) throws {
        if try requireAgent(id, { $0.fail(failure) }) { bumpRevision() }
    }

    // MARK: Selection

    /// Select something, and say how it should be shown. Anything with no
    /// other half to be beside is recorded as `full` whatever the caller passed.
    public mutating func selectContext(_ context: NavigationContext, presentation: SurfacePresentation = .full) throws {
        try ensureContextExists(context)
        let next = NavigationSelection(context: context, presentation: canPresentBeside(context) ? presentation : .full)
        // Choosing an Agent is what makes it the one this workspace comes back to.
        if case let .agent(agentId) = context, let owner = agent(agentId)?.workspaceId {
            lastAgentByWorkspace[owner] = agentId
        }
        let moved = selection != next
        selection = next
        // Choosing something puts the keyboard in it, out of any terminal pane.
        let leftTerminal = terminalFocus
        terminalFocus = false
        // Selecting an Agent is reading it; a Workspace's terminals are read by
        // the same two events.
        let readAgent = readVisibleAgent()
        let readTerminals = readVisibleTerminals()
        if moved || readAgent || readTerminals || leftTerminal { bumpRevision() }
    }

    /// Scratch, and back again.
    public mutating func toggleScratch() throws {
        if selection.context != .workspace(scratchWorkspaceId) {
            scratchReturn = selection
            try selectContext(.workspace(scratchWorkspaceId))
            return
        }
        guard let back = scratchReturn else { return }
        scratchReturn = nil
        guard contextExists(back.context) else { return }
        try selectContext(back.context, presentation: back.presentation)
    }

    /// The Agent this workspace's chords and its split are about.
    public func pairedAgentIn(_ workspaceId: WorkspaceId) -> AgentId? {
        guard let workspace = workspace(workspaceId) else { return nil }
        return pairedAgentId(lastAgentId: lastAgentIn(workspaceId), agentIds: workspace.agents.map(\.id))
    }

    /// Whether this context has an other half to be shown beside.
    private func canPresentBeside(_ context: NavigationContext) -> Bool {
        switch context {
        case .agent: return true
        case let .workspace(id): return pairedAgentIn(id) != nil
        }
    }

    /// Side by side: put the keyboard in the other half.
    public mutating func swapSplitFocus() throws {
        guard selection.presentation == .beside else { return }
        switch selection.context {
        case let .agent(agentId):
            guard let workspace = agent(agentId)?.workspaceId else { return }
            try selectContext(.workspace(workspace), presentation: .beside)
        case let .workspace(workspaceId):
            guard let paired = pairedAgentIn(workspaceId) else { return }
            try selectContext(.agent(paired), presentation: .beside)
        }
    }

    // MARK: The Agents' terminals

    /// The Workspace the selection is in, whether its row or one of its Agents.
    public func selectedWorkspaceId() -> WorkspaceId? {
        switch selection.context {
        case let .workspace(id): return id
        case let .agent(id): return agent(id)?.workspaceId
        }
    }

    /// The Agent whose terminal the view shows, and whose terminal `Cmd+Q V`
    /// opens: the Agent on screen.
    public func terminalAgentId() -> AgentId? {
        switch selection.context {
        case let .agent(id): return agent(id) != nil ? id : nil
        case let .workspace(id):
            guard selection.presentation == .beside else { return nil }
            return pairedAgentIn(id)
        }
    }

    public func agentTerminal(_ agentId: AgentId) -> AgentTerminal? { agentTerminalsValue[agentId] }

    /// Every Agent terminal there is, shown or hidden.
    public func agentTerminals() -> [AgentTerminal] { agentTerminalOrder.compactMap { agentTerminalsValue[$0] } }

    /// The Agent terminal a session id names, whichever Agent's it is.
    public func agentTerminalById(_ terminalId: String) -> AgentTerminal? {
        agentTerminals().first { $0.terminalId == terminalId }
    }

    public func terminalShare(_ agentId: AgentId) -> Double { terminalShares[agentId] ?? AgentTerminals.defaultShare }

    public func terminalStackedShare(_ agentId: AgentId) -> Double {
        terminalStackedShares[agentId] ?? AgentTerminals.defaultShare
    }

    /// The terminal on screen with its Agent: the view's Agent's, if open.
    public func visibleTerminal() -> AgentTerminal? {
        guard let agentId = terminalAgentId(), let terminal = agentTerminalsValue[agentId], terminal.open else { return nil }
        return terminal
    }

    /// The terminal pane's id, when it has the keyboard.
    public var paneFocus: String? { terminalFocus ? visibleTerminal()?.terminalId : nil }

    private func terminalOnScreen(_ agentId: AgentId) -> Bool { terminalAgentId() == agentId }

    private mutating func setTerminal(_ terminal: AgentTerminal) {
        if agentTerminalsValue[terminal.agentId] == nil { agentTerminalOrder.append(terminal.agentId) }
        agentTerminalsValue[terminal.agentId] = terminal
    }

    private mutating func removeTerminal(_ agentId: AgentId) {
        agentTerminalsValue[agentId] = nil
        agentTerminalOrder.removeAll { $0 == agentId }
    }

    /// An Agent's terminal session is up: it is that Agent's terminal now,
    /// shown. When it is the view's Agent and `focus` is set, the keyboard
    /// goes into it.
    public mutating func agentTerminalOpened(
        _ agentId: AgentId, terminalId: String, focus: Bool = false, openedAt: Double = Date().timeIntervalSince1970 * 1000
    ) throws {
        guard agent(agentId) != nil else { throw domainFail(.invalidId) }
        setTerminal(AgentTerminal(agentId: agentId, terminalId: terminalId, open: true, openedAt: openedAt))
        if focus && terminalOnScreen(agentId) { terminalFocus = true }
        bumpRevision()
    }

    /// Show or hide an Agent's terminal pane; its session runs on either way.
    @discardableResult
    public mutating func showAgentTerminal(_ agentId: AgentId, open: Bool, focus: Bool = false) -> Bool {
        guard var terminal = agentTerminalsValue[agentId] else { return false }
        let onScreen = terminalOnScreen(agentId)
        let focusing = open && focus && onScreen
        let unfocus = !open && onScreen && terminalFocus
        if terminal.open == open && !focusing && !unfocus { return false }
        terminal.open = open
        setTerminal(terminal)
        if focusing { terminalFocus = true }
        if unfocus { terminalFocus = false }
        bumpRevision()
        return true
    }

    /// An Agent's terminal is gone. Returns whether it had one.
    @discardableResult
    public mutating func agentTerminalClosed(_ agentId: AgentId) -> Bool {
        guard agentTerminalsValue[agentId] != nil else { return false }
        if terminalOnScreen(agentId) { terminalFocus = false }
        removeTerminal(agentId)
        bumpRevision()
        return true
    }

    /// The divider between an Agent and its terminal, moved.
    @discardableResult
    public mutating func resizeAgentTerminal(_ agentId: AgentId, share: Double, stacked: Bool = false) throws -> Bool {
        guard agent(agentId) != nil else { throw domainFail(.invalidId) }
        let next = AgentTerminals.clampShare(share)
        let current = stacked ? terminalStackedShares[agentId] : terminalShares[agentId]
        if (current ?? AgentTerminals.defaultShare) == next { return false }
        let value: Double? = next == AgentTerminals.defaultShare ? nil : next
        if stacked { terminalStackedShares[agentId] = value } else { terminalShares[agentId] = value }
        bumpRevision()
        return true
    }

    /// Put the keyboard in one pane of what is on screen.
    @discardableResult
    public mutating func focusPane(_ target: PaneFocusTarget) -> Bool {
        switch target {
        case .content:
            if !terminalFocus { return false }
            terminalFocus = false
        case let .terminal(terminalId):
            guard visibleTerminal()?.terminalId == terminalId, !terminalFocus else { return false }
            terminalFocus = true
        }
        bumpRevision()
        return true
    }

    private enum FocusStop { case content, editor, agent, terminal }

    /// Every pane on screen that can hold the keyboard, left to right.
    private func focusStops() -> [FocusStop] {
        guard selectedWorkspaceId() != nil else { return [] }
        var stops: [FocusStop] = resolveLayout(selection).isSplit ? [.editor, .agent] : [.content]
        if visibleTerminal() != nil { stops.append(.terminal) }
        return stops
    }

    private func currentStop() -> FocusStop {
        if paneFocus != nil { return .terminal }
        if !resolveLayout(selection).isSplit { return .content }
        return selection.context.isAgent ? .agent : .editor
    }

    private mutating func arriveAt(_ stop: FocusStop) throws {
        let terminal = visibleTerminal()
        switch stop {
        case .terminal:
            if let terminal { focusPane(.terminal(terminalId: terminal.terminalId)) }
            return
        case .content:
            focusPane(.content)
            return
        case .editor, .agent:
            // Arriving from the terminal, the half asked for may already be the
            // selection's, and only the keyboard moves.
            if currentStop() == .terminal {
                let inFront: FocusStop = selection.context.isAgent ? .agent : .editor
                if inFront == stop {
                    focusPane(.content)
                    return
                }
            }
            try swapSplitFocus()
        }
    }

    /// `Cmd+Q O`: the next pane on screen, wrapping.
    @discardableResult
    public mutating func cyclePaneFocus(_ direction: Int = 1) throws -> Bool {
        let stops = focusStops()
        guard stops.count >= 2 else { return false }
        let current = currentStop()
        let index = stops.firstIndex(of: current) ?? -1
        let count = stops.count
        let next = stops[(((index + direction) % count) + count) % count]
        if next == current { return false }
        try arriveAt(next)
        return true
    }

    /// One machine's reading of which terminal sessions are still running.
    @discardableResult
    public mutating func observePaneTerminals(_ workspaces: [WorkspaceId], alive: Set<String>, since: Double) -> Bool {
        let on = Set(workspaces)
        var changed = false
        for terminal in agentTerminals() {
            guard let workspace = agent(terminal.agentId)?.workspaceId, on.contains(workspace) else { continue }
            if alive.contains(terminal.terminalId) || terminal.openedAt >= since { continue }
            if agentTerminalClosed(terminal.agentId) { changed = true }
        }
        return changed
    }

    /// Put an Agent's terminal back from the state file. Restored, not opened.
    public mutating func restoreAgentTerminal(
        _ agentId: AgentId, terminal: (terminalId: String, open: Bool)?, share: Double?, stackedShare: Double? = nil
    ) throws {
        guard agent(agentId) != nil else { throw domainFail(.invalidId) }
        if let terminal {
            setTerminal(AgentTerminal(agentId: agentId, terminalId: terminal.terminalId, open: terminal.open, openedAt: 0))
        }
        if let share, share != AgentTerminals.defaultShare { terminalShares[agentId] = AgentTerminals.clampShare(share) }
        if let stackedShare, stackedShare != AgentTerminals.defaultShare {
            terminalStackedShares[agentId] = AgentTerminals.clampShare(stackedShare)
        }
    }

    /// An Agent went: so does what the model kept about its terminal.
    private mutating func forgetAgentTerminal(_ agentId: AgentId) {
        if agentTerminalsValue[agentId] != nil && terminalOnScreen(agentId) { terminalFocus = false }
        removeTerminal(agentId)
        terminalShares[agentId] = nil
        terminalStackedShares[agentId] = nil
    }

    // MARK: Layout

    /// The one place that decides what the content area holds.
    public func resolveLayout(_ selection: NavigationSelection) -> SurfaceLayout {
        switch selection.context {
        case let .workspace(workspaceId):
            guard let workspace = workspace(workspaceId), Self.showable(workspace) else { return .unavailable }
            let editor = SurfaceKey.workspaceEditor(workspace.id)
            if selection.presentation == .beside, let paired = pairedAgentIn(workspace.id) {
                return .split(editor: editor, agent: .agent(paired))
            }
            return .workbench(editor: editor)
        case let .agent(agentId):
            guard let agent = agent(agentId), let workspace = workspace(agent.workspaceId), Self.showable(workspace) else {
                return .unavailable
            }
            if selection.presentation == .full { return .agent(agent: .agent(agent.id)) }
            return .split(editor: .workspaceEditor(workspace.id), agent: .agent(agent.id))
        }
    }

    /// Whether there is anything worth drawing in this Workspace's content area.
    static func showable(_ workspace: Workspace) -> Bool { workspace.state.isAvailable && !workspace.close.isRunning }

    // MARK: Removal

    /// An Agent is gone. Where the selection goes when it was the Agent's is
    /// decided inside its Workspace.
    public mutating func agentExited(_ id: AgentId) throws {
        guard let index = workspaceList.firstIndex(where: { $0.agent(id) != nil }) else { throw domainFail(.unknownAgent) }
        let workspace = workspaceList[index]
        let before = TabOrder.of([(workspace.id, workspace.agents.map(\.id))])
        forgetAgentTerminal(id)
        workspaceList[index].removeAgent(id)
        try repairSelection(before)
        bumpRevision()
    }

    /// Every row of the Sidebar, of both kinds, in the order it is drawn.
    private func tabs(_ drawn: [WorkspaceId]) throws -> [NavigationContext] {
        if drawn.count != workspaceList.count || Set(drawn).count != drawn.count || drawn.contains(where: { workspace($0) == nil }) {
            throw InvariantViolation("the drawn order [\(drawn.map(\.rawValue).joined(separator: ", "))] does not name the open workspaces")
        }
        return TabOrder.of(drawn.map { id in (id, workspace(id)!.agents.map(\.id)) })
    }

    /// The selection, after something was removed from under it: the next row
    /// of what held it, and the previous one when there is no next.
    private mutating func repairSelection(_ before: [NavigationContext]) throws {
        if contextExists(selection.context) { return }
        let at = try TabOrder.position(before, selection.context)
        let successor = before[(at + 1)...].first(where: contextExists)
            ?? before[..<at].reversed().first(where: contextExists)
        guard let successor else { throw InvariantViolation("a removal left no row to select") }
        selection = NavigationSelection(context: successor, presentation: .full)
    }

    public mutating func closeWorkspace(_ id: WorkspaceId, inspection: CloseInspection, drawn: [WorkspaceId]) throws {
        guard inspection.isClean else { throw domainFail(.workspaceNotClean) }
        guard let index = workspaceList.firstIndex(where: { $0.id == id }) else { throw domainFail(.unknownWorkspace) }
        // Today's folder is what Scratch *is*; it stops being Scratch at midnight.
        if id == scratchWorkspaceId { throw domainFail(.scratchCannotClose) }
        if !workspaceList[index].agents.isEmpty { throw domainFail(.workspaceHasLiveAgents) }
        let before = try tabs(drawn)
        workspaceList.remove(at: index)
        try repairSelection(before)
        bumpRevision()
    }

    /// Close, but keep everything needed to put it back if the save fails.
    public mutating func closeWorkspaceForPersistence(
        _ id: WorkspaceId, inspection: CloseInspection, drawn: [WorkspaceId]
    ) throws -> WorkspaceCloseRollback {
        guard let index = workspaceList.firstIndex(where: { $0.id == id }) else { throw domainFail(.unknownWorkspace) }
        let workspace = workspaceList[index]
        let before = selection
        try closeWorkspace(id, inspection: inspection, drawn: drawn)
        return WorkspaceCloseRollback(workspace: workspace, index: index, selectionBefore: before, selectionAfter: selection)
    }

    public mutating func rollbackWorkspaceClose(_ rollback: WorkspaceCloseRollback) throws {
        if workspace(rollback.workspace.id) != nil { throw domainFail(.duplicateWorkspaceRoot) }
        if workspaceList.contains(where: { $0.key == rollback.workspace.key }) { throw domainFail(.duplicateWorkspaceRoot) }
        workspaceList.insert(rollback.workspace, at: min(rollback.index, workspaceList.count))
        if selection == rollback.selectionAfter { selection = rollback.selectionBefore }
        bumpRevision()
    }

    public mutating func relocateWorkspace(_ id: WorkspaceId, location: WorkspaceLocation, selectedPath: String) throws {
        guard let index = workspaceList.firstIndex(where: { $0.id == id }) else { throw domainFail(.unknownWorkspace) }
        guard case .unavailable = workspaceList[index].state else { throw domainFail(.workspaceNotUnavailable) }
        if workspaceList.enumerated().contains(where: { $0.offset != index && $0.element.key == location.key }) {
            throw domainFail(.duplicateWorkspaceRoot)
        }
        if workspaceList[index].key == location.key && workspaceList[index].selectedPath == selectedPath {
            if workspaceList[index].markAvailable() { bumpRevision() }
            return
        }
        workspaceList[index].relocate(location, selectedPath: selectedPath)
        bumpRevision()
    }

    public mutating func markWorkspaceUnavailable(_ id: WorkspaceId, _ reason: DiagnosticCode) throws {
        guard let changed = withWorkspace(id, { $0.markUnavailable(reason) }) else { throw domainFail(.unknownWorkspace) }
        if changed { bumpRevision() }
    }

    public mutating func markWorkspaceAvailable(_ id: WorkspaceId) throws {
        guard let changed = withWorkspace(id, { $0.markAvailable() }) else { throw domainFail(.unknownWorkspace) }
        if changed { bumpRevision() }
    }

    public mutating func beginWorkspaceClose(_ id: WorkspaceId) throws {
        guard let changed = try withWorkspace(id, { try $0.beginClose() }) else { throw domainFail(.unknownWorkspace) }
        if changed { bumpRevision() }
    }

    public mutating func markWorkspaceCloseFailed(
        _ id: WorkspaceId, step: CloseStep, diagnostic: DiagnosticCode, detail: String? = nil
    ) throws {
        guard let changed = withWorkspace(id, { $0.closeFailed(step, diagnostic, detail: detail) }) else {
            throw domainFail(.unknownWorkspace)
        }
        if changed { bumpRevision() }
    }

    // MARK: Helpers

    /// Whether this context still names something.
    public func contextExists(_ context: NavigationContext) -> Bool {
        switch context {
        case let .workspace(id): return workspace(id) != nil
        case let .agent(id): return agent(id) != nil
        }
    }

    private func ensureContextExists(_ context: NavigationContext) throws {
        if contextExists(context) { return }
        throw domainFail(context.isAgent ? .unknownAgent : .unknownWorkspace)
    }

    @discardableResult
    private mutating func withWorkspace<T>(_ id: WorkspaceId, _ body: (inout Workspace) throws -> T) rethrows -> T? {
        guard let index = workspaceList.firstIndex(where: { $0.id == id }) else { return nil }
        return try body(&workspaceList[index])
    }

    @discardableResult
    private mutating func withAgent<T>(_ id: AgentId, _ body: (inout Agent) throws -> T) rethrows -> T? {
        guard let index = workspaceList.firstIndex(where: { $0.agent(id) != nil }) else { return nil }
        return try workspaceList[index].withAgent(id, body)
    }

    private mutating func requireAgent<T>(_ id: AgentId, _ body: (inout Agent) throws -> T) throws -> T {
        guard let result = try withAgent(id, body) else { throw domainFail(.unknownAgent) }
        return result
    }

    private mutating func bumpRevision() {
        revision += 1
        recordSelection()
    }

    /// Write the selection into the history, if it moved. A move between the
    /// two halves of one split updates the entry rather than adding one.
    private mutating func recordSelection() {
        let before = history.current
        let now = selection
        let workspace = splitWorkspace(before.context)
        let sameSplit = before.presentation == .beside && now.presentation == .beside
            && workspace != nil && workspace == splitWorkspace(now.context)
        history.visit(now, replace: sameSplit)
    }

    private func splitWorkspace(_ context: NavigationContext) -> WorkspaceId? {
        switch context {
        case let .workspace(id): return id
        case let .agent(id): return agent(id)?.workspaceId
        }
    }

    private func workspaceSnapshots() -> [WorkspaceSnapshot] {
        workspaceList.map { workspace in
            WorkspaceSnapshot(
                id: workspace.id,
                label: labelFor(workspace),
                location: workspace.location,
                selectedPath: workspace.selectedPath,
                editor: workspace.editor,
                startedContainer: workspace.startedContainer,
                repositoryId: workspace.repositoryId,
                state: workspace.state,
                close: workspace.close,
                agents: workspace.agents.map { agent in
                    AgentSnapshot(
                        id: agent.id,
                        workspaceId: agent.workspaceId,
                        profile: agent.profile,
                        presentation: agent.presentation,
                        displayName: Self.agentLabel(agent, siblings: workspace.agents),
                        ordinal: agent.ordinal,
                        status: agent.status,
                        runtimeHealth: agent.runtimeHealth,
                        controlState: agent.controlState,
                        unread: agent.unread,
                        activity: agent.activity,
                        promptCache: agent.promptCache,
                        injection: agent.injection,
                        automaticActions: agent.automaticActions,
                        failure: agent.failure,
                        terminal: agentTerminalsValue[agent.id],
                        terminalShare: terminalShare(agent.id),
                        terminalStackedShare: terminalStackedShare(agent.id)
                    )
                },
                canCreateAgent: workspace.canCreateAgent,
                lastAgentId: lastAgentIn(workspace.id),
                terminals: workspace.terminals.activity
            )
        }
    }

    /// The shortest label that tells two Workspaces apart: the folder name,
    /// and only as much of the path above it as the collision needs. Scratch
    /// is called Scratch only while it is today's folder.
    private func labelFor(_ workspace: Workspace) -> String {
        if workspace.id == scratchWorkspaceId { return scratchName }
        let basename = DomainPaths.rootBasename(workspace.root)
        let collisions = workspaceList.filter {
            $0.id != scratchWorkspaceId && DomainPaths.rootBasename($0.root) == basename
        }
        if collisions.count == 1 { return basename }
        let parents = DomainPaths.rootParentComponents(workspace.root)
        if !parents.isEmpty {
            for depth in 1...parents.count {
                let suffix = parents.prefix(depth).joined(separator: "/")
                let matching = collisions.filter { candidate in
                    let candidateParents = DomainPaths.rootParentComponents(candidate.root)
                    return candidateParents.count >= depth && candidateParents.prefix(depth).joined(separator: "/") == suffix
                }.count
                if matching == 1 {
                    return "\(basename) — \(parents.prefix(depth).reversed().joined(separator: "/"))"
                }
            }
        }
        // The last resort has to be *unique*: the place, spelled out.
        return "\(basename) — \(workspace.location.label)"
    }

    /// The shortest name that tells two Agents in one Workspace apart. A name
    /// the person typed is theirs, and is neither shortened nor counted.
    static func agentLabel(_ agent: Agent, siblings: [Agent]) -> String {
        if let chosen = agent.temporaryName { return chosen }
        let collisions = siblings.filter { $0.temporaryName == nil && $0.profile.id == agent.profile.id }
        return collisions.count == 1 ? agent.profile.displayName : agent.displayName
    }

    private static func ordinalKey(_ owner: WorkspaceId, _ profile: String) -> String { "\(owner.rawValue)\u{0}\(profile)" }
}
