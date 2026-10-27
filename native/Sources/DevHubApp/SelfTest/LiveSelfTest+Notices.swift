// The live phase's Assign Issue, notices and Settings, all from the keyboard
// (and the pointer where a person would use it).

import AppKit
import DevHubCore

extension LiveSelfTest {
    func issue(_ d: SelfTestDriver) async {
        let before = snapshot?.workspaces.count ?? 0
        await d.chord("i", in: window)
        await d.expect(10, "Cmd+Q I did not ask for the Issue (\(sheets?.topTitle ?? "nothing"))") {
            self.picker?.state.prompt.title == "Assign Issue" && self.picker?.state.prompt.question.contains("Paste") == true
        }
        await d.type(SelfTestWorld.issueURL, in: window)
        await d.press(.returnKey, in: window)
        // The one clone of acme/widget there is (projects/widget, found by
        // its name and its origin) is taken without asking; the branch
        // question then says GitHub could not be asked, `gh` being signed out.
        await d.expect(20, "signed out of GitHub was not said (\(picker?.state.prompt.title ?? "no sheet"): \(picker?.state.prompt.note ?? ""); rows \(pickerRowIds))") {
            self.picker?.state.prompt.note?.contains("not signed in to GitHub") == true
        }
        d.check(pickerRowIds.contains("devhub:new-worktree"), "the branch question offers \(pickerRowIds)")
        d.check(world.fakeLog().contains { $0.cli == "gh" && $0.line.contains("auth token") }, "the Issue flow never asked gh for a token")
        await dismissSheets(d, "the Issue flow")
        d.check((snapshot?.workspaces.count ?? 0) == before, "the cancelled Issue flow opened something")
    }

    func notices(_ d: SelfTestDriver) async {
        guard let layer = shell.notices as? NoticeLayer else { return d.check(false, "the notices are not the notice layer") }
        // Nothing went wrong on the way here that nobody looked at.
        let earlier = layer.board.center.map { "\($0.notice.live == .alert ? "failure" : "notice"): \($0.notice.text)" }
        d.check(!layer.board.center.contains { $0.notice.live == .alert }, "failures were said during the run: \(earlier)")
        if !earlier.isEmpty { d.note("notices so far: \(earlier)") }

        shell.publishError(AppError.at(.fileNotFound).withSummary("Self-test failure").withDetail("The detail line to copy"))
        shell.notices.notice("Self-test notice words")
        await d.expect(3, "the notices drew no toasts") { layer.measured != nil && layer.board.notices.count >= 2 }
        // `notice_seconds = 2`: both hide into the center, unread.
        await d.expect(10, "the toasts did not hide themselves (\(layer.board.notices.map(\.summary)))") { layer.board.notices.isEmpty }
        d.check(layer.measured == nil, "the stack is still laid out once empty")
        let center = layer.board.center.map(\.notice.summary)
        d.check(center.contains("Self-test failure") && center.contains("Self-test notice words"), "the center holds \(center)")
        d.check(layer.board.unreadCount >= 2, "the hidden notices are not unread (\(layer.board.unreadCount))")

        // Cmd+Q M: the center, the keys in it; Cmd+C copies the notice it is on.
        await d.chord("m", in: window)
        await d.expect(3, "Cmd+Q M did not open the notice center") { layer.board.isCenterOpen }
        await d.expect(3, "the keys are not in the notice center (\(String(describing: window?.firstResponder)))") {
            self.window?.firstResponder === layer.view.center
        }
        NSPasteboard.general.clearContents()
        await d.command("c", in: window)
        let copied = NSPasteboard.general.string(forType: .string) ?? ""
        let texts = layer.board.center.map(\.notice.text)
        d.check(texts.contains(copied), "Cmd+C in the center copied “\(copied)”, not a notice (\(texts))")

        // Words selected in one, and copied: the selection, not the whole notice.
        let labels = SelfTestDriver.views(WrappingLabel.self, in: layer.view.center)
        if let detail = labels.first(where: { $0.stringValue == "The detail line to copy" }) {
            detail.scrollToVisible(detail.bounds)
            await d.click(detail)
            await d.command("a", in: window)
            NSPasteboard.general.clearContents()
            await d.command("c", in: window)
            let selected = NSPasteboard.general.string(forType: .string) ?? ""
            d.check(selected == "The detail line to copy", "the selected words copied as “\(selected)”")
            d.check(layer.board.isCenterOpen, "selecting words closed the center")
        } else {
            d.check(false, "the center does not draw the failure's detail (\(labels.map(\.stringValue)))")
        }
        await d.press(.escape, in: window)
        if layer.board.isCenterOpen { await d.press(.escape, in: window) }
        await d.expect(3, "Escape did not close the notice center") { !layer.board.isCenterOpen }
        d.check(layer.board.unreadCount == 0, "the notices are still unread after the center was open (\(layer.board.unreadCount))")
    }

    // MARK: Settings

    var settingsFile: String { world.locations.settingsFilePath }

    func settingsConfig() -> Config? {
        guard let text = try? String(contentsOfFile: settingsFile, encoding: .utf8) else { return nil }
        return try? ConfigParsing.parse(text)
    }

    /// One screen of Settings on show, its controls laid out.
    func show(_ settings: SettingsWindowController, _ section: SettingsSection) async {
        settings.show(section)
        settings.window?.contentView?.layoutSubtreeIfNeeded()
        await SelfTestDriver(prefix: "").pause(0.2)
    }

    /// A control of the screen on show, scrolled into view.
    func control<T: NSView>(_ settings: SettingsWindowController, _ type: T.Type, _ label: String) -> T? {
        let found = SelfTestDriver.control(type, labelled: label, in: settings.window?.contentView)
            ?? SelfTestDriver.views(type, in: settings.window?.contentView).first { ($0 as? NSButton)?.title == label }
        found?.scrollToVisible(found?.bounds ?? .zero)
        return found
    }

    /// A text field typed over and applied with Return.
    func retype(_ d: SelfTestDriver, _ settings: SettingsWindowController, _ label: String, _ value: String) async {
        guard let field = control(settings, NSTextField.self, label) else { return d.check(false, "Settings has no field “\(label)”") }
        await d.click(field)
        await d.command("a", in: settings.window)
        await d.type(value, in: settings.window)
        await d.press(.returnKey, in: settings.window)
    }

    /// Wait for the file, and then the app, to say `holds`.
    func saved(_ d: SelfTestDriver, _ what: String, _ holds: @escaping (Config) -> Bool) async {
        await d.expect(5, "\(what) was not written to settings.toml") { self.settingsConfig().map(holds) == true }
        await d.expect(5, "\(what) was written but the app did not take it up") { self.shell.config.map(holds) == true }
    }

    func settings(_ d: SelfTestDriver) async {
        await d.chord("<", in: window)
        await d.expect(10, "Cmd+Q < did not open Settings on the config") {
            self.shell.settingsWindow?.isLoaded == true && self.shell.settingsWindow?.window?.isVisible == true
        }
        guard let settings = shell.settingsWindow, let settingsWindow = settings.window else { return }
        await d.expect(5, "Settings is not the key window") { settingsWindow.isKeyWindow }

        // General: a switch, saved after the pause and not before it.
        await show(settings, .general)
        let before = (try? String(contentsOfFile: settingsFile, encoding: .utf8)) ?? ""
        if let sound = control(settings, NSSwitch.self, "Play a sound") {
            d.check(sound.state == .on, "Play a sound starts \(sound.state == .on ? "on" : "off")")
            await d.click(sound)
            let early = (try? String(contentsOfFile: settingsFile, encoding: .utf8)) ?? ""
            d.check(early == before, "the change was written before the save's pause")
            await saved(d, "Play a sound off") { !$0.general.notifySound }
        } else {
            d.check(false, "General has no Play a sound switch")
        }

        // Workspaces: the source's Hidden folders.
        await show(settings, .workspaces)
        if let hidden = control(settings, NSSwitch.self, "Hidden folders") {
            await d.click(hidden)
            await saved(d, "Hidden folders on") { config in
                if case let .filesystem(source)? = config.workspaceSources.first { return source.includeHidden }
                return false
            }
        } else {
            d.check(false, "Workspaces has no Hidden folders switch")
        }

        // Agents: the first profile's name, typed.
        await show(settings, .agents)
        await retype(d, settings, "Agent display name", "Fake Claude Two")
        await saved(d, "the profile's new name") { $0.agentProfiles.first?.displayName == "Fake Claude Two" }

        // Actions: the first action turned off.
        await show(settings, .actions)
        let firstAction = settingsConfig()?.agentActions.first?.id
        if let offer = control(settings, NSSwitch.self, "Offer this action") {
            await d.click(offer)
            await saved(d, "the first action turned off") { config in config.agentActions.first { $0.id == firstAction }?.enabled == false }
        } else {
            d.check(false, "Actions has no Offer this action switch")
        }

        // Keyboard: the key recorder, then Reset.
        await show(settings, .keyboard)
        let label = "Change the key for \(Commands.definition(CommandId.markAgentUnread.rawValue)?.label ?? "")"
        func unreadKeys(_ config: Config) -> [String] {
            SettingsEdits.keyboardRows(config.keybindings).first { $0.command.id == .markAgentUnread }?.keys.map(ChordKeys.id) ?? []
        }
        if let recorder = control(settings, KeyRecorderButton.self, label) {
            await d.click(recorder)
            await d.expect(3, "a click did not start the key recorder") { recorder.recording }
            await d.press(.character("y"), in: settingsWindow)
            await saved(d, "Mark as unread on y") { unreadKeys($0) == ["y"] }
        } else {
            d.check(false, "Keyboard has no recorder “\(label)”")
        }
        if let reset = control(settings, NSButton.self, "Reset \(SettingsSection.keyboard.resetName) to defaults") {
            await d.click(reset)
            let question = { SelfTestDriver.views(PickerView.self, in: settingsWindow.contentView).last }
            await d.expect(5, "Reset did not ask first") { question() != nil }
            if let picker = question() {
                d.check(picker.state.activeRow?.id == PickerState.cancelRowId, "Reset's first row is \(picker.state.activeRow?.id ?? "nothing"), not Keep")
                await d.press(.down, in: settingsWindow)
                d.check(picker.state.activeRow?.id == SettingsEdits.resetSettingsRow, "Reset's question could not be moved to Reset")
                await d.press(.returnKey, in: settingsWindow)
            }
            await saved(d, "the keyboard shortcuts reset") { unreadKeys($0) == ["u"] }
        } else {
            d.check(false, "Keyboard has no Reset link")
        }

        // Terminal: a tmux option on, and off again.
        await show(settings, .terminal)
        for on in [true, false] {
            guard let utf8 = control(settings, NSButton.self, "Force UTF-8  -u") else {
                d.check(false, "Terminal has no Force UTF-8 option")
                break
            }
            await d.click(utf8)
            await saved(d, "-u \(on ? "on" : "off")") { $0.runtimes.tmuxArgs.contains("-u") == on }
        }

        // Advanced: the git command, typed.
        await show(settings, .advanced)
        await retype(d, settings, "Git command", "/usr/bin/git")
        await saved(d, "the git command") { $0.runtimes.git == "/usr/bin/git" }

        // Escape lets go of a field, and then closes the window.
        for _ in 0..<3 where settingsWindow.isVisible {
            await d.press(.escape, in: settingsWindow)
            await d.pause(0.2)
        }
        d.check(!settingsWindow.isVisible, "Escape did not close Settings")
        await d.expect(3, "the main window did not get the keys back") { self.window?.isKeyWindow == true }
    }
}
