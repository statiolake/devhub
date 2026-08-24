import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("usage: q5-native-launch <bundle-path>\n", stderr)
    exit(64)
}

let bundleURL = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let expectedBundleIdentifier = "io.github.statiolake.devhub"
guard Bundle(url: bundleURL)?.bundleIdentifier == expectedBundleIdentifier else {
    fputs("bundle identity mismatch\n", stderr)
    exit(1)
}
let configuration = NSWorkspace.OpenConfiguration()
configuration.environment = ProcessInfo.processInfo.environment

let semaphore = DispatchSemaphore(value: 0)
var launchedPID: pid_t = 0
var launchError: Error?
NSWorkspace.shared.openApplication(at: bundleURL, configuration: configuration) { application, error in
    launchedPID = application?.processIdentifier ?? 0
    launchError = error
    semaphore.signal()
}

if semaphore.wait(timeout: .now() + 15) == .timedOut {
    fputs("launch_callback_timeout\n", stderr)
    exit(1)
}
if let launchError {
    fputs("launch_callback_error: \(launchError.localizedDescription)\n", stderr)
    exit(1)
}
guard launchedPID > 0 else {
    fputs("invalid_pid\n", stderr)
    exit(1)
}
guard let application = NSRunningApplication(processIdentifier: launchedPID) else {
    fputs("launched_process_exited\n", stderr)
    exit(1)
}
guard application.bundleIdentifier == expectedBundleIdentifier,
      application.bundleURL?.standardizedFileURL == bundleURL.standardizedFileURL else {
    fputs("bundle_identity_mismatch\n", stderr)
    exit(1)
}
print(launchedPID)
