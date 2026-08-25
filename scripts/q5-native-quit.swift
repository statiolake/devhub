import AppKit
import Foundation

// This helper deliberately exposes a closed protocol. The Python driver can
// retain the outcome without retaining a PID, path, or unbounded Foundation
// error description.
enum QuitOutcome: String {
    case appNotRegistered = "app_not_registered"
    case executableUnavailable = "executable_unavailable"
    case executableMismatch = "executable_mismatch"
    case notFinishedLaunching = "not_finished_launching"
    case alreadyTerminated = "already_terminated"
    case requestRejected = "request_rejected"
    case sent = "sent"
}

let turnSeconds: TimeInterval = 0.05
let timeoutSeconds: TimeInterval = 3.0

func emit(_ outcome: QuitOutcome) -> Never {
    // Keep stdout to one closed category. In particular, never print the
    // target PID or executable path from this process-only acceptance helper.
    print(outcome.rawValue)
    fflush(stdout)
    exit(0)
}

func runLoopTurn(until deadline: Date) {
    let remaining = min(turnSeconds, max(0, deadline.timeIntervalSinceNow))
    guard remaining > 0 else { return }
    RunLoop.main.run(until: Date(timeIntervalSinceNow: remaining))
}

guard CommandLine.arguments.count == 3 else {
    emit(.executableUnavailable)
}

let executableURL = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
guard let expectedPID = Int32(CommandLine.arguments[2]), expectedPID > 0 else {
    emit(.appNotRegistered)
}

let deadline = Date(timeIntervalSinceNow: timeoutSeconds)
var sawRegistration = false
var lastTransientOutcome: QuitOutcome?

while Date() < deadline {
    guard let running = NSRunningApplication(processIdentifier: expectedPID) else {
        runLoopTurn(until: deadline)
        continue
    }
    sawRegistration = true

    // A PID can remain visible to LaunchServices while its application is
    // already in the terminated state. Report that state explicitly rather
    // than issuing a request against a stale object.
    guard !running.isTerminated else {
        emit(.alreadyTerminated)
    }
    guard let actualURL = running.executableURL else {
        lastTransientOutcome = .executableUnavailable
        runLoopTurn(until: deadline)
        continue
    }
    guard actualURL.standardizedFileURL == executableURL else {
        emit(.executableMismatch)
    }
    guard running.isFinishedLaunching else {
        lastTransientOutcome = .notFinishedLaunching
        runLoopTurn(until: deadline)
        continue
    }

    // A false terminate result is not final: AppKit can reject one request
    // while the same application is still servicing its launch/run-loop
    // transition. Re-resolve and revalidate the exact PID before retrying.
    if running.terminate() {
        emit(.sent)
    }
    if Date() >= deadline {
        break
    }
    runLoopTurn(until: deadline)
}

// Registration lag and launch readiness are bounded transient states. Report
// the last closed transient only after the deadline; an executable mismatch,
// termination, or successful request exits immediately above.
if let lastTransientOutcome {
    emit(lastTransientOutcome)
}
emit(sawRegistration ? .requestRejected : .appNotRegistered)
