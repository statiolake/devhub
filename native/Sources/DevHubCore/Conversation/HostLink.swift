// Port of apps/desktop/src/main/agent/conversation/hostLink.ts
//
// DevHub's side of one GUI Agent's host: its journal, its input, its ending.
//
// Bytes and lines only. What a line *means* is the protocol adapter's
// business, a layer up; this knows the state directory contract
// (`HostScript.swift`) and the machine it is on, and nothing about Claude or
// Codex.
//
// It holds nothing that a DevHub restart could lose. The host keeps running
// in its tmux session whatever happens here, and a new `HostLink` on the same
// directory — in the same DevHub or the next one, this app or the TS one — is
// attached by asking for the journal from an offset. So "re-attach" is not an
// operation; it is `lines(from:)` again.
//
// Every way this can fail is a `HostLinkFailure` with a code, and nothing is
// caught and left there: a stream that stopped, a journal that shrank, a
// host that is not there to write to, all reach the caller, which is the one
// place that decides what a person sees.

import Foundation

/// Why the link to a host could not do what it was asked.
public enum HostLinkFailureCode: String, Sendable {
    /// The host never wrote its `pid`, or ended before it did.
    case hostNotStarted = "host_not_started"
    /// A write found no host running to take it.
    case hostGone = "host_gone"
    /// `ending()` was asked of a host that is still running.
    case hostRunning = "host_running"
    /// The state directory, or a file the contract says is in it, is not there.
    case stateMissing = "state_missing"
    /// The journal is shorter than what was already read from it.
    case journalTruncated = "journal_truncated"
    /// The stream following the journal stopped for another reason.
    case streamLost = "stream_lost"
    /// A write did not complete: refused, or not taken before its deadline.
    case writeFailed = "write_failed"
    /// The host's files say something the contract does not allow.
    case unreadable
}

public struct HostLinkFailure: Error, CustomStringConvertible, Equatable, Sendable {
    public let code: HostLinkFailureCode
    public let message: String
    /// For a failure of `lines`: the offset to attach from again, which is
    /// everything that was delivered whole before it.
    public let offset: Int?

    public init(_ code: HostLinkFailureCode, _ message: String, offset: Int? = nil) {
        self.code = code
        self.message = message
        self.offset = offset
    }

    public var description: String { message }
}

/// The CLI a host is started again as: the whole of its argv.
public struct RestartedCLI: Hashable, Sendable {
    public var file: String
    public var args: [String]

    public init(file: String, args: [String]) {
        self.file = file
        self.args = args
    }
}

/// One line of the journal, without its newline.
public struct JournalLine: Hashable, Sendable {
    public let line: String
    /// The byte offset just past this line's newline: the offset to pass to
    /// `lines(from:)` to continue after it, and the one to keep across a restart.
    public let offset: Int

    public init(line: String, offset: Int) {
        self.line = line
        self.offset = offset
    }
}

/// A line DevHub wrote to the host, and the journal offset it was written after.
public struct SentRecord: Hashable, Sendable {
    public let afterOffset: Int
    public let line: String

    public init(afterOffset: Int, line: String) {
        self.afterOffset = afterOffset
        self.line = line
    }
}

/// How a host that is no longer running ended.
public enum HostEnding: Hashable, Sendable {
    /// The CLI exited, and this is its status (128 + n for a signal).
    case exited(code: Int, stderrTail: String)
    /// The host could not start the CLI; the reason is in `stderrTail`.
    case hostFailed(stderrTail: String)
    /// Nothing was written down: tmux killed the session (DevHub's Stop, or a
    /// person's), or the machine went away under it.
    case vanished(stderrTail: String)

    public var stderrTail: String {
        switch self {
        case .exited(_, let tail), .hostFailed(let tail), .vanished(let tail): return tail
        }
    }
}

/// A line a caller asked to write that could never be one: DevHub's own mistake.
public struct HostLineRefused: Error, CustomStringConvertible, Equatable {
    public let message: String
    public var description: String { message }
}

/// How long a write may take before the host is reported as not taking it.
public let HOST_WRITE_TIMEOUT_SECONDS: Double = 10
/// How long a read of the host's small files may take.
private let HOST_READ_TIMEOUT_SECONDS: Double = 20
/// The most of a journal (or of `in.log`) one read will take. A bound that
/// fails rather than truncates: half a journal is not a shorter conversation
/// but a wrong one.
private let HOST_FILE_BYTES = 256 * 1024 * 1024

private let HOST_LIMITS = MachineLimits(stdoutBytes: HOST_FILE_BYTES, stderrBytes: 8 * 1024, overflow: .fail)

private func lastLine(_ data: Data) -> String {
    String(decoding: data, as: UTF8.self)
        .components(separatedBy: "\n")
        .map { JSString.trim($0) }
        .filter { !$0.isEmpty }
        .last ?? ""
}

private func describe(_ failure: Error) -> String { "\(failure)" }

private func text(_ data: Data) -> String { String(decoding: data, as: UTF8.self) }

public final class HostLink: Sendable {
    private let machine: HostMachine
    public let stateDirectory: String
    private let writeTimeout: Double
    /// The writes, one at a time, in the order they were asked for.
    private let writes = Turnstile()

    public init(machine: HostMachine, stateDirectory: String, writeTimeout: Double = HOST_WRITE_TIMEOUT_SECONDS) {
        self.machine = machine
        self.stateDirectory = stateDirectory
        self.writeTimeout = writeTimeout
    }

    private var place: String { "\(stateDirectory)\(machine.whereSuffix)" }

    /// The journal, line by line, from `fromOffset` (a line boundary: 0, or an
    /// `offset` a previous line carried).
    ///
    /// It follows the journal as it grows, waiting for a host that has not
    /// started yet, and it ends in exactly two ways without a failure:
    /// `cancel` was cancelled, or the host is over and every byte of the
    /// journal has been delivered — including a last line with no newline,
    /// which a CLI killed in the middle of a write leaves behind and which is
    /// handed on as it is, because what it says is the next layer's to judge.
    /// Any other ending throws a `HostLinkFailure` carrying the offset to
    /// attach from again. A consumer that stops reading lets go of the stream.
    public func lines(from fromOffset: Int, cancel: CancellationFlag) -> AsyncThrowingStream<JournalLine, Error> {
        let holder = Guarded<MachineStream?>(nil)
        return AsyncThrowingStream(bufferingPolicy: .unbounded) { continuation in
            guard fromOffset >= 0 else {
                continuation.finish(throwing: HostLineRefused(message: "\(fromOffset) is not a journal offset"))
                return
            }
            let task = Task {
                do {
                    try await self.follow(from: fromOffset, cancel: cancel, holder: holder) { continuation.yield($0) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                holder.with { $0 }?.kill()
                task.cancel()
            }
        }
    }

    private func follow(
        from fromOffset: Int, cancel: CancellationFlag, holder: Guarded<MachineStream?>,
        yield: (JournalLine) -> Void
    ) async throws {
        let stream: MachineStream
        do {
            stream = try machine.spawnStream([
                "/bin/sh", "-c", STREAM_SCRIPT, STREAM_NAME, stateDirectory, String(fromOffset),
            ])
        } catch {
            throw HostLinkFailure(
                .streamLost, "DevHub lost the journal of the Agent host in \(place): \(describe(error))", offset: fromOffset)
        }
        holder.with { $0 = stream }
        let release = cancel.onCancel { stream.kill() }
        defer { release() }
        /// Everything before this was delivered as whole lines.
        var delivered = fromOffset
        var pending = Data()
        do {
            defer {
                // A consumer that stopped early lets go of the stream here; one
                // that read to the end finds it already over, and this does nothing.
                stream.kill()
            }
            for try await chunk in stream.stdout {
                pending.append(chunk)
                while let newline = pending.firstIndex(of: 0x0A) {
                    let line = pending[pending.startIndex..<newline]
                    delivered += line.count + 1
                    yield(JournalLine(line: text(Data(line)), offset: delivered))
                    pending = Data(pending[(newline + 1)...])
                }
            }
        } catch {
            throw HostLinkFailure(
                .streamLost, "DevHub lost the journal of the Agent host in \(place): \(describe(error))", offset: delivered)
        }
        let end: MachineResult
        do {
            end = try await stream.ended()
        } catch {
            if cancel.isCancelled { return }
            throw HostLinkFailure(
                .streamLost, "DevHub lost the journal of the Agent host in \(place): \(describe(error))", offset: delivered)
        }
        if cancel.isCancelled || Task.isCancelled { return }
        if end.code == STREAM_EXIT.hostOver && end.signal == nil {
            // The host is over, so the journal is final: whatever `tail` had
            // not passed on yet is read once, to the end, and the stream is done.
            let rest = try await readFrom(delivered + pending.count)
            var tail = pending
            tail.append(rest)
            var start = tail.startIndex
            while let newline = tail[start...].firstIndex(of: 0x0A) {
                delivered += newline - start + 1
                yield(JournalLine(line: text(Data(tail[start..<newline])), offset: delivered))
                start = newline + 1
            }
            if start < tail.endIndex {
                delivered += tail.endIndex - start
                yield(JournalLine(line: text(Data(tail[start...])), offset: delivered))
            }
            return
        }
        throw streamFailure(end.code, end.signal, end.stderr, delivered)
    }

    /// One line into the CLI's stdin, and into `in.log` after `afterOffset`:
    /// the journal offset the caller had read when it wrote, which is what
    /// lets a replay put the line back where it was written.
    ///
    /// Writes run one at a time, in the order they were asked for: a line
    /// longer than `PIPE_BUF` is not written atomically, and two of them at
    /// once could interleave into two lines that are neither. The line must
    /// not contain a newline — that is the framing, and a caller that has one
    /// in a line has not encoded it.
    public func write(_ line: String, afterOffset: Int) async throws {
        if line.contains("\n") {
            throw HostLineRefused(message: "a line written to an Agent host must not contain a newline")
        }
        if afterOffset < 0 { throw HostLineRefused(message: "\(afterOffset) is not a journal offset") }
        let input = "\(afterOffset) \(line)\n"
        try await writes.run {
            try await self.input(WRITE_SCRIPT, "devhub-agent-write", input, refused: "did not take a line")
        }
    }

    /// Have the host start its CLI again as `cli` — its whole argv, in place
    /// of the one the host was started with (its environment stays) — and the
    /// lines of `mark` in the journal between the two CLIs' output
    /// (`RESTART_SCRIPT`). Returns once the old CLI has been told to stop;
    /// the mark in the journal is how the caller learns the new one started.
    /// In order with the writes, like one of them.
    public func restart(_ cli: RestartedCLI, mark: [String]) async throws {
        if mark.isEmpty { throw HostLineRefused(message: "a restart's mark has no line") }
        let argv = [cli.file] + cli.args
        if (mark + argv).contains(where: { $0.contains("\n") }) {
            throw HostLineRefused(message: "a restart's mark lines and arguments must not contain a newline")
        }
        let input = ([String(argv.count)] + argv + mark).map { "\($0)\n" }.joined()
        try await writes.run {
            try await self.input(RESTART_SCRIPT, "devhub-agent-restart", input, refused: "did not start its CLI again")
        }
    }

    /// Run one of the host's input scripts with `stdin`; its refusals are `HostLinkFailure`s.
    private func input(_ script: String, _ name: String, _ stdin: String, refused: String) async throws {
        let result: MachineResult
        do {
            result = try await machine.exec(
                ["/bin/sh", "-c", script, name, stateDirectory], stdin: Data(stdin.utf8), timeout: writeTimeout,
                limits: HOST_LIMITS)
        } catch {
            throw HostLinkFailure(.writeFailed, "the Agent host in \(place) \(refused): \(describe(error))")
        }
        if result.code == 0 { return }
        let said = "\(lastLine(result.stderr))\(machine.whereSuffix)"
        if result.code == WRITE_EXIT.hostGone { throw HostLinkFailure(.hostGone, said) }
        if result.code == WRITE_EXIT.stateMissing { throw HostLinkFailure(.stateMissing, said) }
        let status = result.code.map { String($0) } ?? result.signal.map { String($0) } ?? "null"
        throw HostLinkFailure(
            .writeFailed, "the Agent host in \(place) \(refused) (exit \(status)): \(lastLine(result.stderr))")
    }

    /// Every line DevHub has written to this host, in order, each with the offset it followed.
    public func sentLog() async throws -> [SentRecord] {
        let result = try await read(SENT_LOG_SCRIPT, [], what: "the input log in", path: stateDirectory)
        if result.code == WRITE_EXIT.stateMissing {
            throw HostLinkFailure(.stateMissing, "\(lastLine(result.stderr))\(machine.whereSuffix)")
        }
        try answered(result, "the input log")
        let log = text(result.stdout)
        if log.isEmpty { return [] }
        guard log.hasSuffix("\n") else {
            throw HostLinkFailure(.unreadable, "the input log of the Agent host in \(place) ends in the middle of a line")
        }
        return try log.dropLast().components(separatedBy: "\n").enumerated().map { index, entry in
            guard let space = entry.firstIndex(of: " "), space > entry.startIndex,
                  entry[..<space].allSatisfy({ $0.isASCII && $0.isNumber }), let offset = Int(entry[..<space])
            else {
                throw HostLinkFailure(
                    .unreadable, "line \(index + 1) of the input log of the Agent host in \(place) carries no journal offset")
            }
            return SentRecord(afterOffset: offset, line: String(entry[entry.index(after: space)...]))
        }
    }

    /// How the host ended, for a host that is no longer running.
    ///
    /// Asked once, after its session is gone. A host that is still running
    /// when this is asked is a caller that got the order wrong, and it throws
    /// rather than guessing an ending that has not happened.
    public func ending() async throws -> HostEnding {
        let result = try await read(ENDING_SCRIPT, [], what: "the ending of", path: stateDirectory)
        try answered(result, "the ending")
        let output = text(result.stdout)
        let verdict: String
        let stderrTail: String
        if let newline = output.firstIndex(of: "\n") {
            verdict = String(output[..<newline])
            stderrTail = String(output[output.index(after: newline)...])
        } else {
            verdict = output
            stderrTail = ""
        }
        switch verdict {
        case "missing":
            throw HostLinkFailure(.stateMissing, "there is no host state at \(place)")
        case "running":
            throw HostLinkFailure(.hostRunning, "the Agent host in \(place) is still running, so it has no ending yet")
        case "vanished":
            return .vanished(stderrTail: stderrTail)
        default:
            let written = verdict.hasPrefix("exit ") ? String(verdict.dropFirst(5)) : nil
            if written == "host" { return .hostFailed(stderrTail: stderrTail) }
            if let written, !written.isEmpty, written.allSatisfy({ $0.isASCII && $0.isNumber }), let code = Int(written) {
                return .exited(code: code, stderrTail: stderrTail)
            }
            throw HostLinkFailure(
                .unreadable, "the Agent host in \(place) wrote an ending DevHub cannot read: \(JsonValue.quoted(verdict))")
        }
    }

    /// The journal from a byte offset to its end, for a host that is over.
    private func readFrom(_ offset: Int) async throws -> Data {
        let result = try await read(
            #"exec tail -c "+$2" -- "$1/out""#, [String(offset + 1)], what: "the journal",
            path: (stateDirectory as NSString).appendingPathComponent("out"))
        try answered(result, "the journal")
        return result.stdout
    }

    private func read(_ script: String, _ extra: [String], what: String, path: String) async throws -> MachineResult {
        do {
            return try await machine.exec(
                ["/bin/sh", "-c", script, "devhub-agent-read", stateDirectory] + extra, stdin: nil,
                timeout: HOST_READ_TIMEOUT_SECONDS, limits: HOST_LIMITS)
        } catch let error as MachineError where error.kind == .overflow {
            throw HostLinkFailure(
                .unreadable, "\(what) \(path) is larger than the \(HOST_FILE_BYTES) bytes DevHub reads at once")
        }
    }

    /// A read that did not answer is a failure in the machine's own words.
    private func answered(_ result: MachineResult, _ what: String) throws {
        if result.code == 0 { return }
        throw HostLinkFailure(
            .unreadable, "DevHub could not read \(what) of the Agent host in \(place): \(lastLine(result.stderr))")
    }

    private func streamFailure(_ code: Int32?, _ signal: Int32?, _ stderr: Data, _ offset: Int) -> HostLinkFailure {
        let said = lastLine(stderr)
        switch code {
        case STREAM_EXIT.truncated?:
            return HostLinkFailure(.journalTruncated, "\(said)\(machine.whereSuffix)", offset: offset)
        case STREAM_EXIT.notStarted?:
            return HostLinkFailure(.hostNotStarted, "\(said)\(machine.whereSuffix)", offset: offset)
        case STREAM_EXIT.stateMissing?:
            return HostLinkFailure(.stateMissing, "\(said)\(machine.whereSuffix)", offset: offset)
        default:
            let how = code.map { "exit \($0)" } ?? "signal \(signal.map { signalName($0) } ?? "null")"
            return HostLinkFailure(
                .streamLost,
                "the journal of the Agent host in \(place) stopped (\(how))\(said.isEmpty ? "" : ": \(said)")",
                offset: offset)
        }
    }
}

/// A signal by the name Node gives it (`SIGTERM`), as the TS app's sentences say it.
func signalName(_ signal: Int32) -> String {
    switch signal {
    case SIGHUP: return "SIGHUP"
    case SIGINT: return "SIGINT"
    case SIGQUIT: return "SIGQUIT"
    case SIGKILL: return "SIGKILL"
    case SIGTERM: return "SIGTERM"
    case SIGPIPE: return "SIGPIPE"
    default: return "\(signal)"
    }
}
