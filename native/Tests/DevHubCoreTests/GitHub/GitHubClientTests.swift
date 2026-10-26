// Port of apps/desktop/src/main/shell/github.test.ts.
//
// Two subjects, because there are two ways this file talks to GitHub and they
// fail differently. Asking `gh` for a token is a process that may not exist;
// asking the API what a branch is about is a round trip that may be refused.
// The `gh` tests run a real (scripted) `gh` off a real PATH, because the whole
// distinction lives in how the process fails.

import Foundation
import XCTest
@testable import DevHubCore

/// GitHub's answer, as the one round trip returns it, and every request sent.
final class ScriptedGitHub: GitHubTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var bodies: [JsonValue] = []
    private var tokens: [String] = []
    var status = 200
    var answer: JsonValue
    var failure: String?

    init(_ answer: JsonValue) { self.answer = answer }

    func post(body: Data, token: String) async throws -> GitHubHTTPAnswer {
        let (status, answer, failure) = try record(body: body, token: token)
        if let failure { throw URLSessionGitHubTransport.TransportError(message: failure) }
        return GitHubHTTPAnswer(status: status, body: Data(answer.jsonText.utf8))
    }

    private func record(body: Data, token: String) throws -> (Int, JsonValue, String?) {
        lock.lock()
        defer { lock.unlock() }
        bodies.append(try JsonValue.parse(body))
        tokens.append(token)
        return (status, answer, failure)
    }

    var sent: [JsonValue] { lock.lock(); defer { lock.unlock() }; return bodies }
}

final class GitHubClientTests: XCTestCase {
    private var directory = ""

    override func setUp() async throws {
        directory = try GitTestSupport.temporaryDirectory("devhub-gh-")
    }

    override func tearDown() async throws {
        GitTestSupport.remove(directory)
    }

    /// A `gh` on PATH that behaves however this test needs it to.
    private func fakeGh(_ script: String) throws {
        let path = Path.join(directory, "gh")
        try GitTestSupport.write(path, "#!/bin/sh\n\(script)\n")
        chmod(path, 0o755)
    }

    // MARK: reading the GitHub token

    func testIsTheTokenWhenGhIsHoldingOne() async throws {
        try fakeGh(#"echo "gho_example""#)
        let result = await GitHubCLI.readToken(environment: ["PATH": directory])
        XCTAssertEqual(result, .token("gho_example"))
    }

    func testIsUnauthenticatedWhenGhRunsAndDeclines() async throws {
        try fakeGh("exit 1")
        let result = await GitHubCLI.readToken(environment: ["PATH": directory])
        XCTAssertEqual(result, .unauthenticated)
    }

    func testIsUnauthenticatedWhenGhSucceedsButSaysNothing() async throws {
        try fakeGh("exit 0")
        let result = await GitHubCLI.readToken(environment: ["PATH": directory])
        XCTAssertEqual(result, .unauthenticated)
    }

    func testIsUnrunnableNamingPATHWhenThereIsNoGhToRun() async {
        let result = await GitHubCLI.readToken(environment: ["PATH": directory])
        XCTAssertEqual(result, .unrunnable(reason: "there is no `gh` on DevHub's PATH"))
    }

    // MARK: reading who GitHub says this machine is

    func testIsTheLoginWhenGhAnswersWithOne() async throws {
        try fakeGh(#"echo "octocat""#)
        let result = await GitHubCLI.readLogin(environment: ["PATH": directory])
        XCTAssertEqual(result, .login("octocat"))
    }

    func testSaysToLogInWhenGhRunsAndDeclines() async throws {
        try fakeGh("exit 1")
        let result = await GitHubCLI.readLogin(environment: ["PATH": directory])
        XCTAssertEqual(result, .unknown(reason: "`gh` is not signed in to GitHub — run `gh auth login`"))
    }

    func testNamesPATHNotTheLoginWhenThereIsNoGhToRun() async {
        let result = await GitHubCLI.readLogin(environment: ["PATH": directory])
        XCTAssertEqual(result, .unknown(reason: "there is no `gh` on DevHub's PATH"))
    }

    // MARK: the pull request a branch is about

    private let reference = BranchReference(owner: "example", repository: "widget", headOwner: "example", branch: "feature/128-tidy", remoteBranch: "feature/128-tidy", issueNumber: 128)
    /// The same workspace, done in a fork: the branch is mine, the Issue is theirs.
    private let forked = BranchReference(owner: "example", repository: "widget", headOwner: "contributor", branch: "feature/128-tidy", remoteBranch: "feature/128-tidy", issueNumber: 128)

    private func client(_ github: ScriptedGitHub) -> GitHubClient {
        GitHubClient(transport: github, projectScope: ProjectScopeMemory())
    }

    /// The pull requests a branch has, newest first, as the query orders them.
    private func withPullRequests(_ nodes: [JsonValue], issue: JsonValue = ["number": 128, "title": "Tidy", "state": "OPEN", "url": "i"]) -> ScriptedGitHub {
        ScriptedGitHub(["data": ["repository": ["issue": issue, "pullRequests": ["nodes": .array(nodes)]]]])
    }

    private func pullRequest(_ over: [(String, JsonValue)] = []) -> JsonValue {
        var node: JsonObject = [
            "number": 1,
            "url": "p",
            "title": "Tidy the picker",
            "state": "OPEN",
            "isDraft": false,
            "headRepositoryOwner": ["login": "example"],
            "reviewThreads": ["totalCount": 0, "nodes": []],
            "commits": ["nodes": [["commit": ["statusCheckRollup": nil]]]],
        ]
        for (key, value) in over { node[key] = value }
        return .object(node)
    }

    private func variables(_ github: ScriptedGitHub, _ index: Int = 0) -> JsonValue? {
        github.sent[index]["variables"]
    }

    func testIsTheOneOutFromTheBranchWhateverItsBodySays() async throws {
        let github = withPullRequests([pullRequest([("number", 7)])])
        let status = try await client(github).readBranchStatus(reference, token: "token")
        XCTAssertEqual(status.pullRequest, PullRequestStatus(number: 7, url: "p", title: "Tidy the picker", state: .open, conversations: ConversationCount(unresolved: 0, uncounted: 0)))
    }

    func testSearchesForTheBranchsNameOnTheRemoteNotItsNameHere() async throws {
        let github = withPullRequests([])
        var renamed = reference
        renamed.branch = "local-name"
        renamed.remoteBranch = "release-2"
        _ = try await client(github).readBranchStatus(renamed, token: "token")
        XCTAssertEqual(variables(github)?["branch"]?.stringValue, "release-2")
    }

    func testAsksTheRepositoryTheNumbersLiveInByBranchName() async throws {
        let github = withPullRequests([])
        _ = try await client(github).readBranchStatus(reference, token: "token")
        XCTAssertEqual(variables(github)?["owner"]?.stringValue, "example")
        XCTAssertEqual(variables(github)?["branch"]?.stringValue, "feature/128-tidy")
        XCTAssertEqual(variables(github)?["wantIssue"]?.boolValue, true)
    }

    func testIsNothingAtAllWhenNobodyHasOpenedOne() async throws {
        let status = try await client(withPullRequests([])).readBranchStatus(reference, token: "token")
        XCTAssertNil(status.pullRequest)
        XCTAssertEqual(status.issue?.number, 128)
    }

    func testIgnoresAPullRequestFromSomebodyElsesBranchOfTheSameName() async throws {
        let github = withPullRequests([pullRequest([("number", 99), ("headRepositoryOwner", ["login": "somebody-else"])])])
        let status = try await client(github).readBranchStatus(reference, token: "token")
        XCTAssertNil(status.pullRequest)
    }

    func testIgnoresAPullRequestWhoseForkHasBeenDeleted() async throws {
        let github = withPullRequests([pullRequest([("headRepositoryOwner", nil)])])
        let status = try await client(github).readBranchStatus(reference, token: "token")
        XCTAssertNil(status.pullRequest)
    }

    func testReportsEachStateAsGitHubMeansIt() async throws {
        for (state, draft, expected) in [
            ("MERGED", false, PullRequestStatus.State.merged),
            ("CLOSED", false, .closed),
            ("OPEN", true, .draft),
            // GitHub keeps `isDraft` on a draft closed without being marked ready.
            ("CLOSED", true, .closed),
        ] {
            let github = withPullRequests([pullRequest([("state", .string(state)), ("isDraft", .bool(draft))])])
            let status = try await client(github).readBranchStatus(reference, token: "token")
            XCTAssertEqual(status.pullRequest?.state, expected, "\(state) draft=\(draft)")
        }
    }

    func testPrefersALivePullRequestToAMoreRecentlyTouchedDeadOne() async throws {
        let github = withPullRequests([pullRequest([("number", 4), ("state", "CLOSED")]), pullRequest([("number", 5), ("state", "OPEN")])])
        let status = try await client(github).readBranchStatus(reference, token: "token")
        XCTAssertEqual(status.pullRequest?.number, 5)
        XCTAssertEqual(status.pullRequest?.state, .open)
    }

    func testTakesTheMostRecentlyUpdatedWhenNoneOfThemAreLive() async throws {
        let github = withPullRequests([pullRequest([("number", 4), ("state", "MERGED")]), pullRequest([("number", 3), ("state", "CLOSED")])])
        let status = try await client(github).readBranchStatus(reference, token: "token")
        XCTAssertEqual(status.pullRequest?.number, 4)
    }

    // MARK: the conversations in a branch's pull request

    private func threads(_ resolved: [Bool], totalCount: Int? = nil) -> JsonValue {
        ["totalCount": .number(Double(totalCount ?? resolved.count)), "nodes": .array(resolved.map { ["isResolved": .bool($0)] })]
    }

    func testIsAskedOnTheSameQueryAsThePullRequestOnePageOfThreads() async throws {
        let github = withPullRequests([])
        _ = try await client(github).readBranchStatus(reference, token: "token")
        // The Projects lanes are a separate, failure-tolerant request.
        XCTAssertEqual(github.sent.filter { ($0["query"]?.stringValue ?? "").contains("pullRequests(") }.count, 1)
        let query = github.sent[0]["query"]?.stringValue ?? ""
        XCTAssertTrue(query.contains("reviewThreads(first:$threads){ totalCount nodes{ isResolved } }"))
        XCTAssertEqual(variables(github)?["threads"]?.numberValue, 100)
    }

    func testCountsTheThreadsNobodyHasResolved() async throws {
        let github = withPullRequests([pullRequest([("reviewThreads", threads([false, true, false, false]))])])
        let status = try await client(github).readBranchStatus(reference, token: "token")
        XCTAssertEqual(status.pullRequest?.conversations, ConversationCount(unresolved: 3, uncounted: 0))
    }

    func testIsNoughtWhenEveryThreadIsResolved() async throws {
        let github = withPullRequests([pullRequest([("reviewThreads", threads([true, true]))])])
        let status = try await client(github).readBranchStatus(reference, token: "token")
        XCTAssertEqual(status.pullRequest?.conversations, ConversationCount(unresolved: 0, uncounted: 0))
    }

    func testSaysHowManyThreadsWerePastThePageItCounted() async throws {
        let page = (0..<100).map { $0 % 10 != 0 }
        let github = withPullRequests([pullRequest([("reviewThreads", threads(page, totalCount: 250))])])
        let status = try await client(github).readBranchStatus(reference, token: "token")
        XCTAssertEqual(status.pullRequest?.conversations, ConversationCount(unresolved: 10, uncounted: 150))
    }

    func testDoesNotCountAThreadGitHubWouldNotShowAsResolved() async throws {
        let github = withPullRequests([pullRequest([("reviewThreads", ["totalCount": 3, "nodes": [["isResolved": false], nil, ["isResolved": true]]])])])
        let status = try await client(github).readBranchStatus(reference, token: "token")
        XCTAssertEqual(status.pullRequest?.conversations, ConversationCount(unresolved: 1, uncounted: 1))
    }

    func testCountsTheChosenPullRequestsThreadsNotAnothers() async throws {
        let github = withPullRequests([
            pullRequest([("number", 3), ("state", "CLOSED"), ("reviewThreads", threads([false, false]))]),
            pullRequest([("number", 4), ("reviewThreads", threads([false]))]),
        ])
        let chosen = try await client(github).readBranchStatus(reference, token: "token").pullRequest
        XCTAssertEqual(chosen?.number, 4)
        XCTAssertEqual(chosen?.conversations.unresolved, 1)
    }

    func testIsAFailureNotANoughtWhenGitHubLeavesTheThreadsOut() async throws {
        let github = withPullRequests([pullRequest([("number", 5), ("reviewThreads", nil)])])
        await GitHubAssert.rejects(try await self.client(github).readBranchStatus(self.reference, token: "token")) { failure in
            XCTAssertTrue(failure.isGitHubUnavailable)
            XCTAssertTrue(failure.text.contains("GitHub did not list the review conversations of example/widget#5."))
        }
    }

    // MARK: the CI of a branch's pull request

    private func rollup(_ state: String, _ checkRuns: [(String, Int)], _ statuses: [(String, Int)] = []) -> JsonValue {
        func counts(_ by: [(String, Int)]) -> JsonValue { .array(by.map { ["state": .string($0.0), "count": .number(Double($0.1))] }) }
        let total = (checkRuns + statuses).reduce(0) { $0 + $1.1 }
        return ["nodes": [["commit": ["statusCheckRollup": [
            "state": .string(state),
            "contexts": ["totalCount": .number(Double(total)), "checkRunCountsByState": counts(checkRuns), "statusContextCountsByState": counts(statuses)],
        ]]]]]
    }

    private func checksOf(_ commits: JsonValue) async throws -> CheckSummary? {
        try await client(withPullRequests([pullRequest([("commits", commits)])])).readBranchStatus(reference, token: "token").pullRequest?.checks
    }

    func testCIIsAskedOnTheSameQueryFromItsHeadCommit() async throws {
        let github = withPullRequests([])
        _ = try await client(github).readBranchStatus(reference, token: "token")
        let query = github.sent[0]["query"]?.stringValue ?? ""
        XCTAssertTrue(query.contains("commits(last:1){ nodes{ commit{ statusCheckRollup{"))
        XCTAssertTrue(query.contains("contexts{ totalCount checkRunCountsByState{ state count } statusContextCountsByState{ state count } }"))
    }

    func testIsFailingCountingWhatFailedHoweverItFailed() async throws {
        let checks = try await checksOf(rollup("FAILURE", [("SUCCESS", 7), ("FAILURE", 1), ("TIMED_OUT", 1), ("CANCELLED", 1), ("SKIPPED", 2)], [("ERROR", 1), ("SUCCESS", 1)]))
        XCTAssertEqual(checks, CheckSummary(state: .failing, total: 14, failing: 4, pending: 0))
    }

    func testIsFailingWhenGitHubCallsItAnError() async throws {
        let checks = try await checksOf(rollup("ERROR", [], [("ERROR", 1)]))
        XCTAssertEqual(checks?.state, .failing)
    }

    func testIsPendingCountingWhatHasNotFinishedOrNotStarted() async throws {
        let checks = try await checksOf(rollup("PENDING", [("SUCCESS", 3), ("QUEUED", 1), ("IN_PROGRESS", 2), ("WAITING", 1)], [("EXPECTED", 1), ("PENDING", 1)]))
        XCTAssertEqual(checks, CheckSummary(state: .pending, total: 9, failing: 0, pending: 6))
    }

    func testIsPendingWhenAStatusGitHubExpectsHasNotReported() async throws {
        let checks = try await checksOf(rollup("EXPECTED", [], [("EXPECTED", 2)]))
        XCTAssertEqual(checks?.state, .pending)
    }

    func testIsPassingWithSkippedAndNeutralChecksInTheTotal() async throws {
        let checks = try await checksOf(rollup("SUCCESS", [("SUCCESS", 11), ("SKIPPED", 6), ("NEUTRAL", 1)]))
        XCTAssertEqual(checks, CheckSummary(state: .passing, total: 18, failing: 0, pending: 0))
    }

    func testIsAbsentWhenNothingHasReportedOnTheHeadCommit() async throws {
        let checks = try await checksOf(["nodes": [["commit": ["statusCheckRollup": nil]]]])
        XCTAssertNil(checks)
    }

    func testIsAFailureNotAnAbsenceWhenGitHubLeavesTheCommitsOut() async throws {
        let github = withPullRequests([pullRequest([("number", 5), ("commits", nil)])])
        await GitHubAssert.rejects(try await self.client(github).readBranchStatus(self.reference, token: "token")) { failure in
            XCTAssertTrue(failure.text.contains("GitHub did not list the head commit of example/widget#5."))
        }
    }

    func testIsAFailureWhenTheVerdictIsOneItDoesNotKnow() async throws {
        let github = withPullRequests([pullRequest([("number", 6), ("commits", rollup("SOMETHING_NEW", []))])])
        await GitHubAssert.rejects(try await self.client(github).readBranchStatus(self.reference, token: "token")) { failure in
            XCTAssertTrue(failure.text.contains("GitHub said the CI of example/widget#6 is SOMETHING_NEW, which DevHub does not know."))
        }
    }

    // MARK: a branch in a fork

    func testAsksUpstreamAndTakesThePullRequestOutOfTheFork() async throws {
        let github = withPullRequests([pullRequest([("number", 12), ("headRepositoryOwner", ["login": "contributor"])])])
        let status = try await client(github).readBranchStatus(forked, token: "token")
        XCTAssertEqual(variables(github)?["owner"]?.stringValue, "example")
        XCTAssertEqual(status.pullRequest?.number, 12)
        XCTAssertEqual(status.issue?.number, 128)
    }

    func testDoesNotTakeAPullRequestFromADifferentForkOfTheSameBranch() async throws {
        let github = withPullRequests([pullRequest([("number", 5), ("headRepositoryOwner", ["login": "example"])])])
        let status = try await client(github).readBranchStatus(forked, token: "token")
        XCTAssertNil(status.pullRequest)
    }

    // MARK: the Issue a branch names

    func testIsNotAskedForWhenTheBranchNamesNone() async throws {
        let github = withPullRequests([], issue: nil)
        _ = try await client(github).readBranchStatus(
            BranchReference(owner: "example", repository: "widget", headOwner: "example", branch: "spike/rework", remoteBranch: "spike/rework"),
            token: "token"
        )
        XCTAssertEqual(variables(github)?["wantIssue"]?.boolValue, false)
        XCTAssertEqual(variables(github)?["number"]?.numberValue, 0)
    }

    func testIsAFailureWhenTheBranchNamesOneGitHubDoesNotHave() async throws {
        let github = withPullRequests([], issue: nil)
        await GitHubAssert.rejects(try await self.client(github).readBranchStatus(self.reference, token: "token")) { failure in
            XCTAssertTrue(failure.text.contains("no issue example/widget#128"))
        }
    }

    func testCarriesTheIssuesProjectsWhenTheyCanBeRead() async throws {
        let github = withPullRequests([])
        let status = try await client(github).readBranchStatus(reference, token: "token")
        // The scripted answer has no `projectItems`: an empty board list is
        // no badge, and is not drawn as one.
        XCTAssertNil(status.issue?.projects)
        XCTAssertNil(status.issue?.projectsUnreadable)
        XCTAssertEqual(status.issue, IssueStatus(number: 128, title: "Tidy", state: .open, url: "i"))
        XCTAssertEqual(github.sent.count, 2)
    }

    // MARK: the branch a pull request is from

    func testIsTheHeadRefWithTheRepositoryItIsActuallyIn() async throws {
        let github = ScriptedGitHub(["data": ["repository": ["pullRequest": ["headRefName": "patch-1", "headRepository": ["name": "widget", "owner": ["login": "alice"]]]]]])
        let head = try await client(github).readPullRequestHead(IssueReference(owner: "example", repository: "widget", number: 7), token: "token")
        XCTAssertEqual(head, PullRequestHead(branch: "patch-1", owner: "alice", repository: "widget"))
    }

    func testBelongsToThePullRequestsOwnRepositoryWhenTheForkIsGone() async throws {
        let github = ScriptedGitHub(["data": ["repository": ["pullRequest": ["headRefName": "release-2", "headRepository": nil, "state": "MERGED"]]]])
        let head = try await client(github).readPullRequestHead(IssueReference(owner: "example", repository: "widget", number: 7), token: "token")
        XCTAssertEqual(head, PullRequestHead(branch: "release-2", owner: "example", repository: "widget", state: .merged))
    }

    func testIsARefusalWhenGitHubWillNotSayWhichBranchItIs() async throws {
        let github = ScriptedGitHub(["data": ["repository": ["pullRequest": nil]]])
        await GitHubAssert.rejects(try await self.client(github).readPullRequestHead(IssueReference(owner: "example", repository: "widget", number: 7), token: "token")) { failure in
            XCTAssertEqual(failure.code, "github_unavailable")
            XCTAssertTrue(failure.detail?.contains("did not say which branch") ?? false)
        }
    }

    // MARK: the branch an Issue is linked to

    func testIsTheFirstBranchGitHubHasRecordedAgainstIt() async throws {
        let github = ScriptedGitHub(["data": ["repository": ["issue": ["linkedBranches": ["nodes": [["ref": ["name": "128-add-the-picker"]], ["ref": ["name": "128-first-try"]]]]]]]])
        let branch = try await client(github).readIssueLinkedBranch(IssueReference(owner: "example", repository: "widget", number: 128), token: "token")
        XCTAssertEqual(branch, "128-add-the-picker")
    }

    func testIsNothingAtAllForAnIssueNobodyHasStarted() async throws {
        let github = ScriptedGitHub(["data": ["repository": ["issue": ["linkedBranches": ["nodes": []]]]]])
        let branch = try await client(github).readIssueLinkedBranch(IssueReference(owner: "example", repository: "widget", number: 128), token: "token")
        XCTAssertNil(branch)
    }

    // MARK: a refusal

    func testIsReportedAsGitHubsOwnWords() async throws {
        let github = ScriptedGitHub(["errors": [["message": "API rate limit exceeded."]]])
        await GitHubAssert.rejects(try await self.client(github).readBranchStatus(self.reference, token: "token")) { failure in
            XCTAssertEqual(failure.code, "github_unavailable")
            XCTAssertEqual(failure.summary, "DevHub could not get this from GitHub.")
            XCTAssertEqual(failure.detail, "API rate limit exceeded.")
        }
    }

    func testNeverCarriesTheToken() async throws {
        let github = ScriptedGitHub([:])
        github.status = 500
        await GitHubAssert.rejects(try await self.client(github).readBranchStatus(self.reference, token: "secret-token")) { failure in
            XCTAssertEqual(failure.text, "DevHub could not get this from GitHub. GitHub answered 500.")
            XCTAssertFalse("\(failure)".contains("secret-token"))
        }
    }

    func testSaysTheCredentialsWereRefusedWithoutSayingWhatWith() async throws {
        let github = ScriptedGitHub([:])
        github.status = 401
        await GitHubAssert.rejects(try await self.client(github).readBranchStatus(self.reference, token: "secret-token")) { failure in
            XCTAssertEqual(failure.detail, "GitHub refused DevHub's credentials. Run `gh auth login` and try again.")
        }
        github.status = 200
        github.failure = "The Internet connection appears to be offline."
        await GitHubAssert.rejects(try await self.client(github).readBranchStatus(self.reference, token: "secret-token")) { failure in
            XCTAssertEqual(failure.detail, "The Internet connection appears to be offline.")
        }
    }

    // MARK: an Issue's Projects lanes

    private let issue = IssueReference(owner: "example", repository: "widget", number: 128)

    func testAreReadFromProjectItems() async throws {
        let github = ScriptedGitHub(["data": ["repository": ["issue": ["projectItems": ["nodes": [
            ["project": ["title": "DevHub Roadmap"], "fieldValueByName": ["name": "In Review", "color": "YELLOW"]],
        ]]]]]])
        let projects = await client(github).readIssueProjects(issue, token: "token")
        XCTAssertEqual(projects.lanes, [ProjectLane(project: "DevHub Roadmap", status: "In Review", color: "YELLOW")])
        XCTAssertFalse(projects.unreadable)
    }

    func testAreQuietlyUnreadableWithoutReadProjectAndNotAskedAgainSoon() async throws {
        let github = ScriptedGitHub([
            "data": ["repository": ["issue": nil]],
            "errors": [["type": "INSUFFICIENT_SCOPES", "message": "Your token has not been granted the required scopes: read:project"]],
        ])
        let reader = client(github)
        let first = await reader.readIssueProjects(issue, token: "token", at: 1000)
        XCTAssertTrue(first.unreadable)
        XCTAssertNil(first.lanes)
        let second = await reader.readIssueProjects(issue, token: "token", at: 2000)
        XCTAssertTrue(second.unreadable)
        XCTAssertEqual(github.sent.count, 1)
        // Asked again once the memory has run out.
        _ = await reader.readIssueProjects(issue, token: "token", at: 1000 + ProjectScopeMemory.retryMs)
        XCTAssertEqual(github.sent.count, 2)
    }

    func testAreNothingNotAnErrorWhenTheRequestFails() async throws {
        let github = ScriptedGitHub(["errors": [["message": "API rate limit exceeded."]]])
        let projects = await client(github).readIssueProjects(issue, token: "token")
        XCTAssertNil(projects.lanes)
        XCTAssertFalse(projects.unreadable)
    }
}

enum GitHubAssert {
    static func rejects<T>(_ expression: @autoclosure () async throws -> T, file: StaticString = #filePath, line: UInt = #line, _ check: (CodedFailure) -> Void) async {
        do {
            _ = try await expression()
            XCTFail("it did not fail", file: file, line: line)
        } catch let failure as CodedFailure {
            check(failure)
        } catch {
            XCTFail("\(error) is not a coded failure", file: file, line: line)
        }
    }
}
