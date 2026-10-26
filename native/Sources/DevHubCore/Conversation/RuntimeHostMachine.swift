// Any `MachineRuntime` (WP3's port of runtime.ts: this Mac, an SSH host) as
// the machine a conversation's host runs on. The coordinator hands a
// conversation the Workspace's runtime through this, so a GUI Agent's host is
// reached the way everything else on its machine is.
//
// On this Mac the host's scripts are run by `LocalMachine`, whatever the
// runtime: a journal stream's `tail` must die with the stream, and only a
// child spawned with a clean signal mask in its own process group does (a
// Foundation `Process` started from a concurrency thread can hand its
// children a blocked SIGTERM, and the stream script's own `kill` of its
// `tail` then does nothing, leaving the stream open for ever).

import Foundation

public struct RuntimeHostMachine: HostMachine {
    public let runtime: any MachineRuntime

    private let local: LocalMachine?

    public init(_ runtime: any MachineRuntime) {
        self.runtime = runtime
        local = runtime.id == .local ? LocalMachine() : nil
    }

    public var whereSuffix: String { runtime.where }

    public func home() async throws -> String { try await runtime.home() }

    public func exec(_ argv: [String], stdin: Data?, timeout: Double, limits: MachineLimits) async throws -> MachineResult {
        if let local { return try await local.exec(argv, stdin: stdin, timeout: timeout, limits: limits) }
        let overflow: ExecOverflow
        switch limits.overflow {
        case .truncate: overflow = .truncate
        case .fail:
            overflow = .fail {
                MachineError(.overflow, "printed more than the \(limits.stdoutBytes) bytes DevHub reads at once")
            }
        }
        let result = try await runtime.exec(
            ExecRequest(
                argv: argv, stdin: stdin, deadline: .within(timeout * 1000), cancel: CancellationToken(),
                limits: MachineExecLimits(stdoutBytes: limits.stdoutBytes, stderrBytes: limits.stderrBytes, overflow: overflow)))
        return MachineResult(code: result.code, signal: result.signal, stdout: result.stdout, stderr: result.stderr)
    }

    public func spawnStream(_ argv: [String]) throws -> MachineStream {
        if let local { return try local.spawnStream(argv) }
        let cancel = CancellationToken()
        return RuntimeStream(try runtime.spawnStream(StreamRequest(argv: argv, cancel: cancel)), cancel: cancel)
    }

    public func stat(_ path: String) async throws -> MachineFileKind {
        switch try await runtime.stat(path) {
        case .absent: return .absent
        case .directory: return .directory
        case .file: return .file
        }
    }

    public func readDirectory(_ path: String) async throws -> [MachineDirEntry] {
        try await runtime.readdir(path).map { MachineDirEntry(name: $0.name, directory: $0.directory) }
    }

    public func removeTree(_ path: String) async throws { try await runtime.removeTree(path) }

    public func writeTextFile(_ path: String, _ text: String, mode: Int) async throws {
        try await runtime.writeTextFile(path, text: text, mode: mode)
    }
}

private final class RuntimeStream: MachineStream, @unchecked Sendable {
    private let stream: any ByteStream
    private let cancel: CancellationToken
    let stdout: AsyncThrowingStream<Data, Error>

    init(_ stream: any ByteStream, cancel: CancellationToken) {
        self.stream = stream
        self.cancel = cancel
        let chunks = stream.stdout
        stdout = AsyncThrowingStream { continuation in
            let task = Task {
                for await chunk in chunks { continuation.yield(chunk) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func ended() async throws -> MachineResult {
        let end = try await stream.ended()
        return MachineResult(code: end.code, signal: end.signal, stdout: Data(), stderr: end.stderr)
    }

    func kill() {
        stream.kill()
        cancel.cancel()
    }
}
