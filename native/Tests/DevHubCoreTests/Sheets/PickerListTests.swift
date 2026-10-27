// Port of apps/desktop/src/shell/components/shell/picker.test.tsx (the rules,
// without a page) and pathLabel.test.tsx.
import XCTest
@testable import DevHubCore

final class PickerListTests: XCTestCase {
    let items = [
        PickerItem(id: "claude", label: "Claude", searchText: "Claude claude"),
        PickerItem(id: "codex", label: "Codex", searchText: "Codex codex"),
    ]

    func picker(_ edit: (inout PickerPrompt) -> Void = { _ in }) -> PickerState {
        var prompt = PickerPrompt(
            title: "New Agent", question: "Which agent profile should the new agent start from?", items: items,
            emptyNoMatch: "No agent profiles match.", emptyNoItems: "No agent profiles are enabled.")
        edit(&prompt)
        return PickerState(prompt)
    }

    func testReturnAndItsModifiersAreDifferentAnswers() {
        for (split, alternate) in [(false, false), (true, false), (false, true), (true, true)] {
            var state = picker()
            XCTAssertEqual(
                state.chooseActive(split: split, alternate: alternate),
                .choose(PickerChoice(id: "claude", split: split, alternate: alternate, query: "")))
        }
    }

    func testFiltersWhatItWasGivenWithoutAskingAnyone() {
        var state = picker()
        state.setQuery("cod")
        XCTAssertEqual(state.rows.map(\.id), ["codex"])
    }

    func testKeepsTheRowsItHasWhileTheSourceIsAskedAgain() {
        var state = picker { $0.busy = true }
        state.setQuery("c")
        XCTAssertEqual(state.rows.count, 2)
        XCTAssertFalse(state.showsEmpty)
    }

    func testSaysNothingMatchesRatherThanShowingAnEmptyList() {
        var state = picker()
        state.setQuery("zzz")
        XCTAssertTrue(state.showsEmpty)
        XCTAssertEqual(state.emptyMessage, "No agent profiles match.")
        let empty = PickerState(PickerPrompt(title: "t", question: "q", busy: true, emptyNoItems: "none"))
        XCTAssertEqual(empty.emptyMessage, "Searching…")
    }

    func testPinnedRowsLeadWhileNothingIsTypedAndTrailOnceSomethingIs() {
        var state = picker { $0.pinned = [PickerItem(id: "new", label: "New Project…")] }
        XCTAssertEqual(state.rows.map(\.id), ["new", "claude", "codex"])
        state.setQuery("cl")
        XCTAssertEqual(state.rows.map(\.id), ["claude", "new"])
        state.setQuery("zzzz")
        XCTAssertEqual(state.rows.map(\.id), ["new"])
        XCTAssertEqual(state.chooseActive(), .choose(PickerChoice(id: "new", query: "zzzz")))
    }

    func testStartsOnAValueTheCallerSupplied() {
        var state = picker { $0.initialQuery = "feature/128-" }
        XCTAssertEqual(state.query, "feature/128-")
        state.setQuery("feature/128-tidy")
        state.prompt.pinned = [PickerItem(id: "new", label: "New Branch…")]
        XCTAssertEqual(state.choose("new"), .choose(PickerChoice(id: "new", query: "feature/128-tidy")))
    }

    func testKeepsTheCallersOrderAmongRowsTheQueryCannotTellApart() {
        var state = PickerState(PickerPrompt(title: "t", question: "q", items: [
            PickerItem(id: "daily", label: "0901", searchText: "/daily/2026/0901"),
            PickerItem(id: "devhub", label: "devhub", searchText: "/code/devhub"),
            PickerItem(id: "widget", label: "widget", searchText: "/code/widget"),
        ]))
        XCTAssertEqual(state.rows.map(\.label), ["0901", "devhub", "widget"])
        state.setQuery("d")
        XCTAssertEqual(state.rows.map(\.label), ["devhub", "widget", "0901"])
    }

    func testARepositoryLeadsAWorktreeTheQueryMatchesAsWell() {
        var state = PickerState(PickerPrompt(title: "t", question: "q", items: [
            PickerItem(id: "tidy", label: "widget-tidy", searchText: "/code/widget-tidy", worktree: true),
            PickerItem(id: "widget", label: "widget", searchText: "/code/widget"),
        ]))
        XCTAssertEqual(state.rows.map(\.label), ["widget", "widget-tidy"])
        state.setQuery("widget")
        XCTAssertEqual(state.rows.map(\.label), ["widget", "widget-tidy"])
        var better = PickerState(PickerPrompt(title: "t", question: "q", items: [
            PickerItem(id: "widget", label: "widget", searchText: "/t/i/d/y/widget"),
            PickerItem(id: "tidy", label: "widget-tidy", searchText: "/code/widget-tidy", worktree: true),
        ]))
        better.setQuery("tidy")
        XCTAssertEqual(better.rows.map(\.label), ["widget-tidy", "widget"])
        let kinds = PickerState(PickerPrompt(title: "t", question: "q", items: [
            PickerItem(id: "w2", label: "b-wt", searchText: "/code/b-wt", worktree: true),
            PickerItem(id: "r2", label: "b", searchText: "/code/b"),
            PickerItem(id: "w1", label: "a-wt", searchText: "/code/a-wt", worktree: true),
            PickerItem(id: "r1", label: "a", searchText: "/code/a"),
        ]))
        XCTAssertEqual(kinds.rows.map(\.label), ["b", "a", "b-wt", "a-wt"])
    }

    func testHoldsBackAPinnedRowThatMeansWhatWasTyped() {
        var state = picker { $0.pinned = [PickerItem(id: "typed", label: "Use what I typed", needsQuery: true)] }
        XCTAssertEqual(state.rows.map(\.label), ["Claude", "Codex"])
        state.setQuery("c")
        XCTAssertEqual(state.rows.last?.label, "Use what I typed")
    }

    func testStopsListeningOnceARowIsTaken() {
        var state = picker()
        XCTAssertNotNil(state.chooseActive())
        XCTAssertNil(state.chooseActive())
        state.move(1)
        XCTAssertEqual(state.active, 0)
        XCTAssertNil(state.choose("codex"))
        XCTAssertNil(state.escape())
        XCTAssertEqual(state.taken, "claude")
        state.release()
        XCTAssertEqual(state.escape(), .cancel)
    }

    func testTheArrowsGoRoundAndThePageKeysStopAtTheEnds() {
        var state = picker()
        state.move(-1)
        XCTAssertEqual(state.activeRow?.id, "codex")
        state.move(1)
        XCTAssertEqual(state.activeRow?.id, "claude")
        state.page(1)
        XCTAssertEqual(state.activeRow?.id, "codex")
        state.page(-1)
        XCTAssertEqual(state.activeRow?.id, "claude")
    }

    func testAnUnavailableRowCannotBeTaken() {
        var state = picker { $0.items.append(PickerItem(id: "reading", label: "Earlier sessions", unavailable: "Reading…")) }
        XCTAssertNil(state.choose("reading"))
        XCTAssertNil(state.taken)
    }

    func testTheCancelRowLeadsIsWhatReturnTakesAndCancels() {
        var state = PickerState(PickerPrompt(
            title: "Close", question: "q", items: [PickerItem(id: "close", label: "Close")],
            cancelRow: PickerCancelRow(detail: "Leave it open.")))
        XCTAssertEqual(state.rows.map(\.label), ["Cancel", "Close"])
        XCTAssertFalse(state.footerHasCancel)
        XCTAssertEqual(state.chooseActive(), .cancel)
        XCTAssertNil(state.taken)
        XCTAssertEqual(state.choose("close"), .choose(PickerChoice(id: "close")))
        let named = PickerState(PickerPrompt(
            title: "t", question: "q", cancelRow: PickerCancelRow(label: "Keep the current socket", detail: "d")))
        XCTAssertEqual(named.rows.first?.label, "Keep the current socket")
        XCTAssertTrue(picker().footerHasCancel)
    }

    func testNewItemsKeepTheRowThePersonIsOn() {
        var state = picker()
        state.move(1)
        var next = state.prompt
        next.items.insert(PickerItem(id: "aaa", label: "Aaa"), at: 0)
        state.setPrompt(next)
        XCTAssertEqual(state.activeRow?.id, "codex")
    }

    func testAPathGivesWayAtItsHead() {
        XCTAssertEqual(PathLabel.split("/Users/someone/dev/devhub").head, "/Users/someone/dev")
        XCTAssertEqual(PathLabel.split("/Users/someone/dev/devhub").tail, "/devhub")
        XCTAssertEqual(PathLabel.split("devhub").head, "")
        XCTAssertEqual(PathLabel.split("/devhub").tail, "/devhub")
        XCTAssertEqual(PathLabel.split("~/dev").head, "~")
    }
}
