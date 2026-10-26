// Port of the listing half of apps/desktop/src/main/agent/conversation/resume.ts:
// the sessions of each CLI, their previews, and a Claude session read back
// as history on the Agent's machine.
//
// Going on with an earlier session of an Agent's CLI. The argv half — one
// spelling of a resume, `withSession` — is `SessionArgs.swift` (WP5); the
// session a terminal Agent is in is `TerminalAgentSessionLookup` (WP3); the
// file-to-history fold is `ClaudeHistory.swift` (WP5).
//
// # What the CLIs keep
//
// The listing is each CLI's own, read on the Workspace's machine:
//
// - Codex answers `thread/list` on `app-server`, filtered to the Workspace's
//   directory. A short-lived app-server is started for the one question.
// - Claude has no listing command. It keeps each session as JSONL under
//   `<config>/projects/<cwd with every non-alphanumeric character as ->/`,
//   which is read here and never written.
//
// # History
//
// Codex's `thread/resume` answers with the thread's turns, which its adapter
// already draws. Claude's stream-json with `--resume` prints nothing of the
// past, so the session's file is read at launch and its conversation — the
// chain of messages from its last one back to its first — is put at the head
// of the journal as `devhub_history` lines, before the CLI prints anything.
// The adapter reads them like every other line, live or replayed, so the
// history is part of the conversation rather than a second source beside it.
//
// Every script here is byte-identical to the TS app's (a test compares them
// with what Node evaluates the TS module's templates to).

import Foundation

/// One earlier session, as the resume picker lists it.
public struct PastSession: Equatable, Sendable {
    /// Claude's session id, Codex's thread id: what the launch resumes.
    public var id: String
    /// Its title, or its first message when it has none.
    public var title: String
    /// When it last changed, in ms since the epoch, if the CLI says.
    public var updatedAt: Double?
    /// The directory it ran in, if the CLI says.
    public var cwd: String?
    /// The git branch it was last on, if the CLI recorded one.
    public var branch: String?
    /// Whether an Agent in the Workspace listed for can go on with it. Claude
    /// resumes a session only in the directory it ran in (its file is kept
    /// under that directory's name), as its own `/resume` says of another
    /// project's; Codex resumes a thread in any directory it is given.
    public var resumableHere: Bool

    public init(id: String, title: String, updatedAt: Double?, cwd: String?, branch: String? = nil, resumableHere: Bool) {
        self.id = id
        self.title = title
        self.updatedAt = updatedAt
        self.cwd = cwd
        self.branch = branch
        self.resumableHere = resumableHere
    }
}

/// Which sessions a listing offers: the Workspace's directory's, or every
/// directory's on the machine — as the CLIs' own pickers offer both.
public enum SessionScope: String, Sendable, Equatable {
    case here, everywhere

    /// A listing's scope as a page said it, checked (`sessionScope`).
    public init(checking scope: JsonValue?) throws {
        guard case .string(let word)? = scope, let known = SessionScope(rawValue: word) else {
            throw AdapterRefusal("\(scope?.jsonText ?? "undefined") is not a scope of sessions")
        }
        self = known
    }
}

/// One message of a session's last exchanges, as the picker previews it.
public struct PreviewLine: Equatable, Sendable {
    public enum Role: String, Sendable { case person, agent }
    public var role: Role
    public var text: String

    public init(role: Role, text: String) {
        self.role = role
        self.text = text
    }
}

/// What a listing or a history needs of the profile: its command, as resolved on the machine.
public struct SessionProfile: Equatable, Sendable {
    public var kind: SessionCLIKind
    public var command: String
    public var args: [String]
    public var env: [String: String]

    public init(kind: SessionCLIKind, command: String, args: [String], env: [String: String]) {
        self.kind = kind
        self.command = command
        self.args = args
        self.env = env
    }
}

/// How much of a session's end a preview reads.
let PREVIEW_BYTES = 256 * 1024
/// How many messages a preview shows.
private let PREVIEWED = 6
/// How many sessions a listing offers.
let LISTED = 50
/// The largest session file DevHub reads back as history.
let MAX_HISTORY_BYTES = 32 * 1024 * 1024

public enum ResumeScripts {
    /// The last `PREVIEW_BYTES` of the file `$1`, whole lines only.
    public static let tail = "[ -f \"$1\" ] || { echo \"there is no $1\" >&2; exit 66; }\ntail -c \(PREVIEW_BYTES) -- \"$1\"\n"

    /// The same of thread `$2`'s rollout under `$1`: Codex names each
    /// `rollout-<time>-<thread id>.jsonl`, under a directory per day.
    public static let codexRolloutTail = "f=$(find \"$1\" -name \"rollout-*-$2.jsonl\" 2>/dev/null | head -n 1)\n[ -n \"$f\" ] || { echo \"there is no rollout of thread $2 under $1\" >&2; exit 66; }\ntail -c \(PREVIEW_BYTES) -- \"$f\"\n"

    /// The newest session files in `$1` — down to depth `$2`: 1 for one
    /// project's directory, 2 for every project's under `projects/` — each as
    /// a record separator and its id, the directory its file is in (`.` at
    /// depth 1), then its last timestamp, the directory it ran in, the git
    /// branch it was last on (the last `gitBranch`), its last `custom-title`
    /// line (the name a person gave it with `/rename` or `--name`), its last
    /// `ai-title` line, and how many candidate first messages follow (the
    /// first few `user` lines that are not a tool result or a meta message,
    /// each whole). A directory that is not there is one Claude never ran in:
    /// no sessions.
    ///
    /// Newest by modification time, across directories: `stat` in GNU's
    /// spelling or BSD's, through `find -exec +` so that no number of files is
    /// an argument list too long. awk rather than reading every file here,
    /// because a session's file can be tens of megabytes and only these few
    /// lines of it are wanted.
    public static let claudeListing = "[ -d \"$1\" ] || exit 0\ncd -- \"$1\" || exit 71\nfind . -mindepth \"$2\" -maxdepth \"$2\" -name '*.jsonl' -type f -exec sh -c 'stat -c \"%Y %n\" -- \"$@\" 2>/dev/null || stat -f \"%m %N\" -- \"$@\"' sh {} + |\n\tsort -rn | {\n\tn=0\n\twhile IFS= read -r l; do\n\t\tf=${l#* }\n\t\tn=$((n + 1))\n\t\t[ \"$n\" -le \(LISTED) ] || break\n\t\tb=${f##*/}\n\t\tprintf '\\036%s\\n%s\\n' \"${b%.jsonl}\" \"${f%/*}\"\n\t\tawk '\n/\"type\":\"custom-title\"/ && length($0) < 4096 { named = $0 }\n/\"type\":\"ai-title\"/ && length($0) < 4096 { title = $0 }\nc < 5 && /\"type\":\"user\"/ && !/\"tool_use_id\"/ && !/\"isMeta\":true/ && !/\"isSidechain\":true/ && length($0) < 16384 { first[c++] = $0 }\nmatch($0, /\"timestamp\":\"[^\"]*\"/) { stamp = substr($0, RSTART + 13, RLENGTH - 14) }\ncwd == \"\" && match($0, /\"cwd\":\"([^\"\\\\]|\\\\.)*\"/) { cwd = substr($0, RSTART, RLENGTH) }\nmatch($0, /\"gitBranch\":\"([^\"\\\\]|\\\\.)*\"/) { branch = substr($0, RSTART, RLENGTH) }\nEND { print stamp; print cwd; print branch; print named; print title; print c + 0; for (i = 0; i < c; i++) print first[i] }\n' \"$f\" || exit 72\n\tdone\n}\n"

    /// `app-server` answers on stdin that stays open: at end of input it
    /// exits without answering what is still in flight. So the requests go
    /// in, and the input is held open until the answer to `thread/list` (id
    /// 2) has come out — or the server has ended — and then closed, which
    /// ends the server. The answer is recognised by its top-level id, first
    /// or last in the object and however the JSON is spaced; a pattern tied to
    /// one serializer's spacing left the input open until the deadline.
    public static let codexListing = "d=$(mktemp -d) || exit 70\ntrap 'rm -rf \"$d\"' EXIT\n{ cat; until [ -e \"$d/done\" ]; do sleep 0.1; done; } | \"$@\" | {\n\twhile IFS= read -r l; do\n\t\tprintf '%s\\n' \"$l\"\n\t\tprintf '%s\\n' \"$l\" | grep -Eq '^[{][[:space:]]*\"id\"[[:space:]]*:[[:space:]]*2[[:space:]]*[,}]|[,{][[:space:]]*\"id\"[[:space:]]*:[[:space:]]*2[[:space:]]*[}][[:space:]]*$' && break\n\tdone\n\t: >\"$d/done\"\n}\n"
}

/// The sessions of `profile`'s CLI on `runtime`, newest first: those that
/// ran in the directory `root`, or (`everywhere`) in any directory, each
/// saying whether an Agent in `root` can go on with it.
public func listPastSessions(
    _ runtime: any MachineRuntime, _ profile: SessionProfile, root: String, scope: SessionScope = .here
) async throws -> [PastSession] {
    let cwd = try await runtime.realpath(root)
    switch profile.kind {
    case .claude: return try await listClaudeSessions(runtime, profile, cwd, scope)
    case .codex: return try await listCodexSessions(runtime, profile, cwd: cwd, scope: scope, sourceKinds: nil)
    }
}

/// The last few messages of session `id` — the person's words and the
/// Agent's answers, not tools — read on demand from the end of its file, so a
/// preview costs the same whatever the session's length. `cwd` is the
/// directory the listing said it ran in (Claude keeps a session under it).
public func previewPastSession(_ runtime: any MachineRuntime, _ profile: SessionProfile, id: String, cwd: String)
    async throws -> [PreviewLine]
{
    let idCharacters = id.unicodeScalars.allSatisfy { scalar in
        scalar.isASCII && (CharacterSet.alphanumerics.contains(scalar) || scalar == "_" || scalar == "-")
    }
    if id.isEmpty || !idCharacters {
        throw AdapterRefusal("\(JsonValue.quoted(id)) is not a session id")
    }
    let argv: [String]
    switch profile.kind {
    case .claude:
        argv = ["sh", "-c", ResumeScripts.tail, "sh", "\(try await claudeProjectDirectory(runtime, profile, cwd))/\(id).jsonl"]
    case .codex:
        argv = ["sh", "-c", ResumeScripts.codexRolloutTail, "sh", "\(try await codexHome(runtime, profile))/sessions", id]
    }
    let answer = try await askMachine(runtime, "DevHub could not read the end of session \(id)") {
        ExecRequest(
            argv: argv, env: try await runtime.environment(), deadline: .within(10_000), cancel: CancellationToken(),
            limits: MachineExecLimits(
                stdoutBytes: PREVIEW_BYTES + 1024, stderrBytes: 16 * 1024,
                overflow: .fail({ AdapterRefusal("the end of session \(id) was longer than read") })))
    }
    if answer.code != 0 {
        throw ConversationError.sessionsUnreadable(
            "DevHub could not read the end of session \(id)\(runtime.where): \(machineSaid(answer))")
    }
    return profile.kind == .claude ? claudePreview(answer.stdoutText) : codexPreview(answer.stdoutText)
}

/// What a program that failed said: the end of its stderr, else how it ended.
private func machineSaid(_ answer: ExecResult) -> String {
    let said = JSString.trim(answer.stderrText)
    if !said.isEmpty { return said }
    return "exit \(answer.code.map(String.init) ?? answer.signal.map(String.init) ?? "null")"
}

/// The JSON objects among the lines of a file's end; the first, likely cut, is not one.
private func tailRecords(_ text: String) -> [JsonObject] {
    text.components(separatedBy: "\n").compactMap { line in
        if JSString.trim(line).isEmpty { return nil }
        // The first line of a file's end is cut wherever the read began.
        guard case .object(let record)? = try? JsonValue.parse(line) else { return nil }
        return record
    }
}

/// The text blocks of a message's content, joined; the content itself when it is a string.
private func contentText(_ content: JsonValue?) -> String? {
    switch content {
    case .string(let text)?: return text
    case .array(let blocks)?:
        return blocks.compactMap { block -> String? in
            guard case .object(let fields) = block, fields["type"] == "text", case .string(let text)? = fields["text"]
            else { return nil }
            return text
        }.joined(separator: "\n")
    default: return nil
    }
}

/// A Claude session file's end, as its last messages.
public func claudePreview(_ text: String) -> [PreviewLine] {
    var lines: [PreviewLine] = []
    for record in tailRecords(text) {
        if record["isSidechain"] == .bool(true) || record["isMeta"] == .bool(true) { continue }
        if record["isCompactSummary"] == .bool(true) { continue }
        let said = contentText(record["message"]?["content"]) ?? ""
        if JSString.trim(said).isEmpty { continue }
        if record["type"] == "user" { lines.append(PreviewLine(role: .person, text: said)) }
        if record["type"] == "assistant" { lines.append(PreviewLine(role: .agent, text: said)) }
    }
    return lines.suffix(PREVIEWED).map(shortened)
}

/// A Codex rollout's end, as its last messages.
public func codexPreview(_ text: String) -> [PreviewLine] {
    var lines: [PreviewLine] = []
    for record in tailRecords(text) {
        guard record["type"] == "event_msg", case .string(let message)? = record["payload"]?["message"] else { continue }
        let type = record["payload"]?["type"]
        if type == "user_message" { lines.append(PreviewLine(role: .person, text: message)) }
        if type == "agent_message" { lines.append(PreviewLine(role: .agent, text: message)) }
    }
    return lines.suffix(PREVIEWED).map(shortened)
}

private func shortened(_ line: PreviewLine) -> PreviewLine {
    let text = JSString.trim(line.text)
    return PreviewLine(role: line.role, text: JSString.length(text) > 600 ? "\(jsSlice(text, 599))…" : text)
}

/// Where Codex keeps its state: `CODEX_HOME`, the profile's before the machine's.
func codexHome(_ runtime: any MachineRuntime, _ profile: SessionProfile) async throws -> String {
    if let home = profile.env["CODEX_HOME"] { return home }
    if let home = try await runtime.environment()["CODEX_HOME"] { return home }
    return "\(try await runtime.home())/.codex"
}

/// `runtime.exec`, with a failure to get an answer at all — a deadline, a
/// machine that is not there — said as what was being asked, not as the
/// runtime's own words about itself.
private func askMachine(
    _ runtime: any MachineRuntime, _ what: String, _ request: () async throws -> ExecRequest
) async throws -> ExecResult {
    let made = try await request()
    do {
        return try await runtime.exec(made)
    } catch {
        throw ConversationError.sessionsUnreadable("\(what)\(runtime.where): \(RuntimeFailureText.of(error))")
    }
}

// MARK: - Claude

/// Where Claude keeps the sessions it ran in `cwd` (a real path).
///
/// `CLAUDE_CONFIG_DIR` moves the whole of `~/.claude`; the profile's own
/// environment wins over the machine's, as it does for the CLI itself.
func claudeProjectDirectory(_ runtime: any MachineRuntime, _ profile: SessionProfile, _ cwd: String) async throws
    -> String
{
    let config = try await claudeConfigDirectory(runtime, profileEnv: profile.env)
    return "\(config)/projects/\(projectName(cwd))"
}

/// `cwd.replace(/[^a-zA-Z0-9]/g, "-")`, by UTF-16 code unit as JavaScript replaces.
private func projectName(_ cwd: String) -> String {
    String(
        decoding: cwd.utf16.map { unit -> UInt16 in
            switch unit {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A: return unit
            default: return 0x2D
            }
        }, as: UTF16.self)
}

private func listClaudeSessions(
    _ runtime: any MachineRuntime, _ profile: SessionProfile, _ cwd: String, _ scope: SessionScope
) async throws -> [PastSession] {
    let here = try await claudeProjectDirectory(runtime, profile, cwd)
    let slash = here.lastIndex(of: "/")!
    let directory = scope == .here ? here : String(here[..<slash])
    let answer = try await askMachine(runtime, "DevHub could not list Claude's sessions in \(directory)") {
        ExecRequest(
            argv: ["sh", "-c", ResumeScripts.claudeListing, "sh", directory, scope == .here ? "1" : "2"],
            env: try await runtime.environment(), deadline: .within(15_000), cancel: CancellationToken(),
            limits: MachineExecLimits(
                stdoutBytes: 8 * 1024 * 1024, stderrBytes: 16 * 1024,
                overflow: .fail({ AdapterRefusal("the listing of \(directory) was longer than expected") })))
    }
    if answer.code != 0 {
        throw ConversationError.sessionsUnreadable(
            "DevHub could not list Claude's sessions in \(directory)\(runtime.where): \(machineSaid(answer))")
    }
    return try parseClaudeListing(answer.stdoutText, project: String(here[here.index(after: slash)...]), cwd: cwd)
}

/// The listing script's output, as sessions; `project` is the name of the
/// Workspace's directory `cwd` under `projects/`, the one a session's file
/// must be in for Claude to resume it there — and where one that does not
/// say where it ran did.
public func parseClaudeListing(_ output: String, project: String, cwd: String) throws -> [PastSession] {
    var sessions: [PastSession] = []
    for chunk in output.components(separatedBy: "\u{1E}").dropFirst() {
        let fields = chunk.components(separatedBy: "\n")
        guard fields.count >= 8 else {
            throw AdapterRefusal("the listing of Claude's sessions is cut short: \(chunk)")
        }
        let id = fields[0], folder = fields[1], stamp = fields[2], cwdField = fields[3], branchField = fields[4]
        let namedLine = fields[5], generatedLine = fields[6], count = Int(fields[7]) ?? 0
        let candidates = fields.dropFirst(8).prefix(count)
        let first = try candidates.map { try promptOf(id, $0) }.compactMap { $0 }.first
        // A file with no message a person wrote is a session nobody can go on
        // with — Claude's own `/resume` leaves those out too.
        guard let title = try titleOf(id, namedLine, generatedLine, first) else { continue }
        let updatedAt = stamp.isEmpty ? nil : parseISOTime(stamp)
        // Claude finds a session by the directory its file is kept under,
        // whatever its lines say.
        let resumableHere = folder == "." || folder == "./\(project)"
        let ran: String?
        if !cwdField.isEmpty {
            ran = try JsonValue.parse("{\(cwdField)}")["cwd"]?.stringValue
        } else {
            ran = resumableHere ? cwd : nil
        }
        let branch = branchField.isEmpty ? "" : try JsonValue.parse("{\(branchField)}")["gitBranch"]?.stringValue ?? ""
        sessions.append(
            PastSession(
                id: id, title: oneLine(title), updatedAt: updatedAt, cwd: ran,
                // Claude records an empty branch where there is no repository.
                branch: branch.isEmpty ? nil : branch, resumableHere: resumableHere))
    }
    return sessions
}

private func parsedRecord(_ id: String, _ line: String) throws -> JsonObject {
    guard case .object(let record)? = try? JsonValue.parse(line) else {
        throw ConversationError.notResumable("Claude's session \(id) has a line that is not a JSON object")
    }
    return record
}

/// A session's title, in the precedence the Agent SDK gives a session's
/// display name: the name a person gave it (its last `custom-title` line),
/// else the title Claude generated (its last `ai-title` line), else its
/// first prompt.
private func titleOf(_ id: String, _ namedLine: String, _ generatedLine: String, _ first: String?) throws -> String? {
    try recordText(id, namedLine, "custom-title", "customTitle") ?? recordText(id, generatedLine, "ai-title", "aiTitle")
        ?? first
}

/// The text under `key` of a listed line of type `type`, if there is one.
private func recordText(_ id: String, _ line: String, _ type: String, _ key: String) throws -> String? {
    if line.isEmpty { return nil }
    let record = try parsedRecord(id, line)
    guard record["type"] == .string(type), case .string(let text)? = record[key] else { return nil }
    return text
}

/// The text a person wrote, if this `user` line is one.
private func promptOf(_ id: String, _ line: String) throws -> String? {
    let record = try parsedRecord(id, line)
    guard record["type"] == "user" else { return nil }
    let content = record["message"]?["content"]
    if case .string(let text)? = content { return text }
    guard case .array? = content, let text = contentText(content) else { return nil }
    return text.isEmpty ? nil : text
}

/// `text.replace(/\s+/g, " ").trim()`, at most 200 code units.
private func oneLine(_ text: String) -> String {
    var flat = ""
    var inSpace = false
    for scalar in text.unicodeScalars {
        if JSString.isWhitespace(scalar) {
            if !inSpace { flat.append(" ") }
            inSpace = true
        } else {
            flat.unicodeScalars.append(scalar)
            inSpace = false
        }
    }
    flat = JSString.trim(flat)
    return JSString.length(flat) > 200 ? "\(jsSlice(flat, 199))…" : flat
}

/// Claude session `session`'s conversation, as the journal lines its adapter
/// reads as history. Refused, with the reason, when the session is not there
/// or cannot be read whole.
public func claudeHistory(_ runtime: any MachineRuntime, _ profile: SessionProfile, root: String, session: String)
    async throws -> [String]
{
    let directory = try await claudeProjectDirectory(runtime, profile, try await runtime.realpath(root))
    let path = "\(directory)/\(session).jsonl"
    let text: String
    do {
        text = try await runtime.readTextFile(path, maxBytes: MAX_HISTORY_BYTES + 1)
    } catch let failure as RuntimeFileError where failure.code == "ENOENT" {
        throw ConversationError.notResumable(
            "Claude has no session \(session) in \(root)\(runtime.where): there is no \(path).")
    }
    // The CLI resumes it whatever its size: the conversation goes on, and
    // says that its past is not drawn.
    if text.utf8.count > MAX_HISTORY_BYTES {
        return [
            historyWarning(
                "This session's file is larger than DevHub reads back (\(MAX_HISTORY_BYTES / 1024 / 1024) MiB), so its earlier conversation is not drawn here. The CLI has all of it."
            )
        ]
    }
    return try claudeHistoryLines(session: session, text: text)
}

/// DevHub's own word at the head of a history it could not read whole, as a
/// warning the adapter draws (an `informational` system event).
private func historyWarning(_ content: String) -> String {
    JsonValue.object(
        JsonObject([
            ("type", "devhub_history"),
            (
                "record",
                .object(
                    JsonObject([
                        ("type", "system"), ("subtype", "informational"), ("level", "warning"),
                        ("content", .string(content)),
                    ]))
            ),
        ])
    ).jsonText
}

// MARK: - Codex

private func listCodexSessions(
    _ runtime: any MachineRuntime, _ profile: SessionProfile, cwd: String, scope: SessionScope,
    sourceKinds: [CodexThreadSourceKind]?, limit: Int? = nil
) async throws -> [PastSession] {
    var listParams: [(String, JsonValue)] = []
    if scope == .here { listParams.append(("cwd", .string(cwd))) }
    listParams.append(("limit", .number(Double(limit ?? LISTED))))
    listParams.append(("sortKey", "updated_at"))
    if let sourceKinds { listParams.append(("sourceKinds", .array(sourceKinds.map { .string($0.rawValue) }))) }
    let requests: [JsonValue] = [
        .object(
            JsonObject([
                ("id", 1), ("method", "initialize"),
                ("params", .object(JsonObject([("clientInfo", .object(JsonObject([("name", "devhub"), ("version", "0")])))]))),
            ])),
        .object(JsonObject([("method", "initialized")])),
        .object(JsonObject([("id", 2), ("method", "thread/list"), ("params", .object(JsonObject(listParams)))])),
    ]
    let answer = try await askMachine(runtime, "codex app-server did not list its threads") {
        ExecRequest(
            // A resumed Agent's snapshot ends with the thread it resumed,
            // which app-server takes no argument for.
            argv: ["sh", "-c", ResumeScripts.codexListing, "sh", profile.command] + codexStructuredArgs(profile.args).args,
            env: try await runtime.environment().merging(profile.env) { _, profile in profile },
            stdin: Data(requests.map { "\($0.jsonText)\n" }.joined().utf8),
            deadline: .within(30_000), cancel: CancellationToken(),
            limits: MachineExecLimits(
                stdoutBytes: 16 * 1024 * 1024, stderrBytes: 16 * 1024,
                overflow: .fail({ AdapterRefusal("codex's thread list was longer than expected") })))
    }
    return try parseCodexListing(answer.stdoutText, stderr: answer.stderrText)
}

/// app-server's lines, as sessions.
public func parseCodexListing(_ stdout: String, stderr: String) throws -> [PastSession] {
    let reader = CodexReader(version: nil)
    for line in stdout.components(separatedBy: "\n") {
        if JSString.trim(line).isEmpty { continue }
        switch try codexDecodeLine(reader, line) {
        case .error(let id, let code, let message, _) where id == .number(1) || id == .number(2):
            throw ConversationError.sessionsUnreadable(
                "codex did not list its threads: \(message) (\(JsonValue.javaScriptNumber(code)))")
        case .response(.number(2), let result):
            let branches = try threadBranches(reader, result)
            return try codexThreadListResponse(reader, result).map { thread in
                PastSession(
                    id: thread.id, title: oneLine(thread.name ?? thread.preview), updatedAt: thread.updatedAt * 1000,
                    cwd: thread.cwd, branch: branches[thread.id], resumableHere: true)
            }
        default:
            continue
        }
    }
    let said = JSString.trim(stderr).components(separatedBy: "\n").last.map(JSString.trim) ?? ""
    throw ConversationError.sessionsUnreadable(
        "codex app-server ended without listing its threads\(said.isEmpty ? "." : ": \(said)")")
}

/// The branch each listed thread was on, by id: `gitInfo.branch`, which Codex
/// leaves null (or the whole `gitInfo`) outside a repository.
private func threadBranches(_ reader: CodexReader, _ result: JsonValue?) throws -> [String: String] {
    var branches: [String: String] = [:]
    let listed = try reader.fields(result, "result")
    _ = try reader.array(listed, "data", "result") { each, at in
        let thread = try reader.fields(each, at)
        guard let git = thread["gitInfo"], git != .null else { return }
        if let branch = try reader.nullableString(try reader.fields(git, "\(at).gitInfo"), "branch", "\(at).gitInfo") {
            branches[try reader.string(thread, "id", at)] = branch
        }
    }
    return branches
}
