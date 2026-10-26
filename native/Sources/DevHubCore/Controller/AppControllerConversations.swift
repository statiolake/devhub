// Port of the GUI-Agent half of apps/desktop/src/main/shell/appController.ts
// that is not the window's: the records kept beside `state.json` for GUI
// Agents (`drafts`, `limitResumes`), Continue in Terminal / Continue in GUI
// (`continueAgentIn`, `continueAgentElsewhere`), the questions a stop, a
// restart or a continue raises when nothing can draw them
// (`requestCloseAgent`, `requestRestartAgent`, `raiseCloseConfirmation`),
// the conversation view's transport as `registerConversationIpc` is handed
// it, and the session sweep's view of the model (`startRuntimes`'
// `SessionSweeper` options).

import Foundation

/// The GUI Agents' records beside `state.json`: each one's unsent draft
/// (`drafts.json`) and what its conversation decided about a usage limit
/// (`limit-resumes.json`). Each lives as long as its Agent.
public final class GuiAgentRecords: Sendable {
    public let drafts: AgentDrafts
    public let limitResumes: AgentRecords<LimitResumeRecord>

    public init(drafts: AgentDrafts, limitResumes: AgentRecords<LimitResumeRecord>) {
        self.drafts = drafts
        self.limitResumes = limitResumes
    }

    /// Loaded before any view exists, so a file that would not read is said
    /// with the other startup failures (`refused`, each a
    /// `persistence_degraded` detail). Pruned to the Agents `accounted` has.
    public static func load(beside statePath: String, accounted: @escaping @Sendable () -> Set<String>) throws
        -> (records: GuiAgentRecords, refused: [String])
    {
        let directory = (statePath as NSString).deletingLastPathComponent
        let drafts = try AgentDrafts.load(Path.join(directory, "drafts.json"), accounted: accounted)
        let limits = try AgentRecords.load(Path.join(directory, "limit-resumes.json"), LIMIT_RESUME_RECORDS, accounted: accounted)
        return (GuiAgentRecords(drafts: drafts.drafts, limitResumes: limits.records), [drafts.refused, limits.refused].compactMap { $0 })
    }

    /// A draft, and a record, go when their Agent does. `prune` compares
    /// before it writes.
    func prune(_ log: @Sendable (String) -> Void) {
        do {
            try drafts.prune()
            try limitResumes.prune()
        } catch {
            log("[devhub] the GUI Agents' records could not be pruned: \(failureText(error))")
        }
    }
}

extension AppController {
    /// `raiseCloseConfirmation`: a question the model raised, put on screen.
    /// Every way of stopping or carrying on an Agent ends in an outcome, and
    /// one that says `confirmation_required` is a question nobody has been
    /// asked yet: it goes to the one sheet that asks it.
    @discardableResult
    func raiseCloseConfirmation(_ outcome: IntentOutcome) -> IntentOutcome {
        if case let .confirmationRequired(id, _, purpose) = outcome {
            openModal(.closeConfirmation(confirmationId: id.rawValue, purpose: purpose))
        }
        return outcome
    }

    /// `requestCloseAgent`: `Cmd+Q X` on an Agent. An idle Agent is stopped
    /// without a question — the model decides that — and then there is
    /// nothing to open.
    public func requestCloseAgent(_ agentId: AgentId) async throws {
        raiseCloseConfirmation(try await dispatchAwaiting(.stopAgent(agentId)))
    }

    /// `requestRestartAgent`: Restart Session, asking first exactly as the
    /// Sidebar's does — `/restart` and the chord cannot draw the question.
    public func requestRestartAgent(_ agentId: AgentId) async throws {
        raiseCloseConfirmation(try await dispatchAwaiting(.restartAgent(agentId)))
    }

    /// `continueAgentIn`: carry an Agent on in the other presentation,
    /// resuming `session`. A continue of an Agent that is not idle is a
    /// question first (`askAbout`), and whatever asked cannot draw it.
    public func continueAgentIn(_ agentId: AgentId, presentation: AgentPresentation, session: String?) async throws {
        raiseCloseConfirmation(try await dispatchAwaiting(.continueAgent(agentId, presentation: presentation, session: session)))
    }

    /// `continueAgentElsewhere`: the Sidebar row menu's Continue in Terminal
    /// / Continue in GUI, in whichever direction leaves the Agent's own
    /// presentation (the session found the way the conversation view finds it).
    public func continueAgentElsewhere(_ agentId: AgentId) async throws {
        guard let agents, let agent = coordinator.model.agent(agentId) else {
            throw ControlRefusal("no Agent \(agentId.rawValue) is open")
        }
        if agent.presentation == .gui {
            try await continueAgentIn(agentId, presentation: .tui, session: try await agents.conversationSession(agentId))
        } else {
            try await continueAgentIn(agentId, presentation: .gui, session: try await agents.terminalSession(agentId))
        }
    }

    /// The conversation view's transport (`registerConversationIpc`), every
    /// one of its acts the controller's own. nil without GUI Agents.
    public func conversationTransport() async -> ConversationTransport? {
        guard let guiAgents, let agentRecords else { return nil }
        let agents = self.agents
        return await ConversationTransport.start(ConversationTransportOptions(
            conversations: guiAgents, drafts: agentRecords.drafts,
            continueIn: { [weak self] agentId, presentation, session in
                try await self?.continueAgentIn(agentId, presentation: presentation, session: session)
            },
            restart: { [weak self] agentId in try await self?.requestRestartAgent(agentId) },
            terminalSession: { agentId in
                guard let agents else { throw ControlRefusal("DevHub's agents are not running yet.") }
                return try await agents.terminalSession(agentId)
            },
            openFile: { [weak self] agentId, path, selection in
                try await self?.openFromConversation(agentId: agentId, path: path, selection: selection)
            }))
    }

    /// The sweep forgot a machine: out of the persisted set, and saved.
    func forgetSessionMachine(_ machine: RuntimeId) async {
        state.sessionMachines.removeAll { $0 == machine.rawValue }
        do {
            try await saveState()
        } catch {
            log("[devhub] the state could not be saved after the sweep forgot \(machine.rawValue): \(persistenceReason(error))")
        }
    }
}

/// The session sweep's world (`SessionSweepWorld`) on the controller: the
/// model's accounting as the last snapshot says it, the persisted machines,
/// and each machine's tmux and host files.
public struct ControllerSweepWorld: SessionSweepWorld {
    private let controller: AppController
    private let adapterFor: @Sendable (RuntimeId) async throws -> any SweepAdapter
    private let hostFilesFor: @Sendable (RuntimeId) async throws -> any AgentHostFiles

    public init(
        controller: AppController, adapter: @escaping @Sendable (RuntimeId) async throws -> any SweepAdapter,
        hostFiles: @escaping @Sendable (RuntimeId) async throws -> any AgentHostFiles
    ) {
        self.controller = controller
        adapterFor = adapter
        hostFilesFor = hostFiles
    }

    /// On WP3's runtimes: each machine's adapter, and the GUI Agent host
    /// directories of this DevHub profile there.
    public init(
        controller: AppController, runtimes: TerminalRuntimes, profileTag: String,
        machine: @escaping @Sendable (RuntimeId) throws -> any MachineRuntime = { try MachineRuntimes.runtime(for: $0) }
    ) {
        self.init(
            controller: controller, adapter: { try await runtimes.adapter(for: try machine($0)) },
            hostFiles: { try await agentHostFiles(RuntimeHostMachine(try machine($0)), profileTag: profileTag) })
    }

    public func adapter(for machine: RuntimeId) async throws -> any SweepAdapter { try await adapterFor(machine) }
    public func hostFiles(for machine: RuntimeId) async throws -> any AgentHostFiles { try await hostFilesFor(machine) }
    public func accounted() -> SweepAccounting { controller.mirror.sweepAccounting() }
    public func workspaceMachines() -> [RuntimeId] { controller.mirror.workspaceMachines() }
    public func remembered() -> [String] { controller.mirror.sessionMachines() }

    public func forget(_ machine: RuntimeId) {
        let controller = self.controller
        Task { await controller.forgetSessionMachine(machine) }
    }
}
