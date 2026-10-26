import AppKit

// DevHub, native: the application's entry point (docs/PLAN.md, WP9).
//
// `DevHub --self-test` draws the real window from a fixture projection on the
// loopback terminal transport and checks the layout, the Sidebar, the
// terminal surfaces and the chords, then exits 0 — what CI runs on macOS
// (`SelfTest`).

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
