// Port of apps/desktop/src/model/settingsMigration.ts
//
// The one-time fold of `settings.local.toml` back into `settings.toml`.
//
// DevHub used to read two files: `settings.toml`, shared through a dotfiles
// repository and never written here, and `settings.local.toml` beside it, this
// machine's half and the only one a save touched. The dotfiles side now
// *generates* `settings.toml` as an ordinary file, so there is one file, DevHub
// reads it and DevHub writes it.
//
// What is left is the machines that still have the second file. On the first
// start after the change their local answers are folded into `settings.toml`
// with exactly the rule that used to combine them at read time:
//
// - Tables merge key by key, all the way down.
// - Everything else — scalars, arrays, arrays of tables — local replaces whole.
//
// Arrays replace because there is no honest answer to what merging two lists
// means — position and identity disagree, and neither can express "drop the
// third one" — so the list a file wrote is the list it got.
//
// The merge is over raw TOML tables — what the files literally say, before the
// config fills in any defaults: a default is indistinguishable from a value
// once it has been filled in, so merging two finished `Config`s would let a
// default the local file never mentioned quietly beat a real value.
//
// The old file is renamed, not deleted. It is the person's data, and a rename
// is also what makes the migration happen once.

import Foundation

public enum SettingsMigration {
    /// What a migrated `settings.local.toml` is renamed to.
    public static let migratedSuffix = ".migrated"

    /// The shared file's answers with the local file's word over them.
    public static func merge(_ shared: TomlTable, _ local: TomlTable) -> TomlTable {
        var merged = TomlTable()
        for (key, value) in shared.entries { merged[key] = value }
        for (key, mine) in local.entries {
            if case .table(let mineTable) = mine, case .table(let theirs)? = merged[key] {
                merged[key] = .table(merge(theirs, mineTable))
            } else {
                merged[key] = mine
            }
        }
        return merged
    }

    /// The text `settings.toml` should hold once the local file is folded in,
    /// written over the document that is there so the shared file keeps its
    /// comments, its grouping and its key order.
    public static func migratedText(
        shared: String,
        local: String,
        parse: (String) throws -> TomlTable
    ) throws -> String {
        let merged = merge(try parse(shared), try parse(local))
        return try TomlDocument.update(shared, desired: merged)
    }

    /// What a start found to migrate, and what it did about it.
    public enum Outcome: Equatable, Sendable {
        case nothingToMigrate
        case migrated(from: String, to: String)
    }

    /// Fold `localPath` into `sharedPath` and rename it away, if it is still there.
    ///
    /// Nothing is caught. A local file that will not parse, a `settings.toml`
    /// that cannot be written — those are startup failures, and DevHub silently
    /// running on half a configuration it just decided to rewrite is the one
    /// outcome worth avoiding.
    public static func migrateLocalSettings(
        sharedPath: String,
        localPath: String,
        parse: (String) throws -> TomlTable,
        write: (String, String) throws -> Void
    ) throws -> Outcome {
        guard let local = try readIfPresent(localPath) else { return .nothingToMigrate }
        let shared = try readIfPresent(sharedPath) ?? ""
        try write(sharedPath, try migratedText(shared: shared, local: local, parse: parse))
        let to = localPath + migratedSuffix
        try FileSystem.rename(localPath, to)
        return .migrated(from: localPath, to: to)
    }

    /// The file as text, or nil when it is not there.
    static func readIfPresent(_ path: String) throws -> String? {
        do {
            let bytes = try FileSystem.readBytes(path)
            return String(decoding: bytes, as: UTF8.self)
        } catch let error as FileSystemError where error.isNotFound {
            return nil
        }
    }
}
