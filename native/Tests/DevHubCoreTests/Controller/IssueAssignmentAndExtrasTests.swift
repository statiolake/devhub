// `devhub --tell issue assign`'s folder (appController.ts `assignIssueFromCli`
// up to `prepareIssueFolder`) against real git repositories, and the Core
// halves of `devhub --install-cli` and `devhub --metrics`.

import Foundation
import XCTest
@testable import DevHubCore

final class GitIssueAssignerTests: XCTestCase {
    private let git = GitTestSupport.command
    private var root = ""

    override func setUp() async throws {
        try XCTSkipUnless(GitTestSupport.hasGit, "git is not installed")
        root = try GitTestSupport.temporaryDirectory("devhub-assign-")
    }

    override func tearDown() async throws { GitTestSupport.remove(root) }

    private func repository(_ name: String, origin: Bool = true) async throws -> String {
        let path = Path.join(root, name)
        try GitTestSupport.mkdir(path)
        try await git.run(["init", "-q", "."], cwd: path)
        try await git.run(["commit", "-q", "--allow-empty", "-m", "init"], cwd: path)
        if origin { try await git.run(["remote", "add", "origin", "https://github.com/example/widget.git"], cwd: path) }
        return path
    }

    private func assigner(
        open: [WorkspacePlace] = [], branch: AssignmentBranch = AssignmentBranch(reachable: false),
        asked: Recorder<String>? = nil
    ) -> GitIssueAssigner {
        let command = git
        let root = self.root
        return GitIssueAssigner(
            gitFor: { _ in command },
            searchSources: { query in
                ((try? FileManager.default.contentsOfDirectory(atPath: root)) ?? []).sorted().filter { $0.contains(query) }
                    .map { Path.join(root, $0) }
            },
            openPlaces: { open },
            branch: { url, place, _ in
                asked?.add("\(url) \(place.path)")
                return branch
            })
    }

    private func request(_ url: String, repo: String? = nil, branch: String? = nil, place: IssuePlace = .worktree) -> IssueAssignRequest {
        IssueAssignRequest(url: url, repo: repo, branch: branch, place: place, profile: "claude", action: nil, editorOnly: false, presentation: nil)
    }

    func testRefusesSomethingThatIsNotAnIssueOrAPullRequest() async throws {
        do {
            _ = try await assigner().prepare(request("https://example.com/x"))
            XCTFail("a non-GitHub URL was assigned")
        } catch {
            XCTAssertEqual("\(error)", "That is not a GitHub Issue or pull request URL.")
        }
    }

    func testSaysItFoundNoCloneAndHowToGiveOne() async throws {
        do {
            _ = try await assigner().prepare(request("https://github.com/example/widget/issues/128"))
            XCTFail("assigned with no clone")
        } catch {
            XCTAssertEqual("\(error)", "DevHub found no clone of example/widget. Clone it, or pass --repo <path>.")
        }
    }

    func testAPullRequestWhoseHeadCannotBeReachedHasNoBranchToOpen() async throws {
        let main = try await repository("widget")
        let asked = Recorder<String>()
        do {
            _ = try await assigner(branch: AssignmentBranch(branch: "patch-1", fork: "alice/widget", reachable: false), asked: asked)
                .prepare(request("https://github.com/example/widget/pull/7"))
            XCTFail("assigned a pull request nobody can reach")
        } catch {
            XCTAssertEqual("\(error)", "the branch of https://github.com/example/widget/pull/7 cannot be reached from \(main).")
        }
        // The clone the search found is the one the branch was asked about.
        XCTAssertEqual(asked.all, ["https://github.com/example/widget/pull/7 \(main)"])
    }

    func testAnIssueNotStartedGetsItsWipBranchInAWorktreeBesideTheGivenClone() async throws {
        let main = try await repository("widget", origin: false)
        let folder = try await assigner().prepare(request("https://github.com/example/widget/issues/128", repo: main))
        XCTAssertEqual(folder, try RequestedWorkspaceLocation.make(.local(path: Path.join(root, "widget_128"))))
        let branch = try await git.readBranch(Path.join(root, "widget_128"))
        XCTAssertEqual(branch, "feature/128-wip")
    }

    func testTheBranchGivenIsCheckedOutInTheCloneItselfWhenTheRootIsAsked() async throws {
        let main = try await repository("widget", origin: false)
        let asked = Recorder<String>()
        let folder = try await assigner(asked: asked).prepare(
            request("https://github.com/example/widget/issues/9", repo: main, branch: "feature/9-tidy", place: .root))
        XCTAssertEqual(folder, try RequestedWorkspaceLocation.make(.local(path: main)))
        let branch = try await git.readBranch(main)
        XCTAssertEqual(branch, "feature/9-tidy")
        // A branch given is not asked about.
        XCTAssertEqual(asked.all, [])
    }

    func testTheGitOfAMachineIsTheResolvedOneInTheLoginEnvironmentOnlyWhenFoundHere() throws {
        let environment = ["PATH": "/opt/bin:/usr/bin"]
        let found = try ControllerGit.command(
            runtime: LocalRepositoryRuntime(), resolution: .absolutePath("/opt/bin/git"), launchEnvironment: environment, loginFailure: nil)
        XCTAssertEqual(found.git, "/opt/bin/git")
        XCTAssertEqual(found.environment, environment)
        let named = try ControllerGit.command(
            runtime: LocalRepositoryRuntime(), resolution: .commandName("git"), launchEnvironment: environment, loginFailure: nil)
        XCTAssertEqual(named.environment, [:])
        XCTAssertThrowsError(try ControllerGit.command(
            runtime: LocalRepositoryRuntime(),
            resolution: .unavailable(configured: "git", lookup: .path(directories: ["/usr/bin"]), where: nil),
            launchEnvironment: environment, loginFailure: nil)) { error in
            XCTAssertEqual((error as? NamedFailure)?.code, .workspaceUnavailable)
        }
    }
}

final class ControlExtrasNativeTests: XCTestCase {
    func testInstallsTheLauncherForTheBundlesOwnCli() async throws {
        let directory = NSTemporaryDirectory() + "devhub-install-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        var request = InstallRequest.forApp(
            appExecutable: "/Applications/DevHub.app/Contents/MacOS/DevHub",
            cliExecutable: "/Applications/DevHub.app/Contents/Resources/bin/devhub",
            socketPath: "/tmp/devhub.sock", commandName: "devhub", profile: "default", home: directory, pathValue: directory)
        request.candidates = [directory]
        let fixed = request
        let extras = ControlExtras.native(install: { fixed }, metrics: MetricsSources(startedAt: 0))
        let message = try await extras.installCli()
        XCTAssertEqual(message, "Installed the 'devhub' command at \(directory)/devhub.")
        let script = try String(contentsOfFile: directory + "/devhub", encoding: .utf8)
        XCTAssertTrue(script.contains("exec '/Applications/DevHub.app/Contents/Resources/bin/devhub' \"$@\""), script)
        XCTAssertTrue(script.contains(#"DEVHUB_LAUNCH_COMMAND='["/usr/bin/open","-a","/Applications/DevHub.app","--background"]'"#), script)
    }

    func testAMetricsReadingCarriesWhatDevHubCountedItself() async throws {
        let counters = ActivityCounters(clock: { 60_000 })
        counters.record(CounterName.agentReconcileRound)
        counters.record(CounterName.agentReconcileRound)
        let rounds = ReconcileRounds()
        rounds.record("local")
        let extras = ControlExtras.native(
            install: { InstallRequest(executable: "", socketPath: "", commandName: "devhub", profile: "", launchCommand: [], home: "", pathValue: "") },
            metrics: MetricsSources(
                startedAt: 1_000, titleBar: { "native" },
                views: { [ViewIdentity(pid: 7, id: 1, surfaceKey: "chrome:shell", onScreen: true)] },
                processMetrics: { [ProcessMetricInput(pid: 7, type: "Browser", cpuPercent: 1.5, memoryKb: 100)] },
                pendingSweeps: { ["ssh:far"] }, counters: counters, rounds: rounds, cpu: { (12, 3) }, now: { 61_000 }))
        let text = try await extras.metrics()
        let json = try JsonValue.parse(text)
        XCTAssertEqual(json["workbench"], "terminal")
        XCTAssertEqual(json["uptimeMs"], .number(60_000))
        XCTAssertEqual(json["titleBar"], "native")
        XCTAssertEqual(json["mainProcessCpu"]?["userMs"], .number(12))
        XCTAssertEqual(json["pendingSweeps"], ["ssh:far"])
        XCTAssertEqual(json["processes"]?.arrayValue?.first?["workbench"]?["surfaceKey"], "chrome:shell")
        XCTAssertEqual(json["runtimes"]?.arrayValue?.first?["roundsPerMin"], .number(1))
        let counted = json["counters"]?["counters"]?.arrayValue?.first { $0["name"] == .string(CounterName.agentReconcileRound) }
        XCTAssertEqual(counted?["total"], .number(2))
        // Pretty-printed, as `JSON.stringify(…, null, 2)` prints it.
        XCTAssertTrue(text.hasPrefix("{\n  \""), text)
    }

    func testOwnCpuTimeIsReadFromTheProcess() {
        let cpu = MetricsSources.ownCpu()
        XCTAssertGreaterThanOrEqual(cpu.userMs + cpu.systemMs, 0)
    }
}

final class GuiAgentSettingsTests: XCTestCase {
    func testReadsTheAgentsSettingsEachConversationIsHanded() {
        var config = Config.defaults
        config.agents.resumeAfterLimit = false
        config.agents.resumeAfterLimitMessage = "go on"
        config.agents.autoCompactLeadSeconds = 90
        XCTAssertEqual(GuiAgentSettings.resumeAfterLimit(config), LimitResumeSettings(enabled: false, message: "go on"))
        XCTAssertEqual(GuiAgentSettings.cacheKeeping(config).leadSeconds, 90)
        XCTAssertEqual(GuiAgentSettings.cacheKeeping(nil), CACHE_KEEP_OFF)
        XCTAssertFalse(GuiAgentSettings.resumeAfterLimit(nil).enabled)
    }
}
