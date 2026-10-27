// Port of apps/desktop/src/shell/components/shell/wizardFlow.test.ts.
import XCTest
@testable import DevHubCore

/// A presenter that answers each question from a script, and records what it
/// was asked. `nil` in the script is the person pressing Escape.
@MainActor
final class ScriptedPresenter: WizardPresenter {
    typealias Drawing = String
    var script: [String?]
    var asked: [(title: String, failure: String?, step: Int)] = []
    var sheets: [WizardAsking] = []
    var sheetAnswer: Any?

    init(_ script: [String?]) { self.script = script }

    func prompt(_ prompt: PickerPrompt, asking: WizardAsking) async throws -> PickerChoice {
        asked.append((prompt.title, asking.failure, asking.step))
        guard !script.isEmpty else { throw InvariantViolation("the flow asked one too many") }
        guard let reply = script.removeFirst() else { throw WizardSignal.back }
        return PickerChoice(id: reply, query: reply)
    }

    func sheet<T>(_ draw: @escaping (WizardSheetControls<T>) -> String, asking: WizardAsking) async throws -> T {
        sheets.append(asking)
        var answered: T?
        _ = draw(WizardSheetControls(step: asking.step, failure: asking.failure, answer: { answered = $0 }, back: {}))
        guard let answered else { throw WizardSignal.back }
        return answered
    }

    func working<T: Sendable>(_ message: String, _ task: @escaping @Sendable () async throws -> T) async throws -> T {
        try await task()
    }
}

/// A call that fails the first time with words for the person.
final class FailsOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    let words: String
    init(_ words: String) { self.words = words }
    var count: Int { lock.withLock { calls } }
    func call() throws {
        let first = lock.withLock { calls += 1; return calls == 1 }
        if first { throw UserFacingFailure(words) }
    }
}

@MainActor
final class WizardTests: XCTestCase {
    typealias Step = WizardStep<ScriptedPresenter>

    func asking(_ title: String, then next: Step? = nil) -> Step {
        Step { input in
            _ = try await input.ask(PickerPrompt(title: title, question: ""))
            return next
        }
    }

    func testWalksTheChainEachAnswerNames() async throws {
        let presenter = ScriptedPresenter(["a", "b"])
        try await Wizard.run(asking("first", then: asking("second")), presenter: presenter)
        XCTAssertEqual(presenter.asked.map(\.title), ["first", "second"])
    }

    func testReAsksTheStepBeforeWhenThePersonEscapes() async throws {
        let presenter = ScriptedPresenter(["a", nil, "a2", "b"])
        try await Wizard.run(asking("first", then: asking("second")), presenter: presenter)
        XCTAssertEqual(presenter.asked.map(\.title), ["first", "second", "first", "second"])
    }

    func testEndsWhenThePersonEscapesOutOfTheFirstQuestion() async throws {
        let presenter = ScriptedPresenter([nil])
        try await Wizard.run(asking("first"), presenter: presenter)
        XCTAssertEqual(presenter.asked.count, 1)
    }

    func testReAsksTheFailingStepWithTheWordsTheFailureCameWith() async throws {
        let presenter = ScriptedPresenter(["bad", "good"])
        let clone = FailsOnce("Repository not found.")
        let first = Step { input in
            _ = try await input.ask(PickerPrompt(title: "url", question: ""))
            try await input.working("Cloning…") { try clone.call() }
            return nil
        }
        try await Wizard.run(first, presenter: presenter)
        XCTAssertEqual(presenter.asked.map(\.title), ["url", "url"])
        XCTAssertEqual(presenter.asked.map(\.failure), [nil, "Repository not found."])
        XCTAssertEqual(presenter.asked.map(\.step), [1, 1])
        XCTAssertEqual(clone.count, 2)
    }

    func testAsksAStepsOwnSheetAsAQuestionLikeAnyOther() async throws {
        let presenter = ScriptedPresenter(["url"])
        let launch = FailsOnce("The worktree is in the way.")
        let agent = Step { input in
            let chosen: String = try await input.sheet { controls in
                controls.answer("claude")
                return "agent sheet"
            }
            XCTAssertEqual(chosen, "claude")
            try await input.working("Starting…") { try launch.call() }
            return nil
        }
        let first = Step { input in
            _ = try await input.ask(PickerPrompt(title: "url", question: ""))
            return agent
        }
        try await Wizard.run(first, presenter: presenter)
        XCTAssertEqual(presenter.sheets, [
            WizardAsking(failure: nil, step: 2), WizardAsking(failure: "The worktree is in the way.", step: 2),
        ])
    }

    func testForgetsTheReasonOnceTheReAskedQuestionIsAnswered() async throws {
        let presenter = ScriptedPresenter(["bad", "good", "next"])
        let clone = FailsOnce("Repository not found.")
        let first = Step { input in
            _ = try await input.ask(PickerPrompt(title: "url", question: ""))
            try await input.working("Cloning…") { try clone.call() }
            return self.asking("branch")
        }
        try await Wizard.run(first, presenter: presenter)
        XCTAssertEqual(presenter.asked.last?.title, "branch")
        XCTAssertNil(presenter.asked.last?.failure)
        XCTAssertEqual(presenter.asked.last?.step, 2)
    }

    func testGoesBackPastAStepThatDecidedInsteadOfAsking() async throws {
        let presenter = ScriptedPresenter(["a", nil, "a", "b"])
        var decisions = 0
        let third = asking("worktree")
        let decided = Step { _ in
            decisions += 1
            return third
        }
        try await Wizard.run(asking("agent", then: decided), presenter: presenter)
        XCTAssertEqual(presenter.asked.map(\.title), ["agent", "worktree", "agent", "worktree"])
        XCTAssertEqual(decisions, 2)
    }

    func testLetsAFailureWithNoWordsForThePersonOutOfTheWizard() async {
        let presenter = ScriptedPresenter(["a"])
        let first = Step { input in
            _ = try await input.ask(PickerPrompt(title: "url", question: ""))
            throw InvariantViolation("cannot read properties of undefined")
        }
        do {
            try await Wizard.run(first, presenter: presenter)
            XCTFail("the failure stayed in the wizard")
        } catch {
            XCTAssertTrue(error is InvariantViolation)
        }
        XCTAssertEqual(presenter.asked.count, 1)
    }

    func testAnAbandonedWaitReturnsToTheQuestionThatWasAsked() async throws {
        let presenter = ScriptedPresenter(["a", "b"])
        var waits = 0
        let first = Step { input in
            _ = try await input.ask(PickerPrompt(title: "url", question: ""))
            waits += 1
            if waits == 1 { throw WizardSignal.abandoned }
            return nil
        }
        try await Wizard.run(first, presenter: presenter)
        XCTAssertEqual(presenter.asked.map(\.title), ["url", "url"])
    }
}
