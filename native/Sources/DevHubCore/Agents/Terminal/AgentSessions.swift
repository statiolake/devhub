// Port of apps/desktop/src/main/agent/sessions.ts.
//
// An Agent is a tmux session.
//
// An Agent session lives on DevHub's own tmux socket, carries DevHub's own
// markers, and is attached by the same `tmux attach-session` client over the
// same PTY as every workspace terminal — so scrollback, copy mode, resize and
// byte-for-byte input are the terminal's, not an imitation of them.
//
// - **Launch** creates one marked session whose *session command* is the
//   Agent. tmux destroys a session when its command exits, so the Agent's own
//   lifetime is the session's lifetime and nothing has to be told about it.
// - **Reconcile** lists marked Agent sessions. An id in the list is alive; an
//   id the model has and the list does not is an Agent that ended.
// - **Terminate** kills that exact session by the runtime's exact-record rule.
// - **Respawn** runs the Agent's command again in that session's own pane, so
//   a terminal Agent's CLI is restarted without its session ever ending.

import Foundation

/// One Agent, as the runtime needs to see it to start it.
public struct AgentLaunchSpec: Sendable, Equatable {
    public var target: AgentTerminalTarget
    public var command: AgentSessionCommand
    public init(target: AgentTerminalTarget, command: AgentSessionCommand) {
        self.target = target
        self.command = command
    }
}

/// One live Agent session, as reconciliation reports it.
public struct LiveAgentSession: Sendable, Equatable {
    public var agentId: String
    public var workspaceId: String
    /// `#{window_activity}`: when this Agent's pane last wrote, to the second.
    public var activity: String?
}

public final class AgentSessions: @unchecked Sendable {
    private let runtimeFor: @Sendable (RuntimeId) async throws -> TmuxTerminalRuntime
    private let lock = NSLock()
    /// Agents whose launch has not finished.
    ///
    /// Between the row appearing and the session existing there is a window
    /// in which the reconciler would find nothing and correctly conclude "not
    /// running" from a snapshot that is simply early. Naming the window exactly
    /// lets an exit be reported on the very next round.
    private var launching: [String: Int] = [:]

    public init(runtimeFor: @escaping @Sendable (RuntimeId) async throws -> TmuxTerminalRuntime) {
        self.runtimeFor = runtimeFor
    }

    /// Whether Agents can run on one machine: a fact about a machine.
    public func availableOn(_ machine: RuntimeId) async -> Bool {
        (try? await runtimeFor(machine).adapterAvailable) ?? false
    }

    private func markLaunching(_ agentId: String) {
        lock.withLock { launching[agentId, default: 0] += 1 }
    }

    private func unmarkLaunching(_ agentId: String) {
        lock.withLock {
            let left = (launching[agentId] ?? 1) - 1
            launching[agentId] = left > 0 ? left : nil
        }
    }

    /// Start one Agent and do not return until its session has been read back.
    /// A launch that throws leaves nothing behind to clean up.
    public func launch(_ spec: AgentLaunchSpec, cancel: CancellationToken = CancellationToken()) async throws {
        markLaunching(spec.target.agentId)
        defer { unmarkLaunching(spec.target.agentId) }
        let runtime = try await runtimeFor(spec.target.machine)
        try await runtime.launchAgent(spec.target, command: spec.command, cancel: cancel)
    }

    /// Start an Agent's command again in the pane it runs in — a terminal
    /// Agent's Restart Session. It counts as launching meanwhile, so a round
    /// that reads the socket mid-way cannot call it ended.
    public func respawn(_ spec: AgentLaunchSpec, cancel: CancellationToken = CancellationToken()) async throws {
        markLaunching(spec.target.agentId)
        defer { unmarkLaunching(spec.target.agentId) }
        let runtime = try await runtimeFor(spec.target.machine)
        try await runtime.respawnAgent(spec.target, command: spec.command, cancel: cancel)
    }

    /// True while this Agent's session is still being created.
    public func isLaunching(_ agentId: String) -> Bool {
        lock.withLock { launching[agentId] != nil }
    }

    /// Every Agent session on one machine's socket right now.
    public func list(_ machine: RuntimeId, cancel: CancellationToken = CancellationToken()) async throws -> [LiveAgentSession] {
        try await round(machine, captureIds: [], cancel: cancel).live
    }

    /// One reconcile round: which Agents are alive, and the screens asked for,
    /// out of one tmux invocation.
    public func round(
        _ machine: RuntimeId,
        captureIds: [String],
        cancel: CancellationToken = CancellationToken()
    ) async throws -> (live: [LiveAgentSession], screens: [String: AgentScreen]) {
        let runtime = try await runtimeFor(machine)
        let round = try await runtime.agentRound(captureIds, cancel: cancel)
        if round.marker == .wrong { throw portFailure(.conflict) }
        let live: [LiveAgentSession] = round.agents.compactMap { one in
            guard case .agent(let agentId, let workspaceId, _) = one.record else { return nil }
            return LiveAgentSession(agentId: agentId, workspaceId: workspaceId, activity: one.activity)
        }
        var screens: [String: AgentScreen] = [:]
        for (agentId, reading) in round.screens {
            screens[agentId] = AgentScreen(agentId: agentId, screen: reading.screen, oscTitle: reading.oscTitle, oscProgress: "")
        }
        return (live, screens)
    }

    /// Send one Agent a block of text, as though a person had pasted it. The
    /// decision to send is not made here — see `AgentInjectionQueue`.
    public func inject(_ machine: RuntimeId, agentId: String, workspaceId: String, text: String, cancel: CancellationToken = CancellationToken()) async throws {
        let runtime = try await runtimeFor(machine)
        try await runtime.injectAgentText(
            .agent(agentId: agentId, workspaceId: workspaceId, sessionName: TmuxNames.agentSession(agentId: agentId)),
            text: text,
            cancel: cancel
        )
    }

    /// The pid of the process an Agent's pane runs: its command, and so its CLI's.
    public func panePid(_ machine: RuntimeId, agentId: String, workspaceId: String, cancel: CancellationToken = CancellationToken()) async throws -> Int {
        let runtime = try await runtimeFor(machine)
        return try await runtime.agentPanePid(
            .agent(agentId: agentId, workspaceId: workspaceId, sessionName: TmuxNames.agentSession(agentId: agentId)),
            cancel: cancel
        )
    }

    /// Kill one Agent's session. An Agent that is already gone is not a
    /// failure; a same-named session that is not this Agent's throws.
    ///
    /// The record comes off the server, not out of the model: the compensation
    /// for a launch that failed after creating its session has no row.
    public func terminate(_ machine: RuntimeId, agentId: String, cancel: CancellationToken = CancellationToken()) async throws {
        let runtime = try await runtimeFor(machine)
        let listed = try await runtime.listAgents(cancel: cancel).first { listed in
            if case .agent(let id, _, _) = listed.record { return id == agentId }
            return false
        }
        guard let listed else { return }
        try await runtime.closeAgent(listed.record, cancel: cancel)
    }
}
