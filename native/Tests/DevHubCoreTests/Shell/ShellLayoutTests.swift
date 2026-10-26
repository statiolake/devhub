// The window's reading of the projection: `publishLayoutState`,
// `editorTerminalViews`, `paneFocused` and `workbenchArea`
// (apps/desktop/src/main/shell/appController.ts, shellWindow.ts), and the
// window's name (shellTitle.test.ts).

import XCTest
@testable import DevHubCore

private typealias F = ShellFixtures

final class ShellLayoutTests: XCTestCase {
    private func arrange(
        _ snapshot: AppSnapshotWire, sidebar: Bool = false, preview: LayoutPreview = LayoutPreview(),
        shown: inout EditorTerminalsShown
    ) -> ShellArrangement {
        ShellLayout.arrangement(snapshot, chrome: ShellChrome(), keyboardInSidebar: sidebar, preview: preview, shown: &shown)
    }

    private func arrange(_ snapshot: AppSnapshotWire, sidebar: Bool = false, preview: LayoutPreview = LayoutPreview()) -> ShellArrangement {
        var shown = EditorTerminalsShown()
        return arrange(snapshot, sidebar: sidebar, preview: preview, shown: &shown)
    }

    func testAWorkspaceSelectedIsItsEditorAreaWithTheKeyboardInIt() {
        let snapshot = F.snapshot([F.workspace("w")], context: .workspace("w"))
        let arrangement = arrange(snapshot)
        XCTAssertEqual(arrangement.state.surface, .editor(editorKey: "/work/w"))
        XCTAssertEqual(arrangement.state.keyboard, .editor)
        XCTAssertEqual(arrangement.editorTerminals, [EditorTerminalEntry(editorKey: "/work/w", workspaceId: "w")])
    }

    func testNothingIsDrawnUntilTheModelIsReady() {
        let arrangement = arrange(F.snapshot([F.workspace("w")], context: .workspace("w"), readiness: .starting))
        XCTAssertEqual(arrangement.state.surface, SurfaceArrangement.none)
    }

    func testASplitCarriesTheRatioAndTheKeyboardIsInTheSelectedHalf() {
        let workspace = F.workspace("w", agents: [F.agent("a", in: "w")])
        let agentHalf = arrange(F.snapshot([workspace], context: .agent("a"), presentation: .beside, splitRatio: 0.6))
        XCTAssertEqual(agentHalf.state.surface, .split(editorKey: "/work/w", ratio: 0.6))
        XCTAssertEqual(agentHalf.state.keyboard, .agents)
        let editorHalf = arrange(F.snapshot(
            [workspace], context: .workspace("w"), presentation: .beside,
            layout: .split(editorKey: "workspace-editor:w", agentKey: "agent:a")))
        XCTAssertEqual(editorHalf.state.keyboard, .editor)
        let dragging = arrange(F.snapshot([workspace], context: .agent("a"), presentation: .beside), preview: LayoutPreview(splitRatio: 0.3))
        XCTAssertEqual(dragging.state.surface, .split(editorKey: "/work/w", ratio: 0.3))
    }

    func testAnAgentAloneKeepsTheEditorAreasThatWereShownAttachedAndHidden() {
        var shown = EditorTerminalsShown()
        let workspace = F.workspace("w", agents: [F.agent("a", in: "w")])
        _ = arrange(F.snapshot([workspace], context: .workspace("w")), shown: &shown)
        let agent = arrange(F.snapshot([workspace], context: .agent("a")), shown: &shown)
        XCTAssertEqual(agent.state.surface, .agent)
        XCTAssertEqual(agent.state.keyboard, .agents)
        XCTAssertEqual(agent.editorTerminals.map(\.workspaceId), ["w"])
        // The Workspace going takes its editor area with it.
        let gone = arrange(F.snapshot([], context: .workspace(F.scratchId)), shown: &shown)
        XCTAssertEqual(gone.editorTerminals.map(\.workspaceId), [F.scratchId])
    }

    func testAWorkspaceTerminalModeDoesNotServeGetsNoEditorArea() {
        let remote = F.workspace("r", location: .ssh(host: "nas"))
        let arrangement = arrange(F.snapshot([remote], context: .workspace("r")))
        XCTAssertEqual(arrangement.state.surface, .editor(editorKey: "/work/r"))
        XCTAssertEqual(arrangement.editorTerminals, [])
    }

    func testTheViewsAgentsTerminalIsLaidOutWithItsAgentAndNeverWithTheEditorAlone() {
        let workspace = F.workspace("w", agents: [F.agent("a", in: "w", terminal: "t1", share: 0.3, stackedShare: 0.5)])
        let full = arrange(F.snapshot([workspace], context: .agent("a"), visibleTerminal: "t1"))
        XCTAssertEqual(full.state.terminal?.terminalId, "t1")
        XCTAssertEqual(full.state.terminal?.share, 0.3)
        XCTAssertEqual(full.terminals, ["t1"])
        let split = arrange(F.snapshot([workspace], context: .agent("a"), presentation: .beside, visibleTerminal: "t1"))
        XCTAssertEqual(split.state.terminal?.share, 0.5)
        let editor = arrange(F.snapshot([workspace], context: .workspace("w"), visibleTerminal: "t1"))
        XCTAssertNil(editor.state.terminal)
        XCTAssertEqual(editor.terminals, ["t1"])
        let dragged = arrange(F.snapshot([workspace], context: .agent("a"), visibleTerminal: "t1"), preview: LayoutPreview(terminalShare: 0.7))
        XCTAssertEqual(dragged.state.terminal?.share, 0.7)
    }

    func testTheKeyboardIsInTheSidebarWhenAskedForAndInTheTerminalWhenItHasIt() {
        let workspace = F.workspace("w", agents: [F.agent("a", in: "w", terminal: "t1")])
        XCTAssertEqual(arrange(F.snapshot([workspace], context: .agent("a")), sidebar: true).state.keyboard, .sidebar)
        XCTAssertEqual(
            arrange(F.snapshot([workspace], context: .agent("a"), visibleTerminal: "t1", paneFocus: "t1")).state.keyboard,
            .terminal("t1"))
    }

    func testTheSidebarWidthFollowsADragInProgress() {
        let snapshot = F.snapshot()
        XCTAssertEqual(arrange(snapshot).state.sidebarWidth, 248)
        XCTAssertEqual(arrange(snapshot, preview: LayoutPreview(sidebarWidth: 300)).state.sidebarWidth, 300)
    }

    func testTheSeamsAreWhereTheLayoutLeavesThem() {
        let workspace = F.workspace("w", agents: [F.agent("a", in: "w", terminal: "t1")])
        let size = LayoutSize(width: 1200, height: 800)
        let split = arrange(F.snapshot([workspace], context: .agent("a"), presentation: .beside, visibleTerminal: "t1"))
        let seams = ShellLayout.seams(size, split.state)
        XCTAssertNotNil(seams.split)
        XCTAssertEqual(seams.split?.width, WindowLayout.splitDivider)
        XCTAssertEqual(seams.terminal?.stacked, true)
        XCTAssertEqual(seams.contentWidth, 1200 - 248)
        // A pointer in the middle of the content area asks for half of it.
        XCTAssertEqual(seams.ratio(atX: seams.workbench.x + seams.contentWidth / 2), 0.5)
        let full = arrange(F.snapshot([workspace], context: .agent("a"), visibleTerminal: "t1"))
        let fullSeams = ShellLayout.seams(size, full.state)
        XCTAssertNil(fullSeams.split)
        XCTAssertEqual(fullSeams.terminal?.stacked, false)
        let seam = fullSeams.terminal!
        XCTAssertEqual(seam.share(atX: seam.rect.x, y: 0)!, seam.share, accuracy: 0.01)
    }

    func testAClickIntoAViewIsThePersonChoosingThatPane() {
        let workspace = F.workspace("w", agents: [F.agent("a", in: "w", terminal: "t1")])
        let onAgent = F.snapshot([workspace], context: .agent("a"), presentation: .beside, visibleTerminal: "t1", paneFocus: "t1")
        XCTAssertEqual(ShellLayout.paneFocused(.terminal("t1"), onAgent), [])
        XCTAssertEqual(ShellLayout.paneFocused(.agents, onAgent), [.focusPane(.content)])
        XCTAssertEqual(ShellLayout.paneFocused(.editor, onAgent), [.focusPane(.content), .swapSplitFocus])
        let noTerminalFocus = F.snapshot([workspace], context: .agent("a"), presentation: .beside)
        XCTAssertEqual(ShellLayout.paneFocused(.terminal("t1"), noTerminalFocus), [.focusPane(.terminal(terminalId: "t1"))])
        XCTAssertEqual(ShellLayout.paneFocused(.editor, noTerminalFocus), [])
    }

    func testResolvesASurfaceKeyToItsTerminal() throws {
        let scratch = Workspace(id: WorkspaceId(unchecked: F.scratchId), location: .local(path: "/tmp/scratch"), selectedPath: "/tmp/scratch")
        let model = AppModel(scratch: scratch)
        let target = try ShellLayout.target(forSurfaceKey: TerminalSurfaceKeys.workspace(F.scratchId), model: model)
        XCTAssertEqual(target, .workspace(machine: .local, workspaceId: F.scratchId, root: "/tmp/scratch"))
        XCTAssertNil(try ShellLayout.target(forSurfaceKey: "workspace-terminal:not-a-uuid", model: model))
        XCTAssertNil(try ShellLayout.target(forSurfaceKey: "agent:\(UUID().uuidString.lowercased())", model: model))
        XCTAssertNil(try ShellLayout.target(forSurfaceKey: "nonsense", model: model))
    }

    func testTheEditorKeyOfASurfaceKey() {
        let snapshot = F.snapshot([F.workspace("w")])
        XCTAssertEqual(ShellLayout.editorKey(forSurfaceKey: "workspace-editor:w", in: snapshot), "/work/w")
        XCTAssertNil(ShellLayout.editorKey(forSurfaceKey: "agent:a", in: snapshot))
        XCTAssertNil(ShellLayout.editorKey(forSurfaceKey: "workspace-editor:gone", in: snapshot))
    }
}

final class SurfaceLabelsTests: XCTestCase {
    func testTheWindowsNameIsWhatIsInFrontTheWorkspaceAndDevHub() {
        let workspace = F.workspace("w", label: "widget", agents: [F.agent("a", in: "w", name: "Claude", activity: "Editing")])
        XCTAssertEqual(SurfaceLabels.windowTitle(F.snapshot([workspace], context: .workspace("w"))), "widget — DevHub")
        XCTAssertEqual(SurfaceLabels.windowTitle(F.snapshot([workspace], context: .agent("a"))), "Editing — widget — DevHub")
        let quiet = F.workspace("w", label: "widget", agents: [F.agent("a", in: "w", name: "Claude")])
        XCTAssertEqual(SurfaceLabels.windowTitle(F.snapshot([quiet], context: .agent("a"))), "Claude — widget — DevHub")
        XCTAssertEqual(SurfaceLabels.windowTitle(element: "  ", workspace: "Scratch"), "Scratch — DevHub")
    }

    func testACloseThatStoppedSaysWhereAndWhy() {
        XCTAssertEqual(
            SurfaceLabels.closeFailure(.worktree, .cleanupFailed, " git said no "),
            "Closing stopped while removing the worktree folder. A cleanup step did not finish. git said no")
        XCTAssertEqual(
            SurfaceLabels.closeFailure(.terminal, .closeTerminalUnknown, nil),
            "Closing stopped while closing the terminal. DevHub could not confirm the terminal had closed.")
    }

    func testAnAgentsFailureLabel() {
        XCTAssertEqual(
            SurfaceLabels.agentFailureLabel(AgentFailure(code: .tmuxCommandFailed, detail: "no server")), "no server")
        XCTAssertEqual(
            SurfaceLabels.agentFailureLabel(AgentFailure(code: .agentProfileUnavailable, detail: "missing claude")),
            "This Agent's profile cannot be used. missing claude")
        XCTAssertEqual(SurfaceLabels.agentFailureLabel(AgentFailure(code: .conversationFailed)), "DevHub stopped following this Agent's conversation.")
    }
}
