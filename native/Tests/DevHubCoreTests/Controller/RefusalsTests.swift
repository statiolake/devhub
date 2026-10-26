// Ports of apps/desktop/src/main/shell/agentFailure.test.ts (the subject and
// wire halves; `portRefusal` itself is WP3's and tested there),
// completionRefusal.test.ts, cleanupDeadline.test.ts and
// machineConditions.test.ts.

import XCTest
@testable import DevHubCore

private let AGENT = AgentId(unchecked: "550e8400-e29b-41d4-a716-4466554400a0")

final class AgentFailureTests: XCTestCase {
    func testCallsEachPortFailureByWhatToDoNext() {
        let cases: [(PortErrorCode, AgentFailureCode)] = [
            (.unavailable, .agentRuntimeUnavailable), (.incompatible, .agentRuntimeUnavailable),
            (.failed, .tmuxCommandFailed), (.timedOut, .tmuxCommandTimedOut), (.conflict, .tmuxSessionConflict),
            (.rootMissing, .workspaceUnavailable), (.rootInaccessible, .workspaceUnavailable),
            (.socketPathTooLong, .agentRuntimeUnavailable), (.socketUnusable, .agentRuntimeUnavailable),
        ]
        for (kind, code) in cases {
            XCTAssertEqual(agentPortRefusal(PortFailure(kind)).code, code, kind.rawValue)
        }
    }

    func testCarriesTheSentenceThePortWasAllowedToCarry() {
        let refusal = agentPortRefusal(PortFailure(.unavailable, detail: "tmux was not found on the configured PATH."))
        XCTAssertEqual(refusal.code, .agentRuntimeUnavailable)
        XCTAssertEqual(refusal.detail, "tmux was not found on the configured PATH.")
        XCTAssertNil(agentPortRefusal(PortFailure(.failed)).detail)
    }

    func testTreatsAnythingThatIsNotAPortFailureAsARefusedCommand() {
        struct Boom: Error {}
        XCTAssertEqual(agentPortRefusal(Boom()).code, .tmuxCommandFailed)
        XCTAssertNil(agentPortRefusal(Boom()).detail)
    }

    func testIsTheAgentWhenTheRaisingSiteNamedOne() {
        XCTAssertEqual(
            RefusedOperation.agentSubject(AGENT, code: .tmuxSessionConflict, detail: nil),
            .agent(AGENT, code: .tmuxSessionConflict, detail: nil))
    }

    func testIsTheAppWhenTheFailureIsAboutEveryAgentThereIs() {
        XCTAssertEqual(
            RefusedOperation.agentSubject(nil, code: .tmuxCommandFailed, detail: nil),
            .app(code: .agentRuntimeUnavailable, detail: nil))
    }

    func testIsTheMachineWhenARoundNamedOne() {
        XCTAssertEqual(
            RefusedOperation.agentSubject(nil, code: .tmuxCommandTimedOut, detail: "x", machine: "ssh:box"),
            .machine("ssh:box", code: .tmuxCommandTimedOut, detail: "x"))
    }

    func testKeepsTheDetailWhicheverSurfaceItGoesTo() {
        XCTAssertEqual(
            RefusedOperation.agentSubject(AGENT, code: .agentRuntimeUnavailable, detail: "no socket"),
            .agent(AGENT, code: .agentRuntimeUnavailable, detail: "no socket"))
        XCTAssertEqual(
            RefusedOperation.agentSubject(nil, code: .agentRuntimeUnavailable, detail: "no socket"),
            .app(code: .agentRuntimeUnavailable, detail: "no socket"))
    }

    func testARefusedLaunchReachesTheWireWithTheCodeThePortChose() {
        let refusal = agentPortRefusal(PortFailure(.conflict))
        XCTAssertEqual(refusal.code, .tmuxSessionConflict)
        let wire = NamedFailure.agent(refusal.code, "the session DevHub needs is not the one that is there").wire
        XCTAssertEqual(wire.code, .tmuxSessionConflict)
        XCTAssertEqual(wire.detail, "the session DevHub needs is not the one that is there")
    }

    func testAnAppWideRefusalIsAnsweredInTheAppNoticesOwnWords() {
        let wire = RefusedOperation.app(
            code: .workspaceUnavailable, detail: "/src/api could not be opened as a workspace: not a directory").wire
        XCTAssertEqual(wire.code, .workspaceUnavailable)
        XCTAssertEqual(wire.summary, AppError.at(.workspaceUnavailable).summary)
        XCTAssertEqual(wire.detail, "/src/api could not be opened as a workspace: not a directory")
    }

    func testAnAgentOrMachineRefusalNamesTheAgentPortsRefusal() {
        for failure in [
            RefusedOperation.agent(AGENT, code: .tmuxCommandTimedOut, detail: "tmux did not answer."),
            .machine("ssh:build-box.example.com", code: .tmuxCommandTimedOut, detail: "tmux did not answer."),
        ] {
            XCTAssertEqual(failure.wire.code, .tmuxCommandTimedOut)
            XCTAssertEqual(failure.wire.detail, "tmux did not answer.")
        }
    }
}

final class CompletionRefusalTests: XCTestCase {
    private let token = OperationToken(operationId: OperationId(unchecked: "550e8400-e29b-41d4-a716-000000000001"), generation: 1)
    private let words = AppError.at(.workspaceUnavailable)
        .withDetail("/src/api could not be opened as a workspace: not a directory")

    private var failed: ProviderEvent { .operationFailed(token, words) }
    private var launched: ProviderEvent {
        .agentLaunchCompleted(
            token, WorkspaceId(unchecked: "550e8400-e29b-41d4-a716-000000000002"),
            AgentId(unchecked: "550e8400-e29b-41d4-a716-000000000003"), .failed(code: .tmuxCommandFailed, detail: "no tmux"))
    }

    private func rejection(_ refusal: CompletionRefusal) -> AppError? {
        guard case let .answer(_, rejection) = refusal else { return nil }
        return errorWire(rejection)
    }

    private func published(_ refusal: CompletionRefusal) -> AppError? {
        guard case let .answer(publish, _) = refusal else { return nil }
        return publish
    }

    func testIsNotDrawnAgainWhenFailOperationAlreadyDrewIt() {
        let refusal = Refusals.completionRefusal(failed, NamedFailure(words))
        XCTAssertNil(published(refusal))
        var reported = words
        reported.reported = true
        XCTAssertEqual(rejection(refusal), reported)
    }

    func testIsDrawnOnceWhenNothingHasDrawnItAndTheRequestIsToldSo() {
        let launchRefusal = NamedFailure.agent(.tmuxCommandFailed, "no tmux")
        let refusal = Refusals.completionRefusal(launched, launchRefusal)
        XCTAssertEqual(published(refusal), launchRefusal.wire)
        var reported = launchRefusal.wire
        reported.reported = true
        XCTAssertEqual(rejection(refusal), reported)
    }

    func testIsOnlyRefusedUndrawnWhenItAnswersAnOperationSomethingNewerSettled() {
        let stale = StaleCompletion(operationId: token.operationId)
        guard case let .answer(publish, rejection) = Refusals.completionRefusal(launched, stale) else { return XCTFail() }
        XCTAssertNil(publish)
        XCTAssertEqual(rejection as? StaleCompletion, stale)
    }

    func testStopsTheProcessWhenItAnswersAnOperationNeverStarted() {
        guard case .crash = Refusals.completionRefusal(failed, InvariantViolation("an operation never started was completed")) else {
            return XCTFail()
        }
    }
}

final class CleanupDeadlineTests: XCTestCase {
    func testPassesThroughTheAnswerItGot() async throws {
        let answer = try await CloseDeadline.run(.editor, timeoutMs: 50) { true }
        XCTAssertTrue(answer)
    }

    func testPassesThroughTheFailureItGot() async {
        struct NoTmux: Error, Equatable {}
        do {
            _ = try await CloseDeadline.run(.terminal, timeoutMs: 50) { () async throws -> Bool in throw NoTmux() }
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? NoTmux, NoTmux())
        }
    }

    func testEndsByItselfWhenNothingEverAnswers() async {
        do {
            _ = try await CloseDeadline.run(.agents, timeoutMs: 10) { () async throws -> Bool in
                try await Task.sleep(nanoseconds: 10_000_000_000)
                return true
            }
            XCTFail("expected a timeout")
        } catch {
            XCTAssertEqual((error as? CloseTimeout)?.diagnostic, .closeAgentsUnknown)
        }
    }

    /// The exact failure a packaged run measured: the host unreachable.
    private let unreachable = NamedFailure.at(.workspaceUnavailable, "DevHub cannot reach build-box.example.com.")

    func testNamesWhatIsStillRunningAndOnWhichMachine() {
        XCTAssertEqual(
            CloseDeadline.sessionsLeftRunning(.terminal, machine: "ssh:build-box.example.com", unreachable),
            "terminal sessions on ssh:build-box.example.com")
        XCTAssertEqual(
            CloseDeadline.sessionsLeftRunning(.agents, machine: "ssh:build-box.example.com", unreachable),
            "Agent sessions on ssh:build-box.example.com")
    }

    func testSaysItInOneSentenceHoweverManyStepsLeftSomething() {
        let said = CloseDeadline.sessionsLeftRunningDetail([
            "Agent sessions on ssh:build-box.example.com", "terminal sessions on ssh:build-box.example.com",
        ])
        XCTAssertTrue(said.contains("Agent sessions on ssh:build-box.example.com"))
        XCTAssertTrue(said.contains("terminal sessions on ssh:build-box.example.com"))
        XCTAssertTrue(said.contains("tmux"))
        XCTAssertTrue(said.contains("next time it can reach it"))
    }

    func testDoesNotContinuePastAMachineThatAnsweredAndRefused() {
        let refused = NamedFailure(AppError.at(.tmuxCommandFailed).withSummary("no such session"))
        XCTAssertNil(CloseDeadline.sessionsLeftRunning(.terminal, machine: "ssh:build-box.example.com", refused))
    }

    func testDoesNotContinuePastAStepThatRanOutOfTime() {
        XCTAssertNil(CloseDeadline.sessionsLeftRunning(
            .terminal, machine: "ssh:build-box.example.com", CloseTimeout(diagnostic: .closeTerminalUnknown)))
    }

    func testAppliesToNoOtherStep() {
        for step in [CloseStep.editor, .view, .worktree, .state] {
            XCTAssertNil(CloseDeadline.sessionsLeftRunning(step, machine: "ssh:build-box.example.com", unreachable))
        }
    }

    func testTheBudgetIsEveryStepsBound() {
        XCTAssertEqual(CloseDeadline.budgetMs, CloseStep.allCases.count * 20_000)
    }
}

final class MachineConditionsTests: XCTestCase {
    private let host = "ssh:example"

    private final class Said: @unchecked Sendable {
        var entries: [(source: String, summary: String?)] = []
        var clock: Double = 0
    }

    private func conditions(successesToRetract: Int = 2, minimumAgeMs: Double = 0) -> (MachineConditions, Said) {
        let said = Said()
        let subject = MachineConditions(
            publish: { source, summary, _ in said.entries.append((source, summary)) },
            successesToRetract: successesToRetract, minimumAgeMs: minimumAgeMs, now: { said.clock })
        return (subject, said)
    }

    func testIsSaidOnceHoweverManyRoundsFail() {
        let (subject, said) = conditions()
        for _ in 0..<10 { subject.failed(host, summary: "DevHub cannot reach this machine.") }
        XCTAssertEqual(said.entries.count, 1)
        XCTAssertEqual(said.entries[0].source, "machine:ssh:example")
        XCTAssertEqual(said.entries[0].summary, "DevHub cannot reach this machine.")
    }

    func testKeepsTheEpisodesFirstWords() {
        let (subject, said) = conditions()
        subject.failed(host, summary: "DevHub cannot reach this machine.")
        subject.failed(host, summary: "The tmux server did not answer in time.")
        XCTAssertEqual(said.entries.count, 1)
        XCTAssertEqual(said.entries[0].summary, "DevHub cannot reach this machine.")
    }

    func testDoesNotBlinkThroughAnAlternatingEpisode() {
        let (subject, said) = conditions(successesToRetract: 2)
        for _ in 0..<6 {
            subject.failed(host, summary: "DevHub cannot reach this machine.")
            subject.succeeded(host)
        }
        XCTAssertEqual(said.entries.count, 1)
        XCTAssertNotNil(said.entries[0].summary)
    }

    func testIsRetractedOnceTheMachineHasAnsweredEnoughRoundsInARow() {
        let (subject, said) = conditions(successesToRetract: 2)
        subject.failed(host, summary: "DevHub cannot reach this machine.")
        subject.succeeded(host)
        XCTAssertEqual(said.entries.count, 1)
        subject.succeeded(host)
        XCTAssertEqual(said.entries.count, 2)
        XCTAssertEqual(said.entries[1].source, "machine:ssh:example")
        XCTAssertNil(said.entries[1].summary)
        subject.failed(host, summary: "DevHub cannot reach this machine.")
        XCTAssertEqual(said.entries.count, 3)
    }

    func testStaysUpUntilItIsOldEnoughToHaveBeenRead() {
        let (subject, said) = conditions(successesToRetract: 1, minimumAgeMs: 5_000)
        subject.failed(host, summary: "DevHub cannot reach this machine.")
        subject.succeeded(host)
        XCTAssertEqual(said.entries.count, 1)
        said.clock += 5_000
        subject.succeeded(host)
        XCTAssertEqual(said.entries.count, 2)
        XCTAssertNil(said.entries[1].summary)
    }

    func testGoesWithAMachineDevHubHasLetGoOf() {
        let (subject, said) = conditions()
        subject.failed(host, summary: "DevHub cannot reach this machine.")
        subject.forget(host)
        XCTAssertNil(said.entries[1].summary)
        subject.forget(host)
        XCTAssertEqual(said.entries.count, 2)
    }

    func testSaysNothingAboutAMachineThatNeverFailed() {
        let (subject, said) = conditions()
        subject.succeeded(host)
        subject.forget(host)
        XCTAssertTrue(said.entries.isEmpty)
    }
}
