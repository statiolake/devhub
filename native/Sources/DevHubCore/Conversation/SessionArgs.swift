// Port of the argv half of apps/desktop/src/main/agent/conversation/resume.ts
// (`resumeArgs`, `withSession`, `resumedSession`, `codexStructuredArgs`) and
// of codex/argv.ts: how a CLI's argv picks the session it goes on with. The
// listing and reading of sessions is WP6's; the GUI host composes every CLI
// it starts again with these, so they are here.

import Foundation

/// The CLIs whose sessions DevHub can pick: the GUI Agents' kinds.
public enum SessionCLIKind: String, Hashable, Sendable {
    case claude, codex
}

public struct NoSessionsError: Error, CustomStringConvertible, Equatable {
    public let message: String
    public var description: String { message }
}

/// How each CLI's terminal mode is told to go on with a session.
public func resumeArgs(_ kind: SessionCLIKind, _ session: String) -> [String] {
    switch kind {
    case .claude: return ["--resume", session]
    case .codex: return ["resume", session]
    }
}

/// The CLI's argv for a session: `args` with every argument that picks a
/// session taken out, and `session` — the arguments that pick this one
/// (`resumeArgs`, a rewind's cut), or none for a new session — at the end.
///
/// The one place a session is put into an argv: a launch that resumes, a
/// continue, a `/resume` and a rewind all compose theirs here, so an argv
/// that already picked a session (a resumed launch's record, a profile's own
/// `--continue`) never carries two for the CLI to choose between.
public func withSession(_ kind: SessionCLIKind, _ args: [String], _ session: [String]) -> [String] {
    var kept: [String] = []
    var at = 0
    while at < args.count {
        let taken = sessionArgumentsAt(kind, args, at)
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
private func sessionArgumentsAt(_ kind: SessionCLIKind, _ args: [String], _ at: Int) -> Int {
    let arg = args[at]
    let next = at + 1 < args.count ? args[at + 1] : nil
    let withValue = next != nil && !next!.hasPrefix("-") ? 2 : 1
    switch kind {
    case .claude:
        if ["--continue", "-c", "--resume-drops-turn"].contains(arg) { return 1 }
        if arg.hasPrefix("--resume=") || arg.hasPrefix("--resume-session-at=") { return 1 }
        if arg == "--resume" || arg == "-r" { return withValue }
        // `--resume-session-at` always takes its value, whatever it looks like.
        if arg == "--resume-session-at" { return min(2, args.count - at) }
        return 0
    case .codex:
        if arg != "resume" { return 0 }
        if next == "--last" { return 2 }
        return withValue
    }
}

/// The session `resumeArgs` put at the end of `args`, if it put one there.
public func resumedSession(_ kind: SessionCLIKind, _ args: [String]) -> String? {
    guard args.count >= 2, let session = args.last else { return nil }
    return args[args.count - 2] == resumeArgs(kind, session)[0] ? session : nil
}

/// The argv that makes a Codex profile speak `app-server` instead of its TUI
/// (codex/argv.ts). The profile's own arguments come first and the
/// subcommand last, so that global options (`-c key=value`, `--profile`)
/// still apply.
public func appServerArgs(_ profileArgs: [String]) -> [String] {
    profileArgs + ["app-server"]
}

/// A Codex launch's argv in `app-server` mode, and the thread it resumes.
public func codexStructuredArgs(_ args: [String]) -> (args: [String], resumeThreadId: String?) {
    let thread = resumedSession(.codex, args)
    return (appServerArgs(thread == nil ? args : Array(args.dropLast(2))), thread)
}
