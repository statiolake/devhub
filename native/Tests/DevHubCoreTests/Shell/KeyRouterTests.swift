// Port of apps/desktop/src/main/shell/keyRouter.test.ts, historyKeys.test.ts,
// terminalZoom.test.ts, editingCommands.test.ts, chordInputSource.test.ts and
// shell/surfaces/keys.test.ts.

import XCTest
@testable import DevHubCore

/// A stroke from the character and the physical key, built through the same
/// function the app builds one with.
private func press(
    _ key: String, _ code: String, command: Bool = false, shift: Bool = false, option: Bool = false, control: Bool = false,
    isAutoRepeat: Bool = false
) -> KeyStroke {
    KeyStroke(key: ChordKeys.strokeKey(key), code: code, command: command, control: control, option: option, shift: shift, isAutoRepeat: isAutoRepeat)
}

/// A key whose character is its own lower-case letter or digit.
private func stroke(_ code: String, command: Bool = false, shift: Bool = false, option: Bool = false, control: Bool = false) -> KeyStroke {
    var character = code
    if code.hasPrefix("Key") { character = code.dropFirst(3).lowercased() }
    if code.hasPrefix("Digit") { character = String(code.dropFirst(5)) }
    return press(character, code, command: command, shift: shift, option: option, control: control)
}

private let commandQ = stroke("KeyQ", command: true)

private final class Heard: ArmingListener {
    var events: [String] = []
    func armed() { events.append("armed") }
    func disarmed() { events.append("disarmed") }
}

final class KeyRouterTests: XCTestCase {
    private var router: KeyRouter!
    private var heard: Heard!

    override func setUp() {
        heard = Heard()
        router = KeyRouter(layout: .defaults(), listener: heard, retain: true)
    }

    func testSwallowsTheFirstCommandQAndArmsInsteadOfQuitting() {
        XCTAssertEqual(router.route(commandQ), .armed)
        XCTAssertTrue(router.isArmed)
    }

    func testForwardsTheSecondCommandQ() {
        _ = router.route(commandQ)
        XCTAssertEqual(router.route(commandQ), .forward)
    }

    func testStaysArmedHoweverLongItWaitsForTheNextKey() {
        _ = router.route(commandQ)
        XCTAssertTrue(router.isArmed)
        XCTAssertEqual(router.route(stroke("KeyF")), .run(.addWorkspace))
    }

    func testLeavesEveryOtherKeyAloneWhileNothingIsArmed() {
        for key in [
            stroke("KeyW", command: true), stroke("KeyN", command: true), stroke("Digit1", command: true),
            stroke("KeyK", control: true), stroke("KeyA"), stroke("KeyZ"), stroke("Digit3"), stroke("KeyP", shift: true),
        ] {
            XCTAssertEqual(router.route(key), .pass, key.code)
        }
    }

    func testRunsABoundSecondStrokeAndSwallowsAnUnboundOne() {
        _ = router.route(commandQ)
        XCTAssertEqual(router.route(stroke("KeyF")), .run(.addWorkspace))
        _ = router.route(commandQ)
        XCTAssertEqual(router.route(stroke("KeyY")), .cancelled)
    }

    func testDoesNotArmAndFireOnOneHeldDownPrefix() {
        var held = commandQ
        held.isAutoRepeat = true
        XCTAssertEqual(router.route(held), .consume)
        XCTAssertFalse(router.isArmed)
    }

    func testTakesItsLayoutAsDataSoAnOverrideIsAnotherTable() throws {
        let overridden = KeyRouter(
            layout: ChordLayout(prefix: try ChordKeys.parse("Ctrl+q"), table: [KeyBinding(key: try ChordKeys.parse("s"), commandId: .openSettings)]),
            listener: nil)
        XCTAssertEqual(overridden.route(commandQ), .pass)
        _ = overridden.route(stroke("KeyQ", control: true))
        XCTAssertEqual(overridden.route(stroke("KeyS")), .run(.openSettings))
    }

    func testDropsAnArmedPrefixWhenTheTableChangesUnderneathIt() {
        _ = router.route(commandQ)
        router.setLayout(.defaults())
        XCTAssertEqual(router.route(stroke("KeyF")), .pass)
    }

    // MARK: a modifier pressed after the prefix

    private func chord(_ modifierCode: String, _ second: KeyStroke) -> (RouteDecision, RouteDecision) {
        _ = router.route(commandQ)
        let held = router.route(press("Shift", modifierCode, shift: true))
        return (held, router.route(second))
    }

    func testKeepsTheChordArmedForShiftPAndShiftN() {
        let p = chord("ShiftLeft", press("P", "KeyP", shift: true))
        XCTAssertEqual(p.0, .pass)
        XCTAssertEqual(p.1, .run(.previousWorkspace))
        let n = chord("ShiftRight", press("N", "KeyN", shift: true))
        XCTAssertEqual(n.0, .pass)
        XCTAssertEqual(n.1, .run(.nextWorkspace))
    }

    func testKeepsItArmedForShiftCommaWhichIsSettings() {
        let result = chord("ShiftLeft", press("<", "Comma", shift: true))
        XCTAssertEqual(result.1, .run(.openSettings))
    }

    func testKeepsItArmedForTheCommandChords() {
        XCTAssertEqual(chord("MetaLeft", press("n", "KeyN", command: true)).1, .run(.nextTab))
        XCTAssertEqual(chord("MetaLeft", press("j", "KeyJ", command: true)).1, .run(.toggleWorkspaceAgent))
    }

    func testStillWorksForTheUnshiftedChords() {
        _ = router.route(commandQ)
        XCTAssertEqual(router.route(stroke("KeyF")), .run(.addWorkspace))
        _ = router.route(commandQ)
        XCTAssertEqual(router.route(press(",", "Comma")), .run(.renameAgent))
        _ = router.route(commandQ)
        XCTAssertEqual(router.route(stroke("Digit1")), .run(.selectEntry1))
    }

    func testLeavesABareModifierAloneWhenNothingIsArmed() {
        XCTAssertEqual(router.route(press("Shift", "ShiftLeft", shift: true)), .pass)
    }

    // MARK: a chord on a US and a JIS keyboard

    private func second(_ key: String, _ code: String, shift: Bool = true) -> RouteDecision {
        _ = router.route(commandQ)
        _ = router.route(press("Shift", "ShiftLeft", shift: shift))
        return router.route(press(key, code, shift: shift))
    }

    func testUSAndJISKeyboards() {
        let rows: [(String, String, CommandId?, Bool)] = [
            ("[", "BracketLeft", .previousAgent, false), ("]", "BracketRight", .nextAgent, false),
            ("{", "BracketLeft", .previousUnreadAgent, true), ("}", "BracketRight", .nextUnreadAgent, true),
            ("<", "Comma", .openSettings, true), ("?", "Slash", .showChordHelp, true), ("N", "KeyN", .nextWorkspace, true),
            // JIS
            ("[", "BracketRight", .previousAgent, false), ("]", "Backslash", .nextAgent, false),
            ("{", "BracketRight", .previousUnreadAgent, true), ("}", "Backslash", .nextUnreadAgent, true),
            ("@", "BracketLeft", nil, true),
        ]
        for (key, code, command, shift) in rows {
            XCTAssertEqual(second(key, code, shift: shift), command.map { .run($0) } ?? .cancelled, "\(key) \(code)")
        }
    }

    // MARK: the arming, as the router reports it

    func testReportsThePrefix() {
        _ = router.route(commandQ)
        XCTAssertEqual(heard.events, ["armed"])
    }

    func testReportsTheEndOfTheChordOnEveryWayItEnds() {
        for second in [stroke("KeyF"), stroke("KeyY"), commandQ] {
            heard.events = []
            _ = router.route(commandQ)
            _ = router.route(second)
            XCTAssertEqual(heard.events, ["armed", "disarmed"])
        }
    }

    func testDoesNotEndTheChordOnABareModifier() {
        _ = router.route(commandQ)
        _ = router.route(press("Shift", "ShiftLeft", shift: true))
        XCTAssertEqual(heard.events, ["armed"])
    }

    func testReportsTheEndWhenTheTableChanges() {
        _ = router.route(commandQ)
        router.setLayout(.defaults())
        XCTAssertEqual(heard.events, ["armed", "disarmed"])
    }

    func testReportsTheEndWhenDevHubIsLeftAndEndsTheChord() {
        _ = router.route(commandQ)
        router.leave()
        XCTAssertEqual(heard.events, ["armed", "disarmed"])
        XCTAssertEqual(router.route(stroke("KeyF")), .pass)
    }

    func testSaysNothingWhenNothingWasArmed() {
        router.leave()
        router.setLayout(.defaults())
        _ = router.route(stroke("KeyF"))
        XCTAssertEqual(heard.events, [])
    }

    func testReportsAHeldDownPrefixAsOver() {
        _ = router.route(commandQ)
        var held = commandQ
        held.isAutoRepeat = true
        _ = router.route(held)
        XCTAssertEqual(heard.events, ["armed", "disarmed"])
    }

    func testTheLayoutIsTheConfiguredOne() throws {
        let spec = KeybindingsSpec(prefix: "Ctrl+q")
        XCTAssertEqual(ChordLayout.of(spec).prefix, try ChordKeys.parse("Ctrl+q"))
        XCTAssertEqual(ChordLayout.of(nil), .defaults())
    }
}

final class MacKeysTests: XCTestCase {
    func testNamesThePhysicalKeysByTheirDOMCodes() {
        XCTAssertEqual(MacKeys.code(0x0C), "KeyQ")
        XCTAssertEqual(MacKeys.code(0x1B), "Minus")
        XCTAssertEqual(MacKeys.code(0x1D), "Digit0")
        XCTAssertEqual(MacKeys.code(0x38), "ShiftLeft")
        XCTAssertEqual(MacKeys.code(0x7E), "ArrowUp")
    }

    func testReadsTheCharacterOrTheKeysName() {
        XCTAssertEqual(MacKeys.key(characters: "q", keyCode: 0x0C), "q")
        XCTAssertEqual(MacKeys.key(characters: "N", keyCode: 0x2D), "N")
        XCTAssertEqual(MacKeys.key(characters: "\u{F700}", keyCode: 0x7E), "ArrowUp")
        XCTAssertEqual(MacKeys.key(characters: "\u{1B}", keyCode: 0x35), "Escape")
        XCTAssertEqual(MacKeys.key(characters: nil, keyCode: 0x99), "Unidentified")
    }

    func testAStrokeIsTheCharacterWithShiftFoldedIn() {
        let shiftedP = MacKeys.stroke(characters: "P", keyCode: 0x23, command: false, control: false, option: false, shift: true, isAutoRepeat: false)
        XCTAssertEqual(shiftedP.key, "P")
        XCTAssertEqual(shiftedP.code, "KeyP")
        let arrow = MacKeys.stroke(characters: "\u{F700}", keyCode: 0x7E, command: false, control: false, option: true, shift: false, isAutoRepeat: false)
        XCTAssertEqual(arrow.key, "arrowup")
        let router = KeyRouter(layout: .defaults(), listener: nil)
        let q = MacKeys.stroke(characters: "q", keyCode: 0x0C, command: true, control: false, option: false, shift: false, isAutoRepeat: false)
        XCTAssertEqual(router.route(q), .armed)
        XCTAssertEqual(router.route(arrow), .run(.moveEntryUp))
    }
}

final class ShellKeysTests: XCTestCase {
    private func bracket(_ key: String, command: Bool = true, shift: Bool = false, option: Bool = false) -> KeyStroke {
        KeyStroke(key: key, code: key == "[" ? "BracketLeft" : "BracketRight", command: command, option: option, shift: shift)
    }

    func testBackAndForwardAreCmdBracketsOnDevHubsOwnSurfaces() {
        for surface in [KeySurface.shell, .sidebar, .agents, .pane] {
            XCTAssertEqual(ShellKeys.historyDirection(surface, bracket("[")), .back)
            XCTAssertEqual(ShellKeys.historyDirection(surface, bracket("]")), .forward)
        }
    }

    func testBackAndForwardAreNothingWhereAQuestionHoldsTheKeyboard() {
        XCTAssertNil(ShellKeys.historyDirection(.picker, bracket("[")))
        XCTAssertNil(ShellKeys.historyDirection(.settings, bracket("[")))
        XCTAssertFalse(ShellKeys.isAppHistorySurface(.picker))
    }

    func testBackAndForwardMatchTheModifiersExactly() {
        XCTAssertNil(ShellKeys.historyDirection(.agents, bracket("[", shift: true)))
        XCTAssertNil(ShellKeys.historyDirection(.agents, bracket("[", option: true)))
        XCTAssertNil(ShellKeys.historyDirection(.agents, bracket("[", command: false)))
    }

    func testTheOtherGestures() {
        XCTAssertEqual(ShellKeys.mouseButtonDirection(3), .back)
        XCTAssertEqual(ShellKeys.mouseButtonDirection(4), .forward)
        XCTAssertNil(ShellKeys.mouseButtonDirection(2))
        XCTAssertEqual(ShellKeys.swipeDirection(deltaX: 1), .back)
        XCTAssertEqual(ShellKeys.swipeDirection(deltaX: -1), .forward)
        XCTAssertNil(ShellKeys.swipeDirection(deltaX: 0))
    }

    private func zoomKey(_ code: String, _ key: String, command: Bool = true, shift: Bool = false, option: Bool = false, control: Bool = false) -> KeyStroke {
        KeyStroke(key: key, code: code, command: command, control: control, option: option, shift: shift)
    }

    func testZoomsInOnCmdShiftMinusAndOutOnCmdMinus() {
        XCTAssertEqual(ShellKeys.terminalZoom(.agents, zoomKey("Minus", "_", shift: true)), .zoomIn)
        XCTAssertEqual(ShellKeys.terminalZoom(.agents, zoomKey("Minus", "-")), .zoomOut)
        // The same key on a JIS keyboard, which types a different character.
        XCTAssertEqual(ShellKeys.terminalZoom(.pane, zoomKey("Minus", "=", shift: true)), .zoomIn)
        XCTAssertEqual(ShellKeys.terminalZoom(.agents, zoomKey("Digit0", ")", shift: true)), .reset)
        XCTAssertNil(ShellKeys.terminalZoom(.agents, zoomKey("Digit0", "0")))
    }

    func testZoomMeansNothingOnAnyOtherSurface() {
        for surface in [KeySurface.shell, .sidebar, .picker, .toasts, .settings, .other] {
            XCTAssertNil(ShellKeys.terminalZoom(surface, zoomKey("Minus", "-")))
        }
        XCTAssertNil(ShellKeys.terminalZoom(.agents, zoomKey("Minus", "-", command: false)))
        XCTAssertNil(ShellKeys.terminalZoom(.agents, zoomKey("Minus", "-", option: true)))
        XCTAssertNil(ShellKeys.terminalZoom(.agents, zoomKey("Minus", "-", control: true)))
        XCTAssertNil(ShellKeys.terminalZoom(.agents, zoomKey("Equal", "=")))
    }

    private func edit(_ key: String, shift: Bool = false, option: Bool = false, control: Bool = false) -> KeyStroke {
        KeyStroke(key: key, code: "", command: true, control: control, option: option, shift: shift)
    }

    func testTheEditingKeysOfAMacTextBox() {
        XCTAssertEqual(
            ["a", "c", "v", "x", "z"].compactMap { ShellKeys.editingCommand(.settings, edit($0))?.role },
            [.selectAll, .copy, .paste, .cut, .undo])
        XCTAssertEqual(ShellKeys.editingCommand(.settings, edit("Z", shift: true))?.role, .redo)
        XCTAssertEqual(ShellKeys.editingCommand(.sidebar, edit("A"))?.role, .selectAll)
        XCTAssertNil(ShellKeys.editingCommand(.other, edit("a")))
        XCTAssertNil(ShellKeys.editingCommand(.settings, edit("a", option: true)))
        XCTAssertNil(ShellKeys.editingCommand(.settings, edit("a", control: true)))
        XCTAssertNil(ShellKeys.editingCommand(.settings, edit("arrowleft")))
        let roles = ShellKeys.editingGroups.flatMap { $0 }.map(\.role)
        XCTAssertEqual(Set(roles).count, roles.count)
        let keys = ShellKeys.editingGroups.flatMap { $0 }.compactMap { command in command.key.map { "\($0)\(command.shift)" } }
        XCTAssertEqual(Set(keys).count, keys.count)
    }

    func testThePassBranchAsksHistoryThenZoomThenEditing() {
        XCTAssertEqual(ShellKeys.passMeaning(.agents, bracket("[")), .history(.back))
        XCTAssertEqual(ShellKeys.passMeaning(.pane, zoomKey("Minus", "-")), .zoom(.zoomOut))
        XCTAssertEqual(ShellKeys.passMeaning(.sidebar, edit("c")), .editing(.copy))
        XCTAssertNil(ShellKeys.passMeaning(.agents, KeyStroke(key: "a", code: "KeyA")))
    }

    func testTheMacEditingChordsAreGhosttysBytes() {
        func bytes(_ key: String, command: Bool = false, option: Bool = false, control: Bool = false, shift: Bool = false) -> [UInt8]? {
            ShellKeys.terminalEditingSequence(key: key, command: command, option: option, control: control, shift: shift)
        }
        XCTAssertEqual(bytes("arrowleft", command: true), [0x01])
        XCTAssertEqual(bytes("arrowright", command: true), [0x05])
        XCTAssertEqual(bytes("backspace", command: true), [0x15])
        XCTAssertEqual(bytes("arrowleft", option: true), [0x1b, 0x62])
        XCTAssertEqual(bytes("arrowright", option: true), [0x1b, 0x66])
        XCTAssertNil(bytes("arrowleft", command: true, shift: true))
        XCTAssertNil(bytes("arrowleft", command: true, control: true))
        XCTAssertNil(bytes("arrowleft", command: true, option: true))
        XCTAssertNil(bytes("c", command: true))
        XCTAssertNil(bytes("arrowleft"))
    }
}

private final class FakeInputSources: InputSourcePort {
    static let japanese = "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese"
    static let abc = "com.apple.keylayout.ABC"
    var current = japanese
    var log: [String] = []
    var failure: Error?

    struct Broken: Error {}

    func selectAscii() throws -> InputSourceSwitch? {
        log.append("ascii")
        if let failure { throw failure }
        if current == Self.abc { return nil }
        let change = InputSourceSwitch(previous: current, selected: Self.abc)
        current = Self.abc
        return change
    }

    func restore(_ change: InputSourceSwitch) throws -> Bool {
        log.append("restore \(change.previous)")
        if let failure { throw failure }
        if current != change.selected { return false }
        current = change.previous
        return true
    }
}

final class ChordInputSourceTests: XCTestCase {
    func testSelectsAnAsciiSourceWhileTheChordIsArmedAndPutsThePreviousOneBack() {
        let port = FakeInputSources()
        let source = ChordInputSource(port: port) { _ in XCTFail("no failure") }
        source.armed()
        XCTAssertEqual(port.current, FakeInputSources.abc)
        source.disarmed()
        XCTAssertEqual(port.current, FakeInputSources.japanese)
    }

    func testDoesNotFightASourceThePersonChoseWhileArmed() {
        let port = FakeInputSources()
        let source = ChordInputSource(port: port) { _ in }
        source.armed()
        port.current = "com.apple.keylayout.Dvorak"
        source.disarmed()
        XCTAssertEqual(port.current, "com.apple.keylayout.Dvorak")
    }

    func testTouchesNothingWhenTheSourceWasAsciiAlready() {
        let port = FakeInputSources()
        port.current = FakeInputSources.abc
        let source = ChordInputSource(port: port) { _ in }
        source.armed()
        source.disarmed()
        XCTAssertEqual(port.log, ["ascii"])
    }

    func testKeepsOneChordsRestoreAheadOfTheNextChordsSwitch() {
        let port = FakeInputSources()
        let source = ChordInputSource(port: port) { _ in }
        source.armed()
        source.disarmed()
        source.armed()
        XCTAssertEqual(port.log, ["ascii", "restore \(FakeInputSources.japanese)", "ascii"])
        source.disarmed()
        XCTAssertEqual(port.current, FakeInputSources.japanese)
    }

    func testSaysAFailureOnceAndAsksNothingMore() {
        let port = FakeInputSources()
        port.failure = FakeInputSources.Broken()
        var reported = 0
        let source = ChordInputSource(port: port) { _ in reported += 1 }
        source.armed()
        source.disarmed()
        source.armed()
        source.disarmed()
        XCTAssertEqual(reported, 1)
        XCTAssertEqual(port.log, ["ascii"])
    }

    func testSaysAFailedRestore() {
        let port = FakeInputSources()
        var reported = 0
        let source = ChordInputSource(port: port) { _ in reported += 1 }
        source.armed()
        port.failure = FakeInputSources.Broken()
        source.disarmed()
        XCTAssertEqual(reported, 1)
    }

    func testFollowsTheRoutersArming() {
        let port = FakeInputSources()
        let source = ChordInputSource(port: port) { _ in }
        let router = KeyRouter(layout: .defaults(), listener: source)
        _ = router.route(KeyStroke(key: "q", code: "KeyQ", command: true))
        XCTAssertEqual(port.current, FakeInputSources.abc)
        _ = router.route(KeyStroke(key: "f", code: "KeyF"))
        XCTAssertEqual(port.current, FakeInputSources.japanese)
    }
}
