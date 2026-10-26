// Port of apps/desktop/src/model/workspaceOrder.test.ts

import XCTest
@testable import DevHubCore

private struct Row: OrderableWorkspace {
    let id: String
    let label: String
    let key: String
    var main: String?

    init(_ id: String, _ label: String, _ key: String, _ main: String? = nil) {
        self.id = id
        self.label = label
        self.key = key
        self.main = main
    }

    var orderId: String { id }
    var orderLabel: String { label }
    var orderKey: String { key }
}

private func order(_ rows: [Row]) -> [String] {
    WorkspaceOrder.order(rows, mainWorktreeOf: { $0.main }).map(\.label)
}

/// A repository, two of its worktrees, and two unrelated folders.
private let TREE: [Row] = [
    Row("z", "zebra", "/z", "/z"),
    Row("wb", "widget_b", "/w_b", "/w"),
    Row("w", "widget", "/w", "/w"),
    Row("a", "alpha", "/a", "/a"),
    Row("wa", "widget_a", "/w_a", "/w"),
]

private func arranged(_ explicit: [String], _ rows: [Row] = TREE) -> [String] {
    WorkspaceOrder.order(rows, mainWorktreeOf: { $0.main }, explicit: explicit).map(\.label)
}

private func drawn(_ explicit: [String] = [], _ rows: [Row] = TREE) -> [Row] {
    WorkspaceOrder.order(rows, mainWorktreeOf: { $0.main }, explicit: explicit)
}

private func moved(_ id: String, _ direction: MoveDirection, _ explicit: [String] = [], _ rows: [Row] = TREE) -> [String]? {
    WorkspaceOrder.move(drawn(explicit, rows), mainWorktreeOf: { $0.main }, workspaceId: id, direction: direction)
}

private func labelsOf(_ order: [String]?, _ rows: [Row] = TREE) -> [String]? {
    order?.map { id in rows.first { $0.id == id }?.label ?? "?" }
}

final class WorkspaceOrderTests: XCTestCase {
    // MARK: the order workspaces appear in

    func testKeepsARepositorysWorktreesWithItTheRepositoryFirst() {
        XCTAssertEqual(order([
            Row("1", "zebra", "/z", "/z"), Row("2", "widget_b", "/w_b", "/w"), Row("3", "widget", "/w", "/w"),
            Row("4", "alpha", "/a", "/a"), Row("5", "widget_a", "/w_a", "/w"),
        ]), ["alpha", "widget", "widget_a", "widget_b", "zebra"])
    }

    func testGroupsWorktreesWhoseRepositoryIsNotOpenUnderTheFirstOfThem() {
        XCTAssertEqual(order([
            Row("1", "zebra", "/z", "/z"), Row("2", "widget_b", "/w_b", "/w"), Row("3", "widget_a", "/w_a", "/w"),
        ]), ["widget_a", "widget_b", "zebra"])
    }

    func testLeavesAWorkspaceWhoseGitCouldNotBeReadStandingAlone() {
        XCTAssertEqual(order([Row("1", "beta", "/b"), Row("2", "alpha", "/a")]), ["alpha", "beta"])
    }

    func testSortsNamesTheWayAReaderReadsThemDigitsAndAll() {
        XCTAssertEqual(order([Row("1", "app-10", "/10"), Row("2", "app-2", "/2")]), ["app-2", "app-10"])
    }

    func testKeepsTwoIndependentClonesOfOneRepositoryApart() {
        XCTAssertEqual(order([
            Row("1", "widget — b", "/b/widget", "/b/widget"), Row("2", "widget — a", "/a/widget", "/a/widget"),
        ]), ["widget — a", "widget — b"])
    }

    // MARK: workspaces on other machines

    func testDoesNotFoldTwoMachinesIdenticalPathsIntoOneGroup() {
        XCTAssertEqual(order([
            Row("1", "api — staging", "ssh://staging/srv/api"), Row("2", "api — build", "ssh://build/srv/api"),
        ]), ["api — build", "api — staging"])
    }

    func testLeavesALocalFoldersGroupingExactlyWhereItWas() {
        XCTAssertEqual(order([
            Row("1", "widget_a", "/w_a", "/w"), Row("2", "widget", "/w", "/w"), Row("3", "api", "ssh://build/srv/api"),
        ]), ["api", "widget", "widget_a"])
    }

    // MARK: the order a person put the rows in

    func testIsTheAutomaticOrderWhenNobodyHasArrangedAnything() {
        XCTAssertEqual(arranged([]), ["alpha", "widget", "widget_a", "widget_b", "zebra"])
    }

    func testComesBackExactlyAsItWasWrittenDown() {
        XCTAssertEqual(arranged(["z", "w", "wa", "wb", "a"]), ["zebra", "widget", "widget_a", "widget_b", "alpha"])
    }

    func testKeepsARepositorysWorktreesWithItWhenTheRepositoryMoves() {
        XCTAssertEqual(arranged(["w", "a"]), ["widget", "widget_a", "widget_b", "zebra", "alpha"])
    }

    func testCannotBeMadeToTakeAWorktreeOutOfItsGroup() {
        XCTAssertEqual(arranged(["w", "a", "wa", "wb", "z"]), ["widget", "widget_a", "widget_b", "alpha", "zebra"])
    }

    func testPutsTheRepositoryAtTheHeadOfItsGroupWhateverTheFileSays() {
        XCTAssertEqual(arranged(["wb", "wa", "w", "a", "z"]), ["widget", "widget_b", "widget_a", "alpha", "zebra"])
    }

    func testLandsANewlyOpenedWorktreeUnderItsRepositoryNotAtTheEnd() {
        XCTAssertEqual(arranged(["w", "wb", "z", "a"]), ["widget", "widget_a", "widget_b", "zebra", "alpha"])
    }

    func testLandsANewlyOpenedFolderWhereItsNameWouldHavePutIt() {
        let rows = TREE + [Row("b", "beta", "/b", "/b")]
        XCTAssertEqual(
            arranged(["z", "a", "w", "wa", "wb"], rows), ["zebra", "alpha", "beta", "widget", "widget_a", "widget_b"])
    }

    func testIgnoresAnIdWhoseWorkspaceIsNotOpen() {
        XCTAssertEqual(arranged(["z", "gone", "a", "w", "wa", "wb"]), ["zebra", "alpha", "widget", "widget_a", "widget_b"])
    }

    // MARK: moving one row a step

    func testMovesARepositoryPastTheNextGroupWorktreesAndAll() {
        XCTAssertEqual(labelsOf(moved("w", .down)), ["alpha", "zebra", "widget", "widget_a", "widget_b"])
    }

    func testMovesARepositoryBackPastTheGroupAboveIt() {
        XCTAssertEqual(labelsOf(moved("w", .up)), ["widget", "widget_a", "widget_b", "alpha", "zebra"])
    }

    func testMovesAWorktreeWithinItsOwnGroup() {
        XCTAssertEqual(labelsOf(moved("wa", .down)), ["alpha", "widget", "widget_b", "widget_a", "zebra"])
        XCTAssertEqual(labelsOf(moved("wb", .up)), ["alpha", "widget", "widget_b", "widget_a", "zebra"])
    }

    func testWillNotLiftAWorktreeOverItsOwnRepository() {
        XCTAssertNil(moved("wa", .up))
    }

    func testWillNotPushAWorktreeOutOfTheBottomOfItsGroup() {
        XCTAssertNil(moved("wb", .down))
    }

    func testIsANoOpAtEitherEndOfTheList() {
        XCTAssertNil(moved("a", .up))
        XCTAssertNil(moved("z", .down))
    }

    func testIsANoOpForARowThatIsNotThere() {
        XCTAssertNil(moved("nobody", .down))
    }

    func testLetsAWorktreeTakeTheHeadSlotWhenTheRepositoryIsNotOpen() {
        let rows = [Row("wa", "widget_a", "/w_a", "/w"), Row("wb", "widget_b", "/w_b", "/w"), Row("z", "zebra", "/z", "/z")]
        let once = moved("wb", .up, [], rows)
        XCTAssertEqual(labelsOf(once, rows), ["widget_b", "widget_a", "zebra"])
        XCTAssertEqual(
            labelsOf(WorkspaceOrder.move(drawn(once ?? [], rows), mainWorktreeOf: { $0.main }, workspaceId: "wa", direction: .up), rows),
            ["widget_a", "widget_b", "zebra"])
    }

    func testWritesDownTheWholeListSoTheRestOfItStopsMovingOnItsOwn() {
        let order = moved("z", .up)
        XCTAssertEqual(order, ["a", "z", "w", "wa", "wb"])
        let renamed = TREE.map { $0.id == "z" ? Row($0.id, "aardvark", $0.key, $0.main) : $0 }
        XCTAssertEqual(arranged(order ?? [], renamed), ["alpha", "aardvark", "widget", "widget_a", "widget_b"])
    }

    // MARK: dropping a row somewhere

    private func dropped(_ id: String, _ before: String?) -> [String]? {
        labelsOf(WorkspaceOrder.place(drawn(), mainWorktreeOf: { $0.main }, workspaceId: id, before: before))
    }

    func testPutsAGroupInFrontOfTheGroupItWasDroppedOn() {
        XCTAssertEqual(dropped("z", "w"), ["alpha", "zebra", "widget", "widget_a", "widget_b"])
    }

    func testPutsAGroupLastWhenItWasDroppedPastTheEnd() {
        XCTAssertEqual(dropped("a", nil), ["widget", "widget_a", "widget_b", "zebra", "alpha"])
    }

    func testRefusesAGroupDroppedOnSomethingThatIsNotAGroupHead() {
        XCTAssertNil(WorkspaceOrder.place(drawn(), mainWorktreeOf: { $0.main }, workspaceId: "z", before: "wa"))
    }

    func testRefusesAWorktreeDroppedOutsideItsOwnGroup() {
        XCTAssertNil(WorkspaceOrder.place(drawn(), mainWorktreeOf: { $0.main }, workspaceId: "wa", before: "z"))
        XCTAssertNil(WorkspaceOrder.place(drawn(), mainWorktreeOf: { $0.main }, workspaceId: "wa", before: "w"))
    }

    func testRefusesADropThatWouldChangeNothing() {
        XCTAssertNil(WorkspaceOrder.place(drawn(), mainWorktreeOf: { $0.main }, workspaceId: "z", before: nil))
        XCTAssertNil(WorkspaceOrder.place(drawn(), mainWorktreeOf: { $0.main }, workspaceId: "z", before: "z"))
    }

    // MARK: the Agents of one workspace

    private let agents = ["one", "two", "three"]

    func testAgentsStepOnePlaceAndStopAtTheEnds() {
        XCTAssertEqual(WorkspaceOrder.moveAgent(agents, agentId: "one", direction: .down), ["two", "one", "three"])
        XCTAssertEqual(WorkspaceOrder.moveAgent(agents, agentId: "three", direction: .up), ["one", "three", "two"])
        XCTAssertNil(WorkspaceOrder.moveAgent(agents, agentId: "one", direction: .up))
        XCTAssertNil(WorkspaceOrder.moveAgent(agents, agentId: "three", direction: .down))
        XCTAssertNil(WorkspaceOrder.moveAgent(agents, agentId: "nobody", direction: .down))
    }

    func testAgentsDropInFrontOfAnotherOrAtTheEnd() {
        XCTAssertEqual(WorkspaceOrder.placeAgent(agents, agentId: "three", before: "one"), ["three", "one", "two"])
        XCTAssertEqual(WorkspaceOrder.placeAgent(agents, agentId: "one", before: nil), ["two", "three", "one"])
        XCTAssertNil(WorkspaceOrder.placeAgent(agents, agentId: "one", before: "two"))
        XCTAssertNil(WorkspaceOrder.placeAgent(agents, agentId: "one", before: "one"))
        XCTAssertNil(WorkspaceOrder.placeAgent(agents, agentId: "one", before: "nobody"))
    }
}
