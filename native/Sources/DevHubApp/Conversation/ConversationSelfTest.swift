// WP10's part of `DevHub --self-test`: a GUI Agent's pane drawn from Core's
// fixture transcripts with no Agent behind it, in light and in dark —
// `TranscriptFixtures.everything()`, every kind of thing the surface draws,
// and `long(2000)`, the size of a working session — and checked as a person
// would use it: the transcript is there and coloured, the requests are cards,
// the find bar counts a large transcript and opens what it finds, and the
// composer's keys send on ⌘Return, never mid-composition. Each pane is saved
// as a PNG under `DEVHUB_SELF_TEST_SNAPSHOTS` (CI keeps them as an artifact).

import AppKit
import DevHubCore
import SwiftMath

@MainActor
final class ConversationSelfTest {
    private var failures: [String] = []
    private var windows: [NSWindow] = []

    private func check(_ ok: Bool, _ what: @autoclosure () -> String) {
        if !ok { failures.append("conversation: \(what())") }
    }

    private func pause(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    private func until(_ seconds: Double, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            await pause(0.05)
        }
        return condition()
    }

    private static var snapshots: String? {
        ProcessInfo.processInfo.environment["DEVHUB_SELF_TEST_SNAPSHOTS"].flatMap { $0.isEmpty ? nil : $0 }
    }

    /// A window holding one pane drawn from `transcript`.
    private func pane(_ transcript: Transcript, dark: Bool, size: NSSize = NSSize(width: 1100, height: 820)) -> ConversationPaneView {
        let shell = ShellStyle.initial(dark: dark, titleBar: .shown)
        let link = ConversationLink()
        let view = ConversationPaneView(agentId: "self-test-\(windows.count)", workspaceId: "ws", label: "Self-test Agent", style: shell, link: link)
        let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: 40 + 30 * windows.count, y: 40), size: size), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.title = "Conversation self-test"
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.isReleasedWhenClosed = false
        view.frame = NSRect(origin: .zero, size: size)
        view.autoresizingMask = [.width, .height]
        window.contentView = view
        window.orderFront(nil)
        windows.append(window)
        view.setShown(true)
        view.showFixture(transcript)
        return view
    }

    private func snapshot(_ view: NSView, _ name: String) {
        if let pane = view as? ConversationPaneView { print("SNAPSHOT-STATE \(name) \(pane.transcriptView.diagnosis)") }
        view.displayIfNeeded()
        guard let directory = Self.snapshots else { return }
        try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            check(false, "\(name) could not be drawn to an image")
            return
        }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { return }
        let path = (directory as NSString).appendingPathComponent("\(name).png")
        check(FileManager.default.createFile(atPath: path, contents: png), "\(name) could not be saved to \(path)")
        // For a reader of the log alone: the picture, small, as one line.
        if ProcessInfo.processInfo.environment["DEVHUB_SELF_TEST_PRINT_SNAPSHOTS"] == "1",
           let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.55])
        {
            print("SNAPSHOT \(name) \(jpeg.base64EncodedString())")
        }
    }

    func run() async -> [String] {
        // Markdown and highlighting from the bundle: the grammars are in it.
        check(CodeHighlighter.resourceRoot != nil, "the TextMate grammars are not in the bundle")
        let coloured = CodeHighlighter.shared.highlight("const a: number = 2;", .typescript)
        check(coloured.first?.contains { $0.light != nil } == true, "TypeScript is not coloured")
        let document = MarkdownParser.parse("# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n```ts\nlet a = 1\n```")
        check(document.blocks.count == 4, "the Markdown fixture parsed into \(document.blocks.count) blocks, not 4")

        // Math is typeset with the fonts in the bundle (`rehype-katex`).
        let formula = MTTypeset.formula("\\frac{a}{b} + \\sqrt{x^2}", fontSize: 15, color: .labelColor, display: false)
        check((formula?.width ?? 0) > 10 && (formula?.descent ?? 0) > 0, "inline math is not typeset")
        check(MTTypeset.formula("\\frac{", fontSize: 15, color: .labelColor, display: true) == nil, "half a formula was typeset")
        // KaTeX's commands SwiftMath lacks are typeset; what KaTeX refuses is refused.
        for tex in [
            "\\dfrac{a}{b}", "\\operatorname{rank}(A)", "\\lVert x \\rVert", "\\bigl( x \\bigr)", "a \\implies b",
            "\\boxed{x}", "\\overbrace{a+b}^{n}", "\\xrightarrow{f}", "\\overset{!}{=}", "x \\pmod{n}", "\\cancel{x}",
        ] {
            check(MTTypeset.formula(tex, fontSize: 15, color: .labelColor, display: false) != nil, "\(tex) is not typeset")
        }
        for (tex, display) in [("\\frac{a}", true), ("x^2^3", false), ("\\begin{align} a \\end{align}", false), ("\\tag{1} x", false)] {
            check(!MTTypeset.parses(tex, display: display), "\(tex) parses where KaTeX refuses it")
        }
        check(MTTypeset.formula("x \\tag{1}", fontSize: 15, color: .labelColor, display: true)?.tag != nil, "a display formula's \\tag is not drawn")

        for dark in [false, true] {
            let everything = TranscriptFixtures.everything()
            let view = pane(everything, dark: dark)
            await pause(0.6)
            let text = view.transcriptView.text
            let words = text.string
            let rendered = text.rendered.count
            check(rendered >= 15, "everything drew \(rendered) sections")
            for word in ["Fix the bug in src/a.ts", "Plan", "Bash:", "Explore", "Pushed to origin/main", "Conversation compacted", "Turn interrupted"] {
                check(words.contains(word), "everything does not draw “\(word)”")
            }
            check(text.embeds.requestCards.count == 2, "everything drew \(text.embeds.requestCards.count) request cards, not 2")
            let codeColoured = await until(3) {
                text.textStorage.map { storage in
                    var found = false
                    storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, _, stop in
                        if let embed = value as? EmbedAttachment, embed.content is CodeBlockView { found = true; stop.pointee = true }
                    }
                    return found
                } ?? false
            }
            check(codeColoured, "everything drew no code block")
            let displayMath: Bool = text.textStorage.map { storage -> Bool in
                var typeset = false
                storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, _, stop in
                    if let embed = value as? EmbedAttachment, let math = embed.content as? MathEmbedView, math.isTypeset { typeset = true; stop.pointee = true }
                }
                return typeset
            } ?? false
            check(displayMath, "everything's $$…$$ is not typeset")
            check(!view.composerView.isHidden, "the composer is not drawn")
            snapshot(view, "conversation-everything-\(dark ? "dark" : "light")")
            // And the rest of it, a screen at a time from the top.
            let clip = view.transcriptView.scroll.contentView
            let height = view.transcriptView.text.frame.height
            var top: CGFloat = 0
            var page = 0
            while top < height, page < 6 {
                clip.scroll(to: NSPoint(x: 0, y: top))
                view.transcriptView.scroll.reflectScrolledClipView(clip)
                await pause(0.3)
                snapshot(view, "conversation-everything-\(dark ? "dark" : "light")-\(page)")
                top += clip.bounds.height * 0.9
                page += 1
            }
            view.transcriptView.jumpToLatest()
            // A fold opened by a click on its row: the call's body is drawn.
            if let range = text.range(ofKey: "t2/summary", inSection: "t2") {
                let before = text.string.contains("npm ERR! Test failed")
                view.performAction(.toggle(EntryFold.tool("t2")))
                await pause(0.2)
                check(!before && text.string.contains("npm ERR! Test failed"), "opening a call's row did not draw its output")
                _ = range
            } else {
                check(false, "the call t2 has no row")
            }
            // A question asked and answered, on its call: the card's layout, the preview beside.
            view.performAction(.toggle(EntryFold.tool("t6")))
            await pause(0.3)
            // Brought into view, so it is laid out (TextKit lays out what is shown).
            if let range = text.range(ofSection: "t6") {
                view.transcriptView.reveal(NSRange(location: NSMaxRange(range) - 1, length: 1))
                await pause(0.4)
                snapshot(view, "conversation-question-record-\(dark ? "dark" : "light")")
            }
            // Its words are the transcript's text, selected and copied with the rest.
            check(text.string.contains("Which layout?") && text.string.contains("One above the other"), "the recorded question's words are not in the transcript's text")
            if let words = text.string.range(of: "Which layout?") {
                text.setSelectedRange(NSRange(words, in: text.string))
                check(text.selectedWords() == "Which layout?", "a selection of the recorded question copies \(text.selectedWords().debugDescription)")
                text.setSelectedRange(NSRange(location: 0, length: 0))
            }
            let previews = text.previewsBeside
            check(previews.count == 1, "the call t6 drew \(previews.count) previews, not 1")
            check(previews.beside, "the recorded question's preview is not beside its options")
        }
        await arrivals()
        await settingList()
        await failureSheet()
        await mcpPanel()

        await composerKeys()
        await longTranscript()

        for window in windows { window.close() }
        windows = []
        return failures
    }

    /// An entry that arrives while the pane is shown rises in; what was there is drawn as it is.
    private func arrivals() async {
        let first = [TranscriptFixtures.put(TranscriptFixtures.user("u", "hi")), TranscriptFixtures.put(TranscriptFixtures.assistant("a", "Hello."))]
        let view = pane(TranscriptFixtures.transcript(first), dark: false, size: NSSize(width: 800, height: 600))
        await pause(0.4)
        let text = view.transcriptView.text
        check(!text.subviews.contains { $0 is FreshVeil }, "a transcript as it loaded rose in")
        view.showFixture(TranscriptFixtures.transcript(first + [TranscriptFixtures.put(TranscriptFixtures.assistant("b", "**Arrived** just now."))]))
        let rising = text.subviews.contains { veil in veil is FreshVeil && veil.subviews.contains { $0 is NSImageView } }
        check(rising || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, "an entry that arrived did not rise in")
        let settled = await until(2) { !text.subviews.contains { $0 is FreshVeil } }
        check(settled, "an entry's rise did not end")
    }

    /// An Agent's failure: DevHub's sheet over the pane, then the banner along its top.
    private func failureSheet() async {
        let size = NSSize(width: 800, height: 520)
        let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: 60, y: 60), size: size), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        windows.append(window)
        let host = NSView(frame: NSRect(origin: .zero, size: size))
        host.wantsLayer = true
        window.contentView = host
        let view = FailureView(frame: host.bounds)
        host.addSubview(view)
        window.orderFront(nil)
        let style = ShellStyle.initial(dark: false, titleBar: .shown)
        var dismissed = false
        view.onDismiss = { dismissed = true }
        let actions: [(String, Bool, () -> Void)] = [("Continue in terminal", false, {}), ("Dismiss", false, {}), ("Try again", true, {})]
        view.update(
            title: "The conversation could not start", summary: "The Agent's CLI refused to start.",
            detail: "Run `claude doctor` in a terminal to see why.", banner: false, actions: actions, style: style)
        view.layoutSubtreeIfNeeded()
        await pause(0.3)
        snapshot(view, "conversation-failure-sheet")
        if let sheet = view.subviews.first as? FailureSheet {
            check(sheet.card.frame.width > 300 && sheet.card.frame.height > 80, "the failure sheet is \(sheet.card.frame)")
            check(sheet.buttons.map(\.title) == ["Continue in terminal", "Dismiss", "Try again"], "the failure sheet's buttons are \(sheet.buttons.map(\.title))")
            sheet.cancelOperation(nil)
            check(dismissed, "Escape did not dismiss the failure sheet")
        } else {
            check(false, "the failure is not drawn as a sheet")
        }
        view.update(title: "The conversation could not start", summary: "The Agent's CLI refused to start.", detail: nil, banner: true, actions: Array(actions.prefix(1)), style: style)
        view.layoutSubtreeIfNeeded()
        await pause(0.2)
        snapshot(view, "conversation-failure-banner")
        check(view.hitTest(NSPoint(x: 400, y: 400)) == nil, "the failure banner takes the pointer below it")
    }

    /// `/mcp`: a picker's sheet over the pane, the servers as rows, the one chosen in the aside.
    private func mcpPanel() async {
        let view = pane(TranscriptFixtures.everything(), dark: true, size: NSSize(width: 1000, height: 640))
        await pause(0.3)
        let panel = McpPanelView(label: "Self-test Agent", style: ConversationStyle(ShellStyle.initial(dark: true, titleBar: .shown)), agentId: "self-test", transport: nil)
        panel.frame = view.bounds
        view.addSubview(panel)
        let servers = [
            McpServer(name: "github", status: .connected, said: "connected", error: nil, source: "user", actions: [.reconnect, .disable]),
            McpServer(name: "linear", status: .needsSignIn, said: "needs-auth", error: "Sign in to use it", source: "project", actions: [.signIn]),
        ]
        panel.update(McpState(servers: servers, pluginErrors: [], working: [], failure: "The CLI refused: reconnect failed"), signIn: nil)
        panel.layoutSubtreeIfNeeded()
        await pause(0.3)
        snapshot(panel, "conversation-mcp-panel")
        check(panel.card.frame.height > 200 && panel.card.frame.minY == 0, "the MCP sheet is \(panel.card.frame)")
        check(panel.buttons.map(\.title) == ["Close"], "the MCP sheet's footer has \(panel.buttons.map(\.title))")
        panel.removeFromSuperview()
    }

    /// `/model`'s list: over its face, the current choice ticked, the keys on the face; Escape closes it.
    private func settingList() async {
        let view = pane(TranscriptFixtures.everything(), dark: false, size: NSSize(width: 900, height: 700))
        await pause(0.4)
        let composer = view.composerView
        check(composer.openSetting(.model), "the Model picker did not open")
        await pause(0.2)
        let menu = composer.settingMenu
        check(menu.isOpen, "the Model list is not drawn")
        check(menu.rows.map(\.choice.label) == ["Opus", "Sonnet"], "the Model list has \(menu.rows.map(\.choice.label))")
        check(menu.rows.first?.current == true, "the current model is not ticked")
        if let face = menu.face {
            check(view.window?.firstResponder === face, "the keyboard is not on the Model face")
            let anchor = view.convert(face.bounds, from: face)
            check(menu.frame.maxY <= anchor.minY + 0.5 && menu.frame.height > 0, "the Model list is not over its face")
            snapshot(view, "conversation-setting-list")
            if let window = view.window, let down = NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}",
                isARepeat: false, keyCode: 53)
            {
                face.keyDown(with: down)
            }
            check(!menu.isOpen, "Escape did not close the Model list")
        } else {
            check(false, "the Model list has no face")
        }
    }

    /// ⌘Return sends; Return is a new line; nothing is sent while an input method is composing.
    private func composerKeys() async {
        var sent: [ConversationCommandWire] = []
        let transcript = TranscriptFixtures.transcript([TranscriptFixtures.put(TranscriptFixtures.user("u", "hi"))])
        let view = pane(transcript, dark: false, size: NSSize(width: 800, height: 600))
        view.commandSink = { wire in
            sent.append(wire)
            return true
        }
        await pause(0.3)
        let field = view.composerView.field
        guard let window = field.window else { return check(false, "the composer is not in a window") }
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(field)
        field.insertText("hello", replacementRange: NSRange(location: NSNotFound, length: 0))
        func key(_ code: UInt16, _ characters: String, _ flags: NSEvent.ModifierFlags) -> NSEvent? {
            NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters,
                isARepeat: false, keyCode: code)
        }
        // Mid-composition, ⌘Return is the input method's.
        field.setMarkedText("にほ", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        if let event = key(36, "\r", [.command]) { field.keyDown(with: event) }
        await pause(0.2)
        check(sent.isEmpty, "⌘Return sent while an input method was composing")
        field.unmarkText()
        if let event = key(36, "\r", []) { field.keyDown(with: event) }
        await pause(0.1)
        check(sent.isEmpty && field.string.contains("\n"), "Return did not start a new line")
        if let event = key(36, "\r", [.command]) { field.keyDown(with: event) }
        let delivered = await until(2) { !sent.isEmpty }
        check(delivered, "⌘Return did not send")
        if case let .send(text, _)? = sent.first {
            check(text.hasPrefix("hello"), "⌘Return sent “\(text)”")
        } else if delivered {
            check(false, "⌘Return sent \(String(describing: sent.first))")
        }
        let cleared = await until(2) { field.string.isEmpty }
        check(cleared, "the composer was not cleared once the message was sent")
    }

    /// 2,000 entries: drawn, scrolled, and found through.
    private func longTranscript() async {
        let long = TranscriptFixtures.long(2_000)
        let started = Date()
        let view = pane(long, dark: false)
        let drawn = Date().timeIntervalSince(started)
        check(drawn < 20, "the long transcript took \(Int(drawn))s to draw")
        await pause(0.5)
        let text = view.transcriptView.text
        check(text.rendered.count > 1_000, "the long transcript drew \(text.rendered.count) sections")
        check(view.transcriptView.following, "the long transcript does not follow its end")
        snapshot(view, "conversation-long")
        view.findForTest("step")
        let counted = await until(20) { view.findStatus?.complete == true }
        check(counted, "the find bar did not finish counting the long transcript")
        let total = view.findStatus?.total ?? 0
        check(total > 2_000, "the find bar counted \(total) matches of “step”")
        view.stepFindForTest(-1)
        await pause(0.3)
        check(view.findCurrentRange != nil, "the current match is not drawn")
        snapshot(view, "conversation-long-find")
    }
}
