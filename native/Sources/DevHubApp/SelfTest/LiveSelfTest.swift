// The end-to-end phase of `DevHub --self-test`: the real app (`LiveApp`, the
// same assembly a launch makes) on a profile of its own — its own tmux
// server, state, settings and control socket under a scratch home — in the
// self-test's world (`SelfTestWorld`: project folders, a Claude session to
// resume, stand-ins for `claude`, `codex` and a signed-out `gh`), driven the
// way a person drives it: keys and clicks into the event queue
// (`SelfTestDriver`), and the outcome read back from the window, the
// projection, tmux and the files DevHub writes.
//
// What it goes through, in order (each its own prefix in a failure):
//
//   scratch      Scratch's editor terminal attaches to its ws- session, types,
//                and a new window size reaches tmux's client
//   sheets       the palette, the keyboard shortcuts, Go to, Open Workspace
//                (cancelled, then two folders opened), New Agent
//   conversation a message to the stand-in Claude and its streamed Markdown
//                reply (table, code, math), a permission request answered with
//                its number key, ⌘F through the transcript, /resume's picker,
//                Make default (Claude's settings.json), Rename
//   dictation    whisper.cpp hearing a recording played in place of the
//                microphone, into the composer (when a recogniser is there)
//   codex        a Codex Agent and Make default (Codex's config.toml); a stop
//                and a Workspace close asked and answered
//   issue        Assign Issue against the clone, with `gh` signed out
//   notices      toasts hiding into the notice center, the center opened from
//                the keyboard, its words selected and copied
//   settings     a change on every screen written to settings.toml after the
//                save's pause and taken up by the app, the key recorder, Reset
//   exits        `exit` in a Workspace's editor terminal: closed, asked and
//                kept (a fresh ws- session), Scratch started over, a tmux
//                detach attached again, DevHub's own close and quit not exits

import AppKit
import DevHubCore

@MainActor
final class LiveSelfTest {
    var failures: [String] = []
    var world: SelfTestWorld!
    var live: LiveApp!
    var runtime: DevHubRuntime!
    var tmux = ""
    /// Every editor-area client that ended by itself, by Workspace id.
    var endedByItself: [String] = []

    var shell: ShellController { live.shell }
    var window: NSWindow? { shell.window.window }
    var snapshot: AppSnapshotWire? { shell.snapshot }
    var sheets: SheetLayer? { shell.modals as? SheetLayer }

    /// tmux, where Homebrew and the system put it.
    static func findTmux() -> String? {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        let candidates = path.split(separator: ":").map { "\($0)/tmux" } + ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    @discardableResult
    func tmuxSays(_ arguments: [String]) -> String {
        SelfTestDriver.run(tmux, ["-L", world.locations.tmuxSocketName] + arguments).output
    }

    func sessions() -> [String] {
        tmuxSays(["list-sessions", "-F", "#{session_name}"]).split(separator: "\n").map(String.init)
    }

    /// The phase's driver; its failures are this run's.
    func phase(_ name: String, _ body: (SelfTestDriver) async -> Void) async {
        let driver = SelfTestDriver(prefix: "live \(name)")
        SelfTestLaunch.say("self-test live: \(name)")
        await body(driver)
        failures += driver.failures
    }

    /// The top sheet's picker, when the top sheet is one.
    var picker: PickerView? { sheets?.view.cards.last?.content as? PickerView }

    func run() async -> [String] {
        guard let tmux = Self.findTmux() else {
            SelfTestLaunch.say("self-test: no tmux on this machine; the live phase is skipped")
            return []
        }
        guard let python = SelfTestWorld.findPython() else {
            return ["live: there is no python3 for the stand-in CLIs"]
        }
        self.tmux = tmux
        // `/private/tmp`, not `/tmp`: a short path for the control socket,
        // and one with no symlink in it. Scratch is named through the `/tmp`
        // symlink on purpose: its root must come out canonical (realpath).
        let pid = getpid()
        let home = "/private/tmp/dh-st-\(pid)"
        do {
            world = try SelfTestWorld.make(home: home, scratchRoot: "/tmp/dh-st-\(pid)-scratch", python: python)
        } catch {
            return ["live: the self-test's world could not be made: \(failureText(error))"]
        }
        defer {
            if !failures.isEmpty { printLogs() }
            tmuxSays(["kill-server"])
            try? FileManager.default.removeItem(atPath: world.home)
            try? FileManager.default.removeItem(atPath: world.scratchRoot)
        }
        // The stand-ins first on the PATH everything DevHub runs is given
        // (the settings turn the login shell's import off).
        let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
        setenv("PATH", "\(world.bin):\(path)", 1)

        live = LiveApp(locations: world.locations, extensionRoots: ExtensionRoots(builtin: ColorThemeCatalog.builtinRoot, user: [String]()))
        window?.setContentSize(NSSize(width: 1200, height: 800))
        let environment = RuntimeEnvironment(
            locations: world.locations, appExecutable: Bundle.main.executablePath ?? CommandLine.arguments[0],
            cliExecutable: AppDelegate.cliExecutable(), titleBar: live.titleBar)
        do {
            runtime = try await live.start(environment)
        } catch {
            return ["live: the runtime did not start: \(failureText(error))"]
        }
        // Every client that ends by itself is counted, then handed on.
        let handed = runtime.surfaces.attachments.onEndedByItself
        runtime.surfaces.attachments.onEndedByItself = { [weak self] key, target in
            if key.hasPrefix(TerminalSurfaceKeys.workspacePrefix) {
                let id = String(key.dropFirst(TerminalSurfaceKeys.workspacePrefix.count))
                Task { @MainActor in self?.endedByItself.append(id) }
            }
            handed?(key, target)
        }
        NSApp.activate()
        if !NSApp.isActive { NSRunningApplication.current.activate(options: [.activateAllWindows]) }
        window?.makeKeyAndOrderFront(nil)
        let active = await SelfTestDriver(prefix: "live").until(5) { NSApp.isActive && self.window?.isKeyWindow == true }
        SelfTestLaunch.say("self-test live: active \(NSApp.isActive), key window \(window?.isKeyWindow == true) (\(active))")

        await phase("scratch") { await scratch($0) }
        await phase("sheets") { await sheetsPhase($0) }
        await phase("conversation") { await conversation($0) }
        await phase("dictation") { await dictation($0) }
        await phase("codex") { await codex($0) }
        await phase("issue") { await issue($0) }
        await phase("notices") { await notices($0) }
        await phase("settings") { await settings($0) }
        await phase("exits") { await exits($0) }
        return failures
    }

    /// What DevHub and the stand-ins said, for a reader of a failed run.
    func printLogs() {
        for (name, path) in [("devhub-main.log", world.locations.mainLogPath), ("stand-ins", world.log)] {
            let text = (try? String(contentsOfFile: path, encoding: .utf8)) ?? "(none)"
            let lines = text.split(separator: "\n", omittingEmptySubsequences: false).suffix(120)
            SelfTestLaunch.say("self-test live: ---- \(name), last \(lines.count) lines ----")
            for line in lines { SelfTestLaunch.say("  \(line.prefix(400))") }
        }
    }

    // MARK: Helpers the phases share

    func workspace(root: String) -> WorkspaceWire? {
        let canonical = SelfTestWorld.canonical(root)
        return snapshot?.workspaces.first { $0.root == canonical || $0.root == root }
    }

    func agent(_ id: String) -> AgentWire? {
        snapshot?.workspaces.lazy.flatMap(\.agents).first { $0.id == id }
    }

    func editorPane(_ workspaceId: String) -> TerminalPaneView? {
        shell.window.editorTerminals.values.first { $0.surfaceKey == TerminalSurfaceKeys.workspace(workspaceId) }
    }

    func pane(_ agentId: String) -> ConversationPaneView? {
        live.conversations.link.pane(agentId)
    }

    /// Escape until no sheet is up (a wizard goes back one question at a time).
    func dismissSheets(_ d: SelfTestDriver, _ what: String) async {
        for _ in 0..<8 where shell.modals.isPresenting {
            await d.press(.escape, in: window)
            await d.pause(0.25)
        }
        d.check(!shell.modals.isPresenting, "\(what): Escape did not take the sheets away (\(sheets?.topTitle ?? "?"))")
    }

    /// The rows of the top picker, by id.
    var pickerRowIds: [String] { picker?.state.rows.map(\.id) ?? [] }
    var pickerRowLabels: [String] { picker?.state.rows.map(\.label) ?? [] }

    /// Down to the row `id` in the top picker; whether it got there.
    func pointAt(_ d: SelfTestDriver, _ id: String) async -> Bool {
        guard let picker else { return false }
        for _ in 0..<picker.state.rows.count {
            if picker.state.activeRow?.id == id { return true }
            await d.press(.down, in: window)
        }
        return picker.state.activeRow?.id == id
    }
}
