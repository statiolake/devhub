// Port of the flow cases of apps/desktop/src/shell/picker/issueAssignment.test.tsx:
// the four questions, walked with a scripted person and fake services.
import XCTest
@testable import DevHubCore

/// What the flow asked DevHub for, and what DevHub answers.
final class FakeSheetServices: SheetServices, @unchecked Sendable {
    let lock = NSLock()
    var repositories: [RepositoryCandidate] = [
        RepositoryCandidate(place: .local(path: "/projects/widget"), worktrees: [
            WorktreeCandidate(place: .local(path: "/projects/widget"), branch: "main", isMainWorktree: true),
        ]),
    ]
    var findFailure: Error?
    var branch = AssignmentBranch(reachable: false)
    var prepareFailures: [Error] = []
    var actions: [ConfiguredAgentAction] = []
    var calls: [String] = []
    var prepared: [IssueFolderRequest] = []
    var assigned: [SheetIssueAssignment] = []
    var cloned: [(String, String)] = []

    func record(_ call: String) { lock.withLock { calls.append(call) } }

    func profiles() async -> SheetProfiles { SheetProfiles.of(Config.defaults) }
    func config() async -> Config? { Config.defaults }
    func snapshot() async -> AppSnapshotWire? { nil }
    func searchWorkspaces(_ query: String, emit: @escaping @Sendable (WorkspacePickerEvent) -> Void) async {}
    func openPicked(_ path: String, create: Bool, withAgent: AgentLaunch?) async throws { record("open \(path)") }
    func createProject(_ path: String, withAgent: AgentLaunch?) async throws { record("create \(path)") }
    func cloneProject(url: String, parentDirectory: String, withAgent: AgentLaunch?) async throws { record("cloneProject") }
    func projectDefaultDirectory() async -> String { "/projects" }
    func cloneParentDirectories() async throws -> [String] { ["/projects", "/work"] }
    func githubLogin() async -> GitHubLogin { .known("me") }

    func findIssueRepositories(_ url: String) async throws -> [RepositoryCandidate] {
        record("find \(url)")
        if let failure = lock.withLock({ () -> Error? in defer { findFailure = nil }; return findFailure }) { throw failure }
        return repositories
    }

    func cloneRepository(url: String, parentDirectory: String) async throws -> String {
        lock.withLock { cloned.append((url, parentDirectory)) }
        return "\(parentDirectory)/widget"
    }

    func assignmentBranch(url: String, place: WorkspacePlace) async throws -> AssignmentBranch {
        record("branch \(place.path)")
        return branch
    }

    func prepareIssueFolder(_ request: IssueFolderRequest) async throws -> WorkspacePlace {
        let failure = lock.withLock { () -> Error? in
            prepared.append(request)
            return prepareFailures.isEmpty ? nil : prepareFailures.removeFirst()
        }
        if let failure { throw failure }
        guard let branch = request.branch, !request.inRoot else { return request.place }
        return .local(path: "/projects/widget_\(branch.contains("128") ? "128" : "x")")
    }

    func assignIssue(_ request: SheetIssueAssignment) async throws { lock.withLock { assigned.append(request) } }
    func listAgentSessions(place: WorkspacePlace, profileId: String) async throws -> [PastSession] { [] }
    func previewAgentSession(place: WorkspacePlace, profileId: String, session: String, cwd: String) async throws -> [PreviewLine] { [] }
    func createAgent(workspaceId: String, profileId: String, split: Bool, presentation: AgentPresentation?, resume: String?) async {}
    func agentActions() async -> [ConfiguredAgentAction] { actions }
    func runAgentAction(agentId: String, actionId: String) async throws {}
    func confirmInjection(agentId: String, injectionId: String, text: String) async throws {}
    func cancelInjection(agentId: String, injectionId: String) async {}
    func dispatch(_ intent: AppIntentWire) async -> Bool { true }
}

/// A person who answers the flow's questions from a script, by row label (or
/// `typed:<text>` for a row that means the field), and its agent question
/// with `agent`.
@MainActor
final class IssuePerson: IssueFlowPresenter {
    typealias Drawing = String
    var script: [String]
    var agent: FolderAgentAnswer? = .agent(AgentChoice(profileId: "claude", split: false, presentation: .tui))
    var asked: [PickerPrompt] = []
    var agentSheets: [(title: String, place: WorkspacePlace, failure: String?)] = []

    init(_ script: [String]) { self.script = script }

    func prompt(_ prompt: PickerPrompt, asking: WizardAsking) async throws -> PickerChoice {
        asked.append(prompt.failing(asking.failure))
        guard !script.isEmpty else { throw WizardSignal.cancelled }
        let reply = script.removeFirst()
        if reply == "escape" { throw WizardSignal.back }
        var state = PickerState(prompt)
        if reply.hasPrefix("typed:") {
            state.setQuery(String(reply.dropFirst("typed:".count)))
            guard case let .choose(choice)? = state.chooseActive() else { throw WizardSignal.back }
            return choice
        }
        guard let row = state.rows.first(where: { $0.label == reply }), case let .choose(choice)? = state.choose(row.id) else {
            XCTFail("no row \(reply) in \(state.rows.map(\.label))")
            throw WizardSignal.cancelled
        }
        return choice
    }

    func sheet<T>(_ draw: @escaping (WizardSheetControls<T>) -> String, asking: WizardAsking) async throws -> T {
        var answered: T?
        var back = false
        _ = draw(WizardSheetControls(step: asking.step, failure: asking.failure, answer: { answered = $0 }, back: { back = true }))
        if back { throw WizardSignal.back }
        guard let answered else { throw WizardSignal.cancelled }
        return answered
    }

    func working<T: Sendable>(_ message: String, _ task: @escaping @Sendable () async throws -> T) async throws -> T {
        try await task()
    }

    func folderAgentSheet(title: String, place: WorkspacePlace, controls: WizardSheetControls<FolderAgentAnswer>) -> String {
        agentSheets.append((title, place, controls.failure))
        if let agent { controls.answer(agent) } else { controls.back() }
        return title
    }
}

@MainActor
final class IssueFlowTests: XCTestCase {
    let issue = "https://github.com/example/widget/issues/128"

    func walk(_ person: IssuePerson, _ services: FakeSheetServices) async throws {
        try await Wizard.run(IssueFlow.start(services) as WizardStep<IssuePerson>, presenter: person)
    }

    func testMakesTheFolderAsksWhichAgentThenOpensItWithTheAgentAndTheIssue() async throws {
        let services = FakeSheetServices()
        services.actions = [ConfiguredAgentAction(
            trigger: .issue, id: "issue_assignment", displayName: "Work on the Issue", template: "x", confirmBeforeSend: true,
            button: false, enabled: true, order: 0)]
        let person = IssuePerson(["typed:\(issue)", "Create feature/128-wip in a new worktree"])
        try await walk(person, services)
        XCTAssertEqual(person.asked.map(\.title), ["Assign Issue", "Where to work on example/widget#128"])
        XCTAssertEqual(services.prepared, [IssueFolderRequest(
            issueUrl: issue, place: .local(path: "/projects/widget"), branch: "feature/128-wip")])
        XCTAssertEqual(person.agentSheets.map(\.title), ["Agent for example/widget#128"])
        XCTAssertEqual(person.agentSheets.first?.place, .local(path: "/projects/widget_128"))
        XCTAssertEqual(services.assigned, [SheetIssueAssignment(
            issueUrl: issue, place: .local(path: "/projects/widget_128"), profileId: "claude", actionId: "issue_assignment",
            presentation: .tui)])
    }

    func testJustOpeningTheEditorStartsNoAgent() async throws {
        let services = FakeSheetServices()
        let person = IssuePerson(["typed:\(issue)", "Open the root checkout as it is"])
        person.agent = .editorOnly
        try await walk(person, services)
        XCTAssertEqual(services.assigned, [SheetIssueAssignment(issueUrl: issue, place: .local(path: "/projects/widget"), editorOnly: true)])
        // No actions configured: the only row means the URL as typed.
        XCTAssertEqual(person.asked.first?.pinned.map(\.label), ["Use this URL"])
    }

    func testAsksAgainKeepingWhatWasTypedWhenTheURLIsNotAnIssue() async throws {
        let services = FakeSheetServices()
        let person = IssuePerson(["typed:not a url", "typed:\(issue)", "Open the root checkout as it is"])
        try await walk(person, services)
        XCTAssertEqual(person.asked[1].initialQuery, "not a url")
        XCTAssertEqual(person.asked[1].note, "That is not a GitHub Issue or pull request URL.")
        XCTAssertTrue(person.asked[1].noteIsFailure)
    }

    func testAsksWhichRepositoryOnlyWhenThereAreTwo() async throws {
        let services = FakeSheetServices()
        services.repositories.append(RepositoryCandidate(place: .local(path: "/work/widget"), worktrees: []))
        let person = IssuePerson(["typed:\(issue)", "/work/widget", "Open the root checkout as it is"])
        try await walk(person, services)
        XCTAssertEqual(person.asked[1].title, "Which example/widget")
        XCTAssertEqual(services.prepared.last?.place, .local(path: "/work/widget"))
    }

    func testClonesWhenThereIsNoCloneToWorkInAndSaysWhy() async throws {
        let services = FakeSheetServices()
        services.repositories = []
        let person = IssuePerson(["typed:\(issue)", "/work", "Open the root checkout as it is"])
        try await walk(person, services)
        XCTAssertEqual(person.asked[1].title, "Clone example/widget")
        XCTAssertTrue(person.asked[1].question.hasPrefix(IssueFlow.nothingCloned(GitHubItem.parse(url: issue)!)))
        XCTAssertEqual(services.cloned.first?.0, "https://github.com/example/widget.git")
        XCTAssertEqual(services.cloned.first?.1, "/work")
        XCTAssertEqual(services.prepared.last?.place, .local(path: "/work/widget"))
    }

    func testTurnsALookupThatFailedIntoAQuestionNotAnotherLookup() async throws {
        let services = FakeSheetServices()
        services.findFailure = UserFacingFailure("DevHub gave up looking for example/widget after 30 seconds.")
        let person = IssuePerson(["typed:\(issue)", "Look again", "Open the root checkout as it is"])
        try await walk(person, services)
        XCTAssertEqual(person.asked[1].question, "DevHub gave up looking for example/widget after 30 seconds.")
        XCTAssertEqual(services.calls.filter { $0.hasPrefix("find") }.count, 2)
    }

    func testTakesEscapeBackToTheQuestionBeforeOpeningNothing() async throws {
        let services = FakeSheetServices()
        let person = IssuePerson(["typed:\(issue)", "escape", "typed:\(issue)", "Open the root checkout as it is"])
        try await walk(person, services)
        XCTAssertEqual(person.asked.map(\.title), [
            "Assign Issue", "Where to work on example/widget#128", "Assign Issue", "Where to work on example/widget#128",
        ])
        XCTAssertEqual(services.assigned.count, 1)
    }

    func testShowsAFolderThatCouldNotBeMadeOnTheBranchQuestion() async throws {
        let services = FakeSheetServices()
        services.prepareFailures = [CodedFailure.workspace("/projects/widget_128 already exists.")]
        let person = IssuePerson(["typed:\(issue)", "Create feature/128-wip in a new worktree", "Open the root checkout as it is"])
        try await walk(person, services)
        XCTAssertEqual(person.asked[2].title, "Where to work on example/widget#128")
        XCTAssertEqual(person.asked[2].note, "/projects/widget_128 already exists.")
    }

    func testAsksBeforeStartingABranchFromACopyTheFetchCouldNotRefresh() async throws {
        let services = FakeSheetServices()
        services.prepareFailures = [CodedFailure(code: "git_fetch_failed", summary: "The latest changes could not be fetched: offline")]
        let person = IssuePerson([
            "typed:\(issue)", "Create feature/128-wip in a new worktree", "Start from the copy on this machine",
        ])
        try await walk(person, services)
        XCTAssertEqual(person.asked[2].title, "The remote could not be reached")
        XCTAssertEqual(services.prepared.map(\.allowStaleBase), [false, true])
        XCTAssertEqual(services.assigned.count, 1)
    }

    func testStopsBeforeTheBranchQuestionForAForksBranchThisCloneCannotReach() async throws {
        let services = FakeSheetServices()
        services.branch = AssignmentBranch(branch: "fix", fork: "alice/widget", reachable: false)
        let pull = "https://github.com/example/widget/pull/130"
        let person = IssuePerson(["typed:\(pull)"])
        try await walk(person, services)
        XCTAssertEqual(person.asked.count, 2)
        XCTAssertEqual(person.asked[1].title, "Assign Issue")
        XCTAssertEqual(
            person.asked[1].note,
            "fix is in alice/widget, which this clone has no remote for, so example/widget#130 cannot be checked out here.")
    }
}
