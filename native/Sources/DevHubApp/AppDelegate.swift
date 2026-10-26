import AppKit
import DevHubCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let selfTest: Bool
    private var windowController: MainWindowController?

    init(selfTest: Bool) {
        self.selfTest = selfTest
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = MainMenu.build()
        let controller = MainWindowController()
        windowController = controller
        controller.showWindow(nil)
        NSApp.activate()

        if selfTest {
            runSelfTest(controller)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Window Close leaves the process (and every tmux session) running,
        // as the TypeScript app does; Quit is Cmd+Q Cmd+Q.
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { windowController?.showWindow(nil) }
        return true
    }

    private func runSelfTest(_ controller: MainWindowController) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            var failures: [String] = []
            if controller.window?.isVisible != true { failures.append("the main window is not visible") }
            if !TerminalSurfaceProbe.links() { failures.append("the terminal surface did not link") }
            if failures.isEmpty {
                print("self-test ok: \(DevHubVersion.description)")
                exit(0)
            } else {
                FileHandle.standardError.write(Data("self-test failed: \(failures.joined(separator: "; "))\n".utf8))
                exit(1)
            }
        }
    }
}
