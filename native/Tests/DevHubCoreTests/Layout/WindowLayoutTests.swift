// Port of apps/desktop/src/main/shell/windowLayout.test.ts. `chromeVariables`
// (the CSS custom properties the page was handed) has no counterpart: the
// native chrome reads the constants on `WindowLayout` itself, which is what
// the bar's measurements are asserted against here.

import XCTest
@testable import DevHubCore

private let WINDOW = LayoutSize(width: 1440, height: 900)

private func state(
    titleBar: TitleBarMode = .shown, density: DevHubTheme.Density = .compact, sidebarWidth: Double = 248,
    collapsed: Bool = false, surface: SurfaceArrangement = .editor(editorKey: "/a"), keyboard: KeyboardHalf = .editor,
    terminal: (terminalId: String, share: Double)? = nil
) -> LayoutState {
    LayoutState(
        titleBar: titleBar, density: density, sidebarWidth: sidebarWidth, sidebarCollapsed: collapsed, surface: surface,
        keyboard: keyboard, terminal: terminal)
}

private func input(
    state layoutState: LayoutState = state(), editors: [String] = ["/a", "/b"], asking: String? = nil, toasts: LayoutSize? = nil,
    picker: PickerScope = .none, tooltip: TooltipPlacement? = nil, attached: [AttachedPlacement] = [], terminals: [String] = [],
    editorTerminals: [String] = []
) -> LayoutInput {
    LayoutInput(
        windowSize: WINDOW, state: layoutState, editors: editors, asking: asking, toasts: toasts, picker: picker, tooltip: tooltip,
        attached: attached, terminals: terminals, editorTerminals: editorTerminals)
}

/// A view VS Code attached to `/a`, asking for a box in that workbench.
private func attached(id: Int = 1, editorKey: String = "/a", rect: LayoutRect = LayoutRect(x: 10, y: 20, width: 300, height: 200), visible: Bool = true) -> AttachedPlacement {
    AttachedPlacement(id: id, editorKey: editorKey, rect: rect, visible: visible)
}

private func kind(_ identity: ChildIdentity) -> String {
    switch identity {
    case .shell: return "shell"
    case .sidebar: return "sidebar"
    case .agents: return "agents"
    case .editor: return "editor"
    case .attached: return "attached"
    case .terminal: return "terminal"
    case .editorTerminal: return "editorTerminal"
    case .toasts: return "toasts"
    case .picker: return "picker"
    case .tooltip: return "tooltip"
    }
}

private func kinds(_ children: [LayoutChild]) -> [String] { children.map { kind($0.identity) } }

private func rect(_ x: Double, _ y: Double, _ width: Double, _ height: Double) -> LayoutRect {
    LayoutRect(x: x, y: y, width: width, height: height)
}

final class WindowLayoutTests: XCTestCase {
    // MARK: the rectangle the workbench is laid into

    func testIsTheContentAreaMinusTheSidebarAndTheBar() {
        XCTAssertEqual(WindowLayout.workbenchRect(WINDOW, state()), rect(248, 33, 1192, 867))
    }

    func testGivesTheWholeHeightBackWhenThereIsNoBarOfDevHubsOwn() {
        let r = WindowLayout.workbenchRect(WINDOW, state(titleBar: .hidden))
        XCTAssertEqual(r.y, 0)
        XCTAssertEqual(r.height, 900)
    }

    func testFollowsTheSidebarsWidthWithoutAnythingMeasuringIt() {
        let wide = WindowLayout.workbenchRect(WINDOW, state())
        let wider = WindowLayout.workbenchRect(WINDOW, state(sidebarWidth: 400))
        XCTAssertEqual(wide.x, 248)
        XCTAssertEqual(wider.x, 400)
        XCTAssertEqual(wide.width - wider.width, 152)
    }

    func testIsARailsWidthWhenTheSidebarIsCollapsedPerChrome() {
        XCTAssertEqual(WindowLayout.sidebarColumnWidth(state(collapsed: true)), 40)
        XCTAssertEqual(WindowLayout.sidebarColumnWidth(state(density: .comfortable, collapsed: true)), 42)
        XCTAssertEqual(WindowLayout.sidebarColumnWidth(state(titleBar: .hidden, collapsed: true)), 76)
    }

    func testIsTheLeadingShareOfTheAreaInASplitMinusTheSeam() {
        let r = WindowLayout.workbenchRect(WINDOW, state(surface: .split(editorKey: "/a", ratio: 0.5)))
        XCTAssertEqual(r.x, 248)
        XCTAssertEqual(r.width, 593)
    }

    // MARK: the child list

    func testStacksThePageTheWorkbenchesTheNoticesAndTheQuestions() {
        XCTAssertEqual(
            kinds(WindowLayout.compute(input(toasts: LayoutSize(width: 320, height: 90), picker: .window))),
            ["shell", "sidebar", "editor", "editor", "agents", "toasts", "picker", "tooltip"])
    }

    func testHoldsExactlyOneVisibleWorkbenchWhenAWorkspaceIsSelected() {
        let visible = WindowLayout.compute(input()).filter { kind($0.identity) == "editor" && $0.visible }
        XCTAssertEqual(visible.count, 1)
        XCTAssertEqual(visible.first?.identity, .editor(editorKey: "/a"))
    }

    func testPutsTheVisibleWorkbenchLastAmongTheWorkbenches() {
        let editors = WindowLayout.compute(input(state: state(surface: .editor(editorKey: "/b")))).filter { kind($0.identity) == "editor" }
        XCTAssertEqual(editors.last?.visible, true)
        XCTAssertEqual(editors.last?.identity, .editor(editorKey: "/b"))
    }

    func testShowsNoWorkbenchWhenAnAgentFillsTheAreaOrNothingCanBe() {
        for surface in [SurfaceArrangement.agent, .none] {
            let children = WindowLayout.compute(input(state: state(surface: surface)))
            XCTAssertEqual(children.filter { kind($0.identity) == "editor" && $0.visible }.count, 0)
            XCTAssertEqual(children.filter { kind($0.identity) == "editor" }.count, 2)
        }
    }

    func testSizesEveryWorkbenchShownOrNot() {
        let editors = WindowLayout.compute(input()).filter { kind($0.identity) == "editor" }
        XCTAssertEqual(Set(editors.map(\.rect)).count, 1)
    }

    func testParksEveryLayerInTheWindowsCornerWhileItHasNothingToShow() {
        let parked = rect(WINDOW.width - 1, WINDOW.height - 1, WINDOW.width, WINDOW.height)
        for arrangement in [input(), input(toasts: LayoutSize(width: 0, height: 0))] {
            let children = WindowLayout.compute(arrangement)
            XCTAssertEqual(kinds(children), ["shell", "sidebar", "editor", "editor", "agents", "toasts", "picker", "tooltip"])
            for identity in [ChildIdentity.toasts, .picker, .tooltip] {
                XCTAssertEqual(children.first { $0.identity == identity }, LayoutChild(identity: identity, rect: parked, visible: false))
            }
        }
    }

    func testClipsAWorkbenchsQuestionToThatWorkbench() {
        func picker(_ arrangement: LayoutInput) -> LayoutChild? { WindowLayout.compute(arrangement).first { $0.identity == .picker } }
        XCTAssertEqual(picker(input(picker: .workbench))?.rect, WindowLayout.workbenchRect(WINDOW, state()))
        XCTAssertEqual(picker(input(picker: .window))?.rect, rect(0, 0, WINDOW.width, WINDOW.height))
    }

    func testKeepsTheZOrderInEveryArrangement() {
        let arrangements = [
            input(),
            input(attached: [attached()]),
            input(toasts: LayoutSize(width: 300, height: 80), picker: .window, attached: [attached(), attached(id: 2, editorKey: "/b")]),
            input(toasts: LayoutSize(width: 300, height: 80), picker: .window),
            input(asking: "/b", picker: .workbench),
            input(state: state(surface: .agent)),
            input(editors: []),
        ]
        let rank: [String: Int] = [
            "shell": 0, "sidebar": 1, "editor": 2, "attached": 3, "editorTerminal": 3, "agents": 4, "terminal": 5,
            "toasts": 6, "picker": 7, "tooltip": 8,
        ]
        for arrangement in arrangements {
            let order = kinds(WindowLayout.compute(arrangement))
            XCTAssertEqual(order.first, "shell")
            for index in 1..<order.count {
                XCTAssertGreaterThanOrEqual(rank[order[index]]!, rank[order[index - 1]]!, order.joined(separator: ","))
            }
        }
    }

    func testShowsTheWorkbenchThatIsAskingWhateverTheSelectionSays() {
        let visible = WindowLayout.compute(input(state: state(surface: .agent), asking: "/b")).filter { kind($0.identity) == "editor" && $0.visible }
        XCTAssertEqual(visible.first?.identity, .editor(editorKey: "/b"))
    }

    // MARK: where the keyboard goes

    func testGoesToTheWorkbenchOnScreen() {
        XCTAssertEqual(WindowLayout.keyboardChild(input()), .editor(editorKey: "/a"))
    }

    func testGoesToThePageNotToAWorkbenchBeingRebuiltAndKeepsItsSplit() {
        let split = state(surface: .split(editorKey: "/a", ratio: 0.5, hidden: true))
        XCTAssertEqual(WindowLayout.keyboardChild(input(state: split)), .shell)
        XCTAssertEqual(
            WindowLayout.agentsRect(WINDOW, split), WindowLayout.agentsRect(WINDOW, state(surface: .split(editorKey: "/a", ratio: 0.5))))
    }

    func testGoesToTheAgentBesideAWorkbenchNotToTheWorkbench() {
        XCTAssertEqual(
            WindowLayout.keyboardChild(input(state: state(surface: .split(editorKey: "/a", ratio: 0.5), keyboard: .agents))), .agents)
    }

    func testGoesToTheSidebarWhenTheSidebarIsWhatWasAskedFor() {
        XCTAssertEqual(WindowLayout.keyboardChild(input(state: state(keyboard: .sidebar))), .sidebar)
    }

    func testRefusesToPutTheKeysInAnAgentsViewThatIsNotDrawn() {
        XCTAssertEqual(WindowLayout.keyboardChild(input(state: state(surface: .editor(editorKey: "/a"), keyboard: .agents))), .shell)
    }

    func testGoesToAStandingQuestionBeforeAnythingElse() {
        XCTAssertEqual(WindowLayout.keyboardChild(input(picker: .window)), .picker)
    }

    func testGoesToAWorkbenchThatIsAskingEvenOverAnAgent() {
        XCTAssertEqual(WindowLayout.keyboardChild(input(state: state(surface: .agent), asking: "/b")), .editor(editorKey: "/b"))
    }

    // MARK: the Sidebar and the Agents as children of their own

    func testGivesTheSidebarTheLeadingColumnUnderTheBar() {
        XCTAssertEqual(WindowLayout.sidebarRect(WINDOW, state()), rect(0, 33, 248, 867))
    }

    func testLeavesTheTrafficLightsBandToTheWindowsOwnPage() {
        XCTAssertEqual(WindowLayout.sidebarRect(WINDOW, state(titleBar: .hidden)), rect(0, 32, 248, 868))
    }

    func testNarrowsItToTheRailRatherThanTakingItOutOfTheWindow() {
        let rail = WindowLayout.compute(input(state: state(collapsed: true))).first { $0.identity == .sidebar }
        XCTAssertEqual(rail?.visible, true)
        XCTAssertEqual(rail?.rect.width, 40)
    }

    func testIsAlwaysInTheWindowInEveryArrangement() {
        for arrangement in [input(), input(editors: []), input(state: state(surface: .none)), input(toasts: LayoutSize(width: 10, height: 10), picker: .window)] {
            XCTAssertTrue(kinds(WindowLayout.compute(arrangement)).contains("sidebar"))
        }
    }

    func testGivesTheAgentsTheWholeContentAreaWhenOneCoversIt() {
        XCTAssertEqual(WindowLayout.agentsRect(WINDOW, state(surface: .agent)), rect(248, 33, 1192, 867))
    }

    func testGivesTheAgentsTheTrailingShareOfASplitPastTheSeam() {
        let split = state(surface: .split(editorKey: "/a", ratio: 0.5))
        let workbench = WindowLayout.workbenchRect(WINDOW, split)
        let agents = WindowLayout.agentsRect(WINDOW, split)
        XCTAssertEqual(agents.x - (workbench.x + workbench.width), 6)
        XCTAssertEqual(workbench.width + 6 + agents.width, 1192)
    }

    func testDrawsExactlyOneOfTheAgentsAndAWorkbenchForASelection() {
        func onScreen(_ arrangement: LayoutInput) -> [String] {
            WindowLayout.compute(arrangement).filter(\.visible).map { kind($0.identity) }.filter { $0 == "editor" || $0 == "agents" }
        }
        XCTAssertEqual(onScreen(input()), ["editor"])
        XCTAssertEqual(onScreen(input(state: state(surface: .agent))), ["agents"])
        XCTAssertEqual(onScreen(input(state: state(surface: .split(editorKey: "/a", ratio: 0.5)))), ["editor", "agents"])
        XCTAssertEqual(onScreen(input(state: state(surface: .none))), [])
    }

    func testSizesTheAgentsViewEvenWhileItIsNotDrawn() {
        let agents = WindowLayout.compute(input()).first { $0.identity == .agents }
        XCTAssertEqual(agents?.visible, false)
        XCTAssertEqual(agents?.rect, rect(248, 33, 1192, 867))
    }

    // MARK: where a tooltip goes

    private let tipSize = LayoutSize(width: 300, height: 40)

    private func placement(anchor: LayoutRect = LayoutRect(x: 8, y: 100, width: 36, height: 24), size: LayoutSize? = nil) -> TooltipPlacement {
        TooltipPlacement(anchor: anchor, size: size ?? tipSize)
    }

    func testPutsARailsTooltipBesideTheGlyphOutOverTheEditor() {
        let r = WindowLayout.tooltipRect(WINDOW, placement())
        XCTAssertEqual(r, rect(8 + 36 + 6, 100, 300, 40))
        XCTAssertGreaterThan(r.x + r.width, 76)
    }

    func testPutsAnExpandedRowsTooltipBesideItTooNeverUnderIt() {
        XCTAssertEqual(WindowLayout.tooltipRect(WINDOW, placement(anchor: rect(0, 100, 248, 26))), rect(248 + 6, 100, 300, 40))
    }

    func testFlipsToTheOtherSideOfTheAnchorAtTheTrailingEdge() {
        let r = WindowLayout.tooltipRect(WINDOW, placement(anchor: rect(1300, 100, 36, 24)))
        XCTAssertEqual(r.x, 1300 - 6 - 300)
        XCTAssertEqual(r.width, 300)
    }

    func testLiftsATooltipAtTheBottomEdgeRatherThanDroppingItBelow() {
        let r = WindowLayout.tooltipRect(WINDOW, placement(anchor: rect(8, 890, 36, 24)))
        XCTAssertLessThanOrEqual(r.y, 890)
        XCTAssertLessThanOrEqual(r.y + r.height, WINDOW.height)
        XCTAssertEqual(r.height, 40)
    }

    func testClampsAVeryWideTooltipToTheWindowStillBesideTheRow() {
        let r = WindowLayout.tooltipRect(WINDOW, placement(anchor: rect(0, 100, 248, 26), size: LayoutSize(width: WINDOW.width - 20, height: 40)))
        XCTAssertEqual(r.y, 100)
        XCTAssertLessThanOrEqual(r.x + r.width, WINDOW.width)
        XCTAssertEqual(r.width, WINDOW.width - 20)
    }

    func testIsClampedToTheWindowWhenEvenTheFlipDoesNotFit() {
        let r = WindowLayout.tooltipRect(WINDOW, placement(anchor: rect(2, 890, 36, 24)))
        XCTAssertGreaterThanOrEqual(r.x, 4)
        XCTAssertGreaterThanOrEqual(r.y, 4)
        XCTAssertLessThanOrEqual(r.x + r.width, WINDOW.width)
        XCTAssertLessThanOrEqual(r.y + r.height, WINDOW.height)
    }

    func testNeverGrowsPastTheWindowHoweverLongTheSentenceIs() {
        let r = WindowLayout.tooltipRect(WINDOW, placement(size: LayoutSize(width: 4000, height: 3000)))
        XCTAssertEqual(r.width, WINDOW.width)
        XCTAssertEqual(r.height, WINDOW.height)
    }

    func testIsOverTheWindowExactlyWhenATooltipIsUp() {
        func tooltip(_ arrangement: LayoutInput) -> LayoutChild? { WindowLayout.compute(arrangement).first { $0.identity == .tooltip } }
        XCTAssertEqual(tooltip(input())?.visible, false)
        XCTAssertEqual(
            tooltip(input(tooltip: placement())),
            LayoutChild(identity: .tooltip, rect: WindowLayout.tooltipRect(WINDOW, placement()), visible: true))
    }

    func testIsTheTopmostChildOfAllAboveTheQuestions() {
        XCTAssertEqual(
            kinds(WindowLayout.compute(input(toasts: LayoutSize(width: 320, height: 90), picker: .window, tooltip: placement()))),
            ["shell", "sidebar", "editor", "editor", "agents", "toasts", "picker", "tooltip"])
    }

    func testNeverTakesTheKeyboard() {
        XCTAssertNotEqual(WindowLayout.keyboardChild(input(tooltip: placement())), .tooltip)
    }

    // MARK: a view a workbench attached to itself

    func testIsPlacedInTheWindowByTranslatingTheWorkbenchsOrigin() {
        let child = WindowLayout.compute(input(attached: [attached()])).first { kind($0.identity) == "attached" }
        let workbench = WindowLayout.workbenchRect(WINDOW, state())
        XCTAssertEqual(child?.rect, rect(workbench.x + 10, workbench.y + 20, 300, 200))
    }

    func testMovesWithTheWorkbenchWhenTheSidebarNarrows() {
        let collapsed = state(collapsed: true)
        let child = WindowLayout.compute(input(state: collapsed, attached: [attached()])).first { kind($0.identity) == "attached" }
        XCTAssertEqual(child?.rect.x, WindowLayout.workbenchRect(WINDOW, collapsed).x + 10)
    }

    func testIsClippedToItsWorkbenchNeverOverTheSidebarOrAnAgent() {
        let workbench = WindowLayout.workbenchRect(WINDOW, state())
        XCTAssertEqual(
            WindowLayout.insideRect(workbench, rect(-50, -50, workbench.width + 500, workbench.height + 500)), workbench)
        XCTAssertEqual(
            WindowLayout.insideRect(workbench, rect(workbench.width + 10, 0, 100, 100)),
            rect(workbench.x + workbench.width, workbench.y, 0, 100))
    }

    func testIsDrawnOnlyWhenItsWorkbenchIsTheOneOnScreen() {
        func drawn(_ arrangement: LayoutInput) -> [Bool] {
            WindowLayout.compute(arrangement).filter { kind($0.identity) == "attached" }.map(\.visible)
        }
        XCTAssertEqual(drawn(input(attached: [attached()])), [true])
        XCTAssertEqual(drawn(input(attached: [attached(visible: false)])), [false])
        XCTAssertEqual(drawn(input(state: state(surface: .editor(editorKey: "/b")), attached: [attached()])), [false])
        XCTAssertEqual(drawn(input(state: state(surface: .agent), attached: [attached()])), [false])
    }

    func testIsSizedWhetherOrNotItIsDrawnLikeTheWorkbenches() {
        let hidden = WindowLayout.compute(input(state: state(surface: .editor(editorKey: "/b")), attached: [attached()])).first { kind($0.identity) == "attached" }
        let shown = WindowLayout.compute(input(attached: [attached()])).first { kind($0.identity) == "attached" }
        XCTAssertEqual(hidden?.rect, shown?.rect)
    }

    func testSitsAboveEveryWorkbenchAndBelowTheNoticesAndTheQuestions() {
        XCTAssertEqual(
            kinds(WindowLayout.compute(input(toasts: LayoutSize(width: 300, height: 80), picker: .window, tooltip: placement(), attached: [attached()]))),
            ["shell", "sidebar", "editor", "editor", "attached", "agents", "toasts", "picker", "tooltip"])
    }

    func testTellsItsViewsApartSoTheOwnerCanPlaceEachOne() {
        let children = WindowLayout.compute(input(attached: [attached(), attached(id: 2, rect: rect(0, 0, 10, 10))]))
            .filter { kind($0.identity) == "attached" }
        XCTAssertEqual(children.map(\.identity), [.attached(editorKey: "/a", id: 1), .attached(editorKey: "/a", id: 2)])
    }

    // MARK: the title bar and the traffic lights

    func testIsAPlainTitledWindowsBar() {
        XCTAssertEqual(WindowLayout.titleBarHeight, 32)
    }

    func testCentresTheLightsOnTheBarsMiddleLine() {
        XCTAssertEqual(WindowLayout.trafficLightPosition().y + WindowLayout.trafficLightSize / 2, WindowLayout.titleBarHeight / 2)
    }

    func testInsetsTheLightsAsFarFromTheLeadingEdgeAsFromTheTop() {
        XCTAssertEqual(WindowLayout.trafficLightPosition().x, 9)
        XCTAssertEqual(WindowLayout.trafficLightPosition().y, 9)
    }

    func testKeepsTheLightsInsideTheSpanThePageLeavesThem() {
        XCTAssertLessThan(WindowLayout.trafficLightPosition().x + 2 * 23 + WindowLayout.trafficLightSize, WindowLayout.trafficLightSpan)
    }

    func testStartsTheContentAreaUnderTheBarAndItsHairline() {
        let bar = WindowLayout.titleBarHeight
        XCTAssertEqual(WindowLayout.surfaceRect(WINDOW, state()).y, bar + 1)
        XCTAssertEqual(WindowLayout.sidebarRect(WINDOW, state()).y, bar + 1)
        XCTAssertEqual(WindowLayout.sidebarRect(WINDOW, state(titleBar: .hidden)).y, bar)
        XCTAssertEqual(WindowLayout.surfaceRect(WINDOW, state(titleBar: .hidden)).y, 0)
    }

    // MARK: the Agent's terminal, with its Agent

    private let T1 = "11111111-1111-4111-8111-111111111111"
    private let T2 = "22222222-2222-4222-8222-222222222222"

    private func terminalChild(_ layoutState: LayoutState, _ id: String? = nil) -> LayoutChild? {
        let id = id ?? T1
        return WindowLayout.compute(input(state: layoutState, terminals: [T1, T2])).first { $0.identity == .terminal(terminalId: id) }
    }

    func testLaysAFullAgentInsideTheContentAndTheTerminalRightOfIt() {
        let full = state(surface: .agent, terminal: (T1, 0.4))
        let area = WindowLayout.surfaceRect(WINDOW, full)
        let terminalWidth = ((area.width - 6) * 0.4).rounded()
        let contentWidth = area.width - 6 - terminalWidth
        XCTAssertEqual(WindowLayout.agentsRect(WINDOW, full), rect(area.x, area.y, contentWidth, area.height))
        XCTAssertFalse(WindowLayout.terminalStacked(full))
        XCTAssertEqual(WindowLayout.terminalExtent(WINDOW, full), area)
        XCTAssertEqual(WindowLayout.terminalSeam(WINDOW, full), rect(area.x + contentWidth, area.y, 6, area.height))
        let child = terminalChild(full)
        XCTAssertEqual(child?.visible, true)
        XCTAssertEqual(child?.rect, rect(area.x + contentWidth + 6, area.y, terminalWidth, area.height))
        XCTAssertEqual(terminalChild(full, T2)?.visible, false)
    }

    func testInASplitKeepsTheEditorTheWholeLeftHalfAndPutsTheTerminalUnderTheAgent() {
        let split = state(surface: .split(editorKey: "/a", ratio: 0.5), terminal: (T1, 0.4))
        let area = WindowLayout.surfaceRect(WINDOW, split)
        let editor = WindowLayout.workbenchRect(WINDOW, split)
        let agents = WindowLayout.agentsRect(WINDOW, split)
        XCTAssertEqual(editor, WindowLayout.workbenchRect(WINDOW, state(surface: .split(editorKey: "/a", ratio: 0.5))))
        XCTAssertEqual(editor.height, area.height)
        let half = rect(editor.x + editor.width + 6, area.y, area.x + area.width - (editor.x + editor.width + 6), area.height)
        XCTAssertTrue(WindowLayout.terminalStacked(split))
        XCTAssertEqual(WindowLayout.terminalExtent(WINDOW, split), half)
        let terminalHeight = ((area.height - 6) * 0.4).rounded()
        let agentHeight = area.height - 6 - terminalHeight
        XCTAssertEqual(agents, rect(half.x, half.y, half.width, agentHeight))
        XCTAssertEqual(WindowLayout.terminalSeam(WINDOW, split), rect(half.x, area.y + agentHeight, half.width, 6))
        let child = terminalChild(split)
        XCTAssertEqual(child?.visible, true)
        XCTAssertEqual(child?.rect, rect(half.x, area.y + agentHeight + 6, half.width, terminalHeight))
    }

    func testIsNeverDrawnWithTheWorkbenchAlone() {
        let editorOnly = state(terminal: (T1, 0.4))
        XCTAssertNil(WindowLayout.terminalSeam(WINDOW, editorOnly))
        XCTAssertNil(WindowLayout.terminalExtent(WINDOW, editorOnly))
        XCTAssertEqual(WindowLayout.workbenchRect(WINDOW, editorOnly), WindowLayout.surfaceRect(WINDOW, editorOnly))
        XCTAssertEqual(terminalChild(editorOnly)?.visible, false)
    }

    func testIsTheWholeAreaForTheContentWhenNoTerminalIsShown() {
        XCTAssertNil(WindowLayout.terminalSeam(WINDOW, state()))
        XCTAssertEqual(WindowLayout.contentRect(WINDOW, state()), WindowLayout.surfaceRect(WINDOW, state()))
    }

    func testGivesTheKeyboardToTheTerminalOnScreenAndToTheContentOtherwise() {
        let withTerminal = state(surface: .split(editorKey: "/a", ratio: 0.5), keyboard: .terminal(T1), terminal: (T1, 0.4))
        XCTAssertEqual(WindowLayout.keyboardChild(input(state: withTerminal, terminals: [T1])), .terminal(terminalId: T1))
        XCTAssertEqual(WindowLayout.keyboardChild(input(state: withTerminal)), .editor(editorKey: "/a"))
        var nothing = withTerminal
        nothing.surface = .none
        XCTAssertEqual(WindowLayout.keyboardChild(input(state: nothing, terminals: [T1])), .shell)
    }

    func testStacksTheTerminalOverTheContentsViewsAndUnderEveryLayer() {
        let order = kinds(WindowLayout.compute(input(state: state(surface: .split(editorKey: "/a", ratio: 0.5), terminal: (T1, 0.4)), terminals: [T1])))
        XCTAssertGreaterThan(order.firstIndex(of: "terminal")!, order.firstIndex(of: "agents")!)
        XCTAssertLessThan(order.firstIndex(of: "terminal")!, order.firstIndex(of: "toasts")!)
    }

    // MARK: terminal mode's editor area

    private func terminalMode(state layoutState: LayoutState = state()) -> LayoutInput {
        input(state: layoutState, editors: [], editorTerminals: ["/a", "/b"])
    }

    func testLaysTheSelectedWorkspacesTerminalWhereItsWorkbenchWouldBeAndOnlyIt() {
        let children = WindowLayout.compute(terminalMode())
        let terminals = children.filter { kind($0.identity) == "editorTerminal" }
        XCTAssertEqual(terminals.map(\.identity), [.editorTerminal(editorKey: "/b"), .editorTerminal(editorKey: "/a")])
        XCTAssertEqual(terminals.map(\.visible), [false, true])
        for child in terminals { XCTAssertEqual(child.rect, WindowLayout.workbenchRect(WINDOW, state())) }
        XCTAssertFalse(kinds(children).contains("editor"))
    }

    func testIsTheLeftHalfOfASplitWithTheAgentBesideIt() {
        let split = state(surface: .split(editorKey: "/a", ratio: 0.5), keyboard: .agents)
        let children = WindowLayout.compute(terminalMode(state: split))
        let shown = children.first { kind($0.identity) == "editorTerminal" && $0.visible }
        XCTAssertEqual(shown?.rect, WindowLayout.workbenchRect(WINDOW, split))
        let agents = children.first { $0.identity == .agents }
        XCTAssertEqual(agents?.visible, true)
        XCTAssertGreaterThan(agents?.rect.x ?? 0, (shown?.rect.x ?? 0) + (shown?.rect.width ?? 0))
    }

    func testIsNotDrawnUnderAFullAgentButStaysSized() {
        let children = WindowLayout.compute(terminalMode(state: state(surface: .agent)))
        XCTAssertEqual(children.filter { kind($0.identity) == "editorTerminal" && $0.visible }, [])
        XCTAssertEqual(WindowLayout.onScreenEditorTerminal(terminalMode()), "/a")
    }

    func testDrawsNothingForAWorkspaceThatHasNoTerminalViewWhichThePageSpeaksFor() {
        let ssh = terminalMode(state: state(surface: .editor(editorKey: "/ssh")))
        XCTAssertFalse(WindowLayout.compute(ssh).contains { kind($0.identity) == "editorTerminal" && $0.visible })
        XCTAssertEqual(WindowLayout.keyboardChild(ssh), .shell)
    }

    func testTakesTheKeyboardAsTheEditorHalfInTheSplitAndAlone() {
        XCTAssertEqual(WindowLayout.keyboardChild(terminalMode()), .editorTerminal(editorKey: "/a"))
        let split = state(surface: .split(editorKey: "/a", ratio: 0.5))
        XCTAssertEqual(WindowLayout.keyboardChild(terminalMode(state: split)), .editorTerminal(editorKey: "/a"))
        var agents = split
        agents.keyboard = .agents
        XCTAssertEqual(WindowLayout.keyboardChild(terminalMode(state: agents)), .agents)
    }

    func testFallsBackToTheEditorAreaFromAnAgentTerminalThatIsNotOnScreen() {
        let split = state(surface: .split(editorKey: "/a", ratio: 0.5), keyboard: .terminal("t1"))
        XCTAssertEqual(WindowLayout.keyboardChild(terminalMode(state: split)), .editorTerminal(editorKey: "/a"))
    }
}
