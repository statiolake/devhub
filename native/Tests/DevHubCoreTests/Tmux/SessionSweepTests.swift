// Port of apps/desktop/src/main/shell/sessionSweep.test.ts.

import Foundation
import XCTest
@testable import DevHubCore

private let WORKSPACE_ONE = "11111111-1111-4111-8111-111111111111"
private let WORKSPACE_TWO = "22222222-2222-4222-8222-222222222222"
private let AGENT_ONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
private let AGENT_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

private func workspaceSession(_ workspaceId: String) -> OwnedSessionRecord {
    .workspace(workspaceId: workspaceId, sessionName: "ws-" + workspaceId.prefix(20))
}

private func agentSession(_ agentId: String, _ workspaceId: String) -> OwnedSessionRecord {
    .agent(agentId: agentId, workspaceId: workspaceId, sessionName: "ag-\(agentId)")
}

private let SCRATCH = OwnedSessionRecord.scratch(sessionName: "devhub-scratch")

private func accounting(_ workspaces: [String], _ agents: [String], _ terminals: [String] = []) -> SweepAccounting {
    SweepAccounting(workspaces: Set(workspaces), agents: Set(agents), terminals: Set(terminals))
}

struct Said: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// One machine's tmux, as a sweep sees it.
private final class SweepMachine: SweepAdapter, @unchecked Sendable {
    private let lock = NSLock()
    private var _sessions: [OwnedSessionRecord]
    private var _killed: [String] = []
    private var _listings = 0
    var _available = true
    var unreachable: String?

    init(_ sessions: [OwnedSessionRecord]) { _sessions = sessions }

    var adapterAvailable: Bool { lock.withLock { _available } }
    var killed: [String] { lock.withLock { _killed } }
    var listings: Int { lock.withLock { _listings } }

    func markedSessions(cancel: CancellationToken) async throws -> [OwnedSessionRecord] {
        lock.withLock {
            _listings += 1
            return _sessions
        }
    }

    func closeMarkedSession(_ record: OwnedSessionRecord, cancel: CancellationToken) async throws {
        lock.withLock {
            _killed.append(record.sessionName)
            _sessions.removeAll { $0.sessionName == record.sessionName }
        }
    }
}

/// One machine's GUI Agent host directories, by Agent id.
private final class SweepHostFiles: AgentHostFiles, @unchecked Sendable {
    private let lock = NSLock()
    private var _directories: [String]
    private var _removed: [String] = []
    init(_ directories: [String] = []) { _directories = directories }
    var removed: [String] { lock.withLock { _removed } }
    var directories: [String] { lock.withLock { _directories } }

    func list() async throws -> [String] { lock.withLock { _directories } }

    func remove(_ agentId: String) async throws {
        lock.withLock {
            _removed.append(agentId)
            _directories.removeAll { $0 == agentId }
        }
    }
}

private final class SweepWorld: SessionSweepWorld, @unchecked Sendable {
    private let lock = NSLock()
    var adapters: [RuntimeId: SweepMachine] = [:]
    var hostFiles: [RuntimeId: SweepHostFiles] = [:]
    var hostFilesFailure: String?
    var remembered_: [String] = []
    var workspaceMachines_: [RuntimeId] = [.local]
    var accounted_ = accounting([], [])
    var forgotten: [RuntimeId] = []

    func adapter(for machine: RuntimeId) async throws -> any SweepAdapter {
        guard let found = lock.withLock({ adapters[machine] }) else { throw Said("DevHub cannot reach \(machine)") }
        if let unreachable = found.unreachable { throw Said(unreachable) }
        return found
    }

    func hostFiles(for machine: RuntimeId) async throws -> any AgentHostFiles {
        if let hostFilesFailure { throw Said(hostFilesFailure) }
        return lock.withLock {
            if let files = hostFiles[machine] { return files }
            let files = SweepHostFiles()
            hostFiles[machine] = files
            return files
        }
    }

    func accounted() -> SweepAccounting { lock.withLock { accounted_ } }
    func workspaceMachines() -> [RuntimeId] { lock.withLock { workspaceMachines_ } }
    func remembered() -> [String] { lock.withLock { remembered_ } }

    func forget(_ machine: RuntimeId) {
        lock.withLock {
            forgotten.append(machine)
            remembered_.removeAll { $0 == machine.rawValue }
        }
    }
}

private let example = RuntimeId.ssh("example")

final class UnaccountedSessionsTests: XCTestCase {
    func testKeepsTheOnesTheModelStillHasAndReapsTheOldScratchAnchor() {
        let stray = SessionSweep.unaccountedSessions(
            [SCRATCH, workspaceSession(WORKSPACE_ONE), agentSession(AGENT_ONE, WORKSPACE_ONE)],
            accounted: accounting([WORKSPACE_ONE], [AGENT_ONE])
        )
        XCTAssertEqual(stray, [SCRATCH])
    }

    func testNamesATerminalSessionWhoseWorkspaceIsGoneAndAnAgentsWhoseAgentIs() {
        let stray = SessionSweep.unaccountedSessions(
            [SCRATCH, workspaceSession(WORKSPACE_ONE), workspaceSession(WORKSPACE_TWO), agentSession(AGENT_ONE, WORKSPACE_ONE), agentSession(AGENT_TWO, WORKSPACE_TWO)],
            accounted: accounting([WORKSPACE_ONE], [AGENT_ONE])
        )
        XCTAssertEqual(stray.map(\.sessionName), ["devhub-scratch", "ws-" + WORKSPACE_TWO.prefix(20), "ag-\(AGENT_TWO)"])
    }

    func testKeepsAPaneTerminalItsWorkspaceListsAndReapsOneNothingLists() {
        func terminal(_ id: String) -> OwnedSessionRecord { .terminal(terminalId: id, workspaceId: WORKSPACE_ONE, sessionName: "tm-\(id)") }
        let stray = SessionSweep.unaccountedSessions(
            [workspaceSession(WORKSPACE_ONE), terminal(AGENT_ONE), terminal(AGENT_TWO)],
            accounted: accounting([WORKSPACE_ONE], [], [AGENT_ONE])
        )
        XCTAssertEqual(stray.map(\.sessionName), ["tm-\(AGENT_TWO)"])
    }
}

final class SessionSweeperTests: XCTestCase {
    func testReapsTheLeftoverTerminalAndAgentSessionsOnAHostNoWorkspaceUses() async {
        let world = SweepWorld()
        let host = SweepMachine([workspaceSession(WORKSPACE_TWO), agentSession(AGENT_TWO, WORKSPACE_TWO)])
        world.adapters[example] = host
        world.adapters[.local] = SweepMachine([SCRATCH])
        world.remembered_ = ["ssh:example"]
        await SessionSweeper(world: world, log: { _ in }).sweepAll()
        XCTAssertEqual(host.killed, ["ws-" + WORKSPACE_TWO.prefix(20), "ag-\(AGENT_TWO)"])
        // It stays in the set: something was there this time.
        XCTAssertEqual(world.forgotten, [])
    }

    func testTouchesNothingOnAMachineWhoseSessionsTheModelStillAccountsFor() async {
        let world = SweepWorld()
        let host = SweepMachine([workspaceSession(WORKSPACE_ONE), agentSession(AGENT_ONE, WORKSPACE_ONE)])
        world.adapters[example] = host
        world.adapters[.local] = SweepMachine([SCRATCH])
        world.workspaceMachines_ = [.local, example]
        world.accounted_ = accounting([WORKSPACE_ONE], [AGENT_ONE])
        await SessionSweeper(world: world, log: { _ in }).sweepAll()
        XCTAssertEqual(host.killed, [])
        XCTAssertEqual(world.forgotten, [])
    }

    func testNeverSeesASessionThatIsNotDevHubsBecauseTheAdapterNeverListsOne() async {
        let world = SweepWorld()
        let host = SweepMachine([])
        world.adapters[example] = host
        world.adapters[.local] = SweepMachine([SCRATCH])
        world.remembered_ = ["ssh:example"]
        await SessionSweeper(world: world, log: { _ in }).sweepAll()
        XCTAssertEqual(host.killed, [])
    }

    func testDropsAMachineThatCameUpCleanAndHasNoWorkspaceLeft() async {
        let world = SweepWorld()
        world.adapters[example] = SweepMachine([])
        world.adapters[.local] = SweepMachine([SCRATCH])
        world.remembered_ = ["ssh:example"]
        await SessionSweeper(world: world, log: { _ in }).sweepAll()
        XCTAssertEqual(world.forgotten, [example])
        XCTAssertEqual(world.remembered_, [])
    }

    func testKeepsThisMacEvenWhenItIsCleanBecauseAWorkspaceIsAlwaysOnIt() async {
        let world = SweepWorld()
        world.adapters[.local] = SweepMachine([SCRATCH])
        await SessionSweeper(world: world, log: { _ in }).sweepAll()
        XCTAssertEqual(world.forgotten, [])
    }

    func testKeepsAnUnreachableMachinePendingAndSweepsItWhenItComesBack() async {
        let world = SweepWorld()
        let host = SweepMachine([workspaceSession(WORKSPACE_TWO)])
        host.unreachable = "ssh: connect to host example port 22: Host is down"
        world.adapters[example] = host
        world.adapters[.local] = SweepMachine([SCRATCH])
        world.remembered_ = ["ssh:example"]
        let sweeper = SessionSweeper(world: world, log: { _ in })
        await sweeper.sweepAll()
        XCTAssertEqual(sweeper.pending, [example])
        XCTAssertEqual(host.killed, [])
        XCTAssertEqual(world.forgotten, [])
        host.unreachable = nil
        sweeper.machineCameBack(example)
        await sweeper.sweep(example)
        XCTAssertEqual(host.killed, ["ws-" + WORKSPACE_TWO.prefix(20)])
        XCTAssertEqual(sweeper.pending, [])
    }

    func testIgnoresAMachineComingBackThatNothingIsWaitingOn() async throws {
        let world = SweepWorld()
        let host = SweepMachine([])
        world.adapters[example] = host
        let sweeper = SessionSweeper(world: world, log: { _ in })
        sweeper.machineCameBack(example)
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(host.listings, 0)
    }

    func testAsksAMachineWithNoTmuxNothingAndCallsItClean() async {
        let world = SweepWorld()
        let host = SweepMachine([])
        host._available = false
        world.adapters[example] = host
        world.adapters[.local] = SweepMachine([SCRATCH])
        world.remembered_ = ["ssh:example"]
        await SessionSweeper(world: world, log: { _ in }).sweepAll()
        XCTAssertEqual(host.listings, 0)
        XCTAssertEqual(world.forgotten, [example])
    }

    func testAsksEveryMachineEvenWhenOneOfThemFails() async {
        let world = SweepWorld()
        let good = SweepMachine([workspaceSession(WORKSPACE_TWO)])
        world.adapters[.ssh("good")] = good
        world.adapters[.local] = SweepMachine([SCRATCH])
        world.remembered_ = ["ssh:bad", "ssh:good"]
        let sweeper = SessionSweeper(world: world, log: { _ in })
        await sweeper.sweepAll()
        XCTAssertEqual(good.killed, ["ws-" + WORKSPACE_TWO.prefix(20)])
        XCTAssertEqual(sweeper.pending, [.ssh("bad")])
    }

    func testSkipsAPersistedNameThatSpellsNoMachineAndSweepsTheRest() async {
        let world = SweepWorld()
        world.adapters[.local] = SweepMachine([SCRATCH])
        world.remembered_ = ["not a machine"]
        let sweeper = SessionSweeper(world: world, log: { _ in })
        XCTAssertEqual(sweeper.machines(), [.local])
        await sweeper.sweepAll()
        XCTAssertEqual(sweeper.pending, [])
    }
}

final class HostFilesSweepTests: XCTestCase {
    func testRemovesTheDirectoryOfAnAgentNothingAccountsForAndKeepsTheRest() async {
        let world = SweepWorld()
        let local = SweepMachine([agentSession(AGENT_TWO, WORKSPACE_ONE)])
        world.adapters[.local] = local
        let files = SweepHostFiles([AGENT_ONE, AGENT_TWO])
        world.hostFiles[.local] = files
        world.accounted_ = accounting([WORKSPACE_ONE], [AGENT_ONE])
        await SessionSweeper(world: world, log: { _ in }).sweep(.local)
        XCTAssertEqual(local.killed, ["ag-\(AGENT_TWO)"])
        XCTAssertEqual(files.removed, [AGENT_TWO])
        XCTAssertEqual(files.directories, [AGENT_ONE])
    }

    func testDoesNotForgetAMachineItJustRemovedHostFilesFrom() async {
        let world = SweepWorld()
        let build = RuntimeId.ssh("build.example.com")
        world.workspaceMachines_ = [.local]
        world.remembered_ = ["ssh:build.example.com"]
        world.adapters[build] = SweepMachine([])
        let files = SweepHostFiles([AGENT_TWO])
        world.hostFiles[build] = files
        await SessionSweeper(world: world, log: { _ in }).sweep(build)
        XCTAssertEqual(files.removed, [AGENT_TWO])
        XCTAssertEqual(world.forgotten, [])
    }

    func testPostponesAMachineWhoseHostFilesCannotBeReadLikeOneThatDoesNotAnswer() async {
        let world = SweepWorld()
        world.adapters[.local] = SweepMachine([])
        world.hostFilesFailure = "permission denied"
        let outcome = await SessionSweeper(world: world, log: { _ in }).sweep(.local)
        XCTAssertEqual(outcome, .postponed(reason: "permission denied"))
    }
}
