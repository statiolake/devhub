// The fact and tooltip assertions of
// apps/desktop/src/shell/components/sidebar/workspaceRepository.test.tsx and
// rowTooltip.test.tsx, against the pure rowDescription.ts port.

import Foundation
import XCTest
@testable import DevHubCore

final class RowDescriptionTests: XCTestCase {
    private let pullRequest = PullRequestStatus(number: 7, url: "https://github.com/example/widget/pull/7", title: "Rework the picker", state: .open, conversations: .init(unresolved: 0, uncounted: 0))
    private let issue = IssueStatus(number: 128, title: "Tidy the picker", state: .open, url: "https://github.com/example/widget/issues/128")

    private func facts(_ facts: [RowFact]) -> [String] { facts.map(\.text) }

    func testTheIssueMarksHoverIsTheNumberAndTitleTheRepositoryAndTheBranch() {
        let repository = WorkspaceRepositoryWire(workspaceId: "w-1", branch: "feature/128-tidy", issue: issue)
        XCTAssertEqual(RowDescription.issueMarkLines(repository, issue), [
            .fact(TooltipFact(icon: .issueOpen, text: "#128 Tidy the picker")),
            .fact(TooltipFact(icon: .repository, text: "example/widget")),
            .fact(TooltipFact(icon: .branch, text: "feature/128-tidy")),
        ])
        XCTAssertEqual(RowDescription.issueLabel(issue), "Issue #128, open: Tidy the picker")
    }

    func testNamesTheRepositoryTheWorkspaceNumbersItsIssuesInOverTheURLs() {
        let odd = IssueStatus(number: 128, title: "A title", state: .open, url: "https://example.invalid/128")
        let repository = WorkspaceRepositoryWire(workspaceId: "w-1", issueRepository: IssueRepositoryName(owner: "upstream-org", repository: "widget"), issue: odd)
        XCTAssertEqual(RowDescription.issueRepositoryName(repository, odd), "upstream-org/widget")
        XCTAssertNil(RowDescription.issueRepositoryName(nil, odd))
    }

    func testCountsUnresolvedConversationsAndSaysWhatWentUncounted() {
        var withThree = pullRequest
        withThree.conversations = .init(unresolved: 3, uncounted: 0)
        XCTAssertEqual(RowDescription.markLines(RowDescription.pullRequestFacts(withThree)), [
            .fact(TooltipFact(icon: .pullRequest, text: "#7 Rework the picker")),
            .fact(TooltipFact(icon: .conversation, text: "3 unresolved conversations")),
        ])
        XCTAssertEqual(RowDescription.describe(RowDescription.pullRequestFacts(withThree)), "Pull request #7, open: Rework the picker\n3 unresolved conversations")
        XCTAssertEqual(RowDescription.unresolvedConversationsText(.init(unresolved: 1, uncounted: 0)), "1 unresolved conversation")
        XCTAssertEqual(RowDescription.unresolvedConversationsText(.init(unresolved: 4, uncounted: 150)), "4 unresolved conversations, 150 more not counted")
        XCTAssertEqual(RowDescription.unresolvedConversationsText(.init(unresolved: 0, uncounted: 150)), "0 unresolved conversations, 150 more not counted")
        XCTAssertNil(RowDescription.unresolvedConversationsText(.init(unresolved: 0, uncounted: 0)))
        XCTAssertEqual(RowDescription.markLines(RowDescription.pullRequestFacts(pullRequest)), [.fact(TooltipFact(icon: .pullRequest, text: "#7 Rework the picker"))])
        XCTAssertFalse(RowDescription.hasUnresolvedConversations(pullRequest))
        XCTAssertTrue(RowDescription.hasUnresolvedConversations(withThree))
    }

    func testSaysAPullRequestsCIAndBadgesOnlyWhatAsksSomething() {
        var failing = pullRequest
        failing.checks = CheckSummary(state: .failing, total: 12, failing: 3, pending: 0)
        XCTAssertEqual(RowDescription.checksBadge(failing), .checksFailing)
        XCTAssertEqual(RowDescription.markLines(RowDescription.pullRequestFacts(failing)).last, .fact(TooltipFact(icon: .checksFailing, text: "CI: failing (3 of 12 checks)")))
        XCTAssertEqual(RowDescription.describe(RowDescription.pullRequestFacts(failing)), "Pull request #7, open: Rework the picker\nCI: failing (3 of 12 checks)")
        XCTAssertEqual(RowDescription.checksText(CheckSummary(state: .pending, total: 12, failing: 0, pending: 4)), "CI: pending (4 of 12 checks)")
        XCTAssertEqual(RowDescription.checksText(CheckSummary(state: .passing, total: 1, failing: 0, pending: 0)), "CI: passing (1 check)")
        XCTAssertEqual(RowDescription.checksText(CheckSummary(state: .failing, total: 12, failing: 0, pending: 0)), "CI: failing")
        var passing = pullRequest
        passing.checks = CheckSummary(state: .passing, total: 1, failing: 0, pending: 0)
        XCTAssertNil(RowDescription.checksBadge(passing))
        XCTAssertNil(RowDescription.checksBadge(pullRequest))
        var both = failing
        both.conversations = .init(unresolved: 2, uncounted: 0)
        XCTAssertEqual(RowDescription.markLines(RowDescription.pullRequestFacts(both)), [
            .fact(TooltipFact(icon: .pullRequest, text: "#7 Rework the picker")),
            .fact(TooltipFact(icon: .conversation, text: "2 unresolved conversations")),
            .fact(TooltipFact(icon: .checksFailing, text: "CI: failing (3 of 12 checks)")),
        ])
    }

    func testAPullRequestWearsGitHubsOwnMarkForWhatBecameOfIt() {
        XCTAssertEqual(RowDescription.pullRequestGlyph(.open), .pullRequest)
        XCTAssertEqual(RowDescription.pullRequestGlyph(.draft), .pullRequestDraft)
        XCTAssertEqual(RowDescription.pullRequestGlyph(.closed), .pullRequestClosed)
        XCTAssertEqual(RowDescription.pullRequestGlyph(.merged), .pullRequestMerged)
    }

    func testAWorkspaceRowsFactsAreInTheOrderAPersonAsksForThem() {
        let workspace = WorkspaceRowInput(label: "widget", displayRoot: "~/projects/widget", terminals: .working, sshHost: "build.example.com", editor: .devContainer(label: "api"))
        let repository = WorkspaceRepositoryWire(
            workspaceId: "w-1", branch: "feature/128-tidy", mainWorktree: "/projects/other", worktree: "/projects/widget",
            repositoryUrl: "https://github.com/example/widget", issue: issue, pullRequest: pullRequest
        )
        let all = RowDescription.workspaceRowFacts(workspace, repository)
        XCTAssertEqual(facts(all), [
            "widget",
            "~/projects/widget",
            "A command is running in a terminal",
            "github.com/example/widget",
            "/projects/other",
            "feature/128-tidy",
            "#128 Tidy the picker",
            "#7 Rework the picker",
            "ssh:build.example.com",
            "editor in dev container: api",
        ])
        XCTAssertEqual(RowDescription.describe(all), [
            "widget workspace",
            "path ~/projects/widget",
            "terminal working",
            "repository github.com/example/widget",
            "worktree of /projects/other",
            "branch feature/128-tidy",
            "Issue #128, open: Tidy the picker",
            "Pull request #7, open: Rework the picker",
            "on build.example.com",
            "editor in the api dev container",
        ].joined(separator: "\n"))
        XCTAssertTrue(RowDescription.tooltipLines(all).contains(.fact(TooltipFact(icon: .worktree, text: "/projects/other", style: .muted))))
        XCTAssertTrue(RowDescription.tooltipLines(all).contains(.fact(TooltipFact(icon: .repository, text: "github.com/example/widget", style: .muted, href: "https://github.com/example/widget"))))
    }

    func testSaysAnEmptyCheckoutAReadingAndAReasonOnTheRow() {
        let workspace = WorkspaceRowInput(label: "fresh", displayRoot: "/projects/fresh", closeFailure: "Could not remove the worktree", terminals: .finished)
        let reading = WorkspaceRepositoryWire(workspaceId: "w-1", branch: "main", unborn: true, pending: .init(number: 9))
        let first = RowDescription.workspaceRowFacts(workspace, reading)
        XCTAssertEqual(facts(first), ["fresh", "/projects/fresh", "Could not remove the worktree", "A terminal command finished", "main · empty", "Reading #9"])
        XCTAssertEqual(first[2].spoken, "close failed: Could not remove the worktree")
        XCTAssertEqual(first[4].spoken, "branch main, no commits yet")
        let failed = WorkspaceRepositoryWire(workspaceId: "w-1", branch: "feature/128-x", unavailable: .init(number: 128, reason: "GitHub answered 502."))
        let last = RowDescription.workspaceRowFacts(WorkspaceRowInput(label: "w", displayRoot: "/w"), failed).last
        XCTAssertEqual(last, RowFact(icon: .statusError, text: "#128 · GitHub answered 502.", style: .danger))
        XCTAssertEqual(RowDescription.unavailableText(.init(reason: "no git")), "no git")
    }

    func testCarriesTheProjectsLineOrTheScopeHint() {
        var onBoards = issue
        onBoards.projects = [ProjectLane(project: "DevHub Roadmap", status: "In Review")]
        XCTAssertEqual(RowDescription.issueProjectLine(onBoards), "Projects: DevHub Roadmap — In Review")
        var unreadable = issue
        unreadable.projectsUnreadable = true
        XCTAssertEqual(RowDescription.issueProjectLine(unreadable), ProjectStatus.scopeHint)
        XCTAssertNil(RowDescription.issueProjectLine(issue))
    }

    func testScratchWearsTheTerminalAndIsFixed() {
        XCTAssertTrue(RowDescription.rowIdentity(workspaceId: "s", scratchWorkspaceId: "s", remote: false) == (.terminal, true))
        XCTAssertTrue(RowDescription.rowIdentity(workspaceId: "w", scratchWorkspaceId: "s", remote: true) == (.remote, false))
        XCTAssertTrue(RowDescription.rowIdentity(workspaceId: "w", scratchWorkspaceId: "s", remote: false) == (.folder, false))
        XCTAssertNil(RowDescription.editorAttachmentFact(.host))
        XCTAssertEqual(RowDescription.editorAttachmentFact(.devContainer(label: nil))?.text, "editor in dev container")
    }

    func testAnAgentsFactsSayItsStatusUnreadIncluded() {
        let idle = AgentRowInput(displayName: "Claude", status: .idle, unread: .working, activity: "Refactoring", note: "Runtime unavailable")
        let all = RowDescription.agentRowFacts(idle, owner: (label: "widget", icon: .folder))
        XCTAssertEqual(all, [
            RowFact(text: "Claude", style: .name),
            RowFact(icon: .statusUnread, text: "Idle · unread", spoken: "Idle agent, unread", tone: .working),
            RowFact(text: "Refactoring", style: .muted),
            RowFact(text: "Runtime unavailable", style: .note),
            RowFact(icon: .folder, text: "widget", style: .muted),
        ])
        // Background is not idle: the unread mark waits until it comes to rest.
        let background = AgentRowInput(displayName: "Codex", status: .background, unread: .working)
        XCTAssertEqual(RowDescription.agentRowFacts(background)[1], RowFact(icon: .statusBackground, text: "Background", spoken: "Background agent", tone: .background))
        XCTAssertEqual(RowDescription.agentTooltipFacts(idle), [RowFact(icon: .statusUnread, text: "Refactoring", tone: .working)])
        XCTAssertEqual(RowDescription.agentTooltipFacts(background), [RowFact(icon: .statusBackground, text: "Codex", tone: .background)])
        XCTAssertEqual(RowDescription.agentRowDescription(background), "Codex\nBackground agent")
    }

    func testAnAgentsNoteSaysWhatStoppedFirst() {
        XCTAssertEqual(RowDescription.agentNote(stopping: true, stopFailed: "x", failure: "y", runtimeHealth: .failed), "Stopping")
        XCTAssertEqual(RowDescription.agentNote(stopping: false, stopFailed: "The Agent would not stop.", failure: "y", runtimeHealth: .failed), "The Agent would not stop.")
        XCTAssertEqual(RowDescription.agentNote(stopping: false, stopFailed: nil, failure: "It exited.", runtimeHealth: .failed), "It exited.")
        XCTAssertEqual(RowDescription.agentNote(stopping: false, stopFailed: nil, failure: nil, runtimeHealth: .starting), "Starting runtime")
        XCTAssertEqual(RowDescription.agentNote(stopping: false, stopFailed: nil, failure: nil, runtimeHealth: .degraded), "Runtime needs attention")
        XCTAssertNil(RowDescription.agentNote(stopping: false, stopFailed: nil, failure: nil, runtimeHealth: .healthy))
    }
}
