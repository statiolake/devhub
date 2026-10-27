// Port of apps/desktop/src/main/shell/editorTerminalExits.test.ts

import XCTest

@testable import DevHubCore

private let WS = "11111111-1111-4111-8111-111111111111"
private let SCRATCH = "00000000-0000-4000-8000-00000000005c"

/// A close flow played by hand, with its timers run by the test.
@MainActor
private final class Harness {
    var standing: [String: WorkspaceCloseStanding] = [WS: .open, SCRATCH: .open]
    var asking = false
    var now: Double = 0
    var timers: [() async -> Void] = []
    var closed: [String] = []
    var restarted: [String] = []
    var onClose: (String) -> Void = { _ in }
    let alive: Bool
    let sessionFails: Bool
    lazy var exits: EditorTerminalExits = EditorTerminalExits(
        EditorTerminalExitsOptions(
            standing: { [unowned self] id in self.standing[id] ?? .gone },
            closable: { id in id != SCRATCH },
            asking: { [unowned self] in self.asking },
            sessionAlive: { [unowned self] _ in
                if self.sessionFails { throw TerminalFailure(.runtimeTimedOut) }
                return self.alive
            },
            close: { [unowned self] id in
                self.closed.append(id)
                self.onClose(id)
            },
            restart: { [unowned self] id in self.restarted.append(id) },
            log: nil,
            now: { [unowned self] in self.now },
            setTimer: { [unowned self] ms, work in
                XCTAssertEqual(ms, EditorTerminalExits.settlePollMs)
                self.timers.append(work)
                return { [unowned self] in self.timers.removeAll() }
            }))

    init(alive: Bool = false, sessionFails: Bool = false) {
        self.alive = alive
        self.sessionFails = sessionFails
    }

    /// Run the timers due now; how many ran.
    @discardableResult
    func tick() async -> Int {
        let due = timers
        timers = []
        for run in due { await run() }
        return due.count
    }
}

@MainActor
final class EditorTerminalExitsTests: XCTestCase {
    func testIsTheCloseButtonAWorkspaceWithNothingToAskAboutClosesAndNoTerminalIsStarted() async {
        let h = Harness()
        h.onClose = { h.standing[$0] = .closing }
        await h.exits.ended(WS)
        XCTAssertEqual(h.closed, [WS])
        await h.tick()
        h.standing[WS] = nil
        await h.tick()
        XCTAssertEqual(h.restarted, [])
        XCTAssertEqual(h.timers.count, 0)
    }

    func testStartsTheTerminalOverOnceTheClosesQuestionIsCancelled() async {
        let h = Harness()
        h.onClose = { _ in h.asking = true }
        await h.exits.ended(WS)
        await h.tick()
        await h.tick()
        XCTAssertEqual(h.restarted, [])
        // Cancelled: no question, nothing closing, the Workspace still there.
        h.asking = false
        await h.tick()
        XCTAssertEqual(h.restarted, [])
        await h.tick()
        XCTAssertEqual(h.restarted, [WS])
        let ran = await h.tick()
        XCTAssertEqual(ran, 0)
    }

    func testWaitsThroughAnAnswerThatStartsTheCloseAndStartsNothingForOneThatCloses() async {
        let h = Harness()
        h.onClose = { _ in h.asking = true }
        await h.exits.ended(WS)
        // Answered: the question goes, and the close it asked about runs.
        h.asking = false
        h.standing[WS] = .closing
        await h.tick()
        await h.tick()
        h.standing[WS] = nil
        await h.tick()
        XCTAssertEqual(h.restarted, [])
    }

    func testStartsTheTerminalOverWhenTheCloseLeavesTheWorkspaceOpen() async {
        let h = Harness()
        h.onClose = { h.standing[$0] = .closing }
        await h.exits.ended(WS)
        // The close failed part-way: the Workspace stays, with nothing running.
        h.standing[WS] = .open
        await h.tick()
        await h.tick()
        XCTAssertEqual(h.restarted, [WS])
    }

    func testNeverClosesScratchItsTerminalIsStartedOverAtOnce() async {
        let h = Harness()
        await h.exits.ended(SCRATCH)
        XCTAssertEqual(h.closed, [])
        XCTAssertEqual(h.restarted, [SCRATCH])
    }

    func testAttachesAgainWhenTheSessionIsStillThereThePersonDetachedNothingExited() async {
        let h = Harness(alive: true)
        await h.exits.ended(WS)
        XCTAssertEqual(h.closed, [])
        XCTAssertEqual(h.restarted, [WS])
    }

    func testDoesNotCloseOnAGuessWhenTheSessionCannotBeRead() async {
        let h = Harness(sessionFails: true)
        await h.exits.ended(WS)
        XCTAssertEqual(h.closed, [])
        XCTAssertEqual(h.restarted, [WS])
    }

    func testDoesNothingForAWorkspaceThatIsClosingOrGoneThatIsDevHubsOwnTeardown() async {
        let h = Harness()
        h.standing[WS] = .closing
        await h.exits.ended(WS)
        await h.exits.ended("22222222-2222-4222-8222-222222222222")
        XCTAssertEqual(h.closed, [])
        XCTAssertEqual(h.restarted, [])
    }

    func testDoesNothingOnceDevHubIsShuttingDown() async {
        let h = Harness()
        h.exits.dispose()
        await h.exits.ended(WS)
        await h.exits.ended(SCRATCH)
        XCTAssertEqual(h.closed, [])
        XCTAssertEqual(h.restarted, [])
        XCTAssertEqual(h.timers.count, 0)
    }

    func testAsksOnceWhileAnExitIsBeingDecided() async {
        let h = Harness()
        h.onClose = { _ in h.asking = true }
        await h.exits.ended(WS)
        await h.exits.ended(WS)
        XCTAssertEqual(h.closed, [WS])
    }

    func testStopsStartingOverATerminalThatKeepsEndingAtOnceRatherThanLoop() async {
        let h = Harness()
        for _ in 0..<(EditorTerminalExits.maxRestarts + 2) { await h.exits.ended(SCRATCH) }
        XCTAssertEqual(h.restarted.count, EditorTerminalExits.maxRestarts)
        h.now += EditorTerminalExits.restartWindowMs
        await h.exits.ended(SCRATCH)
        XCTAssertEqual(h.restarted.count, EditorTerminalExits.maxRestarts + 1)
    }
}
