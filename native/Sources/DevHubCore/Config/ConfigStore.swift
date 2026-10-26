// Port of apps/desktop/src/model/config.ts — `ConfigStore`.
//
// The one owner of DevHub's settings file in this process.
//
// `load` adopts it, folding in an old `config.toml` or `settings.local.toml`
// first if either is still there; `reload` adopts a newer one, or keeps the
// last good config and records the diagnostic; `save` writes it atomically and
// only over the revision it was given, so an edit made underneath an open
// Settings window is a refusal rather than a silent overwrite.

import Foundation

public actor ConfigStore {
    public nonisolated let paths: ConfigPaths
    private var active: LoadedConfig?
    private var diagnostic: ConfigDiagnostic?
    /// What the last `load` folded in, for the caller that says so in the log.
    private var migration: SettingsMigration.Outcome = .nothingToMigrate
    private var watchers: [UUID: Task<Void, Never>] = [:]

    public init(paths: ConfigPaths) {
        self.paths = paths
    }

    public func load() throws -> LoadedConfig {
        do {
            return try loadOnce()
        } catch let error as ConfigError {
            // Recorded, not swallowed: `load` still throws, and the caller
            // still decides whether to start. But the Settings window needs the
            // diagnostic to show even when the *first* read failed.
            diagnostic = error.diagnostic
            throw error
        }
    }

    private func loadOnce() throws -> LoadedConfig {
        try adoptLegacyFile()
        migration = try adoptLocalFile()
        var text: String
        do {
            text = try read()
        } catch let error as ConfigError where error.code == .io && error.diagnostic.path == "ENOENT" {
            // No file yet. Write the defaults down, so that the first thing a
            // person opens is a document stating what DevHub is actually doing.
            text = try TomlDocument.render(ConfigParsing.document(.defaults))
            try atomicWrite(text)
        }
        let loaded = try decode(text)
        active = loaded
        diagnostic = nil
        return loaded
    }

    /// What the last `load` folded in. `load` is the only thing that sets it.
    public func lastMigration() -> SettingsMigration.Outcome { migration }

    public func reload() throws -> ReloadOutcome {
        let text: String
        do {
            text = try read()
        } catch let error as ConfigError {
            diagnostic = error.diagnostic
            throw error
        }
        let revision = contentRevision(text)
        if active?.revision == revision { return .unchanged(revision: revision) }
        let loaded: LoadedConfig
        do {
            loaded = try decode(text)
        } catch let error as ConfigError {
            diagnostic = error.diagnostic
            throw error
        }
        active = loaded
        diagnostic = nil
        return .applied(loaded)
    }

    public func current() -> LoadedConfig? { active }

    public func lastDiagnostic() -> ConfigDiagnostic? { diagnostic }

    /// Write a whole configuration down, over the document that is there: the
    /// file keeps its comments, its grouping and its order, and only the spans
    /// whose values changed are rewritten.
    public func save(expectedRevision: ContentRevision, config: Config) throws -> LoadedConfig {
        try ConfigParsing.validate(config)
        let text = try read()
        let actual = contentRevision(text)
        if actual != expectedRevision {
            throw ConfigError(ConfigDiagnostic(code: .conflict), expectedRevision: expectedRevision, actualRevision: actual)
        }
        let output: String
        do {
            output = try TomlDocument.update(text, desired: ConfigParsing.document(config))
        } catch is TomlSyntaxError {
            throw ConfigError(code: .serialization)
        }
        let loaded = try decode(output)
        try atomicWrite(output, expectedRevision: actual)
        active = loaded
        diagnostic = nil
        return loaded
    }

    /// Put part of the configuration back to DevHub's defaults: an ordinary
    /// save with some of the values replaced, so there is one path that writes
    /// settings.
    public func resetScope(expectedRevision: ContentRevision, keys: [ConfigScopeKey]) throws -> LoadedConfig {
        let current = try decode(read()).config
        return try save(expectedRevision: expectedRevision, config: current.resetting(keys))
    }

    /// Notice an edit made outside the app.
    ///
    /// Polling, as the TypeScript app does: a config file is edited by a
    /// person, not by a hot loop, and a watcher that has to be correct across
    /// editors that write-and-rename is more machinery than the cost of a stat
    /// every few seconds. The callback hears an applied reload or a
    /// diagnostic, never an unchanged one. Answers a token for `unwatch`.
    @discardableResult
    public func watch(
        intervalMs: Int,
        _ callback: @escaping @Sendable (Result<LoadedConfig, ConfigDiagnosticFailure>) -> Void
    ) -> UUID {
        let interval = max(10, intervalMs)
        let id = UUID()
        watchers[id] = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval) * 1_000_000)
                guard !Task.isCancelled, let self else { return }
                do {
                    if case .applied(let loaded) = try await self.reload() { callback(.success(loaded)) }
                } catch let error as ConfigError {
                    callback(.failure(ConfigDiagnosticFailure(diagnostic: error.diagnostic)))
                } catch {
                    callback(.failure(ConfigDiagnosticFailure(diagnostic: ConfigDiagnostic(code: .io))))
                }
            }
        }
        return id
    }

    public func unwatch(_ id: UUID) {
        watchers.removeValue(forKey: id)?.cancel()
    }

    /// The file as text. A missing file is the `ENOENT` io error.
    private func read() throws -> String {
        let bytes: [UInt8]
        do {
            bytes = try FileSystem.readBytes(paths.file)
        } catch let error as FileSystemError {
            throw error.isNotFound ? ConfigError(code: .io, path: "ENOENT") : ConfigError(code: .io)
        }
        return try decodeUTF8(bytes)
    }

    private func decode(_ text: String) throws -> LoadedConfig {
        let document = try ConfigParsing.parseText(text)
        return LoadedConfig(
            config: try ConfigParsing.interpret(document),
            revision: contentRevision(text),
            notices: ConfigParsing.retiredKeysIn(document)
        )
    }

    /// Take the pre-split `config.toml` over, if the settings file is not
    /// there: a rename rather than a copy, and only when there is nothing to
    /// overwrite.
    private func adoptLegacyFile() throws {
        guard let legacy = paths.legacy else { return }
        if FileSystem.exists(paths.file) { return }
        do {
            try FileSystem.makeDirectories((paths.file as NSString).deletingLastPathComponent)
            try FileSystem.rename(legacy, paths.file)
        } catch let error as FileSystemError {
            if !error.isNotFound { throw ConfigError(code: .io) }
        }
    }

    /// Fold `settings.local.toml` into the settings file, once. Nothing is
    /// caught: a local file that will not parse, or a settings file that cannot
    /// be written, is a startup failure.
    private func adoptLocalFile() throws -> SettingsMigration.Outcome {
        guard let local = paths.local else { return .nothingToMigrate }
        do {
            return try SettingsMigration.migrateLocalSettings(
                sharedPath: paths.file,
                localPath: local,
                parse: ConfigParsing.parseText,
                write: { _, text in try self.atomicWrite(text) }
            )
        } catch let error as FileSystemError {
            _ = error
            throw ConfigError(code: .io)
        }
    }

    /// Write through a temporary file in the same directory and rename over the
    /// target, so a crash mid-write leaves the previous config intact rather
    /// than a half-written one that will not parse.
    private func atomicWrite(_ text: String, expectedRevision: ContentRevision? = nil) throws {
        do {
            if let expectedRevision {
                let actual = contentRevision(try FileSystem.readBytes(paths.file))
                if actual != expectedRevision {
                    throw ConfigError(ConfigDiagnostic(code: .conflict), expectedRevision: expectedRevision, actualRevision: actual)
                }
            }
            try FileSystem.atomicWrite(paths.file, text)
        } catch let error as FileSystemError {
            _ = error
            throw ConfigError(code: .io)
        }
    }
}

/// A watcher's refusal: the diagnostic the reload could not get past.
public struct ConfigDiagnosticFailure: Error, Equatable, Sendable {
    public let diagnostic: ConfigDiagnostic
}

/// `new TextDecoder("utf-8", { fatal: true }).decode(bytes)`: invalid UTF-8 is
/// refused, and a leading byte-order mark is dropped.
func decodeUTF8(_ bytes: [UInt8]) throws -> String {
    var slice = bytes[...]
    if slice.starts(with: [0xEF, 0xBB, 0xBF]) { slice = slice.dropFirst(3) }
    guard let text = String(validatingUTF8Bytes: slice) else { throw ConfigError(code: .invalidUtf8) }
    return text
}

extension String {
    /// The bytes as UTF-8, or nil when they are not valid UTF-8.
    init?<Bytes: Collection>(validatingUTF8Bytes bytes: Bytes) where Bytes.Element == UInt8 {
        var iterator = bytes.makeIterator()
        var decoder = UTF8()
        var scalars = String.UnicodeScalarView()
        loop: while true {
            switch decoder.decode(&iterator) {
            case .scalarValue(let scalar): scalars.append(scalar)
            case .emptyInput: break loop
            case .error: return nil
            }
        }
        self = String(scalars)
    }
}
