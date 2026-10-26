// Port of apps/desktop/src/main/shell/agentProfileCommand.ts, `portRefusal` of
// main/shell/agentFailure.ts, `terminalCommand` of main/shell/agentWiring.ts,
// and the session-argv half of main/agent/conversation/resume.ts
// (`resumeArgs`, `withSession`, `resumedSession`).

import Foundation

/// The kinds of Agent profile (`AgentProfile["kind"]`).
public enum AgentProfileKind: String, Sendable, Equatable, CaseIterable {
    case codex, claude, cursor, custom
}

/// A launch's profile, as much of it as a terminal Agent's command needs.
public struct TerminalAgentProfile: Sendable, Equatable {
    public var kind: AgentProfileKind
    public var command: String
    public var args: [String]
    public var env: [String: String]
    public init(kind: AgentProfileKind, command: String, args: [String], env: [String: String] = [:]) {
        self.kind = kind
        self.command = command
        self.args = args
        self.env = env
    }
}

/// A profile with no sessions to resume or pick (`custom`, `cursor`).
public struct NoSessionsForKind: Error, Equatable, CustomStringConvertible {
    public let kind: AgentProfileKind
    public let what: String
    public var description: String { "a \(kind.rawValue) Agent has no sessions to \(what)" }
}

/// A profile whose command was looked up, or the lookup that failed.
public enum ResolvedAgentProfile: Sendable, Equatable {
    case resolved(TerminalAgentProfile)
    case unavailable(ProgramResolution)
}

public enum TerminalAgentCommand {
    /// A profile with its command looked up and a launch's extra arguments
    /// added.
    ///
    /// **The profile's own arguments first, then the caller's, appended in the
    /// order they were given.** Nothing is deduplicated and nothing is
    /// reordered: an agent command reads its last flag as the winning one.
    /// The command is looked up on the Workspace's machine, the Agent's.
    public static func resolve(
        _ profile: TerminalAgentProfile,
        on runtime: any MachineRuntime,
        extraArgs: [String],
        searchPath: String
    ) async -> ResolvedAgentProfile {
        let resolved = await runtime.resolveProgram(profile.command, searchPath: searchPath)
        guard let path = resolved.path else { return .unavailable(resolved) }
        var resolvedProfile = profile
        resolvedProfile.command = path
        resolvedProfile.args = profile.args + extraArgs
        return .resolved(resolvedProfile)
    }

    /// What a terminal Agent's pane runs: the profile's program, `args`, and
    /// its own variables — one shape for a launch and a restart.
    public static func sessionCommand(_ profile: TerminalAgentProfile, args: [String]) -> AgentSessionCommand {
        AgentSessionCommand(file: profile.command, args: args, env: profile.env)
    }

    /// How each CLI's terminal mode is told to go on with a session.
    public static func resumeArgs(_ kind: AgentProfileKind, session: String) throws -> [String] {
        switch kind {
        case .claude: return ["--resume", session]
        case .codex: return ["resume", session]
        default: throw NoSessionsForKind(kind: kind, what: "resume")
        }
    }

    /// The CLI's argv for a session: `args` with every argument that picks a
    /// session taken out, and `session` at the end. The one place a session is
    /// put into an argv, so an argv that already picked one never carries two.
    public static func withSession(_ kind: AgentProfileKind, args: [String], session: [String]) throws -> [String] {
        var kept: [String] = []
        var at = 0
        while at < args.count {
            let taken = try sessionArgumentsAt(kind, args, at)
            if taken == 0 {
                kept.append(args[at])
                at += 1
            } else {
                at += taken
            }
        }
        return kept + session
    }

    /// How many of `args` from `at` on pick a session: 0 when `args[at]` does not.
    static func sessionArgumentsAt(_ kind: AgentProfileKind, _ args: [String], _ at: Int) throws -> Int {
        let arg = args[at]
        let next: String? = at + 1 < args.count ? args[at + 1] : nil
        let withValue = next != nil && !next!.hasPrefix("-") ? 2 : 1
        switch kind {
        case .claude:
            if ["--continue", "-c", "--resume-drops-turn"].contains(arg) { return 1 }
            if arg.hasPrefix("--resume=") || arg.hasPrefix("--resume-session-at=") { return 1 }
            if arg == "--resume" || arg == "-r" { return withValue }
            if arg == "--resume-session-at" { return 2 }
            return 0
        case .codex:
            if arg != "resume" { return 0 }
            if next == "--last" { return 2 }
            return withValue
        default:
            throw NoSessionsForKind(kind: kind, what: "pick")
        }
    }

    /// The session `resumeArgs` put at the end of `args`, if it put one there.
    public static func resumedSession(_ kind: AgentProfileKind, args: [String]) -> String? {
        guard kind == .claude || kind == .codex, args.count >= 2, let session = args.last else { return nil }
        return args[args.count - 2] == (try? resumeArgs(kind, session: session))?.first ? session : nil
    }

    /// What the Agent port's refusal is called, kind for kind (`portRefusal`).
    ///
    /// Every one of these used to arrive as "the agent runtime is unavailable",
    /// which sent the reader to look at a tmux that was working perfectly. They
    /// are four different things to do next. The code is an `AgentFailureCode`.
    public static func portRefusal(_ error: any Error) -> (code: String, detail: String?) {
        if case TerminalAgentSessionLookupError.notResumable(let detail) = error {
            return ("agent_profile_unavailable", detail)
        }
        guard let port = error as? PortFailure else { return ("tmux_command_failed", nil) }
        let code: String
        switch port.code {
        case .unavailable, .incompatible, .socketPathTooLong, .socketUnusable: code = "agent_runtime_unavailable"
        case .timedOut: code = "tmux_command_timed_out"
        case .conflict: code = "tmux_session_conflict"
        case .rootMissing, .rootInaccessible: code = "workspace_unavailable"
        default: code = "tmux_command_failed"
        }
        return (code, port.detail)
    }
}
