// Port of apps/desktop/src/shell/components/shell/wizardFlow.ts (and the
// presenter half of Wizard.tsx).
//
// A question that takes more than one answer. Assigning an Issue asks four
// things — the URL, which clone, which branch, which agent — and each answer
// decides what the next question is. So a flow here is a chain of steps, each
// a function that asks something and answers with the step that comes next.
// The runner keeps the chain it has walked, and that stack — not any
// individual step — is what Escape unwinds: one step back, re-asked from the
// top of its own code.
//
// **A failure is answered where it happened.** A clone that git refused, a
// worktree whose directory is in the way — these arrive as words written for
// the person, and the runner re-asks the step that caused them with those
// words under the field. Anything that arrives *without* words is a broken
// assumption in DevHub rather than something to retype, and it is thrown clear
// of the wizard to the one place the shell shows failures it cannot explain.

import Foundation

/// How a person leaves a question other than by answering it.
public enum WizardSignal: Error, Equatable, Sendable {
    /// Escape: this step is done with, and the one before it is asked again.
    case back
    /// The flow is over and nothing is going to be asked.
    case cancelled
    /// Escape while something slow was running: stop waiting, ask this step again.
    case abandoned
}

/// A refusal worded for the person, raised by a step itself.
public struct UserFacingFailure: Error, Equatable, Sendable, CustomStringConvertible {
    public var summary: String
    public var detail: String?
    public var actions: [AppErrorAction]

    public init(_ summary: String, detail: String? = nil, actions: [AppErrorAction] = []) {
        self.summary = summary
        self.detail = detail
        self.actions = actions
    }

    public var description: String { detail.map { "\(summary) \($0)" } ?? summary }
}

/// `spokenFailure`: the words a failure came with, for the person; nil when it
/// has none (a broken assumption in DevHub, which is not theirs to retype).
public enum SpokenFailure {
    public static func of(_ error: Error) -> (summary: String, detail: String?)? {
        switch error {
        case let failure as UserFacingFailure: return (failure.summary, failure.detail)
        case let failure as NamedFailure: return (failure.summary, failure.detail)
        case let failure as ControlRefusal: return (failure.message, nil)
        case let failure as CodedFailure: return (failure.summary, failure.detail)
        case let failure as DevhubFailure: return (failure.message, nil)
        case let failure as ConversationError:
            let wire = errorWire(failure)
            return (wire.summary, wire.detail)
        case let failure as AgentActionEmpty:
            let wire = errorWire(failure)
            return (wire.summary, wire.detail)
        default: return nil
        }
    }

    /// `said`: the summary and its detail, as one sentence.
    public static func said(_ error: Error) -> String {
        if let spoken = of(error) { return spoken.detail.map { "\(spoken.summary) \($0)" } ?? spoken.summary }
        let wire = errorWire(error)
        return wire.detail.map { "\(wire.summary) \($0)" } ?? wire.summary
    }
}

/// Everything about a question that is the runner's to know, not the step's.
public struct WizardAsking: Equatable, Sendable {
    /// Why the last attempt at this step failed, if there was one.
    public var failure: String?
    /// Which question this is, counting from one (the depth of the stack).
    public var step: Int

    public init(failure: String?, step: Int) {
        self.failure = failure
        self.step = step
    }
}

/// What the runner hands a sheet a step draws itself.
@MainActor
public struct WizardSheetControls<T> {
    public let step: Int
    public let failure: String?
    public let answer: (T) -> Void
    /// Escape: the question before this one.
    public let back: () -> Void

    public init(step: Int, failure: String?, answer: @escaping (T) -> Void, back: @escaping () -> Void) {
        self.step = step
        self.failure = failure
        self.answer = answer
        self.back = back
    }
}

/// What the runner needs from whoever is drawing.
@MainActor
public protocol WizardPresenter: AnyObject {
    associatedtype Drawing
    func prompt(_ prompt: PickerPrompt, asking: WizardAsking) async throws -> PickerChoice
    func sheet<T>(_ draw: @escaping (WizardSheetControls<T>) -> Drawing, asking: WizardAsking) async throws -> T
    /// Something slow with the person watching. Throws `WizardSignal.abandoned`
    /// when they stop waiting (and the task is cancelled with it).
    func working<T: Sendable>(_ message: String, _ task: @escaping @Sendable () async throws -> T) async throws -> T
}

/// What a step may ask of the runner.
@MainActor
public final class WizardInput<Presenter: WizardPresenter> {
    public let presenter: Presenter
    fileprivate let question: @MainActor (_ present: @MainActor (WizardAsking) async throws -> Any) async throws -> Any

    fileprivate init(presenter: Presenter, question: @escaping @MainActor (@MainActor (WizardAsking) async throws -> Any) async throws -> Any) {
        self.presenter = presenter
        self.question = question
    }

    /// Ask, and answer with the row taken. Throws `WizardSignal.back` when the
    /// person escapes, which the runner reads and nothing else has to.
    public func ask(_ prompt: PickerPrompt) async throws -> PickerChoice {
        let presenter = self.presenter
        return try await question { asking in try await presenter.prompt(prompt, asking: asking) } as! PickerChoice
    }

    /// Ask with a sheet of the step's own; the same question to the runner as `ask`.
    public func sheet<T>(_ draw: @escaping (WizardSheetControls<T>) -> Presenter.Drawing) async throws -> T {
        let presenter = self.presenter
        return try await question { asking in try await presenter.sheet(draw, asking: asking) } as! T
    }

    /// Do something slow with the person watching.
    public func working<T: Sendable>(_ message: String, _ task: @escaping @Sendable () async throws -> T) async throws -> T {
        try await presenter.working(message, task)
    }
}

/// One question and what it leads to. Answering nil ends the flow.
@MainActor
public struct WizardStep<Presenter: WizardPresenter> {
    public let run: (WizardInput<Presenter>) async throws -> WizardStep<Presenter>?

    public init(_ run: @escaping (WizardInput<Presenter>) async throws -> WizardStep<Presenter>?) {
        self.run = run
    }
}

/// The chain walked, the reason the last attempt failed, and whether the step
/// running now has put a question on screen.
@MainActor
final class WizardWalk<Presenter: WizardPresenter> {
    var walked: [WizardStep<Presenter>] = []
    var failure: String?
    var asked = false
}

public enum Wizard {
    /// `runWizard`: walk the chain until it ends, the person escapes out of the
    /// first step, or something fails in a way this cannot put into words.
    @MainActor
    public static func run<Presenter: WizardPresenter>(_ start: WizardStep<Presenter>, presenter: Presenter) async throws {
        let walk = WizardWalk<Presenter>()
        var step: WizardStep<Presenter>? = start

        while let current = step {
            // Whether this step actually put a question on screen. A step that
            // decides for itself is not somewhere Escape can come back *to*.
            walk.asked = false
            let input = WizardInput(presenter: presenter) { present in
                walk.asked = true
                // The step is already on the stack, so its depth is the stack's.
                let answer = try await present(WizardAsking(failure: walk.failure, step: walk.walked.count))
                // The reason belongs to the attempt that failed.
                walk.failure = nil
                return answer
            }
            walk.walked.append(current)
            do {
                let next = try await current.run(input)
                if !walk.asked { walk.walked.removeLast() }
                step = next
            } catch let signal as WizardSignal {
                switch signal {
                case .cancelled:
                    return
                case .abandoned:
                    // Back to the last question that was really asked: a step that
                    // asked and then waited is re-run; one that began with the
                    // slow thing unwinds to the step before it.
                    walk.failure = nil
                    if !walk.asked { walk.walked.removeLast() }
                    step = walk.walked.popLast()
                case .back:
                    walk.failure = nil
                    walk.walked.removeLast()
                    step = walk.walked.popLast()
                }
            } catch {
                // No words means nothing to answer: it is not this person's mistake.
                guard let spoken = SpokenFailure.of(error) else { throw error }
                walk.failure = spoken.summary
                // A step that failed before asking anything has no question to
                // show the reason under; it goes under the question before it.
                if !walk.asked { walk.walked.removeLast() }
                step = walk.walked.popLast()
            }
        }
    }
}
