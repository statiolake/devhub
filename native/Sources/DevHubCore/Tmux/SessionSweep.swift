// Port of apps/desktop/src/main/shell/sessionSweep.ts.
//
// The sessions DevHub owns that nothing in DevHub accounts for any more.
//
// A DevHub session outlives the app on purpose. The price of that is a session
// whose row is gone — a state file that never got written, a Workspace closed
// while its host was unreachable, an Agent whose launch was compensated for.
// Such a session holds a process for the life of its tmux server with nothing
// left that can reach or stop it. So there is one sweep, machine-parameterised,
// asking **every machine DevHub has ever owned sessions on** — the persisted
// `session_machines` set and the machines in use now.
//
// **What it may kill.** Only what `markedSessions` returns, which is only what
// carries DevHub's whole marker tuple on DevHub's own socket under DevHub's own
// server protocol marker — so another DevHub profile's sessions and anybody's
// own tmux are never seen. Of those, `scratch` (the server's bootstrap anchor)
// is accounted for by nothing and reaped; a `ws-` session is accounted for by
// its Workspace, an `ag-` session by its Agent, a `tm-` session by its Agent
// terminal. The kill itself is the runtime's exact-record rule.
//
// **A GUI Agent's host files** (`~/.devhub/agents-<profile>/<id>`) follow the
// same rule, once its session is gone.
//
// **A machine that does not answer is not a failure.** It stays in the set and
// in `pending`, and is swept when a runtime for it next connects.

import Foundation

/// As much of a machine's tmux adapter as a sweep uses.
public protocol SweepAdapter: Sendable {
    /// False on a machine with no tmux: no server, so no sessions.
    var adapterAvailable: Bool { get }
    func markedSessions(cancel: CancellationToken) async throws -> [OwnedSessionRecord]
    func closeMarkedSession(_ record: OwnedSessionRecord, cancel: CancellationToken) async throws
}

extension TmuxTerminalRuntime: SweepAdapter {}

/// One machine's GUI Agent host directories, by the id of the Agent each
/// belongs to.
public protocol AgentHostFiles: Sendable {
    func list() async throws -> [String]
    func remove(_ agentId: String) async throws
}

/// What the model still accounts for, read fresh for every sweep.
public struct SweepAccounting: Sendable, Equatable {
    public var workspaces: Set<String>
    public var agents: Set<String>
    /// The Agents' terminals, by id.
    public var terminals: Set<String>
    public init(workspaces: Set<String> = [], agents: Set<String> = [], terminals: Set<String> = []) {
        self.workspaces = workspaces
        self.agents = agents
        self.terminals = terminals
    }
}

public protocol SessionSweepWorld: Sendable {
    /// One machine's adapter. Throws when the machine cannot be reached.
    func adapter(for machine: RuntimeId) async throws -> any SweepAdapter
    /// One machine's GUI Agent host directories. Throws like `adapter(for:)`.
    func hostFiles(for machine: RuntimeId) async throws -> any AgentHostFiles
    func accounted() -> SweepAccounting
    /// Every machine a Workspace is on right now, this one always among them.
    func workspaceMachines() -> [RuntimeId]
    /// The persisted set, as it was written: strings, not yet machines.
    func remembered() -> [String]
    /// Take one machine out of the persisted set, and save.
    func forget(_ machine: RuntimeId)
}

/// How one machine's sweep ended.
public enum SweepOutcome: Sendable, Equatable {
    case swept(reaped: Int)
    case postponed(reason: String)
}

public enum SessionSweep {
    /// The sessions on one machine that nothing accounts for. Every kind is
    /// named: a new kind of owned session is a compile error here rather than a
    /// session that is silently either always kept or always killed.
    public static func unaccountedSessions(_ sessions: [OwnedSessionRecord], accounted: SweepAccounting) -> [OwnedSessionRecord] {
        sessions.filter { session in
            switch session {
            case .scratch:
                // Only the tmux server's bootstrap anchor now — and the
                // folderless Scratch's terminal, for a state from before that —
                // and nothing accounts for it.
                return true
            case .workspace(let workspaceId, _):
                return !accounted.workspaces.contains(workspaceId)
            case .agent(let agentId, _, _):
                return !accounted.agents.contains(agentId)
            case .terminal(let terminalId, _, _):
                return !accounted.terminals.contains(terminalId)
            }
        }
    }
}

public final class SessionSweeper: @unchecked Sendable {
    private let world: any SessionSweepWorld
    private let log: @Sendable (String) -> Void
    private let lock = NSLock()
    private var pendingMachines: [RuntimeId] = []
    /// One sweep per machine at a time: two would race on the same kills.
    private var running: [RuntimeId: Task<SweepOutcome, Never>] = [:]

    public init(world: any SessionSweepWorld, log: (@Sendable (String) -> Void)? = nil) {
        self.world = world
        self.log = log ?? { line in FileHandle.standardError.write(Data((line + "\n").utf8)) }
    }

    /// The machines a sweep could not finish with, for `devhub --metrics`.
    public var pending: [RuntimeId] { lock.withLock { pendingMachines } }

    /// Every machine to ask: the persisted set and the machines in use now.
    public func machines() -> [RuntimeId] {
        var machines: [RuntimeId] = []
        for machine in world.workspaceMachines() where !machines.contains(machine) { machines.append(machine) }
        for raw in world.remembered() {
            do {
                let machine = try RuntimeId.parse(raw)
                if !machines.contains(machine) { machines.append(machine) }
            } catch {
                // A name this build cannot read is not a reason to refuse the
                // state file, and not a machine either.
                log("[devhub] sweep: \(raw) in session_machines names no machine \(error)")
            }
        }
        return machines
    }

    /// Ask every machine, at startup. One machine's failure is its own.
    public func sweepAll() async {
        for machine in machines() { _ = await sweep(machine) }
    }

    /// A machine started answering again: only one a sweep is waiting on.
    public func machineCameBack(_ machine: RuntimeId) {
        guard lock.withLock({ pendingMachines.contains(machine) }) else { return }
        Task { _ = await sweep(machine) }
    }

    @discardableResult
    public func sweep(_ machine: RuntimeId) async -> SweepOutcome {
        let task: Task<SweepOutcome, Never> = lock.withLock {
            if let existing = running[machine] { return existing }
            let task = Task { [self] in
                let outcome = await run(machine)
                lock.withLock { running[machine] = nil }
                return outcome
            }
            running[machine] = task
            return task
        }
        return await task.value
    }

    private func run(_ machine: RuntimeId) async -> SweepOutcome {
        var reaped = 0
        var removed = 0
        do {
            let adapter = try await world.adapter(for: machine)
            // No tmux on that machine is no server on it, and therefore no
            // DevHub sessions: a clean answer, not an unreachable one.
            if adapter.adapterAvailable {
                let cancel = CancellationToken()
                let stray = SessionSweep.unaccountedSessions(try await adapter.markedSessions(cancel: cancel), accounted: world.accounted())
                for session in stray {
                    try await adapter.closeMarkedSession(session, cancel: cancel)
                    reaped += 1
                }
            }
            // Read after the sessions are gone, so no host is still writing
            // into one.
            let files = try await world.hostFiles(for: machine)
            let agents = world.accounted().agents
            for agentId in try await files.list() where !agents.contains(agentId) {
                try await files.remove(agentId)
                removed += 1
            }
        } catch {
            let reason = RuntimeFailureText.of(error)
            lock.withLock { if !pendingMachines.contains(machine) { pendingMachines.append(machine) } }
            log("[devhub] sweep: \(machine) could not be swept (\(reason)); it will be asked again when it next connects")
            return .postponed(reason: reason)
        }
        lock.withLock { pendingMachines.removeAll { $0 == machine } }
        if reaped > 0 || removed > 0 {
            log("[devhub] sweep: closed \(reaped) session(s) and removed \(removed) Agent host directories on \(machine) that nothing in DevHub accounts for")
        } else if !world.workspaceMachines().contains(machine) {
            // Nothing left there and nothing here that uses it.
            world.forget(machine)
        }
        return .swept(reaped: reaped)
    }
}
