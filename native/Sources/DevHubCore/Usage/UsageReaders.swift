// Port of apps/desktop/src/main/shell/usageReaders.ts.
//
// DevHub's own readers of Claude's and Codex's plan limits, so the Sidebar's
// readout is there without a GUI Agent having run a turn.
//
// One reader per CLI kind, reading with the first profile of that kind in
// Settings' order — its command and its environment, the account a launch from
// it would use. The profile's own arguments are not passed: they are for a
// conversation (a model, a permission mode, a session to resume), and the
// reader must never load or start one. With several profiles of a kind, the
// first is the one read; the others are assumed to share its account.
//
// **No process stays between readings.** Each reading starts the CLI, does the
// handshake and one read, and kills it — also when it fails or times out.
//
// - **Claude**: `claude -p` in stream-json (`claudeFlags`), sent the control
//   requests `initialize` and then `get_usage` (with `skip_behaviors`) — the
//   SDK's `SDKControlGetUsageRequest`, which the SDK marks experimental. No
//   model is called and no message is ever written.
// - **Codex**: `codex app-server`, sent `initialize`, `initialized`,
//   `account/read` and — for a ChatGPT sign-in — the public
//   `account/rateLimits/read`, the request Codex's own TUI polls. No thread is
//   opened.
//
// A sign-in with no plan limits (an API key, Bedrock) is an answer, said in
// the Sidebar as a state. A CLI whose command is not on this Mac is not
// started, and the readout says so too.
//
// # How often
//
// By the most used window of the reader's latest reading: 60 s, 15 s from 90%,
// 5 s from 99% (Codex's TUI rule also has 30 s from 75%; Claude's endpoint is
// experimental, so it stays at 60 s until a window reaches 90%). The first
// reading is at start.
//
// # Failures
//
// A process that will not start or stops, a request the CLI refuses, a
// response in a shape DevHub does not read, a reading not done within 30 s
// (`readTimeoutMs`): that reading's process is killed and the next one is at
// the next tick, at the same cadence — no backoff, no giving up. Readings are
// one at a time per CLI, so a slow one never overlaps or holds up the next.
//
// The failure is said once as `usage_unreadable` at the root — on the first
// failure of a streak, not on each retry; a successful reading ends the
// streak. Readings already taken stay in the readout meanwhile.
//
// Not a failure: Claude answering that the plan has limits but it could not
// fetch them just now (`rate_limits: null`, e.g. its usage endpoint answered
// 429). Nothing is delivered and the usual cadence goes on.
//
// Not retried: a command that is not on this Mac (the readout says so; a
// settings change is picked up at the next start of DevHub).

import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

// MARK: - The process

/// Fired once, with the sentence why, when a program is gone or could not
/// start. A signal rather than a promise, so that an end nobody is waiting on
/// at that moment is still read.
public final class EndSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var why: String?
    private var handlers: [@Sendable (String) -> Void] = []

    public init() {}

    public var reason: String? { lock.lock(); defer { lock.unlock() }; return why }
    public var isEnded: Bool { reason != nil }

    public func end(_ reason: String) {
        lock.lock()
        guard why == nil else { lock.unlock(); return }
        why = reason
        let pending = handlers
        handlers = []
        lock.unlock()
        for handler in pending { handler(reason) }
    }

    /// Runs `handler` once the program has ended — at once, if it has.
    public func onEnd(_ handler: @escaping @Sendable (String) -> Void) {
        lock.lock()
        if let why {
            lock.unlock()
            handler(why)
            return
        }
        handlers.append(handler)
        lock.unlock()
    }
}

/// A program spoken to in lines of JSON, one each way.
public protocol LineProcess: AnyObject, Sendable {
    /// One line of JSON, without its newline.
    func send(_ line: String)
    /// Every line the program writes on stdout, in order.
    func onLine(_ listener: @escaping @Sendable (String) -> Void)
    var ended: EndSignal { get }
    /// Stop it. Idempotent.
    func kill()
}

/// What a reader runs: the profile's program, never its arguments.
public struct UsageCommand: Equatable, Sendable {
    public var file: String
    public var args: [String]
    public var env: [String: String]

    public init(file: String, args: [String], env: [String: String]) {
        self.file = file
        self.args = args
        self.env = env
    }
}

/// `spawnLineProcess`: the program, on pipes, on this machine.
///
/// Started with `SpawnedChild` (not Foundation's `Process`, whose termination
/// handler races the reads of what the program said last, and which leaks its
/// watch descriptor into descendants). The end is reported once the program
/// has been reaped *and* both of its pipes have reached end-of-file, so its
/// last lines and the tail of its complaint are never missed.
public final class ChildLineProcess: LineProcess, @unchecked Sendable {
    /// How much of stderr a failure quotes: the end is where a reason is.
    static let stderrTail = 2048
    /// How long a descendant that still holds a pipe open after the program
    /// itself has gone is waited for before the end is reported anyway.
    static let drainGrace: Double = 1

    public let ended = EndSignal()
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "devhub.child-line-process")
    private var child: SpawnedChild?
    private var readers: [DescriptorReader] = []
    private var listeners: [@Sendable (String) -> Void] = []
    private var buffered = Data()
    private var stderr = Data()
    private var killed = false
    private var stdinOpen = false
    private var outClosed = false
    private var errClosed = false
    private var exitHow: String?
    private let file: String

    public init(command: UsageCommand, cwd: String) {
        file = command.file
        let child: SpawnedChild
        do {
            child = try SpawnedChild.spawn(executable: command.file, args: command.args, env: command.env, cwd: cwd, pipeStdin: true)
        } catch {
            end("\(command.file) could not be started: \(LocalFiles.code(of: error))")
            return
        }
        let readers = [
            DescriptorReader(child.stdout, queue: queue, onChunk: { [weak self] in self?.received($0) }, onEnd: { [weak self] in self?.closed(stderr: false) }),
            DescriptorReader(child.stderr, queue: queue, onChunk: { [weak self] in self?.complained($0) }, onEnd: { [weak self] in self?.closed(stderr: true) }),
        ]
        lock.withLock {
            self.child = child
            self.readers = readers
            stdinOpen = true
        }
        for reader in readers { reader.start() }
        child.whenExited { [weak self] code, signal in
            guard let self else { return }
            let how = signal.map { BoundedExec.signalName($0) } ?? "exit code \(code ?? 0)"
            self.lock.withLock { self.exitHow = how }
            self.endIfDrained()
            // A descendant holding a pipe must not hold the end back for ever.
            self.queue.asyncAfter(deadline: .now() + Self.drainGrace) { [weak self] in self?.endNow() }
        }
    }

    private func received(_ chunk: Data) {
        lock.lock()
        buffered.append(chunk)
        var lines: [String] = []
        while let newline = buffered.firstIndex(of: UInt8(ascii: "\n")) {
            var line = buffered[buffered.startIndex..<newline]
            if line.last == UInt8(ascii: "\r") { line = line.dropLast() }
            lines.append(String(decoding: line, as: UTF8.self))
            buffered.removeSubrange(buffered.startIndex...newline)
        }
        let listeners = self.listeners
        lock.unlock()
        for line in lines { for listener in listeners { listener(line) } }
    }

    private func complained(_ chunk: Data) {
        lock.lock()
        stderr.append(chunk)
        if stderr.count > Self.stderrTail { stderr = stderr.suffix(Self.stderrTail) }
        lock.unlock()
    }

    private func closed(stderr isError: Bool) {
        lock.withLock { if isError { errClosed = true } else { outClosed = true } }
        endIfDrained()
    }

    private func endIfDrained() {
        let done = lock.withLock { exitHow != nil && outClosed && errClosed }
        if done { endNow() }
    }

    private func endNow() {
        guard let how = lock.withLock({ exitHow }) else { return }
        end("\(file) stopped (\(how))")
    }

    private func end(_ why: String) {
        lock.lock()
        let said = String(decoding: stderr, as: UTF8.self).jsTrimmed
        lock.unlock()
        ended.end(said.isEmpty ? why : "\(why): \(said)")
    }

    public func send(_ line: String) {
        guard !ended.isEnded else { return }
        let descriptor: Int32? = lock.withLock { stdinOpen ? child?.stdin : nil }
        guard let descriptor else { return }
        let bytes = Array((line + "\n").utf8)
        var offset = 0
        while offset < bytes.count {
            let written = bytes[offset...].withUnsafeBytes { write(descriptor, $0.baseAddress, $0.count) }
            if written < 0 {
                if errno == EINTR { continue }
                end("\(file) stopped reading: \(String(cString: strerror(errno)))")
                return
            }
            offset += written
        }
    }

    public func onLine(_ listener: @escaping @Sendable (String) -> Void) {
        lock.lock(); listeners.append(listener); lock.unlock()
    }

    /// The whole group: the program may have started children of its own.
    public func kill() {
        let (child, closeStdin): (SpawnedChild?, Bool) = lock.withLock {
            guard !killed else { return (nil, false) }
            killed = true
            let wasOpen = stdinOpen
            stdinOpen = false
            return (self.child, wasOpen)
        }
        guard let child else { return }
        if closeStdin { close(child.stdin) }
        child.signalGroup(SIGTERM)
        // A child spawned from a concurrency thread may have SIGTERM blocked;
        // SIGKILL cannot be.
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
            if child.isRunning { child.signalGroup(SIGKILL) }
        }
    }

    deinit {
        if stdinOpen, let child { close(child.stdin) }
    }
}

// MARK: - The two protocols

/// One CLI's account, asked over its process.
public protocol UsageSource: AnyObject, Sendable {
    /// The handshake.
    func open() async throws
    /// `nil`: the CLI had no reading this time (not a failure).
    func read() async throws -> UsageReading?
    /// Stop its process. Idempotent.
    func close()
}

/// A reader's failure in its own words.
public struct UsageReadFailure: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// Requests a process answers by id, and the one rule for their failure: when
/// the process ends, or says something that cannot be read, every request
/// waiting fails with that reason, and so does every request after it.
final class PendingAnswers<Answer: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: [String: CheckedContinuation<Answer, Error>] = [:]
    private var broken: Error?

    init(_ child: LineProcess) {
        child.ended.onEnd { [weak self] reason in self?.fail(UsageReadFailure(reason)) }
    }

    /// Wait for `id`, sending `request` once the wait is in place.
    func wait(_ id: String, then request: () -> Void) async throws -> Answer {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let broken {
                lock.unlock()
                continuation.resume(throwing: broken)
                return
            }
            waiting[id] = continuation
            lock.unlock()
            request()
        }
    }

    /// Answer `id`; a request never asked is a failure.
    func answer(_ id: String, _ answer: Answer) {
        lock.lock()
        guard let continuation = waiting.removeValue(forKey: id) else {
            lock.unlock()
            fail(UsageReadFailure("the CLI answered \(id), which DevHub did not ask"))
            return
        }
        lock.unlock()
        continuation.resume(returning: answer)
    }

    func fail(_ failure: Error) {
        lock.lock()
        if broken == nil { broken = failure }
        let reason = broken!
        let all = waiting
        waiting = [:]
        lock.unlock()
        for continuation in all.values { continuation.resume(throwing: reason) }
    }
}

/// `claude -p` in stream-json, asked with control requests only. A line that
/// is not a control response is not an answer to anything the reader asked,
/// and is not read.
public final class ClaudeUsageSource: UsageSource, @unchecked Sendable {
    private let child: LineProcess
    private let pending: PendingAnswers<ControlOutcome>
    private let lock = NSLock()
    private var next = 0

    public init(child: LineProcess) {
        self.child = child
        pending = PendingAnswers(child)
        child.onLine { [weak self] line in self?.line(line) }
    }

    public func close() { child.kill() }

    public func open() async throws {
        _ = try await request("initialize")
    }

    public func read() async throws -> UsageReading? {
        try decodeUsage(try await request("get_usage"), version: nil)
    }

    private func nextId() -> String {
        lock.lock(); defer { lock.unlock() }
        next += 1
        return "devhub-usage-\(next)"
    }

    private func request(_ subtype: String) async throws -> JsonObject? {
        let id = nextId()
        // `skip_behaviors`: get_usage otherwise also scans the session history
        // for its "behaviors" recommendations, which a readout never shows.
        let body: JsonObject = subtype == "get_usage" ? ["subtype": .string(subtype), "skip_behaviors": true] : ["subtype": .string(subtype)]
        let message: JsonValue = ["type": "control_request", "request_id": .string(id), "request": .object(body)]
        let child = self.child
        let outcome = try await pending.wait(id) { child.send(message.jsonText) }
        switch outcome {
        case .ok(let payload): return payload
        case .error(let error): throw UsageReadFailure("claude refused \(subtype): \(error)")
        }
    }

    private func line(_ line: String) {
        do {
            let type: String?
            do {
                type = try JsonValue.parse(line)["type"]?.stringValue
            } catch {
                throw UsageReadFailure("claude wrote a line that is not JSON: \(String(line.prefix(200)))")
            }
            guard type == "control_response" else { return }
            guard case .controlResponse(let requestId, let outcome) = try decodeReceived(line, version: nil) else {
                throw UsageReadFailure("a control response decoded as something else")
            }
            pending.answer(requestId, outcome)
        } catch {
            // Read where it arrived, said where it is waited on.
            pending.fail(error)
        }
    }
}

/// `codex app-server`, asked for its account and its rate limits.
/// Notifications are not read; a request *from* the server is refused as a
/// failure: a reader opens no thread, so there is nothing for Codex to ask.
public final class CodexUsageSource: UsageSource, @unchecked Sendable {
    enum Answer: Sendable {
        case result(JsonValue?)
        case error(String)
    }

    private let child: LineProcess
    private let clientVersion: String
    private let pending: PendingAnswers<Answer>
    private let lock = NSLock()
    private var next = 0

    public init(child: LineProcess, clientVersion: String) {
        self.child = child
        self.clientVersion = clientVersion
        pending = PendingAnswers(child)
        child.onLine { [weak self] line in self?.line(line) }
    }

    public func close() { child.kill() }

    public func open() async throws {
        _ = try await call("initialize", [
            "clientInfo": ["name": "devhub", "title": "DevHub", "version": .string(clientVersion)],
            "capabilities": ["experimentalApi": false, "requestAttestation": false],
        ])
        child.send(JsonValue.object(["method": "initialized"]).jsonText)
    }

    public func read() async throws -> UsageReading? {
        let account = try CodexUsageDecoding.accountResponse(try await call("account/read", [:]))
        guard let kind = account.account else {
            throw UsageReadFailure("codex is not signed in, so it has no limits to read. Run `codex login` in a terminal.")
        }
        // Only a ChatGPT sign-in has plan limits: an API key or Bedrock is
        // refused by the read ("chatgpt authentication required").
        if kind != "chatgpt" { return .noPlanLimits }
        // The one field is the protocol's, and leaves out the list of reset
        // credits, which DevHub does not show.
        let result = try await call("account/rateLimits/read", ["excludeResetCreditDetails": true])
        return .windows(try CodexUsageDecoding.rateLimits(result, at: "result"))
    }

    private func nextId() -> Int {
        lock.lock(); defer { lock.unlock() }
        let id = next
        next += 1
        return id
    }

    private func call(_ method: String, _ params: JsonObject) async throws -> JsonValue? {
        let id = nextId()
        let message: JsonValue = ["id": .number(Double(id)), "method": .string(method), "params": .object(params)]
        let child = self.child
        switch try await pending.wait(String(id), then: { child.send(message.jsonText) }) {
        case .result(let result): return result
        case .error(let error): throw UsageReadFailure("codex refused \(method): \(error)")
        }
    }

    private func line(_ line: String) {
        do {
            switch try CodexUsageDecoding.decodeLine(line) {
            case .notification:
                return
            case .request(_, let method, _):
                throw UsageReadFailure("codex asked \(method), which a usage reader does not answer")
            case .restart:
                throw UsageReadFailure("codex app-server said it restarted, which only DevHub's host says")
            case .response(let id, let result):
                pending.answer(id.description, .result(result))
            case .error(let id, let code, let message, _):
                pending.answer(id?.description ?? "null", .error("\(message) (\(JsonValue.javaScriptNumber(code)))"))
            }
        } catch {
            pending.fail(error)
        }
    }
}

// MARK: - How often, and every reader

/// Stops a reader's loop, and wakes it from a wait.
public final class StopSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    private var handlers: [@Sendable () -> Void] = []

    public init() {}

    public var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }

    public func stop() {
        lock.lock()
        guard !stopped else { lock.unlock(); return }
        stopped = true
        let pending = handlers
        handlers = []
        lock.unlock()
        for handler in pending { handler() }
    }

    public func onStop(_ handler: @escaping @Sendable () -> Void) {
        lock.lock()
        if stopped { lock.unlock(); handler(); return }
        handlers.append(handler)
        lock.unlock()
    }
}

public struct UsageReaderDeps: Sendable {
    /// Settings' profiles, in its order.
    public var profiles: [ConfiguredAgentProfile]
    /// The profile's command on this Mac's launch PATH, or `nil` when it is
    /// not on this Mac.
    public var resolveProgram: @Sendable (String) async -> String?
    /// This Mac's launch environment.
    public var environment: @Sendable () async -> [String: String]
    public var home: @Sendable () async -> String
    /// DevHub's own version, which Codex is told.
    public var clientVersion: String
    public var spawn: @Sendable (UsageCommand, String) -> LineProcess
    public var deliver: @Sendable (LimitedCli, UsageReading) -> Void
    public var note: @Sendable (LimitedCli, UsageNote) -> Void
    /// The root surface: a reader's failure, once per streak.
    public var report: @Sendable (CodedFailure) -> Void
    /// Resolves after `ms`, or as soon as the readers are stopped.
    public var wait: @Sendable (Int, StopSignal) async -> Void
    /// How long one whole read (handshake and request) may take.
    public var readTimeoutMs: Int

    public init(
        profiles: [ConfiguredAgentProfile],
        resolveProgram: @escaping @Sendable (String) async -> String?,
        environment: @escaping @Sendable () async -> [String: String],
        home: @escaping @Sendable () async -> String,
        clientVersion: String,
        spawn: @escaping @Sendable (UsageCommand, String) -> LineProcess = { ChildLineProcess(command: $0, cwd: $1) },
        deliver: @escaping @Sendable (LimitedCli, UsageReading) -> Void,
        note: @escaping @Sendable (LimitedCli, UsageNote) -> Void,
        report: @escaping @Sendable (CodedFailure) -> Void,
        wait: @escaping @Sendable (Int, StopSignal) async -> Void = UsageReaders.waitFor,
        readTimeoutMs: Int = UsageReaders.readTimeoutMs
    ) {
        self.profiles = profiles
        self.resolveProgram = resolveProgram
        self.environment = environment
        self.home = home
        self.clientVersion = clientVersion
        self.spawn = spawn
        self.deliver = deliver
        self.note = note
        self.report = report
        self.wait = wait
        self.readTimeoutMs = readTimeoutMs
    }
}

/// The readers DevHub runs: one loop per CLI with plan limits that has a
/// profile.
public final class UsageReaders: @unchecked Sendable {
    /// How long one whole read (handshake and request) may take before it is
    /// killed.
    public static let readTimeoutMs = 30_000
    static let usualIntervalMs = 60_000

    /// The command line of the background usage reader's `claude`: structured
    /// input and output, and nothing that could make it a conversation. It is
    /// sent control requests only, never a message, so it never starts a turn;
    /// `--no-session-persistence` keeps it from writing a session, and
    /// `disableAllHooks` keeps the owner's hooks — `SessionStart` among them —
    /// from running for a process that is not a session anybody opened.
    public static let claudeFlags = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--settings",
        #"{"disableAllHooks":true}"#,
    ]

    /// From the most used window up: at or over `from` percent, every `ms`.
    static let intervals: [LimitedCli: [(from: Double, ms: Int)]] = [
        .codex: [(99, 5_000), (90, 15_000), (75, 30_000)],
        // Experimental: at most once a minute until a window is at 90%.
        .claude: [(99, 5_000), (90, 15_000)],
    ]

    /// How long after `reading` the next read is.
    public static func pollInterval(_ cli: LimitedCli, _ reading: UsageReading) -> Int {
        var most = -1.0
        if case .windows(let windows) = reading {
            for window in windows { most = max(most, window.usedPercent ?? -1) }
        }
        return intervals[cli]?.first { most >= $0.from }?.ms ?? usualIntervalMs
    }

    /// Resolves after `ms`, or as soon as `stop` is stopped.
    public static let waitFor: @Sendable (Int, StopSignal) async -> Void = { ms, stop in
        let sleeper = Task { try? await Task.sleep(nanoseconds: UInt64(max(0, ms)) * 1_000_000) }
        stop.onStop { sleeper.cancel() }
        await sleeper.value
    }

    /// The failure's detail: which CLI, read with which profile, and why.
    static func unreadable(_ cli: LimitedCli, profile: String, _ failure: Error) -> CodedFailure {
        .usageUnreadable("\(cli.displayName), read with the profile “\(profile)”: \(CodedFailure.text(of: failure))")
    }

    /// The words of a read that ran out of time.
    static func timeoutSentence(_ ms: Int) -> String {
        "the usage read was not answered within \(JsonValue.javaScriptNumber(Double(ms) / 1000)) s"
    }

    private let deps: UsageReaderDeps
    private let stopped = StopSignal()
    private let lock = NSLock()
    /// The processes alive now, at most one per CLI.
    private var live: [ObjectIdentifier: UsageSource] = [:]
    private var loops: [Task<Void, Never>] = []

    private init(_ deps: UsageReaderDeps) { self.deps = deps }

    /// Start a reader loop for each CLI with plan limits that has a profile;
    /// stop them all with the answer. Everything a reader does happens after
    /// this returns.
    public static func start(_ deps: UsageReaderDeps) -> UsageReaders {
        let readers = UsageReaders(deps)
        for cli in LimitedCli.allCases {
            guard let profile = deps.profiles.first(where: { $0.kind.rawValue == cli.rawValue }) else { continue }
            let task = Task { await readers.loop(cli, profile) }
            readers.lock.lock(); readers.loops.append(task); readers.lock.unlock()
        }
        return readers
    }

    public func stop() {
        stopped.stop()
        lock.lock()
        let sources = Array(live.values)
        lock.unlock()
        for source in sources { source.close() }
    }

    private func track(_ source: UsageSource) {
        lock.lock(); live[ObjectIdentifier(source)] = source; lock.unlock()
        // A stop that came while the process was being started still kills it.
        if stopped.isStopped { source.close() }
    }

    private func untrack(_ source: UsageSource) {
        lock.lock(); live[ObjectIdentifier(source)] = nil; lock.unlock()
    }

    private final class ResolvedProgram: @unchecked Sendable {
        var asked = false
        var value: String?
    }

    private func loop(_ cli: LimitedCli, _ profile: ConfiguredAgentProfile) async {
        let program = ResolvedProgram()
        var last: UsageReading?
        // Whether this streak of failures was said.
        var said = false
        while !stopped.isStopped {
            do {
                let reading = try await readOnce(cli, profile, program)
                if stopped.isStopped || program.value == nil { return }
                // No reading this time (limits not fetched): nothing delivered.
                if let reading {
                    last = reading
                    said = false
                    deps.deliver(cli, reading)
                }
            } catch {
                if stopped.isStopped { return }
                if !said {
                    said = true
                    deps.report(Self.unreadable(cli, profile: profile.displayName, error))
                }
            }
            // A failure is asked again at the same cadence, not later.
            await deps.wait(last.map { Self.pollInterval(cli, $0) } ?? Self.usualIntervalMs, stopped)
        }
    }

    /// One process for one reading, killed whatever comes of it.
    private func readOnce(_ cli: LimitedCli, _ profile: ConfiguredAgentProfile, _ program: ResolvedProgram) async throws -> UsageReading? {
        if !program.asked {
            program.asked = true
            program.value = await deps.resolveProgram(profile.command)
            // A command not on this Mac is a note, and nothing is read until
            // DevHub starts again.
            if program.value == nil { deps.note(cli, .cliNotFound) }
        }
        guard let file = program.value else { return nil }
        var env = await deps.environment()
        for (key, value) in profile.env { env[key] = value }
        let home = await deps.home()
        if stopped.isStopped { return nil }
        let command = UsageCommand(file: file, args: cli == .claude ? Self.claudeFlags : ["app-server"], env: env)
        let child = deps.spawn(command, home)
        let source: UsageSource = cli == .claude
            ? ClaudeUsageSource(child: child)
            : CodexUsageSource(child: child, clientVersion: deps.clientVersion)
        track(source)
        defer {
            untrack(source)
            source.close()
        }
        return try await Self.within(deps.readTimeoutMs) {
            try await source.open()
            return try await source.read()
        }
    }

    /// `body`, failing if it is not settled within `ms`. The caller kills the
    /// process either way, which is what ends a read left behind.
    static func within(_ ms: Int, _ body: @escaping @Sendable () async throws -> UsageReading?) async throws -> UsageReading? {
        let race = Race()
        return try await withCheckedThrowingContinuation { continuation in
            race.continuation = continuation
            Task {
                do { race.settle(.success(try await body())) } catch { race.settle(.failure(error)) }
            }
            race.timer = Task {
                try? await Task.sleep(nanoseconds: UInt64(max(0, ms)) * 1_000_000)
                if !Task.isCancelled { race.settle(.failure(UsageReadFailure(timeoutSentence(ms)))) }
            }
        }
    }

    private final class Race: @unchecked Sendable {
        private let lock = NSLock()
        var continuation: CheckedContinuation<UsageReading?, Error>?
        private var clock: Task<Void, Never>?
        private var settled = false

        var timer: Task<Void, Never>? {
            get { lock.lock(); defer { lock.unlock() }; return clock }
            set {
                lock.lock()
                let already = settled
                clock = newValue
                lock.unlock()
                if already { newValue?.cancel() }
            }
        }

        func settle(_ result: Result<UsageReading?, Error>) {
            lock.lock()
            let waiting = continuation
            continuation = nil
            settled = true
            let clock = self.clock
            lock.unlock()
            clock?.cancel()
            waiting?.resume(with: result)
        }
    }
}
