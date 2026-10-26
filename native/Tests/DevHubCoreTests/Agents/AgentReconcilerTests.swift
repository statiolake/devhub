// Port of apps/desktop/src/main/shell/{agentReconciler,agentProfileCommand,
// terminalActivityLoop}.test.ts.

import Foundation
import XCTest
@testable import DevHubCore

/// A machine whose loop sleeps for no time at all.
private func host(_ id: RuntimeId, _ reconcileIntervalMs: Double = 0) -> any ReconcileHost {
    ReconcileHostValue(id: id) {
        RuntimeCadence(reconcileIntervalMs: reconcileIntervalMs, repositoryPollMs: 60_000, repositoryFocusRefreshMinIntervalMs: 5_000, headWatchPollMs: nil)
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    private var failures: [String] = []
    func bump(_ key: String = "") -> Int { lock.withLock { counts[key, default: 0] += 1; return counts[key]! } }
    func value(_ key: String = "") -> Int { lock.withLock { counts[key] ?? 0 } }
    func fail(_ text: String) { lock.withLock { failures.append(text) } }
    var said: [String] { lock.withLock { failures } }
}

/// A gate a round waits on until the test opens it.
final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var open = false
    func release() { lock.withLock { open = true } }
    func wait() async {
        while !lock.withLock({ open }) { try? await Task.sleep(nanoseconds: 1_000_000) }
    }
}

func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
    let deadline = Date().addingTimeInterval(2)
    while !condition() {
        if Date() > deadline {
            XCTFail("the reconciler never reached the expected state", file: file, line: line)
            return
        }
        try? await Task.sleep(nanoseconds: 1_000_000)
    }
}

final class AgentReconcilerLoopTests: XCTestCase {
    func testKeepsAskingWhileThereAreAgentsAndStopsWhenToldTo() async throws {
        let rounds = Counter()
        let reconciler = AgentReconciler(.init(
            host: host(.local), hasAgents: { true },
            reconcile: { _ = rounds.bump() },
            onFailure: { _ in rounds.fail("no round failed") }
        ))
        reconciler.start()
        await until { rounds.value() >= 3 }
        reconciler.stop()
        try await Task.sleep(nanoseconds: 10_000_000)
        let seen = rounds.value()
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(rounds.value(), seen)
        XCTAssertEqual(rounds.said, [])
    }

    func testAsksNothingWhileThereIsNoAgent() async throws {
        let rounds = Counter()
        let reconciler = AgentReconciler(.init(host: host(.local), hasAgents: { false }, reconcile: { _ = rounds.bump() }, onFailure: { _ in }))
        reconciler.start()
        try await Task.sleep(nanoseconds: 20_000_000)
        reconciler.stop()
        XCTAssertEqual(rounds.value(), 0)
    }

    func testNeverRunsARoundWhileThePreviousOneIsStillInFlight() async throws {
        let started = Counter()
        let first = Gate()
        let reconciler = AgentReconciler(.init(
            host: host(.local), hasAgents: { true },
            reconcile: { if started.bump() == 1 { await first.wait() } },
            onFailure: { _ in }
        ))
        reconciler.start()
        await until { started.value() == 1 }
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(started.value(), 1)
        first.release()
        await until { started.value() >= 2 }
        reconciler.stop()
    }

    func testReportsAFailedRoundAndKeepsGoing() async {
        let rounds = Counter()
        let reconciler = AgentReconciler(.init(
            host: host(.local), hasAgents: { true },
            reconcile: { if rounds.bump() == 1 { throw Said("the provider is unreachable") } },
            onFailure: { error in rounds.fail("\(error)") }
        ))
        reconciler.start()
        await until { rounds.value() >= 2 }
        reconciler.stop()
        XCTAssertEqual(rounds.said, ["the provider is unreachable"])
    }

    func testRunsTheNextRoundEarlyWhenTheAdapterSaysItSawSomething() async {
        let rounds = Counter()
        let reconciler = AgentReconciler(.init(host: host(.local, 60_000), hasAgents: { true }, reconcile: { _ = rounds.bump() }, onFailure: { _ in }))
        reconciler.start()
        await until { rounds.value() == 1 }
        reconciler.wake()
        await until { rounds.value() == 2 }
        reconciler.stop()
    }
}

final class AgentReconcilersTests: XCTestCase {
    func testDoesNotLetASlowMachineHoldAFastOneUp() async {
        let rounds = Counter()
        let loops = AgentReconcilers(reconcile: { about in _ = rounds.bump(about.id.rawValue) }, onFailure: { _ in })
        loops.follow([host(.local), host(.ssh("far"), 60_000)])
        await until { rounds.value("local") >= 5 }
        XCTAssertEqual(rounds.value("ssh:far"), 1)
        loops.stop()
    }

    func testKeepsALoopOnlyWhileItsMachineHasSomethingToReconcile() async throws {
        let rounds = Counter()
        let loops = AgentReconcilers(reconcile: { about in _ = rounds.bump(about.id.rawValue) }, onFailure: { _ in })
        loops.follow([host(.local), host(.ssh("far"))])
        await until { rounds.value("ssh:far") >= 2 }
        loops.follow([host(.local)])
        // A round already under way finishes.
        try await Task.sleep(nanoseconds: 5_000_000)
        let stoppedAt = rounds.value("ssh:far")
        let localAt = rounds.value("local")
        await until { rounds.value("local") > localAt + 3 }
        XCTAssertEqual(rounds.value("ssh:far"), stoppedAt)
        loops.stop()
    }

    func testIsIdempotentSoAProjectionChangeIsANudgeAndNotARestart() async throws {
        let rounds = Counter()
        let loops = AgentReconcilers(reconcile: { _ in _ = rounds.bump() }, onFailure: { _ in })
        loops.follow([host(.local)])
        await until { rounds.value() >= 2 }
        for _ in 0..<5 { loops.follow([host(.local)]) }
        XCTAssertEqual(loops.machines, [.local])
        let seen = rounds.value()
        try await Task.sleep(nanoseconds: 20_000_000)
        loops.stop()
        try await Task.sleep(nanoseconds: 5_000_000)
        let after = rounds.value()
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(rounds.value(), after)
        XCTAssertGreaterThan(after, seen)
    }

    func testRaisesNothingMoreAboutAMachineWhoseAgentsHaveGone() async throws {
        let rounds = Counter()
        let loops = AgentReconcilers(
            reconcile: { _ in
                _ = rounds.bump()
                throw Said("the host is not answering")
            },
            onFailure: { error in rounds.fail("\(error)") }
        )
        loops.follow([host(.ssh("far"))])
        await until { rounds.said.count >= 2 }
        loops.follow([])
        try await Task.sleep(nanoseconds: 5_000_000)
        let stoppedAt = rounds.value()
        let said = rounds.said.count
        try await Task.sleep(nanoseconds: 25_000_000)
        XCTAssertEqual(rounds.value(), stoppedAt)
        XCTAssertEqual(rounds.said.count, said)
        loops.stop()
    }
}

final class AgentProfileCommandTests: XCTestCase {
    let scratch = ScratchDirectories()
    override func tearDown() { scratch.removeAll() }

    func testIsLookedUpInTheLaunchPathItIsGiven() async throws {
        let bin = scratch.make("profile")
        try Data("#!/bin/sh\n".utf8).write(to: URL(fileURLWithPath: Path.join(bin, "local-agent")))
        chmod(Path.join(bin, "local-agent"), 0o755)
        let resolved = await TerminalAgentCommand.resolve(
            TerminalAgentProfile(kind: .custom, command: "local-agent", args: ["--profile"]),
            on: LocalRuntime(), extraArgs: [], searchPath: bin
        )
        XCTAssertEqual(resolved, .resolved(TerminalAgentProfile(kind: .custom, command: Path.join(bin, "local-agent"), args: ["--profile"])))
    }

    func testPutsTheProfilesOwnArgumentsFirstThenTheCallersInOrder() async throws {
        let resolved = await TerminalAgentCommand.resolve(
            TerminalAgentProfile(kind: .claude, command: "sh", args: ["--a", "--b"]),
            on: LocalRuntime(), extraArgs: ["--b", "--c"], searchPath: "/bin"
        )
        XCTAssertEqual(resolved, .resolved(TerminalAgentProfile(kind: .claude, command: "/bin/sh", args: ["--a", "--b", "--b", "--c"])))
    }

    func testSaysWhereItLookedWhenTheCommandIsNotThere() async {
        let resolved = await TerminalAgentCommand.resolve(
            TerminalAgentProfile(kind: .codex, command: "no-such-codex", args: []),
            on: LocalRuntime(), extraArgs: [], searchPath: "/nowhere"
        )
        guard case .unavailable(let lookup) = resolved else { return XCTFail("\(resolved)") }
        XCTAssertEqual(lookup.unavailableMessage, "DevHub could not find 'no-such-codex' on PATH (looked in: /nowhere).")
    }
}

final class TerminalActivityLoopCadenceTests: XCTestCase {
    func testAsksAMachineAtMostOnceASecond() {
        XCTAssertEqual(TerminalActivityLoop.host(host(.local, 300)).cadence.reconcileIntervalMs, TerminalActivityLoop.intervalMs)
    }

    func testGoesSlowerWithAMachineWhoseOwnCadenceIsSlower() {
        XCTAssertEqual(TerminalActivityLoop.host(host(.local, 2_400)).cadence.reconcileIntervalMs, 2_400)
    }

    func testFollowsACadenceThatMovesAsARemoteRuntimesDoes() {
        let interval = Counter()
        _ = interval.bump()
        let moving = ReconcileHostValue(id: .ssh("example")) {
            RuntimeCadence(reconcileIntervalMs: interval.value() == 1 ? 500 : 3_000, repositoryPollMs: 60_000, repositoryFocusRefreshMinIntervalMs: 10_000, headWatchPollMs: nil)
        }
        let clamped = TerminalActivityLoop.host(moving)
        XCTAssertEqual(clamped.cadence.reconcileIntervalMs, 1_000)
        _ = interval.bump()
        XCTAssertEqual(clamped.cadence.reconcileIntervalMs, 3_000)
    }

    func testAMachinesFailureIsSaidOncePerReasonAndAgainAfterItRecovered() {
        var once = FailureOnce()
        XCTAssertTrue(once.failed("ssh:a", "unreachable"))
        XCTAssertFalse(once.failed("ssh:a", "unreachable"))
        XCTAssertTrue(once.failed("ssh:b", "unreachable"))
        XCTAssertTrue(once.failed("ssh:a", "timeout"))
        once.succeeded("ssh:a")
        XCTAssertTrue(once.failed("ssh:a", "timeout"))
    }
}
