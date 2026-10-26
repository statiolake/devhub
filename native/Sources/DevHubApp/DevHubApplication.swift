import AppKit

// DevHub, native. Phase 0: one empty window with the sidebar column and the
// content area the real layout (docs/PLAN.md, WP9) will fill.
//
// `DevHubApp --self-test` opens the window, checks it is on screen and that
// the terminal surface links, then exits 0 — what CI runs on macOS.

@main
enum DevHubApplication {
    @MainActor
    static func main() {
        let selfTest = CommandLine.arguments.contains("--self-test")
        let application = NSApplication.shared
        let delegate = AppDelegate(selfTest: selfTest)
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        // NSApplication.delegate is weak; `run()` does not return until quit,
        // so this keeps the delegate alive for the process's life.
        withExtendedLifetime(delegate) {
            application.run()
        }
    }
}
