// Port of apps/desktop/src/main/agent/conversation/hostLink.test.ts and
// hostCommand.test.ts
//
// The host and its link, run for real against a fake agent
// (Fixtures/conversation/fake-agent.sh, the TS app's
// test/fixtures/agent-conversation/fake-agent.sh).
//
// The host here is started as a plain process group rather than a tmux
// session, because what is under test is the host's files and the link's
// reading of them; tmux adds nothing to either. A tmux kill is a SIGHUP to
// the pane's process group, and that is what `hangUp` sends.
//
// "DevHub restarted" is a second `HostLink` on the same directory with
// nothing carried over but an offset — which is all a restarted DevHub has.

import Foundation
import XCTest
@testable import DevHubCore

#if canImport(Glibc)
    import Glibc
#elseif canImport(Darwin)
    import Darwin
#endif

let FAKE_AGENT = Fixtures.url("conversation", "fake-agent.sh").path

/// Whether `pid` is a process still running: not gone, and not a zombie
/// nobody reaped (a container's pid 1 need not reap orphans).
func isAlive(_ pid: Int32) -> Bool {
    guard kill(pid, 0) == 0 else { return false }
    #if os(Linux)
        if let stat = try? String(contentsOfFile: "/proc/\(pid)/stat", encoding: .utf8),
           let close = stat.lastIndex(of: ")")
        {
            return !stat[stat.index(after: close)...].trimmingCharacters(in: .whitespaces).hasPrefix("Z")
        }
    #endif
    return true
}

/// A host started for a test, its own process group, reaped when it ends.
final class TestHost: @unchecked Sendable {
    let process: SpawnedProcess
    private let exited = Guarded(false)

    init(_ argv: [String]) throws {
        process = try SpawnedProcess(argv, keepStdin: false)
        SpawnedProcess.drain(process.stdoutFd, chunk: { _ in }, done: {})
        SpawnedProcess.drain(process.stderrFd, chunk: { _ in }, done: {})
        let exited = self.exited
        process.waitForExit { _, _ in exited.with { $0 = true } }
    }

    var hasExited: Bool { exited.with { $0 } }

    /// What tmux does to a session's pane on `kill-session`.
    func hangUp() { kill(-process.pid, SIGHUP) }

    func killAll() { if !hasExited { kill(-process.pid, SIGKILL) } }
}

class HostTestCase: XCTestCase {
    var scratch: [String] = []
    var hosts: [TestHost] = []

    override func tearDown() {
        for host in hosts { host.killAll() }
        hosts = []
        for directory in scratch { try? FileManager.default.removeItem(atPath: directory) }
        scratch = []
        super.tearDown()
    }

    func stateDirectory() throws -> String {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("devhub-host-\(UUID().uuidString)").path
        scratch.append(home)
        let directory = try agentStateDirectory(
            home: home, profileTag: "0123456789ab", agentId: "00000000-0000-4000-8000-0000000000e1")
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        return directory
    }

    /// The host with the fake agent under it, as its own process group.
    @discardableResult
    func startHost(_ directory: String, _ cli: [String] = ["/bin/sh", FAKE_AGENT]) throws -> TestHost {
        let command = hostSessionCommand(
            stateDirectory: directory, cli: CLICommand(file: cli[0], args: Array(cli.dropFirst())))
        let host = try TestHost([command.file] + command.args)
        hosts.append(host)
        return host
    }

    /// The machine the suite runs on; a subclass runs the same suite on another.
    func machine() -> HostMachine { LocalMachine() }

    func link(_ directory: String, writeTimeout: Double = HOST_WRITE_TIMEOUT_SECONDS) -> HostLink {
        HostLink(machine: machine(), stateDirectory: directory, writeTimeout: writeTimeout)
    }
}

/// Read `count` lines, and leave the iterator open.
func readLines(_ iterator: inout AsyncThrowingStream<JournalLine, Error>.Iterator, _ count: Int) async throws
    -> [JournalLine]
{
    var seen: [JournalLine] = []
    while seen.count < count {
        guard let next = try await iterator.next() else {
            throw HostLinkFailure(.streamLost, "the journal ended after \(seen.map(\.line))")
        }
        seen.append(next)
    }
    return seen
}

/// Every line until the journal ends by itself.
func readAll(_ iterator: inout AsyncThrowingStream<JournalLine, Error>.Iterator) async throws -> [JournalLine] {
    var seen: [JournalLine] = []
    while let next = try await iterator.next() { seen.append(next) }
    return seen
}

func failureOf(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async -> HostLinkFailure? {
    do {
        try await work()
        XCTFail("expected a HostLinkFailure, got none", file: file, line: line)
        return nil
    } catch let failure as HostLinkFailure {
        return failure
    } catch {
        XCTFail("expected a HostLinkFailure, got \(error)", file: file, line: line)
        return nil
    }
}

class HostLinkTests: HostTestCase {
    func testDeliversTheAgentsLinesAsTheyAreWrittenAndTakesALineToIt() async throws {
        let directory = try stateDirectory()
        try startHost(directory)
        let link = link(directory)
        let cancel = CancellationFlag()
        var lines = link.lines(from: 0, cancel: cancel).makeAsyncIterator()
        let hello = try await readLines(&lines, 1)[0]
        XCTAssertEqual(hello.line, #"{"type":"hello","argc":0}"#)
        XCTAssertEqual(hello.offset, #"{"type":"hello","argc":0}"#.utf8.count + 1)

        try await link.write(#"{"say":"日本語も一行"}"#, afterOffset: 0)
        let echo = try await readLines(&lines, 1)[0]
        XCTAssertEqual(echo.line, #"{"echo":{"say":"日本語も一行"}}"#)
        XCTAssertEqual(echo.offset, hello.offset + #"{"echo":{"say":"日本語も一行"}}"#.utf8.count + 1)

        cancel.cancel()
        let end = try await lines.next()
        XCTAssertNil(end)
        let sent = try await link.sentLog()
        XCTAssertEqual(sent, [SentRecord(afterOffset: 0, line: #"{"say":"日本語も一行"}"#)])
    }

    func testAttachesFromAnOffsetAfterDevHubRestartsWithNothingMissingAndNothingTwice() async throws {
        let directory = try stateDirectory()
        try startHost(directory)
        let first = link(directory)
        let firstCancel = CancellationFlag()
        var firstLines = first.lines(from: 0, cancel: firstCancel).makeAsyncIterator()
        _ = try await readLines(&firstLines, 1)
        try await first.write(#"{"fake":"count","n":200}"#, afterOffset: 0)
        let before = try await readLines(&firstLines, 37)
        // DevHub goes away in the middle of a burst: the stream is killed and
        // nothing but the last offset survives.
        firstCancel.cancel()

        let again = link(directory)
        let cancel = CancellationFlag()
        var afterLines = again.lines(from: before.last!.offset, cancel: cancel).makeAsyncIterator()
        let after = try await readLines(&afterLines, 200 - 37)
        cancel.cancel()
        XCTAssertEqual((before + after).map(\.line), (1...200).map { #"{"seq":\#($0)}"# })

        // And from the top, which is what a restarted DevHub replays.
        let replayCancel = CancellationFlag()
        var replayLines = again.lines(from: 0, cancel: replayCancel).makeAsyncIterator()
        let replay = try await readLines(&replayLines, 201)
        replayCancel.cancel()
        XCTAssertEqual(replay[0].line, #"{"type":"hello","argc":0}"#)
        XCTAssertEqual(replay[200].line, #"{"seq":200}"#)
    }

    func testStartsTheCLIAgainAsTheWholeArgvItIsGivenTheMarkBetween() async throws {
        let directory = try stateDirectory()
        try startHost(directory, ["/bin/sh", FAKE_AGENT, "--resume", "the old one"])
        let link = link(directory)
        var lines = link.lines(from: 0, cancel: CancellationFlag()).makeAsyncIterator()
        let hello = try await readLines(&lines, 1)[0]
        XCTAssertEqual(hello.line, #"{"type":"hello","argc":2}"#)
        try await link.write(#"{"to":"the first"}"#, afterOffset: 0)
        _ = try await readLines(&lines, 1)

        // The argv replaces the first start's: two arguments, not four.
        try await link.restart(
            RestartedCLI(file: "/bin/sh", args: [FAKE_AGENT, "--resume", "a session id"]), mark: [#"{"mark":"here"}"#])
        let restarted = try await readLines(&lines, 2)
        XCTAssertEqual(restarted.map(\.line), [#"{"mark":"here"}"#, #"{"type":"hello","argc":2}"#])
        try await link.write(#"{"to":"the second"}"#, afterOffset: 0)
        let echo = try await readLines(&lines, 1)[0]
        XCTAssertEqual(echo.line, #"{"echo":{"to":"the second"}}"#)

        // A second start is its own argv again, not the first start's or the host's.
        try await link.restart(RestartedCLI(file: "/bin/sh", args: [FAKE_AGENT]), mark: [#"{"mark":"again"}"#])
        let again = try await readLines(&lines, 2)
        XCTAssertEqual(again.map(\.line), [#"{"mark":"again"}"#, #"{"type":"hello","argc":0}"#])

        // And the host still ends as its CLI does.
        try await link.write(#"{"fake":"exit","code":3}"#, afterOffset: 0)
        let rest = try await readAll(&lines)
        XCTAssertEqual(rest, [])
        guard case .exited(let code, _) = try await link.ending() else { return XCTFail("not exited") }
        XCTAssertEqual(code, 3)
    }

    func testPutsAMarkOfManyLinesInTheJournalWholeInOrder() async throws {
        let directory = try stateDirectory()
        try startHost(directory)
        let link = link(directory)
        var lines = link.lines(from: 0, cancel: CancellationFlag()).makeAsyncIterator()
        _ = try await readLines(&lines, 1)
        let long = #"{"history":"\#(String(repeating: "x", count: 100_000))"}"#
        try await link.restart(
            RestartedCLI(file: "/bin/sh", args: [FAKE_AGENT, "--resume", "a session id"]),
            mark: [#"{"mark":"resume"}"#, long, #"{"history":"last"}"#])
        let restarted = try await readLines(&lines, 4)
        XCTAssertEqual(
            restarted.map(\.line), [#"{"mark":"resume"}"#, long, #"{"history":"last"}"#, #"{"type":"hello","argc":2}"#])
    }

    func testRefusesToStartAgainTheCLIOfAHostThatWouldAddTheArgvToItsOwn() async throws {
        let directory = try stateDirectory()
        try startHost(directory)
        let link = link(directory)
        var lines = link.lines(from: 0, cancel: CancellationFlag()).makeAsyncIterator()
        _ = try await readLines(&lines, 1)
        // What a host started by an earlier DevHub lacks.
        try FileManager.default.removeItem(atPath: "\(directory)/version")
        let failure = await failureOf {
            try await link.restart(RestartedCLI(file: "/bin/sh", args: [FAKE_AGENT]), mark: [#"{"mark":"old host"}"#])
        }
        XCTAssertTrue(failure?.message.contains("it was started by a DevHub from before") ?? false, "\(String(describing: failure))")
        try await link.write(#"{"still":"here"}"#, afterOffset: 0)
        let echo = try await readLines(&lines, 1)[0]
        XCTAssertEqual(echo.line, #"{"echo":{"still":"here"}}"#)
    }

    func testRefusesToStartAgainTheCLIOfAHostThatIsGone() async throws {
        let directory = try stateDirectory()
        try startHost(directory)
        let link = link(directory)
        var lines = link.lines(from: 0, cancel: CancellationFlag()).makeAsyncIterator()
        _ = try await readLines(&lines, 1)
        try await link.write(#"{"fake":"exit","code":0}"#, afterOffset: 0)
        _ = try await readAll(&lines)
        let failure = await failureOf {
            try await link.restart(RestartedCLI(file: "/bin/sh", args: [FAKE_AGENT]), mark: [#"{"mark":"late"}"#])
        }
        XCTAssertEqual(failure?.code, .hostGone)
        XCTAssertTrue(failure?.message.contains("there is no CLI to start again") ?? false)
    }

    func testEndsTheJournalWhenTheAgentExitsAndSaysWithWhatAndWhy() async throws {
        let directory = try stateDirectory()
        try startHost(directory)
        let link = link(directory)
        var lines = link.lines(from: 0, cancel: CancellationFlag()).makeAsyncIterator()
        _ = try await readLines(&lines, 1)
        try await link.write(#"{"before":"exit"}"#, afterOffset: 0)
        try await link.write(#"{"fake":"exit","code":3}"#, afterOffset: 0)
        let rest = try await readAll(&lines)
        XCTAssertEqual(rest.map(\.line), [#"{"echo":{"before":"exit"}}"#])
        let ending = try await link.ending()
        guard case .exited(let code, let tail) = ending else { return XCTFail("not exited: \(ending)") }
        XCTAssertEqual(code, 3)
        XCTAssertTrue(tail.contains("fake-agent: exiting with 3"))
    }

    func testHandsOnALastLineTheAgentNeverFinished() async throws {
        let directory = try stateDirectory()
        try startHost(directory)
        let link = link(directory)
        var lines = link.lines(from: 0, cancel: CancellationFlag()).makeAsyncIterator()
        _ = try await readLines(&lines, 1)
        try await link.write(#"{"fake":"partial"}"#, afterOffset: 0)
        let rest = try await readAll(&lines)
        XCTAssertEqual(rest.map(\.line), [#"{"cut":"#])
        XCTAssertEqual(rest.first?.offset, try Data(contentsOf: URL(fileURLWithPath: "\(directory)/out")).count)
        guard case .exited(let code, _) = try await link.ending() else { return XCTFail("not exited") }
        XCTAssertEqual(code, 9)
    }

    func testTellsAHostThatWasKilledFromOneThatEndedAndRefusesToWriteToIt() async throws {
        let directory = try stateDirectory()
        let host = try startHost(directory)
        let link = link(directory)
        var lines = link.lines(from: 0, cancel: CancellationFlag()).makeAsyncIterator()
        _ = try await readLines(&lines, 1)

        let running = await failureOf { _ = try await link.ending() }
        XCTAssertEqual(running?.code, .hostRunning)
        host.hangUp()

        let rest = try await readAll(&lines)
        XCTAssertEqual(rest, [])
        guard case .vanished = try await link.ending() else { return XCTFail("not vanished") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: "\(directory)/exit"))
        // The CLI runs beside the host, not in its place, and the hang-up reaches it too.
        let cli = Int32(JSString.trim(try String(contentsOfFile: "\(directory)/cli", encoding: .utf8)))!
        XCTAssertFalse(isAlive(cli))
        let refused = await failureOf { try await link.write(#"{"after":"death"}"#, afterOffset: 0) }
        XCTAssertEqual(refused?.code, .hostGone)
        XCTAssertTrue(refused?.message.contains("nothing is reading its input") ?? false)
    }

    func testHoldsAWriteForAHostThatHasNotStartedYet() async throws {
        let directory = try stateDirectory()
        let link = link(directory)
        async let written: Void = link.write(#"{"first":"line"}"#, afterOffset: 0)
        try await Task.sleep(nanoseconds: 200_000_000)
        try startHost(directory)
        try await written
        var lines = link.lines(from: 0, cancel: CancellationFlag()).makeAsyncIterator()
        let seen = try await readLines(&lines, 2)
        XCTAssertEqual(seen.map(\.line), [#"{"type":"hello","argc":0}"#, #"{"echo":{"first":"line"}}"#])
    }

    func testSaysAWriteTimedOutWhenTheAgentIsNotReading() async throws {
        let directory = try stateDirectory()
        try startHost(directory, ["/bin/sh", "-c", "sleep 30"])
        let link = link(directory, writeTimeout: 1.5)
        // Far more than any pipe holds, so the write has to wait for a reader.
        let failure = await failureOf {
            try await link.write(String(repeating: "x", count: 1024 * 1024), afterOffset: 0)
        }
        XCTAssertEqual(failure?.code, .writeFailed)
        XCTAssertTrue(failure?.message.contains("did not take a line") ?? false)
    }

    func testFailsVisiblyWhenTheJournalIsTruncatedUnderIt() async throws {
        let directory = try stateDirectory()
        try startHost(directory)
        let link = link(directory)
        var lines = link.lines(from: 0, cancel: CancellationFlag()).makeAsyncIterator()
        try await link.write(#"{"fake":"count","n":5}"#, afterOffset: 0)
        let seen = try await readLines(&lines, 6)
        // The watchdog compares sizes once a second: let it see the whole
        // journal before it shrinks, or a shrink to what it saw last is none.
        try await Task.sleep(nanoseconds: 1_500_000_000)
        _ = truncate("\(directory)/out", 0)
        let failure = await failureOf { _ = try await readAll(&lines) }
        XCTAssertEqual(failure?.code, .journalTruncated)
        XCTAssertTrue(failure?.message.contains("truncated or replaced") ?? false)
        XCTAssertEqual(failure?.offset, seen[5].offset)
    }

    func testRefusesAnOffsetPastTheEndOfTheJournal() async throws {
        let directory = try stateDirectory()
        try startHost(directory)
        let link = link(directory)
        let firstCancel = CancellationFlag()
        var first = link.lines(from: 0, cancel: firstCancel).makeAsyncIterator()
        let hello = try await readLines(&first, 1)[0]
        firstCancel.cancel()
        var past = link.lines(from: hello.offset + 100, cancel: CancellationFlag()).makeAsyncIterator()
        let failure = await failureOf { _ = try await readAll(&past) }
        XCTAssertEqual(failure?.code, .journalTruncated)
        XCTAssertTrue(failure?.message.contains("fewer than the") ?? false)
    }

    func testFailsVisiblyWhenTheFollowerIsKilledFromOutside() async throws {
        let directory = try stateDirectory()
        try startHost(directory)
        let link = link(directory)
        var lines = link.lines(from: 0, cancel: CancellationFlag()).makeAsyncIterator()
        let hello = try await readLines(&lines, 1)[0]
        // Only this case's `tail`: its argv is the one that names this
        // directory's journal after `-f`.
        let pkill = try TestHost(["pkill", "-f", "tail -c \\+[0-9]+ -f \(directory)/out"])
        _ = pkill
        let failure = await failureOf { _ = try await readAll(&lines) }
        XCTAssertEqual(failure?.code, .streamLost)
        XCTAssertTrue(failure?.message.contains("tail stopped following") ?? false, "\(String(describing: failure))")
        XCTAssertEqual(failure?.offset, hello.offset)
    }

    func testSaysTheHostCouldNotStartTheAgentAndWhy() async throws {
        let directory = try stateDirectory()
        // An `in` that is already there is a FIFO the host cannot make.
        try FileManager.default.createDirectory(atPath: "\(directory)/in", withIntermediateDirectories: false)
        try startHost(directory)
        let link = link(directory)
        var lines = link.lines(from: 0, cancel: CancellationFlag()).makeAsyncIterator()
        let failure = await failureOf { _ = try await readAll(&lines) }
        XCTAssertEqual(failure?.code, .hostNotStarted)
        XCTAssertTrue(failure?.message.contains("cannot make the input pipe") ?? false)
        let ending = try await link.ending()
        guard case .hostFailed(let tail) = ending else { return XCTFail("not host_failed: \(ending)") }
        XCTAssertTrue(tail.contains("devhub-agent-host: cannot make the input pipe"))
    }

    func testSaysTheAgentWasNotThereInTheShellsOwnWords() async throws {
        let directory = try stateDirectory()
        try startHost(directory, ["devhub-no-such-agent-cli"])
        let link = link(directory)
        var lines = link.lines(from: 0, cancel: CancellationFlag()).makeAsyncIterator()
        let rest = try await readAll(&lines)
        XCTAssertEqual(rest, [])
        guard case .exited(let code, let tail) = try await link.ending() else { return XCTFail("not exited") }
        XCTAssertEqual(code, 127)
        XCTAssertTrue(tail.contains("devhub-no-such-agent-cli"))
    }

    func testFailsVisiblyOnAStateDirectoryThatIsNotThere() async throws {
        let directory = try stateDirectory() + "/gone"
        let link = link(directory)
        var lines = link.lines(from: 0, cancel: CancellationFlag()).makeAsyncIterator()
        let stream = await failureOf { _ = try await readAll(&lines) }
        XCTAssertEqual(stream?.code, .stateMissing)
        let write = await failureOf { try await link.write("{}", afterOffset: 0) }
        XCTAssertEqual(write?.code, .stateMissing)
        let sent = await failureOf { _ = try await link.sentLog() }
        XCTAssertEqual(sent?.code, .stateMissing)
        let ending = await failureOf { _ = try await link.ending() }
        XCTAssertEqual(ending?.code, .stateMissing)
    }

    func testKeepsEachWrittenLineWithTheJournalOffsetItFollowed() async throws {
        let directory = try stateDirectory()
        try startHost(directory)
        let link = link(directory)
        let cancel = CancellationFlag()
        var lines = link.lines(from: 0, cancel: cancel).makeAsyncIterator()
        let hello = try await readLines(&lines, 1)[0]
        try await link.write(#"{"a":"one line"}"#, afterOffset: 0)
        try await link.write(#"{"b":"with  spaces "}"#, afterOffset: hello.offset)
        let echoes = try await readLines(&lines, 2)
        // The agent was given the lines alone.
        XCTAssertEqual(echoes.map(\.line), [#"{"echo":{"a":"one line"}}"#, #"{"echo":{"b":"with  spaces "}}"#])
        let sent = try await link.sentLog()
        XCTAssertEqual(
            sent,
            [
                SentRecord(afterOffset: 0, line: #"{"a":"one line"}"#),
                SentRecord(afterOffset: hello.offset, line: #"{"b":"with  spaces "}"#),
            ])
        cancel.cancel()
    }

    func testFailsVisiblyOnAnInputLogLineWithNoOffset() async throws {
        let directory = try stateDirectory()
        try "12 {\"fine\":1}\n{\"no\":\"offset\"}\n".write(toFile: "\(directory)/in.log", atomically: true, encoding: .utf8)
        let failure = await failureOf { _ = try await self.link(directory).sentLog() }
        XCTAssertEqual(failure?.code, .unreadable)
        XCTAssertTrue(failure?.message.contains("line 2 of the input log") ?? false)
    }

    func testRefusesAnOffsetThatIsNotOneAndALineWithANewline() async throws {
        let link = link(try stateDirectory())
        do {
            try await link.write("{}", afterOffset: -1)
            XCTFail("took a negative offset")
        } catch { XCTAssertTrue("\(error)".contains("is not a journal offset")) }
        do {
            try await link.write("one\ntwo", afterOffset: 0)
            XCTFail("took a newline")
        } catch { XCTAssertTrue("\(error)".contains("must not contain a newline")) }
    }
}

/// The same suite through WP3's `LocalRuntime`, the way the coordinator
/// reaches a Workspace's machine (`describeHostLink` in the TS app runs it
/// per machine too).
final class HostLinkOverRuntimeTests: HostLinkTests {
    override func machine() -> HostMachine { RuntimeHostMachine(LocalRuntime()) }

    // Declared again so that test discovery on Linux, which reads each
    // class's own methods, runs them here too.
    override func testDeliversTheAgentsLinesAsTheyAreWrittenAndTakesALineToIt() async throws { try await super.testDeliversTheAgentsLinesAsTheyAreWrittenAndTakesALineToIt() }
    override func testStartsTheCLIAgainAsTheWholeArgvItIsGivenTheMarkBetween() async throws { try await super.testStartsTheCLIAgainAsTheWholeArgvItIsGivenTheMarkBetween() }
    override func testTellsAHostThatWasKilledFromOneThatEndedAndRefusesToWriteToIt() async throws { try await super.testTellsAHostThatWasKilledFromOneThatEndedAndRefusesToWriteToIt() }
}

final class HostCommandTests: XCTestCase {
    let TAG = "0123456789ab"
    let AGENT = "550e8400-e29b-41d4-a716-4466554400d0"

    func testIsUnderThisProfilesOwnDirectory() throws {
        XCTAssertEqual(
            try agentStateDirectory(home: "/home/testuser", profileTag: TAG, agentId: AGENT),
            "/home/testuser/.devhub/agents-\(TAG)/\(AGENT)")
        XCTAssertNotEqual(
            try agentStateDirectory(home: "/home/testuser", profileTag: "fedcba987654", agentId: AGENT),
            try agentStateDirectory(home: "/home/testuser", profileTag: TAG, agentId: AGENT))
    }

    func testRefusesAnIdOrATagThatCouldNameAPathElsewhere() {
        assertThrows(try agentStateDirectory(home: "/home/testuser", profileTag: TAG, agentId: "../x"), "Agent id")
        assertThrows(try agentStateDirectory(home: "/home/testuser", profileTag: "../x", agentId: AGENT), "profile tag")
    }

    func testListsTheOnesNamedLikeAnAgentDevHubMadeAndRemovesOneByOne() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("devhub-hostfiles-\(UUID().uuidString)").path
        defer { try? FileManager.default.removeItem(atPath: home) }
        let machine = FakeHomeMachine(home: home)
        let files = try await agentHostFiles(machine, profileTag: TAG)
        let none = try await files.list()
        XCTAssertEqual(none, [])
        let root = "\(home)/.devhub/agents-\(TAG)"
        for name in [AGENT, "not-an-agent", "550E8400-E29B-41D4-A716-4466554400D1"] {
            try FileManager.default.createDirectory(atPath: "\(root)/\(name)", withIntermediateDirectories: true)
        }
        _ = FileManager.default.createFile(atPath: "\(root)/550e8400-e29b-41d4-a716-4466554400d2", contents: Data())
        let listed = try await files.list()
        XCTAssertEqual(listed, [AGENT])
        try await files.remove(AGENT)
        XCTAssertFalse(FileManager.default.fileExists(atPath: "\(root)/\(AGENT)"))
    }

    func testRunsTheCLIUnderTheHostAsPositionalWords() {
        let command = hostSessionCommand(
            stateDirectory: "/s", cli: CLICommand(file: "claude", args: ["--model", "a b"], env: ["X": "1"]))
        XCTAssertEqual(command.file, "/bin/sh")
        XCTAssertEqual(command.args, ["-c", HOST_SCRIPT, "devhub-agent-host", "/s", "claude", "--model", "a b"])
        XCTAssertEqual(command.env, ["X": "1"])
    }

    func testAGUIAgentsCLIIsItsProfilesInTheStructuredModeOnTheSessionPicked() {
        let claude = GuiAgentProfile(kind: .claude, command: "claude", args: ["--resume", "old", "--model", "x"])
        XCTAssertEqual(guiAgentCli(claude).args, ["--resume", "old", "--model", "x"] + CLAUDE_STRUCTURED_FLAGS)
        XCTAssertEqual(
            guiAgentCli(claude, session: ["--resume", "new"]).args, ["--model", "x", "--resume", "new"] + CLAUDE_STRUCTURED_FLAGS)
        let codex = GuiAgentProfile(kind: .codex, command: "codex", args: ["-c", "a=b", "resume", "t1"])
        XCTAssertEqual(guiAgentCli(codex).args, ["-c", "a=b", "app-server"])
    }
}

/// This machine, with another home.
struct FakeHomeMachine: HostMachine {
    let home: String
    let local = LocalMachine()
    var whereSuffix: String { "" }
    func home() async throws -> String { home }
    func exec(_ argv: [String], stdin: Data?, timeout: Double, limits: MachineLimits) async throws -> MachineResult {
        try await local.exec(argv, stdin: stdin, timeout: timeout, limits: limits)
    }
    func spawnStream(_ argv: [String]) throws -> MachineStream { try local.spawnStream(argv) }
    func stat(_ path: String) async throws -> MachineFileKind { try await local.stat(path) }
    func readDirectory(_ path: String) async throws -> [MachineDirEntry] { try await local.readDirectory(path) }
    func removeTree(_ path: String) async throws { try await local.removeTree(path) }
    func writeTextFile(_ path: String, _ text: String, mode: Int) async throws {
        try await local.writeTextFile(path, text, mode: mode)
    }
}
