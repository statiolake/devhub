// Port of apps/desktop/src/main/runtime/runtime.ts (the `Runtime` interface and
// its value types), local runtime only.
//
// The machine a Workspace's folder is on, as a value.
//
// Everything DevHub runs for a Workspace — `git`, tmux, the Agent pane's PTY,
// the folder probes — runs *somewhere*, and that somewhere is a
// `MachineRuntime`: one interface with every way DevHub touches a Workspace's
// machine. The rule that makes it honest: every method on this interface must
// be answerable across a network, or it does not belong on it.
//
// Nothing on a runtime says which implementation it is. A caller that needs to
// know is a caller that is about to grow the branch this file exists to
// prevent; what it may read is `where`, which is a phrase for a sentence, and
// `cadence`, which is a number for a loop.
//
// Not ported here (out of WP3's scope, see PLAN.md): `watchGitDirectory`
// (WP4, needs `gitDirectory.ts`), `terminalLauncher` (VS Code workbench only).

import Foundation

/// What an answer bigger than its cap means.
///
/// tmux's answers are *identity* — a session list truncated halfway is not a
/// shorter list of sessions, it is a wrong one — so an over-long answer is a
/// failure; git's answers are read as text and truncated.
public enum ExecOverflow: Sendable {
    case truncate
    case fail(@Sendable () -> any Error)
}

/// How much of an answer DevHub will read, and what happens past it.
public struct MachineExecLimits: Sendable {
    public var stdoutBytes: Int
    public var stderrBytes: Int
    public var overflow: ExecOverflow

    public init(stdoutBytes: Int, stderrBytes: Int, overflow: ExecOverflow) {
        self.stdoutBytes = stdoutBytes
        self.stderrBytes = stderrBytes
        self.overflow = overflow
    }
}

public struct ExecRequest: Sendable {
    /// The program and its arguments — never a shell string.
    public var argv: [String]
    /// Absolute, on the runtime's machine.
    public var cwd: String?
    public var env: [String: String]?
    /// Anything secret, because argv is world-readable in `ps`.
    public var stdin: Data?
    public var deadline: OperationDeadline
    public var cancel: CancellationToken
    public var limits: MachineExecLimits
    /// Told every chunk of stdout and stderr as it arrives.
    public var onOutput: (@Sendable (Data) -> Void)?

    public init(
        argv: [String],
        cwd: String? = nil,
        env: [String: String]? = nil,
        stdin: Data? = nil,
        deadline: OperationDeadline,
        cancel: CancellationToken,
        limits: MachineExecLimits,
        onOutput: (@Sendable (Data) -> Void)? = nil
    ) {
        self.argv = argv
        self.cwd = cwd
        self.env = env
        self.stdin = stdin
        self.deadline = deadline
        self.cancel = cancel
        self.limits = limits
        self.onOutput = onOutput
    }
}

public struct ExecResult: Sendable, Equatable {
    /// The exit code, or nil when a signal ended the program.
    public var code: Int32?
    /// The signal that ended it, or nil.
    public var signal: Int32?
    public var stdout: Data
    public var stderr: Data

    public init(code: Int32?, signal: Int32?, stdout: Data, stderr: Data) {
        self.code = code
        self.signal = signal
        self.stdout = stdout
        self.stderr = stderr
    }

    public var success: Bool { code == 0 && signal == nil }
    public var stdoutText: String { String(decoding: stdout, as: UTF8.self) }
    public var stderrText: String { String(decoding: stderr, as: UTF8.self) }
}

/// A long-lived program whose output is read as it arrives, over pipes.
public struct StreamRequest: Sendable {
    public var argv: [String]
    public var cwd: String?
    public var env: [String: String]?
    /// Cancelling it is `kill()`.
    public var cancel: CancellationToken

    public init(argv: [String], cwd: String? = nil, env: [String: String]? = nil, cancel: CancellationToken) {
        self.argv = argv
        self.cwd = cwd
        self.env = env
        self.cancel = cancel
    }
}

/// How a stream's program ended, and the end of what it said on stderr.
public struct StreamEnd: Sendable, Equatable {
    public var code: Int32?
    public var signal: Int32?
    /// The last `streamStderrBytes` of it: the end is where a reason is.
    public var stderr: Data
}

/// What is at a path: the three answers a probe is allowed to give.
public enum FileKind: String, Sendable, Equatable {
    case directory, file, absent
}

// A path DevHub could not find out about is a `RuntimeFileError` (declared
// with WP4's `RepositoryRuntime`): not-there is an answer (`.absent`),
// could-not-look is that error, with the errno that said why.

/// One entry of a directory listing.
public struct DirEntry: Sendable, Equatable {
    public var name: String
    public var directory: Bool
    public init(name: String, directory: Bool) {
        self.name = name
        self.directory = directory
    }
}

/// What a loop over this machine is allowed to cost.
public struct RuntimeCadence: Sendable, Equatable {
    public var reconcileIntervalMs: Double
    public var repositoryPollMs: Double
    /// How recently a full repository round must have finished for focusing
    /// the window to skip asking again. See `Cadence`.
    public var repositoryFocusRefreshMinIntervalMs: Double
    /// nil means real filesystem events, not a poll.
    public var headWatchPollMs: Double?

    public init(
        reconcileIntervalMs: Double,
        repositoryPollMs: Double,
        repositoryFocusRefreshMinIntervalMs: Double,
        headWatchPollMs: Double?
    ) {
        self.reconcileIntervalMs = reconcileIntervalMs
        self.repositoryPollMs = repositoryPollMs
        self.repositoryFocusRefreshMinIntervalMs = repositoryFocusRefreshMinIntervalMs
        self.headWatchPollMs = headWatchPollMs
    }
}

/// What one machine is costing, for `devhub --metrics`.
public struct RuntimeReading: Sendable, Equatable {
    public var id: String
    public var connected: Bool
    public var masterPid: Int32?
    public var medianRoundTripMs: Double
    public var reconcileIntervalMs: Double
    public var execsLastMinute: Int
    public var muxSessionsHeld: Int
    public var muxSessionsWaiting: Int
    public var muxFallbacks: Int
    /// Names, never values: a reading is pasted into issues.
    public var loginEnvironmentNames: [String]
    public var lastFailure: String?
}

/// A configured program, looked up on one machine
/// (`SettingsResolvedRuntimeWire`).
public enum ProgramResolution: Sendable, Equatable {
    case absolutePath(String)
    case commandName(String)
    case unavailable(configured: String, lookup: ProgramLookup, where: String?)

    /// The path to run, when there is one.
    public var path: String? {
        switch self {
        case .absolutePath(let value), .commandName(let value): return value
        case .unavailable: return nil
        }
    }
}

/// How an unavailable program was looked for.
public enum ProgramLookup: Sendable, Equatable {
    case explicit(path: String)
    case path(directories: [String])
}

extension ProgramResolution {
    /// How many search directories one message may name before it summarises.
    public static let maxSearchedDirectories = 12

    /// The sentence a missing runtime is always shown as, wherever it is shown
    /// (`runtimeUnavailableMessage`). nil for a resolved program.
    public var unavailableMessage: String? {
        guard case .unavailable(let configured, let lookup, let whereText) = self else { return nil }
        let place = whereText ?? ""
        switch lookup {
        case .explicit(let path):
            let named = path == configured ? path : "'\(configured)' (\(path))"
            return "DevHub could not find \(named)\(place)."
        case .path(let directories):
            let name = "'\(configured)'"
            if directories.isEmpty { return "DevHub could not find \(name) on PATH\(place) (PATH is empty)." }
            let shown = directories.prefix(ProgramResolution.maxSearchedDirectories)
            let more = directories.count - shown.count
            let searched = shown.joined(separator: ", ") + (more > 0 ? ", and \(more) more" : "")
            return "DevHub could not find \(name) on PATH\(place) (looked in: \(searched))."
        }
    }
}

/// The tmux one machine runs, and the environment it needs to run in.
public enum TmuxProgram: Sendable, Equatable {
    case resolved(path: String, environment: [String: String])
    case unavailable(reason: String)
}

/// The user tmux config as it is on one machine *now*, and which one it is.
///
/// The digest is recorded on the server (`@devhub-config-digest`), and a
/// server whose digest is not this one is a server running a config the
/// person is no longer editing. `UserTmuxConfig.none` is the absence:
/// `/dev/null`, which the bootstrap's `source-file` can still name.
public struct UserTmuxConfig: Sendable, Equatable {
    /// The path on that machine; `/dev/null` when there is no config.
    public var path: String
    /// What is in it, or `"none"`.
    public var digest: String

    public init(path: String, digest: String) {
        self.path = path
        self.digest = digest
    }

    public static let none = UserTmuxConfig(path: "/dev/null", digest: "none")

    /// The identity of one config's bytes, computed the one way.
    public static func digest(of text: String) -> String {
        String(SHA256.hex(text).prefix(32))
    }
}

/// A program, its arguments, and what it needs in its environment.
public struct MachineCommand: Sendable, Equatable {
    public var file: String
    public var args: [String]
    public var env: [String: String]
    public init(file: String, args: [String], env: [String: String]) {
        self.file = file
        self.args = args
        self.env = env
    }
}

/// A `forwardLoopbackPort` held open.
public struct LoopbackForward: Sendable {
    /// The machine the port now reaches; nil when nothing had to be forwarded.
    public var to: String?
    public var close: @Sendable () async throws -> Void
}

/// One running `spawnStream`.
///
/// `stdout` is every byte the program wrote, in order, and it ends when the
/// program's stdout closes. `ended` answers once with how it ended. The
/// program's stdin is a pipe DevHub holds open and never writes to: EOF on it
/// is how a program learns that DevHub let go of it.
public protocol ByteStream: Sendable {
    var stdout: AsyncStream<Data> { get }
    func ended() async throws -> StreamEnd
    /// Stop it. `ended` then answers with the signal. Idempotent.
    func kill()
}

/// One machine, behind one interface.
public protocol MachineRuntime: AnyObject, Sendable {
    /// `local`, or `ssh:<host>`. The key a per-host cache is filed under.
    var id: RuntimeId { get }
    /// For a sentence: `""` locally, `" on <host>"` remotely.
    var `where`: String { get }
    /// `$HOME` on that machine.
    func home() async throws -> String
    /// The environment a command DevHub runs on this machine runs in: the
    /// frozen launch environment. Resolved once per machine and then constant.
    func environment() async throws -> [String: String]

    func exec(_ request: ExecRequest) async throws -> ExecResult
    func spawnPty(_ launch: PtyLaunch) throws -> any PseudoTerminal
    func spawnStream(_ request: StreamRequest) throws -> any ByteStream

    /// What a configured program name means on this machine.
    func resolveProgram(_ configured: String, searchPath: String) async -> ProgramResolution
    /// The tmux this machine's adapter runs.
    func tmuxProgram(_ configured: String, searchPath: String) async -> TmuxProgram
    /// The user tmux config this machine's tmux will source, as a path on it.
    func userTmuxConfig(_ localPath: String) async -> UserTmuxConfig
    /// A directory on this machine DevHub may put its own short-lived files in.
    func scratchDirectory() async throws -> String

    func stat(_ path: String) async throws -> FileKind
    func readTextFile(_ path: String, maxBytes: Int) async throws -> String
    func writeTextFile(_ path: String, text: String, mode: Int) async throws
    /// Write a file only if the name is free; `false` when it was taken.
    func writeNewTextFile(_ path: String, text: String, mode: Int) async throws -> Bool
    func readdir(_ path: String) async throws -> [DirEntry]
    func removeTree(_ path: String) async throws
    func makeDirectory(_ path: String) async throws
    func realpath(_ path: String) async throws -> String

    /// A command meant for this machine, as one a PTY on this Mac can run.
    func commandFromHere(_ command: MachineCommand) async throws -> MachineCommand
    /// Make `localhost:<port>` on this Mac reach `localhost:<port>` there.
    func forwardLoopbackPort(_ port: Int) async throws -> LoopbackForward

    var cadence: RuntimeCadence { get }
    /// This Mac woke up. A hint; never throws, never waited on.
    func resumed()
    func reading() -> RuntimeReading
}
