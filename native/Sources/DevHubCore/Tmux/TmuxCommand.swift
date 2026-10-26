// Port of the readers in apps/desktop/src/main/terminal/command.ts: the bounds,
// the record framing, and the one stderr classification (`serverReach`).
//
// Lengths are counted the way the TS counted them — a JavaScript string's
// length, UTF-16 code units — so a bound refuses exactly what it refused there.

import Foundation

public enum TmuxCommand {
    public static let maxOutputBytes = 128 * 1024
    public static let maxStderrBytes = 16 * 1024
    public static let maxLines = 2048
    public static let maxLineBytes = 4096
    public static let maxRootMetadataBytes = 16 * 1024

    /// The two bytes a tmux `-F` format uses to delimit what it answers.
    ///
    /// Neither can arrive from the values themselves: they are C0 control
    /// characters, and every field DevHub reads this way is either a
    /// tmux-generated name or a marker DevHub wrote.
    public static let fieldSeparator = "\u{1f}"
    public static let recordSeparator = "\u{1e}"

    /// An answer DevHub could not read, and which rule it broke.
    public static func shapeFailure(_ broke: String) -> PortFailure {
        portFailure(.failed, detail: "DevHub could not read what tmux answered: it had \(broke).")
    }

    /// Bytes that are UTF-8, as text; anything else is malformed provider
    /// output, refused instead of silently mangled.
    static func decodeUtf8(_ output: Data) throws -> String {
        guard let text = String(data: output, encoding: .utf8) else {
            throw shapeFailure("bytes that are not UTF-8")
        }
        return text
    }

    /// A format's answer, with the two separators tmux 3.4 hands back as
    /// text restored to the bytes DevHub wrote.
    ///
    /// tmux 3.4 prints every C0 control character of a `-F`/`-p` expansion as
    /// a backslash and three octal digits (`\037`) — newlines and tabs alone
    /// excepted — where the tmux the TS app was written against prints the
    /// byte. An answer holding neither separator as a byte and either one as
    /// an escape is that tmux; any other answer is left exactly as it came.
    /// A marker value that itself spelled `\037` is read as two fields there
    /// and so as somebody else's session: wrong in the safe direction.
    static func decodeFormatted(_ output: Data) throws -> String {
        let text = try decodeUtf8(output)
        if text.scalarContains("\u{1f}") || text.scalarContains("\u{1e}") { return text }
        if !text.contains("\\036") && !text.contains("\\037") { return text }
        return text
            .replacingOccurrences(of: "\\036", with: recordSeparator)
            .replacingOccurrences(of: "\\037", with: fieldSeparator)
    }

    /// Split provider output into lines. A NUL byte, an over-long line or too
    /// many lines is malformed provider output, not a partial answer.
    public static func parseLines(_ output: Data) throws -> [String] {
        let text = try decodeFormatted(output)
        if text.scalarContains("\0") { throw shapeFailure("a NUL byte") }
        var lines: [String] = []
        for raw in text.scalarSplit("\n") {
            let line = raw.scalarHasSuffix("\r") ? raw.scalarDropLast() : raw
            if line.isEmpty { continue }
            if line.utf16.count > maxLineBytes || lines.count == maxLines {
                throw shapeFailure("more lines, or a longer one, than it can hold")
            }
            lines.append(line)
        }
        return lines
    }

    /// Cut one client's whole answer into the records DevHub asked tmux to
    /// frame.
    ///
    /// The newline tmux appends after each expanded format is *not* the record
    /// separator here — a marker value may contain newlines (a path can), and
    /// splitting on them would tear one session's identity into two half-read
    /// ones. A format ends with `recordSeparator`, so a record ends where
    /// DevHub said it ends and tmux's newline is only the byte that follows it.
    public static func splitRecords(_ output: Data) throws -> [String] {
        if output.count > maxOutputBytes { throw shapeFailure("too much of it") }
        let text = try decodeFormatted(output)
        if text.scalarContains("\0") { throw shapeFailure("a NUL byte") }
        if text.isEmpty { return [] }
        var chunks = text.scalarSplit("\u{1e}")
        // Every record is terminated, so what follows the last one is exactly
        // the newline tmux appended to it.
        if chunks.removeLast() != "\n" { throw shapeFailure("an unterminated record") }
        if chunks.count > maxLines { throw shapeFailure("more records than it can hold") }
        return try chunks.enumerated().map { index, chunk in
            if index == 0 { return chunk }
            if !chunk.scalarHasPrefix("\n") { throw shapeFailure("an unterminated record") }
            return chunk.scalarDropFirst()
        }
    }

    /// Parse the answer of one `-F` listing into records of fixed width.
    public static func parseRecords(_ output: Data, fieldCount: Int) throws -> [[String]] {
        try splitRecords(output).map { record in
            let fields = record.scalarSplit("\u{1f}")
            if fields.count != fieldCount { throw shapeFailure("a record of the wrong width") }
            for field in fields where field.utf16.count > maxRootMetadataBytes {
                throw shapeFailure("a field longer than it can hold")
            }
            return fields
        }
    }

    /// Parse one tmux option value without treating an embedded newline as a
    /// record separator. tmux appends exactly one newline to `show-options`; a
    /// path may itself contain newlines and those bytes remain part of identity.
    public static func parseOptionValue(_ output: Data) throws -> String {
        if output.count > maxOutputBytes { throw shapeFailure("too much of it") }
        let text = try decodeUtf8(output)
        if text.scalarContains("\0") { throw shapeFailure("a NUL byte") }
        if !text.scalarHasSuffix("\n") { throw shapeFailure("an unterminated option value") }
        let value = text.scalarDropLast()
        if value.utf16.count > maxRootMetadataBytes { throw shapeFailure("an option value longer than it can hold") }
        return value
    }

    /// A pane capture, as text: bounded and valid UTF-8, but not required to
    /// end in a newline, and its embedded newlines are the lines the rules read.
    public static func parseCapture(_ output: Data) throws -> String {
        if output.count > maxOutputBytes { throw shapeFailure("too much of it") }
        return try decodeUtf8(output)
    }

    /// One `display-message -p` answer, separators restored as for a listing.
    public static func parseDisplay(_ output: Data) throws -> String {
        if output.count > maxOutputBytes { throw shapeFailure("too much of it") }
        return try decodeFormatted(output)
    }

    // MARK: - serverReach

    /// What a failed tmux client said about the server it tried to reach.
    public enum ServerReach: Sendable, Equatable {
        /// Nothing is listening — an answer, not a failure.
        case noServer
        /// The client never got as far as a server, because the socket it
        /// would connect through cannot be used.
        case socketUnusable(PortFailure)
        /// The client reached *a* server and that server refused.
        case reached
    }

    /// As long as a line of tmux's may be in a detail: one line, bounded.
    static let maxSocketLine = 512

    /// The one stderr classification the runtime makes, at the one place every
    /// tmux DevHub runs goes through (`runTmuxSpec`).
    ///
    /// There is no server when tmux says "no server running on <socket>", "error
    /// connecting to <socket> (No such file or directory)", or "server exited
    /// unexpectedly" (a command overlapping DevHub's own server's exit). The
    /// socket cannot be used when tmux says "error connecting to <socket> (File
    /// name too long)" or "error creating <socket> (…)" — named, because a
    /// shorter `TMUX_TMPDIR` fixes it — "error connecting to <socket> (<any
    /// other reason>)", "couldn't create directory <dir> (…)", "directory <dir>
    /// has unsafe permissions", or "no suitable socket path". The last line is
    /// the one read, because tmux prints the reason it stopped last.
    public static func serverReach(_ stderr: Data) -> ServerReach {
        let said = String(decoding: stderr, as: UTF8.self)
            .scalarSplit("\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .last
        guard let said else { return .reached }
        let lower = said.lowercased()
        if lower.hasPrefix("no server running") || lower == "no server" || lower.contains("server exited unexpectedly") {
            return .noServer
        }
        if let (path, reason) = socketError(said) {
            if reason == "No such file or directory" && said.hasPrefix("error connecting") {
                return .noServer
            }
            if reason == "File name too long" {
                return .socketUnusable(portFailure(
                    .socketPathTooLong,
                    detail: "\(path) is \(path.utf8.count) bytes; macOS allows 103 and Linux 107. Set TMUX_TMPDIR to a shorter directory."
                ))
            }
            return unusableSocket(said)
        }
        if isUnsafeDirectory(said) || said == "no suitable socket path" { return unusableSocket(said) }
        return .reached
    }

    /// `^(?:error connecting to|error creating|couldn't create directory) (.+) \((.+)\)$`
    static func socketError(_ said: String) -> (String, String)? {
        let pattern = #"^(?:error connecting to|error creating|couldn't create directory) (.+) \((.+)\)$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: said, range: NSRange(said.startIndex..., in: said)),
              let path = Range(match.range(at: 1), in: said),
              let reason = Range(match.range(at: 2), in: said)
        else { return nil }
        return (String(said[path]), String(said[reason]))
    }

    static func isUnsafeDirectory(_ said: String) -> Bool {
        said.hasPrefix("directory ") && said.hasSuffix(" has unsafe permissions") && said.count > "directory  has unsafe permissions".count
    }

    /// The socket failure that is not about length, in tmux's own words.
    static func unusableSocket(_ said: String) -> ServerReach {
        .socketUnusable(portFailure(
            .socketUnusable,
            detail: "tmux could not use its socket: \(String(said.prefix(maxSocketLine)))"
        ))
    }
}
