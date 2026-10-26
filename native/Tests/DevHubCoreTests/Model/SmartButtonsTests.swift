// Ports of apps/desktop/src/model/smartButtons.test.ts,
// automaticActions.test.ts and the Smart Button half of agentActions.test.ts
// (`smartButtonTriggers`, `smartButtonValues`).

import XCTest
@testable import DevHubCore

private func box(_ top: Double, _ right: Double, _ bottom: Double, _ left: Double) -> LayoutBox {
    LayoutBox(top: top, right: right, bottom: bottom, left: left)
}

private func offset(_ right: Double, _ bottom: Double) -> SmartButtonsOffset { SmartButtonsOffset(right: right, bottom: bottom) }

final class SmartButtonsPlacementTests: XCTestCase {
    // A 1000×600 pane at the origin; a composer from x 100 to 900 whose top is
    // at 480; a box 200×24.
    private let pane = box(0, 1000, 600, 0)
    private let composer = box(480, 900, 580, 100)
    private let size = LayoutSize(width: 200, height: 24)
    private let gui = SmartButtonsSpacing(inset: 16, gap: 0)

    func testDrawsAnAnchoredSpotFromWhereTheAnchorIsNow() {
        XCTAssertEqual(
            SmartButtons.anchoredOffset(edge: .top, along: 16, pane: pane, anchor: composer, box: size, spacing: gui),
            offset(116, 120))
        let grown = box(420, 900, 580, 100)
        XCTAssertEqual(
            SmartButtons.anchoredOffset(edge: .top, along: 16, pane: pane, anchor: grown, box: size, spacing: gui),
            offset(116, 180))
        XCTAssertEqual(
            SmartButtons.anchoredOffset(edge: .side, along: 10, pane: pane, anchor: composer, box: size, spacing: gui),
            offset(-100, 30))
    }

    func testSnapsABoxWhoseBottomComesNearTheComposersTop() {
        XCTAssertEqual(
            SmartButtons.snapSpot(offset(300, 130), pane: pane, anchor: composer, box: size, spacing: gui),
            .anchored(edge: .top, along: 200))
        XCTAssertEqual(
            SmartButtons.snapSpot(offset(300, 120 - SmartButtons.snap), pane: pane, anchor: composer, box: size, spacing: gui),
            .anchored(edge: .top, along: 200))
    }

    func testLeavesABoxFreePastTheThresholdOrBesideTheComposer() {
        let far = offset(300, 120 + SmartButtons.snap + 1)
        XCTAssertEqual(SmartButtons.snapSpot(far, pane: pane, anchor: composer, box: size, spacing: gui), .free(far))
        let beside = offset(0, 124)
        XCTAssertEqual(
            SmartButtons.snapSpot(beside, pane: pane, anchor: box(480, 700, 580, 100), box: size, spacing: gui), .free(beside))
    }

    func testNeverAnchorsPastTheComposersRightEdge() {
        XCTAssertEqual(
            SmartButtons.snapSpot(offset(60, 120), pane: pane, anchor: composer, box: size, spacing: gui),
            .anchored(edge: .top, along: 0))
    }

    func testSnapsToTheSideOfANarrowAnchorTheNearerEdgeWinning() {
        let narrow = box(480, 600, 580, 100)
        XCTAssertEqual(
            SmartButtons.snapSpot(offset(194, 40), pane: pane, anchor: narrow, box: size, spacing: gui),
            .anchored(edge: .side, along: 20))
    }

    func testAnchorsATerminalsBoxToItsCornerWhenThereIsNoStatus() {
        let tui = SmartButtonsSpacing(inset: 0, gap: 4)
        let corner = SmartButtons.anchorBox(pane: pane, anchor: nil, spacing: tui)
        XCTAssertEqual(
            SmartButtons.spotOffset(SmartButtons.defaultSpot(tui), pane: pane, anchor: corner, box: size, spacing: tui),
            offset(SmartButtons.margin, SmartButtons.margin))
        XCTAssertEqual(
            SmartButtons.snapSpot(offset(20, 20), pane: pane, anchor: corner, box: size, spacing: tui),
            .anchored(edge: .top, along: 8))
    }

    func testTellsAnchoredSpotsApartAndRefusesOnesThatAreNot() {
        XCTAssertEqual(SmartButtonsSpot.anchored(edge: .top, along: 4), .anchored(edge: .top, along: 4))
        XCTAssertNotEqual(SmartButtonsSpot.anchored(edge: .top, along: 4), .free(offset(4, 0)))
        XCTAssertTrue(SmartButtons.isSpot(.anchored(edge: .side, along: 0)))
        XCTAssertFalse(SmartButtons.isSpot(.anchored(edge: .top, along: 1.5)))
    }

    // MARK: the clamp

    private let paneSize = LayoutSize(width: 800, height: 600)

    func testLeavesAnOffsetThatFitsWhereItIs() {
        XCTAssertEqual(SmartButtons.clampOffset(offset(40, 100), pane: paneSize, box: size), offset(40, 100))
    }

    func testKeepsTheWholeBoxInsideThePane() {
        XCTAssertEqual(SmartButtons.clampOffset(offset(700, 900), pane: paneSize, box: size), offset(600, 576))
        XCTAssertEqual(SmartButtons.clampOffset(offset(-20, -5), pane: paneSize, box: size), offset(0, 0))
    }

    func testKeepsABoxWiderThanItsPaneOnThePanesRightAndBottomEdges() {
        XCTAssertEqual(SmartButtons.clampOffset(offset(30, 30), pane: LayoutSize(width: 100, height: 10), box: size), offset(0, 0))
    }

    // MARK: a drag

    func testMovesTheBoxWithThePointerCountingFromTheRightAndBottom() {
        XCTAssertEqual(SmartButtons.draggedOffset(offset(12, 12), movedX: -100, movedY: -50, pane: paneSize, box: size), offset(112, 62))
    }

    func testStopsAtThePanesEdgesInWholePixels() {
        XCTAssertEqual(SmartButtons.draggedOffset(offset(12, 12), movedX: 40.4, movedY: -9000, pane: paneSize, box: size), offset(0, 576))
        XCTAssertEqual(SmartButtons.draggedOffset(offset(12, 12), movedX: -10.6, movedY: -0.2, pane: paneSize, box: size), offset(23, 12))
    }

    // MARK: the default spot

    func testStandsOnWhatItIsAttachedTo() {
        let pane = box(100, 900, 700, 100)
        let composer = box(550, 880, 690, 120)
        XCTAssertEqual(SmartButtons.defaultOffset(pane: pane, anchor: composer, spacing: gui), offset(36, 150))
    }

    func testIsThePanesCornerWhenThereIsNothingToStandOn() {
        let pane = box(100, 900, 700, 100)
        XCTAssertEqual(
            SmartButtons.defaultOffset(pane: pane, anchor: nil, spacing: SmartButtonsSpacing(inset: 0, gap: 4)),
            offset(SmartButtons.margin, SmartButtons.margin))
    }

    // MARK: what the model remembers

    func testRemembersEachPresentationsPlaceOnItsOwnAndForgetsOnePutBack() throws {
        var app = AppModel(scratch: localWorkspace("/scratch"))
        XCTAssertTrue(try app.placeSmartButtons(.tui, .free(offset(30, 40))))
        XCTAssertTrue(try app.placeSmartButtons(.gui, .free(offset(5, 6))))
        XCTAssertEqual(app.snapshot().smartButtons, SmartButtonsPlacement(tui: .free(offset(30, 40)), gui: .free(offset(5, 6))))
        XCTAssertTrue(try app.placeSmartButtons(.tui, nil))
        XCTAssertEqual(app.snapshot().smartButtons, SmartButtonsPlacement(gui: .free(offset(5, 6))))
        XCTAssertFalse(try app.placeSmartButtons(.gui, .free(offset(5, 6))))
        XCTAssertTrue(try app.placeSmartButtons(.gui, .anchored(edge: .top, along: 30)))
        XCTAssertFalse(try app.placeSmartButtons(.gui, .anchored(edge: .top, along: 30)))
        XCTAssertEqual(app.snapshot().smartButtons, SmartButtonsPlacement(gui: .anchored(edge: .top, along: 30)))
    }

    func testRefusesAnOffsetThatIsNotAPlace() {
        var app = AppModel(scratch: localWorkspace("/scratch"))
        XCTAssertThrowsError(try app.placeSmartButtons(.tui, .free(offset(-1, 0))))
        XCTAssertFalse(SmartButtons.isOffset(offset(0.5, 0)))
        XCTAssertFalse(SmartButtons.isOffset(offset(0, 1_000_000)))
    }
}

// MARK: - When a Smart Button is offered (agentActions.test.ts)

private func pullRequest(
    state: PullRequestStatus.State = .open, unresolved: Int = 0, uncounted: Int = 0,
    checks: CheckSummary? = CheckSummary(state: .passing, total: 3, failing: 0, pending: 0), number: Int = 42
) -> PullRequestStatus {
    PullRequestStatus(
        number: number, url: "https://github.com/example/widget/pull/\(number)", title: "Tidy", state: state,
        conversations: ConversationCount(unresolved: unresolved, uncounted: uncounted), checks: checks)
}

/// A repository on a feature branch with nothing to do, varied per case.
private func repository(
    branch: String? = "feature/128-tidy", defaultBranch: String? = "main", dirty: Bool? = false, ahead: Int? = 0,
    pullRequest pr: PullRequestStatus?? = .some(pullRequest())
) -> WorkspaceRepositoryWire {
    WorkspaceRepositoryWire(
        workspaceId: "w", branch: branch, dirty: dirty, ahead: ahead, defaultBranch: defaultBranch, pullRequest: pr ?? nil)
}

final class SmartButtonTriggersTests: XCTestCase {
    private func conditional(_ status: AgentStatus, _ repository: WorkspaceRepositoryWire?) -> [String] {
        SmartButtons.triggers(status: status, repository: repository).filter { $0 != .always }.map(\.rawValue)
    }

    func testOffersNothingForARepositoryWithNothingToDo() {
        XCTAssertEqual(conditional(.idle, repository()), [])
    }

    func testOffersCommitForUncommittedChanges() {
        XCTAssertEqual(conditional(.idle, repository(dirty: true)), ["commit"])
        XCTAssertEqual(conditional(.idle, repository(dirty: nil)), [])
    }

    func testOffersPushForCommitsAheadOfTheUpstreamAndNotWithNoUpstream() {
        XCTAssertEqual(conditional(.idle, repository(ahead: 2)), ["push"])
        XCTAssertEqual(conditional(.idle, repository(ahead: nil)), [])
    }

    func testOffersAPullRequestOnABranchWithNonePushedOrNot() {
        XCTAssertEqual(conditional(.idle, repository(ahead: nil, pullRequest: .some(nil))), ["pull_request"])
    }

    func testDoesNotOfferAPullRequestFromTheTrunkOrWhenTheTrunkIsNotKnown() {
        XCTAssertEqual(conditional(.idle, repository(branch: "main", pullRequest: .some(nil))), [])
        XCTAssertEqual(conditional(.idle, repository(defaultBranch: nil, pullRequest: .some(nil))), [])
    }

    func testDoesNotOfferASecondPullRequestForABranchWhoseOneWasMerged() {
        XCTAssertEqual(conditional(.idle, repository(pullRequest: pullRequest(state: .merged))), [])
    }

    func testOffersGettingADraftReadyForADraftPullRequest() {
        XCTAssertEqual(conditional(.idle, repository(pullRequest: pullRequest(state: .draft))), ["draft_pull_request"])
    }

    func testOffersReviewCommentsWhileSomeAreUnresolvedOrWentUncounted() {
        XCTAssertEqual(conditional(.idle, repository(pullRequest: pullRequest(unresolved: 2))), ["unresolved_review_comments"])
        XCTAssertEqual(conditional(.idle, repository(pullRequest: pullRequest(uncounted: 30))), ["unresolved_review_comments"])
        XCTAssertEqual(
            conditional(.idle, repository(pullRequest: pullRequest(state: .draft, unresolved: 1))),
            ["draft_pull_request", "unresolved_review_comments"])
    }

    func testOffersFixingCIWhileItFailsOnAnOpenOrDraftPullRequest() {
        XCTAssertEqual(
            conditional(.idle, repository(pullRequest: pullRequest(checks: CheckSummary(state: .failing, total: 3, failing: 1, pending: 0)))),
            ["ci_failing"])
        XCTAssertEqual(
            conditional(.idle, repository(pullRequest: pullRequest(checks: CheckSummary(state: .pending, total: 3, failing: 1, pending: 0)))),
            [])
    }

    func testOffersNothingAboutAPullRequestThatIsClosedOrMerged() {
        for state in [PullRequestStatus.State.closed, .merged] {
            XCTAssertEqual(
                conditional(.idle, repository(pullRequest: pullRequest(
                    state: state, unresolved: 3, checks: CheckSummary(state: .failing, total: 1, failing: 1, pending: 0)))),
                [])
        }
    }

    func testOffersThemInTheOrderTheWorkGoesIn() {
        XCTAssertEqual(
            conditional(.idle, repository(dirty: true, ahead: 1, pullRequest: pullRequest(
                state: .draft, unresolved: 1, checks: CheckSummary(state: .failing, total: 2, failing: 2, pending: 0)))),
            ["commit", "push", "draft_pull_request", "unresolved_review_comments", "ci_failing"])
    }

    func testOffersNothingUnlessTheAgentIsIdle() {
        let busy = repository(dirty: true, ahead: 1)
        for status in [AgentStatus.working, .waiting, .background, .error, .unknown] {
            XCTAssertEqual(conditional(status, busy), [])
        }
        XCTAssertEqual(conditional(.idle, busy), ["commit", "push"])
    }

    func testOffersNothingForAWorkspaceWhoseRepositoryIsNotKnown() {
        XCTAssertEqual(conditional(.idle, nil), [])
    }

    func testAlwaysOffersTheAlwaysTriggerWhileIdleRepositoryOrNotAndNeverWhileBusy() {
        XCTAssertEqual(SmartButtons.triggers(status: .idle, repository: repository()), [.always])
        XCTAssertEqual(SmartButtons.triggers(status: .idle, repository: nil), [.always])
        XCTAssertEqual(SmartButtons.triggers(status: .idle, repository: repository(dirty: true)), [.commit, .always])
        for status in [AgentStatus.working, .waiting, .background, .error] {
            XCTAssertEqual(SmartButtons.triggers(status: status, repository: nil), [])
        }
    }

    func testNamesTheBranchAndThePullRequest() {
        XCTAssertEqual(
            SmartButtons.values(repository(pullRequest: pullRequest(
                unresolved: 4, checks: CheckSummary(state: .failing, total: 5, failing: 2, pending: 0)))),
            [
                "BRANCH": "feature/128-tidy", "PR_URL": "https://github.com/example/widget/pull/42", "PR_NO": "42",
                "UNRESOLVED": "4", "FAILING": "2",
            ])
    }

    func testSaysACountReadFromTheFirstPageOnlyIsALowerBound() {
        XCTAssertEqual(SmartButtons.values(repository(pullRequest: pullRequest(unresolved: 100, uncounted: 12)))["UNRESOLVED"], "100+")
    }

    func testLeavesOutWhatIsNotKnownSoTheTemplateKeepsItsHole() {
        let values = SmartButtons.values(repository(branch: nil, pullRequest: .some(nil)))
        XCTAssertEqual(values, [:])
        XCTAssertEqual(AgentActions.fillVariables("{{PR_URL}} on {{BRANCH}}", values: values), "{{PR_URL}} on {{BRANCH}}")
    }

    func testFillsEveryShippedSmartButtonsWordingCompletely() {
        let values = SmartButtons.values(repository(pullRequest: pullRequest(
            unresolved: 1, checks: CheckSummary(state: .failing, total: 1, failing: 1, pending: 0))))
        for action in AgentActions.builtIn where action.trigger.isSmartButton {
            XCTAssertFalse(AgentActions.fillVariables(action.template, values: values).contains("{{"), action.id)
        }
    }
}

// MARK: - Automatic actions (automaticActions.test.ts)

final class AutomaticActionsTests: XCTestCase {
    private let actions: [AutomaticActionChoice] = [
        AutomaticActionChoice(id: "commit_changes", trigger: .commit),
        AutomaticActionChoice(id: "push_commits", trigger: .push),
        AutomaticActionChoice(id: "open_pull_request", trigger: .pullRequest),
        AutomaticActionChoice(id: "address_review_comments", trigger: .unresolvedReviewComments),
        AutomaticActionChoice(id: "fix_ci", trigger: .ciFailing),
    ]

    private func pr(_ unresolved: Int, _ checks: CheckSummary.State = .passing, number: Int = 7) -> WorkspaceRepositoryWire {
        WorkspaceRepositoryWire(
            workspaceId: "w", branch: "feature/7-x", dirty: false, ahead: 0, defaultBranch: "main",
            pullRequest: PullRequestStatus(
                number: number, url: "https://github.com/o/r/pull/\(number)", title: "x", state: .open,
                conversations: ConversationCount(unresolved: unresolved, uncounted: 0),
                checks: CheckSummary(state: checks, total: 1, failing: checks == .failing ? 1 : 0, pending: 0)))
    }

    private func agent(
        _ repository: WorkspaceRepositoryWire?, _ automaticActions: [String], status: AgentStatus = .idle, queued: Int = 0
    ) -> AutomaticAgent {
        AutomaticAgent(agentId: "a1", status: status, queued: queued, automaticActions: automaticActions, repository: repository)
    }

    private func fired(_ automatic: inout AutomaticActions, _ one: AutomaticAgent) -> [String] {
        automatic.observe([one], actions: actions).map(\.actionId)
    }

    func testNeverFiresAnAlwaysTriggerActionEvenWhenTicked() {
        var automatic = AutomaticActions()
        let choices = actions + [AutomaticActionChoice(id: "send_ok", trigger: .always)]
        let one = agent(pr(0), ["send_ok"])
        XCTAssertEqual(automatic.observe([one], actions: choices), [])
        XCTAssertEqual(automatic.observe([one], actions: choices), [])
        XCTAssertFalse(AutomaticActions.isAutomatic(.always))
    }

    func testFiresWhenReviewCommentsArriveOnceAndAgainWhenMoreDo() {
        var automatic = AutomaticActions()
        let on = ["address_review_comments"]
        XCTAssertEqual(fired(&automatic, agent(pr(0), on)), [])
        XCTAssertEqual(fired(&automatic, agent(pr(2), on)), ["address_review_comments"])
        XCTAssertEqual(fired(&automatic, agent(pr(2), on)), [])
        XCTAssertEqual(fired(&automatic, agent(pr(1), on)), [])
        XCTAssertEqual(fired(&automatic, agent(pr(3), on)), ["address_review_comments"])
    }

    func testIsOffUnlessTickedAndFiresOnceForWhatAlreadyHoldsWhenItIsTicked() {
        var automatic = AutomaticActions()
        let on = ["address_review_comments"]
        XCTAssertEqual(fired(&automatic, agent(pr(2), [])), [])
        XCTAssertEqual(fired(&automatic, agent(pr(2), on)), ["address_review_comments"])
        XCTAssertEqual(fired(&automatic, agent(pr(2), on)), [])
        XCTAssertEqual(fired(&automatic, agent(pr(2), [])), [])
        XCTAssertEqual(fired(&automatic, agent(pr(2), on)), ["address_review_comments"])
        XCTAssertEqual(fired(&automatic, agent(pr(4), on)), ["address_review_comments"])
    }

    func testWaitsForTheAgentToBeIdleWithNothingQueued() {
        var automatic = AutomaticActions()
        let on = ["fix_ci"]
        XCTAssertEqual(fired(&automatic, agent(pr(0), on)), [])
        XCTAssertEqual(fired(&automatic, agent(pr(0, .failing), on, status: .working)), [])
        XCTAssertEqual(fired(&automatic, agent(pr(0, .failing), on, queued: 1)), [])
        XCTAssertEqual(fired(&automatic, agent(pr(0, .failing), on)), ["fix_ci"])
    }

    func testFiresCIAgainOnlyForANewFailure() {
        var automatic = AutomaticActions()
        let on = ["fix_ci"]
        XCTAssertEqual(fired(&automatic, agent(pr(0, .pending), on)), [])
        XCTAssertEqual(fired(&automatic, agent(pr(0, .failing), on)), ["fix_ci"])
        XCTAssertEqual(fired(&automatic, agent(pr(0, .failing), on)), [])
        XCTAssertEqual(fired(&automatic, agent(nil, on)), [])
        XCTAssertEqual(fired(&automatic, agent(pr(0, .failing), on)), [])
        XCTAssertEqual(fired(&automatic, agent(pr(0, .pending), on)), [])
        XCTAssertEqual(fired(&automatic, agent(pr(0, .failing), on)), ["fix_ci"])
        XCTAssertEqual(fired(&automatic, agent(pr(0, .failing, number: 8), on)), ["fix_ci"])
    }

    func testDoesNotSendWhatAPersonAlreadySent() {
        var automatic = AutomaticActions()
        let on = ["address_review_comments"]
        XCTAssertEqual(fired(&automatic, agent(pr(0), on, status: .working)), [])
        XCTAssertEqual(fired(&automatic, agent(pr(2), on, status: .working)), [])
        automatic.answered(agentId: "a1", trigger: .unresolvedReviewComments)
        XCTAssertEqual(fired(&automatic, agent(pr(2), on)), [])
    }

    func testSendsOneTriggerAtATimeAndNeverOneThatIsNotAutomatic() {
        var automatic = AutomaticActions()
        let on = ["commit_changes", "push_commits", "open_pull_request"]
        let clean = WorkspaceRepositoryWire(workspaceId: "w", branch: "feature/x", dirty: false, ahead: 0, defaultBranch: "main")
        XCTAssertEqual(fired(&automatic, agent(clean, on)), [])
        var both = clean
        both.dirty = true
        both.ahead = 1
        XCTAssertEqual(fired(&automatic, agent(both, on)), ["commit_changes"])
        XCTAssertEqual(fired(&automatic, agent(both, on)), ["push_commits"])
        XCTAssertEqual(fired(&automatic, agent(both, on)), [])
    }

    func testForgetsAnAgentThatHasGone() {
        var automatic = AutomaticActions()
        let on = ["address_review_comments"]
        XCTAssertEqual(fired(&automatic, agent(pr(2), on)), ["address_review_comments"])
        _ = automatic.observe([], actions: actions)
        _ = automatic.observe([], actions: actions)
        XCTAssertEqual(fired(&automatic, agent(pr(2), on)), ["address_review_comments"])
    }
}
