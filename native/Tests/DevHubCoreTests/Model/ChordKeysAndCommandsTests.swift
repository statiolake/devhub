// Port of apps/desktop/src/model/chordKeys.test.ts and commands.test.ts
import XCTest
@testable import DevHubCore

final class ChordKeyGrammarTests: XCTestCase {
    func parse(_ text: String) -> ChordKey { try! ChordKeys.parse(text) }

    func testReadsACharacterAndEveryModifierInAnyOrderAndAnyCase() {
        XCTAssertEqual(parse("{"), ChordKey(key: "{"))
        XCTAssertEqual(parse("CMD+Alt+ctrl+,"), ChordKey(key: ",", command: true, control: true, option: true, shift: false))
    }

    func testFoldsShiftIntoTheCharacterAndAcceptsEitherSpelling() {
        XCTAssertEqual(parse("Shift+n"), parse("N"))
        XCTAssertEqual(parse("Shift+["), parse("{"))
        XCTAssertEqual(parse("Shift+]"), parse("}"))
        XCTAssertEqual(parse("Shift+,"), parse("<"))
        XCTAssertEqual(parse("Shift+/"), parse("?"))
        XCTAssertEqual(parse("Shift+w"), parse("W"))
        XCTAssertEqual(ChordKeys.format(parse("Shift+[")), "{")
        XCTAssertEqual(parse("Shift+{"), parse("{"))
    }

    func testKeepsShiftAsAFlagForAKeyWithNoCharacterToPutItIn() {
        XCTAssertEqual(parse("Shift+Escape"), ChordKey(key: "escape", shift: true))
        XCTAssertEqual(ChordKeys.format(parse("shift+escape")), "Shift+escape")
        XCTAssertEqual(ChordKeys.format(parse("Shift+n")), "N")
    }

    func testRoundTripsEverySpellingThroughFormat() {
        for text in ["q", "Cmd+q", "N", "{", "}", "<", "?", ",", "Cmd+j", "1", "f12", "Shift+escape", "+", "Shift++"] {
            XCTAssertEqual(parse(ChordKeys.format(parse(text))), parse(text), text)
        }
    }

    func testWritesTheModifiersInOneOrderHoweverTheyWereTyped() {
        XCTAssertEqual(ChordKeys.format(parse("shift+cmd+n")), "Cmd+N")
        XCTAssertEqual(ChordKeys.format(parse("cmd+shift+n")), "Cmd+N")
    }

    func testRefusesWhatCouldNeverBeAKeyWithTheReason() {
        let problems: [(String, ChordKeyProblem)] = [
            ("", .empty), ("   ", .empty), ("Shift+", .missingKey), ("Hyper+n", .unknownModifier),
            ("Shift+Shift+n", .duplicateModifier), ("a b", .invalidKey),
        ]
        for (text, problem) in problems {
            XCTAssertThrowsError(try ChordKeys.parse(text), text) { error in
                XCTAssertEqual((error as? ChordKeyError)?.problem, problem, text)
            }
        }
    }

    func testKeepsALettersCaseBecauseTheCaseIsTheShift() {
        XCTAssertNotEqual(ChordKeys.id(parse("N")), ChordKeys.id(parse("n")))
        XCTAssertTrue(ChordKeys.same(parse("Shift+n"), parse("N")))
        XCTAssertFalse(ChordKeys.same(parse("N"), parse("Cmd+N")))
    }

    func testTakesTheCharacterWhateverKeyProducedIt() {
        XCTAssertEqual(ChordKeys.strokeKey("{"), "{")
        XCTAssertEqual(ChordKeys.strokeKey("}"), "}")
        XCTAssertEqual(ChordKeys.strokeKey("@"), "@")
    }

    func testKeepsANamedKeyByItsNameWithoutRegardToCase() {
        XCTAssertEqual(ChordKeys.strokeKey("Escape"), "escape")
        XCTAssertEqual(ChordKeys.strokeKey("ArrowLeft"), "arrowleft")
    }

    func testMakesNoStrokeOfAKeyThatProducedNoCharacter() {
        for absent in ["Process", "Dead", "Unidentified", ""] { XCTAssertNil(ChordKeys.strokeKey(absent), absent) }
    }

    func testKnowsABareModifierWhenItSeesOne() {
        for code in ["ShiftLeft", "ShiftRight", "ControlLeft", "AltRight", "MetaLeft", "CapsLock"] {
            XCTAssertTrue(ChordKeys.isModifierKey(code), code)
        }
        for code in ["KeyP", "Digit1", "BracketLeft", "Comma"] { XCTAssertFalse(ChordKeys.isModifierKey(code), code) }
    }

    func testShowsTheCharacterWhichIsWhatIsPrintedOnTheKey() {
        XCTAssertEqual(ChordKeys.describe(parse("Shift+,")), "<")
        XCTAssertEqual(ChordKeys.describe(parse("Shift+/")), "?")
        XCTAssertEqual(ChordKeys.describe(parse("Shift+[")), "{")
        XCTAssertEqual(ChordKeys.describe(parse("Cmd+j")), "Cmd+j")
        XCTAssertEqual(ChordKeys.describe(parse("Alt+arrowup")), "Alt+↑")
        XCTAssertEqual(ChordKeys.describe(ChordKey(key: " ")), "Space")
    }

    func testCapitalisesAKeyThatHasANameRatherThanACharacter() {
        XCTAssertEqual(ChordKeys.describe(parse("escape")), "Escape")
        XCTAssertEqual(ChordKeys.describe(parse("Shift+escape")), "Shift+Escape")
    }
}

final class CommandRegistryTests: XCTestCase {
    func commandFor(_ bindings: [KeyBinding], _ key: String) -> CommandId? {
        let wanted = ChordKeys.id(try! ChordKeys.parse(key))
        return bindings.first { ChordKeys.id($0.key) == wanted }?.commandId
    }

    func testGivesEveryCommandAnIdNothingElseHas() {
        let ids = Commands.all.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count)
        XCTAssertEqual(Set(ids), Set(CommandId.allCases))
        XCTAssertEqual(ids.count, 48)
    }

    func testSpellsEveryDefaultKeyInTheGrammarTheConfigUses() {
        for command in Commands.all {
            if Commands.paletteOnly.contains(command.id) {
                XCTAssertEqual(command.defaultKeys, [], command.id.rawValue)
            } else {
                XCTAssertGreaterThan(command.defaultKeys.count, 0, command.id.rawValue)
            }
            for text in command.defaultKeys { XCTAssertNoThrow(try ChordKeys.parse(text), "\(command.id): \(text)") }
        }
    }

    func testWritesEveryDefaultKeyCanonically() {
        for command in Commands.all {
            for text in command.defaultKeys { XCTAssertEqual(ChordKeys.format(try! ChordKeys.parse(text)), text, command.id.rawValue) }
        }
    }

    func testNeverGivesOneKeyToTwoCommands() {
        var seen: [String: CommandId] = [:]
        for binding in Commands.defaultBindings() {
            let id = ChordKeys.id(binding.key)
            XCTAssertNil(seen[id], "\(id) is bound twice")
            seen[id] = binding.commandId
        }
    }

    func testDoesGiveOneCommandTwoKeysWhereTwoHabitsReachIt() {
        let bindings = Commands.defaultBindings()
        for command in Commands.all {
            XCTAssertEqual(Commands.keys(for: command.id, in: bindings).count, command.defaultKeys.count, command.id.rawValue)
        }
    }

    func testPutsOneCommandOnEachOfTheThreeStrokesAboutTheOtherThing() {
        XCTAssertEqual(Commands.definition("toggle_split")?.defaultKeys, ["z"])
        XCTAssertEqual(Commands.definition("toggle_scratch")?.defaultKeys, ["J"])
        let bindings = Commands.defaultBindings()
        XCTAssertEqual(commandFor(bindings, "z"), .toggleSplit)
        XCTAssertEqual(commandFor(bindings, "J"), .toggleScratch)
        XCTAssertEqual(commandFor(bindings, "Cmd+j"), .toggleWorkspaceAgent)
    }

    func testLetsTheSidebarStepTakeTheBareLetterAsWellAsTheCommandOne() {
        XCTAssertEqual(Commands.definition("next_tab")?.defaultKeys, ["Cmd+n", "n"])
        XCTAssertEqual(Commands.definition("previous_tab")?.defaultKeys, ["Cmd+p", "p"])
        let bindings = Commands.defaultBindings()
        XCTAssertEqual(commandFor(bindings, "Cmd+n"), .nextTab)
        XCTAssertEqual(commandFor(bindings, "n"), .nextTab)
        XCTAssertEqual(commandFor(bindings, "Cmd+p"), .previousTab)
        XCTAssertEqual(commandFor(bindings, "p"), .previousTab)
        XCTAssertEqual(commandFor(bindings, "N"), .nextWorkspace)
        XCTAssertEqual(commandFor(bindings, "P"), .previousWorkspace)
    }

    func testPutsTheAgentsTerminalOnVAndLeavesSAndTheSidebarToThePalette() {
        let bindings = Commands.defaultBindings()
        XCTAssertEqual(commandFor(bindings, "v"), .toggleTerminal)
        XCTAssertNil(commandFor(bindings, "s"))
        XCTAssertNil(commandFor(bindings, "S"))
        XCTAssertEqual(Commands.definition("focus_sidebar")?.defaultKeys, [])
        XCTAssertEqual(Commands.paletteOnly, [.focusSidebar, .openLog])
        XCTAssertEqual(Commands.keys(for: .focusSidebar, in: bindings), [])
    }

    func testMovesBetweenPanesWithOAndGivesTheBareArrowsNothing() {
        let bindings = Commands.defaultBindings()
        XCTAssertEqual(commandFor(bindings, "o"), .swapSplitFocus)
        for arrow in ["arrowleft", "arrowright", "arrowup", "arrowdown"] { XCTAssertNil(commandFor(bindings, arrow), arrow) }
        XCTAssertEqual(commandFor(bindings, "Alt+arrowup"), .moveEntryUp)
        XCTAssertFalse(Commands.isCommandId("split_terminal_below"))
        XCTAssertFalse(Commands.isCommandId("focus_pane_left"))
    }

    func testKnowsItsOwnIdsAndNobodyElses() {
        XCTAssertTrue(Commands.isCommandId("next_workspace"))
        XCTAssertFalse(Commands.isCommandId("nope"))
        XCTAssertNil(Commands.definition("nope"))
    }

    func testMarksExactlyTheTenDigitCommandsAsDigitCommands() {
        let digits = Commands.all.filter { $0.id.selectEntryDigit != nil }
        XCTAssertEqual(digits.map(\.id.rawValue), (0...9).map { "select_entry_\($0)" })
        XCTAssertEqual(digits.map(\.ordinal), (0...9).map { Optional($0) })
        XCTAssertEqual(Commands.definition("select_entry_0")?.label, "Select Scratch")
        XCTAssertEqual(Commands.definition("select_entry_3")?.label, "Select workspace 3")
    }
}

final class KeybindingRulesTests: XCTestCase {
    func testAcceptsATableThatOnlyNamesKeysAndIdsDevHubHas() {
        XCTAssertEqual(Commands.check(KeybindingsSpec(prefix: "Ctrl+q", chords: ["Shift+n": "previous_workspace", "g": ""])), [])
    }

    func testReportsAnIdDevHubDoesNotHave() {
        XCTAssertEqual(Commands.check(KeybindingsSpec(prefix: "Cmd+q", chords: ["g": "teleport"])), [KeybindingProblem(code: .unknownCommand, path: "keybindings.chords.g")])
    }

    func testReportsAKeyThatIsNotAKey() {
        XCTAssertEqual(Commands.check(KeybindingsSpec(prefix: "Cmd+q", chords: ["Hyper+g": "next_tab"])), [KeybindingProblem(code: .invalidKey, path: "keybindings.chords.Hyper+g")])
        XCTAssertEqual(Commands.check(KeybindingsSpec(prefix: "Hyper+q", chords: [:])), [KeybindingProblem(code: .invalidKey, path: "keybindings.prefix")])
        XCTAssertEqual(Commands.check(KeybindingsSpec(prefix: "Cmd+q", chords: ["Shift+{": "next_tab"])), [])
    }

    func testReportsTwoSpellingsOfOneStroke() {
        let problems = Commands.check(KeybindingsSpec(prefix: "Cmd+q", chords: ["Shift+n": "next_tab", "shift+N": "previous_tab"]))
        XCTAssertEqual(problems.count, 1)
        XCTAssertEqual(problems.first?.code, .duplicateKey)
        XCTAssertEqual(problems.first?.path, "keybindings.chords.shift+N (also keybindings.chords.Shift+n)")
    }

    func testReportsEveryProblemNotTheFirst() {
        let problems = Commands.check(KeybindingsSpec(prefix: "Cmd+q", chords: ["g": "teleport", "Hyper+h": "next_tab"]))
        XCTAssertEqual(problems.map(\.code), [.unknownCommand, .invalidKey])
    }
}

final class ResolvedBindingsTests: XCTestCase {
    func commandFor(_ spec: KeybindingsSpec, _ key: String) -> CommandId? {
        let wanted = ChordKeys.id(try! ChordKeys.parse(key))
        return Commands.resolve(spec).bindings.first { ChordKeys.id($0.key) == wanted }?.commandId
    }

    func testIsTheShippedTableWhenTheFileSaysNothing() {
        let resolved = Commands.resolve(KeybindingsSpec())
        XCTAssertEqual(resolved.bindings.count, Commands.defaultBindings().count)
        XCTAssertEqual(ChordKeys.format(resolved.prefix), "Cmd+q")
    }

    func testPutsOOnTheOtherPane() {
        XCTAssertEqual(commandFor(KeybindingsSpec(), "o"), .swapSplitFocus)
        XCTAssertFalse(Commands.isCommandId("open_workspace_externally"))
    }

    func testKeepsEveryKeyTheFileDoesNotMention() {
        let spec = KeybindingsSpec(prefix: "Cmd+q", chords: ["g": "next_tab"])
        XCTAssertEqual(commandFor(spec, "f"), .addWorkspace)
        XCTAssertEqual(commandFor(spec, "Shift+n"), .nextWorkspace)
    }

    func testLetsAKeyBeMovedToAnotherCommand() {
        XCTAssertEqual(commandFor(KeybindingsSpec(prefix: "Cmd+q", chords: ["g": "next_tab"]), "g"), .nextTab)
    }

    func testLetsAKeyBeTakenAwayWithTheEmptyString() {
        XCTAssertNil(commandFor(KeybindingsSpec(prefix: "Cmd+q", chords: ["f": ""]), "f"))
        XCTAssertEqual(commandFor(KeybindingsSpec(prefix: "Cmd+q", chords: ["f": ""]), "g"), .openTabPicker)
    }

    func testChangesThePrefix() {
        XCTAssertEqual(ChordKeys.format(Commands.resolve(KeybindingsSpec(prefix: "Ctrl+q", chords: [:])).prefix), "Ctrl+q")
    }

    func testSkipsAnEntryItCannotUseRatherThanLosingTheWholeTable() {
        let spec = KeybindingsSpec(prefix: "nonsense++", chords: ["Hyper+h": "next_tab", "g": "teleport"])
        XCTAssertEqual(ChordKeys.format(Commands.resolve(spec).prefix), "Cmd+q")
        XCTAssertEqual(commandFor(spec, "g"), .openTabPicker)
    }
}
