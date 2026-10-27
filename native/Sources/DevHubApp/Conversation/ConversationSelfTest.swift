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
    }

    func run() async -> [String] {
        // Markdown and highlighting from the bundle: the grammars are in it.
        check(CodeHighlighter.resourceRoot != nil, "the TextMate grammars are not in the bundle")
        let coloured = CodeHighlighter.shared.highlight("const a: number = 2;", .typescript)
        check(coloured.first?.contains { $0.light != nil } == true, "TypeScript is not coloured")
        let document = MarkdownParser.parse("# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n```ts\nlet a = 1\n```")
        check(document.blocks.count == 4, "the Markdown fixture parsed into \(document.blocks.count) blocks, not 4")

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
            check(!view.composerView.isHidden, "the composer is not drawn")
            snapshot(view, "conversation-everything-\(dark ? "dark" : "light")")
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
        }

        await composerKeys()
        await longTranscript()

        for window in windows { window.close() }
        windows = []
        return failures
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
