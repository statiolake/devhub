// Port of the terminal-Agent half of apps/desktop/src/main/shell/agentWiring.ts
// (`wireAgents`: launch, stop, the reconcile round, the injection queue,
// `terminalSession`, `restartTerminal`, `observe`, `deliver`, `terminate`).
//
// Where DevHub's terminal Agents get built: turning a launch into a session
// command, and turning the list of live sessions into the model's vocabulary.
//
// The GUI half (a GUI Agent's conversation, host files, MCP sign-in) is WP5's
// and WP6's; it plugs into the same round through `GuiAgentRounds`, so the two
// presentations are read from two places — a screen, a conversation — into
// the one reading a round reports, and deliver through the one queue and gate.

import Foundation

/// How an Agent is drawn (`AgentPresentation`).
public enum AgentPresentation: String, Sendable, Equatable {
    /// A terminal Agent: its CLI's own TUI in the pane.
    case tui
    /// A GUI Agent: DevHub's conversation view over the CLI's structured mode.
    case gui
}

/// One Agent of the model, as a round needs to see it.
public struct TerminalAgentRecord: Sendable, Equatable {
    public var id: String
    public var displayName: String
    public var profile: TerminalAgentProfile
    public var presentation: AgentPresentation
    public init(id: String, displayName: String, profile: TerminalAgentProfile, presentation: AgentPresentation) {
        self.id = id
        self.displayName = displayName
        self.profile = profile
        self.presentation = presentation
    }
}

/// One open Workspace and its Agents, as a round needs to see it.
public struct TerminalAgentWorkspace: Sendable, Equatable {
    public var id: String
    public var root: String
    public var agents: [TerminalAgentRecord]
    public init(id: String, root: String, agents: [TerminalAgentRecord]) {
        self.id = id
        self.root = root
        self.agents = agents
    }
}

/// The live model: the authority on which Agents exist and where they run.
public protocol TerminalAgentModel: Sendable {
    func workspaces() -> [TerminalAgentWorkspace]
    /// Which machine a Workspace's Agents run on: the one its folder is on.
    func machine(of workspaceId: String) -> RuntimeId?
}

extension TerminalAgentModel {
    func place(of agentId: String) -> (agent: TerminalAgentRecord, workspace: TerminalAgentWorkspace, machine: RuntimeId)? {
        for workspace in workspaces() {
            if let agent = workspace.agents.first(where: { $0.id == agentId }), let machine = machine(of: workspace.id) {
                return (agent, workspace, machine)
            }
        }
        return nil
    }

    func hasAgent(_ agentId: String) -> Bool {
        workspaces().contains { $0.agents.contains { $0.id == agentId } }
    }
}

/// What a GUI Agent's round reads and sends, supplied by the conversation
/// layer. Absent: a round reports no GUI Agent's status.
public protocol GuiAgentRounds: Sendable {
    /// Once a round, and only here: the round is the clock.
    func reading(machine: RuntimeId, agent: TerminalAgentRecord, root: String) async -> TerminalAgentReading
    func send(agentId: String, text: String) async throws
    /// A GUI Agent's session is gone: stop following it, say how it ended
    /// unless DevHub ended it, and take its host files away.
    func ended(machine: RuntimeId, agent: TerminalAgentRecord) async
    /// DevHub is stopping it: what `ended` must not report as news.
    func stopping(_ agentId: String, _ stopping: Bool)
}

/// One Agent's reading this round.
public struct TerminalAgentReading: Sendable, Equatable {
    public var status: TerminalAgentStatus
    public var activity: String?
    /// An `AgentFailureCode` and its sentence, when the Agent has failed.
    public var failure: AgentRefusal?
    public init(status: TerminalAgentStatus, activity: String?, failure: AgentRefusal? = nil) {
        self.status = status
        self.activity = activity
        self.failure = failure
    }
}

/// A refused operation's code (`AgentFailureCode`) and sentence.
public struct AgentRefusal: Sendable, Equatable {
    public var code: String
    public var detail: String?
    public init(code: String, detail: String?) {
        self.code = code
        self.detail = detail
    }
}

/// One Agent's observation, as the model applies it (`AgentObservation`).
public struct TerminalAgentObservation: Sendable, Equatable {
    public var agentId: String
    public var status: TerminalAgentStatus
    /// `healthy` or `unavailable` (`RuntimeHealth`).
    public var runtimeHealth: String
    public var activity: String?
    public var injection: AgentInjection
    public var failure: AgentRefusal?
}

/// A complete provider reconciliation. Missing provider Agents are `exited`.
public struct TerminalAgentReconciliation: Sendable, Equatable {
    public var observations: [TerminalAgentObservation]
    public var exited: [String]
}

/// How a launch ended (`AgentLaunchResult`).
public enum TerminalAgentLaunchResult: Sendable, Equatable {
    case started
    case failed(AgentRefusal)
}

/// How a stop ended (`AgentStopResult`).
public enum TerminalAgentStopResult: Sendable, Equatable {
    case stopped
    case failed(AgentRefusal)
}

public final class TerminalAgentWiring: @unchecked Sendable {
    public let sessions: AgentSessions
    private let model: any TerminalAgentModel
    private let machineRuntime: @Sendable (RuntimeId) throws -> any MachineRuntime
    private let gui: (any GuiAgentRounds)?
    /// The `/devhub` skill's arguments for a launch on a machine
    /// (`withDevhubSkill`, WP7): the argv the profile's CLI is given.
    private let skilled: @Sendable (RuntimeId, TerminalAgentProfile, [String]) async -> [String]
    private let log: @Sendable (String) -> Void

    private let detector = AgentStatusDetector()
    private let activity = AgentActivityReader()
    public let injections = AgentInjectionQueue()
    /// Which Agents have written something since the last round.
    private let freshness: AgentScreenFreshness
    private let lock = NSLock()
    /// Each Agent's activity marker as the last round found it. An Agent with
    /// no entry here has never been listed, and is not asked about until it
    /// has been: capturing a session that does not exist yet would cost every
    /// Agent behind it in the batch its screen.
    private var lastMarkers: [String: String?] = [:]

    public init(
        runtimeFor: @escaping @Sendable (RuntimeId) async throws -> TmuxTerminalRuntime,
        model: any TerminalAgentModel,
        machineRuntime: @escaping @Sendable (RuntimeId) throws -> any MachineRuntime = { try MachineRuntimes.runtime(for: $0) },
        gui: (any GuiAgentRounds)? = nil,
        skilled: (@Sendable (RuntimeId, TerminalAgentProfile, [String]) async -> [String])? = nil,
        freshnessClock: AgentScreenFreshness.Clock? = nil,
        log: (@Sendable (String) -> Void)? = nil
    ) {
        sessions = AgentSessions(runtimeFor: runtimeFor)
        self.model = model
        self.machineRuntime = machineRuntime
        self.gui = gui
        self.skilled = skilled ?? { _, _, args in args }
        freshness = AgentScreenFreshness(clock: freshnessClock)
        self.log = log ?? { line in FileHandle.standardError.write(Data((line + "\n").utf8)) }
    }

    // MARK: Launch and stop

    /// Start a terminal Agent: its profile's CLI as the session command.
    ///
    /// A failure stays a `failed` result rather than a throw, so the row is
    /// retryable rather than pretending, and says what `portRefusal` says.
    public func launch(workspaceId: String, agentId: String, profile: TerminalAgentProfile, workspaceRoot: String) async -> TerminalAgentLaunchResult {
        do {
            guard let machine = model.machine(of: workspaceId) else {
                throw portFailure(.failed, detail: "the Workspace this Agent belongs to is no longer open")
            }
            let args = await skilled(machine, profile, profile.args)
            try await sessions.launch(AgentLaunchSpec(
                target: AgentTerminalTarget(machine: machine, agentId: agentId, workspaceId: workspaceId, root: workspaceRoot),
                command: TerminalAgentCommand.sessionCommand(profile, args: args)
            ))
            return .started
        } catch {
            let refusal = TerminalAgentCommand.portRefusal(error)
            return .failed(AgentRefusal(code: refusal.code, detail: refusal.detail ?? RuntimeFailureText.of(error)))
        }
    }

    private func machineOfAgent(_ agentId: String) -> RuntimeId? {
        model.place(of: agentId)?.machine
    }

    /// Stop an Agent's session; a GUI Agent's conversation goes with it.
    private func stopAgent(_ machine: RuntimeId, _ agentId: String) async throws {
        let agent = model.place(of: agentId)?.agent
        let isGui = agent?.presentation == .gui
        if isGui { gui?.stopping(agentId, true) }
        defer { if isGui { gui?.stopping(agentId, false) } }
        try await sessions.terminate(machine, agentId: agentId)
        if isGui, let agent { await gui?.ended(machine: machine, agent: agent) }
    }

    /// Stop one Agent. An Agent whose Workspace has gone has no machine to be
    /// stopped on, and no session either. A stop that did not stop leaves the
    /// Agent retryable rather than pretending it is gone.
    public func stop(_ agentId: String) async -> TerminalAgentStopResult {
        guard let machine = machineOfAgent(agentId) else { return .stopped }
        do {
            try await stopAgent(machine, agentId)
            return .stopped
        } catch {
            let refusal = TerminalAgentCommand.portRefusal(error)
            return .failed(AgentRefusal(code: refusal.code, detail: refusal.detail))
        }
    }

    /// Stop every Agent of a workspace, and say so if one did not stop.
    /// "Already gone" is success; anything else throws, and the close reports
    /// *that step* as the one that failed.
    public func closeWorkspaceAgents(_ workspaceId: String) async throws {
        guard let workspace = model.workspaces().first(where: { $0.id == workspaceId }),
              let machine = model.machine(of: workspaceId)
        else { return }
        for agent in workspace.agents { try await stopAgent(machine, agent.id) }
    }

    // MARK: The round

    /// One round: the socket's Agent sessions, matched against the model's.
    ///
    /// There is a single source of truth and it is `list-sessions`. An id it
    /// carries is an Agent whose command is still running; an id the model has
    /// and the list does not is an Agent that ended — except an Agent whose
    /// launch has not returned yet.
    public func reconcile(machine: RuntimeId, agentId: String? = nil) async throws -> TerminalAgentReconciliation {
        let health = await sessions.availableOn(machine) ? "healthy" : "unavailable"
        // The Agents this round is *about*, read before the socket is asked.
        // A round that listed sessions first and then read the model would
        // judge an Agent launched in between against a list taken before it
        // existed.
        var asked: [(agent: TerminalAgentRecord, workspace: TerminalAgentWorkspace)] = []
        for workspace in model.workspaces() where model.machine(of: workspace.id) == machine {
            for agent in workspace.agents where agentId == nil || agent.id == agentId {
                asked.append((agent, workspace))
            }
        }
        // Which screens this round will read, decided before it runs, from the
        // last round's markers. A GUI Agent has no screen to read.
        let markersBefore = lock.withLock { lastMarkers }
        let captureIds = asked
            .filter { $0.agent.presentation == .tui }
            .map(\.agent.id)
            .filter { id in markersBefore[id] != nil && freshness.shouldCapture(id, marker: markersBefore[id] ?? nil) }
        let round = try await sessions.round(machine, captureIds: captureIds)
        let live = Set(round.live.map(\.agentId))
        var markers: [String: String?] = [:]
        for one in round.live { markers[one.agentId] = .some(one.activity) }
        lock.withLock { lastMarkers = markers }

        var observations: [TerminalAgentObservation] = []
        var exited: [String] = []
        for (agent, workspace) in asked {
            // And read the model again at the end: an Agent that went away
            // while the screens were being captured is news the model already
            // has.
            if !model.hasAgent(agent.id) { continue }
            if !live.contains(agent.id) {
                if sessions.isLaunching(agent.id) { continue }
                detector.forget(agent.id)
                activity.forget(agent.id)
                freshness.forget(agent.id)
                // An Agent that ended takes with it anything it was never told:
                // said out loud rather than dropped in silence.
                for undelivered in injections.forget(agent.id) {
                    log("[devhub] agent \(agent.id) ended with text never delivered (\(undelivered.state.rawValue)): \(String(undelivered.text.prefix(120)))")
                }
                if agent.presentation == .gui { await gui?.ended(machine: machine, agent: agent) }
                exited.append(agent.id)
                continue
            }
            let reading: TerminalAgentReading
            let send: @Sendable (String) async throws -> Void
            if agent.presentation == .gui, let gui {
                reading = await gui.reading(machine: machine, agent: agent, root: workspace.root)
                let id = agent.id
                send = { text in try await gui.send(agentId: id, text: text) }
            } else {
                reading = observe(marker: markers[agent.id] ?? nil, screen: round.screens[agent.id], agentId: agent.id, kind: agent.profile.kind.rawValue)
                let sessions = self.sessions
                let id = agent.id, workspaceId = workspace.id
                send = { text in try await sessions.inject(machine, agentId: id, workspaceId: workspaceId, text: text) }
            }
            // The send happens here, on the reading this round settled on,
            // because this is the only place that knows the Agent is idle *now*.
            await deliver(agent.id, status: reading.status, send: send)
            observations.append(TerminalAgentObservation(
                agentId: agent.id,
                status: reading.status,
                runtimeHealth: health,
                activity: reading.activity,
                injection: injections.state(agent.id, status: reading.status),
                failure: reading.failure
            ))
        }
        return TerminalAgentReconciliation(observations: observations, exited: exited)
    }

    /// One Agent's status this round, and what it says it is doing.
    ///
    /// The screen this round did not *ask* for is an Agent that has written
    /// nothing since it was last read: the detector is told so. The screen it
    /// asked for and did not get is a capture that failed: the row keeps what
    /// it had. Only a screen that arrived is a new status.
    func observe(marker: String?, screen: AgentScreen?, agentId: String, kind: String) -> TerminalAgentReading {
        guard let screen else {
            if !freshness.shouldCapture(agentId, marker: marker) {
                return TerminalAgentReading(status: detector.unchanged(agentId), activity: activity.showing(agentId))
            }
            return TerminalAgentReading(status: detector.showing(agentId), activity: activity.showing(agentId))
        }
        // Only a capture that arrived counts.
        freshness.captured(agentId, marker: marker)
        return TerminalAgentReading(status: detector.status(kind: kind, screen: screen), activity: activity.activity(screen))
    }

    /// Send one Agent whatever is due for it. A failure is kept on the queue
    /// rather than thrown: the next round will try again.
    private func deliver(_ agentId: String, status: TerminalAgentStatus, send: @Sendable (String) async throws -> Void) async {
        guard let text = injections.due(agentId, status: status) else { return }
        do {
            try await send(text)
            injections.sent(agentId)
        } catch {
            injections.failed(agentId, reason: RuntimeFailureText.of(error))
        }
    }

    // MARK: Injection

    /// Queue what DevHub means to say. Which state it starts in is the whole of
    /// what a caller varies: there is no second path for "send this one
    /// straight away".
    public func queueInjection(_ agentId: String, text: String, review: Bool) throws -> String {
        let id = UUID().uuidString.lowercased()
        try injections.queue(agentId, AgentInjectionIntent(id: id, text: text, state: review ? .pendingReview : .confirmed))
        return id
    }

    public func confirmInjection(_ agentId: String, injectionId: String, text: String) throws -> Bool {
        try injections.confirm(agentId, intentId: injectionId, text: text)
    }

    public func cancelInjection(_ agentId: String, injectionId: String) -> Bool {
        injections.cancel(agentId, intentId: injectionId)
    }

    // MARK: Session of a terminal Agent

    struct NotATerminalAgent: Error, CustomStringConvertible {
        let description: String
    }

    /// The session a terminal Claude or Codex Agent's CLI is in, for a GUI
    /// Agent to go on with. Found from the Agent's own processes, looked for
    /// again on every ask; a refusal says what was in the pane, and is logged.
    public func terminalSession(_ agentId: String) async throws -> String {
        guard let place = model.place(of: agentId) else {
            throw NotATerminalAgent(description: "there is no running Agent \(agentId)")
        }
        if place.agent.presentation != .tui {
            throw NotATerminalAgent(description: "\(place.agent.displayName) is not a terminal Agent")
        }
        do {
            let runtime = try machineRuntime(place.machine)
            let pid = try await sessions.panePid(place.machine, agentId: agentId, workspaceId: place.workspace.id)
            return try await TerminalAgentSessionLookup.terminalSession(
                runtime, kind: place.agent.profile.kind, profileEnv: place.agent.profile.env, panePid: pid
            )
        } catch {
            log("[devhub] the session of terminal Agent \(agentId) (\(place.agent.profile.kind.rawValue)) could not be told: \(RuntimeFailureText.of(error))")
            throw error
        }
    }

    /// Restart Session for a terminal Claude or Codex Agent: its CLI started
    /// again in its own tmux pane, on the session it is in now, with the
    /// command, arguments and variables a launch of its profile runs. Refused,
    /// saying why, when the session cannot be told — never started on a new
    /// conversation instead.
    public func restartTerminal(_ agentId: String) async throws {
        guard let place = model.place(of: agentId) else {
            throw NotATerminalAgent(description: "there is no running Agent \(agentId)")
        }
        if place.agent.presentation != .tui {
            throw NotATerminalAgent(description: "\(place.agent.displayName) is not a terminal Agent")
        }
        let session = try await terminalSession(agentId)
        let profile = place.agent.profile
        // The launch's own argv with the session it is in now put where a
        // resumed launch puts one, so a profile's own `--continue`, or the
        // session it was first launched on, is never a second session.
        let args = try TerminalAgentCommand.withSession(
            profile.kind,
            args: profile.args,
            session: try TerminalAgentCommand.resumeArgs(profile.kind, session: session)
        )
        try await sessions.respawn(AgentLaunchSpec(
            target: AgentTerminalTarget(machine: place.machine, agentId: agentId, workspaceId: place.workspace.id, root: place.workspace.root),
            command: TerminalAgentCommand.sessionCommand(profile, args: await skilled(place.machine, profile, args))
        ))
    }
}
