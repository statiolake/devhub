// The live phase's GUI Agents: a conversation with the stand-in Claude
// typed and answered from the keyboard, /resume, Make default, Rename,
// dictation through whisper.cpp, and a Codex Agent's Make default.

import AppKit
import AVFoundation
import DevHubCore

extension LiveSelfTest {
    /// alpha's Claude Agent, made by the sheets phase.
    var claudeAgent: AgentWire? {
        workspace(root: world.alpha)?.agents.first { $0.profileId == SelfTestWorld.claudeProfile }
    }

    /// Every embedded view the transcript draws, of one kind.
    func embeds<T>(_ type: T.Type, in pane: ConversationPaneView) -> [T] {
        guard let storage = pane.transcriptView.text.textStorage else { return [] }
        var found: [T] = []
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, _, _ in
            if let embed = value as? EmbedAttachment, let content = embed.content as? T { found.append(content) }
        }
        return found
    }

    /// Put the keys in `pane`'s composer, with a click.
    func focusComposer(_ d: SelfTestDriver, _ pane: ConversationPaneView) async {
        let field = pane.composerView.field
        if window?.firstResponder !== field { await d.click(field) }
        await d.expect(3, "a click did not put the keys in the composer (\(String(describing: window?.firstResponder)))") {
            self.window?.firstResponder === field
        }
    }

    /// Type `text` in the composer and send it with ⌘Return.
    func send(_ d: SelfTestDriver, _ pane: ConversationPaneView, _ text: String) async {
        await focusComposer(d, pane)
        await d.type(text, in: window)
        d.check(pane.composerView.field.string == text, "the composer holds “\(pane.composerView.field.string)”, not what was typed")
        await d.press(.returnKey, [.command], in: window)
        await d.expect(5, "⌘Return did not send “\(text)” (the composer holds “\(pane.composerView.field.string)”)") {
            pane.composerView.field.string.isEmpty
        }
    }

    /// The model list of `pane`'s composer, opened with `/model` and Return.
    func openModelList(_ d: SelfTestDriver, _ pane: ConversationPaneView) async -> SettingMenuView? {
        await focusComposer(d, pane)
        await d.type("/model", in: window)
        await d.press(.returnKey, in: window)
        let menu = pane.composerView.settingMenu
        let open = await d.until(5) { menu.isOpen }
        d.check(open, "/model and Return did not open the model list")
        return open ? menu : nil
    }

    /// Option-Return on `id` in the open list: the CLI's default for new sessions.
    func makeDefault(_ d: SelfTestDriver, _ menu: SettingMenuView, _ id: String) async {
        await d.expect(10, "the model list offers no Make default (\(menu.rows.map { "\($0.choice.id)\($0.offersDefault ? "+" : "")" }))") {
            menu.rows.contains { $0.offersDefault }
        }
        for _ in 0..<menu.rows.count where menu.rows[menu.highlighted].choice.id != id {
            await d.press(.down, in: window)
        }
        d.check(menu.rows[menu.highlighted].choice.id == id, "the model list could not be moved to \(id) (\(menu.rows.map(\.choice.id)))")
        await d.press(.returnKey, [.option], in: window)
        await d.expect(10, "Option-Return did not make \(id) the default (\(menu.rows.filter(\.isDefault).map(\.choice.id)))") {
            menu.rows.first { $0.choice.id == id }?.isDefault == true
        }
        await d.press(.escape, in: window)
        await d.expect(3, "Escape did not close the model list") { !menu.isOpen }
    }

    func conversation(_ d: SelfTestDriver) async {
        guard let agent = claudeAgent else { return d.check(false, "there is no Claude Agent to talk to") }
        await d.expect(10, "the Agent's conversation pane is not drawn") { self.pane(agent.id)?.window != nil }
        guard let pane = pane(agent.id) else { return }
        let text = pane.transcriptView.text

        // A message, and the stand-in's streamed reply in Markdown.
        await send(d, pane, "Hello from the self-test")
        let replied = await d.until(30) { text.string.contains("The end of the fake reply") }
        d.check(replied, "no reply was drawn (the transcript says “\(text.string.suffix(300))”; the stand-in read \(world.fakeLog().filter { $0.cli == "claude" }.map(\.line).suffix(4)))")
        d.check(text.string.contains("Hello from the self-test"), "the message is not in the transcript")
        d.check(world.fakeLog().contains { $0.cli == "claude" && $0.line.contains("Hello from the self-test") }, "the stand-in Claude never read the message")
        if replied {
            await d.expect(5, "the reply's code block is not drawn") { !self.embeds(CodeBlockView.self, in: pane).isEmpty }
            await d.expect(5, "the reply's table is not drawn") { !self.embeds(TableEmbedView.self, in: pane).isEmpty }
            await d.expect(5, "the reply's $$…$$ is not typeset") { self.embeds(MathEmbedView.self, in: pane).contains { $0.isTypeset } }
            d.check(!text.string.contains("```"), "the reply's code fence is drawn as text")
        }

        // A permission request: a card, answered with its number key.
        await send(d, pane, "Ask me for permission")
        await d.expect(20, "the permission request drew no card") { !text.embeds.requestCards.isEmpty }
        await d.expect(5, "the waiting line is not shown") { !pane.waitingLine.isHidden }
        await d.click(pane.waitingLine)
        let card = text.embeds.requestCards.first
        await d.expect(3, "the waiting line did not put the keys on the card (\(String(describing: window?.firstResponder)))") {
            card != nil && self.window?.firstResponder === card
        }
        await d.press(.character("1"), in: window)
        await d.expect(20, "the card's 1 did not allow the call (\(text.string.suffix(200)))") { text.string.contains("Permission answer: allow") }
        await d.expect(5, "the card stayed after its answer") { text.embeds.requestCards.isEmpty }
        d.check(world.fakeLog().contains { $0.cli == "claude" && $0.line.contains("\"behavior\":\"allow\"") }, "the stand-in never read an allow")

        // ⌘F: the find bar, counting through the transcript; Escape closes it.
        await focusComposer(d, pane)
        await d.command("f", in: window)
        await d.expect(3, "⌘F did not open the find bar") { pane.isFindOpen }
        await d.type("fake reply", in: window)
        await d.expect(5, "find counted \(pane.findStatus?.total ?? -1) matches of “fake reply”") {
            pane.findStatus?.complete == true && (pane.findStatus?.total ?? 0) >= 2
        }
        await d.press(.returnKey, in: window)
        await d.expect(3, "Return in the find bar did not step to a match") { pane.findCurrentRange != nil }
        await d.press(.escape, in: window)
        await d.expect(3, "Escape did not close the find bar") { !pane.isFindOpen }

        // /resume: the questions layer's session picker, alpha's earlier session listed.
        await focusComposer(d, pane)
        await d.type("/resume", in: window)
        await d.press(.returnKey, in: window)
        await d.expect(5, "/resume did not open the session picker") { self.picker != nil }
        await d.expect(10, "the session picker does not list the earlier session (\(pickerRowLabels))") {
            self.pickerRowLabels.contains { $0.contains("The earlier widget session") }
        }
        await d.press(.escape, in: window)
        await d.expect(3, "Escape did not close the session picker") { !self.shell.modals.isPresenting }

        // Make default: Claude's own settings.json, in the profile's CLAUDE_CONFIG_DIR.
        if let menu = await openModelList(d, pane) {
            await makeDefault(d, menu, "opus")
            let file = Path.join(world.claudeConfig, "settings.json")
            let written = (try? String(contentsOfFile: file, encoding: .utf8)) ?? ""
            let model = (try? JSONSerialization.jsonObject(with: Data(written.utf8)) as? [String: Any])?["model"] as? String
            d.check(model == "opus", "Make default wrote \(written.isEmpty ? "nothing" : written) to \(file)")
        }

        // Rename (Cmd+Q ,): the name selected, typed over, Return.
        await d.chord(",", in: window)
        await d.expect(5, "Cmd+Q , did not open Rename") { self.picker?.state.prompt.title == "Rename Agent" }
        await d.command("a", in: window)
        await d.type("Self-test Claude", in: window)
        await d.press(.returnKey, in: window)
        await d.expect(5, "Rename did not rename the Agent (\(self.agent(agent.id)?.displayName ?? "gone"))") {
            self.agent(agent.id)?.displayName == "Self-test Claude"
        }
        d.check(!shell.modals.isPresenting, "Rename stayed up")
    }

    /// whisper.cpp hearing `say`'s voice, played in place of the microphone.
    func dictation(_ d: SelfTestDriver) async {
        let required = ProcessInfo.processInfo.environment["DEVHUB_SELF_TEST_REQUIRE_WHISPER"] == "1"
        guard let install = DictationController.install() else {
            d.check(!required, "there is no recogniser (DEVHUB_WHISPER_DIR is \(ProcessInfo.processInfo.environment["DEVHUB_WHISPER_DIR"] ?? "unset"))")
            d.note("no recogniser: dictation is not exercised")
            return
        }
        d.note("recogniser \(install.binary), model \(install.model), server \(install.server ?? "none")")
        // A recording: `say`, brought down to 16 kHz mono 16-bit, with a second of silence after it.
        let directory = Path.join(world.home, "voice")
        try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let aiff = Path.join(directory, "spoken.aiff")
        let wav = Path.join(directory, "spoken.wav")
        let said = SelfTestDriver.run("/usr/bin/say", ["-v", "Samantha", "-o", aiff, "Hello from the dev hub self test."])
        if said.code != 0 { SelfTestDriver.run("/usr/bin/say", ["-o", aiff, "Hello from the dev hub self test."]) }
        let converted = SelfTestDriver.run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav])
        d.check(converted.code == 0 && FileManager.default.fileExists(atPath: wav), "the recording could not be made: \(said.output) \(converted.output)")
        guard converted.code == 0 else { return }

        guard let agent = claudeAgent, let pane = pane(agent.id) else { return d.check(false, "there is no composer to dictate into") }
        let dictation = shell.dictation
        d.check(dictation.unavailableReason == nil, "the composer says there is no recogniser: \(dictation.unavailableReason ?? "")")
        // English, with the composer's language switch.
        let composer = pane.composerView
        for _ in 0..<3 where dictation.language != .en {
            await d.click(composer.languageButton)
        }
        d.check(dictation.language == .en, "the language switch did not reach English (\(dictation.language))")
        dictation.audioFile = URL(fileURLWithPath: wav)
        defer { dictation.audioFile = nil }
        await focusComposer(d, pane)
        await d.press(.character("m"), [.command, .shift], in: window)
        await d.expect(10, "⌘⇧M did not start a dictation (\(dictation.phase))") { dictation.phase == .recording }
        await d.expect(20, "the recording was not played to its end") { dictation.audioFileDone }
        await d.pause(0.5)
        await d.press(.character("m"), [.command, .shift], in: window)
        await d.expect(60, "the dictation did not finish (\(dictation.phase))") { dictation.phase == .idle }
        let heard = composer.field.string
        d.note("dictation heard “\(heard)”")
        let words = heard.lowercased()
        d.check(words.contains("hello") && (words.contains("self") || words.contains("test")), "the composer holds “\(heard)” after the dictation")
        // Put the words away.
        await focusComposer(d, pane)
        await d.command("a", in: window)
        await d.press(.delete, in: window)
        d.check(composer.field.string.isEmpty, "the dictated words could not be cleared")
    }

    func codex(_ d: SelfTestDriver) async {
        guard workspace(root: world.alpha) != nil else { return d.check(false, "alpha is not open") }
        // New Agent: the second profile, the stand-in Codex.
        await d.chord("c", in: window)
        await d.expect(10, "New Agent does not list Fake Codex") { self.pickerRowIds.contains("new:\(SelfTestWorld.codexProfile)") }
        d.check(await pointAt(d, "new:\(SelfTestWorld.codexProfile)"), "New Agent could not be moved to Fake Codex")
        await d.press(.returnKey, in: window)
        await d.expect(20, "New Agent started no Codex Agent") {
            self.workspace(root: self.world.alpha)?.agents.contains { $0.profileId == SelfTestWorld.codexProfile } == true
        }
        guard let codex = workspace(root: world.alpha)?.agents.first(where: { $0.profileId == SelfTestWorld.codexProfile }) else { return }
        await d.expect(10, "the Codex Agent's pane is not drawn") { self.pane(codex.id)?.window != nil }
        guard let pane = pane(codex.id) else { return }
        // Make default: Codex's config.toml, in the profile's CODEX_HOME.
        if let menu = await openModelList(d, pane) {
            d.check(menu.rows.map(\.choice.id) == ["gpt-5.5-codex", "gpt-5.5-mini"], "Codex's models are \(menu.rows.map(\.choice.id))")
            await makeDefault(d, menu, "gpt-5.5-mini")
            let file = Path.join(world.codexHome, "config.toml")
            let written = (try? String(contentsOfFile: file, encoding: .utf8)) ?? ""
            let parsed = try? ConfigParsing.parseText(written)
            d.check(parsed?["model"] == .string("gpt-5.5-mini"), "Make default wrote \(written.isEmpty ? "nothing" : written) to \(file)")
        }
        // A message to Codex too.
        await send(d, pane, "Hello Codex")
        await d.expect(20, "Codex's reply was not drawn") { pane.transcriptView.text.string.contains("Fake Codex reply") }

        // Close what is selected (Cmd+Q X): the Codex Agent stops, asking first when it would interrupt.
        await d.chord("x", in: window)
        if await d.until(3, { self.shell.modals.isPresenting }) {
            d.check(pickerRowIds.contains(SheetRows.confirmRow), "the stop's question has no confirm row (\(pickerRowIds))")
            d.check(await pointAt(d, SheetRows.confirmRow), "the stop's question could not be moved to its confirm row")
            await d.press(.returnKey, in: window)
        }
        await d.expect(20, "Cmd+Q X did not stop the Codex Agent") { self.agent(codex.id) == nil }

    }
}
