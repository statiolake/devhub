// Port of apps/desktop/src/main/shell/issues.test.ts, plus the branch
// question and the folder half of Assign Issue (main/shell/appController.ts
// `assignmentBranch`, `prepareIssueFolder`).
//
// A worktree is the same repository checked out somewhere else, so the flow's
// first question is about *repositories* and the second is about places
// within one.

import Foundation
import XCTest
@testable import DevHubCore

final class IssuesTests: XCTestCase {
    private let git = GitTestSupport.command
    private let issue = IssueReference(owner: "example", repository: "widget", number: 128)
    private var root = ""
    private var cleanups: [String] = []

    override func setUp() async throws {
        try XCTSkipUnless(GitTestSupport.hasGit, "git is not installed")
        root = try GitTestSupport.temporaryDirectory("devhub-issues-")
        cleanups = [root]
    }

    override func tearDown() async throws {
        for path in cleanups { GitTestSupport.remove(path) }
    }

    /// A repository with `origin` pointing at the Issue's repository.
    private func repository(_ name: String) async throws -> String {
        let path = Path.join(root, name)
        try GitTestSupport.mkdir(path)
        try await git.run(["init", "-q", "."], cwd: path)
        try await git.run(["commit", "-q", "--allow-empty", "-m", "init"], cwd: path)
        try await git.run(["remote", "add", "origin", "https://github.com/example/widget.git"], cwd: path)
        return path
    }

    /// The scratch source the TS test configures: the directories directly in
    /// `root`, filtered by the query the way the picker's fuzzy filter keeps
    /// every name that contains it.
    private func searchSources() -> @Sendable (String) async -> [String] {
        let root = self.root
        return { query in
            let names = (try? FileManager.default.contentsOfDirectory(atPath: root)) ?? []
            return names.sorted().filter { $0.contains(query) }.map { Path.join(root, $0) }
        }
    }

    private func find(_ open: [WorkspacePlace] = [], gitFor: (@Sendable (WorkspacePlace) async throws -> GitCommand)? = nil) async throws -> [RepositoryCandidate] {
        let command = git
        return try await IssueClones.find(issue: issue, openPlaces: open, searchSources: searchSources(), gitFor: gitFor ?? { _ in command })
    }

    // MARK: finding the clones of an Issue's repository

    func testFoldsARepositoryAndItsWorktreesIntoOneRepository() async throws {
        let main = try await repository("widget")
        try await git.run(["worktree", "add", "-q", "-b", "feature/9-old", Path.join(root, "widget_feature_9-old")], cwd: main)
        let found = try await find()
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.first?.place.path, main)
        XCTAssertEqual(found.first?.worktrees.count, 2)
        XCTAssertEqual(found.first?.worktrees.last?.branch, "feature/9-old")
        XCTAssertEqual(found.first?.worktrees.first?.isMainWorktree, true)
        XCTAssertEqual(found.first?.worktrees.last?.isMainWorktree, false)
    }

    func testListsAWorktreeNoSourceCanSee() async throws {
        let main = try await repository("widget")
        let hidden = try GitTestSupport.temporaryDirectory("devhub-elsewhere-")
        cleanups.append(hidden)
        try await git.run(["worktree", "add", "-q", "-b", "feature/9-hidden", Path.join(hidden, "somewhere")], cwd: main)
        let found = try await find()
        XCTAssertTrue(found.first?.worktrees.map(\.branch).contains("feature/9-hidden") ?? false)
    }

    func testKeepsTwoIndependentClonesApart() async throws {
        let first = try await repository("widget")
        let second = try await repository("widget_two")
        let found = try await find()
        XCTAssertEqual(found.map(\.place.path).sorted(), [first, second].sorted())
    }

    func testIgnoresADirectoryWhoseRemoteIsSomebodyElsesWidget() async throws {
        let other = try await repository("widget")
        try await git.run(["remote", "set-url", "origin", "https://github.com/somebody/widget.git"], cwd: other)
        let named = Path.join(root, "widgetry")
        try GitTestSupport.mkdir(named)
        let found = try await find()
        XCTAssertEqual(found, [])
    }

    // MARK: a clone on another machine

    func testIsInspectedWithTheGitOfTheMachineItNames() async throws {
        let here = try await repository("widget")
        let asked = TestCell<[String]>([])
        let command = git
        let found = try await find([.ssh(host: "build.example.com", path: here)]) { place in
            asked.value.append(place.label)
            return command
        }
        XCTAssertTrue(asked.value.contains("build.example.com:\(here)"))
        XCTAssertTrue(found.map(\.place).contains(.ssh(host: "build.example.com", path: here)))
    }

    func testKeepsTwoHostsWithTheSamePathApart() async throws {
        let here = try await repository("widget")
        let found = try await find([.ssh(host: "one.example.com", path: here), .ssh(host: "two.example.com", path: here)])
        let hosts = found.compactMap { candidate -> String? in
            if case .ssh(let host, _) = candidate.place { return host }
            return nil
        }
        XCTAssertEqual(hosts.sorted(), ["one.example.com", "two.example.com"])
    }

    // MARK: a lookup that is abandoned

    func testStopsAtTheNextCandidateRatherThanWorkingThroughThemAll() async throws {
        _ = try await repository("widget")
        let command = git
        let issue = self.issue
        let search = searchSources()
        let lookup = Task {
            // The person pressed Escape before the first git was asked for.
            withUnsafeCurrentTask { $0?.cancel() }
            return try await IssueClones.find(issue: issue, openPlaces: [], searchSources: search, gitFor: { _ in command })
        }
        do {
            _ = try await lookup.value
            XCTFail("an abandoned lookup answered")
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
    }

    func testStillAnswersNormallyWhenNothingCancelsIt() async throws {
        let main = try await repository("widget")
        let found = try await find()
        XCTAssertEqual(found.map(\.place.path), [main])
    }

    // MARK: the branch question

    private func scripted(_ answer: JsonValue) -> GitHubClient {
        GitHubClient(transport: ScriptedGitHub(answer), projectScope: ProjectScopeMemory())
    }

    private func signedIn(_ environment: [String: String]) async -> GitHubTokenResult { .token("token") }

    func testAnIssueWithNoLinkedBranchIsFoundByTheConventionOrNotStarted() async throws {
        let main = try await repository("widget")
        try await git.run(["remote", "remove", "origin"], cwd: main)
        let client = scripted(["data": ["repository": ["issue": ["linkedBranches": ["nodes": []]]]]])
        let none = try await IssueAssignmentFlow.branch(
            url: "https://github.com/example/widget/issues/128", place: .local(path: main), environment: [:], git: git,
            readToken: { _ in .token("token") }, client: client
        )
        XCTAssertEqual(none, AssignmentBranch(reachable: false))

        try await git.run(["branch", "feature/128-earlier"], cwd: main)
        let named = try await IssueAssignmentFlow.branch(
            url: "https://github.com/example/widget/issues/128", place: .local(path: main), environment: [:], git: git,
            readToken: { _ in .token("token") }, client: client
        )
        XCTAssertEqual(named, AssignmentBranch(branch: "feature/128-earlier", reachable: true))
    }

    func testALinkedBranchNobodyCanReachIsDroppedSoTheIssueReadsAsNotStarted() async throws {
        let main = try await repository("widget")
        try await git.run(["remote", "remove", "origin"], cwd: main)
        let client = scripted(["data": ["repository": ["issue": ["linkedBranches": ["nodes": [["ref": ["name": "128-gone"]]]]]]]])
        let plan = try await IssueAssignmentFlow.branch(
            url: "https://github.com/example/widget/issues/128", place: .local(path: main), environment: [:], git: git,
            readToken: { _ in .token("token") }, client: client
        )
        XCTAssertEqual(plan, AssignmentBranch(reachable: false))
    }

    func testAPullRequestsHeadFromAForkThisCloneCannotReachSaysWhere() async throws {
        let main = try await repository("widget")
        try await git.run(["remote", "remove", "origin"], cwd: main)
        let client = scripted(["data": ["repository": ["pullRequest": ["headRefName": "patch-1", "state": "OPEN", "headRepository": ["name": "widget", "owner": ["login": "alice"]]]]]])
        let plan = try await IssueAssignmentFlow.branch(
            url: "https://github.com/example/widget/pull/7", place: .local(path: main), environment: [:], git: git,
            readToken: { _ in .token("token") }, client: client
        )
        XCTAssertEqual(plan, AssignmentBranch(branch: "patch-1", fork: "alice/widget", reachable: false, pullRequestState: .open))
    }

    func testRefusesToOfferChoicesAboutSomethingItNeverRead() async throws {
        let main = try await repository("widget")
        await GitTestSupport.assertRejects(
            try await IssueAssignmentFlow.branch(url: "https://github.com/example/widget/issues/128", place: .local(path: main), environment: [:], git: self.git, readToken: { _ in .unauthenticated }),
            matching: "Run `gh auth login`"
        )
        await GitTestSupport.assertRejects(
            try await IssueAssignmentFlow.branch(url: "https://example.com/nothing", place: .local(path: main), environment: [:], git: self.git),
            matching: "not a GitHub Issue or pull request URL"
        )
        await GitTestSupport.assertRejects(
            try await IssueAssignmentFlow.branch(url: "https://github.com/example/widget/issues/128", place: .local(path: main), environment: [:], git: self.git, readToken: { _ in .unrunnable(reason: "there is no `gh` on DevHub's PATH") }),
            matching: "could not ask GitHub about example/widget#128: there is no `gh` on DevHub's PATH\\."
        )
    }

    // MARK: the folder

    func testPreparesTheIssuesWorktreeOrTheCloneAsItStands() async throws {
        let main = try await repository("widget")
        try await git.run(["remote", "remove", "origin"], cwd: main)
        let asItStands = try await IssueAssignmentFlow.prepareFolder(IssueFolderRequest(issueUrl: "https://github.com/example/widget/issues/128", place: .local(path: main)), git: git)
        XCTAssertEqual(asItStands, .local(path: main))
        let worktree = try await IssueAssignmentFlow.prepareFolder(
            IssueFolderRequest(issueUrl: "https://github.com/example/widget/issues/128", place: .ssh(host: "h", path: main), branch: GitHubBranchNaming.wipBranch(forIssue: 128)),
            git: git
        )
        // The machine the flow was working on; only the path moves.
        XCTAssertEqual(worktree, .ssh(host: "h", path: Path.join(root, "widget_128")))
        let rooted = try await IssueAssignmentFlow.prepareFolder(
            IssueFolderRequest(issueUrl: "https://github.com/example/widget/issues/9", place: .local(path: main), branch: "feature/9-wip", inRoot: true),
            git: git
        )
        XCTAssertEqual(rooted, .local(path: main))
        let head = try await git.readBranch(main)
        XCTAssertEqual(head, "feature/9-wip")
    }

    func testTheCLIsDefaultBranchIsTheOfferedOneElseTheWipBranch() {
        let issueItem = GitHubItem(owner: "example", repository: "widget", number: 128, kind: .issue)
        let pullItem = GitHubItem(owner: "example", repository: "widget", number: 7, kind: .pull)
        XCTAssertEqual(IssueAssignmentFlow.defaultBranch(for: issueItem, existing: AssignmentBranch(branch: "feature/128-x", reachable: true)), "feature/128-x")
        XCTAssertEqual(IssueAssignmentFlow.defaultBranch(for: issueItem, existing: AssignmentBranch(reachable: false)), "feature/128-wip")
        XCTAssertNil(IssueAssignmentFlow.defaultBranch(for: pullItem, existing: AssignmentBranch(branch: "patch-1", reachable: false)))
    }
}
