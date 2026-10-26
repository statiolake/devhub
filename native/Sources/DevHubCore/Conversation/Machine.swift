// What a GUI Agent's conversation needs of the machine its host runs on: the
// part of the TS app's `Runtime` (apps/desktop/src/main/runtime/runtime.ts)
// that `hostLink.ts`, `hostCommand.ts` and `pathLinks.ts` use. This Mac is
// `LocalMachine`; an SSH host (WP12) is another `HostMachine` with the same
// scripts run over its transport.

import Foundation

/// A finished program: its exit code, or the signal that ended it, and what it printed.
public struct MachineResult: Sendable, Equatable {
    public var code: Int32?
    public var signal: Int32?
    public var stdout: Data
    public var stderr: Data

    public init(code: Int32?, signal: Int32?, stdout: Data, stderr: Data) {
        self.code = code
        self.signal = signal
        self.stdout = stdout
        self.stderr = stderr
    }
}

/// What to do when a program prints more than a read takes.
public enum MachineOverflow: Sendable {
    /// Fail the read: half an answer is a wrong one.
    case fail
    /// Keep the start, drop the rest.
    case truncate
}

public struct MachineLimits: Sendable {
    public var stdoutBytes: Int
    public var stderrBytes: Int
    public var overflow: MachineOverflow

    public init(stdoutBytes: Int, stderrBytes: Int, overflow: MachineOverflow) {
        self.stdoutBytes = stdoutBytes
        self.stderrBytes = stderrBytes
        self.overflow = overflow
    }
}

/// Why a program could not be run, or was stopped.
public struct MachineError: Error, CustomStringConvertible, Equatable, Sendable {
    public enum Kind: Sendable, Equatable {
        case launchFailed
        case timedOut
        case overflow
        case io
    }

    public let kind: Kind
    public let message: String

    public init(_ kind: Kind, _ message: String) {
        self.kind = kind
        self.message = message
    }

    public var description: String { message }
}

public enum MachineFileKind: String, Sendable {
    case file, directory, other, absent
}

public struct MachineDirEntry: Sendable, Equatable {
    public var name: String
    public var directory: Bool

    public init(name: String, directory: Bool) {
        self.name = name
        self.directory = directory
    }
}

/// A long-lived program whose stdout is read as it comes: a journal stream.
/// Its stdin is held open and never written, so closing it is an EOF the
/// program can see (the stream script's way to know DevHub let go).
public protocol MachineStream: AnyObject, Sendable {
    /// Its stdout, chunk by chunk, until it closes. Throws when it could not be read.
    var stdout: AsyncThrowingStream<Data, Error> { get }
    /// How it ended (stdout is empty here: it went to `stdout`), once it has.
    func ended() async throws -> MachineResult
    /// Let go of it: stdin closed, then the program and everything it started stopped.
    func kill()
}

public protocol HostMachine: Sendable {
    /// Appended to a sentence about this machine: `""` here, ` on host` for another.
    var whereSuffix: String { get }
    func home() async throws -> String
    /// Run `argv` to its end, `stdin` written to it and closed, within `timeout` seconds.
    func exec(_ argv: [String], stdin: Data?, timeout: Double, limits: MachineLimits) async throws -> MachineResult
    /// Start `argv` and read its stdout as it comes.
    func spawnStream(_ argv: [String]) throws -> MachineStream
    func stat(_ path: String) async throws -> MachineFileKind
    func readDirectory(_ path: String) async throws -> [MachineDirEntry]
    func removeTree(_ path: String) async throws
    /// Write `text` to `path` (made or replaced) with `mode`.
    func writeTextFile(_ path: String, _ text: String, mode: Int) async throws
}
