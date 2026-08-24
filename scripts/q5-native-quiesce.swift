import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
    fputs("usage: q5-native-quiesce <bundle-path> <pid>\n", stderr)
    exit(64)
}

let bundleURL = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true).standardizedFileURL
let expectedBundleIdentifier = "io.github.statiolake.devhub"
guard let expectedPID = Int32(CommandLine.arguments[2]), expectedPID >= 0 else {
    fputs("invalid pid\n", stderr)
    exit(64)
}
guard Bundle(url: bundleURL)?.bundleIdentifier == expectedBundleIdentifier else {
    fputs("bundle identity mismatch\n", stderr)
    exit(1)
}

let deadline = Date().addingTimeInterval(10)
while Date() < deadline {
    let oldProcessPresent = expectedPID > 0 &&
        NSRunningApplication(processIdentifier: expectedPID) != nil
    let sameBundleProcesses = NSWorkspace.shared.runningApplications.contains { application in
        guard application.bundleIdentifier == expectedBundleIdentifier,
              let runningURL = application.bundleURL?.standardizedFileURL else { return false }
        return runningURL == bundleURL
    }
    if !oldProcessPresent && !sameBundleProcesses {
        print("quiescent")
        exit(0)
    }
    usleep(50_000)
}

fputs("bundle quiescence timeout\n", stderr)
exit(1)
