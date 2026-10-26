// Port of `JsonStateStore` from apps/desktop/src/model/persistence.ts
//
// What the store guarantees:
//
// - a write is atomic (temp file, fsync, rename) and keeps a `.bak` of the
//   last file that parsed, so a crash mid-write cannot lose the previous state;
// - a corrupt file is quarantined rather than deleted, and the load says so;
// - a file from a newer schema is an error, never a silent downgrade;
// - the whole document is decoded before any of it is adopted.
//
// An actor, so two saves cannot interleave their renames (the TS store's
// `writeChain`).

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif
import Foundation

public enum RecoveryReason: String, Sendable, Equatable {
    case missing
    case corruptPrimary = "corrupt_primary"
    case corruptPrimaryAndBackup = "corrupt_primary_and_backup"
}

public enum StateOrigin: String, Sendable, Equatable {
    case primary, backup, fresh
}

public struct LoadMetadata: Equatable, Sendable {
    public var origin: StateOrigin
    public var recoveryReason: RecoveryReason?
    /// Why the primary file would not load, in the words a person can act on.
    public var corruptionDetail: String?
    public var primaryQuarantined: Bool
    public var backupQuarantined: Bool
    public var migrated: Bool
    /// What a migration changed that the person would otherwise not know about.
    public var migrationNotes: [String]
}

public struct StateLoad: Equatable, Sendable {
    public var state: PersistedAppState
    public var metadata: LoadMetadata
}

/// Facts an old document never wrote down, looked up before it is migrated
/// (`StatePreparation`). May return a document with them filled in, and the
/// sentences the person has to be told about what it could not look up.
public typealias StatePreparation = @Sendable (WireJSON, Int) async -> (document: WireJSON, notes: [String])

public actor JsonStateStore {
    public nonisolated let path: String
    private let prepare: StatePreparation?

    public init(path: String, prepare: StatePreparation? = nil) {
        self.path = path
        self.prepare = prepare
    }

    /// `stateStoreForUserData`.
    public static func forUserData(_ userDataDir: String) -> JsonStateStore {
        JsonStateStore(path: Path.join(userDataDir, "state.json"))
    }

    public nonisolated var backupPath: String { "\(path).bak" }

    private enum Candidate {
        case missing
        case unsafe
        case bytes([UInt8])
    }

    public func loadState() async throws -> StateLoad {
        switch try readCandidate(path) {
        case .missing:
            return try await loadBackupOrFresh(.missing, primaryQuarantined: false, primaryDetail: nil)
        case .unsafe:
            throw StateError(.unsafePath)
        case let .bytes(bytes):
            switch await decodeCandidate(bytes) {
            case .newerVersion: throw StateError(.newerVersion)
            case let .corrupt(detail):
                let quarantined = quarantine(path)
                return try await loadBackupOrFresh(.corruptPrimary, primaryQuarantined: quarantined, primaryDetail: detail)
            case let .state(state, migrated, notes):
                if migrated { try saveLocked(state) }
                return StateLoad(state: state, metadata: LoadMetadata(
                    origin: .primary, primaryQuarantined: false, backupQuarantined: false, migrated: migrated, migrationNotes: notes
                ))
            }
        }
    }

    public func loadOrDefault() async throws -> PersistedAppState { try await loadState().state }

    public func saveState(_ state: PersistedAppState) throws { try saveLocked(state) }

    public func markStarting() async throws -> PersistedAppState {
        var state = try await loadOrDefault()
        state.markStarting()
        try saveLocked(state)
        return state
    }

    public func markCleanShutdown() async throws -> PersistedAppState {
        var state = try await loadOrDefault()
        state.markCleanShutdown()
        try saveLocked(state)
        return state
    }

    /// Parse, prepare, migrate and decode one candidate file.
    private func decodeCandidate(_ bytes: [UInt8]) async -> StateDecoding.Decoded {
        switch StateDecoding.parse(bytes) {
        case let .corrupt(detail): return .corrupt(detail)
        case .newerVersion: return .newerVersion
        case let .document(document, version, legacy):
            var prepared = document
            var notes: [String] = []
            if let prepare { (prepared, notes) = await prepare(document, version) }
            let decoded = StateDecoding.decodeParsed(prepared, version: version, legacy: legacy)
            if case let .state(state, migrated, migrationNotes) = decoded {
                return .state(state, migrated: migrated, migrationNotes: notes + migrationNotes)
            }
            return decoded
        }
    }

    private func loadBackupOrFresh(_ reason: RecoveryReason, primaryQuarantined: Bool, primaryDetail: String?) async throws -> StateLoad {
        switch try readCandidate(backupPath) {
        case .unsafe:
            throw StateError(.unsafePath)
        case .missing:
            return StateLoad(state: .fresh(), metadata: LoadMetadata(
                origin: .fresh, recoveryReason: reason, corruptionDetail: primaryDetail, primaryQuarantined: primaryQuarantined,
                backupQuarantined: false, migrated: false, migrationNotes: []
            ))
        case let .bytes(bytes):
            switch await decodeCandidate(bytes) {
            case .newerVersion: throw StateError(.newerVersion)
            case let .corrupt(detail):
                let backupQuarantined = quarantine(backupPath)
                return StateLoad(state: .fresh(), metadata: LoadMetadata(
                    origin: .fresh, recoveryReason: .corruptPrimaryAndBackup, corruptionDetail: primaryDetail ?? detail,
                    primaryQuarantined: primaryQuarantined, backupQuarantined: backupQuarantined, migrated: false, migrationNotes: []
                ))
            case let .state(state, migrated, notes):
                if migrated { try saveLocked(state) }
                return StateLoad(state: state, metadata: LoadMetadata(
                    origin: .backup, recoveryReason: reason, corruptionDetail: primaryDetail, primaryQuarantined: primaryQuarantined,
                    backupQuarantined: false, migrated: migrated, migrationNotes: notes
                ))
            }
        }
    }

    private func saveLocked(_ state: PersistedAppState) throws {
        try StateValidation.validate(state)
        let parent = (path as NSString).deletingLastPathComponent
        // The directory is part of the write.
        do {
            try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } catch {
            // Foundation wraps the errno (macOS: a Cocoa error over a POSIX
            // one); name it the way the write itself would.
            let ns = error as NSError
            let posix = ns.domain == NSPOSIXErrorDomain ? ns : ns.userInfo[NSUnderlyingErrorKey] as? NSError
            if let posix, posix.domain == NSPOSIXErrorDomain { throw Self.ioError(Int32(posix.code), path) }
            throw StateError(.io, path: path, cause: String(describing: error))
        }
        let text = state.fileText
        let temporary = "\(path).tmp.\(getpid()).\(Int(Date().timeIntervalSince1970 * 1000))"
        let fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        if fd < 0 { throw Self.ioError(errno, path) }
        var bytes = Array(text.utf8)
        var written = 0
        while written < bytes.count {
            let result = bytes.withUnsafeMutableBytes { buffer in
                write(fd, buffer.baseAddress!.advanced(by: written), buffer.count - written)
            }
            if result < 0 {
                let code = errno
                close(fd)
                unlink(temporary)
                throw Self.ioError(code, path)
            }
            written += result
        }
        bytes.removeAll()
        fsync(fd)
        close(fd)
        try prepareBackup()
        if rename(temporary, path) != 0 {
            let code = errno
            unlink(temporary)
            throw Self.ioError(code, path)
        }
    }

    /// The `.bak` is only ever a copy of a file that parsed.
    private func prepareBackup() throws {
        switch try readCandidate(path) {
        case .missing: return
        case .unsafe: throw StateError(.unsafePath)
        case let .bytes(bytes):
            switch StateDecoding.decode(bytes) {
            case .newerVersion: throw StateError(.newerVersion)
            case .corrupt:
                _ = quarantine(path)
            case .state:
                let temporary = "\(backupPath).tmp.\(getpid()).\(Int(Date().timeIntervalSince1970 * 1000))"
                let fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0o600)
                if fd < 0 { throw Self.ioError(errno, path) }
                let ok = bytes.withUnsafeBytes { buffer -> Bool in
                    var offset = 0
                    while offset < buffer.count {
                        let result = write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                        if result < 0 { return false }
                        offset += result
                    }
                    return true
                }
                close(fd)
                if !ok || rename(temporary, backupPath) != 0 {
                    let code = errno
                    unlink(temporary)
                    throw Self.ioError(code, path)
                }
            }
        }
    }

    private func readCandidate(_ path: String) throws -> Candidate {
        var info = stat()
        if stat(path, &info) != 0 {
            if errno == ENOENT { return .missing }
            throw Self.ioError(errno, path)
        }
        if (info.st_mode & S_IFMT) != S_IFREG { return .unsafe }
        if (info.st_mode & 0o077) != 0 { return .unsafe }
        guard let data = FileManager.default.contents(atPath: path) else {
            throw Self.ioError(EACCES, path)
        }
        return .bytes([UInt8](data))
    }

    /// Move a file that would not parse out of the way instead of deleting it.
    private func quarantine(_ path: String) -> Bool {
        for suffix in 0..<1000 {
            let candidate = "\(path).corrupt.\(suffix)"
            if FileManager.default.fileExists(atPath: candidate) { continue }
            return rename(path, candidate) == 0
        }
        return false
    }

    static func ioError(_ code: Int32, _ path: String) -> StateError {
        let message = String(cString: strerror(code))
        let name = code == EACCES ? "EACCES" : code == ENOENT ? "ENOENT" : code == EEXIST ? "EEXIST" : "errno \(code)"
        return StateError(code == EACCES ? .permissionDenied : .io, path: path, cause: "\(name): \(message)")
    }
}
