// Port of apps/desktop/src/main/shell/chords.ts (the pure half: strokes,
// matching, effects, `resolveChord`)
//
// A chord's second stroke, resolved against the model.
//
// **The table and the reasoning behind it are in `Commands`.** This file has
// no table of its own — it turns a command id into the one thing that command
// should do *now*, given what is selected, and answers "nothing" when there is
// nothing to act on.
//
// # The three lists
//
// - `sidebarEntries` — Scratch, then the workspaces. What a digit names (0 is Scratch).
// - `everyAgent` — every Agent there is, in sidebar order, across workspaces.
// - `everyTab` — every row of the tree in order, of both kinds.
//
// The workspaces arrive already in the order the sidebar draws them, so none
// of the three sorts anything.

import Foundation

/// One keystroke as the dispatcher sees it.
public struct KeyStroke: Hashable, Sendable {
    /// The character it produced, or the name of a key that produces none, or
    /// nothing for a key that arrived with neither (which completes no chord).
    public var key: String?
    public var code: String
    public var command: Bool
    public var control: Bool
    public var option: Bool
    public var shift: Bool
    public var isAutoRepeat: Bool

    public init(key: String?, code: String = "", command: Bool = false, control: Bool = false, option: Bool = false,
                shift: Bool = false, isAutoRepeat: Bool = false) {
        self.key = key
        self.code = code
        self.command = command
        self.control = control
        self.option = option
        self.shift = shift
        self.isAutoRepeat = isAutoRepeat
    }
}

/// Where the keyboard lands inside an editor a move arrives at.
public enum Landing: String, Hashable, Sendable {
    case editor
}

/// What running a chord comes to, once it has been resolved against the model.
public enum ChordEffect: Hashable, Sendable {
    /// `presentation` nil is the plain, full one; `passing`: `Cmd+Q N/P`.
    case selectContext(ContextWire, presentation: SurfacePresentation? = nil, focus: Landing? = nil, passing: Bool = false)
    case swapSplitFocus
    case cyclePaneFocus
    case toggleTerminal(agentId: String)
    case terminalNeedsAgent(workspaceId: String)
    case terminalNeedsAgentView(workspaceId: String)
    case closeTerminal(terminalId: String)
    case focusSidebar
    case toggleSidebar
    case toggleScratch(focus: Landing)
    case openWorkspacePicker
    case openTabPicker
    case openAgentPicker(workspaceId: String)
    case openIssuePicker
    case openAgentActions(agentId: String)
    case renameAgent(agentId: String)
    case markAgentUnread(agentId: String)
    case dismissAlert
    case showNotifications
    case closeAgent(agentId: String)
    case restartAgent(agentId: String)
    case closeWorkspace(workspaceId: String)
    /// `workspaceId` nil for the top-level rows, present for that workspace's Agents.
    case reorderEntries(workspaceId: String?, order: [String])
    case refreshRepositories
    case openChordHelp
    case openSettings
    case openLog
    case openCommandPalette
    case navigateHistory(NavigationDirection)
}

public enum Chords {
    /// `defaultChordTable`.
    public static func defaultTable() -> [KeyBinding] { Commands.defaultBindings() }

    /// `strokeAs`: the stroke as a binding would spell it. Shift is in the
    /// character already, unless there is no character to be in.
    public static func strokeAs(_ stroke: KeyStroke) -> ChordKey? {
        guard let key = stroke.key else { return nil }
        return ChordKey(
            key: key, command: stroke.command, control: stroke.control, option: stroke.option,
            shift: key.unicodeScalars.count > 1 ? stroke.shift : false
        )
    }

    /// `matchChord`: the binding this stroke completes, if any.
    public static func match(_ table: [KeyBinding], _ stroke: KeyStroke) -> KeyBinding? {
        guard let spelled = strokeAs(stroke) else { return nil }
        let wanted = ChordKeys.id(spelled)
        return table.first { ChordKeys.id($0.key) == wanted }
    }

    private static func sidebarEntries(_ snapshot: AppSnapshotWire) throws -> [ContextWire] {
        try snapshot.orderedWorkspaces().map { .workspace($0.id) }
    }

    private static func everyAgent(_ snapshot: AppSnapshotWire) throws -> [AgentWire] {
        try snapshot.orderedWorkspaces().flatMap(\.agents)
    }

    private static func everyTab(_ snapshot: AppSnapshotWire) throws -> [ContextWire] {
        try snapshot.orderedWorkspaces().flatMap { workspace in
            [ContextWire.workspace(workspace.id)] + workspace.agents.map { ContextWire.agent($0.id) }
        }
    }

    private static func selectedWorkspace(_ snapshot: AppSnapshotWire) -> WorkspaceWire? {
        snapshot.workspace(for: snapshot.selection.context)
    }

    private static func focusedTerminal(_ snapshot: AppSnapshotWire) -> String? {
        guard let id = snapshot.paneFocus, id == snapshot.visibleTerminal else { return nil }
        return id
    }

    private static func selectedAgent(_ snapshot: AppSnapshotWire) throws -> AgentWire? {
        guard case let .agent(id) = snapshot.selection.context else { return nil }
        return try everyAgent(snapshot).first { $0.id == id }
    }

    /// Close the workspace the selection is in — nothing, when that is Scratch.
    private static func closeWorkspace(_ snapshot: AppSnapshotWire, _ workspace: WorkspaceWire?) -> ChordEffect? {
        guard let workspace, workspace.id != snapshot.scratchWorkspaceId else { return nil }
        return .closeWorkspace(workspaceId: workspace.id)
    }

    private static func wrap(_ index: Int, _ length: Int) -> Int { ((index % length) + length) % length }

    /// Step through a ring, from wherever the selection is in it, stopping at
    /// the first entry `wanted` accepts. Every entry is offered once.
    private static func step(
        _ ring: [ContextWire], from: ContextWire, direction: Int, wanted: (Int) -> Bool = { _ in true }
    ) throws -> ChordEffect? {
        guard let current = ring.firstIndex(of: from) else {
            throw InvariantViolation("\(from) is not a row of the tab order")
        }
        for offset in stride(from: 1, through: ring.count, by: 1) {
            let index = wrap(current + direction * offset, ring.count)
            if wanted(index) { return .selectContext(ring[index]) }
        }
        return nil
    }

    private static func paired(_ workspace: WorkspaceWire) -> String? {
        pairedAgentId(lastAgentId: workspace.lastAgentId, agentIds: workspace.agents.map(\.id))
    }

    /// `resolveChord`: turn a command into the one thing it should do now, or
    /// nothing. Nothing is a real answer.
    public static func resolve(_ commandId: CommandId, _ snapshot: AppSnapshotWire) throws -> ChordEffect? {
        guard let definition = Commands.definition(commandId.rawValue) else { return nil }
        let workspace = selectedWorkspace(snapshot)
        let agent = try selectedAgent(snapshot)
        if definition.needs == .workspace && workspace == nil { return nil }
        if definition.needs == .agent && agent == nil { return nil }
        if definition.needs == .split && snapshot.selection.presentation != .beside { return nil }

        if let ordinal = commandId.selectEntryDigit {
            let entries = try sidebarEntries(snapshot)
            return ordinal < entries.count ? .selectContext(entries[ordinal]) : nil
        }

        switch commandId {
        case .forwardPrefix: return nil // Handled by the dispatcher before anything is resolved.
        case .addWorkspace: return .openWorkspacePicker
        case .openTabPicker: return .openTabPicker
        case .addAgent:
            guard let workspace, workspace.canCreateAgent else { return nil }
            return .openAgentPicker(workspaceId: workspace.id)
        case .openIssuePicker: return .openIssuePicker
        case .sendAgentAction: return agent.map { .openAgentActions(agentId: $0.id) }
        case .renameAgent: return agent.map { .renameAgent(agentId: $0.id) }
        case .markAgentUnread: return agent.map { .markAgentUnread(agentId: $0.id) }
        case .closeSelection:
            // The small thing if you are standing on one, the big thing if you are not.
            if let terminal = focusedTerminal(snapshot) { return .closeTerminal(terminalId: terminal) }
            if let agent { return .closeAgent(agentId: agent.id) }
            return closeWorkspace(snapshot, workspace)
        case .restartAgent: return agent.map { .restartAgent(agentId: $0.id) }
        case .closeWorkspace: return closeWorkspace(snapshot, workspace)
        case .refreshRepositories: return .refreshRepositories
        case .focusSidebar: return .focusSidebar
        case .toggleSidebar: return .toggleSidebar
        case .dismissAlert: return .dismissAlert
        case .showNotifications: return .showNotifications
        case .openSettings: return .openSettings
        case .openLog: return .openLog
        case .showChordHelp: return .openChordHelp
        case .openCommandPalette: return .openCommandPalette
        case .navigateBack, .navigateForward:
            let forwards = commandId == .navigateForward
            if let history = snapshot.history, !(forwards ? history.canGoForward : history.canGoBack) { return nil }
            return .navigateHistory(forwards ? .forward : .back)
        case .focusEditor:
            return .selectContext(.workspace(workspace?.id ?? snapshot.scratchWorkspaceId))
        case .swapSplitFocus:
            let beside = snapshot.selection.presentation == .beside
            if snapshot.visibleTerminal == nil { return beside ? .swapSplitFocus : nil }
            return .cyclePaneFocus
        case .toggleTerminal:
            guard let workspace else { return nil }
            guard let owner = agent?.id ?? paired(workspace) else { return .terminalNeedsAgent(workspaceId: workspace.id) }
            if agent == nil && snapshot.selection.presentation != .beside { return .terminalNeedsAgentView(workspaceId: workspace.id) }
            return .toggleTerminal(agentId: owner)
        case .toggleScratch:
            return .toggleScratch(focus: .editor)
        case .toggleSplit:
            guard let workspace else { return nil }
            if snapshot.selection.presentation == .beside {
                return .selectContext(snapshot.selection.context, presentation: .full)
            }
            if let agent { return .selectContext(.agent(agent.id), presentation: .beside) }
            return paired(workspace) == nil ? nil : .selectContext(.workspace(workspace.id), presentation: .beside)
        case .toggleWorkspaceAgent:
            guard let workspace else { return nil }
            if snapshot.selection.presentation == .beside { return .swapSplitFocus }
            if agent != nil { return .selectContext(.workspace(workspace.id), focus: .editor) }
            return paired(workspace).map { .selectContext(.agent($0), presentation: .full) }
        case .nextWorkspace, .previousWorkspace:
            let entries = try sidebarEntries(snapshot)
            if entries.count < 2 { return nil }
            return try step(
                entries, from: .workspace(workspace?.id ?? snapshot.scratchWorkspaceId),
                direction: commandId == .nextWorkspace ? 1 : -1
            )
        case .nextAgent, .previousAgent, .nextUnreadAgent, .previousUnreadAgent:
            let forwards = commandId == .nextAgent || commandId == .nextUnreadAgent
            let onlyUnread = commandId == .nextUnreadAgent || commandId == .previousUnreadAgent
            let tabs = try everyTab(snapshot)
            let unread = Set(try everyAgent(snapshot).filter { $0.unread != nil }.map(\.id))
            return try step(tabs, from: snapshot.selection.context, direction: forwards ? 1 : -1) { index in
                guard case let .agent(id) = tabs[index] else { return false }
                return !onlyUnread || unread.contains(id)
            }
        case .moveEntryUp, .moveEntryDown:
            let direction: MoveDirection = commandId == .moveEntryUp ? .up : .down
            let context = snapshot.selection.context
            if context == .workspace(snapshot.scratchWorkspaceId) { return nil }
            if case let .agent(agentId) = context {
                guard let workspace else { return nil }
                return WorkspaceOrder.moveAgent(workspace.agents.map(\.id), agentId: agentId, direction: direction)
                    .map { .reorderEntries(workspaceId: workspace.id, order: $0) }
            }
            guard case let .workspace(workspaceId) = context else { return nil }
            return WorkspaceOrder.move(
                try snapshot.sidebarWorkspaces().rows, mainWorktreeOf: { $0.groupKey }, workspaceId: workspaceId, direction: direction
            ).map { .reorderEntries(workspaceId: nil, order: $0) }
        case .nextTab, .previousTab:
            let tabs = try everyTab(snapshot)
            if tabs.count < 2 { return nil }
            let effect = try step(tabs, from: snapshot.selection.context, direction: commandId == .nextTab ? 1 : -1)
            if case let .selectContext(context, presentation, focus, _)? = effect {
                return .selectContext(context, presentation: presentation, focus: focus, passing: true)
            }
            return effect
        default:
            return nil
        }
    }
}
