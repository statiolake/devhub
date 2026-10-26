// Port of `claudeHistoryLines` and its helpers in
// apps/desktop/src/main/agent/conversation/resume.ts (the Claude session
// file read back as the adapter's `devhub_history` lines). The rest of
// resume.ts — listing sessions, previews, Codex — is WP6's; this part is
// here because the Claude adapter reads what it makes, and its tests do too.

import Foundation

/// A Claude session file (`~/.claude/projects/<dir>/<session>.jsonl`), as the
/// lines the adapter draws its past from: the main chain of the conversation
/// as the CLI resumes it, from its first record to its last, each as a
/// `devhub_history` line — a message (with the tool's own account of its
/// result, `tool_use_result`, so a call that only started its task in the
/// background reads as one), a system event the session file kept (the
/// adapter decides which it draws, as it does live), a message the person
/// queued mid-turn, and a file the person attached or that changed outside
/// the conversation. The other attachments are the CLI's notes to the model
/// (reminders, listings, the environment), which nothing live shows either.
public func claudeHistoryLines(session: String, text: String) throws -> [String] {
    let records = try text.components(separatedBy: "\n")
        .filter { !JSString.trim($0).isEmpty }
        .map { try parsedLine(session, $0) }
    // Where each uuid is written. Claude writes some records again under the
    // same uuid (an attachment carried across a compaction), so a uuid can
    // name more than one line.
    var byUuid: [String: [Int]] = [:]
    for (position, record) in records.enumerated() {
        if case .string(let uuid)? = record["uuid"] { byUuid[uuid, default: []].append(position) }
    }
    func isMessage(_ record: JsonObject) -> Bool {
        (record["type"] == "user" || record["type"] == "assistant") && record["isSidechain"] != .bool(true)
    }
    var chain: [JsonObject] = []
    var visited = Set<Int>()
    // The conversation as it stood when line `position` was written: the
    // last record of the main chain above it (not a subagent's) that the
    // walk has not drawn yet. The whole file's conversation is the one
    // standing below its last line.
    func standingAbove(_ position: Int) -> Int? {
        var at = position - 1
        while at >= 0 {
            let record = records[at]
            if case .string? = record["uuid"], record["isSidechain"] != .bool(true), !visited.contains(at) { return at }
            at -= 1
        }
        return nil
    }
    // Each record goes on at its parent (`parentUuid`, else a compaction
    // boundary's `logicalParentUuid`). Of the lines a parent uuid names, the
    // chain takes the last one above the record, as Claude writes some
    // records twice under one uuid; a parent written only after its child is
    // still its parent (the CLI finds a record by its uuid), so the last line
    // with that uuid then. When the parent names no record the walk has not
    // yet drawn — none at all, or one of the conversation after the record,
    // as a boundary's logical parent can be a reminder Claude wrote only
    // after the summary, under it — the record goes on at the conversation
    // standing above it in the file. The walk never draws a line twice, and
    // every session the CLI resumes is drawn back to its first record.
    var next = standingAbove(records.count)
    while let at = next {
        let record = records[at]
        visited.insert(at)
        chain.append(record)
        // `parentUuid ?? logicalParentUuid`: a null parent falls back too.
        let parentValue: JsonValue? =
            record["parentUuid"] == nil || record["parentUuid"] == .null
            ? record["logicalParentUuid"] : record["parentUuid"]
        let written = parentValue?.stringValue.flatMap { byUuid[$0] }
        let named = written.map { written in written.reversed().first { $0 < at } ?? written.last! }
        next = named == nil || visited.contains(named!) ? standingAbove(at) : named
    }
    func history(_ fields: JsonObject) -> String {
        json(["type": "devhub_history", "record": .object(fields)])
    }
    return chain.reversed().flatMap { record -> [String] in
        if record["isSidechain"] == .bool(true) { return [] }
        if record["type"] == "system" { return [history(systemEvent(record))] }
        let attachment = record["attachment"]?.objectValue
        if record["type"] == "attachment", attachment?["type"] == "file" || attachment?["type"] == "edited_text_file" {
            return [history(["type": "attachment", "attachment": .object(attachment!)])]
        }
        // A message the person wrote while a turn ran, which the CLI took in
        // as it went: the person's words, like any other message of theirs.
        if record["type"] == "attachment", attachment?["type"] == "queued_command", taskNotification(record) == nil {
            var fields: JsonObject = ["type": "user"]
            fields["uuid"] = record["uuid"]
            var message: JsonObject = ["role": "user"]
            message["content"] = attachment?["prompt"]
            fields["message"] = .object(message)
            return [history(fields)]
        }
        // A background task's end, which Claude records as a user message it
        // adds, or as a queued command it took in mid-turn.
        if let notification = taskNotification(record) {
            var fields: JsonObject = ["type": "user"]
            fields["uuid"] = record["uuid"]
            fields["message"] = ["role": "user", "content": .string(notification)]
            return [history(fields)]
        }
        if !isMessage(record) || record["isMeta"] == .bool(true) || record["isCompactSummary"] == .bool(true) {
            return []
        }
        var fields: JsonObject = [:]
        fields["type"] = record["type"]
        fields["uuid"] = record["uuid"]
        fields["message"] = record["message"]
        // Whether a call only started its task in the background, in the
        // field stream-json prints it in.
        if let result = record["toolUseResult"] { fields["tool_use_result"] = result }
        return [history(fields)]
    }
}

private func json(_ value: JsonValue) -> String { value.jsonText }

private func parsedLine(_ id: String, _ line: String) throws -> JsonObject {
    if case .object(let object)? = try? JsonValue.parse(line) { return object }
    throw ConversationError.notResumable("Claude's session \(id) has a line that is not a JSON object")
}

/// A session file's system record, in the shape stream-json prints the same
/// event: the compaction's metadata under the name and keys the wire uses.
private func systemEvent(_ record: JsonObject) -> JsonObject {
    var rest = record
    let compactMetadata = rest["compactMetadata"]
    rest["compactMetadata"] = nil
    guard let compactMetadata, compactMetadata != .null else { return rest }
    var metadata: JsonObject = [:]
    metadata["trigger"] = compactMetadata["trigger"]
    metadata["pre_tokens"] = compactMetadata["preTokens"]
    rest["compact_metadata"] = .object(metadata)
    return rest
}

/// The `<task-notification>` a top-level record of a session file carries, if it carries one.
private func taskNotification(_ record: JsonObject) -> String? {
    if record["isSidechain"] == .bool(true) { return nil }
    let content: JsonValue?
    if record["type"] == "user" {
        content = record["message"]?["content"]
    } else if record["type"] == "attachment", record["attachment"]?["type"] == "queued_command" {
        content = record["attachment"]?["prompt"]
    } else {
        content = nil
    }
    let text: String?
    switch content {
    case .string(let words)?: text = words
    case .array(let blocks)?:
        text = blocks.compactMap { block -> String? in
            guard block["type"] == "text", case .string(let words)? = block["text"] else { return nil }
            return words
        }.joined(separator: "\n")
    default: text = nil
    }
    guard let text, isTaskNotificationText(text) else { return nil }
    return text
}
