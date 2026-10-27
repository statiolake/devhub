// `DevHub --self-test`: what CI runs on macOS against the bundle. It draws the
// real window from a fixture projection, with every terminal surface on the
// loopback transport (no tmux, no settings file, nothing under the person's
// home), and checks what WP9 is for:
//
//   - the window is on screen, in both arrangements a chord leads to
//   - every child is where `WindowLayout.compute` says, in its order
//   - the Sidebar draws Scratch, one Workspace and its Agent
//   - the editor area's terminal attaches, draws, types and resizes over the
//     frame contract (`started`, `output`, acknowledgements)
//   - `Cmd+Q Z` and `Cmd+Q V` route through the chord dispatcher
//   - after a split (`Cmd+Q Z`) with the terminal open (`Cmd+Q V`), the
//     editor, the Agent and its terminal are all attached and shown
//   - the built-in colour themes are in the bundle
//   - a GUI Agent's pane draws the fixture transcripts, finds through a long
//     one, and sends on ⌘Return but not mid-composition (WP10,
//     `ConversationSelfTest`)
//
// Exit 0 with "self-test ok", else 1 with every failure.

import AppKit
import DevHubCore

@MainActor
final class SelfTest {
    private var shell: ShellController?
    private let transport = LoopbackTransport()
    private var failures: [String] = []

    private func check(_ ok: Bool, _ what: @autoclosure () -> String) {
        if !ok { failures.append(what()) }
    }

    private func pause(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    /// Wait for `condition`, up to `seconds`.
    private func until(_ seconds: Double, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            await pause(0.05)
        }
        return condition()
    }

    func start() {
        Task { @MainActor in
            await run()
            // WP10: a GUI Agent's pane from Core's fixture transcripts.
            failures += await ConversationSelfTest().run()
            await live()
            if failures.isEmpty {
                print("self-test ok: \(DevHubVersion.description)")
                exit(0)
            }
            FileHandle.standardError.write(Data("self-test failed: \(failures.joined(separator: "; "))\n".utf8))
            exit(1)
        }
    }

    /// Whether every child the layout names is where it says.
    private func layoutApplied(_ window: MainWindowController, _ what: String) {
        guard let input = window.layoutInput() else { return check(false, "\(what): there is no layout") }
        let expected = WindowLayout.compute(input)
        check(!expected.isEmpty, "\(what): the layout has no children")
        for child in expected {
            let view: NSView?
            switch child.identity {
            case .shell: view = window.backdrop
            case .sidebar: view = window.sidebar
            case .agents: view = window.agents
            case let .terminal(id): view = window.agentTerminals[id]
            case let .editorTerminal(key): view = window.editorTerminals[key]
            case .tooltip: view = window.tooltip.view
            default: view = nil
            }
            guard let view else {
                check(child.identity == .toasts || child.identity == .picker, "\(what): no view for \(child.identity)")
                continue
            }
            check(view.frame == child.rect.cgRect, "\(what): \(child.identity) is at \(view.frame), not \(child.rect)")
            check(view.isHidden == !child.visible, "\(what): \(child.identity) shown is \(!view.isHidden), not \(child.visible)")
        }
        // In the stack's order, lowest first.
        let order = expected.compactMap { child -> NSView? in
            switch child.identity {
            case .shell: return window.backdrop
            case .sidebar: return window.sidebar
            case .agents: return window.agents
            case let .terminal(id): return window.agentTerminals[id]
            case let .editorTerminal(key): return window.editorTerminals[key]
            case .tooltip: return window.tooltip.view
            default: return nil
            }
        }
        let stacked = window.root.subviews.filter { view in order.contains { $0 === view } }
        check(stacked.elementsEqual(order, by: ===), "\(what): the children are not stacked in the layout's order")
    }

    private func key(_ window: NSWindow, _ characters: String, code: UInt16, command: Bool) -> NSEvent? {
        NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: command ? [.command] : [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters,
            isARepeat: false, keyCode: code)
    }

    private func run() async {
        // WP8: the vendored built-in colour themes are in the bundle.
        let roots = ExtensionRoots(builtin: ColorThemeCatalog.builtinRoot, user: [String]())
        let themes = ColorThemeCatalog.list(roots)
        check(ColorThemeCatalog.find(themes, "Dark 2026") != nil && ColorThemeCatalog.find(themes, "Light 2026") != nil,
              "the built-in colour themes are missing")
        check(TerminalSurfaceProbe.links(), "the terminal surface did not link")

        let appearance = AppearanceController(roots: roots)
        let shell = ShellController(titleBar: .shown, appearance: appearance, transport: transport)
        self.shell = shell
        let window = shell.window
        window.showWindow(nil)
        window.window?.setContentSize(NSSize(width: 1200, height: 780))
        NSApp.activate()
        shell.installKeyboard()
        let root = (NSTemporaryDirectory() as NSString).appendingPathComponent("devhub-self-test")

        // 1. A Workspace's editor area.
        shell.apply(WindowFixtures.selfTestWorkspace(root: root))
        await pause(0.5)
        check(window.window?.isVisible == true, "the main window is not visible")
        layoutApplied(window, "the editor area")
        let rows = window.sidebar.list.treeIds
        check(rows == [
            "workspace:\(WindowFixtures.scratchId)", "workspace:\(WindowFixtures.workspaceId)", "agent:\(WindowFixtures.agentId)",
        ], "the Sidebar draws \(rows), not Scratch, the Workspace and its Agent")

        let editorKey = TerminalSurfaceKeys.workspace(WindowFixtures.workspaceId)
        let editor = window.editorTerminals.values.first { $0.surfaceKey == editorKey }
        check(editor != nil, "the editor area has no terminal view")
        if let editor {
            let attached = await until(5) { editor.isAttached }
            check(attached, "the editor terminal did not attach (\(editor.connection))")
            let drawn = await until(3) { editor.screenText().contains("DevHub loopback") }
            check(drawn, "the editor terminal did not draw its output")
            if let attachment = transport.live(editorKey) {
                check(attachment.viewLabel == "editor", "the editor terminal attached as \(attachment.viewLabel)")
                let acked = await until(3) { self.transport.acknowledgedUpTo(attachment.attachmentId) >= 1 }
                check(acked, "the editor terminal did not acknowledge what it drew")
                editor.type("echo self-test\r")
                let typed = await until(3) {
                    String(decoding: self.transport.typed(attachment.attachmentId), as: UTF8.self).contains("echo self-test")
                }
                check(typed, "what was typed did not reach the session")
                let echoed = await until(3) { editor.screenText().contains("echo self-test") }
                check(echoed, "the session's echo was not drawn")
                // A different size reaches the session as a resize.
                let before = transport.resizes.filter { $0.attachmentId == attachment.attachmentId }.last?.size
                window.window?.setContentSize(NSSize(width: 1000, height: 700))
                let resized = await until(3) {
                    let last = self.transport.resizes.filter { $0.attachmentId == attachment.attachmentId }.last?.size
                    return last != nil && last != before
                }
                check(resized, "a new window size did not reach the session")
                layoutApplied(window, "the resized window")
            } else {
                check(false, "the editor terminal is not attached on \(editorKey)")
            }
        }

        // 2. The chords: `Cmd+Q Z` and `Cmd+Q V` reach their commands.
        if let nsWindow = window.window, let dispatcher = shell.chordDispatcher {
            for (character, code, command) in [("z", UInt16(6), CommandId.toggleSplit), ("v", UInt16(9), CommandId.toggleTerminal)] {
                guard let prefix = key(nsWindow, "q", code: 12, command: true), let second = key(nsWindow, character, code: code, command: false) else {
                    check(false, "the key events could not be made")
                    continue
                }
                check(dispatcher.handleKey(prefix) == nil, "Cmd+Q was not taken as the prefix")
                check(dispatcher.isArmed, "Cmd+Q did not arm the prefix")
                check(dispatcher.handleKey(second) == nil, "Cmd+Q \(character.uppercased()) reached the surface")
                check(shell.lastCommand == command, "Cmd+Q \(character.uppercased()) ran \(String(describing: shell.lastCommand))")
            }
        } else {
            check(false, "the chord dispatcher is not installed")
        }

        // 3. What `Cmd+Q Z` then `Cmd+Q V` leave on screen: the split, with
        // the Agent's terminal under it.
        shell.apply(WindowFixtures.selfTest(root: root, presentation: .beside, terminal: true, revision: 2))
        await pause(0.5)
        layoutApplied(window, "the split")
        let agentKey = TerminalSurfaceKeys.agent(WindowFixtures.agentId)
        let terminalKey = TerminalSurfaceKeys.paneTerminal(WindowFixtures.terminalId)
        for (label, surfaceKey) in [("the Agent", agentKey), ("the Agent's terminal", terminalKey), ("the editor", editorKey)] {
            let attached = await until(5) { self.transport.live(surfaceKey) != nil }
            check(attached, "\(label) did not attach on \(surfaceKey)")
        }
        if let pane = window.agentTerminals[WindowFixtures.terminalId] {
            check(!pane.isHidden, "the Agent's terminal is not shown in the split")
            let drawn = await until(3) { pane.screenText().contains("DevHub loopback") }
            check(drawn, "the Agent's terminal did not draw")
        } else {
            check(false, "the Agent's terminal has no view")
        }
        check(!window.agents.isHidden, "the Agents' view is not shown in the split")
        check(editor.map { !$0.isHidden } ?? false, "the editor is not shown in the split")
        if let state = shell.arrangement?.state, case let .split(_, ratio, _) = state.surface {
            check(abs(ratio - 0.55) < 0.001, "the split is at \(ratio)")
        } else {
            check(false, "the arrangement is not a split")
        }

        // 4. The Agent alone keeps the editor attached and hidden.
        shell.apply(WindowFixtures.selfTest(root: root, presentation: .full, terminal: false, revision: 3))
        await pause(0.3)
        layoutApplied(window, "the Agent alone")
        check(editor.map(\.isHidden) ?? false, "the editor is still shown with the Agent alone")
        check(editor?.isAttached ?? false, "the hidden editor let go of its attachment")
        check(transport.live(editorKey) != nil, "the hidden editor's attachment was let go of")

        // 5. WP11: the command palette is a sheet over the window, and
        // Escape takes it away.
        shell.openModal(.commandPalette(rows: [
            CommandPaletteRow(commandId: .toggleSplit, title: "View: Toggle Split", chords: ["Cmd+Q Z"], recent: false),
        ]))
        let sheets = shell.modals as? SheetLayer
        let palette = await until(3) { sheets?.topTitle == "Commands" }
        check(palette, "the command palette did not come up (\(sheets?.topTitle ?? "no sheet"))")
        if let picker = sheets?.view.cards.last?.content as? PickerView {
            check(picker.state.rows.map(\.label) == ["View: Toggle Split"], "the palette lists \(picker.state.rows.map(\.label))")
            check(picker.window != nil && picker.bounds.height > 100, "the palette's sheet is \(picker.bounds)")
            picker.cancel()
        }
        let paletteGone = await until(3) { !shell.modals.isPresenting }
        check(paletteGone, "Escape did not take the command palette away")

        // 6. WP11: a failure is a toast in the corner, and Cmd+Q D puts it away.
        shell.publishError(AppError.at(.fileNotFound).withSummary("Self-test notice"))
        let toast = await until(2) { shell.notices.measured != nil }
        check(toast, "a failure drew no toast")
        if let size = shell.notices.measured, let layer = shell.notices.layerView {
            check(!layer.isHidden && layer.frame.width == CGFloat(size.width), "the toast is laid out at \(layer.frame), measured \(size)")
        }
        shell.notices.dismissAlert()
        let toastGone = await until(2) { shell.notices.measured == nil }
        check(toastGone, "Cmd+Q D did not put the toast away")

        window.disposeAll()
        window.window?.orderOut(nil)
    }

    // MARK: The live phase: a private tmux server

    private let box = ShellBox()
    private var liveShell: ShellController?

    /// tmux, where Homebrew and the system put it.
    private static func findTmux() -> String? {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        let candidates = path.split(separator: ":").map { "\($0)/tmux" } + ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    @discardableResult
    private static func tmux(_ tmux: String, _ arguments: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tmux)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    /// The real runtime on a profile of its own (its own tmux server, state,
    /// settings and socket under a scratch home): Scratch's editor terminal
    /// attaches to its `ws-` session, and a new window size reaches tmux.
    private func live() async {
        guard let tmux = Self.findTmux() else {
            print("self-test: no tmux on this machine; the live phase is skipped")
            return
        }
        // `/private/tmp`, not `/tmp`: a short path for the control socket, and
        // one with no symlink in it, so every root DevHub derives from it is
        // already canonical.
        let home = "/private/tmp/dh-st-\(getpid())"
        let locations = ProfileLocations(profile: "selftest", home: home, environment: [:])
        let fm = FileManager.default
        try? fm.createDirectory(atPath: locations.configDirectory, withIntermediateDirectories: true)
        // Scratch under the real home, not under `/tmp`: a root that is
        // reached through a symlink (`/tmp` → `/private/tmp`) does not get its
        // `ws-` session on macOS (see the report on WP3).
        let scratchRoot = (NSHomeDirectory() as NSString).appendingPathComponent(".devhub-self-test-\(getpid())")
        try? fm.createDirectory(atPath: scratchRoot, withIntermediateDirectories: true)
        let settings = """
            version = \(Int(ConfigConstants.schemaVersion))

            [general]
            workbench = "terminal"

            [scratch]
            daily = "\(scratchRoot)/YYYYMMDD"

            [appearance]
            title_bar = "hidden"
            """
        try? settings.write(toFile: locations.settingsFilePath, atomically: true, encoding: .utf8)
        defer {
            Self.tmux(tmux, ["-L", locations.tmuxSocketName, "kill-server"])
            try? fm.removeItem(atPath: home)
            try? fm.removeItem(atPath: scratchRoot)
        }

        let transport = LateTransport()
        let roots = ExtensionRoots(builtin: ColorThemeCatalog.builtinRoot, user: [String]())
        let shell = ShellController(titleBar: .hidden, appearance: AppearanceController(roots: roots), transport: transport)
        liveShell = shell
        box.shell = shell
        shell.window.showWindow(nil)
        shell.window.window?.setContentSize(NSSize(width: 1100, height: 720))
        let box = self.box
        let environment = RuntimeEnvironment(
            locations: locations, appExecutable: Bundle.main.executablePath ?? CommandLine.arguments[0],
            cliExecutable: AppDelegate.cliExecutable(), titleBar: .hidden)
        let runtime: DevHubRuntime
        do {
            runtime = try await DevHubRuntime.start(
                environment, app: WindowShell(box: box),
                hooks: RuntimeHooks(config: { config in Task { @MainActor in box.shell?.configAccepted(config) } }))
        } catch {
            return check(false, "live: the runtime did not start: \(failureText(error))")
        }
        transport.target = runtime.transport
        shell.adopt(runtime)
        await runtime.controller.shellReady()

        let scratchKey = await until(20) {
            guard let snapshot = shell.snapshot, snapshot.readiness == .ready else { return false }
            return shell.window.editorTerminals.values.contains { $0.surfaceKey == TerminalSurfaceKeys.workspace(snapshot.scratchWorkspaceId) }
        }
        check(scratchKey, "live: Scratch's editor area has no terminal view")
        let accepted = await until(5) { shell.config?.general.workbench == "terminal" }
        check(accepted, "live: the self-test's settings were not accepted")
        let pane = shell.snapshot.flatMap { snapshot in
            shell.window.editorTerminals.values.first { $0.surfaceKey == TerminalSurfaceKeys.workspace(snapshot.scratchWorkspaceId) }
        }
        if let pane {
            let attached = await until(20) { pane.isAttached }
            check(attached, "live: Scratch's editor terminal did not attach to tmux (\(pane.connection))")
            if !attached, let snapshot = shell.snapshot, let scratch = snapshot.workspace(snapshot.scratchWorkspaceId) {
                let exists = FileManager.default.fileExists(atPath: scratch.root)
                let all = Self.tmux(tmux, ["-L", locations.tmuxSocketName, "list-sessions"])
                print("self-test live: Scratch is \(scratch.root) (exists: \(exists), state: \(scratch.state)); tmux has: \(all)")
            }
            layoutApplied(shell.window, "live")
            let sessions = Self.tmux(tmux, ["-L", locations.tmuxSocketName, "list-sessions", "-F", "#{session_name}"])
            check(sessions.split(separator: "\n").contains { $0.hasPrefix("ws-") }, "live: there is no ws- session (\(sessions))")
            func clientSize() -> String {
                Self.tmux(tmux, ["-L", locations.tmuxSocketName, "list-clients", "-F", "#{client_width}x#{client_height}"])
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
            let before = clientSize()
            shell.window.window?.setContentSize(NSSize(width: 900, height: 600))
            let resized = await until(10) {
                let now = clientSize()
                let grid = pane.terminal.getTerminal()
                return !now.isEmpty && now != before && now.split(separator: "\n").contains("\(grid.cols)x\(grid.rows)")
            }
            check(resized, "live: tmux's client is \(clientSize()) after a resize (was \(before))")
            pane.type("echo devhub-live\r")
            let echoed = await until(10) { pane.screenText().contains("devhub-live") }
            check(echoed, "live: what was typed in the editor terminal did not come back")
            if attached { print("self-test live: \(pane.surfaceKey) attached on tmux -L \(locations.tmuxSocketName), client \(clientSize())") }
        }
        shell.window.disposeAll()
        await runtime.shutdown()
    }
}
