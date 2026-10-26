// Port of main/shell/bootstrapShell.ts's application half and of
// main/shell/openFromFinder.ts: one DevHub per profile (a second launch hands
// its paths to the first and leaves), the window up before the runtimes so
// their messages have somewhere to go, the runtimes (`DevHubRuntime.start`),
// the control socket last, Finder's opens queued until it is up, the Dock's
// reopen, a wake from sleep, and the quit: the state saved as a clean exit,
// every client detached and every session left running, inside the deadline.

import AppKit
import DevHubCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let selfTest: Bool
    private(set) var shell: ShellController?
    private(set) var runtime: DevHubRuntime?
    private let menu = MainMenu()
    private let box = ShellBox()
    private let transport = LateTransport()
    /// Paths Finder handed over before the runtime could take them.
    private var pendingOpens: [String] = []
    private var quitting = false
    private var wakeObserver: NSObjectProtocol?
    private var selfTestRun: SelfTest?

    init(selfTest: Bool) {
        self.selfTest = selfTest
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        menu.host = self
        NSApp.mainMenu = menu.build()
        if selfTest {
            let run = SelfTest()
            selfTestRun = run
            run.start()
            return
        }
        Task { await launch() }
    }

    // MARK: Launch

    private func fail(_ message: String, _ detail: String) -> Never {
        MainLog.shared.error("[devhub] \(message): \(detail)")
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = detail
        alert.alertStyle = .critical
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        exit(1)
    }

    private func launch() async {
        let locations: ProfileLocations
        do {
            locations = try ProfileLocations.current()
        } catch {
            fail("DevHub could not start", String(describing: error))
        }
        // `requestSingleInstanceLock`: another DevHub on this profile is the
        // one; it is brought forward, given what Finder gave this one, and
        // this one leaves before touching anything.
        if await ControlClient.socketAnswers(locations.controlSocketPath) {
            _ = try? await ControlClient.ask(locations.controlSocketPath, .activate)
            for path in pendingOpens {
                _ = try? await ControlClient.ask(locations.controlSocketPath, .open(Self.openRequest(path)))
            }
            exit(0)
        }

        // The window is made in the settings' chrome and colours, read before
        // the settings can be loaded.
        let text = try? String(contentsOfFile: locations.settingsFilePath, encoding: .utf8)
        let titleBar = ConfigParsing.titleBarMode(in: text)
        let themes = ConfigParsing.colorThemes(in: text)
        let names = ColorThemeNames(dark: themes.dark, light: themes.light)
        let appearance = AppearanceController(names: names, roots: ExtensionRoots.standard(profile: locations, home: NSHomeDirectory()))
        appearance.configure(mode: ConfigParsing.appearanceMode(in: text), names: names)
        let shell = ShellController(titleBar: titleBar, appearance: appearance, transport: transport)
        self.shell = shell
        box.shell = shell
        shell.openSettings = { MainLog.shared.log("[devhub] the Settings window is not drawn in this build yet") }
        shell.window.showWindow(nil)
        NSApp.activate()
        shell.installKeyboard()

        let environment = RuntimeEnvironment(
            locations: locations, appExecutable: Bundle.main.executablePath ?? CommandLine.arguments[0],
            cliExecutable: Self.cliExecutable(), titleBar: titleBar)
        let box = self.box
        let hooks = RuntimeHooks(
            repositories: { status in Task { @MainActor in box.shell?.repositoriesChanged(status) } },
            usageLimits: { limits in Task { @MainActor in box.shell?.usageLimitsChanged(limits) } },
            config: { config in Task { @MainActor in box.shell?.configAccepted(config) } })
        let runtime: DevHubRuntime
        do {
            runtime = try await DevHubRuntime.start(environment, app: WindowShell(box: box), hooks: hooks)
        } catch {
            fail("DevHub could not start", failureText(error))
        }
        self.runtime = runtime
        transport.target = runtime.transport
        shell.adopt(runtime)
        await runtime.controller.shellReady()
        do {
            try await runtime.openControlSocket()
        } catch {
            // Another DevHub claimed the profile while this one started.
            MainLog.shared.error("[devhub] the control socket could not be opened: \(failureText(error))")
            fail("Another DevHub is already running", failureText(error))
        }
        for path in pendingOpens { await runtime.finderOpens.offer(path) }
        pendingOpens = []
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { _ in
            Task { await runtime.resumed() }
        }
    }

    static func openRequest(_ path: String) -> ControlOpenRequest {
        ControlOpenRequest(path: path, cwd: (path as NSString).deletingLastPathComponent)
    }

    /// The `devhub` command inside the bundle (or beside a bare executable).
    static func cliExecutable() -> String {
        if let resources = Bundle.main.resourceURL?.appendingPathComponent("bin/devhub").path,
           FileManager.default.isExecutableFile(atPath: resources)
        {
            return resources
        }
        let beside = ((Bundle.main.executablePath ?? CommandLine.arguments[0]) as NSString).deletingLastPathComponent
        return (beside as NSString).appendingPathComponent("devhub")
    }

    // MARK: Finder (`application(_:open:)`)

    func application(_ application: NSApplication, open urls: [URL]) {
        let paths = urls.filter(\.isFileURL).map(\.path)
        guard let runtime else {
            pendingOpens += paths
            return
        }
        Task {
            for path in paths { await runtime.finderOpens.offer(path) }
        }
    }

    // MARK: The Dock

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Closing the window leaves the process (and every tmux session)
        // running; quitting is Cmd+Q Cmd+Q or the menu.
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // `raiseFromAppActivation`: only a window that was put away needs it.
        if let window = shell?.window.window, !window.isVisible {
            shell?.bringToFront()
        }
        return true
    }

    // MARK: Quit (`before-quit`)

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if selfTest { return .terminateNow }
        guard let runtime else { return .terminateNow }
        if quitting { return .terminateLater }
        quitting = true
        MainLog.shared.log("[devhub] quit: shutting down")
        shell?.window.disposeAll()
        let deadline = Double(DevHubRuntime.shutdownDeadlineMs) / 1000
        Task.detached {
            await withTaskGroup(of: Bool.self) { group in
                group.addTask {
                    await runtime.shutdown()
                    return true
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: UInt64(deadline * 1_000_000_000))
                    return false
                }
                if let first = await group.next(), !first {
                    MainLog.shared.warn("[devhub] quit: shutdown did not finish in time")
                }
                group.cancelAll()
            }
            await MainActor.run { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    /// `Restart DevHub`: quit, and start again once this process has gone.
    func relaunch() {
        let bundle = Bundle.main.bundleURL.pathExtension == "app" ? Bundle.main.bundlePath : nil
        let executable = Bundle.main.executablePath ?? CommandLine.arguments[0]
        let pid = ProcessInfo.processInfo.processIdentifier
        let start = bundle.map { "/usr/bin/open -n \(Self.quoted($0))" } ?? Self.quoted(executable)
        let script = "while /bin/kill -0 \(pid) 2>/dev/null; do /bin/sleep 0.2; done; \(start)"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", script]
        try? process.run()
        NSApp.terminate(nil)
    }

    private static func quoted(_ text: String) -> String {
        "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

extension AppDelegate: MenuHost {
    func menuSelectedWorkspace() -> (id: String, label: String)? {
        guard let snapshot = shell?.snapshot, let workspace = snapshot.workspace(for: snapshot.selection.context),
              workspace.id != snapshot.scratchWorkspaceId else { return nil }
        return (workspace.id, workspace.label)
    }

    func menuCloseWorkspace(_ workspaceId: String) { shell?.requestCloseWorkspace(workspaceId) }

    func menuOpenWorkspacePicker() { shell?.openModal(.workspacePicker) }

    func menuOpenSettings() { shell?.openSettings?() }

    func menuRestart() { relaunch() }

    func menuInstallCli() {
        guard let controller = runtime?.controller else { return }
        Task { @MainActor in
            let alert = NSAlert()
            do {
                alert.messageText = try await controller.installCli()
            } catch {
                alert.messageText = "The ‘devhub’ command could not be installed."
                alert.informativeText = failureText(error)
                alert.alertStyle = .warning
            }
            alert.runModal()
        }
    }
}

/// The attach transport before the runtime exists: an attach fails as a
/// surface that is unavailable, and every later one goes to the runtime's.
final class LateTransport: TerminalAttachTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var targetValue: TerminalAttachTransport?

    var target: TerminalAttachTransport? {
        get { lock.withLock { targetValue } }
        set { lock.withLock { targetValue = newValue } }
    }

    private func live() throws -> TerminalAttachTransport {
        guard let target else { throw TerminalFailure(.surfaceUnavailable) }
        return target
    }

    func attach(surfaceKey: String, viewLabel: String, size: TerminalSize, sink: @escaping TerminalFrameSink) async throws
        -> TerminalAttachReceipt
    {
        try await live().attach(surfaceKey: surfaceKey, viewLabel: viewLabel, size: size, sink: sink)
    }

    func input(_ identity: TerminalRequestIdentity, sequence: Int, _ bytes: Data) throws {
        try live().input(identity, sequence: sequence, bytes)
    }

    func resize(_ identity: TerminalRequestIdentity, _ size: TerminalSize) throws { try live().resize(identity, size) }

    func acknowledge(_ identity: TerminalRequestIdentity, sequence: Int) throws {
        try live().acknowledge(identity, sequence: sequence)
    }

    func detach(_ identity: TerminalRequestIdentity) throws { try live().detach(identity) }
}
