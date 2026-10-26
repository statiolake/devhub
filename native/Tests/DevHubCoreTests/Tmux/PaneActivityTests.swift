// Port of apps/desktop/src/main/terminal/paneActivity.test.ts.

import Foundation
import XCTest
@testable import DevHubCore

private let FS = "\u{1f}"
private let RS = "\u{1e}"
private let WS = "550e8400-e29b-41d4-a716-446655440000"
private let AGENT = "550e8400-e29b-41d4-a716-4466554400a0"
private let ROOT = "/Users/me/projects/widget"
private let MARKER = "marker\(FS)1"

/// One `list-panes` record, in `paneActivityFields` order.
private func paneRecord(
    session: String = "widget-0123456789ab", context: String = "workspace", workspaceId: String = WS,
    agentId: String = "none", window: String = "@1", pane: String = "%1", windowActive: String = "1",
    attached: String = "1", activity: String = "1700000000", dead: String = "0", screen: String = "10:0:5",
    command: String = "zsh", root: String = ROOT
) -> String {
    ["pane-activity", session, context, workspaceId, agentId, window, pane, windowActive, attached, activity, dead, screen, command, root]
        .joined(separator: FS)
}

private func output(_ records: String...) -> Data {
    Data(records.map { "\($0)\(RS)\n" }.joined().utf8)
}

/// The session name DevHub gives a root.
private func sessionFor(_ root: String) -> String { "ws-" + TmuxMarkers.workspaceDigest(root: root).prefix(20) }

final class PaneListingTests: XCTestCase {
    func testReadsEveryPaneOfAMarkedWorkspaceSessionWithItsSignals() throws {
        let reading = try TmuxMarkers.parsePaneActivity(
            output(
                MARKER,
                paneRecord(session: sessionFor(ROOT), pane: "%1", command: "-zsh"),
                paneRecord(session: sessionFor(ROOT), window: "@2", pane: "%2", windowActive: "0", screen: "200:3:40", command: "make")
            ),
            contextHome: "/Users/me"
        )
        XCTAssertEqual(reading.marker, .owned)
        XCTAssertEqual(reading.panes, [
            PaneSample(workspaceId: WS, pane: "%1", window: "@1", inView: true, command: "-zsh", dead: false, windowActivity: 1700000000, screen: "10:0:5"),
            PaneSample(workspaceId: WS, pane: "%2", window: "@2", inView: false, command: "make", dead: false, windowActivity: 1700000000, screen: "200:3:40"),
        ])
    }

    func testIsNotOnScreenWithoutAnAttachedClient() throws {
        let reading = try TmuxMarkers.parsePaneActivity(output(MARKER, paneRecord(session: sessionFor(ROOT), attached: "0")), contextHome: "/Users/me")
        XCTAssertEqual(reading.panes.first?.inView, false)
    }

    func testLeavesOutAgentsTheAnchorAndSessionsDevHubDidNotMark() throws {
        let reading = try TmuxMarkers.parsePaneActivity(
            output(
                MARKER,
                paneRecord(session: TmuxNames.agentSession(agentId: AGENT), context: "agent", agentId: AGENT),
                paneRecord(session: "scratch", context: "global", workspaceId: "global", root: "/Users/me"),
                paneRecord(session: "mine", context: "", workspaceId: "", root: "")
            ),
            contextHome: "/Users/me"
        )
        XCTAssertEqual(reading.panes, [])
    }

    func testReportsAServerDevHubDoesNotOwnAsWrongWithNoPanes() throws {
        XCTAssertEqual(
            try TmuxMarkers.parsePaneActivity(output("marker\(FS)", paneRecord()), contextHome: "/Users/me"),
            PaneActivityReading(marker: .wrong, panes: [], terminals: [])
        )
    }

    func testRefusesARecordOfTheWrongWidth() {
        XCTAssertThrowsError(try TmuxMarkers.parsePaneActivity(output(MARKER, "pane-activity\(FS)x"), contextHome: "/Users/me"))
    }
}

final class ShellCommandTests: XCTestCase {
    func testStripsALoginShellsDashAndAPath() {
        XCTAssertEqual(PaneActivity.commandName("-zsh"), "zsh")
        XCTAssertEqual(PaneActivity.commandName("/bin/bash"), "bash")
    }

    func testKnowsTheConfiguredShellTheCommonOnesAndNothingElse() {
        XCTAssertTrue(PaneActivity.isShellCommand("zsh", configuredShell: "zsh"))
        XCTAssertTrue(PaneActivity.isShellCommand("bash", configuredShell: "zsh"))
        XCTAssertTrue(PaneActivity.isShellCommand("myshell", configuredShell: "myshell"))
        XCTAssertTrue(PaneActivity.isShellCommand("", configuredShell: "zsh"))
        XCTAssertFalse(PaneActivity.isShellCommand("vim", configuredShell: "zsh"))
        XCTAssertFalse(PaneActivity.isShellCommand("claude", configuredShell: "zsh"))
    }
}

private func sample(
    pane: String = "%1", window: String = "@1", inView: Bool = false, command: String = "zsh",
    dead: Bool = false, windowActivity: Int? = 1_000, screen: String = "0:0:0"
) -> PaneSample {
    PaneSample(workspaceId: WS, pane: pane, window: window, inView: inView, command: command, dead: dead, windowActivity: windowActivity, screen: screen)
}

final class OutputClockTests: XCTestCase {
    let idle = 5.0
    func at(_ seconds: Double) -> Double { seconds * 1000 }

    func testIsWorkingWhileACommandPrintsQuietAfterNSecondsWorkingAgainOnOutput() {
        var tracker = PaneActivityTracker()
        XCTAssertEqual(tracker.observe([sample()], nowMs: at(1_000), idleSeconds: idle, configuredShell: "zsh").first?.running, false)
        // A command starts: the foreground process changed, which is output.
        func run(_ seconds: Double, _ screen: String, _ activity: Int? = nil) -> Bool? {
            tracker.observe(
                [sample(command: "make", windowActivity: activity ?? Int(seconds), screen: screen)],
                nowMs: at(seconds), idleSeconds: idle, configuredShell: "zsh"
            ).first?.running
        }
        XCTAssertEqual(run(1_001, "0:0:0"), true)
        XCTAssertEqual(run(1_002, "1:0:1"), true)
        // Nothing for four seconds: still working.
        XCTAssertEqual(run(1_006, "1:0:1", 1_002), true)
        // Five: quiet, which is finished.
        XCTAssertEqual(run(1_007, "1:0:1", 1_002), false)
        // It prints again.
        XCTAssertEqual(run(1_008, "2:0:1"), true)
        // It exits: the shell is back.
        XCTAssertEqual(tracker.observe([sample(screen: "3:0:2")], nowMs: at(1_009), idleSeconds: idle, configuredShell: "zsh").first?.running, false)
    }

    func testCountsARedrawThatLeavesTheCursorWhereItWasByTheWindowsActivity() {
        var tracker = PaneActivityTracker()
        func htop(_ seconds: Int) -> Bool? {
            tracker.observe([sample(command: "htop", windowActivity: seconds, screen: "0:0:0")], nowMs: at(Double(seconds)), idleSeconds: idle, configuredShell: "zsh").first?.running
        }
        _ = htop(1_000)
        for second in 1_001..<1_020 { XCTAssertEqual(htop(second), true) }
    }

    func testDatesAPaneItHasNeverSeenByItsWindowNotByNow() {
        // A `less` open since long before DevHub started is quiet at once.
        var tracker = PaneActivityTracker()
        XCTAssertEqual(tracker.observe([sample(command: "less", windowActivity: 100)], nowMs: at(1_000), idleSeconds: idle, configuredShell: "zsh").first?.running, false)
    }

    func testCreditsAWindowsOutputToThePaneWhoseScreenMoved() {
        var tracker = PaneActivityTracker()
        func round(_ seconds: Int, _ a: String, _ b: String) -> [PaneVerdict] {
            tracker.observe(
                [
                    sample(pane: "%1", command: "make", windowActivity: seconds, screen: a),
                    sample(pane: "%2", command: "tail", windowActivity: seconds, screen: b),
                ],
                nowMs: at(Double(seconds)), idleSeconds: idle, configuredShell: "zsh"
            )
        }
        _ = round(1_000, "a0", "b0")
        for second in 1_001...1_010 { _ = round(second, "a\(second)", "b0") }
        XCTAssertEqual(round(1_011, "a-last", "b0").map(\.running), [true, false])
    }

    func testNeverGoesQuietWithNZero() {
        var tracker = PaneActivityTracker()
        _ = tracker.observe([sample(command: "sleep")], nowMs: at(1_000), idleSeconds: 0, configuredShell: "zsh")
        XCTAssertEqual(tracker.observe([sample(command: "sleep")], nowMs: at(9_000), idleSeconds: 0, configuredShell: "zsh").first?.running, true)
    }

    func testIsNotWorkingInADeadPane() {
        var tracker = PaneActivityTracker()
        XCTAssertEqual(tracker.observe([sample(command: "make", dead: true, windowActivity: 1_000)], nowMs: at(1_000), idleSeconds: idle, configuredShell: "zsh").first?.running, false)
    }

    func testForgetsAPaneTheRoundItStopsBeingListed() {
        var tracker = PaneActivityTracker()
        _ = tracker.observe([sample(command: "make", windowActivity: 1_000)], nowMs: at(1_000), idleSeconds: idle, configuredShell: "zsh")
        _ = tracker.observe([], nowMs: at(1_001), idleSeconds: idle, configuredShell: "zsh")
        // Seen again, it is a pane seen for the first time: dated by its window.
        XCTAssertEqual(tracker.observe([sample(command: "make", windowActivity: 900)], nowMs: at(1_002), idleSeconds: idle, configuredShell: "zsh").first?.running, false)
    }
}

/// The main-process half of "from tmux to the row" (the roll-up into a row's
/// status and unread mark is `model/terminalActivity.ts`, WP2's).
final class TerminalObservationTests: XCTestCase {
    func testGoesRunningQuietOutputRunningRoundByRound() {
        var tracker = PaneActivityTracker()
        func round(_ seconds: Double, command: String = "zsh", screen: String = "0:0:0", activity: Int? = 1_000, inView: Bool = false) -> TerminalActivityLoop.Observation? {
            let verdicts = tracker.observe([sample(inView: inView, command: command, windowActivity: activity, screen: screen)], nowMs: seconds * 1000, idleSeconds: 5, configuredShell: "zsh")
            return TerminalActivityLoop.observations(verdicts, workspacesOnMachine: [WS]).first
        }
        _ = round(1_000)
        XCTAssertEqual(round(1_001, command: "npm", screen: "1", activity: 1_001)?.panes.first?.running, true)
        XCTAssertEqual(round(1_006, command: "npm", screen: "1", activity: 1_001)?.panes.first?.running, false)
        XCTAssertEqual(round(1_007, command: "npm", screen: "2", activity: 1_007)?.panes.first?.running, true)
        let viewed = round(1_012, command: "npm", screen: "2", activity: 1_007, inView: true)?.panes.first
        XCTAssertEqual(viewed?.running, false)
        XCTAssertEqual(viewed?.inView, true)
    }

    func testLeavesAnEmptyReadingForAWorkspaceWithNoSessionAndDropsStrangers() {
        XCTAssertEqual(
            TerminalActivityLoop.observations([PaneVerdict(workspaceId: "other", pane: "%9", running: true, inView: false)], workspacesOnMachine: [WS]),
            [TerminalActivityLoop.Observation(workspaceId: WS, panes: [])]
        )
    }
}

final class AgentTerminalPaneTests: XCTestCase {
    let terminal = "11111111-1111-4111-8111-111111111111"

    func testAreNamedByTheirOwnSessionInTheActivityReadingAndNotCountedAsTheWorkspaces() throws {
        let reading = try TmuxMarkers.parsePaneActivity(
            output(
                MARKER,
                paneRecord(session: sessionFor(ROOT), pane: "%1"),
                paneRecord(session: TmuxNames.terminalSession(terminalId: terminal), context: "terminal", pane: "%9", command: "make"),
                // Not DevHub's: a name that looks right with no marker.
                paneRecord(session: TmuxNames.terminalSession(terminalId: terminal).replacingOccurrences(of: "1111", with: "2222"), context: "")
            ),
            contextHome: "/Users/me"
        )
        XCTAssertEqual(reading.panes.map(\.pane), ["%1"])
        XCTAssertEqual(reading.terminals, [TerminalSessionSample(terminalId: terminal, workspaceId: WS)])
    }

    func testIsMarkedOnlyWithItsWholeTupleAndANameThatIsItsId() {
        let marking = SessionMarking(name: TmuxNames.terminalSession(terminalId: terminal), context: "terminal", workspaceId: WS, root: ROOT, agentId: "none")
        XCTAssertTrue(TmuxMarkers.isMarked(marking, expectedGlobalRoot: "/Users/me"))
        var other = marking
        other.name = "tm-nope"
        XCTAssertFalse(TmuxMarkers.isMarked(other, expectedGlobalRoot: "/Users/me"))
        other = marking
        other.agentId = AGENT
        XCTAssertFalse(TmuxMarkers.isMarked(other, expectedGlobalRoot: "/Users/me"))
        other = marking
        other.workspaceId = "w"
        XCTAssertFalse(TmuxMarkers.isMarked(other, expectedGlobalRoot: "/Users/me"))
    }

    func testReadsEachPanesHandleSocketWindowPaneCwdCommandAndWhereItIs() throws {
        let record = [
            "terminal-pane", TmuxNames.terminalSession(terminalId: terminal), "terminal", WS, "none",
            "@4", "0", "%9", "0", "1", "1", "npm", "host.local", "0", "/private/tmp/tmux-501/devhub",
            "/Users/me/projects/widget/api", "81", "25", "80", "24", "zsh", "4242", ROOT,
        ].joined(separator: FS)
        let parsed = try TmuxMarkers.parsePaneTerminals(output(MARKER, record), contextHome: "/Users/me")
        XCTAssertEqual(parsed.marker, .owned)
        XCTAssertEqual(parsed.panes, [PaneTerminalPane(pane: MarkedPane(
            workspaceId: WS, sessionName: TmuxNames.terminalSession(terminalId: terminal),
            windowId: "@4", windowIndex: 0, paneId: "%9", paneIndex: 0, active: true, windowActive: true,
            windowName: "zsh", command: "npm", title: "host.local", cwd: "/Users/me/projects/widget/api",
            dead: false, socketPath: "/private/tmp/tmux-501/devhub", left: 81, top: 25, width: 80, height: 24, pid: 4242
        ), terminalId: terminal)])
        // A server that is not DevHub's says nothing about anybody's panes.
        XCTAssertEqual(try TmuxMarkers.parsePaneTerminals(output("marker\(FS)", record), contextHome: "/Users/me").panes, [])
    }

    func testReadsAWorkspacesEditorTerminalPanesApartFromItsAgentsTerminals() throws {
        func record(_ session: String, _ context: String, _ pane: String) -> String {
            ["terminal-pane", session, context, WS, "none", "@1", "2", pane, "0", "1", "1", "ssh", "prod", "0",
             "/tmp/tmux-501/devhub", ROOT, "0", "0", "80", "24", "ssh", "77", ROOT].joined(separator: FS)
        }
        let ws = sessionFor(ROOT)
        let parsed = try TmuxMarkers.parseWorkspacePanes(
            output(MARKER, record(ws, "workspace", "%3"), record(TmuxNames.terminalSession(terminalId: terminal), "terminal", "%4")),
            contextHome: "/Users/me"
        )
        XCTAssertEqual(parsed.panes.map { [$0.sessionName, $0.paneId, String($0.pid)] }, [[ws, "%3", "77"]])
        XCTAssertEqual(try TmuxMarkers.parsePaneTerminals(output(MARKER, record(ws, "workspace", "%3")), contextHome: "/Users/me").panes, [])
    }
}
