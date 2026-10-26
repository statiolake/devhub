// Port of apps/desktop/src/main/agent/conversation/mcpSignIn.test.ts
//
// The MCP sign-in runner against a fake `mcp login`: a shell script that
// prints an authorization URL whose `redirect_uri` names a localhost port,
// reads what is typed at its prompt, and ends the way the test says. The
// machine is a fake too — its terminal a child process over pipes, its
// forwards a record — so what is checked is what the runner asks of a
// machine and what it shows, for an Agent on this Mac and on a host alike.

import Foundation
import XCTest
@testable import DevHubCore

private let AUTHORIZE =
    "https://auth.example.com/authorize?response_type=code&client_id=abc"
    + "&redirect_uri=http%3A%2F%2Flocalhost%3A43117%2Fcallback&state=xyz"

/// `<program> mcp login <server>`, as far as the runner can tell: it says
/// what it was run as and with, prints the URL (in colour, as a CLI does),
/// waits for a line at its prompt, and ends with `$FAKE_EXIT`.
private let FAKE_CLI = """
    #!/bin/sh
    printf 'args=%s cwd=%s term=%s profile=%s\\n' "$*" "$(pwd)" "$TERM" "$PROFILE_VAR"
    printf '\\033[1mOpen this URL:\\033[0m %s\\n' '\(AUTHORIZE)'
    printf 'Paste the redirect URL: '
    read line
    printf 'got %s\\n' "$line"
    exit "${FAKE_EXIT:-0}"

    """

/// A terminal that is a child process over pipes: enough for a script that reads a line.
private final class PipePty: PseudoTerminal, @unchecked Sendable {
    let process = Process()
    let input = Pipe()
    let output = Pipe()
    private let lock = NSLock()
    private var data: [@Sendable (Data) -> Void] = []
    private var exit: [@Sendable (Int32?) -> Void] = []
    var pid: Int32 { process.processIdentifier }

    init(_ launch: PtyLaunch) throws {
        process.executableURL = URL(fileURLWithPath: launch.file)
        process.arguments = launch.args
        process.currentDirectoryURL = URL(fileURLWithPath: launch.cwd)
        process.environment = launch.env
        process.standardInput = input
        process.standardOutput = output
        process.standardError = output
    }

    func onData(_ listener: @escaping @Sendable (Data) -> Void) { lock.withLock { data.append(listener) } }
    func onExit(_ listener: @escaping @Sendable (Int32?) -> Void) { lock.withLock { exit.append(listener) } }
    // A terminal turns the Return it is sent into the newline `read` waits for.
    func write(_ bytes: Data) {
        let text = String(decoding: bytes, as: UTF8.self).replacingOccurrences(of: "\r", with: "\n")
        input.fileHandleForWriting.write(Data(text.utf8))
    }
    func resize(_ size: TerminalSize) {}
    // SIGKILL: a child Foundation starts from a test's thread may have
    // SIGTERM blocked on Linux (PLAN.md §3.4); a real PTY's child does not.
    func kill() { killHard(process.processIdentifier) }
    func pause() {}
    func resume() {
        let listeners = lock.withLock { (data, exit) }
        let ended = DispatchGroup()
        ended.enter()
        output.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                ended.leave()
                return
            }
            for listener in listeners.0 { listener(chunk) }
        }
        let process = self.process
        process.terminationHandler = { _ in
            // Once its output is all read: a terminal says it ended after what it printed.
            ended.notify(queue: .global()) {
                let code = process.terminationReason == .exit ? process.terminationStatus : nil
                for listener in listeners.1 { listener(code) }
            }
        }
        do {
            try process.run()
        } catch {
            for listener in listeners.1 { listener(nil) }
        }
    }
}

private func killHard(_ pid: Int32) { _ = kill(pid, SIGKILL) }

private enum Kind { case local, remote, refusing }

/// The Agent's machine: this Mac (`to` nil, nothing forwarded) or a host
/// (`to` its name), or one whose forward is refused.
private final class FakeSignInMachine: McpSignInMachine, @unchecked Sendable {
    let kind: Kind
    let extra: [String: String]
    var environmentFailure: String?
    private let lock = NSLock()
    private var _launched: [PtyLaunch] = []
    private var _forwards: [Int] = []
    private var _closed: [Int] = []
    var launched: [PtyLaunch] { lock.withLock { _launched } }
    var forwards: [Int] { lock.withLock { _forwards } }
    var closed: [Int] { lock.withLock { _closed } }

    init(_ kind: Kind, _ extra: [String: String] = [:]) {
        self.kind = kind
        self.extra = extra
    }

    func environment() async throws -> [String: String] {
        if let environmentFailure { throw Said(environmentFailure) }
        return ["PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"].merging(extra) { $1 }
    }

    func resolveProgram(_ configured: String, searchPath: String) async -> ProgramResolution {
        await LocalRuntime().resolveProgram(configured, searchPath: searchPath)
    }

    func spawnPty(_ launch: PtyLaunch) throws -> any PseudoTerminal {
        lock.withLock { _launched.append(launch) }
        return try PipePty(launch)
    }

    func forwardLoopbackPort(_ port: Int) async throws -> LoopbackForward {
        lock.withLock { _forwards.append(port) }
        if kind == .refusing {
            throw Said("DevHub could not forward localhost:\(port) to build-box: bind: Address already in use")
        }
        return LoopbackForward(
            to: kind == .remote ? "build-box" : nil,
            close: { [self] in lock.withLock { _closed.append(port) } })
    }
}

private final class Shown: @unchecked Sendable {
    private let lock = NSLock()
    private var _all: [McpSignIn] = []
    private var _reconnects: [Int] = []
    var all: [McpSignIn] { lock.withLock { _all } }
    var reconnects: [Int] { lock.withLock { _reconnects } }
    func add(_ signIn: McpSignIn) { lock.withLock { _all.append(signIn) } }
    func reconnected() { lock.withLock { _reconnects.append(_all.count) } }
}

final class McpSignInTests: XCTestCase {
    nonisolated(unsafe) static let scratch = ScratchDirectories()
    nonisolated(unsafe) static var bin = ""
    static var program: String { "\(bin)/fake-cli" }
    static var folder: String { "\(bin)/workspace" }

    override class func setUp() {
        // Real, so that the script's `pwd` names it the way it is written here.
        bin = URL(fileURLWithPath: scratch.make("mcp-login")).resolvingSymlinksInPath().path
        try? Data(FAKE_CLI.utf8).write(to: URL(fileURLWithPath: program))
        chmod(program, 0o700)
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    }

    override class func tearDown() { scratch.removeAll() }

    private func run(
        _ machine: any McpSignInMachine, _ env: [String: String] = [:],
        signedIn: @escaping @Sendable () async throws -> Void = {}
    ) -> (McpSignInRun, Shown) {
        let shown = Shown()
        let started = McpSignInRun(
            McpSignInPlan(
                machine: machine, program: Self.program,
                env: ["PROFILE_VAR": "from-profile"].merging(env) { $1 }, cwd: Self.folder, server: "linear",
                show: { shown.add($0) },
                signedIn: {
                    shown.reconnected()
                    try await signedIn()
                }))
        return (started, shown)
    }

    /// Until the command has asked for the redirect URL.
    private func prompted(_ shown: Shown) async throws {
        let deadline = Date().addingTimeInterval(10)
        while !(shown.all.last?.output.contains("Paste the redirect URL") ?? false) {
            if Date() > deadline { throw Said("the command never prompted") }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    func testRunsTheProfilesProgramAsMcpLoginInTheWorkspaceAndShowsWhatItPrintsWithoutEscapes() async throws {
        let machine = FakeSignInMachine(.local)
        let (started, shown) = run(machine)
        XCTAssertEqual(
            shown.all.first, McpSignIn(server: "linear", phase: .running, output: "", callback: nil, failure: nil))
        try await prompted(shown)
        try started.input("http://localhost:43117/callback?code=c0de&state=xyz")
        let ended = await started.finished
        let launched = machine.launched[0]
        XCTAssertEqual(launched.file, Self.program)
        XCTAssertEqual(launched.args, ["mcp", "login", "linear"])
        XCTAssertEqual(launched.cwd, Self.folder)
        XCTAssertEqual(launched.env["PROFILE_VAR"], "from-profile")
        XCTAssertEqual(launched.env["TERM"], "dumb")
        XCTAssertTrue(ended.output.contains("args=mcp login linear cwd=\(Self.folder) term=dumb profile=from-profile"), ended.output)
        XCTAssertTrue(ended.output.contains("Open this URL: \(AUTHORIZE)"))
        XCTAssertFalse(ended.output.contains("\u{1B}"))
        XCTAssertTrue(ended.output.contains("got http://localhost:43117/callback?code=c0de&state=xyz"))
        XCTAssertEqual(ended.phase, .succeeded)
        XCTAssertNil(ended.failure)
    }

    func testHasTheServerReconnectedOnceItHasSignedInBeforeItSaysItIsDone() async throws {
        let (started, shown) = run(FakeSignInMachine(.remote))
        try await prompted(shown)
        try started.input("")
        _ = await started.finished
        XCTAssertEqual(shown.reconnects.count, 1)
        XCTAssertEqual(shown.all[shown.reconnects[0]...].map(\.phase), [McpSignInPhase.succeeded])
    }

    func testSaysSoWhenTheServerCouldNotBeReconnectedAfterSigningIn() async throws {
        let (started, shown) = run(FakeSignInMachine(.local)) {
            throw Said("The conversation has stopped taking input")
        }
        try await prompted(shown)
        try started.input("")
        let ended = await started.finished
        XCTAssertEqual(ended.phase, .succeeded)
        XCTAssertEqual(ended.failure, "Signed in, but the server could not be reconnected: The conversation has stopped taking input")
    }

    func testOnAHostForwardsTheCallbackPortThereWhileTheCommandRunsAndTakesItAwayWhenItEnds() async throws {
        let machine = FakeSignInMachine(.remote)
        let (started, shown) = run(machine)
        try await prompted(shown)
        XCTAssertEqual(machine.forwards, [43117])
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(shown.all.first { $0.callback != nil }?.callback, .forwarded(port: 43117, to: "build-box"))
        XCTAssertEqual(machine.closed, [])
        try started.input("")
        let ended = await started.finished
        XCTAssertEqual(machine.closed, [43117])
        XCTAssertEqual(ended.phase, .succeeded)
    }

    func testOnThisMacHasNothingForwardedAndSaysNothingAboutIt() async throws {
        let (started, shown) = run(FakeSignInMachine(.local))
        try await prompted(shown)
        try started.input("")
        let ended = await started.finished
        XCTAssertNil(ended.callback)
        XCTAssertTrue(shown.all.allSatisfy { $0.callback == nil })
    }

    func testTakesTheForwardAwayWhenTheCommandFailsTooAndSaysHowItEnded() async throws {
        let machine = FakeSignInMachine(.remote)
        let (started, shown) = run(machine, ["FAKE_EXIT": "3"])
        try await prompted(shown)
        try started.input("")
        let ended = await started.finished
        XCTAssertEqual(shown.reconnects, [])
        XCTAssertEqual(machine.closed, [43117])
        XCTAssertEqual(ended.phase, .failed)
        XCTAssertEqual(ended.failure, "`\(Self.program) mcp login linear` ended with exit code 3.")
    }

    func testGoesOnWhenTheForwardIsRefusedSayingWhy() async throws {
        let (started, shown) = run(FakeSignInMachine(.refusing))
        try await prompted(shown)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(
            shown.all.last?.callback,
            .unforwarded(port: 43117, why: "DevHub could not forward localhost:43117 to build-box: bind: Address already in use"))
        try started.input("http://localhost:43117/callback?code=c0de")
        let ended = await started.finished
        XCTAssertEqual(ended.phase, .succeeded)
    }

    func testEndsAsCancelledWhenThePersonCancelsIt() async throws {
        let machine = FakeSignInMachine(.remote)
        let (started, shown) = run(machine)
        try await prompted(shown)
        started.cancel()
        let ended = await started.finished
        XCTAssertEqual(ended.phase, .failed)
        XCTAssertEqual(ended.failure, "The sign-in was cancelled.")
        XCTAssertEqual(machine.closed, [43117])
        assertThrowsMatching("the sign-in to linear is not running") { try started.input("late") }
    }

    func testFailsWithTheReasonWhenTheMachineCannotRunIt() async throws {
        let machine = FakeSignInMachine(.remote)
        machine.environmentFailure = "build-box could not be reached: timed out"
        let (started, _) = run(machine)
        let ended = await started.finished
        XCTAssertEqual(ended.phase, .failed)
        XCTAssertEqual(ended.failure, "build-box could not be reached: timed out")
    }

    func testFailsSayingSoWhenTheProgramIsNotThere() async throws {
        let machine = FakeSignInMachine(.local)
        let started = McpSignInRun(
            McpSignInPlan(
                machine: machine, program: "no-such-cli-anywhere", env: ["PATH": "/nowhere"], cwd: Self.folder,
                server: "linear", show: { _ in }, signedIn: {}))
        let ended = await started.finished
        XCTAssertEqual(ended.phase, .failed)
        XCTAssertEqual(ended.failure, "DevHub could not find 'no-such-cli-anywhere' on PATH (looked in: /nowhere).")
        XCTAssertEqual(machine.launched, [])
    }
}

final class SignInOutputTests: XCTestCase {
    func testIsReadAsTheTerminalWouldShowIt() {
        XCTAssertEqual(
            terminalText("\u{1B}[1mbold\u{1B}[0m line\r\nwaiting 1\rwaiting 2\n\u{1B}]0;title\u{07}done\u{07}"),
            "bold line\nwaiting 2\ndone")
    }

    func testNamesTheCallbackPortOfTheFirstAuthorizationURLWithALoopbackRedirectUri() {
        XCTAssertEqual(callbackPort("Open \(AUTHORIZE) now"), 43117)
        XCTAssertEqual(
            callbackPort(
                "https://a.example.com/?redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb "
                    + "https://b.example.com/?redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcb"),
            5555)
        XCTAssertNil(callbackPort("https://example.com/docs"))
        XCTAssertNil(callbackPort("https://a.example.com/?redirect_uri=http%3A%2F%2Flocalhost%2Fcb"))
    }
}
