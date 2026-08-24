import AppKit
import Carbon.HIToolbox
import Foundation

guard CommandLine.arguments.count == 3 else {
    fputs("usage: q5-native-reopen <bundle-path> <pid>\n", stderr)
    exit(64)
}

let bundleURL = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let expectedBundleIdentifier = "io.github.statiolake.devhub"
guard let expectedPID = Int32(CommandLine.arguments[2]), expectedPID > 0 else {
    fputs("invalid pid\n", stderr)
    exit(64)
}
guard let running = NSRunningApplication(processIdentifier: expectedPID),
      running.bundleURL?.standardizedFileURL == bundleURL.standardizedFileURL,
      running.bundleIdentifier == expectedBundleIdentifier,
      Bundle(url: bundleURL)?.bundleIdentifier == expectedBundleIdentifier else {
    fputs("running bundle identity mismatch\n", stderr)
    exit(1)
}

let targetDescriptor = NSAppleEventDescriptor(processIdentifier: expectedPID)
let reopenEvent = NSAppleEventDescriptor(
    eventClass: AEEventClass(kCoreEventClass),
    eventID: AEEventID(kAEReopenApplication),
    targetDescriptor: targetDescriptor,
    returnID: AEReturnID(kAutoGenerateReturnID),
    transactionID: AETransactionID(kAnyTransactionID)
)
do {
    let noReply = NSAppleEventDescriptor.SendOptions(rawValue: UInt(kAENoReply))
    _ = try reopenEvent.sendEvent(options: noReply, timeout: 5)
} catch {
    fputs("Core Apple Event reopen failed\n", stderr)
    exit(1)
}
_ = running.activate(options: [.activateAllWindows])
if running.processIdentifier != expectedPID {
    fputs("running process changed during reopen\n", stderr)
    exit(1)
}
print(expectedPID)
