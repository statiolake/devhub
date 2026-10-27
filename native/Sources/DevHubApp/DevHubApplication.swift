import AppKit

// DevHub, native: the application's entry point (docs/PLAN.md, WP9).
//
// `DevHub --self-test` draws the real window from a fixture projection on the
// loopback terminal transport and checks the layout, the Sidebar, the
// terminal surfaces and the chords, then exits 0 — what CI runs on macOS
// (`SelfTest`). CI starts it with `open`, as Finder would, so that it is an
// application the Mac lets come to the front; `SelfTestLaunch` takes what the
// shell would have handed it (its environment, where its output and its exit
// status go) from its arguments.

@main
enum DevHubApplication {
    @MainActor
    static func main() {
        let selfTest = CommandLine.arguments.contains("--self-test")
        if selfTest { SelfTestLaunch.adopt(CommandLine.arguments) }
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

/// `--self-test-env FILE` (`KEY=VALUE` lines), `--self-test-log FILE` (stdout
/// and stderr) and `--self-test-result FILE` (the exit status): what a process
/// started by `open` cannot be given by the shell that started it.
enum SelfTestLaunch {
    nonisolated(unsafe) static var resultPath: String?

    static func value(_ arguments: [String], _ name: String) -> String? {
        guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    static func adopt(_ arguments: [String]) {
        if let log = value(arguments, "--self-test-log") {
            let fd = Darwin.open(log, O_WRONLY | O_CREAT | O_APPEND, 0o644)
            if fd >= 0 {
                dup2(fd, STDOUT_FILENO)
                dup2(fd, STDERR_FILENO)
                close(fd)
            }
        }
        if let file = value(arguments, "--self-test-env"), let text = try? String(contentsOfFile: file, encoding: .utf8) {
            for line in text.split(separator: "\n") {
                guard let equals = line.firstIndex(of: "=") else { continue }
                setenv(String(line[..<equals]), String(line[line.index(after: equals)...]), 1)
            }
        }
        resultPath = value(arguments, "--self-test-result")
    }

    /// One line of the self-test's own, written at once (`print` waits in
    /// a buffer while the output is a file).
    static func say(_ line: String) {
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }

    /// Leave with `code`, said where the starter looks for it.
    static func exit(_ code: Int32) -> Never {
        if let resultPath { try? "\(code)\n".write(toFile: resultPath, atomically: true, encoding: .utf8) }
        Darwin.exit(code)
    }
}
