// Port of apps/desktop/test/terminal/tmux.test.ts: the tmux runtime's seams,
// without a tmux server — session naming, what counts as ownership, version
// acceptance, config precedence, the bounded runner's refusals, the operation
// gate, the stderr classification, and the names failures are drawn under.

import Foundation
import XCTest
@testable import DevHubCore

/// A scratch directory per test, removed afterwards.
final class ScratchDirectories {
    private var made: [String] = []

    func make(_ label: String) -> String {
        let base = NSTemporaryDirectory()
        let path = Path.join(base, "devhub-\(label)-\(UUID().uuidString.prefix(8))")
        try! FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        // Canonical, because roots are compared against `realpath`.
        let real = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        made.append(real)
        return real
    }

    func removeAll() {
        for path in made { try? FileManager.default.removeItem(atPath: path) }
        made = []
    }
}

func unitRuntime(
    home: String = NSTemporaryDirectory(),
    tmux: ResolvedExecutable? = nil,
    shell: ResolvedExecutable? = nil,
    tmuxArgs: [String] = [],
    socket: String = "devhub",
    environment: [String: String] = ["PATH": "/usr/bin:/bin"],
    timeoutMs: Double = 1
) -> TmuxTerminalRuntime {
    TmuxTerminalRuntime(TmuxTerminalRuntimeOptions(
        context: RuntimeLaunchContext(home: home, environment: environment),
        tmux: tmux.map { .resolved($0) } ?? .unavailable(reason: "DevHub could not find 'tmux' on PATH (looked in: /usr/bin, /bin)."),
        shell: shell,
        tmuxArgs: tmuxArgs,
        effectiveSocketName: socket,
        timeoutMs: timeoutMs,
        log: { _ in }
    ))
}

func assertThrowsPort(_ code: PortErrorCode, _ body: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
    do {
        try body()
        XCTFail("expected a \(code) failure", file: file, line: line)
    } catch let failure as PortFailure {
        XCTAssertEqual(failure.code, code, file: file, line: line)
    } catch {
        XCTFail("expected a PortFailure, got \(error)", file: file, line: line)
    }
}

func assertThrowsPortAsync(_ code: PortErrorCode, file: StaticString = #filePath, line: UInt = #line, _ body: () async throws -> Void) async -> PortFailure? {
    do {
        try await body()
        XCTFail("expected a \(code) failure", file: file, line: line)
    } catch let failure as PortFailure {
        XCTAssertEqual(failure.code, code, "\(failure)", file: file, line: line)
        return failure
    } catch {
        XCTFail("expected a PortFailure, got \(error)", file: file, line: line)
    }
    return nil
}

let agentA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
let workspaceB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

final class TmuxSessionNamingTests: XCTestCase {
    func testIsStableBoundedAndDerivedOnlyFromTheRoot() {
        let root = "/workspaces/devhub-terminal-test"
        let digest = TmuxMarkers.workspaceDigest(root: root)
        XCTAssertEqual(digest.count, 64)
        XCTAssertLessThanOrEqual(("ws-" + digest.prefix(20)).count, 256)
        XCTAssertLessThanOrEqual(("ws-" + digest.prefix(32)).count, 256)
        // The same root is the same session on the next launch.
        XCTAssertEqual(TmuxMarkers.workspaceDigest(root: root), digest)
        XCTAssertTrue(TmuxMarkers.isWorkspaceSessionName("ws-" + digest.prefix(20), root: root))
        XCTAssertTrue(TmuxMarkers.isWorkspaceSessionName("ws-" + digest.prefix(32), root: root))
        XCTAssertFalse(TmuxMarkers.isWorkspaceSessionName("ws-whatever", root: root))
    }

    func testKeepsRootMetadataBoundedAndUnambiguous() {
        // A newline in a path is part of the path, not a record separator.
        let first = "/workspaces/a\nb"
        XCTAssertNotEqual(first, "/workspaces/ab")
        XCTAssertTrue(TmuxMarkers.isRootMetadata(first))
        XCTAssertTrue(TmuxMarkers.sessionMatches(
            SessionMarking(name: "workspace", context: "global", workspaceId: "global", root: first, agentId: "none"),
            TargetIdentity(sessionName: "workspace", root: first, workspaceId: "global", context: "global", agentId: "none")
        ))
        XCTAssertFalse(TmuxMarkers.isRootMetadata("hex:2f746d70"))
        XCTAssertFalse(TmuxMarkers.isRootMetadata(""))
        XCTAssertFalse(TmuxMarkers.isRootMetadata("relative/path"))
    }

    func testAnAgentTerminalIsNamedByItsId() {
        XCTAssertEqual(TmuxNames.terminalSession(terminalId: agentA), "tm-\(agentA)")
        XCTAssertEqual(TmuxMarkers.terminalIdOfSession("tm-\(agentA)"), agentA)
        XCTAssertNil(TmuxMarkers.terminalIdOfSession("tm-not-a-uuid"))
        XCTAssertNil(TmuxMarkers.terminalIdOfSession("ag-\(agentA)"))
    }
}

final class TmuxOwnershipTests: XCTestCase {
    func testOwnsAnAgentSessionOnlyWhenTheWholeMarkerTupleIsItsOwn() {
        let root = "/workspaces/project"
        let session = SessionMarking(name: "ag-\(agentA)", context: "agent", workspaceId: workspaceB, root: root, agentId: agentA)
        XCTAssertTrue(TmuxMarkers.isMarked(session, expectedGlobalRoot: "/workspaces"))
        var renamed = session
        renamed.name = "ag-other"
        XCTAssertFalse(TmuxMarkers.isMarked(renamed, expectedGlobalRoot: "/workspaces"))
        var noAgent = session
        noAgent.agentId = "none"
        XCTAssertFalse(TmuxMarkers.isMarked(noAgent, expectedGlobalRoot: "/workspaces"))
        // A workspace terminal that has picked up an Agent id is not a terminal
        // DevHub wrote.
        XCTAssertFalse(TmuxMarkers.isMarked(
            SessionMarking(name: "ws-" + TmuxMarkers.workspaceDigest(root: root).prefix(20), context: "workspace", workspaceId: workspaceB, root: root, agentId: agentA),
            expectedGlobalRoot: "/workspaces"
        ))
    }

    func testNeverTreatsUnknownMetadataAsOwned() {
        let session = SessionMarking(name: "scratch", context: "other", workspaceId: "secret", root: "/elsewhere/secret", agentId: "none")
        XCTAssertFalse(TmuxMarkers.isMarked(session, expectedGlobalRoot: "/workspaces"))
        XCTAssertFalse(TmuxMarkers.sessionMatches(session, TargetIdentity(sessionName: "scratch", root: "/workspaces", workspaceId: "global", context: "global", agentId: "none")))
    }

    func testRequiresTheWholeMarkerTripleNotJustAMatchingName() {
        let root = "/workspaces/project"
        let name = "ws-" + TmuxMarkers.workspaceDigest(root: root).prefix(20)
        XCTAssertTrue(TmuxMarkers.isMarked(SessionMarking(name: name, context: "workspace", workspaceId: agentA, root: root, agentId: "none"), expectedGlobalRoot: "/workspaces"))
        XCTAssertFalse(TmuxMarkers.isMarked(SessionMarking(name: name, context: "workspace", workspaceId: "not-a-uuid", root: root, agentId: "none"), expectedGlobalRoot: "/workspaces"))
        // A scratch session rooted somewhere other than this launch's home is
        // another DevHub's, or another user's.
        XCTAssertFalse(TmuxMarkers.isMarked(SessionMarking(name: "scratch", context: "global", workspaceId: "global", root: "/elsewhere", agentId: "none"), expectedGlobalRoot: "/workspaces"))
    }

    func testAnAgentTerminalIsOwnedOnlyAsATerminal() {
        let root = "/workspaces/project"
        let session = SessionMarking(name: "tm-\(agentA)", context: "terminal", workspaceId: workspaceB, root: root, agentId: "none")
        XCTAssertTrue(TmuxMarkers.isMarked(session, expectedGlobalRoot: "/workspaces"))
        var withAgent = session
        withAgent.agentId = agentA
        XCTAssertFalse(TmuxMarkers.isMarked(withAgent, expectedGlobalRoot: "/workspaces"))
        var badName = session
        badName.name = "tm-x"
        XCTAssertFalse(TmuxMarkers.isMarked(badName, expectedGlobalRoot: "/workspaces"))
    }
}

final class TmuxConfigurationTests: XCTestCase {
    func testDisablesTheAdapterWhenTheSocketSelectorIsPassedAsAnArgument() {
        XCTAssertTrue(isSafeTmuxArgument("-u"))
        XCTAssertTrue(isSafeTmuxArgument("-2"))
        XCTAssertFalse(isSafeTmuxArgument("-L"))
        let disabled = unitRuntime(tmux: ResolvedExecutable(path: "/usr/bin/tmux", basename: "tmux"), tmuxArgs: ["-L", "evil"])
        XCTAssertFalse(disabled.adapterAvailable)
        let enabled = unitRuntime(tmux: ResolvedExecutable(path: "/usr/bin/tmux", basename: "tmux"), tmuxArgs: ["-u"])
        XCTAssertTrue(enabled.adapterAvailable)
    }

    func testRefusesASocketNameThatIsNotOne() {
        XCTAssertTrue(SocketName.isValid("devhub"))
        XCTAssertTrue(SocketName.isValid("dev-hub_1.0"))
        for invalid in ["", "dev/hub", "dev hub", String(repeating: "a", count: 65)] {
            XCTAssertFalse(SocketName.isValid(invalid))
            XCTAssertThrowsError(try SocketName(invalid))
        }
        XCTAssertFalse(unitRuntime(socket: "dev/hub").adapterAvailable)
    }

    func testAcceptsNumericVersionSuffixesButRejectsVersionsBefore33() {
        for version in ["3.3", "3.7b", "4.0"] {
            let parts = version.components(separatedBy: ".").map(TmuxMarkers.parseNumericPrefix)
            XCTAssertTrue(parts[0] > 3 || (parts[0] == 3 && parts[1] >= 3))
        }
        let parts = "3.2".components(separatedBy: ".").map(TmuxMarkers.parseNumericPrefix)
        XCTAssertTrue(parts[0] < 3 || (parts[0] == 3 && parts[1] < 3))
        XCTAssertEqual(TmuxMarkers.parseNumericPrefix("next"), 0)
    }
}

final class TmuxRequiredSetTests: XCTestCase {
    func testIsRebuiltFromTheSnapshotAloneAndAlwaysContainsScratch() throws {
        let set = try unitRuntime().requiredTerminalSet([(workspaceId: agentA, canonicalPath: "/workspaces/one")])
        XCTAssertEqual(set.sessions[0], .scratch(sessionName: "scratch"))
        XCTAssertEqual(set.sessions[1], .workspace(workspaceId: agentA, sessionName: "ws-" + TmuxMarkers.workspaceDigest(root: "/workspaces/one").prefix(20)))
        XCTAssertThrowsError(try unitRuntime().requiredTerminalSet([(workspaceId: "not-a-uuid", canonicalPath: "/workspaces/one")]))
        // A set with no Scratch could not describe a running DevHub.
        XCTAssertThrowsError(try RequiredTerminalSet([]))
    }

    func testRefusesAPreflightWhoseCountsContradictItsState() throws {
        let socket = try SocketName("devhub")
        XCTAssertEqual(try TerminalPreflight(requestedSocketName: socket, state: .targetAbsent, ownedSessionCount: 0, unknownSessionCount: 0).state, .targetAbsent)
        XCTAssertThrowsError(try TerminalPreflight(requestedSocketName: socket, state: .targetAbsent, ownedSessionCount: 1, unknownSessionCount: 0))
        XCTAssertThrowsError(try TerminalPreflight(requestedSocketName: socket, state: .targetDevhubEmpty, ownedSessionCount: 1, unknownSessionCount: 0))
    }
}

final class TmuxInspectionTests: XCTestCase {
    func testProjectsAProviderFailureAsUnknownNeverAsClean() async throws {
        // Fail-closed: an unverified terminal must never look empty to a close
        // confirmation.
        let inspection = try await unitRuntime().inspect(.localScratch)
        guard case .unknown(let diagnostic, let reason) = inspection.process else {
            return XCTFail("expected unknown, got \(inspection.process)")
        }
        XCTAssertEqual(diagnostic, "close_terminal_unknown")
        // And the provider's own words come with it.
        XCTAssertTrue(reason?.contains("tmux") ?? false)
        if case .unknown = inspection.extraPanes {} else { XCTFail("extraPanes") }
        if case .unknown = inspection.extraWindows {} else { XCTFail("extraWindows") }
    }

    func testStillReportsCancellationAsAFailureNotAsUnknown() async {
        let cancel = CancellationToken()
        cancel.cancel()
        _ = await assertThrowsPortAsync(.cancelled) {
            _ = try await unitRuntime().inspect(.workspace(machine: .local, workspaceId: "a", root: "/ws"), cancel: cancel)
        }
    }
}

final class BoundedRunnerTests: XCTestCase {
    let limits = MachineExecLimits(
        stdoutBytes: TmuxCommand.maxOutputBytes,
        stderrBytes: TmuxCommand.maxStderrBytes,
        overflow: .fail({ portFailure(.failed, detail: "too much") })
    )

    func testChecksCancellationAndTheDeadlineBeforeSpawningAnything() async {
        _ = await assertThrowsPortAsync(.timedOut) {
            _ = try await BoundedCommand.run(
                CommandSpec(file: "not-spawned", args: [], cwd: ".", env: [:]),
                deadline: .within(0), cancel: CancellationToken(), limits: limits
            )
        }
        let cancelled = CancellationToken()
        cancelled.cancel()
        _ = await assertThrowsPortAsync(.cancelled) {
            _ = try await BoundedCommand.run(
                CommandSpec(file: "not-spawned", args: [], cwd: ".", env: [:]),
                deadline: .within(1_000), cancel: cancelled, limits: limits
            )
        }
    }

    func testReportsAMissingExecutableAsUnavailableNotAsAFailure() async {
        _ = await assertThrowsPortAsync(.unavailable) {
            _ = try await BoundedCommand.run(
                CommandSpec(file: "/nonexistent/no-such-program", args: [], cwd: "/", env: [:]),
                deadline: .within(2_000), cancel: CancellationToken(), limits: limits
            )
        }
    }

    func testGivesTheNextCommandAFullBudgetOnceOneHasAnswered() async throws {
        // The budget is a watchdog on silence, not a ration of commands.
        // Six pauses of 200 ms are longer than the 1 s budget together, and
        // each is well inside it alone.
        let deadline = OperationDeadline.within(1_000)
        for round in 0..<6 {
            try await Task.sleep(nanoseconds: 200_000_000)
            let output = try await BoundedCommand.run(
                CommandSpec(file: "/bin/echo", args: [String(round)], cwd: "/", env: ["PATH": "/usr/bin:/bin"]),
                deadline: deadline, cancel: CancellationToken(), limits: limits
            )
            XCTAssertTrue(output.success)
        }
    }

    func testStillTimesOutACommandThatGoesQuietForTheWholeBudget() async {
        _ = await assertThrowsPortAsync(.timedOut) {
            _ = try await BoundedCommand.run(
                CommandSpec(file: "/bin/sleep", args: ["5"], cwd: "/", env: ["PATH": "/usr/bin:/bin"]),
                deadline: .within(200), cancel: CancellationToken(), limits: limits
            )
        }
    }

    func testCollectsARealChildsOutputWithinTheBudget() async throws {
        let output = try await BoundedCommand.run(
            CommandSpec(file: "/bin/echo", args: ["devhub"], cwd: "/", env: ["PATH": "/usr/bin:/bin"]),
            deadline: .within(5_000), cancel: CancellationToken(), limits: limits
        )
        XCTAssertTrue(output.success)
        XCTAssertEqual(output.stdoutText, "devhub\n")
    }

    func testStopsWhenTheOperationIsAbandoned() async {
        let cancel = CancellationToken()
        Task {
            try await Task.sleep(nanoseconds: 100_000_000)
            cancel.cancel()
        }
        _ = await assertThrowsPortAsync(.cancelled) {
            _ = try await BoundedCommand.run(
                CommandSpec(file: "/bin/sleep", args: ["5"], cwd: "/", env: ["PATH": "/usr/bin:/bin"]),
                deadline: .within(5_000), cancel: cancel, limits: limits
            )
        }
    }
}

final class ProviderOutputParsingTests: XCTestCase {
    func testRefusesMalformedRecordsRatherThanUsingPartOfThem() throws {
        XCTAssertEqual(try TmuxCommand.parseLines(Data("a\nb\r\n\nc\n".utf8)), ["a", "b", "c"])
        XCTAssertThrowsError(try TmuxCommand.parseLines(Data("a\0b".utf8)))
        XCTAssertThrowsError(try TmuxCommand.parseLines(Data((String(repeating: "x", count: 4097) + "\n").utf8)))
    }

    func testKeepsANewlineInsideOneOptionValue() throws {
        XCTAssertEqual(try TmuxCommand.parseOptionValue(Data("/workspaces/a\nb\n".utf8)), "/workspaces/a\nb")
        // tmux always terminates the value; output without it is truncated.
        XCTAssertThrowsError(try TmuxCommand.parseOptionValue(Data("/workspaces".utf8)))
        XCTAssertThrowsError(try TmuxCommand.parseOptionValue(Data("/works\0paces\n".utf8)))
    }

    func testReadsAListingByItsRecordSeparatorNotByTmuxsNewline() throws {
        let field = "\u{1f}", record = "\u{1e}"
        let listing = "scratch\(field)global\(field)/a\(record)\n" + "ws\(field)\(field)/x\ny\(record)\n"
        XCTAssertEqual(try TmuxCommand.parseRecords(Data(listing.utf8), fieldCount: 3), [
            ["scratch", "global", "/a"],
            // A value containing a newline stays one field of one record.
            ["ws", "", "/x\ny"],
        ])
        XCTAssertThrowsError(try TmuxCommand.parseRecords(Data("a\(field)b\(record)\n".utf8), fieldCount: 3))
        XCTAssertThrowsError(try TmuxCommand.parseRecords(Data("a\(field)b\(field)c\n".utf8), fieldCount: 3))
        XCTAssertEqual(try TmuxCommand.parseRecords(Data(), fieldCount: 3), [])
    }

    func testRefusesBytesThatAreNotUtf8() {
        XCTAssertThrowsError(try TmuxCommand.splitRecords(Data([0xff, 0x1e, 0x0a])))
    }
}

final class ExecutableResolutionTests: XCTestCase {
    func testLooksABareNameUpInAbsolutePathEntriesOnly() {
        let env = ["PATH": "relative/bin::/bin"]
        XCTAssertEqual(BoundedCommand.resolveExecutable(home: "/", environment: env, configured: "echo")?.basename, "echo")
        XCTAssertNil(BoundedCommand.resolveExecutable(home: "/", environment: env, configured: "definitely-not-a-program"))
        // A relative path with a separator is never resolved against the
        // process's own working directory.
        XCTAssertNil(BoundedCommand.resolveExecutable(home: "/", environment: env, configured: "bin/echo"))
        XCTAssertNil(BoundedCommand.resolveExecutable(home: "/", environment: env, configured: ""))
        XCTAssertEqual(
            BoundedCommand.resolveExecutable(home: "/", environment: env, configured: "/bin/echo")?.path,
            URL(fileURLWithPath: "/bin/echo").resolvingSymlinksInPath().path
        )
    }
}

final class OperationGateTests: XCTestCase {
    func testExcludesOrdinaryOperationsDuringATransitionAndHonoursCancellation() async throws {
        let gate = unitRuntime()
        let transition = try await gate.beginTransition()
        let cancel = CancellationToken()
        let settled = Flag()
        let waiting = Task { () -> PortErrorCode? in
            do {
                let permit = try await gate.acquireOperation(cancel)
                permit.release()
                settled.set()
                return nil
            } catch let failure as PortFailure {
                settled.set()
                return failure.code
            }
        }
        try await Task.sleep(nanoseconds: 30_000_000)
        // A socket transition must be able to inventory the old socket without
        // an ordinary operation creating a session on it underneath.
        XCTAssertFalse(settled.isSet)
        cancel.cancel()
        let code = try await waiting.value
        XCTAssertEqual(code, .cancelled)
        transition.release()
        let release = try await gate.acquireOperation(CancellationToken())
        release.release()
    }

    func testLetsATransitionWaitForTheOperationsAlreadyRunning() async throws {
        let gate = unitRuntime()
        let release = try await gate.acquireOperation(CancellationToken())
        let acquired = Flag()
        let transition = Task { () -> RuntimeOperationGate.Permit in
            let done = try await gate.beginTransition()
            acquired.set()
            return done
        }
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertFalse(acquired.isSet)
        release.release()
        try await transition.value.release()
        XCTAssertTrue(acquired.isSet)
    }
}

final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.withLock { value = true } }
    var isSet: Bool { lock.withLock { value } }
}

final class ServerReachTests: XCTestCase {
    func reach(_ stderr: String) -> TmuxCommand.ServerReach { TmuxCommand.serverReach(Data(stderr.utf8)) }

    func testCoversEveryWayTmuxSaysTheServerIsGone() {
        for stderr in [
            "no server running on /tmp/tmux-501/devhub",
            "error connecting to /tmp/tmux-501/devhub (No such file or directory)",
            // Killing the last session ends the server; a command that
            // overlaps that exit is told the server went away.
            "server exited unexpectedly",
        ] {
            XCTAssertEqual(reach("\(stderr)\n"), .noServer)
        }
    }

    func testNamesASocketPathTooLongForASocketAddressWithItsLengthAndTheFix() {
        let path = "/private/tmp/\(String(repeating: "a", count: 90))/tmux-501/devhub"
        for stderr in ["error connecting to \(path) (File name too long)\n", "error creating \(path) (File name too long)\n"] {
            guard case .socketUnusable(let failure) = reach(stderr) else { return XCTFail(stderr) }
            XCTAssertEqual(failure.code, .socketPathTooLong)
            XCTAssertEqual(failure.detail, "\(path) is \(path.utf8.count) bytes; macOS allows 103 and Linux 107. Set TMUX_TMPDIR to a shorter directory.")
        }
    }

    func testReadsEveryOtherSocketTmuxCouldNotUseAsThatInTmuxsWords() {
        for stderr in [
            "couldn't create directory /tmp/locked/tmux-501 (Permission denied)",
            "error creating /tmp/locked/tmux-501 (Permission denied)",
            "error connecting to /tmp/x/tmux-501/devhub (Permission denied)",
            "error connecting to /tmp/x/tmux-501/devhub (Socket operation on non-socket)",
            "directory /tmp/x/tmux-501 has unsafe permissions",
            "no suitable socket path",
        ] {
            guard case .socketUnusable(let failure) = reach("\(stderr)\n") else { return XCTFail(stderr) }
            XCTAssertEqual(failure.code, .socketUnusable, stderr)
            XCTAssertEqual(failure.detail, "tmux could not use its socket: \(stderr)")
        }
    }

    func testStillReadsAServerThatAnsweredAsAServer() {
        for stderr in ["", "can't find session: scratch", "lost server", "unknown command: show-options"] {
            XCTAssertEqual(reach(stderr), .reached)
        }
    }

    func testReadsTheLastLineWhichIsTheOneTmuxStoppedOn() {
        XCTAssertEqual(reach("/home/alice/.tmux.conf:3: unknown option: foo\nno server running on /tmp/tmux-501/devhub\n"), .noServer)
    }
}

/// What a failure is *called* when it reaches a person.
final class TerminalFailureNamingTests: XCTestCase {
    func code(_ port: PortErrorCode) -> TerminalErrorCode { TerminalFailure.from(portFailure(port)).code }

    func testBlamesTheFolderNotTheRuntimeWhenTheRootIsGone() {
        XCTAssertEqual(code(.rootMissing), .workspaceRootMissing)
        XCTAssertEqual(code(.rootInaccessible), .workspaceRootInaccessible)
    }

    func testDoesNotCallAMissingFolderAnUnavailableRuntime() {
        XCTAssertNotEqual(code(.rootMissing), .runtimeUnavailable)
    }

    func testKeepsATimeoutApartFromARuntimeThatIsNotThere() {
        XCTAssertEqual(code(.timedOut), .runtimeTimedOut)
        XCTAssertEqual(code(.unavailable), .runtimeUnavailable)
    }

    func testSaysAVersionItCannotWorkWithIsAVersionNotAnAbsence() {
        XCTAssertEqual(code(.incompatible), .runtimeIncompatible)
    }

    func testGivesASocketTmuxCannotUseItsOwnTitleAndCallsItTheRuntimeNotBeingThere() {
        let tooLong = portFailure(.socketPathTooLong, detail: "/tmp/x/tmux-501/devhub is 120 bytes; macOS allows 103 and Linux 107. Set TMUX_TMPDIR to a shorter directory.")
        XCTAssertEqual(tooLong.code.shownAs, "terminal_socket_path_too_long")
        XCTAssertEqual(tooLong.code.shownSummary, "The terminal socket path is too long.")
        XCTAssertEqual(tooLong.wireDetail, tooLong.detail)
        XCTAssertEqual(PortErrorCode.socketUnusable.shownAs, "terminal_socket_unusable")
        for port in [PortErrorCode.socketPathTooLong, .socketUnusable] {
            let drawn = TerminalFailure.from(portFailure(port, detail: "which socket, and why"))
            XCTAssertEqual(drawn.code, .runtimeUnavailable)
            XCTAssertEqual(drawn.summary, "which socket, and why")
        }
    }

    func testStillReportsACancelledOperationAsAStaleTarget() {
        XCTAssertEqual(code(.cancelled), .staleTarget)
        XCTAssertEqual(code(.conflict), .sessionUnavailable)
    }
}

/// What a refused or silent tmux tells the person looking at the pane, run
/// against a real child.
final class TmuxRefusalTests: XCTestCase {
    let scratch = ScratchDirectories()
    override func tearDown() { scratch.removeAll() }

    /// A stand-in tmux that does exactly what the script says and nothing else.
    func fakeTmux(_ script: String) -> ResolvedExecutable {
        let directory = scratch.make("tmux-unit")
        let path = Path.join(directory, "tmux")
        try! Data("#!/bin/sh\n\(script)\n".utf8).write(to: URL(fileURLWithPath: path))
        chmod(path, 0o755)
        return ResolvedExecutable(path: path, basename: "tmux")
    }

    func testNamesTheSubcommandWhateverFlagsComeBeforeOrAfterIt() {
        XCTAssertEqual(TmuxMarkers.tmuxSubcommand(["kill-session", "-t", "a"]), "kill-session")
        XCTAssertEqual(TmuxMarkers.tmuxSubcommand(["-u", "capture-pane", "-p"]), "capture-pane")
        // A queue is named by the command that says what the queue was for.
        XCTAssertEqual(TmuxMarkers.tmuxSubcommand(["display-message", "-p", "x", ";", "list-sessions"]), "display-message")
    }

    func testCarriesTheSubcommandAndTmuxsLastWordOutOfARefusal() async throws {
        let runner = unitRuntime(tmux: fakeTmux("echo \"usage: kill-session [-t target-session]\" >&2\necho \"can't find session: nope\" >&2\nexit 1"))
        let output = try await runner.runTmux(try SocketName("devhub"), ["kill-session", "-t", "nope"], cancel: CancellationToken(), deadline: .within(5_000))
        XCTAssertFalse(output.success)
        // The last line, not the first.
        XCTAssertEqual(output.refusal(), portFailure(.failed, detail: "tmux `kill-session` failed: can't find session: nope"))
    }

    func testReportsASocketItCouldNotConnectThroughAsThatNotAsAConflict() async throws {
        let path = "/private/tmp/\(String(repeating: "a", count: 90))/tmux-501/devhub"
        for (said, code) in [
            ("error connecting to \(path) (File name too long)", PortErrorCode.socketPathTooLong),
            ("couldn't create directory /tmp/locked/tmux-501 (Permission denied)", .socketUnusable),
        ] {
            let runner = unitRuntime(
                tmux: fakeTmux("[ \"$3\" = \"-V\" ] && { echo \"tmux 3.4\"; exit 0; }\necho \"\(said)\" >&2\nexit 1"),
                timeoutMs: 5_000
            )
            _ = await assertThrowsPortAsync(code) { _ = try await runner.agentRound([]) }
            _ = await assertThrowsPortAsync(code) { _ = try await runner.preflight(try SocketName("devhub")) }
        }
    }

    func testStillReadsAServerThatRefusedTheMarkerProbeAsAConflict() async throws {
        let runner = unitRuntime(
            tmux: fakeTmux("[ \"$3\" = \"-V\" ] && { echo \"tmux 3.4\"; exit 0; }\necho \"unknown command: display-message\" >&2\nexit 1"),
            timeoutMs: 5_000
        )
        let round = try await runner.agentRound([])
        XCTAssertEqual(round.marker, .wrong)
        let preflight = try await runner.preflight(try SocketName("devhub"))
        XCTAssertEqual(preflight.state, .wrongMarker)
    }

    func testSaysWhichCommandFellSilentAndHowLongDevHubWaited() async throws {
        let runner = unitRuntime(tmux: fakeTmux("sleep 5"))
        let failure = await assertThrowsPortAsync(.timedOut) {
            _ = try await runner.runTmux(try SocketName("devhub"), ["list-sessions", "-F", "#{session_name}"], cancel: CancellationToken(), deadline: .within(200))
        }
        XCTAssertEqual(failure?.detail, "tmux `list-sessions` did not answer within 0.2 s")
    }

    func testKeepsAMalformedAnswersOwnWordsWhichNameNoCommand() {
        XCTAssertThrowsError(try TmuxCommand.parseRecords(Data("one\u{1f}two\n".utf8), fieldCount: 2)) { error in
            XCTAssertEqual(error as? PortFailure, portFailure(.failed, detail: "DevHub could not read what tmux answered: it had an unterminated record."))
        }
    }

    func testRefusesAVersionBefore33AndAcceptsOneAfter() async throws {
        let old = unitRuntime(tmux: fakeTmux("echo \"tmux 3.2a\""), timeoutMs: 5_000)
        _ = await assertThrowsPortAsync(.incompatible) {
            try await old.ensureVersion(try SocketName("devhub"), cancel: CancellationToken(), deadline: .within(5_000))
        }
        let next = unitRuntime(tmux: fakeTmux("echo \"tmux next-3.6\""), timeoutMs: 5_000)
        _ = await assertThrowsPortAsync(.incompatible) {
            try await next.ensureVersion(try SocketName("devhub"), cancel: CancellationToken(), deadline: .within(5_000))
        }
        let good = unitRuntime(tmux: fakeTmux("echo \"tmux 3.4\""), timeoutMs: 5_000)
        try await good.ensureVersion(try SocketName("devhub"), cancel: CancellationToken(), deadline: .within(5_000))
    }
}
