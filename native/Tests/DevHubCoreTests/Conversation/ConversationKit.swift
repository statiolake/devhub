// What the AgentConversation tests share: the fake host of
// apps/desktop/src/main/agent/conversation/conversation.test.ts, its scripted
// CLIs, and limitResumeTestKit.ts (the hand-turned clock, records in memory).

import Foundation
import XCTest
@testable import DevHubCore

/// A journal and an `in.log`, with the host's contract and none of its processes.
final class FakeHost: ConversationHost, @unchecked Sendable {
    private let lock = NSRecursiveLock()

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    private var _journal: [JournalLine] = []
    private var _inLog: [SentRecord] = []
    private var size = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var _onWrite: (String) -> Void = { _ in }
    private var _onRestart: ([String]) -> Void = { _ in }
    private var _restarts: [Restart] = []
    private var _sleeps: [[String]] = []
    private var _refuseRestart = false
    private var _failAfter: Int?
    private var _refuseWrite = false
    private var _slowWrites = false
    private var _sentLogFailure: Error?
    /// The stream being read now: how far it has handed lines out, and
    /// whether the reader still holds the last one (it has not asked for the next).
    private var cursor: (handed: Int, holding: Bool, open: Bool)?
    private var cursorCancel: CancellationFlag?

    struct Restart: Equatable {
        let args: [String]
        let mark: [String]
    }

    var journal: [JournalLine] { locked { _journal } }
    var inLog: [SentRecord] { locked { _inLog } }
    var restarts: [Restart] { locked { _restarts } }
    /// The marks of each time the CLI was put to sleep.
    var sleeps: [[String]] { locked { _sleeps } }
    /// Called with each written line; a scripted CLI answers through `print`.
    var onWrite: (String) -> Void {
        get { locked { _onWrite } }
        set { locked { _onWrite = newValue } }
    }
    /// Called for a restart, after the mark is in the journal as the real host puts it.
    var onRestart: ([String]) -> Void {
        get { locked { _onRestart } }
        set { locked { _onRestart = newValue } }
    }
    /// The next restart fails.
    var refuseRestart: Bool {
        get { locked { _refuseRestart } }
        set { locked { _refuseRestart = newValue } }
    }
    /// The next `lines` stream fails after this many lines, once.
    var failAfter: Int? {
        get { locked { _failAfter } }
        set { locked { _failAfter = newValue } }
    }
    /// The next write fails.
    var refuseWrite: Bool {
        get { locked { _refuseWrite } }
        set { locked { _refuseWrite = newValue } }
    }
    /// Writes return a turn after the CLI has taken them, as a real exec does.
    var slowWrites: Bool {
        get { locked { _slowWrites } }
        set { locked { _slowWrites = newValue } }
    }
    /// `sentLog` fails with this.
    var sentLogFailure: Error? {
        get { locked { _sentLogFailure } }
        set { locked { _sentLogFailure = newValue } }
    }

    /// Lines printed that the reader has not finished taking.
    var undelivered: Int {
        locked {
            guard let cursor, cursor.open, cursorCancel?.isCancelled != true else { return 0 }
            return _journal.count - cursor.handed + (cursor.holding ? 1 : 0)
        }
    }

    func print(_ line: String) {
        let woken = locked { () -> [CheckedContinuation<Void, Never>] in
            size += "\(line)\n".utf8.count
            _journal.append(JournalLine(line: line, offset: size))
            defer { waiters = [] }
            return waiters
        }
        for waiter in woken { waiter.resume() }
    }

    private func wakeAll() {
        let woken = locked { () -> [CheckedContinuation<Void, Never>] in
            defer { waiters = [] }
            return waiters
        }
        for waiter in woken { waiter.resume() }
    }

    func lines(from fromOffset: Int, cancel: CancellationFlag) -> AsyncThrowingStream<JournalLine, Error> {
        let start = locked { () -> Int in
            let index = _journal.firstIndex { $0.offset > fromOffset } ?? _journal.count
            cursor = (index, false, true)
            cursorCancel = cancel
            return index
        }
        let state = Guarded((index: start, delivered: 0))
        return AsyncThrowingStream { [self] in
            locked { cursor?.holding = false }
            while true {
                if cancel.isCancelled {
                    locked { cursor?.open = false }
                    return nil
                }
                let next = try locked { () throws -> JournalLine? in
                    let (index, delivered) = state.with { ($0.index, $0.delivered) }
                    guard index < _journal.count else { return nil }
                    if let failAfter = _failAfter, delivered == failAfter {
                        _failAfter = nil
                        cursor?.open = false
                        throw HostLinkFailure(.streamLost, "the fake stream dropped", offset: fromOffset)
                    }
                    state.with {
                        $0.index += 1
                        $0.delivered += 1
                    }
                    cursor = (index + 1, true, true)
                    return _journal[index]
                }
                if let next { return next }
                let remove = cancel.onCancel { [weak self] in self?.wakeAll() }
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                    let ready = locked { () -> Bool in
                        if cancel.isCancelled || state.with({ $0.index }) < _journal.count { return true }
                        waiters.append(continuation)
                        return false
                    }
                    if ready { continuation.resume() }
                }
                remove()
            }
        }
    }

    func write(_ line: String, afterOffset: Int) async throws {
        await Task.yield()
        let (refused, slow) = locked { () -> (Bool, Bool) in
            if _refuseWrite {
                _refuseWrite = false
                return (true, false)
            }
            _inLog.append(SentRecord(afterOffset: afterOffset, line: line))
            return (false, _slowWrites)
        }
        if refused { throw HostLinkFailure(.hostGone, "the fake host has ended") }
        onWrite(line)
        if slow { try? await Task.sleep(nanoseconds: 2_000_000) }
    }

    func restart(session: [String], mark: [String]) async throws {
        await Task.yield()
        let refused = locked { () -> Bool in
            if _refuseRestart {
                _refuseRestart = false
                return true
            }
            _restarts.append(Restart(args: session, mark: mark))
            return false
        }
        if refused { throw HostLinkFailure(.writeFailed, "the fake host did not start its CLI again") }
        for line in mark { print(line) }
        onRestart(session)
    }

    func sleep(mark: [String]) async throws {
        await Task.yield()
        locked { _sleeps.append(mark) }
        for line in mark { print(line) }
    }

    func sentLog() async throws -> [SentRecord] {
        if let failure = sentLogFailure { throw failure }
        return inLog
    }
}

/// The permission fixture's lines, each with its side.
let PERMISSION_TURN: [(side: String, line: String)] = Fixtures.text("conversation", "claude-permission-turn.ndjson")
    .split(separator: "\n", omittingEmptySubsequences: false)
    .map(String.init)
    .filter { $0.hasPrefix("> ") || $0.hasPrefix("< ") }
    .map { ($0.hasPrefix(">") ? "sent" : "received", String($0.dropFirst(2))) }

/// Prints the fixture's CLI lines up to the next line DevHub is to write, and checks that line when it comes.
final class ScriptedCli: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private var next = 0

    init(_ host: FakeHost) {
        host.onWrite = { [self] line in
            lock.lock()
            defer { lock.unlock() }
            guard next < PERMISSION_TURN.count, PERMISSION_TURN[next].side == "sent" else {
                XCTFail("the CLI did not expect a line, got \(line)")
                return
            }
            XCTAssertEqual(try? JsonValue.parse(line), try? JsonValue.parse(PERMISSION_TURN[next].line))
            next += 1
            printUntilDevHub(host)
        }
    }

    private func printUntilDevHub(_ host: FakeHost) {
        while next < PERMISSION_TURN.count && PERMISSION_TURN[next].side == "received" {
            host.print(PERMISSION_TURN[next].line)
            next += 1
        }
    }

    var remaining: Int {
        lock.lock()
        defer { lock.unlock() }
        return PERMISSION_TURN.count - next
    }
}

/// A Claude new enough to resume at a message, answering each message with
/// one line of its own; `hold` keeps it from ending the turn.
final class AnsweringCli: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private var _hold = false
    private var _usage: JsonValue?
    private var said = 0
    private var started = false

    var hold: Bool {
        get { lock.withLock { _hold } }
        set { lock.withLock { _hold = newValue } }
    }
    var usage: JsonValue? {
        get { lock.withLock { _usage } }
        set { lock.withLock { _usage = newValue } }
    }

    init(_ host: FakeHost, version: String = "2.1.282") {
        let print = { (value: JsonValue) in host.print(value.jsonText) }
        host.onWrite = { [self] line in
            guard case .object(let message)? = try? JsonValue.parse(line) else { return }
            if message["type"] == "control_request" {
                let subtype = message["request"]?.objectValue?["subtype"]
                print([
                    "type": "control_response",
                    "response": [
                        "subtype": "success",
                        "request_id": message["request_id"] ?? nil,
                        "response": subtype == "mcp_status" ? ["mcpServers": []] : ["commands": [], "models": []],
                    ],
                ])
                return
            }
            if message["type"] != "user" { return }
            let (number, first, hold, usage) = lock.withLock { () -> (Int, Bool, Bool, JsonValue?) in
                said += 1
                defer { started = true }
                return (said, !started, _hold, _usage)
            }
            if first {
                print([
                    "type": "system", "subtype": "init", "session_id": "s-1", "cwd": "/home/testuser/project",
                    "model": "claude-sonnet-5", "permissionMode": "default", "slash_commands": [],
                    "claude_code_version": .string(version),
                ])
            }
            print([
                "type": "user",
                "message": ["role": "user", "content": message["message"]?.objectValue?["content"] ?? nil],
                "parent_tool_use_id": nil, "session_id": "s-1", "uuid": .string("u\(number)"),
            ])
            var assistant: JsonObject = [
                "id": .string("msg_\(number)"), "role": "assistant",
                "content": [["type": "text", "text": .string("answer \(number)")]],
            ]
            if let usage { assistant["usage"] = usage }
            print([
                "type": "assistant", "message": .object(assistant), "parent_tool_use_id": nil, "session_id": "s-1",
                "uuid": .string("a\(number)"),
            ])
            if hold { return }
            print(RESULT_LINE)
        }
        host.onRestart = { [self] _ in lock.withLock { started = false } }
    }
}

let RESULT_LINE: JsonValue = [
    "type": "result", "subtype": "success", "is_error": false, "duration_ms": 100, "result": "done",
    "session_id": "s-1",
]

func endTurn(_ host: FakeHost) { host.print(RESULT_LINE.jsonText) }

/// Until nothing is under way in the conversation, and the host has nothing
/// the conversation has not taken: the TS tests' 50 turns of the event loop.
func settle(_ conversation: AgentConversation, _ host: FakeHost? = nil) async {
    var stable = 0
    var last: [Int] = []
    for _ in 0..<4000 {
        try? await Task.sleep(nanoseconds: 1_000_000)
        let busy = conversation.activity.with { $0 }
        let now = [await conversation.snapshot().revision, host?.inLog.count ?? 0, host?.journal.count ?? 0]
        if busy == 0 && (host?.undelivered ?? 0) == 0 && now == last {
            stable += 1
            if stable >= 3 { return }
        } else {
            stable = 0
        }
        last = now
    }
    XCTFail("the conversation did not settle")
}

/// What a refusal is drawn as: its own kind and the sentence it was written in.
func drawnAs(_ work: () async throws -> Void) async -> ConversationError? {
    do {
        try await work()
    } catch let error as ConversationError {
        return error
    } catch {
        XCTFail("it failed with \(error), which is not a ConversationError")
        return nil
    }
    XCTFail("it did not fail")
    return nil
}

func drawnAs<T>(_ task: Task<T, Error>) async -> ConversationError? {
    await drawnAs { _ = try await task.value }
}

// MARK: - limitResumeTestKit.ts

let RESUME_ON = LimitResumeSettings(enabled: true, message: "続けて")
let RESUME_OFF = LimitResumeSettings(enabled: false, message: "続けて")

/// Records kept in memory, per Agent, as the file would keep them.
final class MemoryRecords: AgentRecordStore, @unchecked Sendable {
    private let lock = NSLock()
    private var records: [String: LimitResumeRecord] = [:]

    func get(_ agentId: String) -> LimitResumeRecord? { lock.withLock { records[agentId] } }

    func set(_ agentId: String, _ record: LimitResumeRecord?) { lock.withLock { records[agentId] = record } }

    /// This Agent's record, as a conversation is handed it.
    func slot(_ agentId: String = "agent") -> LimitResumeRecordSlot {
        LimitResumeRecordSlot(get: { self.get(agentId) }, set: { self.set(agentId, $0) })
    }
}

/// A clock that moves only when the test says.
final class TurnedClock: ConversationClock, @unchecked Sendable {
    private final class Timer: @unchecked Sendable {
        let at: Double
        let then: @Sendable () -> Void
        var off = false
        init(at: Double, then: @escaping @Sendable () -> Void) {
            self.at = at
            self.then = then
        }
    }

    private let lock = NSLock()
    private var current: Double
    private var timers: [Timer] = []

    init(_ now: Double) { current = now }

    func now() -> Double { lock.withLock { current } }

    func after(_ ms: Double, _ then: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        let timer = lock.withLock { () -> Timer in
            let timer = Timer(at: current + ms, then: then)
            timers.append(timer)
            return timer
        }
        return { [self] in lock.withLock { timer.off = true } }
    }

    /// The timers set and not called off.
    var pending: Int { lock.withLock { timers.filter { !$0.off }.count } }

    /// Move on by `ms`, calling every timer that comes due, in order.
    func advance(_ ms: Double) {
        lock.withLock { current += ms }
        while true {
            let due = lock.withLock { () -> Timer? in
                let due = timers.filter { !$0.off && $0.at <= current }.min { $0.at < $1.at }
                due?.off = true
                return due
            }
            guard let due else { return }
            due.then()
        }
    }
}

/// A conversation that never goes on by itself: the setting is off.
func resumeOff() -> LimitResumeOptions {
    LimitResumeOptions(settings: { RESUME_OFF }, record: MemoryRecords().slot(), clock: TurnedClock(0))
}
