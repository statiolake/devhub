// Port of apps/desktop/src/main/shell/github.ts.
//
// What GitHub is asked, and how DevHub is allowed to ask it.
//
// One GraphQL query per branch DevHub is watching, built here rather than
// shelled out to `gh`: the CLI's own queries fetch far more than a title and a
// pull request's state, and this runs every minute.
//
// The token is read from `gh auth token` and used. It is never written to a
// config file, never logged, and never put in an error message — a failure says
// that authentication was refused, not what was refused with.

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - What is asked, and what comes back

/// A workspace's checked-out branch, as GitHub names the things it is about.
///
/// Two repositories, because in a fork they are two. The Issue and the pull
/// request live in `owner/repository` — `upstream`, where the work is
/// discussed — and the branch lives in `headOwner`'s copy of it.
public struct BranchReference: Hashable, Sendable {
    /// Where Issues and pull requests are numbered: `upstream`, or `origin`.
    public var owner: String
    public var repository: String
    /// Who owns the branch — the fork, when the work is being done in one.
    public var headOwner: String
    /// The short name, as git reports it.
    public var branch: String
    /// What that branch is called on the remote, which is what a pull
    /// request's head actually is; the local name for a branch never pushed.
    public var remoteBranch: String
    /// The Issue the branch names, by DevHub's convention, when it names one.
    public var issueNumber: Int?

    public init(owner: String, repository: String, headOwner: String, branch: String, remoteBranch: String, issueNumber: Int? = nil) {
        self.owner = owner
        self.repository = repository
        self.headOwner = headOwner
        self.branch = branch
        self.remoteBranch = remoteBranch
        self.issueNumber = issueNumber
    }
}

/// What GitHub says a branch is about. Either half may be absent.
public struct BranchStatus: Equatable, Sendable {
    public var issue: IssueStatus?
    public var pullRequest: PullRequestStatus?

    public init(issue: IssueStatus? = nil, pullRequest: PullRequestStatus? = nil) {
        self.issue = issue
        self.pullRequest = pullRequest
    }
}

public struct IssueStatus: Equatable, Sendable, Codable {
    public enum State: String, Sendable, Codable { case open, closed }
    public var number: Int
    public var title: String
    public var state: State
    public var url: String
    /// Projects (v2) boards and lanes; absent when unreadable.
    public var projects: [ProjectLane]?
    /// Set when the token lacks `read:project`, so the row can say so once.
    public var projectsUnreadable: Bool?

    public init(number: Int, title: String, state: State, url: String, projects: [ProjectLane]? = nil, projectsUnreadable: Bool? = nil) {
        self.number = number
        self.title = title
        self.state = state
        self.url = url
        self.projects = projects
        self.projectsUnreadable = projectsUnreadable
    }
}

/// The pull request out from this branch, in all four states: asking the
/// branch directly answers about the merged and closed ones too.
public struct PullRequestStatus: Equatable, Sendable, Codable {
    public enum State: String, Sendable, Codable { case open, draft, closed, merged }
    public var number: Int
    public var url: String
    public var title: String
    public var state: State
    public var conversations: ConversationCount
    /// Its head commit's CI, or absent when nothing has reported on that commit.
    public var checks: CheckSummary?

    public init(number: Int, url: String, title: String, state: State, conversations: ConversationCount, checks: CheckSummary? = nil) {
        self.number = number
        self.url = url
        self.title = title
        self.state = state
        self.conversations = conversations
        self.checks = checks
    }
}

/// What a pull request's CI says about its head commit: GitHub's own rollup,
/// folded into the three verdicts a person acts on, and how many checks are in
/// each of the two that ask something of you, out of `total`.
public struct CheckSummary: Equatable, Sendable, Codable {
    public enum State: String, Sendable, Codable { case passing, failing, pending }
    public var state: State
    public var total: Int
    public var failing: Int
    public var pending: Int

    public init(state: State, total: Int, failing: Int, pending: Int) {
        self.state = state
        self.total = total
        self.failing = failing
        self.pending = pending
    }
}

/// A pull request's review conversations nobody has resolved yet, counted
/// from the first page of them; `uncounted` says how many were past that.
public struct ConversationCount: Equatable, Sendable, Codable {
    public var unresolved: Int
    public var uncounted: Int

    public init(unresolved: Int, uncounted: Int) {
        self.unresolved = unresolved
        self.uncounted = uncounted
    }
}

/// A pull request's head, as somewhere a branch can be fetched from.
public struct PullRequestHead: Equatable, Sendable {
    public enum State: String, Sendable { case open, closed, merged }
    public var branch: String
    public var owner: String
    public var repository: String
    /// Open, closed unmerged, or merged — absent when GitHub did not say.
    public var state: State?

    public init(branch: String, owner: String, repository: String, state: State? = nil) {
        self.branch = branch
        self.owner = owner
        self.repository = repository
        self.state = state
    }
}

/// The token, or why DevHub does not have one.
public enum GitHubTokenResult: Equatable, Sendable {
    case token(String)
    case unrunnable(reason: String)
    case unauthenticated
}

/// Which GitHub account this machine is signed in as, or why that is not known.
public enum GitHubLoginResult: Equatable, Sendable {
    case login(String)
    case unknown(reason: String)
}

// MARK: - `gh`

/// The one place DevHub starts the GitHub CLI.
public enum GitHubCLI {
    static let timeoutSeconds = 10.0

    /// What came of running `gh`: its answer, every way DevHub failed to get
    /// one out of the binary, or `gh` running and declining.
    enum Result: Equatable {
        case output(String)
        case unrunnable(String)
        case refused
    }

    static func run(_ args: [String], environment: [String: String]) async -> Result {
        guard let gh = ProcessRunner.resolveExecutable("gh", searchPath: environment["PATH"] ?? "") else {
            // The common one, and the only one worth its own sentence: there
            // is no `gh` on the PATH DevHub was given.
            return .unrunnable("there is no `gh` on DevHub's PATH")
        }
        do {
            let answer = try await BoundedExec.run(
                argv: [gh] + args,
                cwd: nil,
                environment: environment,
                timeoutMs: Int(timeoutSeconds * 1000),
                limits: ExecLimits(stdoutBytes: 1024 * 1024, stderrBytes: 8 * 1024)
            )
            let text = answer.stdoutText.jsTrimmed
            // `gh` ran and declined. It exits non-zero when it cannot answer,
            // and an empty answer with a zero exit means the same thing.
            return answer.code == 0 && !text.isEmpty ? .output(text) : .refused
        } catch ExecFailure.timedOut {
            return .unrunnable("`gh \(args.joined(separator: " "))` did not answer within \(Int(timeoutSeconds)) seconds")
        } catch {
            return .unrunnable(failureText(error))
        }
    }

    /// The token `gh` is holding, or why DevHub does not have one. Read on
    /// every poll rather than kept: a token that was revoked or logged out of
    /// should stop working when it stops being valid.
    public static func readToken(environment: [String: String]) async -> GitHubTokenResult {
        switch await run(["auth", "token"], environment: environment) {
        case .output(let token): return .token(token)
        case .unrunnable(let reason): return .unrunnable(reason: reason)
        case .refused: return .unauthenticated
        }
    }

    /// Who `gh` says this machine is, so a repository typed as a bare name
    /// means the same thing here as it does to `gh repo clone`.
    public static func readLogin(environment: [String: String]) async -> GitHubLoginResult {
        // `--jq` rather than parsing `gh auth status`, whose sentence is
        // written for a person and has been reworded between releases.
        switch await run(["api", "user", "--jq", ".login"], environment: environment) {
        case .output(let login): return .login(login)
        case .unrunnable(let reason): return .unknown(reason: reason)
        case .refused: return .unknown(reason: "`gh` is not signed in to GitHub — run `gh auth login`")
        }
    }
}

// MARK: - The API

/// One answer of GitHub's GraphQL endpoint: an HTTP status and the body.
public struct GitHubHTTPAnswer: Sendable {
    public var status: Int
    public var body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

/// How a request reaches GitHub. A failure to reach it at all throws with the
/// network's own reason — never the request, which carries the token.
public protocol GitHubTransport: Sendable {
    func post(body: Data, token: String) async throws -> GitHubHTTPAnswer
}

/// `fetch("https://api.github.com/graphql")`, through URLSession.
public struct URLSessionGitHubTransport: GitHubTransport {
    public static let endpoint = URL(string: "https://api.github.com/graphql")!
    public static let requestTimeoutSeconds = 20.0

    public init() {}

    public func post(body: Data, token: String) async throws -> GitHubHTTPAnswer {
        var request = URLRequest(url: Self.endpoint, timeoutInterval: Self.requestTimeoutSeconds)
        request.httpMethod = "POST"
        request.setValue("bearer \(token)", forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        // GitHub asks for one, and a request without it is answered less
        // helpfully when something goes wrong.
        request.setValue("DevHub", forHTTPHeaderField: "user-agent")
        request.httpBody = body
        let answer: (Data, Int) = try await withCheckedThrowingContinuation { continuation in
            let task = URLSession.shared.dataTask(with: request) { data, response, error in
                if let error {
                    continuation.resume(throwing: TransportError(message: (error as NSError).localizedDescription))
                    return
                }
                continuation.resume(returning: (data ?? Data(), (response as? HTTPURLResponse)?.statusCode ?? 0))
            }
            task.resume()
        }
        return GitHubHTTPAnswer(status: answer.1, body: answer.0)
    }

    struct TransportError: Error, CustomStringConvertible {
        let message: String
        var description: String { message }
    }
}

/// When the token last failed to read Projects; asked again after a while.
/// Shared by every client, as the TS module keeps it.
public final class ProjectScopeMemory: @unchecked Sendable {
    public static let shared = ProjectScopeMemory()
    static let retryMs = 10.0 * 60_000

    private let lock = NSLock()
    private var missingAt: Double?

    public init() {}

    var lastMissingAt: Double? {
        get { lock.lock(); defer { lock.unlock() }; return missingAt }
        set { lock.lock(); missingAt = newValue; lock.unlock() }
    }

    /// For tests: forget a remembered missing scope.
    public func reset() { lastMissingAt = nil }
}

/// The GraphQL questions of github.ts.
public struct GitHubClient: Sendable {
    public var transport: GitHubTransport
    public var projectScope: ProjectScopeMemory
    public var now: @Sendable () -> Double

    public init(
        transport: GitHubTransport = URLSessionGitHubTransport(),
        projectScope: ProjectScopeMemory = .shared,
        now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.transport = transport
        self.projectScope = projectScope
        self.now = now
    }

    /// How many of a branch's pull requests are read: only ever a handful.
    static let maxPullRequests = 10
    /// How many of a pull request's review threads are read to count the
    /// unresolved ones: GitHub's own ceiling for one page.
    static let maxReviewThreads = 100

    /// What a branch is about, in one round trip.
    ///
    /// The pull request is asked for by the branch's *name on the remote*,
    /// against the repository pull requests are numbered in, and then narrowed
    /// to the ones whose head is the branch's own owner — the only spelling
    /// that can answer for a fork. Its review threads and its head commit's CI
    /// rollup are on the same query. The Issue is on the same query and skipped
    /// when the branch does not name one; `$number` is still declared and sent,
    /// because GraphQL validates a variable's type whether or not the field
    /// that uses it is included.
    static let branchQuery = """
    query($owner:String!,$name:String!,$branch:String!,$number:Int!,$wantIssue:Boolean!,$prs:Int!,$threads:Int!){
      repository(owner:$owner,name:$name){
        pullRequests(headRefName:$branch, first:$prs, orderBy:{field:UPDATED_AT,direction:DESC}){
          nodes{
            number url title state isDraft headRepositoryOwner{ login }
            reviewThreads(first:$threads){ totalCount nodes{ isResolved } }
            commits(last:1){ nodes{ commit{ statusCheckRollup{
              state
              contexts{ totalCount checkRunCountsByState{ state count } statusContextCountsByState{ state count } }
            } } } }
          }
        }
        issue(number:$number) @include(if:$wantIssue){ number title state url }
      }
    }
    """

    /// Read what a branch is about: the pull request out from it, and the
    /// Issue it names, if it names one.
    public func readBranchStatus(_ reference: BranchReference, token: String) async throws -> BranchStatus {
        let wantIssue = reference.issueNumber != nil
        let answer = try await post(
            query: Self.branchQuery,
            variables: [
                "owner": .string(reference.owner),
                "name": .string(reference.repository),
                "branch": .string(reference.remoteBranch),
                // Sent whether or not it is used. Zero is never a real Issue number.
                "number": .number(Double(reference.issueNumber ?? 0)),
                "wantIssue": .bool(wantIssue),
                "prs": .number(Double(Self.maxPullRequests)),
                "threads": .number(Double(Self.maxReviewThreads)),
            ],
            token: token
        )
        if let complaint = Self.firstError(answer) { throw CodedFailure.gitHub(complaint) }
        guard let repository = answer["data"]?["repository"], repository.objectValue != nil else {
            throw CodedFailure.gitHub("GitHub has no repository \(reference.owner)/\(reference.repository).")
        }
        // No match is a fact and not a failure: it is what every branch looks
        // like before anybody opens a pull request from it.
        let chosen = Self.chosenPullRequest(repository["pullRequests"]?["nodes"]?.arrayValue ?? [], headOwner: reference.headOwner)
        let issue: JsonValue? = repository["issue"]?.objectValue == nil ? nil : repository["issue"]
        if wantIssue && issue == nil {
            throw CodedFailure.gitHub("GitHub has no issue \(reference.owner)/\(reference.repository)#\(reference.issueNumber ?? 0).")
        }
        var issueStatus: IssueStatus?
        if let issue, let number = reference.issueNumber {
            let projects = await readIssueProjects(IssueReference(owner: reference.owner, repository: reference.repository, number: number), token: token)
            issueStatus = IssueStatus(
                number: Int(issue["number"]?.numberValue ?? 0),
                title: issue["title"]?.stringValue ?? "",
                state: issue["state"]?.stringValue?.uppercased() == "CLOSED" ? .closed : .open,
                url: issue["url"]?.stringValue ?? "",
                projects: (projects.lanes?.isEmpty ?? true) ? nil : projects.lanes,
                projectsUnreadable: projects.unreadable ? true : nil
            )
        }
        var pullRequest: PullRequestStatus?
        if let chosen {
            pullRequest = PullRequestStatus(
                number: Int(chosen["number"]?.numberValue ?? 0),
                url: chosen["url"]?.stringValue ?? "",
                title: chosen["title"]?.stringValue ?? "",
                state: Self.pullRequestState(chosen),
                conversations: try Self.conversationCount(chosen, reference),
                checks: try Self.checkSummary(chosen, reference)
            )
        }
        return BranchStatus(issue: issueStatus, pullRequest: pullRequest)
    }

    /// Which of a branch's pull requests the row is about: **a live pull
    /// request outranks a finished one, and among equals the most recently
    /// updated wins** — `orderBy: UPDATED_AT DESC` makes "among equals" the
    /// first match. Only the ones out of this workspace's own remote count; a
    /// fork that has since been deleted has no owner to compare, and is
    /// nobody's.
    static func chosenPullRequest(_ nodes: [JsonValue], headOwner: String) -> JsonValue? {
        let present = nodes.filter { node in
            guard node.objectValue != nil, let login = node["headRepositoryOwner"]?["login"]?.stringValue else { return false }
            return login.lowercased() == headOwner.lowercased()
        }
        return present.first(where: { ($0["state"]?.stringValue ?? "").uppercased() == "OPEN" }) ?? present.first
    }

    /// `isDraft` is only a distinction while it is open — GitHub keeps the flag
    /// set on a draft that was closed without ever being marked ready.
    static func pullRequestState(_ node: JsonValue) -> PullRequestStatus.State {
        switch (node["state"]?.stringValue ?? "").uppercased() {
        case "MERGED": return .merged
        case "CLOSED": return .closed
        default: return node["isDraft"]?.boolValue == true ? .draft : .open
        }
    }

    /// How many of a pull request's review threads are still open. A pull
    /// request GitHub answered without the threads is a failure and not a zero.
    static func conversationCount(_ node: JsonValue, _ reference: BranchReference) throws -> ConversationCount {
        guard let threads = node["reviewThreads"], threads.objectValue != nil else {
            throw CodedFailure.gitHub("GitHub did not list the review conversations of \(reference.owner)/\(reference.repository)#\(Int(node["number"]?.numberValue ?? 0)).")
        }
        // A null in the page is a thread GitHub would not show this token,
        // which is a thread not counted rather than one counted as resolved.
        let read = (threads["nodes"]?.arrayValue ?? []).filter { $0.objectValue != nil }
        let total = Int(threads["totalCount"]?.numberValue ?? 0)
        return ConversationCount(
            unresolved: read.filter { $0["isResolved"]?.boolValue != true }.count,
            uncounted: max(0, total - read.count)
        )
    }

    /// The rollup's own verdict, as one of the three `CheckSummary` says.
    static let checkVerdict: [String: CheckSummary.State] = [
        "SUCCESS": .passing,
        "FAILURE": .failing,
        "ERROR": .failing,
        "PENDING": .pending,
        "EXPECTED": .pending,
    ]

    /// Which verdict each state a check run or a commit status can be in
    /// counts toward; a state not listed asks nothing of anybody.
    static let checkCountedAs: [String: CheckSummary.State] = [
        "FAILURE": .failing,
        "ERROR": .failing,
        "CANCELLED": .failing,
        "TIMED_OUT": .failing,
        "STARTUP_FAILURE": .failing,
        "ACTION_REQUIRED": .failing,
        "PENDING": .pending,
        "EXPECTED": .pending,
        "QUEUED": .pending,
        "IN_PROGRESS": .pending,
        "WAITING": .pending,
    ]

    /// What the pull request's CI says, from the rollup on its head commit. A
    /// pull request answered without its commits is a failure; so is a verdict
    /// this does not know — a verdict drawn as some other verdict would be a
    /// badge that lies.
    static func checkSummary(_ node: JsonValue, _ reference: BranchReference) throws -> CheckSummary? {
        let at = "\(reference.owner)/\(reference.repository)#\(Int(node["number"]?.numberValue ?? 0))"
        guard let commits = node["commits"], commits.objectValue != nil else {
            throw CodedFailure.gitHub("GitHub did not list the head commit of \(at).")
        }
        guard let rollup = commits["nodes"]?.arrayValue?.first?["commit"]?["statusCheckRollup"], rollup.objectValue != nil else {
            return nil
        }
        let raw = rollup["state"]?.stringValue ?? ""
        guard let state = checkVerdict[raw.uppercased()] else {
            throw CodedFailure.gitHub("GitHub said the CI of \(at) is \(raw), which DevHub does not know.")
        }
        let contexts = rollup["contexts"]
        let counts = (contexts?["checkRunCountsByState"]?.arrayValue ?? []) + (contexts?["statusContextCountsByState"]?.arrayValue ?? [])
        func counted(_ verdict: CheckSummary.State) -> Int {
            counts
                .filter { checkCountedAs[($0["state"]?.stringValue ?? "").uppercased()] == verdict }
                .reduce(0) { $0 + Int($1["count"]?.numberValue ?? 0) }
        }
        return CheckSummary(
            state: state,
            total: Int(contexts?["totalCount"]?.numberValue ?? 0),
            failing: counted(.failing),
            pending: counted(.pending)
        )
    }

    /// The branch a pull request is asking to merge, asked once when somebody
    /// assigns a pull request and wants a worktree for it.
    public func readPullRequestHead(_ pullRequest: IssueReference, token: String) async throws -> PullRequestHead {
        let answer = try await post(
            query: """
            query($owner:String!,$name:String!,$number:Int!){
              repository(owner:$owner,name:$name){ pullRequest(number:$number){
                headRefName
                state
                headRepository{ name owner{ login } }
              } }
            }
            """,
            variables: [
                "owner": .string(pullRequest.owner),
                "name": .string(pullRequest.repository),
                "number": .number(Double(pullRequest.number)),
            ],
            token: token
        )
        if let failed = Self.firstError(answer) { throw CodedFailure.gitHub(failed) }
        let head = answer["data"]?["repository"]?["pullRequest"]
        guard let branch = head?["headRefName"]?.stringValue, !branch.isEmpty else {
            throw CodedFailure.gitHub("GitHub did not say which branch \(pullRequest.owner)/\(pullRequest.repository)#\(pullRequest.number) is from.")
        }
        // A head repository GitHub cannot name is a fork that has been deleted
        // since the pull request was opened: the pull request's own repository
        // is the only remaining candidate.
        let state: PullRequestHead.State? = switch head?["state"]?.stringValue?.uppercased() {
        case "MERGED": .merged
        case "CLOSED": .closed
        case "OPEN": .open
        default: nil
        }
        return PullRequestHead(
            branch: branch,
            owner: head?["headRepository"]?["owner"]?["login"]?.stringValue ?? pullRequest.owner,
            repository: head?["headRepository"]?["name"]?.stringValue ?? pullRequest.repository,
            state: state
        )
    }

    /// The branch GitHub says an Issue is being worked on: its own "linked
    /// branches", the first one recorded. Nothing is an ordinary answer.
    public func readIssueLinkedBranch(_ issue: IssueReference, token: String) async throws -> String? {
        let answer = try await post(
            query: """
            query($owner:String!,$name:String!,$number:Int!){
              repository(owner:$owner,name:$name){ issue(number:$number){
                linkedBranches(first:10){ nodes{ ref{ name } } }
              } }
            }
            """,
            variables: [
                "owner": .string(issue.owner),
                "name": .string(issue.repository),
                "number": .number(Double(issue.number)),
            ],
            token: token
        )
        if let failed = Self.firstError(answer) { throw CodedFailure.gitHub(failed) }
        for node in answer["data"]?["repository"]?["issue"]?["linkedBranches"]?["nodes"]?.arrayValue ?? [] {
            if let name = node["ref"]?["name"]?.stringValue, !name.isEmpty { return name }
        }
        return nil
    }

    /// The Projects (v2) lanes an Issue sits in. Its own request, because a
    /// token without `read:project` makes `projectItems` an error that nulls
    /// the whole Issue. Never throws: any failure is "no badge", and a missing
    /// scope is remembered so the request is not repeated every minute.
    public func readIssueProjects(_ issue: IssueReference, token: String, at time: Double? = nil) async -> (lanes: [ProjectLane]?, unreadable: Bool) {
        let now = time ?? self.now()
        if let missing = projectScope.lastMissingAt, now - missing < ProjectScopeMemory.retryMs {
            return (nil, true)
        }
        do {
            let answer = try await post(
                query: """
                query($owner:String!,$name:String!,$number:Int!){
                  repository(owner:$owner,name:$name){ issue(number:$number){
                    \(ProjectStatus.projectItemsSelection)
                  } }
                }
                """,
                variables: [
                    "owner": .string(issue.owner),
                    "name": .string(issue.repository),
                    "number": .number(Double(issue.number)),
                ],
                token: token
            )
            let errors = answer["errors"]?.arrayValue ?? []
            let scopes = TextPattern("read:project|required scopes", options: [.caseInsensitive])
            if errors.contains(where: { $0["type"]?.stringValue == "INSUFFICIENT_SCOPES" || scopes.matches($0["message"]?.stringValue ?? "") }) {
                projectScope.lastMissingAt = now
                return (nil, true)
            }
            if !errors.isEmpty { return (nil, false) }
            projectScope.lastMissingAt = nil
            return (ProjectStatus.parseLanes(answer["data"]?["repository"]?["issue"]?["projectItems"]), false)
        } catch {
            return (nil, false)
        }
    }

    static func firstError(_ answer: JsonValue) -> String? {
        answer["errors"]?.arrayValue?.first?["message"]?.stringValue
    }

    /// One request, and every way it can fail said without the token.
    func post(query: String, variables: JsonObject, token: String) async throws -> JsonValue {
        let body = JsonValue.object(["query": .string(query), "variables": .object(variables)]).jsonText
        let answer: GitHubHTTPAnswer
        do {
            answer = try await transport.post(body: Data(body.utf8), token: token)
        } catch {
            // The reason is the network's, and it is said as it came. What
            // must not appear is the request, which carries the token.
            throw CodedFailure.gitHub(failureText(error))
        }
        if answer.status == 401 || answer.status == 403 {
            throw CodedFailure.gitHub("GitHub refused DevHub's credentials. Run `gh auth login` and try again.")
        }
        guard (200..<300).contains(answer.status) else {
            throw CodedFailure.gitHub("GitHub answered \(answer.status).")
        }
        do {
            return try JsonValue.parse(answer.body)
        } catch {
            throw CodedFailure.gitHub("GitHub answered with something that is not JSON.")
        }
    }
}
