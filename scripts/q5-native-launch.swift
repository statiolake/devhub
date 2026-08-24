import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("usage: q5-native-launch <bundle-path>\n", stderr)
    exit(64)
}

let bundleURL = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
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
    fputs("LaunchServices timed out\n", stderr)
    exit(1)
}
if launchedPID <= 0 {
    if let launchError {
        fputs("LaunchServices failed: \(launchError.localizedDescription)\n", stderr)
    }
    exit(1)
}
print(launchedPID)
