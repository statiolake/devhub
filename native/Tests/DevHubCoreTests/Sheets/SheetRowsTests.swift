// Ports the row and wording cases of apps/desktop/src/shell/picker/*.test.tsx
// (issueAssignment, closeConfirmation, worktreeClose, agentPickerSheet,
// agentRename) and components/shell/sessionRows.
import XCTest
@testable import DevHubCore

final class SheetRowsTests: XCTestCase {
    let issue = GitHubItem.parse(url: "https://github.com/example/widget/issues/128")!
    let pull = GitHubItem.parse(url: "https://github.com/example/widget/pull/130")!
    let root = "/projects/widget"
    let wip = "feature/128-wip"

    func rows(_ plan: AssignmentBranch, item: GitHubItem? = nil) -> [PickerItem] {
        IssueFlow.folderRows(plan, root: root, item: item ?? issue, wip: wip)
    }

    func testSaysWhatEachBranchRowDoesAndWhere() {
        let found = rows(AssignmentBranch(branch: "alice/fix-the-crash", reachable: true))
        XCTAssertEqual(found.map(\.label), [
            "Open alice/fix-the-crash in a new worktree", "Create feature/128-wip in a new worktree",
            "Open alice/fix-the-crash in the root checkout", "Create feature/128-wip in the root checkout",
            "Open the root checkout as it is",
        ])
        XCTAssertEqual(found.map { $0.detail?.plain }, [
            "Checks out the existing branch in ../widget_128", "New branch from the default branch, in ../widget_128",
            "Switches /projects/widget to the existing branch",
            "New branch from the default branch, switched to in /projects/widget", "No branch change in /projects/widget",
        ])
    }

    func testNamesAPullRequestsWorktreeByTheIssueItsBranchIsFor() {
        let found = rows(AssignmentBranch(branch: "feature/128-short-name", reachable: true), item: pull)
        XCTAssertEqual(found.first?.detail?.plain, "Checks out the existing branch in ../widget_128")
        // A pull request's branch is its head: no new branch is offered.
        XCTAssertFalse(found.contains { $0.label.hasPrefix("Create") })
    }

    func testNamesAnExistingWorktreeByItsFolderAndOffersNoSecondRow() {
        let found = rows(AssignmentBranch(branch: wip, reachable: true, checkedOutAt: "/projects/widget_feature_128-wip"))
        XCTAssertEqual(found.map(\.label), ["Open feature/128-wip in its worktree", "Open the root checkout as it is"])
        XCTAssertEqual(found.first?.detail?.plain, "Already checked out in ../widget_feature_128-wip")
    }

    func testOffersTheRootCheckoutOnceWhenTheBranchIsCheckedOutThere() {
        let found = rows(AssignmentBranch(branch: "feature/128-tidy", reachable: true, checkedOutAt: root))
        XCTAssertEqual(found.map(\.label), [
            "Create feature/128-wip in a new worktree", "Open feature/128-tidy in the root checkout",
            "Create feature/128-wip in the root checkout",
        ])
    }

    func testAnIssueWithNoBranchIsOfferedANewOne() {
        XCTAssertEqual(rows(AssignmentBranch(reachable: false)).map(\.label), [
            "Create feature/128-wip in a new worktree", "Create feature/128-wip in the root checkout", "Open the root checkout as it is",
        ])
    }

    func testSaysWhyAPullRequestsHeadCannotBeHad() {
        XCTAssertEqual(
            IssueFlow.unreachableHead(pull, AssignmentBranch(branch: "fix", fork: "alice/widget", reachable: false)),
            "fix is in alice/widget, which this clone has no remote for, so example/widget#130 cannot be checked out here.")
        XCTAssertEqual(
            IssueFlow.unreachableHead(pull, AssignmentBranch(branch: "fix", reachable: false, pullRequestState: .merged)),
            "example/widget#130 is a merged pull request, and its branch fix no longer exists.")
        XCTAssertEqual(IssueFlow.worktreeCount(1), "No worktrees")
        XCTAssertEqual(IssueFlow.worktreeCount(2), "1 worktree")
        XCTAssertEqual(IssueFlow.worktreeCount(4), "3 worktrees")
        XCTAssertEqual(IssueFlow.besideRoot(root, "/elsewhere/widget_128"), "/elsewhere/widget_128")
    }

    // MARK: The close confirmation

    func inspection(_ inputs: CloseInspectionInputs = .clean) -> CloseInspectionProjection {
        CloseInspectionProjection(workspaceId: WorkspaceId(unchecked: "w"), workspaceLabel: "widget", inputs: inputs)
    }

    func testAStopOffersCancelFirstAndTheStopSecond() {
        let prompt = SheetRows.closeConfirmation(.agentStop(AgentId(unchecked: "a"), terminal: false), agentName: "Claude")
        let state = PickerState(prompt)
        XCTAssertEqual(state.rows.map(\.label), ["Cancel", "Stop the Agent"])
        XCTAssertEqual(prompt.title, "Stop “Claude”?")
        XCTAssertEqual(state.rows.first?.detail?.plain, "Leave the Agent running.")
    }

    func testWithATerminalOpenItOffersToMoveItOrCloseIt() {
        let prompt = SheetRows.closeConfirmation(.agentStop(AgentId(unchecked: "a"), terminal: true), agentName: nil)
        XCTAssertEqual(PickerState(prompt).rows.map(\.label), [
            "Cancel", "Move the terminal to the editor", "Stop, and close the terminal",
        ])
        XCTAssertEqual(prompt.title, "Stop this Agent?")
    }

    func testAWorkspaceCloseKeepsOnlyTheDiagnosticsThatAreNotClean() {
        let purpose = ConfirmationOutcomePurpose.workspaceClose(
            inspection: inspection(CloseInspectionInputs(
                agents: .busy(count: 2), terminalProcesses: .unknown(diagnostic: .closeTerminalUnknown, reason: nil),
                terminalPanes: .unknown(diagnostic: .closeTerminalUnknown, reason: nil),
                terminalWindows: .unknown(diagnostic: .closeTerminalUnknown, reason: nil),
                unsavedEditors: .unsaved(tabs: ["a", "b", "c", "d", "e", "f", "g"]))),
            worktree: .remove)
        XCTAssertEqual(SheetRows.closeDiagnostics(purpose), [
            PickerFact("Agents", "2 busy"),
            PickerFact("Terminal processes, Terminal panes, Terminal windows", "Could not verify terminal state"),
            PickerFact("Unsaved files", "a, b, c, d, e, and 2 more"),
            PickerFact("Worktree", "The folder is removed from disk"),
        ])
        let words = SheetRows.confirmationWords(purpose, agentName: nil)
        XCTAssertEqual(words.title, "Close “widget”?")
        XCTAssertEqual(words.confirmDetail, "Everything listed below is closed with it. Unsaved changes are discarded.")
        let clean = ConfirmationOutcomePurpose.workspaceClose(inspection: inspection(), worktree: .keep)
        XCTAssertEqual(SheetRows.closeDiagnostics(clean), [])
        XCTAssertEqual(SheetRows.confirmationWords(clean, agentName: nil).confirmDetail, "Everything listed below is closed with it.")
    }

    func testContinueAndRestartNameTheAgentAndWhereItGoesOn() {
        let tui = SheetRows.confirmationWords(.agentContinue(AgentId(unchecked: "a"), presentation: .tui), agentName: "Claude")
        XCTAssertEqual(tui.title, "Continue “Claude” in a terminal?")
        XCTAssertEqual(tui.confirm, "Continue in terminal")
        let gui = SheetRows.confirmationWords(.agentContinue(AgentId(unchecked: "a"), presentation: .gui), agentName: nil)
        XCTAssertEqual(gui.title, "Continue this Agent in the GUI?")
        let restart = SheetRows.confirmationWords(.agentRestart(AgentId(unchecked: "a")), agentName: "Claude")
        XCTAssertEqual(restart.title, "Restart the session of “Claude”?")
        XCTAssertEqual(restart.confirm, "Restart Session")
    }

    func testTheWorktreeQuestionHasThreeAnswersWithCancelFirst() {
        let dirty = SheetRows.worktreeClose(label: "widget_128", root: "/p/widget_128", branch: "feature/128-wip", dirty: true)
        XCTAssertEqual(PickerState(dirty).rows.map(\.label), ["Cancel", "Just close the workspace", "Delete the worktree"])
        XCTAssertEqual(dirty.items[1].detail?.plain, "Remove /p/widget_128 and everything uncommitted on feature/128-wip.")
        let unknown = SheetRows.worktreeClose(label: "w", root: "/w", branch: nil, dirty: nil)
        XCTAssertTrue(unknown.question.contains("could not tell"))
    }

    // MARK: New Agent

    let claude = SheetProfile(id: "claude", displayName: "Claude", kind: .claude, presentation: .gui, presentations: [.tui, .gui])
    let custom = SheetProfile(id: "mine", displayName: "Mine", kind: .custom, presentation: .tui, presentations: [.tui])

    func testNewRowsComeFirstAndSessionsNewestFirstEachOnce() {
        let now = 10_000_000_000.0
        let older = PastSession(id: "s1", title: "Older", updatedAt: now - 2 * 3_600_000, cwd: "/w", branch: "main", resumableHere: true)
        let newer = PastSession(id: "s2", title: "Newer", updatedAt: now - 60_000, cwd: "/w", resumableHere: true)
        let second = SheetProfile(id: "claude2", displayName: "Claude Opus", kind: .claude, presentation: .tui, presentations: [.tui, .gui])
        let rows = SheetRows.agentRows(
            [claude, second, custom], listings: ["claude": .listed([older, newer]), "claude2": .listed([newer])], openEditor: true,
            now: now)
        XCTAssertEqual(rows.items.map(\.label), [
            "New Claude Session", "New Claude Opus Session", "New Mine Session", "Just open the editor",
            "Claude Session: Newer", "Claude Session: Older",
        ])
        XCTAssertNil(rows.items[0].detail)
        XCTAssertEqual(rows.items[1].detail?.plain, "Claude")
        XCTAssertEqual(rows.items[2].detail?.plain, "Other — no status detection")
        XCTAssertEqual(rows.items[5].detail?.plain, "2 hours ago · main")
        XCTAssertEqual(rows.sessionCount, 2)
        XCTAssertEqual(rows.items[0].accessory?.text(alternate: false), "GUI")
        XCTAssertEqual(rows.items[0].accessory?.text(alternate: true), "TUI")
        XCTAssertEqual(rows.items[2].accessory?.text(alternate: true), "TUI")
        XCTAssertEqual(rows.targets["session:claude:s2"]?.session?.id, "s2")
    }

    func testAListingStillBeingReadEndsInAQuietRowAndAFailedOneSaysWhy() {
        let rows = SheetRows.agentRows([claude, custom], listings: ["claude": .reading], openEditor: false, now: 0)
        XCTAssertEqual(rows.items.last?.unavailable, "Reading…")
        let failed = SheetRows.agentRows([claude], listings: ["claude": .failed("no claude")], openEditor: false, now: 0)
        XCTAssertEqual(failed.refusals, ["no claude"])
        let prompt = SheetRows.agentPicker(
            title: "New Agent", question: SheetRows.folderAgentQuestion, step: nil, hint: SheetRows.folderAgentHint, failure: nil,
            rows: failed, availability: .ready)
        XCTAssertTrue(prompt.noteIsFailure)
        XCTAssertEqual(prompt.note, "no claude\n\(SheetRows.folderAgentHint)")
    }

    func testRelativeTimeReadsTheWayIntlDoes() {
        let now = 1_000_000_000_000.0
        XCTAssertEqual(SheetRows.relativeTime(now - 10_000, now: now), "just now")
        XCTAssertEqual(SheetRows.relativeTime(now - 60_000, now: now), "1 minute ago")
        XCTAssertEqual(SheetRows.relativeTime(now - 3 * 3_600_000, now: now), "3 hours ago")
        XCTAssertEqual(SheetRows.relativeTime(now - 24 * 3_600_000, now: now), "yesterday")
        XCTAssertEqual(SheetRows.relativeTime(now - 9 * 24 * 3_600_000, now: now), "last week")
        XCTAssertEqual(SheetRows.relativeTime(now - 400 * 24 * 3_600_000, now: now), "last year")
        XCTAssertEqual(SheetRows.relativeTime(now - 3 * 24 * 3_600_000, now: now), "3 days ago")
    }

    // MARK: The rest

    func testGoToListsEveryWorkspaceAndItsAgentsAndKnowsWhereARowGoes() {
        XCTAssertEqual(SheetRows.tabTarget(PickerChoice(id: "agent:a1", split: true)), .selectContext(.agent("a1"), split: true))
        XCTAssertEqual(SheetRows.tabTarget(PickerChoice(id: "workspace:w1", split: true)), .selectContext(.workspace("w1")))
        XCTAssertNil(SheetRows.tabTarget(PickerChoice(id: "nonsense")))
        let empty = SheetRows.tabPicker(nil)
        XCTAssertEqual(empty.items, [])
        XCTAssertEqual(empty.note, "⌥Return opens an agent beside its editor.")
    }

    func testRenameRefusesANameOfOnlySpaces() {
        XCTAssertEqual(SheetRows.renamed("  Reviewer "), .success("Reviewer"))
        XCTAssertEqual(SheetRows.renamed("   "), .failure(UserFacingFailure("A name cannot be only spaces.")))
        let prompt = SheetRows.rename(current: "Claude", failure: nil)
        XCTAssertEqual(prompt.initialQuery, "Claude")
        XCTAssertTrue(prompt.pinned[0].needsQuery)
    }

    func testThePaletteSaysWhatWasUsedLatelyAndItsKeys() {
        let rows = [
            CommandPaletteRow(commandId: .openSettings, title: "DevHub: Open Settings", chords: ["Cmd+Q Shift+,"], recent: true),
            CommandPaletteRow(commandId: .openLog, title: "DevHub: Open Log", chords: [], recent: false),
        ]
        let prompt = SheetRows.commandPalette(rows)
        XCTAssertEqual(prompt.items.map(\.id), ["0", "1"])
        XCTAssertEqual(prompt.items[0].detail, .text("recently used"))
        XCTAssertEqual(prompt.items[0].accessory, .keys(["Cmd+Q Shift+,"]))
        XCTAssertNil(prompt.items[1].accessory)
        var state = PickerState(prompt)
        state.setQuery("open_log")
        XCTAssertEqual(state.rows.first?.id, "1")
    }

    func testCloneRowsSayWhereTheCloneLands() {
        let items = SheetRows.cloneParentItems(["/code"], repositoryName: "widget")
        XCTAssertEqual(items[0].detail?.plain, "Lands as /code/widget")
        XCTAssertEqual(SheetRows.cloneTypedItem(repositoryName: nil).detail?.plain, "Uses exactly what is in the field")
        let typed = SheetRows.cloneRepository(typed: "", draft: "example/widget", login: .pending, step: 2, failure: nil)
        XCTAssertEqual(typed.pinned.first?.detail?.plain, "Clones https://github.com/example/widget.git as widget")
        let bare = SheetRows.cloneRepository(typed: "", draft: "widget", login: .pending, step: 2, failure: nil)
        XCTAssertEqual(bare.pinned, [])
        XCTAssertNotNil(bare.note)
        XCTAssertEqual(SheetRows.newProjectStart(defaultDirectory: "/code", typed: ""), "/code/")
        XCTAssertEqual(SheetRows.newProjectStart(defaultDirectory: "/code", typed: "widget"), "/code/widget")
    }
}
