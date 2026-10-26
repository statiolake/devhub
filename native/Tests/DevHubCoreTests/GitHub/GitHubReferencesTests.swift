// Port of apps/desktop/src/model/github.test.ts, model/projectStatus.test.ts,
// model/projects.test.ts, main/shell/projects.test.ts and the remote identity
// cases of model/domain.test.ts.

import Foundation
import XCTest
@testable import DevHubCore

final class GitHubReferencesTests: XCTestCase {
    // MARK: an Issue or pull request URL

    func testReadsWhichOfTheTwoAURLNames() {
        XCTAssertEqual(
            GitHubItem.parse(url: "https://github.com/example/widget/issues/128"),
            GitHubItem(owner: "example", repository: "widget", number: 128, kind: .issue)
        )
        XCTAssertEqual(
            GitHubItem.parse(url: "https://github.com/example/widget/pull/128"),
            GitHubItem(owner: "example", repository: "widget", number: 128, kind: .pull)
        )
    }

    func testIsNotReadAsAnIssueWhenItIsAPullRequest() {
        XCTAssertNil(IssueReference.parse(url: "https://github.com/example/widget/pull/128"))
    }

    func testWritesBackTheURLItCameFrom() {
        for url in ["https://github.com/example/widget/issues/128", "https://github.com/example/widget/pull/128"] {
            XCTAssertEqual(GitHubItem.parse(url: url)?.url, url)
        }
    }

    func testAnIssueURLIsReadAsOwnerRepositoryAndNumber() {
        XCTAssertEqual(IssueReference.parse(url: "https://github.com/example/widget/issues/128"), IssueReference(owner: "example", repository: "widget", number: 128))
    }

    func testSurvivesWhatABrowserAddsToIt() {
        XCTAssertEqual(
            IssueReference.parse(url: "  https://github.com/example/widget/issues/128#issuecomment-9  "),
            IssueReference(owner: "example", repository: "widget", number: 128)
        )
    }

    func testIsNotSomeOtherHostWearingTheSamePath() {
        XCTAssertNil(IssueReference.parse(url: "https://github.example.com/example/widget/issues/128"))
    }

    func testRoundTripsThroughTheReferenceDevHubKeeps() {
        let url = "https://github.com/example/widget/issues/128"
        XCTAssertEqual(IssueReference.parse(url: url)?.url, url)
    }

    // MARK: the branch naming convention

    func testStartsAnIssueOnABranchThatSaysTheWorkIsNotNamedYet() {
        XCTAssertEqual(GitHubBranchNaming.wipBranch(forIssue: 128), "feature/128-wip")
        XCTAssertEqual(GitHubBranchNaming.issueNumber(fromBranch: GitHubBranchNaming.wipBranch(forIssue: 128)), 128)
    }

    func testRecognisesAnIssueInABranchMadeOutsideDevHub() {
        XCTAssertEqual(GitHubBranchNaming.issueNumber(fromBranch: "feature/128-tidy-the-picker"), 128)
        XCTAssertEqual(GitHubBranchNaming.issueNumber(fromBranch: "fix/9-crash"), 9)
    }

    func testReadsAPrefixThatIsSeveralSegmentsDeep() {
        XCTAssertEqual(GitHubBranchNaming.issueNumber(fromBranch: "alice/fix/128-crash"), 128)
        XCTAssertEqual(GitHubBranchNaming.issueNumber(fromBranch: "team/alice/feature/9-thing"), 9)
        XCTAssertEqual(GitHubBranchNaming.issueNumber(fromBranch: "step/feature/#1234-issue-body"), 1234)
    }

    func testReadsTheNumberWhetherOrNotItIsWrittenAsAnIssue() {
        XCTAssertEqual(GitHubBranchNaming.issueNumber(fromBranch: "feature/#128-tidy-the-picker"), 128)
        XCTAssertEqual(GitHubBranchNaming.issueNumber(fromBranch: "alice/fix/#9-crash"), 9)
    }

    func testReadsANameThatStartsAtTheSlash() {
        XCTAssertEqual(GitHubBranchNaming.issueNumber(fromBranch: "/128-tidy"), 128)
        XCTAssertEqual(GitHubBranchNaming.issueNumber(fromBranch: "/#128-tidy"), 128)
    }

    func testReadsTheSigilWhereverAPersonPutIt() {
        XCTAssertEqual(GitHubBranchNaming.issueNumber(fromBranch: "feature/#1234"), 1234)
        XCTAssertEqual(GitHubBranchNaming.issueNumber(fromBranch: "step/feature/#1234"), 1234)
        XCTAssertEqual(GitHubBranchNaming.issueNumber(fromBranch: "feature/fix-#1234-crash"), 1234)
        XCTAssertEqual(GitHubBranchNaming.issueNumber(fromBranch: "#1234"), 1234)
    }

    func testDoesNotReadABareNumberThatIsNotTheConvention() {
        for branch in ["feature/tidy-128", "128-tidy", "feature/128", "v2-rewrite", "release/2024"] {
            XCTAssertNil(GitHubBranchNaming.issueNumber(fromBranch: branch), branch)
        }
    }

    // MARK: remote identity (model/domain.test.ts)

    func testNormalisesHTTPSAndSSHAliasesWithoutCredentials() throws {
        let https = try RemoteIdentity.parse("https://USER:secret@GitHub.com/Owner/Repo.git")
        let ssh = try RemoteIdentity.parse("git@github.com:owner/repo.git")
        let scp = try RemoteIdentity.parse("alice@github.com:OWNER/Repo.git")
        XCTAssertEqual(https.rawValue, "github.com/owner/repo")
        XCTAssertEqual(ssh, https)
        XCTAssertEqual(scp, ssh)
    }

    func testDropsOnlyTheSchemesOwnDefaultPort() throws {
        XCTAssertEqual(try RemoteIdentity.parse("https://github.com:443/OWNER/Repo.git").rawValue, "github.com/owner/repo")
        XCTAssertEqual(try RemoteIdentity.parse("https://github.com:8443/OWNER/Repo.git").rawValue, "github.com:8443/owner/repo")
        XCTAssertEqual(try RemoteIdentity.parse("http://code.example:80/Owner/Repo"), try RemoteIdentity.parse("http://code.example/Owner/Repo"))
        XCTAssertEqual(try RemoteIdentity.parse("ssh://git@code.example:22/Owner/Repo"), try RemoteIdentity.parse("ssh://git@code.example/Owner/Repo"))
        XCTAssertEqual(try RemoteIdentity.parse("ssh://git@code.example:2222/Owner/Repo").rawValue, "code.example:2222/Owner/Repo")
    }

    func testKeepsNonGitHubPathsCaseSensitiveAndRejectsTraversal() throws {
        XCTAssertEqual(try RemoteIdentity.parse("https://code.example/Owner/Repo.git").rawValue, "code.example/Owner/Repo")
        XCTAssertThrowsError(try RemoteIdentity.parse("https://code.example/owner/../repo"))
        XCTAssertThrowsError(try RemoteIdentity.parse(""))
        XCTAssertThrowsError(try RemoteIdentity.parse("no-slash-or-colon"))
        XCTAssertThrowsError(try RemoteIdentity.parse("ftp://code.example/owner/repo"))
        XCTAssertEqual(try RemoteIdentity.parse("github.com/Example/Widget").rawValue, "github.com/example/widget")
    }

    // MARK: Projects lanes (model/projectStatus.test.ts)

    func testStatusLetterTakesTheFirstLetterOfTheLastWord() {
        XCTAssertEqual(ProjectStatus.statusLetter("Todo"), "T")
        XCTAssertEqual(ProjectStatus.statusLetter("In Progress"), "P")
        XCTAssertEqual(ProjectStatus.statusLetter("In Review"), "R")
        XCTAssertEqual(ProjectStatus.statusLetter("done"), "D")
    }

    func testStatusLetterSkipsEmojiAndPunctuation() {
        XCTAssertEqual(ProjectStatus.statusLetter("🚧 In Progress"), "P")
        XCTAssertEqual(ProjectStatus.statusLetter("✅ Done!"), "D")
        XCTAssertEqual(ProjectStatus.statusLetter("(Blocked) - waiting..."), "W")
        XCTAssertNil(ProjectStatus.statusLetter("🎉"))
    }

    func testStatusLetterTakesTheFirstCharacterOfAJapaneseName() {
        XCTAssertEqual(ProjectStatus.statusLetter("進行中"), "進")
        XCTAssertEqual(ProjectStatus.statusLetter("レビュー待ち"), "レ")
        XCTAssertEqual(ProjectStatus.statusLetter("対応中 レビュー"), "レ")
    }

    func testStatusLetterHasNoLetterForNothing() {
        XCTAssertNil(ProjectStatus.statusLetter(nil))
        XCTAssertNil(ProjectStatus.statusLetter("  "))
    }

    func testParseLanesReadsBoardsStatusesAndColours() throws {
        let items = try JsonValue.parse("""
        {"nodes":[
          {"project":{"title":"DevHub Roadmap"},"fieldValueByName":{"name":"In Review","color":"yellow"}},
          {"project":{"title":"Triage"},"fieldValueByName":{}},
          {"project":null},
          null
        ]}
        """)
        XCTAssertEqual(ProjectStatus.parseLanes(items), [
            ProjectLane(project: "DevHub Roadmap", status: "In Review", color: "YELLOW"),
            ProjectLane(project: "Triage"),
        ])
    }

    func testParseLanesIsEmptyForNothing() throws {
        XCTAssertEqual(ProjectStatus.parseLanes(nil), [])
        XCTAssertEqual(ProjectStatus.parseLanes(try JsonValue.parse(#"{"nodes":null}"#)), [])
    }

    func testPrimaryLanePrefersTheBoardNamedLikeTheRepositoryElseTheFirstWithAStatus() {
        let lanes = [ProjectLane(project: "Triage"), ProjectLane(project: "Other", status: "Todo"), ProjectLane(project: "widget", status: "Done")]
        XCTAssertEqual(ProjectStatus.primaryLane(lanes, repository: "Widget")?.status, "Done")
        XCTAssertEqual(ProjectStatus.primaryLane(lanes)?.project, "Other")
        XCTAssertNil(ProjectStatus.primaryLane([ProjectLane(project: "Triage")]))
    }

    func testProjectsTooltipListsEveryBoardWithItsLane() {
        XCTAssertEqual(
            ProjectStatus.tooltip([ProjectLane(project: "DevHub Roadmap", status: "In Review"), ProjectLane(project: "Triage")]),
            "Projects: DevHub Roadmap — In Review; Triage"
        )
    }

    func testLaneColorTokenMapsKnownColoursAndLeavesTheRestMuted() {
        XCTAssertEqual(ProjectStatus.laneColorToken("GREEN"), "--status-idle")
        XCTAssertNil(ProjectStatus.laneColorToken("GRAY"))
        XCTAssertNil(ProjectStatus.laneColorToken(nil))
    }

    // MARK: the name a clone lands under (model/projects.test.ts)

    func testIsTheLastComponentWithoutDotGit() {
        XCTAssertEqual(Projects.cloneDirectoryName("https://github.com/owner/repo.git"), "repo")
        XCTAssertEqual(Projects.cloneDirectoryName("https://github.com/owner/repo"), "repo")
    }

    func testReadsAnScpStyleRemote() {
        XCTAssertEqual(Projects.cloneDirectoryName("git@github.com:owner/repo.git"), "repo")
    }

    func testIgnoresTrailingSlashesAndAQuery() {
        XCTAssertEqual(Projects.cloneDirectoryName("https://example.com/owner/repo/"), "repo")
        XCTAssertEqual(Projects.cloneDirectoryName("https://example.com/o/repo.git?ref=x"), "repo")
    }

    func testAnswersWithNothingWhenThereIsNoNameToTake() {
        XCTAssertNil(Projects.cloneDirectoryName(""))
        XCTAssertNil(Projects.cloneDirectoryName("   "))
        XCTAssertNil(Projects.cloneDirectoryName("https://example.com/../"))
    }

    func testFolderNameIsTheLastSegmentOfAPath() {
        XCTAssertEqual(Projects.folderName("/projects/widget_128-wip"), "widget_128-wip")
        XCTAssertEqual(Projects.folderName("/projects/widget/"), "widget")
        XCTAssertEqual(Projects.folderName("widget"), "widget")
        XCTAssertEqual(Projects.folderName("/"), "/")
    }

    func testJoinsWithoutDoublingTheSeparatorAndLeavesAPathAlone() {
        XCTAssertEqual(Projects.joinPath("/a/b", "repo"), "/a/b/repo")
        XCTAssertEqual(Projects.joinPath("/a/b/", "repo"), "/a/b/repo")
        XCTAssertEqual(Projects.joinPath("/a/b", "/tmp/thing"), "/tmp/thing")
        XCTAssertEqual(Projects.joinPath("/a/b", "~/thing"), "~/thing")
    }

    // MARK: what a typed repository means

    private let signedIn = GitHubLogin.known("octocat")

    func testTakesABareNameAsThisPersonsOwnRepository() {
        XCTAssertEqual(Projects.cloneTarget("devhub", login: signedIn), .clone(url: "https://github.com/octocat/devhub.git", name: "devhub"))
    }

    func testTakesOneSlashAsOwnerAndRepositoryOnGitHub() {
        XCTAssertEqual(Projects.cloneTarget("example/widget", login: signedIn), .clone(url: "https://github.com/example/widget.git", name: "widget"))
        XCTAssertEqual(Projects.cloneTarget("example/widget.git", login: signedIn), .clone(url: "https://github.com/example/widget.git", name: "widget"))
    }

    func testClonesAURLExactlyAsItWasGiven() {
        for (url, name) in [
            ("https://gitlab.example/group/thing.git", "thing"),
            ("ssh://git@example.com:2222/owner/thing", "thing"),
            ("git@github.com:example/widget.git", "widget"),
        ] {
            XCTAssertEqual(Projects.cloneTarget(url, login: signedIn), .clone(url: url, name: name))
        }
    }

    func testSaysWhoItWouldHaveToBeRatherThanCloningNobodysRepository() {
        guard case .unreadable(let reason) = Projects.cloneTarget("devhub", login: .unknown(reason: "there is no `gh` on DevHub's PATH")) else {
            return XCTFail("cloned without an owner")
        }
        XCTAssertTrue(reason.contains("there is no `gh` on DevHub's PATH"))
        XCTAssertTrue(reason.contains("owner/devhub"))
    }

    func testWaitsRatherThanGuessingWhileTheLoginIsStillBeingRead() {
        guard case .unreadable = Projects.cloneTarget("devhub", login: .pending) else { return XCTFail("guessed") }
    }

    func testRefusesWhatIsNeitherANameNorAURL() {
        for typed in ["", "   ", "a/b/c", "../escape"] {
            guard case .unreadable = Projects.cloneTarget(typed, login: signedIn) else { return XCTFail(typed) }
        }
    }

    // MARK: where a new project goes (main/shell/projects.test.ts)

    private let home = "/home/tester"

    private func config(_ directory: String?, sources: [WorkspaceSource]? = nil) -> Config {
        var config = Config.defaults
        config.workspaceSources = sources ?? [.filesystem(FilesystemSource(id: "code", path: "/srv/code", minDepth: 1, maxDepth: 1))]
        config.projects = ProjectsConfig(directory: directory)
        return config
    }

    func testIsTheSettingWhenItIsSetOverTheFirstFolderSource() {
        XCTAssertEqual(Projects.defaultProjectDirectory(config("/srv/new"), home: home), "/srv/new")
    }

    func testExpandsTildeInTheSettingAndDoesNotKeepATrailingSlash() {
        XCTAssertEqual(Projects.defaultProjectDirectory(config("~/dev/new/"), home: home), "/home/tester/dev/new")
        XCTAssertEqual(Projects.defaultProjectDirectory(config("~"), home: home), home)
    }

    func testIsTheFirstFolderSourceThenHomeWhenTheSettingIsUnset() {
        XCTAssertEqual(Projects.defaultProjectDirectory(config(nil), home: home), "/srv/code")
        XCTAssertEqual(Projects.defaultProjectDirectory(config(nil, sources: []), home: home), home)
        XCTAssertEqual(Projects.defaultProjectDirectory(nil, home: home), home)
    }

    func testCloneChoicesStartWithTheSettingFollowedByTheDerivedParents() {
        let derived = ["/srv/code", "/srv/work"]
        XCTAssertEqual(Projects.cloneParentChoices(config("/srv/new"), derived: derived, home: home), ["/srv/new", "/srv/code", "/srv/work"])
        XCTAssertEqual(Projects.cloneParentChoices(config("/srv/work/"), derived: derived, home: home), ["/srv/work", "/srv/code"])
        XCTAssertEqual(Projects.cloneParentChoices(config("/srv/new"), derived: [], home: home), ["/srv/new"])
    }

    func testCloneChoicesAreUnchangedWhenTheSettingIsUnset() {
        let derived = ["/srv/code", "/srv/work"]
        XCTAssertEqual(Projects.cloneParentChoices(config(nil), derived: derived, home: home), derived)
        XCTAssertEqual(Projects.cloneParentChoices(config(nil), derived: [], home: home), ["/srv/code"])
        XCTAssertEqual(Projects.cloneParentChoices(nil, derived: [], home: home), [home])
    }

    // MARK: making a project and cloning one

    func testCreatesAProjectAndRefusesOneThatIsAlreadyThere() throws {
        let parent = try GitTestSupport.temporaryDirectory("devhub-project-")
        defer { GitTestSupport.remove(parent) }
        let made = try Projects.createProject(Path.join(parent, "fresh"), home: home)
        XCTAssertTrue(GitTestSupport.isDirectory(made))
        XCTAssertThrowsError(try Projects.createProject(made, home: home)) { error in
            XCTAssertEqual(failureText(error), "\(made) already exists.")
        }
        XCTAssertThrowsError(try Projects.createProject("relative/path", home: home)) { error in
            XCTAssertEqual(failureText(error), "A folder needs a full path; relative/path is not one.")
        }
        XCTAssertThrowsError(try Projects.createProject("  ", home: home)) { error in
            XCTAssertEqual(failureText(error), "Enter a path for the folder.")
        }
        // Today's workspace is the same folder whether or not anything made it.
        XCTAssertEqual(try Projects.ensureWorkspaceFolder(made, home: home), made)
    }

    func testClonesIntoTheParentUnderTheNameTheSheetShowed() async throws {
        try XCTSkipUnless(GitTestSupport.hasGit, "git is not installed")
        let parent = try GitTestSupport.temporaryDirectory("devhub-clone-")
        defer { GitTestSupport.remove(parent) }
        let command = GitTestSupport.command
        let origin = Path.join(parent, "origin", "widget.git")
        try GitTestSupport.mkdir(origin)
        try await command.run(["init", "--bare", "-q", origin])
        let target = try await Projects.cloneProject(url: origin, parentDirectory: Path.join(parent, "clones"), command: command, home: home)
        XCTAssertEqual(target, Path.join(parent, "clones", "widget"))
        XCTAssertTrue(GitTestSupport.isDirectory(Path.join(target, ".git")))
        await GitTestSupport.assertRejects(
            try await Projects.cloneProject(url: origin, parentDirectory: Path.join(parent, "clones"), command: command, home: home),
            matching: "already exists"
        )
        await GitTestSupport.assertRejects(
            try await Projects.cloneProject(url: "  ", parentDirectory: parent, command: command, home: home),
            matching: "does not look like a repository URL"
        )
    }
}
