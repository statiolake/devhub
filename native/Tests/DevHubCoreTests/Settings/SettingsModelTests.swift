// The Settings window's edits and session (sections.tsx, SettingsApp.tsx,
// settingsWindow.ts): what each screen writes, and that a change writes the
// TOML in place.
import XCTest
@testable import DevHubCore

final class FakeSettingsHost: SettingsHost, @unchecked Sendable {
    let lock = NSLock()
    var adopted: [Config] = []
    var moved: [String] = []
    func adopt(_ config: Config) async { lock.withLock { adopted.append(config) } }
    func preflightSocket(_ name: String) async throws -> TerminalPreflight {
        try TerminalPreflight(requestedSocketName: try SocketName(name), state: .targetAbsent, ownedSessionCount: 0, unknownSessionCount: 0)
    }
    func changeSocket(_ name: String) async throws { lock.withLock { moved.append(name) } }
    func launchPath() -> String { "/usr/bin:/bin" }
    func loginEnvironmentSummary() -> String { "Imported from /bin/zsh." }
    func previousExit() -> String { "clean" }
}

final class SettingsModelTests: ScratchDirectoryTestCase {
    func command(_ id: CommandId) -> CommandDefinition { Commands.all.first { $0.id == id }! }

    func testRebindingAShippedKeyWritesAnUnbindAndTheNewKey() throws {
        let settings = command(.openSettings)
        let rows = SettingsEdits.keyboardRows(KeybindingsSpec())
        let keys = rows.first { $0.command.id == .openSettings }!.keys
        XCTAssertTrue(rows.first { $0.command.id == .openSettings }!.atDefault)
        let next = try ChordKeys.parse("Cmd+j")
        let spec = SettingsEdits.rebind(KeybindingsSpec(), command: settings, keys: keys, to: next)
        for key in keys { XCTAssertEqual(spec.chords[ChordKeys.format(key)], "") }
        XCTAssertEqual(spec.chords[ChordKeys.format(next)], "open_settings")
        let after = SettingsEdits.keyboardRows(spec).first { $0.command.id == .openSettings }!
        XCTAssertEqual(after.keys.map(ChordKeys.id), [ChordKeys.id(next)])
        XCTAssertFalse(after.atDefault)
        // Rebinding again takes the override away rather than unbinding it.
        let again = SettingsEdits.rebind(spec, command: settings, keys: after.keys, to: nil)
        XCTAssertNil(again.chords[ChordKeys.format(next)])
        XCTAssertEqual(SettingsEdits.keyboardRows(again).first { $0.command.id == .openSettings }!.keys, [])
        // Reset takes everything this command said out of the table.
        let reset = SettingsEdits.resetBinding(spec, command: settings)
        XCTAssertTrue(reset.chords.isEmpty)
        XCTAssertTrue(SettingsEdits.keyboardRows(reset).first { $0.command.id == .openSettings }!.atDefault)
    }

    func testSaysWhichCommandAKeyIsTakenFrom() throws {
        let rows = SettingsEdits.keyboardRows(KeybindingsSpec())
        let palette = rows.first { $0.command.id == .openCommandPalette }!
        let key = palette.keys[0]
        let owner = SettingsEdits.owner(of: key, in: rows)
        XCTAssertEqual(owner?.id, .openCommandPalette)
        let message = SettingsEdits.conflict(key, owner: owner, command: command(.openSettings))
        XCTAssertEqual(message, "\(ChordKeys.describe(key)) currently does “\(palette.command.label)”. It does this instead now.")
        XCTAssertNil(SettingsEdits.conflict(key, owner: owner, command: palette.command))
    }

    func testANewActionGoesAtTheEndOfItsGroupAndMovesOnlyWithinIt() {
        var config = Config.defaults
        config.agentActions = SettingsEdits.renumbered(config.agentActions)
        let (added, at) = SettingsEdits.addAction(config, selectedTrigger: .issue, id: "action-1")
        let tree = SheetRows.actionsInTreeOrder(added.agentActions)
        XCTAssertEqual(tree[at].id, "action-1")
        XCTAssertEqual(tree[at].trigger, .issue)
        XCTAssertEqual(tree[at].template, "{{ISSUE_URL}}\n")
        XCTAssertFalse(tree[at].button)
        XCTAssertEqual(tree[at + 1].trigger, .commit)
        // Up within the Issue group; never down into the commit group.
        let up = SettingsEdits.moveAction(added, selected: at, by: -1)
        XCTAssertEqual(up?.selected, at - 1)
        XCTAssertEqual(SheetRows.actionsInTreeOrder(up!.config.agentActions)[at - 1].id, "action-1")
        XCTAssertEqual(SheetRows.actionsInTreeOrder(up!.config.agentActions)[at - 1].order, 0)
        XCTAssertNil(SettingsEdits.moveAction(added, selected: at, by: 1))
        let push = SettingsEdits.addAction(config, selectedTrigger: .push, id: "action-2")
        XCTAssertTrue(SheetRows.actionsInTreeOrder(push.config.agentActions)[push.selected].button)
    }

    func testAnActionMovedOntoAButtonsTriggerIsDrawnAsOne() {
        let issue = ConfiguredAgentAction(
            trigger: .issue, id: "x", displayName: "X", template: "t", confirmBeforeSend: true, button: false, enabled: true, order: 0)
        XCTAssertTrue(SettingsEdits.trigger(issue, .push).button)
        var off = SettingsEdits.trigger(issue, .push)
        off.button = false
        XCTAssertFalse(SettingsEdits.trigger(off, .commit).button)
        XCTAssertFalse(SettingsEdits.trigger(off, .issue).button)
        XCTAssertEqual(SettingsEdits.messageNote(.commit).prefix(32), "This message takes no variables.")
        XCTAssertTrue(SettingsEdits.messageNote(.push).hasPrefix("{{BRANCH}} is replaced when it is sent."))
        XCTAssertTrue(SettingsEdits.messageNote(.issue).hasPrefix("{{ISSUE_URL}} and {{ISSUE_NO}} are replaced"))
    }

    func testSourcesAndProfilesStartFromSomethingTheLoaderTakes() throws {
        var config = Config.defaults
        for kind in ["filesystem", "command", "date"] {
            config.workspaceSources = [SettingsEdits.emptySource(kind, id: "source-1")]
            if kind == "command" { continue } // One blank argument waits to be typed into.
            XCTAssertNoThrow(try ConfigParsing.validate(config), kind)
        }
        let (added, selected) = SettingsEdits.addProfile(Config.defaults)
        XCTAssertEqual(added.agentProfiles[selected].id, "agent-1")
        XCTAssertNoThrow(try ConfigParsing.validate(added))
        XCTAssertEqual(SettingsEdits.freeId("source", taken: ["source-1", "source-2"]), "source-3")
        XCTAssertEqual(SettingsEdits.freeEnvName(["VARIABLE_1"]), "VARIABLE_2")
        let gui = ConfiguredAgentProfile(id: "c", displayName: "C", kind: .claude, command: "claude", presentation: .gui)
        XCTAssertEqual(SettingsEdits.kind(gui, .cursor).presentation, .tui)
        XCTAssertEqual(SettingsEdits.kind(gui, .codex).presentation, .gui)
        XCTAssertEqual(SettingsEdits.presentationOptions(.cursor, defaults: AgentsConfig(defaultPresentation: .gui)).map(\.label), [
            "Default (Terminal (TUI))", "Terminal (TUI)",
        ])
        let source = FilesystemSource(id: "s", path: "~", minDepth: 1, maxDepth: 2)
        XCTAssertEqual(SettingsEdits.depth(source, minDepth: 3).maxDepth, 3)
        XCTAssertEqual(SettingsEdits.tmuxArgument(RuntimeConfig(tmuxArgs: ["-2"]), "-u", on: true).tmuxArgs, ["-2", "-u"])
        XCTAssertEqual(SettingsEdits.tmuxArgument(RuntimeConfig(tmuxArgs: ["-2", "-u"]), "-2", on: false).tmuxArgs, ["-u"])
    }

    func testTheSocketQuestionSaysWhatHappensToTheSessions() throws {
        let marked = try TerminalPreflight(requestedSocketName: try SocketName("other"), state: .markedSessions, ownedSessionCount: 1, unknownSessionCount: 0)
        XCTAssertEqual(SettingsEdits.socketQuestion(marked, requested: "other").title, "Adopt the DevHub sessions on “other”?")
        XCTAssertEqual(SettingsEdits.socketQuestion(marked, requested: "other").message, "That socket already has 1 DevHub session from another run.")
        let wrong = try TerminalPreflight(requestedSocketName: try SocketName("x"), state: .wrongMarker, ownedSessionCount: 0, unknownSessionCount: 2)
        XCTAssertTrue(SettingsEdits.socketQuestion(wrong, requested: "x").message.hasPrefix("There are 2 sessions there"))
        let prompt = SettingsEdits.socketPrompt(marked, requested: "other")
        XCTAssertEqual(PickerState(prompt).rows.map(\.label), ["Keep the current socket", "Adopt them"])
        XCTAssertEqual(prompt.details, [PickerFact("DevHub sessions there", "1"), PickerFact("Other sessions there", "0")])
    }

    func testAPushDoesNotTakeTheKeyboardAwayMidEdit() {
        var session = SettingsSession()
        let first = snapshot(sequence: 1)
        session.adopt(first)
        XCTAssertEqual(session.draft, first.config)
        var typed = first.config
        typed.general.noticeSeconds = 3
        let count = session.edit(typed)
        var pushed = snapshot(sequence: 2)
        pushed.config.general.noticeSeconds = 99
        session.adopt(pushed)
        XCTAssertEqual(session.draft?.general.noticeSeconds, 3)
        XCTAssertEqual(session.snapshot?.sequence, 2)
        session.settle(count)
        session.adopt(snapshot(sequence: 3))
        XCTAssertEqual(session.draft?.general.noticeSeconds, Config.defaults.general.noticeSeconds)
        session.adopt(snapshot(sequence: 1))
        XCTAssertEqual(session.snapshot?.sequence, 3)
    }

    func testTheRefusalOnScreenFollowsTheAlertRule() {
        var session = SettingsSession()
        session.adopt(snapshot(sequence: 1))
        session.refuse(.externalEditConflict)
        XCTAssertEqual(session.notice, SettingsRules.Refusal.externalEditConflict.message)
        session.dismissRefusal()
        session.refuse(.externalEditConflict)
        XCTAssertNil(session.notice)
        session.acted()
        session.refuse(.externalEditConflict)
        XCTAssertNotNil(session.notice)
        session.editSocket("other")
        XCTAssertTrue(session.socketMoved)
    }

    func snapshot(sequence: Int) -> SettingsSnapshot {
        let resolved = ResolvedRuntimes(shell: .absolutePath("/bin/zsh"), git: .commandName("git"), tmux: .commandName("tmux"))
        return SettingsSnapshot(
            sequence: sequence, revision: "r\(sequence)", config: Config.defaults, resolved: resolved,
            health: Runtimes.health(resolved), loginEnvironment: "", sessionId: "s", logDirectory: "/logs", previousExit: "clean",
            diagnostic: nil, notices: [])
    }

    func testASaveWritesTheTomlInPlace() async throws {
        let path = Path.join(directory, "settings.toml")
        let original = """
            version = 4

            # How long a notice stays up.
            [general]
            notice_seconds = 8 # the default

            [appearance]
            terminal_font_size = 13
            """
        try write(path, original + "\n")
        let store = ConfigStore(paths: ConfigPaths(file: path))
        let host = FakeSettingsHost()
        let service = SettingsService(store: store, host: host, logDirectory: directory)
        let first = try await service.snapshot()
        var next = first.config
        next.general.noticeSeconds = 3
        let saved = try await service.save(revision: first.revision, config: next)
        XCTAssertEqual(saved.config.general.noticeSeconds, 3)
        XCTAssertGreaterThan(saved.sequence, first.sequence)
        XCTAssertEqual(host.adopted.last?.general.noticeSeconds, 3)
        let written = try read(path)
        XCTAssertTrue(written.contains("# How long a notice stays up."), written)
        XCTAssertTrue(written.contains("notice_seconds = 3"), written)
        XCTAssertTrue(written.contains("terminal_font_size = 13"), written)
        // Every line the person wrote is still there, in order, but the one
        // value that changed; the store may add the settings it fills in.
        let writtenLines = written.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var cursor = 0
        for line in original.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) where !line.hasPrefix("notice_seconds") {
            guard let found = writtenLines[cursor...].firstIndex(of: line) else { return XCTFail("lost \(line.debugDescription)\n\(written)") }
            cursor = found + 1
        }
        // A save drafted from an older revision is a refusal, not an overwrite.
        do {
            _ = try await service.save(revision: first.revision, config: first.config)
            XCTFail("an out-of-date save went through")
        } catch {
            XCTAssertEqual(SettingsRules.Refusal.of(error), .externalEditConflict)
        }
    }

    func testAResetPutsAScreensPartBackAndTheSocketIsSavedOnlyOnceMoved() async throws {
        let path = Path.join(directory, "settings.toml")
        try write(path, "version = 4\n[general]\nnotice_seconds = 3\n[appearance]\nterminal_font_size = 15\n")
        let host = FakeSettingsHost()
        let service = SettingsService(store: ConfigStore(paths: ConfigPaths(file: path)), host: host, logDirectory: directory)
        let first = try await service.snapshot()
        let reset = try await service.resetScope(revision: first.revision, keys: SettingsSection.terminal.scope)
        XCTAssertEqual(reset.config.appearance.terminalFontSize, AppearanceConfig().terminalFontSize)
        XCTAssertEqual(reset.config.general.noticeSeconds, 3)
        let moved = try await service.socketApply("elsewhere")
        XCTAssertEqual(host.moved, ["elsewhere"])
        XCTAssertEqual(moved.config.runtimes.tmuxSocketName, "elsewhere")
        let summary = try await service.summary()
        XCTAssertTrue(summary.contains("\"previousExit\": \"clean\""), summary)
        XCTAssertFalse(summary.contains("notice_seconds"))
    }
}
