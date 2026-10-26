// Port of apps/desktop/src/main/agent/conversation/agentRecords.ts and drafts.ts
//
// Something DevHub keeps for each GUI Agent across a restart of DevHub, in a
// file of its own beside `state.json`: an Agent's unsent draft (`drafts.json`),
// what DevHub is to do about the usage limit it stopped at
// (`limit-resumes.json`). Same files, same shape, as the TS app's: either app
// reads what the other wrote.
//
// A record lives exactly as long as its Agent, and the store is told which
// Agents there are (`accounted`) rather than trusting anyone to remember to
// say one went away: a record set for an Agent that is not there is dropped,
// and `prune` (run whenever the projection changes, and at load) drops every
// record whose Agent has gone. That is why these are not in the Agent's own
// host directory, which lives as long but sits on the Agent's machine — an
// SSH round trip per write, and a write that could not finish after DevHub is
// told to quit — nor in `state.json`, whose every save is a snapshot of the
// whole model.
//
// Each write replaces the file whole (a temporary file renamed over it) and
// is synchronous, so a record set is on disk before anything after it — a
// quit included — can run.

import Foundation

private let RECORDS_VERSION: Double = 1

/// A record in the file that is not one: what was wrong with it.
public struct RecordRefused: Error, CustomStringConvertible, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public struct AgentRecordsKind<T: Equatable & Sendable>: Sendable {
    /// The key the records are under in the file: `drafts`.
    public let key: String
    /// What starts empty when the file cannot be read, in a clause: `the Agents' unsent drafts start empty`.
    public let lost: String
    /// One record as the file has it; throws `RecordRefused` for one that is not.
    public let decode: @Sendable (JsonValue, String) throws -> T
    /// One record as the file keeps it.
    public let encode: @Sendable (T) -> JsonValue

    public init(
        key: String, lost: String, decode: @escaping @Sendable (JsonValue, String) throws -> T,
        encode: @escaping @Sendable (T) -> JsonValue
    ) {
        self.key = key
        self.lost = lost
        self.decode = decode
        self.encode = encode
    }
}

/// What of the store a user of one kind of record needs: each Agent's, read and set.
public protocol AgentRecordStore<Record>: Sendable {
    associatedtype Record
    func get(_ agentId: String) -> Record?
    func set(_ agentId: String, _ record: Record?)
}

public final class AgentRecords<T: Equatable & Sendable>: AgentRecordStore, @unchecked Sendable {
    private let path: String
    private let kind: AgentRecordsKind<T>
    private let accounted: @Sendable () -> Set<String>
    private let lock = NSLock()
    /// In the order they were first set, as the file keeps them.
    private var records: [(String, T)]

    private init(
        path: String, kind: AgentRecordsKind<T>, accounted: @escaping @Sendable () -> Set<String>, records: [(String, T)]
    ) {
        self.path = path
        self.kind = kind
        self.accounted = accounted
        self.records = records
    }

    /// The records at `path`, none when there is no file yet. A file that
    /// does not read as records is moved aside to `<path>.corrupt` and the
    /// store starts empty; `refused` says so, for the caller to tell the person.
    public static func load(
        _ path: String, _ kind: AgentRecordsKind<T>, accounted: @escaping @Sendable () -> Set<String>
    ) throws -> (records: AgentRecords<T>, refused: String?) {
        guard FileManager.default.fileExists(atPath: path) else {
            return (AgentRecords(path: path, kind: kind, accounted: accounted, records: []), nil)
        }
        let text = try String(contentsOfFile: path, encoding: .utf8)
        let decoded: [(String, T)]
        do {
            decoded = try decodeRecords(try JsonValue.parse(text), kind)
        } catch let error as JsonSyntaxError {
            return try setAside(path, kind, accounted, reason: "\(error)")
        } catch let error as RecordRefused {
            return try setAside(path, kind, accounted, reason: error.message)
        }
        let store = AgentRecords(path: path, kind: kind, accounted: accounted, records: decoded)
        try store.prune()
        return (store, nil)
    }

    private static func setAside(
        _ path: String, _ kind: AgentRecordsKind<T>, _ accounted: @escaping @Sendable () -> Set<String>, reason: String
    ) throws -> (records: AgentRecords<T>, refused: String?) {
        let aside = "\(path).corrupt"
        try? FileManager.default.removeItem(atPath: aside)
        try FileManager.default.moveItem(atPath: path, toPath: aside)
        return (
            AgentRecords(path: path, kind: kind, accounted: accounted, records: []),
            "\(path) could not be read (\(reason)); it was moved to \(aside), and \(kind.lost)."
        )
    }

    public func get(_ agentId: String) -> T? {
        lock.withLock { records.first { $0.0 == agentId }?.1 }
    }

    /// The Agent's record is now `record`; nil is none. Dropped when the
    /// Agent is not there: a record set after its Agent went away is a record
    /// of nothing. A write that fails is said on stderr; the record stays in
    /// memory.
    public func set(_ agentId: String, _ record: T?) {
        let accounted = self.accounted()
        lock.withLock {
            let at = records.firstIndex { $0.0 == agentId }
            if !accounted.contains(agentId) {
                if let at {
                    records.remove(at: at)
                    write()
                }
                return
            }
            if let at, let record, records[at].1 == record { return }
            if at == nil && record == nil { return }
            if let record {
                if let at { records[at].1 = record } else { records.append((agentId, record)) }
            } else if let at {
                records.remove(at: at)
            }
            write()
        }
    }

    /// Drop the record of every Agent that is not there any more.
    public func prune() throws {
        let accounted = self.accounted()
        lock.withLock {
            let before = records.count
            records.removeAll { !accounted.contains($0.0) }
            if records.count != before { write() }
        }
    }

    /// Inside the lock only.
    private func write() {
        do {
            let directory = (path as NSString).deletingLastPathComponent
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let file: JsonValue = [
                "version": .number(RECORDS_VERSION),
                kind.key: .object(JsonObject(records.map { ($0.0, kind.encode($0.1)) })),
            ]
            let temporary = "\(path).tmp"
            try Data("\(file.jsonText)\n".utf8).write(to: URL(fileURLWithPath: temporary))
            // rename(2) puts the new file in the old one's place in one step.
            if rename(temporary, path) != 0 {
                let code = errno
                try? FileManager.default.removeItem(atPath: temporary)
                throw RecordRefused("renaming \(temporary) over it failed: \(String(cString: strerror(code)))")
            }
        } catch {
            FileHandle.standardError.write(Data("[devhub] could not save \(path): \(error)\n".utf8))
        }
    }
}

private func decodeRecords<T>(_ value: JsonValue, _ kind: AgentRecordsKind<T>) throws -> [(String, T)] {
    guard case .object(let file) = value else { throw RecordRefused("it is not an object") }
    guard file["version"] == .number(RECORDS_VERSION) else {
        throw RecordRefused("its version is \(file["version"]?.jsonText ?? "undefined")")
    }
    guard case .object(let records)? = file[kind.key] else { throw RecordRefused("its \(kind.key) are not an object") }
    return try records.map { agentId, record in (agentId, try kind.decode(record, agentId)) }
}

// MARK: - Drafts

/// What the person was typing to each GUI Agent and has not sent: its draft.
///
/// One string per Agent, kept in `drafts.json` beside `state.json`, so a
/// draft outlives a restart of DevHub and comes back into the same Agent's
/// composer. The view is the only author: it reports the draft as it changes
/// (debounced there), and the last report is kept — so two places typing to
/// one Agent is last write wins.
///
/// Only the words are kept. Attached images are not: they are the bytes of
/// the images themselves, which a text file written on every pause in typing
/// should not carry, so after a restart the text comes back without them.
public final class AgentDrafts: Sendable {
    private let records: AgentRecords<String>

    private init(_ records: AgentRecords<String>) { self.records = records }

    public static let kind = AgentRecordsKind<String>(
        key: "drafts", lost: "the Agents' unsent drafts start empty",
        decode: { text, agentId in
            guard case .string(let draft) = text else { throw RecordRefused("the draft of \(agentId) is not text") }
            return draft
        },
        encode: { .string($0) })

    /// The drafts at `path`, none when there is no file yet. A file that does
    /// not read as drafts is moved aside to `<path>.corrupt` and the store
    /// starts empty; `refused` says so, for the caller to tell the person.
    public static func load(_ path: String, accounted: @escaping @Sendable () -> Set<String>) throws
        -> (drafts: AgentDrafts, refused: String?)
    {
        let (records, refused) = try AgentRecords.load(path, kind, accounted: accounted)
        return (AgentDrafts(records), refused)
    }

    /// The Agent's draft; empty when it has none.
    public func get(_ agentId: String) -> String { records.get(agentId) ?? "" }

    /// The Agent's draft is now `text`; empty is no draft. Dropped when the
    /// Agent is not there: a report that arrives after its Agent went away is
    /// a draft for nothing.
    public func set(_ agentId: String, _ text: String) { records.set(agentId, text.isEmpty ? nil : text) }

    /// Drop the draft of every Agent that is not there any more.
    public func prune() throws { try records.prune() }
}
