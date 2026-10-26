// Port of apps/desktop/src/main/cli/launch.ts, and the socket client half of
// devhubCli.ts (`ask`)
//
// Starting DevHub when `devhub` finds it is not running.
//
// Every `devhub` command does this, not just a bare one. The command names a
// DevHub — its profile's control socket is written into the launcher script —
// and "there is no DevHub listening" is a fact about the moment rather than an
// answer to what was asked. So the CLI starts it, and then asks again. The
// request that follows is the request that was typed, unchanged.
//
// How DevHub is started is not guessed here. It is *recorded* by the app that
// installed the launcher, in `DEVHUB_LAUNCH_COMMAND`, because the app is the
// only thing that knows how it was itself started:
//
//   - A bundled DevHub records `open -a <the .app that is running>
//     --background`: the path rather than the bundle identifier, because a
//     DevHub never launched from the Finder is not yet known to Launch
//     Services. `--background` because the request that follows decides
//     whether DevHub comes forward.
//   - A DevHub run straight from a build records its own executable, which is
//     the app and does not exit (the TypeScript app's `dev.sh`).
//
// What is watched, either way, is the control socket: DevHub is ready exactly
// when the socket answers, and a launch command that exits non-zero before
// then is reported for what it is instead of being waited out.
//
// Nothing here worries about two `devhub` commands racing into a cold start.
// The second one starts a second app, the app's single-instance claim turns
// that into a no-op, and both then wait for the one socket.

import Foundation

/// The launcher script's record of how to start the DevHub it belongs to.
public let launchCommandEnvironmentVariable = "DEVHUB_LAUNCH_COMMAND"

/// How long a cold start is given before the wait is called a failure.
public let launchTimeoutMs = 30_000

/// How often the socket is asked, while waiting.
public let launchPollMs = 200

/// How long a `ping` is given before the silence is the answer.
public let livenessTimeoutMs = 2_000

/// The socket said nothing was there. A type rather than a message, because
/// the callers need to tell "DevHub is not running" from every other reason a
/// request can fail.
public struct DevHubNotRunning: Error, Equatable, CustomStringConvertible, Sendable {
    public init() {}
    public var description: String { "DevHub is not running." }
}

/// A sentence the CLI prints as its failure.
public struct DevhubFailure: Error, Equatable, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public enum ControlClient {
    /// Send one request and read its one-line answer.
    public static func ask(_ socketPath: String, _ request: ControlRequest) async throws -> ControlResponse {
        let line = request.line
        let answer: String = try await UnixStream.offload {
            let fd: Int32
            do {
                fd = try UnixStream.connect(socketPath)
            } catch let failure as UnixStream.Failure {
                if failure.code == ENOENT || failure.code == ECONNREFUSED { throw DevHubNotRunning() }
                throw failure
            }
            defer { UnixStream.close(fd) }
            try UnixStream.write(fd, line)
            var buffer: [UInt8] = []
            while true {
                let chunk = try UnixStream.read(fd)
                if chunk.isEmpty { break }
                buffer.append(contentsOf: chunk)
            }
            let text = String(decoding: buffer, as: UTF8.self)
            return String(text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        }
        if answer.isEmpty {
            throw DevhubFailure("DevHub closed the connection without answering.")
        }
        return try ControlResponse.parse(answer)
    }

    /// Whether there is a DevHub there.
    ///
    /// It **asks**, and the answer coming back is the whole test. Connecting
    /// is not: a `devhub` on a host talks over a unix socket `ssh -R` forwarded
    /// onto it, which belongs to the host's sshd and accepts a connection
    /// whether or not anything is still listening at the far end. A socket
    /// that accepts and then says nothing is exactly what a dead far end looks
    /// like, so "no answer in time" *is* the answer "not running".
    public static func socketAnswers(_ socketPath: String, timeoutMs: Int = livenessTimeoutMs) async -> Bool {
        let ping = ControlRequest.ping.line
        return (try? await UnixStream.offload { () -> Bool in
            guard let fd = try? UnixStream.connect(socketPath) else { return false }
            defer { UnixStream.close(fd) }
            UnixStream.setReadTimeout(fd, seconds: Double(timeoutMs) / 1000)
            let started = Date()
            guard (try? UnixStream.write(fd, ping)) != nil else { return false }
            var buffer: [UInt8] = []
            while Date().timeIntervalSince(started) * 1000 < Double(timeoutMs) {
                guard let chunk = try? UnixStream.read(fd) else { return false }
                if chunk.isEmpty { return buffer.contains(0x0A) }
                buffer.append(contentsOf: chunk)
                // One line of JSON is the protocol's whole answer; anything
                // that answers at all is a DevHub.
                if buffer.contains(0x0A) { return true }
            }
            return false
        }) ?? false
    }
}

/// The things starting DevHub needs from the world, so that the tests do not
/// need the world.
public protocol DevhubLauncher: Sendable {
    /// Start DevHub, and report only failure: it throws the reason the command
    /// could not be started, or that it started and gave up; it never returns,
    /// because "the command ran" is not the question. It ends when cancelled.
    func open() async throws -> Never
    /// What to say when DevHub is not answering and `open` did not fix it.
    func cannotStart(_ reason: String) -> String
    /// What was started, named in the message when it never answers.
    var description: String { get }
    /// The socket being waited on, named in the same message.
    var socketPath: String { get }
    /// Whether the control socket is answering right now.
    func answers() async -> Bool
    func pause(milliseconds: Int) async throws
    func now() -> Double
}

public enum DevhubLaunch {
    /// The command that starts this DevHub, as the app that installed the
    /// launcher knows it: `open -a <bundle> --background` for an app inside
    /// a `.app` bundle, the executable itself otherwise.
    public static func launchCommand(forAppExecutable executable: String) -> [String] {
        var path = executable
        while path != "/" && !path.isEmpty {
            if path.hasSuffix(".app") {
                return ["/usr/bin/open", "-a", path, "--background"]
            }
            path = (path as NSString).deletingLastPathComponent
        }
        return [executable]
    }

    /// What the launcher script recorded, read back. A launcher without it is
    /// one written by an older DevHub, and that is said out loud rather than
    /// papered over with a guess.
    public static func parseLaunchCommand(_ raw: String?) throws -> [String] {
        guard let raw, !raw.isEmpty else {
            throw DevhubFailure(
                "\(launchCommandEnvironmentVariable) is not set, so this launcher does not know how to start DevHub. Run \"DevHub: Install 'devhub' command in PATH\" from DevHub's command palette to write it again."
            )
        }
        guard let parsed = try? WireJSON.parse(raw), let items = parsed.arrayValue, !items.isEmpty,
            items.allSatisfy({ $0.stringValue != nil })
        else {
            throw DevhubFailure("\(launchCommandEnvironmentVariable) is not a command: \(raw)")
        }
        return items.compactMap(\.stringValue)
    }

    /// Send a request; if there is no DevHub to send it to, make one and send
    /// the same request again. What comes back is an answer to what was
    /// asked, so every caller past this line is written once.
    public static func sendOrLaunch(
        _ send: @Sendable () async throws -> ControlResponse, launcher: any DevhubLauncher
    ) async throws -> ControlResponse {
        do {
            return try await send()
        } catch is DevHubNotRunning {
            try await launchAndWait(launcher)
            return try await send()
        }
    }

    /// Start DevHub and wait for it to be able to answer: for the socket, not
    /// for a duration, with a ceiling so a DevHub which never comes up is
    /// reported instead of hanging a terminal forever.
    public static func launchAndWait(_ launcher: any DevhubLauncher) async throws {
        let failure = LaunchFailure()
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                do {
                    try await launcher.open()
                } catch is CancellationError {
                    return
                } catch {
                    let reported = DevhubFailure(launcher.cannotStart(controlFailureText(error)))
                    await failure.set(reported)
                    throw reported
                }
            }
            group.addTask {
                try await waitForSocket(launcher, failure: failure)
            }
            defer { group.cancelAll() }
            // The first to finish decides: the socket answering, or the
            // launch failing. A launch that fails after DevHub has already
            // answered is not this command's business.
            do {
                while let _ = try await group.next() {
                    return
                }
            } catch {
                // A launch that failed is the report, even when the wait gave
                // up in the same moment: it says what was attempted.
                if let reported = await failure.value { throw reported }
                throw error
            }
        }
    }

    static func waitForSocket(_ launcher: any DevhubLauncher, failure: LaunchFailure = LaunchFailure()) async throws {
        let deadline = launcher.now() + Double(launchTimeoutMs)
        while true {
            // The launch's own failure, as soon as there is one: a wrong path
            // is reported at once rather than waited out.
            await Task.yield()
            if let reported = await failure.value { throw reported }
            if await launcher.answers() { return }
            if launcher.now() >= deadline {
                throw DevhubFailure(
                    "DevHub was started with \(launcher.description), but nothing was listening on \(launcher.socketPath) within \(launchTimeoutMs / 1000) seconds."
                )
            }
            try await launcher.pause(milliseconds: launchPollMs)
        }
    }
}

/// The launch command's failure, once it has one.
actor LaunchFailure {
    private(set) var value: DevhubFailure?
    func set(_ failure: DevhubFailure) { value = failure }
}

/// The real thing: a command, the socket, and the clock.
public struct CommandLauncher: DevhubLauncher {
    public let socketPath: String
    public let command: [String]
    let environment: [String: String]

    public init(socketPath: String, command: [String], environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.socketPath = socketPath
        self.command = command
        self.environment = environment
    }

    public var description: String { command.joined(separator: " ") }

    public func cannotStart(_ reason: String) -> String {
        "DevHub is not running, and it could not be started: \(reason)\nThe 'devhub' launcher starts DevHub with \(command.joined(separator: " ")). If DevHub has moved, run \"DevHub: Install 'devhub' command in PATH\" from DevHub's command palette again."
    }

    /// Run the launch command and let it outlive this process. Only failure
    /// is reported: it could not be started, or it exited non-zero. Exit 0 is
    /// what `open` does the moment it has handed the request over, and says
    /// nothing about whether DevHub came up — the socket answers that.
    public func open() async throws -> Never {
        guard let program = command.first else { throw DevhubFailure("the launch command is empty") }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: program)
        process.arguments = Array(command.dropFirst())
        var environment = self.environment
        // Set for the TypeScript CLI under Electron; never for an app.
        environment["ELECTRON_RUN_AS_NODE"] = nil
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let exit = LaunchExitBox()
        process.terminationHandler = { finished in exit.finish(finished.terminationStatus) }
        do {
            try process.run()
        } catch {
            throw DevhubFailure(spawnFailure(program, error))
        }
        let status = try await exit.wait()
        if status != 0 {
            throw DevhubFailure("\(program) exited with status \(status)")
        }
        while true {
            try await Task.sleep(for: .seconds(3600))
        }
    }

    private func spawnFailure(_ program: String, _ error: Error) -> String {
        let nsError = error as NSError
        if nsError.domain == NSCocoaErrorDomain && nsError.code == NSFileNoSuchFileError
            || (nsError.domain == NSPOSIXErrorDomain && nsError.code == Int(ENOENT))
        {
            return "spawn \(program) ENOENT"
        }
        if FileManager.default.fileExists(atPath: program) == false {
            return "spawn \(program) ENOENT"
        }
        return "spawn \(program) \(nsError.localizedDescription)"
    }

    public func answers() async -> Bool { await ControlClient.socketAnswers(socketPath) }
    public func pause(milliseconds: Int) async throws { try await Task.sleep(for: .milliseconds(milliseconds)) }
    public func now() -> Double { Date().timeIntervalSince1970 * 1000 }
}

/// The other machine's answer: there is nothing here to start. A `devhub` on
/// a host talks to DevHub over a socket forwarded from the machine the window
/// is on, so "not running" is the end of the matter.
public struct ForwardedSocketLauncher: DevhubLauncher {
    public let socketPath: String
    public let machine: String

    public init(socketPath: String, machine: String) {
        self.socketPath = socketPath
        self.machine = machine
    }

    var nothing: String { "DevHub is not listening on \(socketPath)." }

    public var description: String { "nothing — DevHub does not run on \(machine)" }

    public func cannotStart(_ reason: String) -> String {
        "\(nothing)\nDevHub runs on the machine this window belongs to, and reaches \(machine) over a socket forwarded onto it, so it cannot be started from here. Check that DevHub is running and that the window for \(machine) is still open."
    }

    public func open() async throws -> Never { throw DevhubFailure(nothing) }
    public func answers() async -> Bool { await ControlClient.socketAnswers(socketPath) }
    public func pause(milliseconds: Int) async throws { try await Task.sleep(for: .milliseconds(milliseconds)) }
    public func now() -> Double { Date().timeIntervalSince1970 * 1000 }
}

/// A process's exit status, awaited once, with cancellation.
final class LaunchExitBox: @unchecked Sendable {
    private let lock = NSLock()
    private var status: Int32?
    private var continuation: CheckedContinuation<Int32, Error>?
    private var cancelled = false

    func finish(_ value: Int32) {
        lock.lock()
        status = value
        let waiting = continuation
        continuation = nil
        lock.unlock()
        waiting?.resume(returning: value)
    }

    func wait() async throws -> Int32 {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int32, Error>) in
                lock.lock()
                if let status {
                    lock.unlock()
                    continuation.resume(returning: status)
                } else if cancelled {
                    lock.unlock()
                    continuation.resume(throwing: CancellationError())
                } else {
                    self.continuation = continuation
                    lock.unlock()
                }
            }
        } onCancel: {
            lock.lock()
            cancelled = true
            let waiting = continuation
            continuation = nil
            lock.unlock()
            waiting?.resume(throwing: CancellationError())
        }
    }
}
