// Port of apps/desktop/src/model/persistence.ts — validation, hydration and
// projection (`validateState`, `hydrateModel`, `restoreNavigation`,
// `stateFromSnapshot`, `applySnapshot`).

import Foundation

public enum StateValidation {
    typealias D = StateDecoding

    static func uuid(_ place: String, _ value: String) throws {
        if !DomainIds.isCanonicalUuid(value) { throw D.refuse(place, "an identity", .string(value)) }
    }

    static func absolutePath(_ place: String, _ value: String) throws {
        if value.isEmpty || value.contains("\0") || !value.hasPrefix("/") { throw D.refuse(place, "an absolute path", .string(value)) }
    }

    static func bytes(_ text: String) -> Int { text.utf8.count }

    /// `refuseRecord`: a `DomainError` refusing a record is the document's
    /// fault, said with which record; anything else propagates.
    static func refuseRecord<T>(_ place: String, _ work: () throws -> T) throws -> T {
        do { return try work() } catch let error as DomainError {
            throw StateError(.invalid, cause: "\(place): \(error.code.rawValue)")
        }
    }

    static func agent(_ place: String, _ record: AgentStateRecord) throws {
        if let terminal = record.terminal { try uuid("\(place).terminal.terminal_id", terminal.terminalId) }
        if let share = record.terminalShare, !AgentTerminals.isShare(share) {
            throw D.refuse("\(place).terminal_share", "a share between 0.15 and 0.85", .number(share))
        }
        if let share = record.terminalStackedShare, !AgentTerminals.isShare(share) {
            throw D.refuse("\(place).terminal_stacked_share", "a share between 0.15 and 0.85", .number(share))
        }
        try uuid("\(place).agent_id", record.agentId)
        try uuid("\(place).workspace_id", record.workspaceId)
        if !DomainIds.isSlug(record.profileId) { throw D.refuse("\(place).profile_id", "a profile id", .string(record.profileId)) }
        if record.ordinal.rounded() != record.ordinal || record.ordinal == 0 {
            throw D.refuse("\(place).ordinal", "a non-zero whole number", .number(record.ordinal))
        }
        if let command = record.profileCommand,
           command.jsTrimmed.isEmpty || command.contains("\0") || bytes(command) > StateSchema.maxAgentProfileArgBytes {
            throw D.invalid()
        }
        for name in [record.temporaryName, record.profileDisplayName].compactMap({ $0 }) {
            if !DomainNames.validDisplayName(name) || bytes(name) > StateSchema.maxAgentNameBytes { throw D.invalid() }
        }
        if let args = record.profileArgs {
            if args.count > StateSchema.maxAgentProfileArgs
                || args.contains(where: { bytes($0) > StateSchema.maxAgentProfileArgBytes || $0.contains("\0") }) {
                throw D.invalid()
            }
        }
        if let env = record.profileEnv {
            if env.count > StateSchema.maxAgentProfileEnvEntries || env.entries.contains(where: { key, value in
                key.isEmpty || bytes(key) > StateSchema.maxAgentProfileEnvKeyBytes || bytes(value) > StateSchema.maxAgentProfileEnvValueBytes
                    || key.contains("\0") || value.contains("\0") || !DomainNames.isEnvironmentName(key)
            }) {
                throw D.invalid()
            }
        }
        let snapshotBytes = (record.profileArgs ?? []).reduce(0) { $0 + $1.utf16.count }
            + (record.profileEnv?.entries ?? []).reduce(0) { $0 + $1.key.utf16.count + $1.value.utf16.count }
        if snapshotBytes > StateSchema.maxAgentProfileSnapshotBytes { throw D.invalid() }
        if let mapping = record.providerMapping,
           mapping.isEmpty || mapping.utf16.count > StateSchema.maxOpaqueMappingBytes || mapping.contains("\0") {
            throw D.invalid()
        }
    }

    /// The same identity `locationKey` gives a Workspace, computed on the record.
    static func recordKey(_ record: WorkspaceStateRecord) -> String {
        let host: String
        if case let .ssh(name)? = record.location { host = name } else { host = "" }
        return "\(host)\u{0}\(D.normalizePathString(record.canonicalPath))"
    }

    static func workspace(_ place: String, _ record: WorkspaceStateRecord) throws {
        try uuid("\(place).workspace_id", record.workspaceId)
        try absolutePath("\(place).selected_path", record.selectedPath)
        try absolutePath("\(place).canonical_path", record.canonicalPath)
        if case let .ssh(host)? = record.location {
            _ = try refuseRecord("workspace \(record.workspaceId)'s host") { try DomainHosts.sshHost(host) }
        }
        if let editor = record.editor { try absolutePath("\(place).editor.config_path", editor.configPath) }
        if let repository = record.repositoryId { try uuid("\(place).repository_id", repository) }
        if let last = record.lastAgentId { try uuid("\(place).last_agent_id", last) }
        var ids = Set<String>()
        for (index, agent) in record.agents.enumerated() {
            try self.agent("\(place).agents[\(index)]", agent)
            if agent.workspaceId != record.workspaceId || ids.contains(agent.agentId) { throw D.invalid() }
            ids.insert(agent.agentId)
        }
    }

    static func isValidSocketName(_ value: String) -> Bool {
        !value.isEmpty && value.utf16.count <= 64
            && value.unicodeScalars.allSatisfy { ("A"..."Z").contains($0) || ("a"..."z").contains($0) || ("0"..."9").contains($0) || "_.-".unicodeScalars.contains($0) }
    }

    static func ownedSession(_ session: OwnedSessionRecordState) throws {
        let name = session.sessionName
        if name.isEmpty || name.utf16.count > 256 || name.contains("\0") { throw D.invalid() }
        try uuid("the session's workspace_id", session.workspaceId)
        // A workspace session is named from a digest of its canonical root.
        guard name.hasPrefix("ws-") else { throw D.invalid() }
        let digest = name.dropFirst(3)
        if (digest.count != 20 && digest.count != 32) || !digest.unicodeScalars.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }) {
            throw D.invalid()
        }
    }

    /// A required set is exactly one session per workspace, with no duplicate names.
    static func requiredSet(_ sessions: [OwnedSessionRecordState]) throws {
        var names = Set<String>()
        var workspaces = Set<String>()
        for session in sessions {
            try ownedSession(session)
            if names.contains(session.sessionName) { throw D.invalid() }
            names.insert(session.sessionName)
            workspaces.insert(session.workspaceId)
        }
        if workspaces.count != sessions.count { throw D.invalid() }
    }

    static func uniqueSessions(_ sessions: [OwnedSessionRecordState]) throws {
        var names = Set<String>()
        for session in sessions {
            try ownedSession(session)
            if names.contains(session.sessionName) { throw D.invalid() }
            names.insert(session.sessionName)
        }
    }

    static func tmux(_ tmux: TmuxState, _ workspaceIds: Set<String>) throws {
        if !isValidSocketName(tmux.effectiveSocketName) { throw D.invalid() }
        switch tmux.transition {
        case .stable: break
        case let .pending(requested, required, preflight, verified):
            if !isValidSocketName(requested) || requested == tmux.effectiveSocketName { throw D.invalid() }
            try requiredSet(required)
            if let verified {
                // Old sessions are only inventoried once the target is known good.
                if preflight != .targetAbsent && preflight != .targetDevhubEmpty { throw D.invalid() }
                try uniqueSessions(verified)
            }
        case let .cleaningOld(old, requested, required, _, sessions):
            if !isValidSocketName(old) || !isValidSocketName(requested) || old == requested || tmux.effectiveSocketName != old {
                throw D.invalid()
            }
            try requiredSet(required)
            try uniqueSessions(sessions.map(\.session))
        case let .oldCleaned(old, new, required):
            if !isValidSocketName(old) || !isValidSocketName(new) || old == new || tmux.effectiveSocketName != old { throw D.invalid() }
            try requiredSet(required)
        case let .recreationPending(effective, required, sessions):
            if !isValidSocketName(effective) || tmux.effectiveSocketName != effective { throw D.invalid() }
            try requiredSet(required)
            if Set(required.map(\.sessionName)) != Set(sessions.map(\.session.sessionName)) { throw D.invalid() }
        }
        // A transition's required set names the workspaces the snapshot has.
        if let required = tmux.transition.required, Set(required.map(\.workspaceId)) != workspaceIds { throw D.invalid() }
    }

    /// `validateState`: the single gate. Past it, hydration is total for shape.
    public static func validate(_ state: PersistedAppState) throws {
        if state.schemaVersion != StateSchema.version { throw StateError(.newerVersion) }
        var workspaceIds = Set<String>()
        var locations = Set<String>()
        var agentIds = Set<String>()
        for (index, workspace) in state.workspaces.enumerated() {
            try self.workspace("workspaces[\(index)]", workspace)
            let key = recordKey(workspace)
            if workspaceIds.contains(workspace.workspaceId) || locations.contains(key) { throw D.invalid() }
            workspaceIds.insert(workspace.workspaceId)
            locations.insert(key)
            for agent in workspace.agents {
                if agentIds.contains(agent.agentId) { throw D.invalid() }
                agentIds.insert(agent.agentId)
            }
        }
        for presentation in AgentPresentation.allCases {
            if let spot = state.smartButtons[presentation], !SmartButtons.isSpot(spot) { throw D.invalid() }
        }
        if !TerminalZoom.isOffset(state.zoomOffset) { throw D.invalid() }
        if state.sidebar.width < StateSchema.minSidebarWidth || state.sidebar.width > StateSchema.maxSidebarWidth
            || state.splitRatio < AppModel.splitMinRatio || state.splitRatio > AppModel.splitMaxRatio {
            throw D.invalid()
        }
        let frame = state.windowFrame
        if frame.width == 0 || frame.height == 0 || frame.width > 32768 || frame.height > 32768 { throw D.invalid() }
        for (index, id) in state.sidebar.order.enumerated() { try uuid("sidebar.order[\(index)]", id) }
        switch state.navigation {
        case let .workspace(id)?: try uuid("navigation.context.workspace_id", id)
        case let .agent(id)?: try uuid("navigation.context.agent_id", id)
        case nil: break
        }
        try tmux(state.tmux, workspaceIds)
    }
}

public enum StatePersistence {
    typealias V = StateValidation

    /// The profile an Agent was launched with: the record's own snapshot wins
    /// over the configured profile.
    static func launchProfile(_ record: AgentStateRecord, _ fallback: AgentProfile?) throws -> AgentProfile {
        let kind = record.profileKind ?? fallback?.kind
        let displayName = record.profileDisplayName ?? fallback?.displayName
        // A record written before profiles carried a command names its kind.
        let command = record.profileCommand ?? fallback?.command ?? kind?.rawValue
        let args = record.profileArgs ?? fallback?.args
        let env = record.profileEnv ?? fallback?.env
        let presentation = record.profilePresentation ?? fallback?.presentation
        guard let kind, let displayName, let command, let args, let env, let presentation else { throw StateError(.invalid) }
        return try V.refuseRecord("agent \(record.agentId)'s profile") {
            try AgentProfile.create(
                id: try DomainIds.agentProfileId(record.profileId), displayName: displayName, kind: kind, command: command,
                args: args, env: env.entries.map { ($0.key, $0.value) }, presentation: presentation
            )
        }
    }

    static func location(_ record: WorkspaceStateRecord) -> RequestedLocation {
        if case let .ssh(host)? = record.location { return .ssh(host: host, path: record.canonicalPath) }
        return .local(path: record.canonicalPath)
    }

    static func controlState(_ record: PersistedAgentControlState) -> AgentControlState {
        switch record {
        case .running: return .running
        case .stopping: return .stopping
        case let .stopFailed(diagnostic): return .stopFailed(diagnostic: diagnostic)
        }
    }

    /// `hydrateModel`: build the live model from a saved state and the
    /// configured profiles. An Agent whose profile is no longer configured
    /// comes back as Waiting with an unavailable runtime. `today` is a
    /// Workspace for today's daily folder with an id nobody has used.
    public static func hydrate(_ state: PersistedAppState, profiles: [AgentProfile], today: Workspace) throws -> AppModel {
        try V.validate(state)
        var profileById: [String: AgentProfile] = [:]
        for profile in profiles {
            if let previous = profileById[profile.id], previous != profile { throw StateError(.invalid) }
            profileById[profile.id] = profile
        }
        let restored = try state.workspaces.map { record -> (WorkspaceStateRecord, String, Workspace) in
            let place = "workspace \(record.workspaceId)"
            let workspace = try V.refuseRecord(place) { () throws -> Workspace in
                let editor: EditorAttachment = try record.editor.map { .devContainer(configPath: try DevContainerConfig.path($0.configPath)) } ?? .host
                var made = Workspace(
                    id: try WorkspaceId(record.workspaceId), location: try WorkspaceLocation.make(location(record)),
                    selectedPath: try DomainPaths.displayPath(record.selectedPath), editor: editor
                )
                if let started = record.editor?.startedContainerId { try made.noteStartedContainer(started) }
                return made
            }
            return (record, place, workspace)
        }
        let scratch = restored.first { $0.2.key == today.key }?.2 ?? today
        var model = AppModel(scratch: scratch)
        for (record, place, workspace) in restored {
            let id = workspace.id
            if workspace.id != scratch.id { try V.refuseRecord(place) { try model.addWorkspace(workspace) } }
            try V.refuseRecord("\(place)'s lifecycle") {
                if case let .unavailable(reason) = record.lifecycle { try model.markWorkspaceUnavailable(id, reason) }
            }
            for agentRecord in record.agents {
                let configured = profileById[agentRecord.profileId]
                let profile = try launchProfile(agentRecord, configured)
                let status: AgentStatus = configured != nil ? agentRecord.status : .waiting
                let health: AgentRuntimeHealth = configured != nil ? agentRecord.runtimeHealth : .unavailable
                try V.refuseRecord("agent \(agentRecord.agentId)") {
                    try model.restoreAgent(AgentRestoreRecord(
                        id: try AgentId(agentRecord.agentId), workspaceId: id, profile: profile, presentation: agentRecord.presentation,
                        ordinal: Int(agentRecord.ordinal), temporaryName: agentRecord.temporaryName, status: status,
                        runtimeHealth: health, controlState: controlState(agentRecord.controlState),
                        unread: agentRecord.unread?.reason
                    ))
                }
            }
            if let last = record.lastAgentId {
                try V.refuseRecord("\(place)'s last agent") { model.restoreLastAgent(id, try AgentId(last)) }
            }
            for agentRecord in record.agents
            where agentRecord.terminal != nil || agentRecord.terminalShare != nil || agentRecord.terminalStackedShare != nil {
                try V.refuseRecord("agent \(agentRecord.agentId)'s terminal") {
                    try model.restoreAgentTerminal(
                        try AgentId(agentRecord.agentId),
                        terminal: agentRecord.terminal.map { ($0.terminalId, $0.open) },
                        share: agentRecord.terminalShare, stackedShare: agentRecord.terminalStackedShare
                    )
                }
            }
            restoreLegacyTerminal(&model, record)
        }
        try V.refuseRecord("the sidebar and the split") {
            try model.restoreSidebar(width: state.sidebar.width, collapsed: state.sidebar.collapsed)
            model.restoreWorkspaceOrder(try state.sidebar.order.map { try WorkspaceId($0) })
            try model.restoreSplitRatio(state.splitRatio)
            try model.restoreTerminalZoom(Int(state.zoomOffset))
            try model.restoreSmartButtons(state.smartButtons)
        }
        let navigation = try restoreNavigation(state).context
        try V.refuseRecord("the selection") {
            switch navigation {
            case nil: try model.selectContext(.workspace(model.scratchWorkspaceId))
            case let .workspace(id)?: try model.selectContext(.workspace(try WorkspaceId(id)))
            case let .agent(id)?: try model.selectContext(.agent(try AgentId(id)))
            }
        }
        // Back starts at the restored selection.
        model.resetHistory()
        return model
    }

    /// A Workspace's terminal from a file written when terminals were the
    /// Workspace's, given to its last Agent — or its only one.
    static func restoreLegacyTerminal(_ model: inout AppModel, _ record: WorkspaceStateRecord) {
        guard let legacy = AgentTerminals.legacy(layout: record.paneLayout, terminals: record.paneTerminals) else { return }
        let agents = record.agents.map(\.agentId)
        let owner: String?
        if let last = record.lastAgentId, agents.contains(last) {
            owner = last
        } else {
            owner = agents.count == 1 ? agents[0] : nil
        }
        guard let owner else { return }
        let ownerRecord = record.agents.first { $0.agentId == owner }
        if ownerRecord?.terminal != nil { return }
        guard let agentId = try? AgentId(owner), model.agent(agentId) != nil else { return }
        try? model.restoreAgentTerminal(
            agentId, terminal: (legacy.terminalId, true), share: ownerRecord?.terminalShare ?? legacy.share
        )
    }

    public struct NavigationRestore: Equatable, Sendable {
        /// nil is Scratch.
        public var context: NavigationContextRecord?
        public var changed: Bool
    }

    /// `restoreNavigation`: a missing Agent falls to the next Agent in its
    /// Workspace, then to the Workspace, then to Scratch.
    public static func restoreNavigation(
        _ state: PersistedAppState, liveWorkspaceIds: Set<String>? = nil, liveAgentIds: Set<String>? = nil
    ) throws -> NavigationRestore {
        try V.validate(state)
        let workspaces = liveWorkspaceIds ?? Set(state.workspaces.map(\.workspaceId))
        let agents = liveAgentIds ?? Set(state.workspaces.flatMap { $0.agents.map(\.agentId) })
        let scratch = NavigationRestore(context: nil, changed: true)
        guard let context = state.navigation else { return NavigationRestore(context: nil, changed: false) }
        switch context {
        case let .workspace(id):
            return workspaces.contains(id) ? NavigationRestore(context: context, changed: false) : scratch
        case let .agent(id):
            if agents.contains(id) { return NavigationRestore(context: context, changed: false) }
            guard let owner = state.workspaces.first(where: { $0.agents.contains { $0.agentId == id } }),
                  workspaces.contains(owner.workspaceId) else { return scratch }
            let index = owner.agents.firstIndex { $0.agentId == id }!
            if let next = owner.agents[(index + 1)...].first(where: { agents.contains($0.agentId) }) {
                return NavigationRestore(context: .agent(next.agentId), changed: true)
            }
            return NavigationRestore(context: .workspace(owner.workspaceId), changed: true)
        }
    }

    /// `stateFromSnapshot`: project the live model back into records.
    public static func state(from snapshot: AppSnapshot) throws -> PersistedAppState {
        var state = PersistedAppState.fresh()
        state.workspaces = snapshot.workspaces.map { workspace in
            let editor: EditorRecord?
            if case let .devContainer(configPath) = workspace.editor {
                editor = EditorRecord(configPath: configPath, startedContainerId: workspace.startedContainer)
            } else {
                editor = nil
            }
            let location: WorkspaceLocationRecord
            if case let .ssh(host, _) = workspace.location { location = .ssh(host: host) } else { location = .local }
            let lifecycle: WorkspaceLifecycleRecord
            if case let .unavailable(reason) = workspace.state { lifecycle = .unavailable(reason) } else { lifecycle = .available }
            return WorkspaceStateRecord(
                workspaceId: workspace.id.rawValue, selectedPath: workspace.selectedPath, canonicalPath: workspace.root,
                location: location, editor: editor, repositoryId: workspace.repositoryId?.rawValue,
                lastAgentId: workspace.lastAgentId?.rawValue, lifecycle: lifecycle,
                agents: workspace.agents.map { agent in
                    let control: PersistedAgentControlState
                    switch agent.controlState {
                    case .running: control = .running
                    case .stopping: control = .stopping
                    case let .stopFailed(diagnostic): control = .stopFailed(diagnostic)
                    }
                    return AgentStateRecord(
                        agentId: agent.id.rawValue, workspaceId: agent.workspaceId.rawValue, profileId: agent.profileId,
                        profileKind: agent.profileKind, profileDisplayName: agent.profileDisplayName,
                        profileCommand: agent.profile.command, profileArgs: agent.profile.args, profileEnv: agent.profile.env,
                        profilePresentation: agent.profile.presentation, presentation: agent.presentation,
                        ordinal: Double(agent.ordinal), temporaryName: agent.displayName, status: agent.status,
                        unread: agent.unread.map { .reason($0) }, runtimeHealth: agent.runtimeHealth, controlState: control,
                        providerMapping: nil,
                        terminal: agent.terminal.map { AgentTerminalRecord(terminalId: $0.terminalId, open: $0.open) },
                        terminalShare: agent.terminalShare == AgentTerminals.defaultShare ? nil : agent.terminalShare,
                        terminalStackedShare: agent.terminalStackedShare == AgentTerminals.defaultShare ? nil : agent.terminalStackedShare
                    )
                },
                paneLayout: nil, paneTerminals: nil
            )
        }
        // Scratch itself is written as absent, so a restart on another day
        // comes back to *that* day's Scratch.
        switch snapshot.selection.context {
        case let .workspace(id) where id == snapshot.scratchWorkspaceId: state.navigation = nil
        case let .workspace(id): state.navigation = .workspace(id.rawValue)
        case let .agent(id): state.navigation = .agent(id.rawValue)
        }
        state.sidebar = SidebarState(width: snapshot.sidebar.width, collapsed: snapshot.sidebar.collapsed, order: snapshot.workspaceOrder.map(\.rawValue))
        state.splitRatio = snapshot.splitRatio
        state.zoomOffset = Double(snapshot.terminalZoomOffset)
        state.smartButtons = snapshot.smartButtons
        try V.validate(state)
        return state
    }

    /// `applySnapshot`: re-project the model onto an existing state, keeping
    /// the fields the model does not own (each Agent's provider mapping).
    public static func apply(_ snapshot: AppSnapshot, to state: PersistedAppState) throws -> PersistedAppState {
        var projected = try self.state(from: snapshot)
        for workspaceIndex in projected.workspaces.indices {
            guard let previous = state.workspaces.first(where: { $0.workspaceId == projected.workspaces[workspaceIndex].workspaceId }) else {
                continue
            }
            for agentIndex in projected.workspaces[workspaceIndex].agents.indices {
                let id = projected.workspaces[workspaceIndex].agents[agentIndex].agentId
                guard let previousAgent = previous.agents.first(where: { $0.agentId == id }) else { continue }
                projected.workspaces[workspaceIndex].agents[agentIndex].providerMapping = previousAgent.providerMapping
            }
        }
        var next = state
        next.workspaces = projected.workspaces
        next.navigation = projected.navigation
        next.sidebar = projected.sidebar
        next.splitRatio = projected.splitRatio
        next.zoomOffset = projected.zoomOffset
        next.smartButtons = projected.smartButtons
        try V.validate(next)
        return next
    }
}
