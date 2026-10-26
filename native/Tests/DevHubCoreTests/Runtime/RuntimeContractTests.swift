// Port of apps/desktop/src/main/runtime/runtime.contract.test.ts (the local
// runtime; `watchGitDirectory` is WP4's), cadence.test.ts, quote.test.ts and
// main/terminal/portFailure.test.ts, plus the PTY the attach transport opens.

import Foundation
import XCTest
@testable import DevHubCore

private let truncating = MachineExecLimits(stdoutBytes: 64 * 1024, stderrBytes: 8 * 1024, overflow: .truncate)

private func execOn(
    _ runtime: any MachineRuntime,
    _ argv: [String],
    cwd: String? = nil,
    stdin: Data? = nil,
    limits: MachineExecLimits = truncating,
    timeoutMs: Double = 10_000,
    cancel: CancellationToken = CancellationToken()
) async throws -> ExecResult {
    try await runtime.exec(ExecRequest(
        argv: argv, cwd: cwd, env: ["PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"],
        stdin: stdin, deadline: .within(timeoutMs), cancel: cancel, limits: limits
    ))
}

final class LocalRuntimeContractTests: XCTestCase {
    let scratch = ScratchDirectories()
    var runtime: LocalRuntime!
    var dir = ""

    override func setUp() {
        runtime = LocalRuntime()
        dir = scratch.make("runtime")
    }

    override func tearDown() { scratch.removeAll() }

    // MARK: exec

    func testAnswersWithWhatTheCommandWroteAndHowItEnded() async throws {
        let result = try await execOn(runtime, ["/bin/echo", "hello"])
        XCTAssertEqual(result.stdoutText, "hello\n")
        XCTAssertEqual(result.code, 0)
        XCTAssertNil(result.signal)
    }

    func testCarriesANonZeroExitRatherThanThrowingForIt() async throws {
        let result = try await execOn(runtime, ["/bin/sh", "-c", "exit 3"])
        XCTAssertEqual(result.code, 3)
    }

    func testKeepsStderrApartFromStdout() async throws {
        let result = try await execOn(runtime, ["/bin/sh", "-c", "echo out; echo err >&2"])
        XCTAssertEqual(result.stdoutText, "out\n")
        XCTAssertEqual(result.stderrText, "err\n")
    }

    func testPassesEachArgumentAsOneWordWhateverIsInIt() async throws {
        let awkward = "one two 'three' $HOME\nfour"
        let result = try await execOn(runtime, ["/bin/sh", "-c", "printf %s \"$1\"", "sh", awkward])
        XCTAssertEqual(result.stdoutText, awkward)
    }

    func testRunsWhereItWasToldTo() async throws {
        let result = try await execOn(runtime, ["/bin/pwd"], cwd: dir)
        let expected = try await runtime.realpath(dir)
        XCTAssertEqual(result.stdoutText.trimmingCharacters(in: .whitespacesAndNewlines), expected)
    }

    func testPutsTheEnvironmentItWasGivenOnTheCommand() async throws {
        let result = try await runtime.exec(ExecRequest(
            argv: ["/bin/sh", "-c", "printf %s \"$DEVHUB_CONTRACT\""],
            env: ["DEVHUB_CONTRACT": "yes"],
            deadline: .within(10_000), cancel: CancellationToken(), limits: truncating
        ))
        XCTAssertEqual(result.stdoutText, "yes")
    }

    func testFeedsStdinWithoutPuttingItOnTheCommandLine() async throws {
        let result = try await execOn(runtime, ["/bin/cat"], stdin: Data("a secret\n".utf8))
        XCTAssertEqual(result.stdoutText, "a secret\n")
    }

    func testTruncatesAnOverLongAnswerWhenAskedTo() async throws {
        let result = try await execOn(runtime, ["/bin/sh", "-c", "printf 'xxxxxx'"], limits: MachineExecLimits(stdoutBytes: 2, stderrBytes: 2, overflow: .truncate))
        XCTAssertEqual(result.stdoutText, "xx")
        XCTAssertEqual(result.code, 0)
    }

    func testRefusesAnOverLongAnswerWhenAskedTo() async {
        do {
            _ = try await execOn(runtime, ["/bin/sh", "-c", "printf 'xxxxxx'"], limits: MachineExecLimits(
                stdoutBytes: 2, stderrBytes: 2, overflow: .fail({ portFailure(.failed, detail: "too much") })
            ))
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual((error as? PortFailure)?.detail, "too much")
        }
    }

    func testGivesUpOnSilenceAtTheDeadline() async {
        _ = await assertThrowsPortAsync(.timedOut) { _ = try await execOn(self.runtime, ["/bin/sleep", "30"], timeoutMs: 60) }
    }

    func testStopsWhenTheOperationIsAbandoned() async {
        let cancel = CancellationToken()
        let runtime: LocalRuntime = self.runtime
        let running = Task { try await execOn(runtime, ["/bin/sleep", "30"], cancel: cancel) }
        cancel.cancel()
        do {
            _ = try await running.value
            XCTFail("expected a refusal")
        } catch {
            XCTAssertTrue(error is PortFailure)
        }
    }

    func testSaysAProgramIsUnavailableRatherThanHanging() async {
        _ = await assertThrowsPortAsync(.unavailable) { _ = try await execOn(self.runtime, [Path.join(self.dir, "no-such-program")]) }
    }

    // MARK: spawnStream

    private func stream(_ argv: [String], cwd: String? = nil) throws -> any ByteStream {
        try runtime.spawnStream(StreamRequest(
            argv: argv, cwd: cwd,
            env: ["PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin", "DEVHUB_CONTRACT": "streamed"],
            cancel: CancellationToken()
        ))
    }

    private func everything(_ stream: AsyncStream<Data>) async -> String {
        var all = Data()
        for await chunk in stream { all.append(chunk) }
        return String(decoding: all, as: UTF8.self)
    }

    func testDeliversBytesWhileTheProgramIsStillRunningExactlyAsWritten() async throws {
        // `read` waits on the stdin DevHub holds open, so the program is alive
        // when the first line arrives.
        let running = try stream(["/bin/sh", "-c", "printf '{\"a\":1}\\n\\r\\n'; read -r never"])
        var iterator = running.stdout.makeAsyncIterator()
        let first = await iterator.next()
        XCTAssertEqual(first.map { String(decoding: $0, as: UTF8.self) }, "{\"a\":1}\n\r\n")
        running.kill()
        let end = try await running.ended()
        XCTAssertNotEqual(end.signal ?? end.code, 0)
    }

    func testCarriesTheExitCodeAndTheEndOfStderr() async throws {
        let running = try stream(["/bin/sh", "-c", "echo out; echo \"why it stopped\" >&2; exit 3"])
        let out = await everything(running.stdout)
        XCTAssertEqual(out, "out\n")
        let end = try await running.ended()
        XCTAssertEqual(end.code, 3)
        XCTAssertEqual(String(decoding: end.stderr, as: UTF8.self), "why it stopped\n")
    }

    func testRunsWhereItWasToldToInTheEnvironmentItWasGiven() async throws {
        let running = try stream(["/bin/sh", "-c", "pwd -P; printf %s \"$DEVHUB_CONTRACT\""], cwd: dir)
        let out = await everything(running.stdout)
        let expected = try await runtime.realpath(dir)
        XCTAssertEqual(out, "\(expected)\nstreamed")
        let end = try await running.ended()
        XCTAssertEqual(end.code, 0)
    }

    func testStreamStopsWhenTheOperationIsAbandoned() async throws {
        let cancel = CancellationToken()
        let running = try runtime.spawnStream(StreamRequest(argv: ["/bin/sh", "-c", "sleep 30"], env: ["PATH": "/usr/bin:/bin"], cancel: cancel))
        cancel.cancel()
        let out = await everything(running.stdout)
        XCTAssertEqual(out, "")
        do {
            let end = try await running.ended()
            XCTAssertNotNil(end.signal)
        } catch let failure as PortFailure {
            XCTAssertEqual(failure.code, .cancelled)
        }
    }

    func testSaysAProgramIsUnavailableRatherThanStreamingNothing() async throws {
        let running = try stream(["/nonexistent/devhub-no-such-program"])
        let out = await everything(running.stdout)
        XCTAssertEqual(out, "")
        _ = await assertThrowsPortAsync(.unavailable) { _ = try await running.ended() }
    }

    // MARK: probes

    func testTellsADirectoryFromAFileFromNothingThere() async throws {
        try Data("x".utf8).write(to: URL(fileURLWithPath: Path.join(dir, "a-file")))
        let kinds = [try await runtime.stat(dir), try await runtime.stat(Path.join(dir, "a-file")), try await runtime.stat(Path.join(dir, "nope"))]
        XCTAssertEqual(kinds, [.directory, .file, .absent])
    }

    func testSaysNothingThereForAPathUnderAFileNotAFailure() async throws {
        try Data("x".utf8).write(to: URL(fileURLWithPath: Path.join(dir, "a-file")))
        let kind = try await runtime.stat(Path.join(dir, "a-file", "deeper"))
        XCTAssertEqual(kind, .absent)
    }

    func testReadsAFileBoundedAndStopsAtTheBound() async throws {
        try Data("abcdefghij".utf8).write(to: URL(fileURLWithPath: Path.join(dir, "long")))
        let short = try await runtime.readTextFile(Path.join(dir, "long"), maxBytes: 4)
        let whole = try await runtime.readTextFile(Path.join(dir, "long"), maxBytes: 100)
        XCTAssertEqual(short, "abcd")
        XCTAssertEqual(whole, "abcdefghij")
    }

    func testNamesThePathAndTheErrnoWhenItCouldNotLook() async {
        do {
            _ = try await runtime.readTextFile(Path.join(dir, "absent"), maxBytes: 10)
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? RuntimeFileError, RuntimeFileError(path: Path.join(dir, "absent"), code: "ENOENT"))
        }
    }

    func testWritesAFileAndReadsBackWhatItWrote() async throws {
        try await runtime.writeTextFile(Path.join(dir, "written"), text: "hi", mode: 0o600)
        let text = try await runtime.readTextFile(Path.join(dir, "written"), maxBytes: 64)
        XCTAssertEqual(text, "hi")
    }

    func testWritesANewFileOnlyIfTheNameIsFree() async throws {
        let path = Path.join(dir, "once")
        let first = try await runtime.writeNewTextFile(path, text: "a", mode: 0o600)
        let second = try await runtime.writeNewTextFile(path, text: "b", mode: 0o600)
        XCTAssertTrue(first)
        XCTAssertFalse(second)
        let text = try await runtime.readTextFile(path, maxBytes: 8)
        XCTAssertEqual(text, "a")
        let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int
        XCTAssertEqual(mode.map { $0 & 0o777 }, 0o600)
    }

    func testListsADirectorySayingWhichEntriesAreDirectories() async throws {
        try await runtime.makeDirectory(Path.join(dir, "sub"))
        try Data("x".utf8).write(to: URL(fileURLWithPath: Path.join(dir, "leaf")))
        let entries = try await runtime.readdir(dir).sorted { $0.name < $1.name }
        XCTAssertEqual(entries, [DirEntry(name: "leaf", directory: false), DirEntry(name: "sub", directory: true)])
    }

    func testRemovesATreeAndRemovingNothingIsNotAFailure() async throws {
        try await runtime.makeDirectory(Path.join(dir, "tree", "deep"))
        try Data("x".utf8).write(to: URL(fileURLWithPath: Path.join(dir, "tree", "deep", "leaf")))
        try await runtime.removeTree(Path.join(dir, "tree"))
        let kind = try await runtime.stat(Path.join(dir, "tree"))
        XCTAssertEqual(kind, .absent)
        try await runtime.removeTree(Path.join(dir, "tree"))
    }

    func testCanonicalisesAPath() async throws {
        try await runtime.makeDirectory(Path.join(dir, "real"))
        let up = try await runtime.realpath(Path.join(dir, "real", ".."))
        let here = try await runtime.realpath(dir)
        XCTAssertEqual(up, here)
    }

    func testAnswersWithAHomeDirectory() async throws {
        let home = try await runtime.home()
        XCTAssertTrue(home.hasPrefix("/"))
    }

    // MARK: the user tmux config

    func testIsAPathOnThatMachineWithTheConfigsOwnBytesAtIt() async throws {
        let local = Path.join(dir, "tmux.conf")
        try Data("set -g mouse on\n".utf8).write(to: URL(fileURLWithPath: local))
        let answer = await runtime.userTmuxConfig(local)
        XCTAssertNotEqual(answer.path, "/dev/null")
        let text = try await runtime.readTextFile(answer.path, maxBytes: 4096)
        XCTAssertEqual(text, "set -g mouse on\n")
    }

    func testCarriesAnEditAcrossRatherThanAnOlderCopy() async throws {
        let local = Path.join(dir, "tmux.conf")
        try Data("set -g mouse on\n".utf8).write(to: URL(fileURLWithPath: local))
        _ = await runtime.userTmuxConfig(local)
        try Data("set -g mouse off\n".utf8).write(to: URL(fileURLWithPath: local))
        let answer = await runtime.userTmuxConfig(local)
        let text = try await runtime.readTextFile(answer.path, maxBytes: 4096)
        XCTAssertEqual(text, "set -g mouse off\n")
    }

    func testNamesWhichConfigItIsAndSaysSoAgainWhenItChanges() async throws {
        let local = Path.join(dir, "tmux.conf")
        try Data("set -g mouse on\n".utf8).write(to: URL(fileURLWithPath: local))
        let first = await runtime.userTmuxConfig(local)
        XCTAssertNotEqual(first.digest, "none")
        let again = await runtime.userTmuxConfig(local)
        XCTAssertEqual(again.digest, first.digest)
        try Data("set -g mouse off\n".utf8).write(to: URL(fileURLWithPath: local))
        let changed = await runtime.userTmuxConfig(local)
        XCTAssertNotEqual(changed.digest, first.digest)
        // The same digest the TS app records: the first 32 hex digits of the
        // SHA-256 of the bytes.
        XCTAssertEqual(first.digest, String(SHA256.hex("set -g mouse on\n").prefix(32)))
    }

    func testIsDevNullWhenThereIsNoneAndStopsBeingOneWhenThereIs() async throws {
        let local = Path.join(dir, "tmux.conf")
        let none = await runtime.userTmuxConfig(local)
        XCTAssertEqual(none, UserTmuxConfig(path: "/dev/null", digest: "none"))
        try Data("set -g mouse on\n".utf8).write(to: URL(fileURLWithPath: local))
        let some = await runtime.userTmuxConfig(local)
        XCTAssertNotEqual(some.path, "/dev/null")
    }

    // MARK: reading

    func testNamesTheMachineAndCountsWhatHasBeenRunOnIt() async throws {
        _ = try await execOn(runtime, ["/bin/echo", "x"])
        let before = runtime.reading()
        XCTAssertEqual(before.id, runtime.id.rawValue)
        _ = try await execOn(runtime, ["/bin/echo", "x"])
        let after = runtime.reading()
        XCTAssertEqual(after.execsLastMinute, before.execsLastMinute + 1)
        XCTAssertEqual(after.reconcileIntervalMs, runtime.cadence.reconcileIntervalMs)
    }

    // MARK: programs

    func testResolvesAProgramOnThePathItWasGivenAndSaysWhereItLookedWhenItCannot() async {
        let found = await runtime.resolveProgram("sh", searchPath: "/nonexistent:/bin")
        XCTAssertEqual(found, .absolutePath("/bin/sh"))
        let missing = await runtime.resolveProgram("definitely-not-tmux", searchPath: "/a:/b")
        XCTAssertEqual(missing.unavailableMessage, "DevHub could not find 'definitely-not-tmux' on PATH (looked in: /a, /b).")
        let explicit = await runtime.resolveProgram("/nonexistent/tmux", searchPath: "/bin")
        XCTAssertEqual(explicit.unavailableMessage, "DevHub could not find /nonexistent/tmux.")
        let empty = await runtime.resolveProgram("tmux", searchPath: "")
        XCTAssertEqual(empty.unavailableMessage, "DevHub could not find 'tmux' on PATH (PATH is empty).")
        let many = await runtime.resolveProgram("x-none", searchPath: (1...14).map { "/d\($0)" }.joined(separator: ":"))
        XCTAssertEqual(
            many.unavailableMessage,
            "DevHub could not find 'x-none' on PATH (looked in: /d1, /d2, /d3, /d4, /d5, /d6, /d7, /d8, /d9, /d10, /d11, /d12, and 2 more)."
        )
    }

    func testTheTmuxOfThisMachineIsThePersonsOwnWithNothingAdded() async {
        let tmux = await runtime.tmuxProgram("sh", searchPath: "/bin")
        XCTAssertEqual(tmux, .resolved(path: "/bin/sh", environment: [:]))
        let missing = await runtime.tmuxProgram("no-tmux-here", searchPath: "/a")
        XCTAssertEqual(missing, .unavailable(reason: "DevHub could not find 'no-tmux-here' on PATH (looked in: /a)."))
    }
}

final class CadenceTests: XCTestCase {
    func testBoundsTheDutyCycleAtAnEighthUpToWhereTheCeilingTakesOver() {
        for rtt in [1.0, 5, 30, 60, 100, 150, 300, 375] {
            XCTAssertLessThanOrEqual(rtt / Cadence.remoteReconcileIntervalMs(rtt), 1 / Cadence.reconcileDutyCycle)
        }
    }

    func testSpendsMoreThanAnEighthOfTheClockPastTheCeilingAndSaysSo() {
        XCTAssertEqual(Cadence.remoteReconcileIntervalMs(900), Cadence.remoteReconcileCeilingMs)
        XCTAssertGreaterThan(900 / Cadence.remoteReconcileCeilingMs, 1 / Cadence.reconcileDutyCycle)
    }

    func testLandsAFastLinkOnTheFloorRatherThanPollingHarder() {
        XCTAssertEqual(Cadence.remoteReconcileIntervalMs(5), Cadence.remoteReconcileFloorMs)
        XCTAssertEqual(Cadence.remoteReconcileIntervalMs(60), Cadence.remoteReconcileFloorMs)
        XCTAssertEqual(Cadence.remoteReconcileIntervalMs(70), 560)
    }

    func testStopsSlowingDownAtTheCeiling() {
        XCTAssertEqual(Cadence.remoteReconcileIntervalMs(300), 2_400)
        XCTAssertEqual(Cadence.remoteReconcileIntervalMs(1_000), Cadence.remoteReconcileCeilingMs)
    }

    func testRunsAtTheCeilingWhenTheMedianIsNotAMeasurement() {
        XCTAssertEqual(Cadence.remoteReconcileIntervalMs(.nan), Cadence.remoteReconcileCeilingMs)
        XCTAssertEqual(Cadence.remoteReconcileIntervalMs(-1), Cadence.remoteReconcileCeilingMs)
    }

    func testIsNotWhatThisMachineUsesBecauseThisMachineHasNoLatency() {
        XCTAssertEqual(Cadence.remoteReconcileIntervalMs(0), Cadence.remoteReconcileFloorMs)
        XCTAssertEqual(localCadence.reconcileIntervalMs, 300)
    }

    func testIsShorterHereThanOverANetworkAndBothAreUnderThePoll() {
        XCTAssertEqual(localCadence.repositoryFocusRefreshMinIntervalMs, Cadence.repositoryFocusRefreshMinIntervalMs)
        XCTAssertLessThan(Cadence.repositoryFocusRefreshMinIntervalMs, Cadence.remoteRepositoryFocusRefreshMinIntervalMs)
        XCTAssertLessThan(Cadence.remoteRepositoryFocusRefreshMinIntervalMs, localCadence.repositoryPollMs)
    }
}

final class ShellQuoteTests: XCTestCase {
    /// What `/bin/sh` actually makes of a quoted argv. The only real assertion.
    func shellArgv(_ line: String) -> [String] {
        let result = runSync("/bin/sh", ["-c", "for word in \(line); do printf '%s\\0' \"$word\"; done"])
        var parts = result.stdout.scalarSplit("\0")
        parts.removeLast()
        return parts
    }

    func testSurvivesEveryAwkwardByte() {
        for (what, value) in [
            ("a space", "one two"), ("a single quote", "it's"), ("only single quotes", "'''"),
            ("a double quote", "say \"hi\""), ("a dollar", "$HOME and ${PATH}"), ("a backtick", "`whoami`"),
            ("a backslash", "back\\slash"), ("a newline", "first\nsecond"), ("a semicolon and an ampersand", "a; rm -rf /& b"),
            ("a glob", "*.ts"), ("a tilde", "~/notes"), ("a bang", "history!"), ("the empty string", ""),
            ("a non-ASCII byte", "日本語 — ok"),
        ] {
            XCTAssertEqual(shellArgv(ShellQuote.word(value)), [value], what)
        }
    }

    func testMakesTheEmptyStringAWordRatherThanNothing() {
        XCTAssertEqual(ShellQuote.word(""), "''")
    }

    func testKeepsEveryWordAWordWhateverIsInIt() {
        let argv = ["git", "commit", "-m", "it's a $test\nand a 'quote'", ""]
        XCTAssertEqual(shellArgv(ShellQuote.argv(argv)), argv)
    }

    func testIsEmptyForAnEmptyArgv() {
        XCTAssertEqual(ShellQuote.argv([]), "")
    }
}

final class MachineFailureTests: XCTestCase {
    func testIsEachPortFailureAsTheMachinesFailureWithItsSentence() {
        for (port, code) in [
            (PortErrorCode.unavailable, "machine_unavailable"), (.incompatible, "machine_unavailable"),
            (.timedOut, "machine_timed_out"), (.cancelled, "operation_cancelled"),
            (.conflict, "machine_command_failed"), (.failed, "machine_command_failed"),
            (.rootMissing, "workspace_unavailable"), (.rootInaccessible, "workspace_unavailable"),
        ] {
            let failure = portFailure(port, detail: "It said so.")
            XCTAssertEqual(failure.code.shownAs, code)
            XCTAssertEqual(failure.wireDetail, "It said so.")
        }
    }

    func testReadsAsItsTitleAndItsSentenceWhereItIsText() {
        XCTAssertEqual(RuntimeFailureText.of(portFailure(.unavailable, detail: "It said so.")), "The machine is unavailable. It said so.")
        XCTAssertEqual(RuntimeFailureText.of(portFailure(.timedOut)), "The machine did not answer in time. terminal runtime timed out")
    }

    func testAFolderTheMachineCouldNotReadNamesThePathAndTheErrno() async {
        let missing = Path.join(NSTemporaryDirectory(), "devhub-unreadable-\(UUID().uuidString)", "not-there")
        do {
            _ = try await LocalRuntime().realpath(missing)
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? RuntimeFileError, RuntimeFileError(path: missing, code: "ENOENT"))
        }
    }

    func testAMachineIsNamedOneOfTwoWays() throws {
        XCTAssertEqual(try RuntimeId.parse("local"), .local)
        XCTAssertEqual(try RuntimeId.parse("ssh:build-box"), .ssh("build-box"))
        XCTAssertThrowsError(try RuntimeId.parse("container:abc")) { error in
            XCTAssertEqual("\(error)", "container:abc does not name a machine DevHub knows")
        }
    }
}

final class PseudoTerminalTests: XCTestCase {
    func testRunsTheProgramOnATerminalOfTheSizeItWasGiven() throws {
        let pty = try openPty(PtyLaunch(
            file: "/bin/sh", args: ["-c", "stty size; tty; exit 7"], cwd: "/",
            cols: 101, rows: 33, env: ["PATH": "/usr/bin:/bin", "TERM": "xterm-256color"]
        ))
        let output = Collected()
        let exited = expectation(description: "exited")
        let code = Collected()
        pty.onData { output.append($0) }
        pty.onExit { value in
            code.append(Data([UInt8(value ?? 255)]))
            exited.fulfill()
        }
        pty.resume()
        wait(for: [exited], timeout: 10)
        XCTAssertTrue(output.text.contains("33 101"), output.text)
        XCTAssertTrue(output.text.contains("/dev/pts/") || output.text.contains("/dev/ttys"), output.text)
        XCTAssertEqual(code.bytes, [7])
    }

    func testCarriesInputAndResizesTheTerminal() throws {
        let pty = try openPty(PtyLaunch(
            file: "/bin/sh", args: ["-c", "read line; stty size; echo \"got:$line\""], cwd: "/",
            cols: 80, rows: 24, env: ["PATH": "/usr/bin:/bin"]
        ))
        let output = Collected()
        let exited = expectation(description: "exited")
        pty.onData { output.append($0) }
        pty.onExit { _ in exited.fulfill() }
        pty.resume()
        pty.resize(TerminalSize(cols: 120, rows: 40))
        pty.write(Data("hello\r".utf8))
        wait(for: [exited], timeout: 10)
        XCTAssertTrue(output.text.contains("40 120"), output.text)
        XCTAssertTrue(output.text.contains("got:hello"), output.text)
    }

    func testTheClientsEnvironmentIsAlwaysAnXtermWithTrueColour() {
        let env = terminalEnvironment(["TMUX": "/tmp/x", "TMUX_PANE": "%1", "TERM": "dumb", "HOME": "/h"])
        XCTAssertEqual(env, ["TERM": "xterm-256color", "COLORTERM": "truecolor", "HOME": "/h"])
    }
}

final class Collected: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    func append(_ chunk: Data) { lock.withLock { data.append(chunk) } }
    var text: String { lock.withLock { String(decoding: data, as: UTF8.self) } }
    var bytes: [UInt8] { lock.withLock { Array(data) } }
}
