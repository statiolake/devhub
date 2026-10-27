// The live phase's managed Neovim (terminal mode's editor, `ManagedNeovims`):
// file jumps from the `devhub` command typed in a Workspace's ws- terminal
// and from a file link clicked in a conversation, each landing in the one
// Neovim server DevHub keeps for that Workspace — a new tmux window in its
// ws- session on the first jump, the same one after; a Neovim that was quit
// started again by the next jump; and the Workspace's close taking its
// Neovim with it. What Neovim has open is asked of it over its own socket
// (msgpack-rpc), as a second client.

import AppKit
import DevHubCore

extension LiveSelfTest {
    /// What a managed Neovim says it is showing.
    struct NeovimShows: Equatable, CustomStringConvertible {
        var buffer: String
        /// 1-based line, 0-based byte (`nvim_win_get_cursor`).
        var line: Int
        var byte: Int
        var description: String { "\(buffer) at [\(line), \(byte)]" }
    }

    /// Neovim, wherever Homebrew or the PATH put it.
    static func findNeovim() -> String? {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        let candidates = path.split(separator: ":").map { "\($0)/nvim" } + ["/opt/homebrew/bin/nvim", "/usr/local/bin/nvim"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// `condition`, asked until it holds or `seconds` pass.
    func eventually(_ seconds: Double, _ condition: () async -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await condition() { return true }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return await condition()
    }

    /// The live Neovim panes of a session, by pane id.
    func neovimPanes(_ session: String) -> [String] {
        tmuxSays(["list-panes", "-s", "-t", "=\(session)", "-F", "#{pane_id} #{pane_current_command} #{pane_dead}"])
            .split(separator: "\n").compactMap { line in
                let fields = line.split(separator: " ").map(String.init)
                return fields.count == 3 && fields[1] == "nvim" && fields[2] == "0" ? fields[0] : nil
            }
    }

    /// The pane id of the active window's active pane in a session.
    func activePane(_ session: String) -> String {
        tmuxSays(["display-message", "-p", "-t", "=\(session):", "#{pane_id}"]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Ask the server on `socket` what its current window shows.
    func askNeovim(_ socket: String) async -> Result<NeovimShows, Error> {
        do {
            let client = try await NeovimClient.connect(socket)
            defer { Task { await client.close() } }
            let name = try await client.request("nvim_buf_get_name", [0])
            let cursor = try await client.request("nvim_win_get_cursor", [0])
            guard case let .array(position) = cursor, position.count == 2,
                  let line = position[0].intValue, let byte = position[1].intValue
            else { throw DevhubFailure("nvim_win_get_cursor answered \(cursor)") }
            return .success(NeovimShows(buffer: name.stringValue ?? "\(name)", line: Int(line), byte: Int(byte)))
        } catch {
            return .failure(error)
        }
    }

    /// Wait for the server on `socket` to show `expected`; a failure says what it shows instead.
    func expectNeovim(_ d: SelfTestDriver, _ socket: String, _ expected: NeovimShows, _ what: String) async {
        var last: Result<NeovimShows, Error>?
        let shown = await eventually(10) {
            last = await askNeovim(socket)
            if case let .success(shows) = last { return shows == expected }
            return false
        }
        if !shown {
            let said: String
            switch last {
            case let .success(shows)?: said = "it shows \(shows)"
            case let .failure(error)?: said = "it could not be asked: \(failureText(error))"
            case nil: said = "it was never asked"
            }
            d.check(false, "\(what): the managed Neovim does not show \(expected); \(said)")
        }
    }

    /// The file link the stand-in Claude's "jump" reply drew, in `pane`'s transcript.
    func jumpLink(in pane: ConversationPaneView) -> (range: NSRange, link: DocLink)? {
        let text = pane.transcriptView.text
        guard let storage = text.textStorage else { return nil }
        var found: (range: NSRange, link: DocLink)?
        storage.enumerateAttribute(.link, in: NSRange(location: 0, length: storage.length)) { value, range, stop in
            if let link = (value as? TranscriptLink)?.link, case let .file(path, _) = link, path.hasSuffix(SelfTestWorld.jumpPath) {
                found = (range, link)
                stop.pointee = true
            }
        }
        return found
    }

    /// `devhub` typed in a Workspace's editor terminal (which must show its shell).
    func typeDevhub(_ d: SelfTestDriver, _ workspaceId: String, _ what: String, _ arguments: String) async -> TerminalPaneView? {
        guard let pane = await editorTerminal(d, workspaceId, what) else { return nil }
        await d.type("\(DevhubInstall.shellQuote(devhubCommand)) \(arguments)\r", in: window)
        return pane
    }

    /// The `devhub` command a ws- terminal runs: the launcher DevHub writes
    /// for this run (the `/devhub` skill's), linked into the world's bin.
    var devhubCommand: String { Path.join(world.bin, "devhub") }

    func neovim(_ d: SelfTestDriver) async {
        let required = ProcessInfo.processInfo.environment["DEVHUB_SELF_TEST_REQUIRE_NVIM"] == "1"
        guard let nvim = Self.findNeovim() else {
            d.check(!required, "there is no nvim, and DEVHUB_SELF_TEST_REQUIRE_NVIM is set")
            d.note("no nvim: the managed Neovim is not exercised")
            return
        }
        d.note("nvim \(nvim)")
        guard let alpha = workspace(root: world.alpha), let beta = workspace(root: world.beta) else {
            return d.check(false, "alpha and beta are not both open")
        }
        guard let claude = claudeAgent else { return d.check(false, "there is no Claude Agent in alpha") }
        let neovims = runtime.neovims
        let alphaSession = TmuxNames.workspaceSession(root: alpha.root)
        let alphaSocket = await neovims.socketPath(alpha.id)

        // The launcher, where a terminal can type it; the file the jumps open.
        let launcher = DevhubSkill(userDataPath: world.locations.userDataDirectory).cli
        try? FileManager.default.removeItem(atPath: devhubCommand)
        do {
            try FileManager.default.createSymbolicLink(atPath: devhubCommand, withDestinationPath: launcher)
        } catch {
            return d.check(false, "the devhub launcher \(launcher) could not be linked: \(error)")
        }
        let file = Path.join(world.alpha, SelfTestWorld.jumpPath)
        do {
            try FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            try (1...40).map { "const widget\($0) = \($0);" }.joined(separator: "\n").appending("\n")
                .write(toFile: file, atomically: true, encoding: .utf8)
        } catch {
            return d.check(false, "\(file) could not be written: \(error)")
        }
        defer { try? FileManager.default.removeItem(atPath: (file as NSString).deletingLastPathComponent) }

        // 1. `devhub -g` from alpha's ws- terminal: the first jump starts
        //    alpha's Neovim in a new window of its session, at the line.
        await goTo(d, "widget", alpha.id)
        let windowsBefore = tmuxSays(["list-windows", "-t", "=\(alphaSession)", "-F", "#{window_id}"]).split(separator: "\n").count
        guard let terminal = await typeDevhub(d, alpha.id, "alpha", "-g \(SelfTestWorld.jumpPath):7") else { return }
        let started = await eventually(20) { await neovims.paneOf(alpha.id) != nil }
        d.check(started, "devhub -g in alpha's terminal started no managed Neovim (the screen ends “\(terminal.screenText().trimmingCharacters(in: .whitespacesAndNewlines).suffix(300))”; tmux has \(tmuxSays(["list-panes", "-s", "-t", "=\(alphaSession)", "-F", "#{pane_id} #{pane_current_command}"])))")
        guard started, let first = await neovims.paneOf(alpha.id) else { return }
        await d.expect(10, "alpha's Neovim pane \(first) is not a live nvim pane of \(alphaSession) (\(neovimPanes(alphaSession)))") {
            self.neovimPanes(alphaSession) == [first]
        }
        let windowsAfter = tmuxSays(["list-windows", "-t", "=\(alphaSession)", "-F", "#{window_id}"]).split(separator: "\n").count
        d.check(windowsAfter == windowsBefore + 1, "the first jump made \(windowsAfter - windowsBefore) windows in \(alphaSession), not one")
        d.check(activePane(alphaSession) == first, "the Neovim window is not the one \(alphaSession) shows (\(activePane(alphaSession)))")
        d.check(FileManager.default.fileExists(atPath: alphaSocket), "alpha's Neovim has no socket at \(alphaSocket)")
        await expectNeovim(d, alphaSocket, NeovimShows(buffer: file, line: 7, byte: 0), "devhub -g \(SelfTestWorld.jumpPath):7")
        await d.expect(10, "alpha's editor terminal does not show Neovim (the screen ends “\(terminal.screenText().trimmingCharacters(in: .whitespacesAndNewlines).suffix(300))”)") {
            terminal.screenText().contains("const widget7 = 7;")
        }

        // 2. A file link in the conversation, clicked: the same Neovim, at
        //    the link's line and column.
        await d.chord("g", in: window)
        await d.expect(5, "Cmd+Q G did not open Go to") { self.picker != nil }
        await d.type(claude.displayName, in: window)
        await d.press(.returnKey, in: window)
        await d.expect(5, "Go to did not select \(claude.displayName)") { self.snapshot?.selection.context == .agent(claude.id) }
        guard let pane = pane(claude.id) else { return d.check(false, "the Claude Agent's conversation is not drawn") }
        await send(d, pane, "Where do I jump to?")
        await d.expect(30, "the stand-in's jump reply drew no link to \(SelfTestWorld.jumpPath) (the transcript ends “\(pane.transcriptView.text.string.suffix(200))”)") {
            self.jumpLink(in: pane) != nil
        }
        if let hit = jumpLink(in: pane) {
            let range = hit.range
            if case let .file(_, linkRange) = hit.link {
                d.check(linkRange == .line(line: 4, column: 3), "the link reads its place as \(String(describing: linkRange)), not 4:3")
            }
            pane.transcriptView.reveal(range)
            await d.pause(0.3)
            let text = pane.transcriptView.text
            if let segment = text.lineRects(range).first {
                let point = NSPoint(x: segment.midX, y: segment.midY)
                // What is under the pointer, for a click that opens nothing.
                let inWindow = text.convert(point, to: nil)
                let hit = window?.contentView?.hitTest(window?.contentView?.superview?.convert(inWindow, from: nil) ?? inWindow)
                let index = text.characterIndexForInsertion(at: point)
                let under = index < (text.textStorage?.length ?? 0) ? text.textStorage?.attribute(.link, at: index, effectiveRange: nil) : nil
                let before = text.selectedRange()
                d.check(text.bounds.contains(point), "the link at \(point) is outside its text view's \(text.bounds.size) (laid out to \(text.laidOutBottom())): a click on it would miss the view")
                await d.click(text, at: point)
                let opened = await eventually(5) {
                    if case let .success(shows) = await askNeovim(alphaSocket) { return shows.line == 4 }
                    return false
                }
                if !opened {
                    d.note("the link's click: range \(range), at \(point) in a text view of \(text.bounds.size) (laid out to \(text.laidOutBottom())), visible \(text.visibleRect), hits \(hit.map { "\(type(of: $0))" } ?? "nothing"), the index there \(index) holds \(under.map { "\($0)" } ?? "no link"), selection \(before) → \(text.selectedRange()), keys in \(window?.firstResponder.map { "\(type(of: $0))" } ?? "nothing")")
                }
            } else {
                d.check(false, "the link to \(SelfTestWorld.jumpPath) has no place on the screen")
            }
            await expectNeovim(d, alphaSocket, NeovimShows(buffer: file, line: 4, byte: 2), "the conversation's link")
            let reused = await neovims.paneOf(alpha.id)
            d.check(reused == first, "the link's jump did not reuse alpha's Neovim (\(first) → \(reused ?? "none"))")
            d.check(neovimPanes(alphaSession) == [first], "after the link's jump \(alphaSession) has the Neovim panes \(neovimPanes(alphaSession)), not \(first) alone")
            d.check(activePane(alphaSession) == first, "the link's jump did not bring the Neovim window to the front (\(activePane(alphaSession)))")
            await d.expect(5, "the link's jump did not show alpha's editor beside the Agent") {
                self.editorPane(alpha.id).map { !$0.isHidden } == true
            }
        }

        // 3. Neovim quit in its window (`:qa!`, typed into alpha's editor
        //    terminal): forgotten, and the next jump starts a new one.
        if let terminal = await editorTerminal(d, alpha.id, "alpha") {
            await d.type(":qa!\r", in: window)
            await d.expect(15, "after :qa! alpha's Neovim is still known (\(neovimPanes(alphaSession)); the screen ends “\(terminal.screenText().trimmingCharacters(in: .whitespacesAndNewlines).suffix(200))”)") {
                self.neovimPanes(alphaSession).isEmpty
            }
            let forgotten = await eventually(10) { await neovims.paneOf(alpha.id) == nil }
            d.check(forgotten, "DevHub did not hear alpha's Neovim end")
            d.check(!FileManager.default.fileExists(atPath: alphaSocket), "alpha's Neovim left its socket \(alphaSocket)")
            await d.expect(10, "after Neovim quit, alpha's terminal does not show its shell (\(activePane(alphaSession)))") {
                !self.activePane(alphaSession).isEmpty && !self.neovimPanes(alphaSession).contains(self.activePane(alphaSession))
            }
        }
        if await typeDevhub(d, alpha.id, "alpha", "-g \(SelfTestWorld.jumpPath):12:7") != nil {
            let again = await eventually(20) { await neovims.paneOf(alpha.id).map { $0 != first } == true }
            d.check(again, "the jump after :qa! started no new Neovim (\(neovimPanes(alphaSession)))")
            if again, let second = await neovims.paneOf(alpha.id) {
                await d.expect(10, "the new Neovim \(second) is not alpha's one nvim pane (\(neovimPanes(alphaSession)))") {
                    self.neovimPanes(alphaSession) == [second]
                }
                await expectNeovim(d, alphaSocket, NeovimShows(buffer: file, line: 12, byte: 6), "the jump after :qa!")
            }
            // Put away again: alpha's terminal is its shell for what follows.
            if await editorTerminal(d, alpha.id, "alpha") != nil {
                await d.type(":qa!\r", in: window)
                await d.expect(15, "the second :qa! did not end alpha's Neovim (\(neovimPanes(alphaSession)))") { self.neovimPanes(alphaSession).isEmpty }
                _ = await eventually(10) { await neovims.paneOf(alpha.id) == nil }
            }
        }

        // 4. The Workspace closes: its Neovim goes with it. beta's, started
        //    from its own terminal, then beta closed (Cmd+Q W) and opened again.
        let betaSession = TmuxNames.workspaceSession(root: beta.root)
        let betaSocket = await neovims.socketPath(beta.id)
        let readme = Path.join(world.beta, "README.md")
        await goTo(d, "beta", beta.id)
        guard await typeDevhub(d, beta.id, "beta", "-g README.md:1") != nil else { return }
        let betaStarted = await eventually(20) { await neovims.paneOf(beta.id) != nil }
        d.check(betaStarted, "devhub -g in beta's terminal started no managed Neovim (\(neovimPanes(betaSession)))")
        guard betaStarted else { return }
        await expectNeovim(d, betaSocket, NeovimShows(buffer: readme, line: 1, byte: 0), "devhub -g README.md:1 in beta")
        // A second client, to hear the server end.
        let ended = WatchedEnd()
        let watcher = try? await NeovimClient.connect(betaSocket)
        await watcher?.onClose { ended.set() }
        d.check(watcher != nil, "beta's Neovim could not be reached at \(betaSocket)")
        await d.chord("W", in: window)
        if await d.until(5, { self.picker != nil }) {
            d.check(await pointAt(d, SheetRows.confirmRow), "beta's close question could not be moved to its confirm row (\(pickerRowIds))")
            await d.press(.returnKey, in: window)
        }
        await d.expect(20, "Cmd+Q W did not close beta") { self.workspace(root: self.world.beta) == nil }
        await d.expect(10, "beta's Neovim outlived beta's close") { ended.value }
        let betaForgotten = await eventually(5) { await neovims.paneOf(beta.id) == nil }
        d.check(betaForgotten, "DevHub still knows beta's Neovim after the close")
        d.check(!FileManager.default.fileExists(atPath: betaSocket), "beta's close left its Neovim's socket \(betaSocket)")
        d.check(!sessions().contains(betaSession), "beta's session outlived its close (\(sessions()))")
        await watcher?.close()

        // beta again, for the phases after this one: `devhub <folder>`.
        await goTo(d, "widget", alpha.id)
        if await typeDevhub(d, alpha.id, "alpha", DevhubInstall.shellQuote(world.beta)) != nil {
            await d.expect(20, "devhub \(world.beta) did not open beta again") { self.workspace(root: self.world.beta) != nil }
        }
        await d.expect(10, "a Neovim was left running (\(tmuxSays(["list-panes", "-a", "-F", "#{session_name} #{pane_current_command}"])))") {
            !self.tmuxSays(["list-panes", "-a", "-F", "#{pane_current_command}"]).split(separator: "\n").contains("nvim")
        }
    }
}

/// A flag a connection's close sets, read from the main actor.
final class WatchedEnd: @unchecked Sendable {
    private let lock = NSLock()
    private var ended = false
    var value: Bool { lock.withLock { ended } }
    func set() { lock.withLock { ended = true } }
}
