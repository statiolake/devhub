// Port of apps/desktop/src/main/agent/conversation/mcpSignIn.ts
//
// Signing in to one of a GUI Agent's MCP servers: the CLI's own documented
// `<cli> mcp login <server>`, run by DevHub on the Agent's machine and shown
// in the MCP panel as it goes.
//
// Both CLIs have the command (Claude Code's CLI reference, "claude mcp
// login"; Codex's `codex mcp login`) and neither has a way to run the flow
// from inside a structured session, so the command is the one way for both,
// run the same way: the Agent's profile's program with the profile's
// environment, in the Agent's Workspace folder, on the machine the Agent runs
// on — the same CLI configuration the Agent reads, so the credentials land
// where the Agent looks for them.
//
// # A terminal, not pipes
//
// `claude mcp login` needs an interactive terminal: where it cannot open a
// browser (over SSH) it prints the authorization URL and asks for the
// redirect URL to be pasted back at a prompt. So it runs on a pseudo-terminal
// (`MachineRuntime.spawnPty`), what it prints is shown as text with the
// terminal's escapes taken out, and a line the person types in the panel is
// written to it as a line typed at that prompt. `TERM=dumb`: what reads the
// output is not a terminal emulator, and saying so keeps a CLI from drawing
// for one. The terminal is as wide as a URL can be long, so no URL is broken
// in two.
//
// # The browser's way back
//
// The authorization URL's `redirect_uri` is `http://localhost:<port>/…` on
// the machine the command runs on, where it listens for the browser. The
// browser is this Mac's, so for an Agent on a host DevHub forwards that port
// there for as long as the command runs (`forwardLoopbackPort`: `ssh -O
// forward -L` over the host's master; nothing on this Mac, where the port is
// already the same port). It is taken away when the command ends, however it
// ends. A forward that cannot be made is said in the panel and the sign-in
// goes on: pasting the redirect URL at the prompt still finishes it.
//
// # The program
//
// A PTY's child is started by `execve`, which looks nothing up, where the TS
// app's node-pty searches `PATH`; so the profile's program is looked up on
// the machine first, on the `PATH` the command runs with, the way node-pty
// would find it.

import Foundation

/// What a sign-in needs of the Agent's machine.
public protocol McpSignInMachine: Sendable {
    func environment() async throws -> [String: String]
    func resolveProgram(_ configured: String, searchPath: String) async -> ProgramResolution
    func spawnPty(_ launch: PtyLaunch) throws -> any PseudoTerminal
    func forwardLoopbackPort(_ port: Int) async throws -> LoopbackForward
}

/// A runtime, as the machine a sign-in runs on.
public struct RuntimeSignInMachine: McpSignInMachine {
    public let runtime: any MachineRuntime
    public init(_ runtime: any MachineRuntime) { self.runtime = runtime }
    public func environment() async throws -> [String: String] { try await runtime.environment() }
    public func resolveProgram(_ configured: String, searchPath: String) async -> ProgramResolution {
        await runtime.resolveProgram(configured, searchPath: searchPath)
    }
    public func spawnPty(_ launch: PtyLaunch) throws -> any PseudoTerminal { try runtime.spawnPty(launch) }
    public func forwardLoopbackPort(_ port: Int) async throws -> LoopbackForward {
        try await runtime.forwardLoopbackPort(port)
    }
}

public struct McpSignInPlan: Sendable {
    public var machine: any McpSignInMachine
    /// The Agent's profile's program (`claude`, `codex`): never its arguments.
    public var program: String
    /// The profile's environment, over the machine's own.
    public var env: [String: String]
    /// The Agent's Workspace folder, on that machine.
    public var cwd: String
    public var server: String
    /// Told every change of how the sign-in stands, the last one included.
    public var show: @Sendable (McpSignIn) -> Void
    /// What to do once the command has signed in: have the Agent's CLI
    /// reconnect the server with the new credentials. A failure of it is the
    /// sign-in's to say.
    public var signedIn: @Sendable () async throws -> Void

    public init(
        machine: any McpSignInMachine, program: String, env: [String: String], cwd: String, server: String,
        show: @escaping @Sendable (McpSignIn) -> Void, signedIn: @escaping @Sendable () async throws -> Void
    ) {
        self.machine = machine
        self.program = program
        self.env = env
        self.cwd = cwd
        self.server = server
        self.show = show
        self.signedIn = signedIn
    }
}

/// Wide enough that no authorization URL wraps: a CLI that breaks its lines
/// at the terminal's width would otherwise put a newline in the middle of it.
private let COLUMNS = 4096

/// Escape sequences a terminal program writes: CSI, OSC, and the two-byte ones.
private let ESCAPES = try! NSRegularExpression(
    pattern: #"\x{1B}\[[0-?]*[ -/]*[@-~]|\x{1B}\][^\x{07}\x{1B}]*(?:\x{07}|\x{1B}\\)|\x{1B}[@-Z\\-_]"#)
/// The control characters a text view drops.
private let CONTROLS = try! NSRegularExpression(pattern: #"[\x{00}-\x{08}\x{0B}\x{0C}\x{0E}-\x{1F}\x{7F}]"#)

private func replacing(_ regex: NSRegularExpression, in text: String) -> String {
    regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
}

/// What a terminal program printed, as the text a person would read on the
/// terminal: escapes gone, and a line a carriage return went back over is
/// what was written over it last.
public func terminalText(_ printed: String) -> String {
    replacing(ESCAPES, in: printed)
        .replacingOccurrences(of: "\r\n", with: "\n")
        .components(separatedBy: "\n")
        .map { line in
            // A progress line redrawn in place: what is left is the last drawing.
            let parts = line.components(separatedBy: "\r").filter { !$0.isEmpty }
            return replacing(CONTROLS, in: parts.last ?? "")
        }
        .joined(separator: "\n")
}

private let URLS = try! NSRegularExpression(pattern: #"https?://[^\s"'<>`]+"#)
private let LOOPBACK: Set<String> = ["localhost", "127.0.0.1", "[::1]", "::1"]

/// The value of `name` in a URL's query, as `URLSearchParams.get` reads it:
/// `+` is a space, the rest percent-decoded.
private func searchParam(_ url: URLComponents, _ name: String) -> String? {
    guard let query = url.percentEncodedQuery else { return nil }
    for pair in query.split(separator: "&", omittingEmptySubsequences: false) {
        let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        let key = String(parts[0]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding
        guard key == name else { continue }
        let value = parts.count > 1 ? String(parts[1]) : ""
        return value.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? value
    }
    return nil
}

/// The port an authorization URL in `text` has the browser come back to:
/// the port of its `redirect_uri`, when that is a loopback address. The
/// first such URL decides.
public func callbackPort(_ text: String) -> Int? {
    for match in URLS.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
        guard let range = Range(match.range, in: text) else { continue }
        // Text that only looked like a URL, or a `redirect_uri` that is not
        // one, names no port to forward.
        guard let found = URLComponents(string: String(text[range])), found.scheme != nil,
            let uri = searchParam(found, "redirect_uri"), let redirect = URLComponents(string: uri),
            let scheme = redirect.scheme?.lowercased(), let host = redirect.host?.lowercased(),
            LOOPBACK.contains(host), let port = redirect.port
        else { continue }
        // A URL's port is empty when it is its scheme's own (`URL.port`).
        if (scheme == "http" && port == 80) || (scheme == "https" && port == 443) { continue }
        return port
    }
    return nil
}

/// Why a sign-in could not start its program.
private struct SignInFailure: Error, CustomStringConvertible {
    let description: String
}

/// One run of `<program> mcp login <server>`. It starts as it is made; how
/// it stands is told to `plan.show`, and `finished` settles with how it
/// ended — it never fails: whatever stopped it is its `failure`, in the panel.
public final class McpSignInRun: @unchecked Sendable {
    public let server: String
    private let plan: McpSignInPlan
    /// Recursive: `show` may ask the run how it stands.
    private let lock = NSRecursiveLock()
    private var current: McpSignIn
    private var printed = Data()
    private var pty: (any PseudoTerminal)?
    private var cancelled = false
    private var forward: Task<LoopbackForward?, Never>?
    private var run: Task<McpSignIn, Never>?

    public init(_ plan: McpSignInPlan) {
        self.plan = plan
        server = plan.server
        current = McpSignIn(server: plan.server, phase: .running, output: "", callback: nil, failure: nil)
        plan.show(current)
        run = Task { [self] in await self.whole() }
    }

    /// How it ended, once it has.
    public var finished: McpSignIn {
        get async { await lock.withLock { run! }.value }
    }

    public var state: McpSignIn { lock.withLock { current } }

    /// A line the person typed in the panel, written as if typed at the command's prompt.
    public func input(_ text: String) throws {
        try lock.withLock {
            guard let pty, current.phase == .running else {
                throw AdapterRefusal("the sign-in to \(server) is not running, so it takes nothing typed")
            }
            pty.write(Data("\(text)\r".utf8))
        }
    }

    /// Stop the command; the sign-in ends as cancelled.
    public func cancel() {
        lock.withLock {
            guard current.phase == .running else { return }
            cancelled = true
            pty?.kill()
        }
    }

    private func show(_ change: (inout McpSignIn) -> Void) {
        lock.withLock {
            change(&current)
            plan.show(current)
        }
    }

    /// The whole run, and its one root: anything that stopped it — the
    /// machine's environment unreadable, the command not starting, a forward
    /// that could not be taken away — is the sign-in's failure, shown where
    /// the sign-in is.
    private func whole() async -> McpSignIn {
        var failures: [String] = []
        var exitCode: Int32?
        do {
            exitCode = try await command()
        } catch {
            failures.append(RuntimeFailureText.of(error))
        }
        // However the command ended, the forward goes with it.
        do {
            try await closeForward()
        } catch {
            failures.append(RuntimeFailureText.of(error))
        }
        if failures.isEmpty && exitCode != 0 {
            let wasCancelled = lock.withLock { cancelled }
            failures.append(
                wasCancelled
                    ? "The sign-in was cancelled."
                    : "`\(plan.program) mcp login \(plan.server)` ended \(exitCode.map { "with exit code \($0)" } ?? "without an exit code")."
            )
        }
        if !failures.isEmpty {
            show {
                $0.phase = .failed
                $0.failure = failures.joined(separator: " ")
            }
            return state
        }
        do {
            try await plan.signedIn()
        } catch {
            show {
                $0.phase = .succeeded
                $0.failure = "Signed in, but the server could not be reconnected: \(RuntimeFailureText.of(error))"
            }
            return state
        }
        show { $0.phase = .succeeded }
        return state
    }

    /// Run the command to its end: its exit code.
    private func command() async throws -> Int32? {
        var env = try await plan.machine.environment().merging(plan.env) { _, profile in profile }
        env["TERM"] = "dumb"
        env["NO_COLOR"] = "1"
        if lock.withLock({ cancelled }) { return nil }
        let resolution = await plan.machine.resolveProgram(plan.program, searchPath: env["PATH"] ?? "")
        guard let file = resolution.path else {
            throw SignInFailure(description: resolution.unavailableMessage ?? "DevHub could not find \(plan.program).")
        }
        if lock.withLock({ cancelled }) { return nil }
        let pty = try plan.machine.spawnPty(
            PtyLaunch(
                file: file, args: ["mcp", "login", plan.server], cwd: plan.cwd, cols: COLUMNS, rows: 40, pixelWidth: 0,
                pixelHeight: 0, env: env))
        lock.withLock { self.pty = pty }
        return await withCheckedContinuation { (exited: CheckedContinuation<Int32?, Never>) in
            let once = Guarded(false)
            pty.onExit { code in
                if once.with({ done in
                    defer { done = true }
                    return !done
                }) {
                    exited.resume(returning: code)
                }
            }
            pty.onData { [self] bytes in
                lock.withLock {
                    printed.append(bytes)
                    let output = terminalText(String(decoding: printed, as: UTF8.self))
                    show { $0.output = output }
                    forwardOnce()
                }
            }
            pty.resume()
        }
    }

    /// Forward the callback port, once the command has printed a URL naming one.
    private func forwardOnce() {
        guard forward == nil, let port = callbackPort(current.output) else { return }
        let machine = plan.machine
        forward = Task { [self] in
            do {
                let made = try await machine.forwardLoopbackPort(port)
                if let to = made.to { show { $0.callback = .forwarded(port: port, to: to) } }
                return made
            } catch {
                // The sign-in goes on without it: the redirect URL can still be
                // pasted at the command's prompt, and the panel says so.
                show { $0.callback = .unforwarded(port: port, why: RuntimeFailureText.of(error)) }
                return nil
            }
        }
    }

    private func closeForward() async throws {
        let forward = lock.withLock { self.forward }
        try await forward?.value?.close()
    }
}
