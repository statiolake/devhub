// Port of apps/desktop/src/main/agent/conversation/codex/decode.ts
//
// What `codex app-server` prints, read into the shapes the adapter uses.
//
// The wire is JSON-RPC 2.0, one message per line (app-server leaves out the
// `"jsonrpc"` member). A line is one of four things: a response to a request
// DevHub made, an error response to one, a notification, or a request the
// server makes of DevHub (an approval, a question).
//
// Every reader here checks only the fields the adapter reads, each named as
// the vendored upstream type names it (`CodexProtocol.swift`). A field that
// is absent and a field that is `null` read the same: the server omits some
// nullable fields and sends others as `null`, and nothing here tells the two
// apart.
//
// A message that does not have the shape its reader expects throws the
// shared `ProtocolMismatch`, naming the path that did not fit and the CLI's
// version (which is why every reader takes the `CodexReader` that knows it).
// That is the CLI saying something DevHub believed it would never say, so
// nothing here recovers from it: the loop that feeds lines in turns it into a
// broken conversation at its one root.

import Foundation

/// Reads fields of one message, failing with that message's path and the CLI's version.
public struct CodexReader: SchemaReader, Sendable {
    /// The CLI's version, once the handshake has said it.
    public let version: String?

    public init(version: String?) { self.version = version }

    public func fail(_ path: String, _ expected: String) -> ProtocolMismatch {
        ProtocolMismatch(path: path, expected: expected, agentVersion: version)
    }

    func mismatch(_ path: String, _ expected: String, _ value: JsonValue?) -> ProtocolMismatch {
        fail(path, "\(expected), got \(codexDescribe(value))")
    }

    public func fields(_ value: JsonValue?, _ path: String) throws -> JsonObject {
        guard case .object(let object)? = value else { throw mismatch(path, "an object", value) }
        return object
    }

    public func string(_ o: JsonObject, _ key: String, _ path: String) throws -> String {
        guard case .string(let text)? = o[key] else { throw mismatch("\(path).\(key)", "a string", o[key]) }
        return text
    }

    public func nullableString(_ o: JsonObject, _ key: String, _ path: String) throws -> String? {
        guard let value = o[key], value != .null else { return nil }
        guard case .string(let text) = value else { throw mismatch("\(path).\(key)", "a string or null", value) }
        return text
    }

    public func number(_ o: JsonObject, _ key: String, _ path: String) throws -> Double {
        guard case .number(let number)? = o[key] else { throw mismatch("\(path).\(key)", "a number", o[key]) }
        return number
    }

    public func nullableNumber(_ o: JsonObject, _ key: String, _ path: String) throws -> Double? {
        guard let value = o[key], value != .null else { return nil }
        guard case .number(let number) = value else { throw mismatch("\(path).\(key)", "a number or null", value) }
        return number
    }

    public func boolean(_ o: JsonObject, _ key: String, _ path: String) throws -> Bool {
        guard case .bool(let flag)? = o[key] else { throw mismatch("\(path).\(key)", "a boolean", o[key]) }
        return flag
    }

    public func nullableBoolean(_ o: JsonObject, _ key: String, _ path: String) throws -> Bool? {
        guard let value = o[key], value != .null else { return nil }
        guard case .bool(let flag) = value else { throw mismatch("\(path).\(key)", "a boolean or null", value) }
        return flag
    }

    public func oneOf(_ o: JsonObject, _ key: String, _ path: String, _ values: [String]) throws -> String {
        if case .string(let value)? = o[key], values.contains(value) { return value }
        throw mismatch("\(path).\(key)", "one of \(values.joined(separator: " | "))", o[key])
    }

    public func array<T>(_ o: JsonObject, _ key: String, _ path: String, _ each: (JsonValue, String) throws -> T) throws
        -> [T]
    {
        guard case .array(let items)? = o[key] else { throw mismatch("\(path).\(key)", "an array", o[key]) }
        return try items.enumerated().map { index, item in try each(item, "\(path).\(key)[\(index)]") }
    }

    public func nullableArray<T>(
        _ o: JsonObject, _ key: String, _ path: String, _ each: (JsonValue, String) throws -> T
    ) throws -> [T]? {
        guard let value = o[key], value != .null else { return nil }
        return try array(o, key, path, each)
    }

    public func stringItem(_ value: JsonValue, _ path: String) throws -> String {
        guard case .string(let text) = value else { throw mismatch(path, "a string", value) }
        return text
    }

    /// Any JSON: what the adapter keeps only to show.
    public func json(_ o: JsonObject, _ key: String) -> JsonValue {
        o[key] ?? .null
    }

    public func rpcId(_ o: JsonObject, _ key: String, _ path: String) throws -> CodexRpcId {
        switch o[key] {
        case .number(let value)?: return .number(value)
        case .string(let text)?: return .string(text)
        default: throw mismatch("\(path).\(key)", "a string or number id", o[key])
        }
    }
}

/// How a value reads in a mismatch, as `typeof` names it.
func codexDescribe(_ value: JsonValue?) -> String {
    switch value {
    case nil: return "a undefined"
    case .null?: return "null"
    case .array?: return "an array"
    case .bool?: return "a boolean"
    case .number?: return "a number"
    case .string?: return "a string"
    case .object?: return "a object"
    }
}

/// A JSON-RPC id, as app-server writes it (`RequestId`).
public enum CodexRpcId: Hashable, Sendable, CustomStringConvertible {
    case number(Double)
    case string(String)

    public var json: JsonValue {
        switch self {
        case .number(let value): return .number(value)
        case .string(let text): return .string(text)
        }
    }

    /// `JSON.stringify(id)`: the key a request is filed under.
    public var key: String { json.jsonText }

    public var description: String {
        switch self {
        case .number(let value): return JsonValue.javaScriptNumber(value)
        case .string(let text): return text
        }
    }
}

// MARK: - The envelope

public enum CodexMessage: Equatable, Sendable {
    case response(id: CodexRpcId, result: JsonValue?)
    case error(id: CodexRpcId?, code: Double, message: String, data: JsonValue)
    case notification(method: String, params: JsonValue?)
    case request(id: CodexRpcId, method: String, params: JsonValue?)
    /// The host stopped app-server and started it again (Restart session),
    /// and put this line (`RESTART_MARK`) between the two servers' output —
    /// not something app-server printed.
    case restart
}

/// One line off app-server's stdout.
public func codexDecodeLine(_ r: CodexReader, _ line: String) throws -> CodexMessage {
    let value: JsonValue
    do {
        value = try JsonValue.parse(line)
    } catch {
        throw r.fail("line", "JSON, got \(jsSlice(line, 200)) (\(jsonSyntaxMessage(error)))")
    }
    let o = try r.fields(value, "message")
    if o["type"] == .string("devhub_restart") { return .restart }
    if o["method"] != nil {
        let method = try r.string(o, "method", "message")
        let params = o["params"]
        if o["id"] != nil { return .request(id: try r.rpcId(o, "id", "message"), method: method, params: params) }
        return .notification(method: method, params: params)
    }
    if o["error"] != nil {
        let error = try r.fields(o["error"], "message.error")
        let id: CodexRpcId? = o["id"] == .null ? nil : try r.rpcId(o, "id", "message")
        return .error(
            id: id, code: try r.number(error, "code", "message.error"),
            message: try r.string(error, "message", "message.error"), data: r.json(error, "data"))
    }
    if o["result"] != nil {
        return .response(id: try r.rpcId(o, "id", "message"), result: o["result"])
    }
    throw r.fail("message", "a request, notification or response, got \(jsSlice(line, 200))")
}

/// `text.slice(0, count)`, by UTF-16 code units as JavaScript counts.
func jsSlice(_ text: String, _ count: Int) -> String {
    let units = Array(text.utf16)
    if units.count <= count { return text }
    return String(decoding: units[0..<count], as: UTF16.self)
}

private func jsonSyntaxMessage(_ error: Error) -> String {
    if let syntax = error as? JsonSyntaxError { return syntax.description }
    return "\(error)"
}

// MARK: - Responses to DevHub's requests

public func codexInitializeResponse(_ r: CodexReader, _ value: JsonValue?) throws -> String {
    let o = try r.fields(value, "result")
    return try r.string(o, "userAgent", "result")
}

public struct CodexAccountReading: Equatable, Sendable {
    /// The kind of sign-in (`Account["type"]`), or nil when there is none.
    /// A string rather than the vendored union: a kind a newer Codex adds is
    /// still a sign-in, and only the usage reader asks which one it is.
    public var account: String?
    public var requiresOpenaiAuth: Bool
}

public func codexAccountResponse(_ r: CodexReader, _ value: JsonValue?) throws -> CodexAccountReading {
    let o = try r.fields(value, "result")
    let account: String?
    if let raw = o["account"], raw != .null {
        account = try r.string(try r.fields(raw, "result.account"), "type", "result.account")
    } else {
        account = nil
    }
    return CodexAccountReading(account: account, requiresOpenaiAuth: try r.boolean(o, "requiresOpenaiAuth", "result"))
}

public enum CodexHistoryMode: String, Sendable, Equatable {
    case legacy, paginated
}

public struct CodexThreadFacts: Equatable, Sendable {
    public var id: String
    public var parentThreadId: String?
    public var agentNickname: String?
    public var historyMode: CodexHistoryMode
    public var turns: [CodexTurnFacts]
    /// Whether the person may start or steer this thread's turns themselves:
    /// `canAcceptDirectInput`, which app-server prints (0.156.1 does) though
    /// its pinned schema does not list it. Absent is no: nothing says yes.
    public var takesDirectInput: Bool
}

func codexThread(_ r: CodexReader, _ value: JsonValue?, _ path: String) throws -> CodexThreadFacts {
    let o = try r.fields(value, path)
    return CodexThreadFacts(
        id: try r.string(o, "id", path),
        parentThreadId: try r.nullableString(o, "parentThreadId", path),
        agentNickname: try r.nullableString(o, "agentNickname", path),
        historyMode: CodexHistoryMode(rawValue: try r.oneOf(o, "historyMode", path, ["legacy", "paginated"]))!,
        turns: try r.nullableArray(o, "turns", path) { value, at in try codexTurn(r, value, at) } ?? [],
        takesDirectInput: try r.nullableBoolean(o, "canAcceptDirectInput", path) == true)
}

public struct CodexThreadOpened: Equatable, Sendable {
    public var thread: CodexThreadFacts
    public var model: String
    public var cwd: String
    public var reasoningEffort: String?
    public var approvalPolicy: JsonValue
    public var sandbox: JsonValue
}

/// `thread/start` and `thread/resume` answer with the same facts.
public func codexThreadOpenedResponse(_ r: CodexReader, _ value: JsonValue?) throws -> CodexThreadOpened {
    let o = try r.fields(value, "result")
    return CodexThreadOpened(
        thread: try codexThread(r, o["thread"], "result.thread"),
        model: try r.string(o, "model", "result"),
        cwd: try r.string(o, "cwd", "result"),
        reasoningEffort: try r.nullableString(o, "reasoningEffort", "result"),
        approvalPolicy: r.json(o, "approvalPolicy"),
        sandbox: r.json(o, "sandbox"))
}

/// One earlier thread, as `thread/list` names it: what the resume picker shows.
public struct CodexListedThread: Equatable, Sendable {
    public var id: String
    public var preview: String
    public var name: String?
    public var updatedAt: Double
    public var cwd: String
}

/// `thread/list`'s page of threads, newest first as asked.
public func codexThreadListResponse(_ r: CodexReader, _ value: JsonValue?) throws -> [CodexListedThread] {
    let o = try r.fields(value, "result")
    return try r.array(o, "data", "result") { each, at in
        let t = try r.fields(each, at)
        return CodexListedThread(
            id: try r.string(t, "id", at), preview: try r.string(t, "preview", at),
            name: try r.nullableString(t, "name", at), updatedAt: try r.number(t, "updatedAt", at),
            cwd: try r.string(t, "cwd", at))
    }
}

/// A model `model/list` names, by `model`: the name a thread opens with and
/// a turn is given (`ThreadStartResponse.model`, `TurnStartParams.model`).
public struct CodexModelChoice: Equatable, Sendable {
    public var model: String
    public var displayName: String
    public var hidden: Bool
    /// Whether Codex starts a thread on this model when config.toml names none.
    public var isDefault: Bool
    public var efforts: [String]
    /// The effort a turn on this model runs at when none is given.
    public var defaultEffort: String
}

/// One page of `model/list`, and where the next one starts, if there is one.
public func codexModelListResponse(_ r: CodexReader, _ value: JsonValue?) throws -> (
    models: [CodexModelChoice], next: String?
) {
    let o = try r.fields(value, "result")
    let models = try r.array(o, "data", "result") { item, path in
        let m = try r.fields(item, path)
        return CodexModelChoice(
            model: try r.string(m, "model", path),
            displayName: try r.string(m, "displayName", path),
            hidden: try r.boolean(m, "hidden", path),
            isDefault: try r.boolean(m, "isDefault", path),
            efforts: try r.array(m, "supportedReasoningEfforts", path) { option, at in
                try r.string(try r.fields(option, at), "reasoningEffort", at)
            },
            defaultEffort: try r.string(m, "defaultReasoningEffort", path))
    }
    return (models, try r.nullableString(o, "nextCursor", "result"))
}

/// One MCP server as `mcpServerStatus/list` names it: the fields the panel
/// reads, with the statuses kept as Codex's words, so a word a later Codex
/// adds is shown rather than refused.
public struct CodexMcpServer: Equatable, Sendable {
    public var name: String
    /// `runtimeStatus`: nil when Codex has no connection state for it.
    public var runtimeStatus: String?
    /// `authStatus`: `unsupported`, `notLoggedIn`, `bearerToken`, `oAuth`…
    public var authStatus: String
    public var pluginId: String?
    /// `toolsError`: why listing its tools failed.
    public var toolsError: String?
}

/// One page of `mcpServerStatus/list`, and the cursor of the next.
public func codexMcpServerStatusListResponse(_ r: CodexReader, _ value: JsonValue?) throws -> (
    servers: [CodexMcpServer], next: String?
) {
    let o = try r.fields(value, "result")
    let servers = try r.array(o, "data", "result") { item, path in
        let m = try r.fields(item, path)
        return CodexMcpServer(
            name: try r.string(m, "name", path),
            runtimeStatus: try r.nullableString(m, "runtimeStatus", path),
            authStatus: try r.string(m, "authStatus", path),
            pluginId: try r.nullableString(m, "pluginId", path),
            toolsError: try r.nullableString(m, "toolsError", path))
    }
    return (servers, try r.nullableString(o, "nextCursor", "result"))
}

/// A skill `skills/list` names, as the composer offers it after `$` and a
/// turn is given it (`UserInput`'s `skill`, by name and the path of its SKILL.md).
public struct CodexSkillChoice: Equatable, Sendable {
    public var name: String
    public var description: String
    public var path: String
}

/// The enabled skills `skills/list` names for the thread's directory, in its
/// order. The short description is the one a picker shows, where the skill
/// has one (`interface.shortDescription`, else the legacy
/// `shortDescription`); otherwise its description.
public func codexSkillsListResponse(_ r: CodexReader, _ value: JsonValue?) throws -> [CodexSkillChoice] {
    let o = try r.fields(value, "result")
    let entries = try r.array(o, "data", "result") { entry, path in
        try r.array(try r.fields(entry, path), "skills", path) { skill, at -> (Bool, CodexSkillChoice) in
            let s = try r.fields(skill, at)
            let face = s["interface"] == nil ? nil : try r.fields(s["interface"], "\(at).interface")
            let enabled = try r.boolean(s, "enabled", at)
            let name = try r.string(s, "name", at)
            let description: String
            if let short = try face.flatMap({ try r.nullableString($0, "shortDescription", "\(at).interface") }) {
                description = short
            } else if let short = try r.nullableString(s, "shortDescription", at) {
                description = short
            } else {
                description = try r.string(s, "description", at)
            }
            return (enabled, CodexSkillChoice(name: name, description: description, path: try r.string(s, "path", at)))
        }
    }
    return entries.flatMap { $0 }.compactMap { $0.0 ? $0.1 : nil }
}

/// A response whose content DevHub does not read still has to be an object.
public func codexAnyObjectResponse(_ r: CodexReader, _ value: JsonValue?) throws {
    _ = try r.fields(value, "result")
}

/// The turn a message went to, as `turn/start` (`TurnStartResponse`, the
/// turn it started) or `turn/steer` (`TurnSteerResponse`, the turn it
/// joined) answers: the turn whose `turn/completed` answers the message.
public func codexMessageTurn(_ r: CodexReader, steer: Bool, _ value: JsonValue?) throws -> String {
    let o = try r.fields(value, "result")
    return steer
        ? try r.string(o, "turnId", "result")
        : try r.string(try r.fields(o["turn"], "result.turn"), "id", "result.turn")
}

/// `thread/revert`'s answer. What it took back is the request's to say; the thread is only checked.
public func codexThreadRevertResponse(_ r: CodexReader, _ value: JsonValue?) throws {
    let o = try r.fields(value, "result")
    _ = try r.string(try r.fields(o["thread"], "result.thread"), "id", "result.thread")
}

// MARK: - Turns and items

public enum CodexTurnStatus: String, Sendable, Equatable {
    case completed, interrupted, failed, inProgress
}

public struct CodexTurnFacts: Equatable, Sendable {
    public var id: String
    public var status: CodexTurnStatus
    public var durationMs: Double?
    public var items: [CodexItem]
    public var error: String?
    /// The turn's error is the plan's usage limit (`codexErrorInfo`
    /// `usageLimitExceeded`): the turn stopped because the limit was reached.
    public var usageLimited: Bool
    /// The turn's error is the provider refusing the sign-in
    /// (`codexErrorInfo` `unauthorized`): no turn gets past it until the
    /// person signs in again.
    public var unauthorized: Bool
}

/// The `codexErrorInfo` of a turn the provider refused as unauthenticated.
private let UNAUTHORIZED = CodexErrorInfo.unauthorized.rawValue
/// The `codexErrorInfo` of a turn stopped by the plan's usage limit.
private let USAGE_LIMIT_EXCEEDED = CodexErrorInfo.usageLimitExceeded.rawValue

func codexTurn(_ r: CodexReader, _ value: JsonValue?, _ path: String) throws -> CodexTurnFacts {
    let o = try r.fields(value, path)
    var message: String?
    var usageLimited = false
    var unauthorized = false
    if let error = o["error"], error != .null {
        let e = try r.fields(error, "\(path).error")
        let details = try r.nullableString(e, "additionalDetails", "\(path).error")
        message = try r.string(e, "message", "\(path).error")
        if let details { message = "\(message!)\n\(details)" }
        // A kind in a word, or a kind with its HTTP status as an object: only
        // the one word is read.
        let info = e["codexErrorInfo"]
        switch info {
        case nil, .null?, .string?, .object?: break
        default:
            throw r.fail("\(path).error.codexErrorInfo", "a string, an object or null, got \(codexDescribe(info))")
        }
        usageLimited = info == .string(USAGE_LIMIT_EXCEEDED)
        unauthorized = info == .string(UNAUTHORIZED)
    }
    return CodexTurnFacts(
        id: try r.string(o, "id", path),
        status: CodexTurnStatus(rawValue: try r.oneOf(o, "status", path, ["completed", "interrupted", "failed", "inProgress"]))!,
        durationMs: try r.nullableNumber(o, "durationMs", path),
        items: try r.array(o, "items", path) { value, at in try codexItem(r, value, at) },
        error: message, usageLimited: usageLimited, unauthorized: unauthorized)
}

public func codexTurnNotification(_ r: CodexReader, _ params: JsonValue?) throws -> (threadId: String, turn: CodexTurnFacts)
{
    let o = try r.fields(params, "params")
    return (try r.string(o, "threadId", "params"), try codexTurn(r, o["turn"], "params.turn"))
}

private let COMMAND_STATUSES = ["inProgress", "completed", "failed", "declined"]
private let TOOL_CALL_STATUSES = ["inProgress", "completed", "failed"]
private let COLLAB_STATUSES = ["inProgress", "completed", "failed", "interrupted"]
private let COLLAB_TOOLS = CodexCollabAgentTool.allCases.map(\.rawValue)
private let COLLAB_AGENT_STATUSES = CodexCollabAgentStatus.allCases.map(\.rawValue)
private let SUBAGENT_ACTIVITY = ["started", "interacted", "interrupted", "completed"]

public enum CodexUserMessageInput: Equatable, Sendable {
    case text(String)
    case image(ImageRef)
    case other(label: String)
}

/// `inProgress`, `completed`, `failed`, `declined` (`CommandExecutionStatus`, `PatchApplyStatus`).
public enum CodexCallStatus: String, Sendable, Equatable {
    case inProgress, completed, failed, declined, interrupted
}

public enum CodexFileChangeKind: String, Sendable, Equatable {
    case add, delete, update
}

public struct CodexFileChange: Equatable, Sendable {
    public var path: String
    public var diff: String
    public var kind: CodexFileChangeKind
}

public enum CodexSubagentActivityKind: String, Sendable, Equatable {
    case started, interacted, interrupted, completed
}

/// The items the adapter draws, each as the fields it reads. Every other
/// item type the protocol names comes back as `other` with the item whole,
/// and one the protocol does not name as `unknown`: the adapter shows both,
/// but only the second is a surprise.
public enum CodexItem: Equatable, Sendable {
    case userMessage(id: String, clientId: String?, content: [CodexUserMessageInput])
    case agentMessage(id: String, text: String)
    case plan(id: String, text: String)
    case reasoning(id: String, summary: [String], content: [String])
    case commandExecution(
        id: String, command: String, cwd: String, status: CodexCallStatus, aggregatedOutput: String?, exitCode: Double?)
    case fileChange(id: String, status: CodexCallStatus, changes: [CodexFileChange])
    /// `arguments`, `result`: kept only to show.
    case mcpToolCall(
        id: String, server: String, tool: String, status: CodexCallStatus, arguments: JsonValue, result: JsonValue,
        error: String?)
    case dynamicToolCall(
        id: String, namespace: String?, tool: String, status: CodexCallStatus, arguments: JsonValue, output: [String])
    case collabAgentToolCall(
        id: String, tool: CodexCollabAgentTool, status: CodexCallStatus, receiverThreadIds: [String], prompt: String?,
        model: String?, agentsStates: [CodexAgentState])
    case subAgentActivity(id: String, kind: CodexSubagentActivityKind, agentThreadId: String, agentPath: String)
    case webSearch(id: String, query: String, results: JsonValue)
    case imageView(id: String, path: String)
    case enteredReviewMode(id: String, review: String)
    case exitedReviewMode(id: String, review: String)
    case contextCompaction(id: String)
    case other(itemType: CodexThreadItemType, id: String, raw: JsonValue)
    case unknown(itemType: String, id: String, raw: JsonValue)

    public var id: String {
        switch self {
        case .userMessage(let id, _, _), .agentMessage(let id, _), .plan(let id, _), .reasoning(let id, _, _),
            .commandExecution(let id, _, _, _, _, _), .fileChange(let id, _, _), .mcpToolCall(let id, _, _, _, _, _, _),
            .dynamicToolCall(let id, _, _, _, _, _), .collabAgentToolCall(let id, _, _, _, _, _, _),
            .subAgentActivity(let id, _, _, _), .webSearch(let id, _, _), .imageView(let id, _),
            .enteredReviewMode(let id, _), .exitedReviewMode(let id, _), .contextCompaction(let id),
            .other(_, let id, _), .unknown(_, let id, _):
            return id
        }
    }
}

/// One agent a collab call reports on, in the order the call names them.
public struct CodexAgentState: Equatable, Sendable {
    public var thread: String
    public var status: CodexCollabAgentStatus
}

private func codexFileChange(_ r: CodexReader, _ value: JsonValue, _ path: String) throws -> CodexFileChange {
    let o = try r.fields(value, path)
    return CodexFileChange(
        path: try r.string(o, "path", path), diff: try r.string(o, "diff", path),
        kind: CodexFileChangeKind(
            rawValue: try r.oneOf(try r.fields(o["kind"], "\(path).kind"), "type", "\(path).kind", ["add", "delete", "update"]))!)
}

/// The media type of a `data:` URL, else any image.
func dataUrlMediaType(_ url: String) -> String {
    guard url.hasPrefix("data:") else { return "image/*" }
    let rest = url.dropFirst(5)
    let type = rest.prefix { $0 != ";" && $0 != "," }
    return type.isEmpty ? "image/*" : String(type)
}

private func codexUserInput(_ r: CodexReader, _ value: JsonValue, _ path: String) throws -> CodexUserMessageInput {
    let o = try r.fields(value, path)
    let type = try r.string(o, "type", path)
    switch type {
    case "text":
        return .text(try r.string(o, "text", path))
    case "image":
        guard let url = try r.nullableString(o, "url", path) else {
            // An image the OpenAI file store holds: named, not drawable here.
            let file = try r.string(o, "fileId", path)
            return .image(ImageRef(mediaType: "image/*", source: .file(path: file), label: file))
        }
        return .image(
            ImageRef(mediaType: dataUrlMediaType(url), source: .url(url), label: url.hasPrefix("data:") ? "image" : url))
    case "localImage":
        let file = try r.string(o, "path", path)
        return .image(ImageRef(mediaType: "image/*", source: .file(path: file), label: file))
    default:
        return .other(label: try r.nullableString(o, "name", path) ?? r.nullableString(o, "path", path) ?? type)
    }
}

public func codexItem(_ r: CodexReader, _ value: JsonValue?, _ path: String) throws -> CodexItem {
    let o = try r.fields(value, path)
    let type = try r.string(o, "type", path)
    let id = try r.string(o, "id", path)
    func status(_ values: [String]) throws -> CodexCallStatus {
        CodexCallStatus(rawValue: try r.oneOf(o, "status", path, values))!
    }
    switch type {
    case "userMessage":
        return .userMessage(
            id: id, clientId: try r.nullableString(o, "clientId", path),
            content: try r.array(o, "content", path) { value, at in try codexUserInput(r, value, at) })
    case "agentMessage":
        return .agentMessage(id: id, text: try r.string(o, "text", path))
    case "plan":
        return .plan(id: id, text: try r.string(o, "text", path))
    case "reasoning":
        return .reasoning(
            id: id, summary: try r.array(o, "summary", path, r.stringItem),
            content: try r.array(o, "content", path, r.stringItem))
    case "commandExecution":
        return .commandExecution(
            id: id, command: try r.string(o, "command", path), cwd: try r.string(o, "cwd", path),
            status: try status(COMMAND_STATUSES),
            aggregatedOutput: try r.nullableString(o, "aggregatedOutput", path),
            exitCode: try r.nullableNumber(o, "exitCode", path))
    case "fileChange":
        return .fileChange(
            id: id, status: try status(COMMAND_STATUSES),
            changes: try r.array(o, "changes", path) { value, at in try codexFileChange(r, value, at) })
    case "mcpToolCall":
        let server = try r.string(o, "server", path)
        let tool = try r.string(o, "tool", path)
        let callStatus = try status(TOOL_CALL_STATUSES)
        let error: String?
        if let raw = o["error"], raw != .null {
            error = try r.string(try r.fields(raw, "\(path).error"), "message", "\(path).error")
        } else {
            error = nil
        }
        return .mcpToolCall(
            id: id, server: server, tool: tool, status: callStatus, arguments: r.json(o, "arguments"),
            result: r.json(o, "result"), error: error)
    case "dynamicToolCall":
        let namespace = try r.nullableString(o, "namespace", path)
        let tool = try r.string(o, "tool", path)
        let callStatus = try status(TOOL_CALL_STATUSES)
        let output =
            try r.nullableArray(o, "contentItems", path) { content, at -> String? in
                let c = try r.fields(content, at)
                return try r.string(c, "type", at) == "inputText" ? try r.string(c, "text", at) : nil
            } ?? []
        return .dynamicToolCall(
            id: id, namespace: namespace, tool: tool, status: callStatus, arguments: r.json(o, "arguments"),
            output: output.compactMap { $0 })
    case "collabAgentToolCall":
        let states = try r.fields(o["agentsStates"], "\(path).agentsStates")
        var agentsStates: [CodexAgentState] = []
        for (threadId, state) in states {
            let at = "\(path).agentsStates.\(threadId)"
            agentsStates.append(
                CodexAgentState(
                    thread: threadId,
                    status: CodexCollabAgentStatus(rawValue: try r.oneOf(try r.fields(state, at), "status", at, COLLAB_AGENT_STATUSES))!))
        }
        return .collabAgentToolCall(
            id: id, tool: CodexCollabAgentTool(rawValue: try r.oneOf(o, "tool", path, COLLAB_TOOLS))!,
            status: try status(COLLAB_STATUSES),
            receiverThreadIds: try r.array(o, "receiverThreadIds", path, r.stringItem),
            prompt: try r.nullableString(o, "prompt", path), model: try r.nullableString(o, "model", path),
            agentsStates: agentsStates)
    case "subAgentActivity":
        return .subAgentActivity(
            id: id, kind: CodexSubagentActivityKind(rawValue: try r.oneOf(o, "kind", path, SUBAGENT_ACTIVITY))!,
            agentThreadId: try r.string(o, "agentThreadId", path), agentPath: try r.string(o, "agentPath", path))
    case "webSearch":
        return .webSearch(id: id, query: try r.string(o, "query", path), results: r.json(o, "results"))
    case "imageView":
        return .imageView(id: id, path: try r.string(o, "path", path))
    case "enteredReviewMode":
        return .enteredReviewMode(id: id, review: try r.string(o, "review", path))
    case "exitedReviewMode":
        return .exitedReviewMode(id: id, review: try r.string(o, "review", path))
    case "contextCompaction":
        return .contextCompaction(id: id)
    default:
        if let known = CodexThreadItemType(rawValue: type) {
            // Every type the vendored `ThreadItem` names is placed: those
            // drawn are above, the rest are shown whole.
            precondition(!known.drawn, "the item type \(type) is drawn but has no reader")
            return .other(itemType: known, id: id, raw: value ?? .null)
        }
        return .unknown(itemType: type, id: id, raw: value ?? .null)
    }
}

public struct CodexItemNotification: Equatable, Sendable {
    public var threadId: String
    public var turnId: String
    public var item: CodexItem
    /// When the item started, by app-server's clock (`item/started`'s `startedAtMs`).
    public var startedAtMs: Double?
}

public func codexItemNotification(_ r: CodexReader, _ params: JsonValue?) throws -> CodexItemNotification {
    let o = try r.fields(params, "params")
    return CodexItemNotification(
        threadId: try r.string(o, "threadId", "params"), turnId: try r.string(o, "turnId", "params"),
        item: try codexItem(r, o["item"], "params.item"), startedAtMs: try r.nullableNumber(o, "startedAtMs", "params"))
}

// MARK: - Deltas

public struct CodexTextDelta: Equatable, Sendable {
    public var threadId: String
    public var itemId: String
    public var delta: String
}

/// `item/agentMessage/delta`, `item/plan/delta`, `item/commandExecution/outputDelta`.
public func codexTextDelta(_ r: CodexReader, _ params: JsonValue?) throws -> CodexTextDelta {
    let o = try r.fields(params, "params")
    return CodexTextDelta(
        threadId: try r.string(o, "threadId", "params"), itemId: try r.string(o, "itemId", "params"),
        delta: try r.string(o, "delta", "params"))
}

public struct CodexReasoningDelta: Equatable, Sendable {
    public var threadId: String
    public var itemId: String
    public var delta: String
    /// Which part: the summary part for a summary delta, the content part for a raw one.
    public var index: Int
}

public func codexReasoningSummaryDelta(_ r: CodexReader, _ params: JsonValue?) throws -> CodexReasoningDelta {
    let o = try r.fields(params, "params")
    let index = try r.number(o, "summaryIndex", "params")
    let text = try codexTextDelta(r, params)
    return CodexReasoningDelta(threadId: text.threadId, itemId: text.itemId, delta: text.delta, index: Int(index))
}

public func codexReasoningTextDelta(_ r: CodexReader, _ params: JsonValue?) throws -> CodexReasoningDelta {
    let o = try r.fields(params, "params")
    let index = try r.number(o, "contentIndex", "params")
    let text = try codexTextDelta(r, params)
    return CodexReasoningDelta(threadId: text.threadId, itemId: text.itemId, delta: text.delta, index: Int(index))
}

public func codexSummaryPartAdded(_ r: CodexReader, _ params: JsonValue?) throws -> (
    threadId: String, itemId: String, summaryIndex: Int
) {
    let o = try r.fields(params, "params")
    return (
        try r.string(o, "threadId", "params"), try r.string(o, "itemId", "params"),
        Int(try r.number(o, "summaryIndex", "params"))
    )
}

public func codexPatchUpdated(_ r: CodexReader, _ params: JsonValue?) throws -> (
    threadId: String, itemId: String, changes: [CodexFileChange]
) {
    let o = try r.fields(params, "params")
    return (
        try r.string(o, "threadId", "params"), try r.string(o, "itemId", "params"),
        try r.array(o, "changes", "params") { value, at in try codexFileChange(r, value, at) }
    )
}

// MARK: - Everything else the adapter reads off a notification

public func codexPlanUpdated(_ r: CodexReader, _ params: JsonValue?) throws -> (
    threadId: String, turnId: String, plan: [PlanStep]
) {
    let o = try r.fields(params, "params")
    return (
        try r.string(o, "threadId", "params"), try r.string(o, "turnId", "params"),
        try r.array(o, "plan", "params") { value, path in
            let s = try r.fields(value, path)
            let step = try r.string(s, "step", path)
            let status = try r.oneOf(s, "status", path, ["pending", "inProgress", "completed"])
            return PlanStep(text: step, status: status == "inProgress" ? .inProgress : PlanStatus(rawValue: status)!)
        }
    )
}

public func codexRequestResolved(_ r: CodexReader, _ params: JsonValue?) throws -> (threadId: String, requestId: CodexRpcId)
{
    let o = try r.fields(params, "params")
    return (try r.string(o, "threadId", "params"), try r.rpcId(o, "requestId", "params"))
}

public struct CodexTokens: Equatable, Sendable {
    public var totalTokens: Double
    public var inputTokens: Double
    public var cachedInputTokens: Double
    public var outputTokens: Double
}

public struct CodexTokenUsage: Equatable, Sendable {
    public var threadId: String
    public var turnId: String
    public var total: CodexTokens
    public var last: CodexTokens
    public var modelContextWindow: Double?
}

private func codexTokens(_ r: CodexReader, _ value: JsonValue?, _ path: String) throws -> CodexTokens {
    let o = try r.fields(value, path)
    return CodexTokens(
        totalTokens: try r.number(o, "totalTokens", path), inputTokens: try r.number(o, "inputTokens", path),
        cachedInputTokens: try r.number(o, "cachedInputTokens", path), outputTokens: try r.number(o, "outputTokens", path))
}

public func codexTokenUsage(_ r: CodexReader, _ params: JsonValue?) throws -> CodexTokenUsage {
    let o = try r.fields(params, "params")
    let usage = try r.fields(o["tokenUsage"], "params.tokenUsage")
    return CodexTokenUsage(
        threadId: try r.string(o, "threadId", "params"), turnId: try r.string(o, "turnId", "params"),
        total: try codexTokens(r, usage["total"], "params.tokenUsage.total"),
        last: try codexTokens(r, usage["last"], "params.tokenUsage.last"),
        modelContextWindow: try r.nullableNumber(usage, "modelContextWindow", "params.tokenUsage"))
}

/// The `rateLimits` snapshot of `account/rateLimits/updated`'s params, or —
/// `at` "result" — of `account/rateLimits/read`'s result: the same
/// `RateLimitSnapshot` under the same key. The windows it reports, primary
/// before secondary. A window that is null in a sparse update is left out:
/// "not reported this time", never "cleared".
public func codexRateLimits(_ r: CodexReader, _ params: JsonValue?, at: String = "params") throws -> [RateLimit] {
    let o = try r.fields(params, at)
    let snapshot = try r.fields(o["rateLimits"], "\(at).rateLimits")
    return try ["primary", "secondary"].compactMap { slot in
        guard let value = snapshot[slot], value != .null else { return nil }
        let path = "\(at).rateLimits.\(slot)"
        let w = try r.fields(value, path)
        let minutes = try r.nullableNumber(w, "windowDurationMins", path)
        let resetsAt = try r.nullableNumber(w, "resetsAt", path)
        return RateLimit(
            window: minutes.map(rateLimitWindowName) ?? slot,
            durationMinutes: minutes,
            usedPercent: try r.number(w, "usedPercent", path),
            // Unix seconds on the wire, as Codex's core protocol keeps it.
            resetsAt: resetsAt.map { $0 * 1000 })
    }
}

public func codexErrorNotification(_ r: CodexReader, _ params: JsonValue?) throws -> (
    threadId: String, turnId: String, willRetry: Bool, message: String
) {
    let o = try r.fields(params, "params")
    let error = try r.fields(o["error"], "params.error")
    let details = try r.nullableString(error, "additionalDetails", "params.error")
    let message = try r.string(error, "message", "params.error")
    return (
        try r.string(o, "threadId", "params"), try r.string(o, "turnId", "params"),
        try r.boolean(o, "willRetry", "params"), details.map { "\(message)\n\($0)" } ?? message
    )
}

/// `warning` and `guardianWarning`: a message for the user and nothing else.
public func codexWarning(_ r: CodexReader, _ params: JsonValue?) throws -> (threadId: String?, message: String) {
    let o = try r.fields(params, "params")
    return (try r.nullableString(o, "threadId", "params"), try r.string(o, "message", "params"))
}

/// `deprecationNotice` and `configWarning`: a summary for the user and its details.
public func codexSummaryNotice(_ r: CodexReader, _ params: JsonValue?) throws -> (summary: String, details: String?) {
    let o = try r.fields(params, "params")
    return (try r.string(o, "summary", "params"), try r.nullableString(o, "details", "params"))
}

public func codexRerouted(_ r: CodexReader, _ params: JsonValue?) throws -> (
    threadId: String, fromModel: String, toModel: String, reason: String
) {
    let o = try r.fields(params, "params")
    let reason: String
    switch o["reason"] {
    case .string(let text)?: reason = text
    case nil: reason = "undefined"
    case let other?: reason = other.jsonText
    }
    return (
        try r.string(o, "threadId", "params"), try r.string(o, "fromModel", "params"),
        try r.string(o, "toModel", "params"), reason
    )
}

/// `thread/closed`: which thread, and nothing else.
public func codexThreadClosed(_ r: CodexReader, _ params: JsonValue?) throws -> String {
    try r.string(try r.fields(params, "params"), "threadId", "params")
}

public func codexThreadStarted(_ r: CodexReader, _ params: JsonValue?) throws -> CodexThreadFacts {
    try codexThread(r, try r.fields(params, "params")["thread"], "params.thread")
}

// MARK: - Requests the server makes of DevHub

public struct CodexNetworkAmendment: Equatable, Sendable {
    public var host: String
    /// `allow` or `deny`.
    public var action: String
}

public struct CodexCommandApproval: Equatable, Sendable {
    public var threadId: String
    public var turnId: String
    public var itemId: String
    /// `command` or `writeStdin`.
    public var kind: String
    public var reason: String?
    public var command: String?
    public var cwd: String?
    public var networkHost: String?
    public var execpolicyAmendment: [String]?
    public var networkAmendments: [CodexNetworkAmendment]
}

public func codexCommandApproval(_ r: CodexReader, _ params: JsonValue?) throws -> CodexCommandApproval {
    let o = try r.fields(params, "params")
    let network = o["networkApprovalContext"]
    let threadId = try r.string(o, "threadId", "params")
    let turnId = try r.string(o, "turnId", "params")
    let itemId = try r.string(o, "itemId", "params")
    let kind = o["kind"] != nil ? try r.oneOf(o, "kind", "params", ["command", "writeStdin"]) : "command"
    let reason = try r.nullableString(o, "reason", "params")
    let command = try r.nullableString(o, "command", "params")
    let cwd = try r.nullableString(o, "cwd", "params")
    let networkHost: String?
    if let network, network != .null {
        networkHost = try r.string(try r.fields(network, "params.networkApprovalContext"), "host", "params.networkApprovalContext")
    } else {
        networkHost = nil
    }
    return CodexCommandApproval(
        threadId: threadId, turnId: turnId, itemId: itemId, kind: kind, reason: reason, command: command, cwd: cwd,
        networkHost: networkHost,
        execpolicyAmendment: try r.nullableArray(o, "proposedExecpolicyAmendment", "params", r.stringItem),
        networkAmendments: try r.nullableArray(o, "proposedNetworkPolicyAmendments", "params") { value, path in
            let a = try r.fields(value, path)
            return CodexNetworkAmendment(
                host: try r.string(a, "host", path), action: try r.oneOf(a, "action", path, ["allow", "deny"]))
        } ?? [])
}

public func codexFileChangeApproval(_ r: CodexReader, _ params: JsonValue?) throws -> (
    threadId: String, turnId: String, itemId: String, reason: String?
) {
    let o = try r.fields(params, "params")
    return (
        try r.string(o, "threadId", "params"), try r.string(o, "turnId", "params"),
        try r.string(o, "itemId", "params"), try r.nullableString(o, "reason", "params")
    )
}

public struct CodexPermissionsApproval: Equatable, Sendable {
    public var threadId: String
    public var turnId: String
    public var itemId: String
    public var cwd: String
    public var reason: String?
    /// Granted back whole when the person allows it.
    public var network: JsonValue
    public var fileSystem: JsonValue
}

public func codexPermissionsApproval(_ r: CodexReader, _ params: JsonValue?) throws -> CodexPermissionsApproval {
    let o = try r.fields(params, "params")
    let permissions = try r.fields(o["permissions"], "params.permissions")
    return CodexPermissionsApproval(
        threadId: try r.string(o, "threadId", "params"), turnId: try r.string(o, "turnId", "params"),
        itemId: try r.string(o, "itemId", "params"), cwd: try r.string(o, "cwd", "params"),
        reason: try r.nullableString(o, "reason", "params"),
        network: r.json(permissions, "network"), fileSystem: r.json(permissions, "fileSystem"))
}

public struct CodexQuestion: Equatable, Sendable {
    public var id: String
    public var header: String
    public var question: String
    public var isOther: Bool
    public var isSecret: Bool
    public var options: [QuestionOption]
}

public func codexUserInputRequest(_ r: CodexReader, _ params: JsonValue?) throws -> (
    threadId: String, turnId: String, itemId: String, questions: [CodexQuestion]
) {
    let o = try r.fields(params, "params")
    return (
        try r.string(o, "threadId", "params"), try r.string(o, "turnId", "params"),
        try r.string(o, "itemId", "params"),
        try r.array(o, "questions", "params") { value, path in
            let q = try r.fields(value, path)
            return CodexQuestion(
                id: try r.string(q, "id", path), header: try r.string(q, "header", path),
                question: try r.string(q, "question", path), isOther: try r.boolean(q, "isOther", path),
                isSecret: try r.boolean(q, "isSecret", path),
                options: try r.nullableArray(q, "options", path) { option, at in
                    let p = try r.fields(option, at)
                    return QuestionOption(label: try r.string(p, "label", at), description: try r.string(p, "description", at))
                } ?? [])
        }
    )
}

/// An elicitation of the modes DevHub takes: a form, or a page to visit. The
/// `openai/form` modes come only to a client that opts into them at
/// `initialize`, which DevHub does not.
///
/// A plain confirmation (a form of no fields) may offer to remember its
/// acceptance: `_meta.persist` names how long, as one mode or a list of them
/// (`codex_protocol::mcp_approval_meta`). A mode DevHub does not know is not
/// offered, as Codex's own terminal UI does not offer it.
public func codexElicitation(_ r: CodexReader, _ params: JsonValue?) throws -> (threadId: String, elicitation: Elicitation) {
    let o = try r.fields(params, "params")
    let mode = try r.oneOf(o, "mode", "params", ["form", "url"])
    let fields = mode == "url" ? [] : try formFields(r, o["requestedSchema"], "params.requestedSchema")
    let threadId = try r.string(o, "threadId", "params")
    let server = try r.string(o, "serverName", "params")
    let message = try r.string(o, "message", "params")
    let url = mode == "url" ? try r.string(o, "url", "params") : nil
    return (
        threadId,
        Elicitation(
            server: server, message: message, url: url, fields: fields,
            remember: mode == "form" && fields.isEmpty ? try persistModes(r, o["_meta"]) : [])
    )
}

/// The ways of remembering an acceptance `_meta.persist` offers, in DevHub's order.
private func persistModes(_ r: CodexReader, _ meta: JsonValue?) throws -> [Remember] {
    guard let meta, meta != .null else { return [] }
    let m = try r.fields(meta, "params._meta")
    guard let persist = m["persist"], persist != .null else { return [] }
    let offered: [String]
    if case .string(let one) = persist {
        offered = [one]
    } else {
        offered = try r.array(m, "persist", "params._meta", r.stringItem)
    }
    return REMEMBER_ORDER.filter { offered.contains($0.rawValue) }
}

private let REMEMBER_ORDER: [Remember] = [.session, .always]
