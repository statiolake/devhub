// Port of apps/desktop/src/main/agent/detect/{rules,claudeScreens,codexScreens,
// cursorScreens}.test.ts. The screens are the TS fixtures
// (`*Screens.fixture.ts`), dumped once to `Fixtures/detect/*-screens.json`
// byte for byte — including the no-break spaces the CLIs actually drew.

import Foundation
import XCTest
@testable import DevHubCore

enum DetectFixture {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures")
        .appendingPathComponent("detect")

    static func screens(_ kind: String) -> [String: DetectionScreen] {
        let data = try! Data(contentsOf: root.appendingPathComponent("\(kind)-screens.json"))
        let object = try! JSONSerialization.jsonObject(with: data) as! [String: [String: String]]
        return object.mapValues { DetectionScreen(screen: $0["screen"] ?? "", oscTitle: $0["oscTitle"] ?? "", oscProgress: "") }
    }

    static let claude = screens("claude")
    static let codex = screens("codex")
    static let cursor = screens("cursor")
}

private func input(_ screen: String, _ oscTitle: String = "", _ oscProgress: String = "") -> DetectionScreen {
    DetectionScreen(screen: screen, oscTitle: oscTitle, oscProgress: oscProgress)
}

private let RULE = String(repeating: "─", count: 40)

final class ScreenRegionTests: XCTestCase {
    func testTakesThePromptBoxAsTheTextBetweenTheLastTwoRules() {
        let screen = ["some output", RULE, "  ❯ ", RULE, "  ? for shortcuts"].joined(separator: "\n")
        XCTAssertEqual(DetectRules.region(input(screen), .promptBoxBody), "  ❯ ")
        XCTAssertEqual(DetectRules.region(input(screen), .afterLastHorizontalRule), "  ? for shortcuts")
    }

    func testCountsNonEmptyLinesFromTheBottomKeepingTheBlanksBetween() {
        let screen = ["a", "", "b", "", "", "c"].joined(separator: "\n")
        XCTAssertEqual(DetectRules.region(input(screen), .bottomNonEmptyLines(2)), ["b", "", "", "c"].joined(separator: "\n"))
        XCTAssertEqual(DetectRules.region(input(screen), .topNonEmptyLines(2)), ["a", "", "b"].joined(separator: "\n"))
    }

    func testReadsTheTitleFromTheTitleNeverFromTheScreen() {
        let reading = DetectRules.read(DetectManifests.claude, input("⠋ thinking", ""))
        XCTAssertNotEqual(reading.state, .working)
    }

    func testTakesCodexsPromptLineAndWhatFollowsIt() {
        let screen = ["old", "› first", "between", "› run the tests", "Allow command?"].joined(separator: "\n")
        XCTAssertEqual(DetectRules.region(input(screen), .afterLastPromptMarker), "Allow command?")
        XCTAssertEqual(DetectRules.region(input("no marker"), .afterLastPromptMarker), "no marker")
    }

    func testCompilesEveryManifestPattern() {
        for manifest in [DetectManifests.claude, DetectManifests.codex, DetectManifests.cursor] {
            for rule in manifest.rules { _ = DetectRules.read(Manifest(id: manifest.id, version: manifest.version, rules: [rule]), input("")) }
        }
    }
}

final class ClaudeManifestRuleTests: XCTestCase {
    func testReadsTheTitleSpinnerAsWorking() {
        let reading = DetectRules.read(DetectManifests.claude, input("", "⠋ Doing the thing"))
        XCTAssertEqual(reading.matchedRuleId, "osc_title_working")
        XCTAssertEqual(reading.state, .working)
        XCTAssertTrue(reading.visibleWorking)
    }

    func testReadsTheLivePromptBoxAsIdle() {
        let screen = ["done.", RULE, " ❯ ", RULE, " ? for shortcuts"].joined(separator: "\n")
        let reading = DetectRules.read(DetectManifests.claude, input(screen, "✳ DevHub"))
        XCTAssertEqual(reading.state, .idle)
        XCTAssertTrue(reading.visibleIdle)
    }

    func testReadsAPermissionQuestionAsBlockedOverTheIdlePrompt() {
        let screen = ["Bash command", "  npm test", RULE, "Do you want to proceed?", " ❯ 1. Yes", "   2. No, and tell Claude what to do differently (esc to cancel)"].joined(separator: "\n")
        let reading = DetectRules.read(DetectManifests.claude, input(screen, "✳ DevHub"))
        XCTAssertEqual(reading.state, .blocked)
        XCTAssertTrue(reading.visibleBlocker)
    }

    func testTreatsTheTranscriptViewerAsNoReadingAtAll() {
        let reading = DetectRules.read(DetectManifests.claude, input(["Showing detailed transcript", "ctrl+o to toggle"].joined(separator: "\n")))
        XCTAssertTrue(reading.skipStateUpdate)
    }
}

final class CodexManifestRuleTests: XCTestCase {
    func testReadsItsTitleSpinnerAndItsActionRequired() {
        XCTAssertEqual(DetectRules.read(DetectManifests.codex, input("", "⠹ codex")).state, .working)
        let blocked = DetectRules.read(DetectManifests.codex, input("", "Action Required — codex"))
        XCTAssertEqual(blocked.state, .blocked)
        XCTAssertTrue(blocked.visibleBlocker)
    }

    func testReadsTheWorkingFooterWhenThereIsNoTitleToRead() {
        XCTAssertEqual(DetectRules.read(DetectManifests.codex, input("• Working (12s · esc to interrupt)")).state, .working)
    }

    func testReadsALiveBlockerAfterThePromptMarker() {
        let reading = DetectRules.read(DetectManifests.codex, input(["› run the tests", "Allow command?"].joined(separator: "\n")))
        XCTAssertEqual(reading.state, .blocked)
        XCTAssertTrue(reading.visibleBlocker)
    }

    func testDoesNotReadATitleAloneAsIdle() {
        XCTAssertEqual(DetectRules.read(DetectManifests.codex, input("", "codex — a-project")).state, .unknown)
    }
}

final class ManifestKindTests: XCTestCase {
    func testAKindWithNoManifestHasNonePermanently() {
        XCTAssertNil(DetectManifests.manifest(for: "custom"))
        XCTAssertNil(DetectManifests.manifest(for: "nothing-like-this"))
    }

    func testHandsEachKindItsOwn() {
        XCTAssertEqual(DetectManifests.manifest(for: "claude")?.id, "claude")
        XCTAssertEqual(DetectManifests.manifest(for: "codex")?.id, "codex")
        XCTAssertEqual(DetectManifests.manifest(for: "cursor")?.id, "cursor")
    }

    func testLetsOnlyTheVerifiedManifestsClaimAFreePrompt() {
        func claimsIdle(_ manifest: Manifest) -> Bool { manifest.rules.contains { $0.state == .idle } }
        XCTAssertTrue(claimsIdle(DetectManifests.claude))
        XCTAssertTrue(claimsIdle(DetectManifests.codex))
        XCTAssertFalse(claimsIdle(DetectManifests.cursor))
    }

    func testCarriesHerdrsVersions() {
        XCTAssertEqual(DetectManifests.claude.version, "2026.08.13.1")
        XCTAssertEqual(DetectManifests.codex.version, "2026.08.09.1")
        XCTAssertEqual(DetectManifests.cursor.version, "2026.08.03.1")
    }
}

final class DebounceTests: XCTestCase {
    let agent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    func screen(_ text: String, _ title: String = "") -> AgentScreen { AgentScreen(agentId: agent, screen: text, oscTitle: title) }
    let idle = ["x", RULE, " ❯ ", RULE, ""].joined(separator: "\n")

    func testMakesANewStateProveItselfForTwoRounds() {
        let detector = AgentStatusDetector()
        XCTAssertEqual(detector.status(kind: "claude", screen: screen("", "⠋ working")), .unknown)
        XCTAssertEqual(detector.status(kind: "claude", screen: screen("", "⠋ working")), .working)
        // One stray frame does not move the row.
        XCTAssertEqual(detector.status(kind: "claude", screen: screen(idle)), .working)
        XCTAssertEqual(detector.status(kind: "claude", screen: screen(idle)), .idle)
    }

    func testLetsAVisibleBlockerThroughAtOnce() {
        let detector = AgentStatusDetector()
        _ = detector.status(kind: "claude", screen: screen("", "⠋ working"))
        _ = detector.status(kind: "claude", screen: screen("", "⠋ working"))
        let blocked = ["Bash command", RULE, "Do you want to proceed?", " ❯ 1. Yes", "   2. No (esc to cancel)"].joined(separator: "\n")
        XCTAssertEqual(detector.status(kind: "claude", screen: screen(blocked)), .waiting)
    }

    func testNeverReadsAScreenForAKindItHasNoManifestFor() {
        let detector = AgentStatusDetector()
        XCTAssertEqual(detector.status(kind: "custom", screen: screen("", "⠋ working")), .unknown)
        XCTAssertEqual(detector.status(kind: "custom", screen: screen("", "⠋ working")), .unknown)
    }

    func testSettlesOnWhatItReadOnceTheScreenStopsChanging() {
        let detector = AgentStatusDetector()
        XCTAssertEqual(detector.status(kind: "claude", screen: screen(idle)), .unknown)
        XCTAssertEqual(detector.unchanged(agent), .idle)
    }

    func testHasNothingToSettleForAnAgentItNeverManagedToRead() {
        XCTAssertEqual(AgentStatusDetector().unchanged(agent), .unknown)
    }

    func testHoldsStillOnceAQuietScreenHasBeenAgreedOn() {
        let detector = AgentStatusDetector()
        _ = detector.status(kind: "claude", screen: screen(idle))
        XCTAssertEqual(detector.unchanged(agent), .idle)
        XCTAssertEqual(detector.unchanged(agent), .idle)
    }

    func testReadsARealClaudeCodePromptAsIdleWithoutASecondCapture() {
        let detector = AgentStatusDetector()
        let real = DetectFixture.claude["CLAUDE_IDLE"]!
        _ = detector.status(kind: "claude", screen: AgentScreen(agentId: agent, screen: real.screen, oscTitle: real.oscTitle))
        XCTAssertEqual(detector.unchanged(agent), .idle)
        XCTAssertTrue(detector.unchanged(agent).isIdle)
    }

    func testReadsARealCodexComposerAsIdleWithoutASecondCapture() {
        let detector = AgentStatusDetector()
        let real = DetectFixture.codex["CODEX_IDLE"]!
        _ = detector.status(kind: "codex", screen: AgentScreen(agentId: agent, screen: real.screen, oscTitle: real.oscTitle))
        XCTAssertEqual(detector.unchanged(agent), .idle)
        XCTAssertTrue(detector.unchanged(agent).isIdle)
    }

    func testSettlesAWorkingScreenAsWorkingNotAsSomethingElse() {
        let detector = AgentStatusDetector()
        _ = detector.status(kind: "claude", screen: screen("", "⠋ working"))
        XCTAssertEqual(detector.unchanged(agent), .working)
    }

    func testKeepsTheRowsStatusWhileTheAgentsOwnViewerIsUp() {
        let detector = AgentStatusDetector()
        _ = detector.status(kind: "claude", screen: screen(idle))
        _ = detector.status(kind: "claude", screen: screen(idle))
        XCTAssertEqual(detector.status(kind: "claude", screen: screen(idle)), .idle)
        XCTAssertEqual(detector.status(kind: "claude", screen: screen("Showing detailed transcript\nctrl+o to toggle")), .idle)
    }

    func testForgetsAnAgentThatEnded() {
        let detector = AgentStatusDetector()
        _ = detector.status(kind: "claude", screen: screen(idle))
        _ = detector.status(kind: "claude", screen: screen(idle))
        detector.forget(agent)
        XCTAssertEqual(detector.showing(agent), .unknown)
        XCTAssertEqual(detector.unchanged(agent), .unknown)
    }
}

/// The Claude Code manifest, against screens a real Claude Code drew.
final class ClaudeScreensTests: XCTestCase {
    func reading(_ name: String) -> Reading { DetectRules.read(DetectManifests.claude, DetectFixture.claude[name]!) }

    func testSaysWorkingWhileItIsWorking() {
        XCTAssertEqual(reading("CLAUDE_WORKING").state, .working)
        XCTAssertTrue(reading("CLAUDE_WORKING").visibleWorking)
    }

    func testSaysWorkingWithABackgroundAgentListUnderTheFooter() {
        XCTAssertEqual(reading("CLAUDE_WORKING_WITH_AGENTS").state, .working)
        XCTAssertTrue(reading("CLAUDE_WORKING_WITH_AGENTS").visibleWorking)
    }

    func testSaysIdleWhenItIsWaitingForAPersonToType() {
        XCTAssertEqual(reading("CLAUDE_IDLE").state, .idle)
    }

    func testSaysBlockedWhenItHasStoppedToAskAQuestion() {
        XCTAssertEqual(reading("CLAUDE_WAITING").state, .blocked)
        XCTAssertTrue(reading("CLAUDE_WAITING").visibleBlocker)
    }

    func testDecidesEachStateFromLiveChromeAndSaysSo() {
        XCTAssertEqual(reading("CLAUDE_WORKING").matchedRuleId, "screen_working_footer")
        XCTAssertEqual(reading("CLAUDE_IDLE").matchedRuleId, "live_prompt_box")
        XCTAssertEqual(reading("CLAUDE_WAITING").matchedRuleId, "numbered_permission_prompt")
    }

    func testSaysItCannotTellRatherThanGuessingIdleOnAScreenItDoesNotKnow() {
        let result = DetectRules.read(DetectManifests.claude, input("a screen no rule here describes", DetectFixture.claude["CLAUDE_WORKING"]!.oscTitle))
        XCTAssertEqual(result.state, .unknown)
    }

    func testCannotTellTheThreeStatesApartByTheTitleAlone() {
        XCTAssertEqual(DetectFixture.claude["CLAUDE_WORKING"]!.oscTitle, DetectFixture.claude["CLAUDE_IDLE"]!.oscTitle)
        XCTAssertEqual(DetectFixture.claude["CLAUDE_IDLE"]!.oscTitle, DetectFixture.claude["CLAUDE_WAITING"]!.oscTitle)
    }
}

final class CodexScreensTests: XCTestCase {
    func reading(_ name: String) -> Reading { DetectRules.read(DetectManifests.codex, DetectFixture.codex[name]!) }

    func testSaysWorkingWhileATurnIsRunning() {
        XCTAssertEqual(reading("CODEX_WORKING").state, .working)
        XCTAssertTrue(reading("CODEX_WORKING").visibleWorking)
    }

    func testSaysIdleOnlyOnceCodexIsActuallyReady() {
        XCTAssertEqual(reading("CODEX_IDLE").state, .idle)
    }

    func testDoesNotCallAHalfStartedCodexIdle() {
        XCTAssertNotEqual(reading("CODEX_STARTUP").state, .idle)
    }

    func testNeverCallsANumberedMenuIdleAndKnowsAPersonIsNeeded() {
        XCTAssertEqual(reading("CODEX_UPDATE_PROMPT").state, .blocked)
        XCTAssertTrue(reading("CODEX_UPDATE_PROMPT").visibleBlocker)
    }

    func testKnowsTheTrustQuestionIsWaitingOnAPerson() {
        XCTAssertEqual(reading("CODEX_TRUST_PROMPT").state, .blocked)
        XCTAssertTrue(reading("CODEX_TRUST_PROMPT").visibleBlocker)
    }

    func testCannotTellAQuestionFromAFreePromptByTheTitle() {
        let codex = DetectFixture.codex
        XCTAssertEqual(codex["CODEX_STARTUP"]!.oscTitle, codex["CODEX_UPDATE_PROMPT"]!.oscTitle)
        XCTAssertEqual(codex["CODEX_UPDATE_PROMPT"]!.oscTitle, codex["CODEX_TRUST_PROMPT"]!.oscTitle)
        XCTAssertFalse(codex["CODEX_TRUST_PROMPT"]!.oscTitle.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    func testSaysItCannotTellRatherThanGuessingIdle() {
        let result = DetectRules.read(DetectManifests.codex, input("a screen no rule here describes", DetectFixture.codex["CODEX_IDLE"]!.oscTitle))
        XCTAssertEqual(result.state, .unknown)
    }
}

final class CursorScreensTests: XCTestCase {
    func reading(_ screen: DetectionScreen) -> Reading { DetectRules.read(DetectManifests.cursor, screen) }
    func named(_ name: String) -> DetectionScreen { DetectFixture.cursor[name]! }

    func testKnowsACommandWaitingForApprovalIsWaitingOnAPerson() {
        XCTAssertEqual(reading(named("CURSOR_COMMAND_APPROVAL")).state, .blocked)
        XCTAssertTrue(reading(named("CURSOR_COMMAND_APPROVAL")).visibleBlocker)
    }

    func testKnowsAFileWriteWaitingForApprovalIsWaitingOnAPerson() {
        XCTAssertEqual(reading(named("CURSOR_WRITE_APPROVAL")).state, .blocked)
        XCTAssertTrue(reading(named("CURSOR_WRITE_APPROVAL")).visibleBlocker)
    }

    func testSaysWorkingFromASpinnerAnInterruptHintAndABackgroundTaskCount() {
        for name in ["CURSOR_WORKING_SPINNER", "CURSOR_WORKING_STOP_HINT", "CURSOR_WORKING_BACKGROUND"] {
            XCTAssertEqual(reading(named(name)).state, .working, name)
            XCTAssertTrue(reading(named(name)).visibleWorking, name)
        }
    }

    func testPutsAQuestionAboveARunningTurnWhenBothAreOnScreen() {
        let both = input("\(named("CURSOR_WORKING_SPINNER").screen)\n\(named("CURSOR_COMMAND_APPROVAL").screen)", "example-host")
        XCTAssertEqual(reading(both).state, .blocked)
    }

    func testHasNoIdleRuleAtAll() {
        XCTAssertTrue(DetectManifests.cursor.rules.filter { $0.state == .idle }.isEmpty)
        XCTAssertFalse(DetectManifests.cursor.rules.contains { $0.visibleIdle })
    }

    func testReadsAFreeLookingPromptAsUnknownRatherThanIdle() {
        let result = reading(named("CURSOR_LOOKS_FREE"))
        XCTAssertEqual(result.state, .unknown)
        XCTAssertNil(result.matchedRuleId)
    }

    func testDoesNotCallAHalfStartedCursorIdle() {
        XCTAssertEqual(reading(named("CURSOR_LOGIN_SPLASH")).state, .unknown)
    }

    func testKeysNothingOnATitleTheShellHappenedToSet() {
        XCTAssertEqual(named("CURSOR_LOGIN_SPLASH").oscTitle, "example-host")
        XCTAssertEqual(reading(input("", "example-host")).state, .unknown)
    }

    func testSaysItCannotTellRatherThanGuessing() {
        XCTAssertEqual(reading(input("a screen no rule here describes", "example-host")).state, .unknown)
    }
}
