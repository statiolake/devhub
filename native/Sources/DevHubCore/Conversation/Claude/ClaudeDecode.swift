// Port of apps/desktop/src/main/agent/conversation/claude/decode.ts
//
// Claude's stream-json lines, read into DevHub's own types.
//
// Written from the public headless / Agent SDK documentation and from what
// the wire captures record — not from the SDK's type declarations, which are
// proprietary. Every shape here is DevHub's reading of the protocol.
//
// # How strict
//
// A field DevHub uses is checked, and a line of a known type that lacks it or
// carries it in another type throws `ProtocolMismatch` with the path. A field
// DevHub does not use is not looked at, so the CLI adding one is not a
// mismatch. A `type` DevHub has never heard of is not a mismatch either: it
// decodes as `unknown`, and the adapter shows it as a warning, since what it
// carried may be part of the conversation. A `system` subtype DevHub has
// never heard of decodes as `reported`: a system event is the CLI saying
// something beside the conversation, and the CLI adds new ones often, so the
// adapter shows it quietly, as information, not as something wrong.
//
// Some types DevHub knows and deliberately does not use. They decode as
// `unused` rather than `unknown`, so that knowing them is written down here
// and they never raise the "DevHub does not know this event" notice.

import Foundation

public enum ControlOutcome: Hashable, Sendable {
    case ok(payload: JsonObject?)
    case error(String)
}

public struct ClaudeAssistant: Hashable, Sendable {
    public var parent: String?
    /// The message's place in the session (its record there), where a resume can cut it.
    public var uuid: String?
    public var messageId: String
    public var content: [ContentBlock]
    /// The API error the message stands for (`authentication_failed`, `rate_limit`, …).
    public var error: String?
    /// The model that wrote it, as the API names it.
    public var model: String?
    /// When the CLI wrote it, in ms since the epoch, if it said (`timestamp`).
    public var timestamp: Double?
    /// How much of the context window the conversation filled once this
    /// message was written.
    public var contextTokens: Double?
    /// The message's usage, as the prompt cache reads it.
    public var cache: CacheSample?
}

public struct ClaudeUser: Hashable, Sendable {
    public var parent: String?
    public var uuid: String?
    public var content: [UserBlock]
    /// The tool's own account of the result a tool_result block carries.
    public var toolResult: ToolUseResult
}

/// A message of a session, as stream-json prints it or a session file keeps it.
public enum ClaudeMessage: Hashable, Sendable {
    case assistant(ClaudeAssistant)
    case user(ClaudeUser)
}

public struct ClaudeInit: Hashable, Sendable {
    public var sessionId: String
    public var cwd: String
    public var model: String
    public var permissionMode: String?
    public var slashCommands: [String]
    public var version: String?
    /// The effort the session sends on its next request, when this CLI
    /// publishes it: nil on CLIs that do not, and when no effort will be sent.
    public var effort: String?
    /// The MCP servers of the session and how each stands; nil on a CLI that does not say.
    public var mcpServers: [McpServerState]?
    /// The plugins that did not load, and why (`plugin_errors`).
    public var pluginErrors: [PluginError]
}

public struct ClaudeCanUseTool: Hashable, Sendable {
    public var requestId: String
    public var toolName: String
    public var input: JsonObject
    public var suggestions: [JsonObject]
    public var reason: String?
    public var toolUseId: String?
    /// AskUserQuestion's questions; nil for every other tool.
    public var questions: [Question]?
}

public struct ClaudeResult: Hashable, Sendable {
    public var isError: Bool
    public var subtype: String
    public var durationMs: Double?
    public var result: String?
    /// How many times the model was asked (`num_turns`): 0 when the CLI
    /// answered by itself, as it does a local command.
    public var modelTurns: Double?
    public var errors: [String]
    public var costUsd: Double?
    public var usage: ResultUsage?
    /// Each model the turn used (`modelUsage`), and the context window it has.
    public var contextWindows: [(String, Double)]

    public static func == (lhs: ClaudeResult, rhs: ClaudeResult) -> Bool {
        lhs.isError == rhs.isError && lhs.subtype == rhs.subtype && lhs.durationMs == rhs.durationMs
            && lhs.result == rhs.result && lhs.modelTurns == rhs.modelTurns && lhs.errors == rhs.errors
            && lhs.costUsd == rhs.costUsd && lhs.usage == rhs.usage
            && lhs.contextWindows.map(\.0) == rhs.contextWindows.map(\.0)
            && lhs.contextWindows.map(\.1) == rhs.contextWindows.map(\.1)
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(subtype)
        hasher.combine(durationMs)
    }
}

public struct ClaudeTask: Hashable, Sendable {
    public var subtype: String
    public var taskId: String?
    public var toolUseId: String?
    public var status: String?
    public var text: String?
    public var raw: JsonObject
}

public struct ClaudeBackgroundTaskInfo: Hashable, Sendable {
    public var taskId: String
    /// `local_bash`, `local_agent`, or another kind the CLI has.
    public var taskType: String
    public var description: String
}

public struct ClaudePermissionDenied: Hashable, Sendable {
    public var toolUseId: String?
    /// The subagent the call was made in, by its agent id.
    public var agentId: String?
    public var toolName: String?
    /// What decided: `classifier`, `rule`, `mode`, …
    public var reasonType: String?
    public var reason: String?
    public var message: String?
    public var raw: JsonObject
}

public enum ClaudeLine: Hashable, Sendable {
    case controlResponse(requestId: String, outcome: ControlOutcome)
    case canUseTool(ClaudeCanUseTool)
    /// An MCP server asking the person something (`SDKControlElicitationRequest`).
    case elicitation(requestId: String, elicitation: Elicitation)
    /// A control request from the CLI of a subtype DevHub does not serve.
    case controlRequestUnserved(requestId: String, subtype: String, raw: JsonObject)
    case controlCancelRequest(requestId: String)
    case initialized(ClaudeInit)
    case stream(parent: String?, event: StreamEvent)
    case assistant(ClaudeAssistant)
    case user(ClaudeUser)
    case result(ClaudeResult)
    case apiRetry(attempt: Double?, maxRetries: Double?, retryDelayMs: Double?, errorStatus: Double?, raw: JsonObject)
    case compactBoundary(trigger: String?, preTokens: Double?, postTokens: Double?)
    /// What the CLI is doing apart from the model's words (`SDKStatusMessage`):
    /// `compacting` while it compacts the conversation (nil when the line does
    /// not say what the CLI is doing), and how a compaction ended.
    case status(permissionMode: String?, compacting: Bool?, compactFailure: String?)
    /// Something the CLI says to the person in so many words: a recap, a warning, a refusal.
    case said(level: NoticeLevel, text: String)
    /// A command the CLI ran itself, or what it printed, as a system event.
    case localCommand(blocks: [UserBlock])
    /// The CLI's own permission check refused a call (a rule, auto mode's classifier).
    case permissionDenied(ClaudePermissionDenied)
    case task(ClaudeTask)
    /// Every task the CLI has working in the background now, whole: printed each time the set changes.
    case backgroundTasks([ClaudeBackgroundTaskInfo])
    /// `status`: whether the CLI may go on (`allowed`, `allowed_warning`) or
    /// has been refused (`rejected`). `resetsAt`: when the limiting window
    /// resets, in epoch ms, when it says.
    case rateLimit(windows: [RateLimit], status: String?, resetsAt: Double?)
    /// The host started the CLI again on the session cut short before
    /// `message`, and put this line between the two CLIs' output.
    case rewind(message: String)
    /// The host started the CLI again on another session (`/resume`), and put
    /// this line between the two CLIs' output, followed by that session's
    /// past as `devhub_history` lines.
    case resume(session: String)
    /// The host stopped the CLI and started it again on the same session
    /// (Restart session), and put this line (`RESTART_MARK`) between the two.
    case restart
    /// A message of the session this conversation resumed, put in the
    /// journal by DevHub — not something the CLI printed.
    case history(ClaudeMessage)
    case unused
    /// A system event of a subtype DevHub has never heard of.
    case reported(subtype: String, raw: JsonObject)
    case unknown(key: String, raw: JsonObject)
}

/// One MCP server as the CLI reports it, in `system/init`'s `mcp_servers`
/// and in the answer to `mcp_status` alike. `status` is the CLI's word, kept
/// as a string so a word a later CLI adds is shown rather than refused.
public struct McpServerState: Hashable, Sendable {
    public var name: String
    public var status: String
    /// Why it failed, when the CLI says.
    public var error: String?
    /// Where it is configured (`scope`); `mcp_status` says, `system/init` does not.
    public var scope: String?
}

public struct ResultUsage: Hashable, Sendable {
    public var inputTokens: Double?
    public var outputTokens: Double?
    public var cacheReadTokens: Double?
}

public enum StreamEvent: Hashable, Sendable {
    case messageStart(messageId: String)
    case blockStart(index: Double, block: ContentBlock)
    case delta(index: Double, delta: Delta)
    case messageStop
    case unused
    case unknown(key: String, raw: JsonObject)
}

public enum Delta: Hashable, Sendable {
    case text(String)
    case thinking(String)
    case unused
    case unknown(key: String, raw: JsonObject)
}

public enum ContentBlock: Hashable, Sendable {
    case text(String)
    case thinking(String)
    case toolUse(id: String, name: String, input: JsonObject)
    case unused
    case unknown(key: String, raw: JsonObject)
}

/// What a tool says of its own result (`tool_use_result`), beside the blocks
/// the model reads: an object for most tools, the error's words for a call
/// that failed, the content blocks again for an MCP tool. Only an object says
/// more than the blocks do, so the others read as `NO_TOOL_RESULT`.
public struct ToolUseResult: Hashable, Sendable {
    /// The task the call started in the background (`status` "async_launched").
    public var launchedTask: String?
    /// The teammate the call spawned (`status` "teammate_spawned"), by the
    /// name its messages come from.
    public var teammate: String?
    /// A command's streams, apart (Bash).
    public var stdout: String?
    public var stderr: String?
    public var interrupted: Bool
    /// The task a command run in the background is (`backgroundTaskId`).
    public var backgroundTask: String?
    /// The edit a file tool made (Edit, MultiEdit, Write), as unified-diff hunks.
    public var patch: (path: String, hunks: String)?
    /// Where the CLI saved output too large for the conversation.
    public var persistedPath: String?
    /// What the person answered to AskUserQuestion's questions.
    public var answered: AnsweredQuestions?

    public static func == (lhs: ToolUseResult, rhs: ToolUseResult) -> Bool {
        lhs.launchedTask == rhs.launchedTask && lhs.teammate == rhs.teammate && lhs.stdout == rhs.stdout
            && lhs.stderr == rhs.stderr && lhs.interrupted == rhs.interrupted
            && lhs.backgroundTask == rhs.backgroundTask && lhs.patch?.path == rhs.patch?.path
            && lhs.patch?.hunks == rhs.patch?.hunks && lhs.persistedPath == rhs.persistedPath
            && lhs.answered == rhs.answered
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(launchedTask)
        hasher.combine(stdout)
        hasher.combine(patch?.path)
    }
}

public struct AnsweredQuestions: Hashable, Sendable {
    public var questions: [Question]
    /// A multi-select answer is its labels joined with `", "`, or a list of them.
    public var answers: [String: AnswerValue]
    public var notes: [String: String]
}

public let NO_TOOL_RESULT = ToolUseResult(
    launchedTask: nil, teammate: nil, stdout: nil, stderr: nil, interrupted: false, backgroundTask: nil, patch: nil,
    persistedPath: nil, answered: nil)

/// A block of a tool result's content.
public enum ResultPart: Hashable, Sendable {
    case text(String)
    case image(ImageRef)
    /// A tool the result made available to the model (a tool search's find).
    case reference(name: String)
    case unknown(key: String, raw: JsonObject)
}

public struct TeamSignal: Hashable, Sendable {
    public var type: String
    public var failure: String?
}

public enum UserBlock: Hashable, Sendable {
    case text(String)
    /// A command the CLI ran itself: `/model sonnet`, `! ls`.
    case command(line: String)
    /// A teammate's message to the conversation, by its name. `signal` is its
    /// team protocol's word (`idle_notification`, `shutdown_approved`, …)
    /// when the message is one, with the failure an idle notification names.
    case teammateMessage(from: String, text: String, signal: TeamSignal?)
    /// What such a command printed.
    case commandOutput(output: String, failed: Bool)
    /// An image the person put in the message.
    case image(ImageRef)
    case taskNotification(taskId: String?, toolUseId: String?, status: String?, summary: String?, raw: JsonObject)
    case toolResult(toolUseId: String, isError: Bool, parts: [ResultPart])
    case unused
    case unknown(key: String, raw: JsonObject)
}

/// DevHub's answer to a request of the CLI's: a permission's behavior, or an elicitation's action.
public enum SentAnswer: String, Hashable, Sendable {
    case allow, deny, accept, decline, cancel
}

/// What DevHub writes, read back: the lines of `in.log`.
public enum SentLine: Hashable, Sendable {
    case user(text: String, images: [ImageRef], origin: SentOrigin)
    case controlRequest(requestId: String, subtype: String, request: JsonObject)
    case controlResponse(requestId: String, answer: SentAnswer)
    /// DevHub's refusal of a control request it does not serve.
    case controlRefusal(requestId: String)
}

/// The key DevHub adds to a user message it writes, saying who made the Agent
/// say it. The CLI does not read it; `in.log` keeps it, so the origin
/// survives a restart of DevHub.
public let ORIGIN_KEY = "devhub_origin"

/// Reads fields of one line, failing with that line's path and the CLI's version.
struct Fields: SchemaReader {
    let version: String?

    func fail(_ path: String, _ expected: String) -> ProtocolMismatch {
        ProtocolMismatch(path: path, expected: expected, agentVersion: version)
    }

    func object(_ value: JsonValue?, _ path: String) throws -> JsonObject {
        guard case .object(let object)? = value else { throw fail(path, "an object") }
        return object
    }

    func array(_ value: JsonValue?, _ path: String) throws -> [JsonValue] {
        guard case .array(let items)? = value else { throw fail(path, "an array") }
        return items
    }

    func string(_ value: JsonValue?, _ path: String) throws -> String {
        guard case .string(let text)? = value else { throw fail(path, "a string") }
        return text
    }

    func number(_ value: JsonValue?, _ path: String) throws -> Double {
        guard case .number(let number)? = value else { throw fail(path, "a number") }
        return number
    }

    func boolean(_ value: JsonValue?, _ path: String) throws -> Bool {
        guard case .bool(let flag)? = value else { throw fail(path, "a boolean") }
        return flag
    }

    /// An ISO 8601 time, as ms since the epoch.
    func optionalTime(_ value: JsonValue?, _ path: String) throws -> Double? {
        guard let text = try optionalString(value, path) else { return nil }
        guard let time = parseISOTime(text) else { throw fail(path, "an ISO 8601 time") }
        return time
    }

    func optionalString(_ value: JsonValue?, _ path: String) throws -> String? {
        guard let value, value != .null else { return nil }
        return try string(value, path)
    }

    func optionalNumber(_ value: JsonValue?, _ path: String) throws -> Double? {
        guard let value, value != .null else { return nil }
        return try number(value, path)
    }

    /// `parent_tool_use_id`: present on every message, null at the top level.
    func parent(_ line: JsonObject, _ type: String) throws -> String? {
        guard let value = line["parent_tool_use_id"], value != .null else { return nil }
        return try string(value, "\(type).parent_tool_use_id")
    }
}

/// `Date.parse` of the ISO 8601 times the CLIs write: `2026-01-02T03:04:05.678Z`,
/// with or without fractional seconds, `Z` or an offset; a bare date is UTC.
func parseISOTime(_ text: String) -> Double? {
    let pattern =
        #"^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?$"#
    guard let regex = try? NSRegularExpression(pattern: pattern),
          let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
    else { return nil }
    func group(_ index: Int) -> String? {
        let range = match.range(at: index)
        guard range.location != NSNotFound, let swiftRange = Range(range, in: text) else { return nil }
        return String(text[swiftRange])
    }
    var components = DateComponents()
    components.year = Int(group(1)!)
    components.month = Int(group(2)!)
    components.day = Int(group(3)!)
    components.hour = Int(group(4) ?? "0")
    components.minute = Int(group(5) ?? "0")
    components.second = Int(group(6) ?? "0")
    guard let month = components.month, (1...12).contains(month), let day = components.day, (1...31).contains(day),
          let hour = components.hour, hour <= 24, let minute = components.minute, minute <= 59,
          let second = components.second, second <= 59
    else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    var offsetSeconds = 0
    if let zone = group(8), zone != "Z" {
        let sign = zone.hasPrefix("-") ? -1 : 1
        let parts = zone.dropFirst().split(separator: ":")
        offsetSeconds = sign * (Int(parts[0])! * 3600 + Int(parts[1])! * 60)
    } else if group(8) == nil, group(4) != nil {
        // A date-time without a zone is local time to `Date.parse`.
        offsetSeconds = TimeZone.current.secondsFromGMT()
    }
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    guard let date = calendar.date(from: components) else { return nil }
    var millis = (date.timeIntervalSince1970 - Double(offsetSeconds)) * 1000
    if let fraction = group(7) {
        let digits = String(fraction.prefix(3)).padding(toLength: 3, withPad: "0", startingAt: 0)
        millis += Double(Int(digits)!)
    }
    return millis.rounded()
}

private func parse(_ line: String, _ f: Fields, _ side: String) throws -> JsonObject {
    let value: JsonValue
    do {
        value = try JsonValue.parse(line)
    } catch {
        // Not JSON is itself the finding; the parser's message adds nothing
        // the path does not already say.
        throw f.fail(side, "a line of JSON")
    }
    return try f.object(value, side)
}

public func decodeReceived(_ line: String, version: String?) throws -> ClaudeLine {
    let f = Fields(version: version)
    let raw = try parse(line, f, "line")
    let type = try f.string(raw["type"], "type")
    switch type {
    case "control_response":
        return try decodeControlResponse(raw, f)
    case "control_request":
        return try decodeControlRequest(raw, f)
    case "control_cancel_request":
        return .controlCancelRequest(requestId: try f.string(raw["request_id"], "control_cancel_request.request_id"))
    case "system":
        return try decodeSystem(raw, f)
    case "stream_event":
        return .stream(
            parent: try f.parent(raw, "stream_event"),
            event: try decodeStreamEvent(try f.object(raw["event"], "stream_event.event"), f))
    case "assistant":
        if let ran = try decodeRanCommand(raw, "assistant", f) { return .user(ran) }
        return .assistant(try decodeAssistant(raw, f))
    case "user":
        return .user(try decodeUser(raw, f))
    case "result":
        return .result(try decodeResult(raw, f))
    case "rate_limit_event":
        return try decodeRateLimit(raw, f)
    case "devhub_history":
        return try decodeHistory(raw, f)
    case "devhub_rewind":
        return .rewind(message: try f.string(raw["message"], "devhub_rewind.message"))
    case "devhub_resume":
        return .resume(session: try f.string(raw["session"], "devhub_resume.session"))
    case "devhub_restart":
        return .restart
    // `/clear` (and the CLI's other fresh starts): the model goes on from
    // nothing, in a new session the next `system/init` names.
    case "conversation_reset":
        return .said(level: .info, text: "Context cleared: the model starts afresh from here.")
    // `tool_progress`: ticks of a running tool, whose entry already says it
    // runs. `prompt_suggestion`: suggested next prompts, which are not offered.
    case "tool_progress", "prompt_suggestion":
        return .unused
    default:
        return .unknown(key: type, raw: raw)
    }
}

/// A session file's message, in the shape stream-json prints the same message.
private func decodeHistory(_ raw: JsonObject, _ f: Fields) throws -> ClaudeLine {
    let record = try f.object(raw["record"], "devhub_history.record")
    let type = try f.string(record["type"], "devhub_history.record.type")
    switch type {
    case "assistant":
        if let ran = try decodeRanCommand(record, "devhub_history.record", f) { return .history(.user(ran)) }
        return .history(.assistant(try decodeAssistant(record, f)))
    case "user":
        return .history(.user(try decodeUser(record, f)))
    // A system event the session file kept, in the shape stream-json prints it.
    case "system":
        return try decodeSystem(record, f)
    case "attachment":
        return try decodeAttachment(try f.object(record["attachment"], "devhub_history.record.attachment"), f)
    default:
        throw f.fail("devhub_history.record.type", "assistant, user, system or attachment")
    }
}

/// Something the CLI attached to the conversation that a session file keeps
/// and stream-json does not print: a file the person attached, and a file
/// changed outside the conversation.
private func decodeAttachment(_ attachment: JsonObject, _ f: Fields) throws -> ClaudeLine {
    let at = "devhub_history.record.attachment"
    let type = try f.string(attachment["type"], "\(at).type")
    switch type {
    case "file":
        let name = try f.optionalString(attachment["displayPath"], "\(at).displayPath")
            ?? (try f.string(attachment["filename"], "\(at).filename"))
        return .said(level: .info, text: "Attached \(name)")
    case "edited_text_file":
        return .said(
            level: .info,
            text: "Changed outside the conversation: \(try f.string(attachment["filename"], "\(at).filename"))")
    default:
        throw f.fail("\(at).type", "file or edited_text_file")
    }
}

private func decodeControlResponse(_ raw: JsonObject, _ f: Fields) throws -> ClaudeLine {
    let response = try f.object(raw["response"], "control_response.response")
    let requestId = try f.string(response["request_id"], "control_response.response.request_id")
    let subtype = try f.string(response["subtype"], "control_response.response.subtype")
    if subtype == "success" {
        let payload = response["response"]
        return .controlResponse(
            requestId: requestId,
            outcome: .ok(
                payload: payload == nil || payload == .null
                    ? nil : try f.object(payload, "control_response.response.response")))
    }
    if subtype == "error" {
        return .controlResponse(
            requestId: requestId, outcome: .error(try f.string(response["error"], "control_response.response.error")))
    }
    throw f.fail("control_response.response.subtype", "\"success\" or \"error\", not \(JsonValue.quoted(subtype))")
}

private func decodeControlRequest(_ raw: JsonObject, _ f: Fields) throws -> ClaudeLine {
    let requestId = try f.string(raw["request_id"], "control_request.request_id")
    let request = try f.object(raw["request"], "control_request.request")
    let subtype = try f.string(request["subtype"], "control_request.request.subtype")
    let at = "control_request.request"
    if subtype == "elicitation" {
        return .elicitation(requestId: requestId, elicitation: try decodeElicitation(request, at, f))
    }
    if subtype != "can_use_tool" {
        return .controlRequestUnserved(requestId: requestId, subtype: subtype, raw: raw)
    }
    let suggestions = request["permission_suggestions"]
    let toolName = try f.string(request["tool_name"], "\(at).tool_name")
    let input = try f.object(request["input"], "\(at).input")
    return .canUseTool(
        ClaudeCanUseTool(
            requestId: requestId, toolName: toolName, input: input,
            suggestions: suggestions == nil || suggestions == .null
                ? []
                : try f.array(suggestions, "\(at).permission_suggestions").enumerated().map { index, each in
                    try f.object(each, "\(at).permission_suggestions[\(index)]")
                },
            // The reason's shape is not pinned down by any public document; a
            // sentence is shown and anything else is left to the input it is about.
            reason: request["decision_reason"]?.stringValue,
            toolUseId: try f.optionalString(request["tool_use_id"], "\(at).tool_use_id"),
            questions: toolName == ASK_USER_QUESTION ? try decodeQuestions(input, "\(at).input", f) : nil))
}

/// An elicitation: a form (the default mode), or a page to visit. A form with
/// no schema asks for nothing, so it is a plain confirmation. Claude
/// documents no way of remembering an acceptance, so none is offered.
private func decodeElicitation(_ request: JsonObject, _ at: String, _ f: Fields) throws -> Elicitation {
    let mode = request["mode"] == nil || request["mode"] == .null ? "form" : try f.string(request["mode"], "\(at).mode")
    if mode != "form" && mode != "url" {
        throw f.fail("\(at).mode", "\"form\" or \"url\", not \(JsonValue.quoted(mode))")
    }
    let schema = request["requested_schema"]
    return Elicitation(
        server: try f.string(request["mcp_server_name"], "\(at).mcp_server_name"),
        message: try f.string(request["message"], "\(at).message"),
        url: mode == "url" ? try f.string(request["url"], "\(at).url") : nil,
        fields: mode == "url" || schema == nil || schema == .null
            ? [] : try formFields(f, schema, "\(at).requested_schema"),
        remember: [])
}

/// The tool whose permission request is a set of questions for the person.
public let ASK_USER_QUESTION = "AskUserQuestion"

/// AskUserQuestion's input. Its answers are filed under each question's
/// text, so the text is the question's id.
private func decodeQuestions(_ input: JsonObject, _ at: String, _ f: Fields) throws -> [Question] {
    try f.array(input["questions"], "\(at).questions").enumerated().map { index, each in
        let path = "\(at).questions[\(index)]"
        let question = try f.object(each, path)
        let text = try f.string(question["question"], "\(path).question")
        return Question(
            id: text,
            header: try f.optionalString(question["header"], "\(path).header") ?? "",
            text: text,
            options: try f.array(question["options"], "\(path).options").enumerated().map { at, option in
                let read = try f.object(option, "\(path).options[\(at)]")
                return QuestionOption(
                    label: try f.string(read["label"], "\(path).options[\(at)].label"),
                    description: try f.optionalString(read["description"], "\(path).options[\(at)].description") ?? "",
                    preview: try f.optionalString(read["preview"], "\(path).options[\(at)].preview"))
            },
            multiSelect: question["multiSelect"] == nil
                ? false : try f.boolean(question["multiSelect"], "\(path).multiSelect"),
            allowsOther: true)
    }
}

public struct InitializeCommand: Hashable, Sendable {
    public var name: String
    public var description: String
    public var argumentHint: String?
}

public struct InitializeModel: Hashable, Sendable {
    public var id: String
    public var label: String
    /// The full model name the choice resolves to, as a session reports its model.
    public var resolved: String?
    /// The effort levels the model takes; none for a model without effort.
    public var efforts: [String]
}

public struct InitializeFacts: Hashable, Sendable {
    public var commands: [InitializeCommand]
    public var models: [InitializeModel]
    /// The permission mode the session is in, before any turn has said so.
    public var currentMode: String?
}

/// The payload of the CLI's success response to DevHub's `initialize`.
public func decodeInitialize(_ payload: JsonObject?, version: String?) throws -> InitializeFacts {
    let f = Fields(version: version)
    let at = "control_response(initialize).response.response"
    let body = try f.object(payload.map(JsonValue.object), at)
    func list(_ key: String) throws -> [JsonValue] {
        body[key] == nil ? [] : try f.array(body[key], "\(at).\(key)")
    }
    return InitializeFacts(
        commands: try list("commands").enumerated().map { index, each in
            let path = "\(at).commands[\(index)]"
            let command = try f.object(each, path)
            let hint = try f.optionalString(command["argumentHint"], "\(path).argumentHint")
            return InitializeCommand(
                name: try f.string(command["name"], "\(path).name"),
                description: try f.optionalString(command["description"], "\(path).description") ?? "",
                argumentHint: hint == "" ? nil : hint)
        },
        models: try list("models").enumerated().map { index, each in
            let path = "\(at).models[\(index)]"
            let model = try f.object(each, path)
            let efforts =
                model["supportedEffortLevels"] == nil
                ? [] : try f.array(model["supportedEffortLevels"], "\(path).supportedEffortLevels")
            return InitializeModel(
                id: try f.string(model["value"], "\(path).value"),
                label: try f.string(model["displayName"], "\(path).displayName"),
                resolved: try f.optionalString(model["resolvedModel"], "\(path).resolvedModel"),
                efforts: try efforts.enumerated().map { at, level in
                    try f.string(level, "\(path).supportedEffortLevels[\(at)]")
                })
        },
        currentMode: try f.optionalString(body["current_permission_mode"], "\(at).current_permission_mode"))
}

private func decodeMcpServers(_ value: JsonValue?, _ at: String, _ f: Fields) throws -> [McpServerState] {
    try f.array(value, at).enumerated().map { index, each in
        let path = "\(at)[\(index)]"
        let server = try f.object(each, path)
        return McpServerState(
            name: try f.string(server["name"], "\(path).name"),
            status: try f.string(server["status"], "\(path).status"),
            error: try f.optionalString(server["error"], "\(path).error"),
            scope: try f.optionalString(server["scope"], "\(path).scope"))
    }
}

/// The payload of the CLI's success response to DevHub's `mcp_status`.
public func decodeMcpStatus(_ payload: JsonObject?, version: String?) throws -> [McpServerState] {
    let f = Fields(version: version)
    let at = "control_response(mcp_status).response.response"
    let body = try f.object(payload.map(JsonValue.object), at)
    return try decodeMcpServers(body["mcpServers"], "\(at).mcpServers", f)
}

private func decodeSystem(_ raw: JsonObject, _ f: Fields) throws -> ClaudeLine {
    let subtype = try f.string(raw["subtype"], "system.subtype")
    let at = "system/\(subtype)"
    switch subtype {
    case "init":
        return .initialized(
            ClaudeInit(
                sessionId: try f.string(raw["session_id"], "\(at).session_id"),
                cwd: try f.string(raw["cwd"], "\(at).cwd"),
                model: try f.string(raw["model"], "\(at).model"),
                permissionMode: try f.optionalString(raw["permissionMode"], "\(at).permissionMode"),
                slashCommands: try (raw["slash_commands"] == nil
                    ? [] : try f.array(raw["slash_commands"], "\(at).slash_commands")).enumerated().map { index, each in
                        try f.string(each, "\(at).slash_commands[\(index)]")
                    },
                version: try f.optionalString(raw["claude_code_version"], "\(at).claude_code_version"),
                effort: raw["effort"] == .null ? nil : try f.optionalString(raw["effort"], "\(at).effort"),
                mcpServers: raw["mcp_servers"] == nil
                    ? nil : try decodeMcpServers(raw["mcp_servers"], "\(at).mcp_servers", f),
                pluginErrors: try (raw["plugin_errors"] == nil
                    ? [] : try f.array(raw["plugin_errors"], "\(at).plugin_errors")).enumerated().map { index, each in
                        let path = "\(at).plugin_errors[\(index)]"
                        let error = try f.object(each, path)
                        return PluginError(
                            plugin: try f.string(error["plugin"], "\(path).plugin"),
                            message: try f.string(error["message"], "\(path).message"))
                    }))
    case "api_retry":
        return .apiRetry(
            attempt: try f.optionalNumber(raw["attempt"], "\(at).attempt"),
            maxRetries: try f.optionalNumber(raw["max_retries"], "\(at).max_retries"),
            retryDelayMs: try f.optionalNumber(raw["retry_delay_ms"], "\(at).retry_delay_ms"),
            errorStatus: try f.optionalNumber(raw["error_status"], "\(at).error_status"),
            raw: raw)
    case "compact_boundary":
        let metadata =
            raw["compact_metadata"] == nil
            ? JsonObject() : try f.object(raw["compact_metadata"], "\(at).compact_metadata")
        return .compactBoundary(
            trigger: try f.optionalString(metadata["trigger"], "\(at).compact_metadata.trigger"),
            preTokens: try f.optionalNumber(metadata["pre_tokens"], "\(at).compact_metadata.pre_tokens"),
            postTokens: try f.optionalNumber(metadata["post_tokens"], "\(at).compact_metadata.post_tokens"))
    case "status":
        // `status` absent says nothing of what the CLI is doing; null says it does nothing.
        let compacting: Bool?
        switch raw["status"] {
        case nil: compacting = nil
        case .null?: compacting = false
        default: compacting = try f.string(raw["status"], "\(at).status") == "compacting"
        }
        let result = try f.optionalString(raw["compact_result"], "\(at).compact_result")
        return .status(
            permissionMode: try f.optionalString(raw["permissionMode"], "\(at).permissionMode"),
            compacting: compacting,
            compactFailure: result == "failed"
                ? (try f.optionalString(raw["compact_error"], "\(at).compact_error") ?? "the CLI did not say why")
                : nil)
    case "permission_denied":
        func text(_ key: String) throws -> String? { try f.optionalString(raw[key], "\(at).\(key)") }
        return .permissionDenied(
            ClaudePermissionDenied(
                toolUseId: try text("tool_use_id"), agentId: try text("agent_id"), toolName: try text("tool_name"),
                reasonType: try text("decision_reason_type"), reason: try text("decision_reason"),
                message: try text("message"), raw: raw))
    case "away_summary":
        return .said(level: .info, text: "While you were away: \(try f.string(raw["content"], "\(at).content"))")
    case "informational":
        return .said(
            level: try noticeLevel(raw["level"], "\(at).level", f), text: try f.string(raw["content"], "\(at).content"))
    case "model_refusal_no_fallback":
        let why = try f.optionalString(raw["apiRefusalExplanation"], "\(at).apiRefusalExplanation")
        return .said(
            level: .error, text: "\(try f.string(raw["content"], "\(at).content"))\(why.map { " (\($0))" } ?? "")")
    // A change a command of the CLI's made to the repository: which kind (an
    // open set) and, best effort, on which branch.
    case "vcs_state_changed":
        return .said(
            level: .info,
            text: vcsChange(try f.string(raw["kind"], "\(at).kind"), try f.optionalString(raw["branch"], "\(at).branch")))
    case "local_command":
        let content = try f.string(raw["content"], "\(at).content")
        return .localCommand(blocks: textBlock(content))
    // A stop hook's round, drawn only when a hook failed: hooks are the
    // owner's configuration (below), and one that ran well says nothing.
    case "stop_hook_summary":
        let errors = try (raw["hookErrors"] == nil ? [] : try f.array(raw["hookErrors"], "\(at).hookErrors"))
            .enumerated().map { index, each in try f.string(each, "\(at).hookErrors[\(index)]") }
        return errors.isEmpty ? .unused : .said(level: .warning, text: "A stop hook failed: \(errors.joined(separator: "; "))")
    case "task_started", "task_progress", "task_updated", "task_notification":
        return .task(
            ClaudeTask(
                subtype: subtype,
                taskId: try f.optionalString(raw["task_id"], "\(at).task_id"),
                toolUseId: try f.optionalString(raw["tool_use_id"], "\(at).tool_use_id"),
                status: try f.optionalString(raw["status"], "\(at).status"),
                text: try f.optionalString(raw["summary"], "\(at).summary")
                    ?? (try f.optionalString(raw["description"], "\(at).description")),
                raw: raw))
    case "background_tasks_changed":
        return .backgroundTasks(
            try f.array(raw["tasks"], "\(at).tasks").enumerated().map { index, each in
                let path = "\(at).tasks[\(index)]"
                let task = try f.object(each, path)
                return ClaudeBackgroundTaskInfo(
                    taskId: try f.string(task["task_id"], "\(path).task_id"),
                    taskType: try f.string(task["task_type"], "\(path).task_type"),
                    description: try f.string(task["description"], "\(path).description"))
            })
    // Known, and not drawn:
    // - hook_*: a hook the owner configured (SessionStart and the like)
    //   reports itself whether or not hook events were asked for; hooks are
    //   not drawn, and what a hook prints is the owner's configuration, not
    //   the conversation;
    // - thinking_tokens: an estimate of the thinking while it streams;
    // - turn_duration: how long a turn took, which the transcript does not
    //   draw (a turn that completed draws nothing);
    // - bridge_status: the CLI's link to a remote control of the session,
    //   which is not the conversation and which DevHub does not offer.
    case "thinking_tokens", "turn_duration", "bridge_status", "hook_started", "hook_progress", "hook_response":
        return .unused
    default:
        return .reported(subtype: subtype, raw: raw)
    }
}

/// A `vcs_state_changed` event, said as what was done; a kind DevHub has no phrase for is named.
private func vcsChange(_ kind: String, _ branch: String?) -> String {
    switch kind {
    case "push": return branch.map { "Pushed \($0)" } ?? "Pushed"
    case "commit": return branch.map { "Committed on \($0)" } ?? "Committed"
    case "merge": return branch.map { "Merged into \($0)" } ?? "Merged"
    case "rebase": return branch.map { "Rebased \($0)" } ?? "Rebased"
    default:
        return branch.map { "Changed the repository (\(kind)) on \($0)" } ?? "Changed the repository (\(kind))"
    }
}

/// A system event's `level`, as a notice's: anything but a warning or an error is information.
private func noticeLevel(_ value: JsonValue?, _ at: String, _ f: Fields) throws -> NoticeLevel {
    let level = try f.optionalString(value, at)
    return level == "warning" ? .warning : level == "error" ? .error : .info
}

private func decodeStreamEvent(_ event: JsonObject, _ f: Fields) throws -> StreamEvent {
    let type = try f.string(event["type"], "stream_event.event.type")
    let at = "stream_event.event(\(type))"
    switch type {
    case "message_start":
        let message = try f.object(event["message"], "\(at).message")
        return .messageStart(messageId: try f.string(message["id"], "\(at).message.id"))
    case "content_block_start":
        return .blockStart(
            index: try f.number(event["index"], "\(at).index"),
            block: try decodeContentBlock(
                try f.object(event["content_block"], "\(at).content_block"), "\(at).content_block", f))
    case "content_block_delta":
        return .delta(
            index: try f.number(event["index"], "\(at).index"),
            delta: try decodeDelta(try f.object(event["delta"], "\(at).delta"), "\(at).delta", f))
    case "message_stop":
        return .messageStop
    // The block's end is told by its complete `assistant` message; the
    // message's usage and stop reason, by the turn's `result`.
    case "content_block_stop", "message_delta", "ping":
        return .unused
    default:
        return .unknown(key: "stream_event/\(type)", raw: event)
    }
}

private func decodeDelta(_ delta: JsonObject, _ at: String, _ f: Fields) throws -> Delta {
    let type = try f.string(delta["type"], "\(at).type")
    switch type {
    case "text_delta": return .text(try f.string(delta["text"], "\(at).text"))
    case "thinking_delta": return .thinking(try f.string(delta["thinking"], "\(at).thinking"))
    // A tool's input arrives whole in the complete message; a thinking
    // block's signature and a text's citations are not drawn.
    case "input_json_delta", "signature_delta", "citations_delta": return .unused
    default: return .unknown(key: "delta/\(type)", raw: delta)
    }
}

private func decodeContentBlock(_ block: JsonObject, _ at: String, _ f: Fields) throws -> ContentBlock {
    let type = try f.string(block["type"], "\(at).type")
    switch type {
    case "text": return .text(try f.string(block["text"], "\(at).text"))
    case "thinking": return .thinking(try f.string(block["thinking"], "\(at).thinking"))
    case "tool_use":
        return .toolUse(
            id: try f.string(block["id"], "\(at).id"), name: try f.string(block["name"], "\(at).name"),
            input: try f.object(block["input"], "\(at).input"))
    // Thinking the API withholds: there is nothing to draw.
    case "redacted_thinking": return .unused
    default: return .unknown(key: "content/\(type)", raw: block)
    }
}

/// A local slash command's answer. Asked one over stream-json (`/mcp`,
/// `/cost`), the CLI runs it without the model and prints neither an echo of
/// the message nor a `local_command` event, only an assistant message of the
/// model `<synthetic>` and then the command's `result`. That message says
/// which command ran (`local_command_run`) and what it printed, in the tags
/// the session file records a local command in (`local_command_source`), so
/// it is read as the session file's record of the command: the command, then
/// its output. Observed from 2.1.273 through 2.1.283; neither field is in the
/// SDK's types.
private func decodeRanCommand(_ raw: JsonObject, _ at: String, _ f: Fields) throws -> ClaudeUser? {
    guard raw["local_command_run"] != nil else { return nil }
    let run = try f.object(raw["local_command_run"], "\(at).local_command_run")
    let command = try f.string(run["command"], "\(at).local_command_run.command")
    let args = JSString.trim(try f.string(run["args"], "\(at).local_command_run.args"))
    let source = try f.string(raw["local_command_source"], "\(at).local_command_source")
    return ClaudeUser(
        parent: try f.parent(raw, "assistant"),
        uuid: try f.optionalString(raw["uuid"], "\(at).uuid"),
        content: [.command(line: args.isEmpty ? "/\(command)" : "/\(command) \(args)")] + textBlock(source),
        toolResult: NO_TOOL_RESULT)
}

private func decodeAssistant(_ raw: JsonObject, _ f: Fields) throws -> ClaudeAssistant {
    let message = try f.object(raw["message"], "assistant.message")
    return ClaudeAssistant(
        parent: try f.parent(raw, "assistant"),
        uuid: try f.optionalString(raw["uuid"], "assistant.uuid"),
        messageId: try f.string(message["id"], "assistant.message.id"),
        content: try f.array(message["content"], "assistant.message.content").enumerated().map { index, block in
            try decodeContentBlock(
                try f.object(block, "assistant.message.content[\(index)]"), "assistant.message.content[\(index)]", f)
        },
        error: try f.optionalString(raw["error"], "assistant.error"),
        model: try f.optionalString(message["model"], "assistant.message.model"),
        timestamp: try f.optionalTime(raw["timestamp"], "assistant.timestamp"),
        contextTokens: try contextTokens(message["usage"], f),
        cache: try cacheSample(message["usage"], f))
}

private func contextTokens(_ value: JsonValue?, _ f: Fields) throws -> Double? {
    guard let value, value != .null else { return nil }
    let usage = try f.object(value, "assistant.message.usage")
    let counts = try ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].map {
        try f.optionalNumber(usage[$0], "assistant.message.usage.\($0)")
    }
    if counts.allSatisfy({ $0 == nil }) { return nil }
    return counts.reduce(0) { $0 + ($1 ?? 0) }
}

private func cacheSample(_ value: JsonValue?, _ f: Fields) throws -> CacheSample? {
    guard let value, value != .null else { return nil }
    let at = "assistant.message.usage"
    let usage = try f.object(value, at)
    let write = try f.optionalNumber(usage["cache_creation_input_tokens"], "\(at).cache_creation_input_tokens")
    let read = try f.optionalNumber(usage["cache_read_input_tokens"], "\(at).cache_read_input_tokens")
    // A provider that reports no cache counts at all says nothing about a cache.
    if write == nil && read == nil { return nil }
    let split =
        usage["cache_creation"] == nil || usage["cache_creation"] == .null
        ? nil : try f.object(usage["cache_creation"], "\(at).cache_creation")
    return CacheSample(
        inputTokens: try f.optionalNumber(usage["input_tokens"], "\(at).input_tokens") ?? 0,
        outputTokens: try f.optionalNumber(usage["output_tokens"], "\(at).output_tokens") ?? 0,
        cacheWriteTokens: write ?? 0,
        cacheReadTokens: read ?? 0,
        write5mTokens: try split.flatMap {
            try f.optionalNumber($0["ephemeral_5m_input_tokens"], "\(at).cache_creation.ephemeral_5m_input_tokens")
        },
        write1hTokens: try split.flatMap {
            try f.optionalNumber($0["ephemeral_1h_input_tokens"], "\(at).cache_creation.ephemeral_1h_input_tokens")
        })
}

private func contextWindows(_ value: JsonValue?, _ f: Fields) throws -> [(String, Double)] {
    guard let value, value != .null else { return [] }
    let models = try f.object(value, "result.modelUsage")
    var windows: [(String, Double)] = []
    for (model, usage) in models {
        let path = "result.modelUsage.\(model)"
        if let window = try f.optionalNumber(try f.object(usage, path)["contextWindow"], "\(path).contextWindow") {
            windows.append((model, window))
        }
    }
    return windows
}

private func decodeUser(_ raw: JsonObject, _ f: Fields) throws -> ClaudeUser {
    let message = try f.object(raw["message"], "user.message")
    let content = message["content"]
    let blocks: [UserBlock]
    if case .string(let text)? = content {
        blocks = textBlock(text)
    } else {
        blocks = try f.array(content, "user.message.content").enumerated().flatMap { index, block in
            try decodeUserBlock(
                try f.object(block, "user.message.content[\(index)]"), "user.message.content[\(index)]", f)
        }
    }
    return ClaudeUser(
        parent: try f.parent(raw, "user"),
        uuid: try f.optionalString(raw["uuid"], "user.uuid"),
        content: blocks,
        toolResult: try decodeToolUseResult(raw["tool_use_result"], f))
}

private func decodeToolUseResult(_ value: JsonValue?, _ f: Fields) throws -> ToolUseResult {
    // A string is the words of a call that failed, and an array an MCP tool's
    // content blocks again: both are what the tool_result block already
    // carries, and neither starts a task.
    guard case .object(let result)? = value else { return NO_TOOL_RESULT }
    let at = "user.tool_use_result"
    func text(_ key: String) throws -> String? { try f.optionalString(result[key], "\(at).\(key)") }
    let path = try text("filePath")
    let hunks: [String] =
        result["structuredPatch"] == nil || result["structuredPatch"] == .null
        ? []
        : try f.array(result["structuredPatch"], "\(at).structuredPatch").enumerated().map { index, each in
            try unifiedHunk(try f.object(each, "\(at).structuredPatch[\(index)]"), "\(at).structuredPatch[\(index)]", f)
        }
    return ToolUseResult(
        launchedTask: result["status"] == .string("async_launched") ? try f.string(result["agentId"], "\(at).agentId") : nil,
        teammate: result["status"] == .string("teammate_spawned") ? try f.string(result["name"], "\(at).name") : nil,
        stdout: try text("stdout"),
        stderr: try text("stderr"),
        interrupted: result["interrupted"] == nil ? false : try f.boolean(result["interrupted"], "\(at).interrupted"),
        backgroundTask: try text("backgroundTaskId"),
        patch: path == nil || hunks.isEmpty ? nil : (path!, hunks.joined(separator: "\n")),
        persistedPath: try text("persistedOutputPath"),
        answered: result["answers"] == nil ? nil : try answeredQuestions(result, at, f))
}

private func answeredQuestions(_ result: JsonObject, _ at: String, _ f: Fields) throws -> AnsweredQuestions {
    let answers = try f.object(result["answers"], "\(at).answers")
    let annotations =
        result["annotations"] == nil || result["annotations"] == .null
        ? JsonObject() : try f.object(result["annotations"], "\(at).annotations")
    var notes: [String: String] = [:]
    for (question, annotation) in annotations {
        let path = "\(at).annotations[\(JsonValue.quoted(question))]"
        if let note = try f.optionalString(try f.object(annotation, path)["notes"], "\(path).notes"), note != "" {
            notes[question] = note
        }
    }
    var read: [String: AnswerValue] = [:]
    for (question, answer) in answers {
        let path = "\(at).answers[\(JsonValue.quoted(question))]"
        if case .array = answer {
            read[question] = .many(try f.array(answer, path).enumerated().map { index, each in
                try f.string(each, "\(path)[\(index)]")
            })
        } else {
            read[question] = .one(try f.string(answer, path))
        }
    }
    return AnsweredQuestions(questions: try decodeQuestions(result, at, f), answers: read, notes: notes)
}

/// One hunk of a `structuredPatch`, as a unified diff writes it.
private func unifiedHunk(_ hunk: JsonObject, _ at: String, _ f: Fields) throws -> String {
    func n(_ key: String) throws -> String { JsonValue.javaScriptNumber(try f.number(hunk[key], "\(at).\(key)")) }
    let lines = try f.array(hunk["lines"], "\(at).lines").enumerated().map { index, line in
        try f.string(line, "\(at).lines[\(index)]")
    }
    return (["@@ -\(try n("oldStart")),\(try n("oldLines")) +\(try n("newStart")),\(try n("newLines")) @@"] + lines)
        .joined(separator: "\n")
}

/// Whether a text is task notifications: it opens with one, bare or in a system reminder.
public func isTaskNotificationText(_ text: String) -> Bool {
    text.range(of: #"^\s*(?:<system-reminder>[\s\S]*?)?<task-notification>"#, options: .regularExpression) != nil
}

/// Every match of a regular expression with its capture groups (nil for a group that did not take part).
func matches(_ pattern: String, in text: String) -> [[String?]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { match in
        (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            guard range.location != NSNotFound, let swiftRange = Range(range, in: text) else { return nil }
            return String(text[swiftRange])
        }
    }
}

/// A text the CLI put in the conversation. One made of `<task-notification>`
/// elements is not anybody's words: it is how the CLI tells the model that a
/// background task ended (a session file records it so), and each element is
/// that task's end. Whatever wraps them (a system reminder) is the model's
/// reading aid, not something to draw.
func textBlock(_ text: String) -> [UserBlock] {
    if let command = commandBlock(text) { return command }
    if text.range(of: #"^\s*<teammate-message[\s>]"#, options: .regularExpression) != nil {
        return teammateMessages(text)
    }
    if !isTaskNotificationText(text) { return [.text(text)] }
    return matches(#"<task-notification>([\s\S]*?)</task-notification>"#, in: text).map { groups in
        let body = groups[1] ?? ""
        return .taskNotification(
            taskId: notificationField(body, "task-id"),
            toolUseId: notificationField(body, "tool-use-id"),
            status: notificationField(body, "status"),
            summary: notificationField(body, "summary"),
            raw: ["text": .string(text)])
    }
}

/// A text the CLI wrote of a command it ran itself, as the session file
/// records it: the command (`<command-name>` and `<command-args>`, or a
/// shell-mode `<bash-input>`), what it printed (`<local-command-stdout>` /
/// `-stderr`, `<bash-stdout>` / `-stderr`), or the caveat it puts before
/// them, which is for the model and is not drawn.
private func commandBlock(_ text: String) -> [UserBlock]? {
    guard let opening = matches(#"^\s*<([a-z-]+)>"#, in: text).first?[1] else { return nil }
    switch opening {
    case "local-command-caveat":
        return []
    case "command-name", "command-message":
        let name = notificationField(text, "command-name") ?? ""
        let args = JSString.trim(notificationField(text, "command-args") ?? "")
        let line = name.hasPrefix("/") ? name : "/\(name)"
        return [.command(line: args.isEmpty ? line : "\(line) \(args)")]
    case "bash-input":
        return [.command(line: "! \(notificationField(text, "bash-input") ?? "")")]
    case "local-command-stdout", "local-command-stderr", "bash-stdout", "bash-stderr":
        let family = opening.hasPrefix("bash") ? "bash" : "local-command"
        let stdout = plain(notificationField(text, "\(family)-stdout"))
        let stderr = plain(notificationField(text, "\(family)-stderr"))
        return [.commandOutput(output: [stdout, stderr].filter { !$0.isEmpty }.joined(separator: "\n"), failed: !stderr.isEmpty)]
    default:
        return nil
    }
}

/// Messages from teammates, as the CLI hands them to the model: each in a
/// `<teammate-message teammate_id="…">` element, its body words or one of the
/// team protocol's JSON messages (which may have words after it).
private func teammateMessages(_ text: String) -> [UserBlock] {
    matches(#"<teammate-message([^>]*)>([\s\S]*?)</teammate-message>"#, in: text).map { groups in
        let attributes = groups[1] ?? ""
        let from = matches(#"teammate_id="([^"]*)""#, in: attributes).first?[1] ?? ""
        let words = JSString.trim(groups[2] ?? "")
        return .teammateMessage(from: from, text: words, signal: teamSignal(words))
    }
}

private func teamSignal(_ words: String) -> TeamSignal? {
    guard words.hasPrefix("{") else { return nil }
    let firstLine = String(words.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
    // Words that open with a brace and are not the protocol's JSON: they are
    // words, drawn as such.
    guard let value = (try? JsonValue.parse(words)) ?? (try? JsonValue.parse(firstLine)),
          case .object(let object) = value, case .string(let type)? = object["type"]
    else { return nil }
    let failure = object["failureReason"]?.stringValue
    return TeamSignal(type: type, failure: failure == "" ? nil : failure)
}

/// A command's printout without the terminal's colours.
private func plain(_ text: String?) -> String {
    JSString.trim((text ?? "").replacingOccurrences(of: "\u{1b}\\[[0-9;]*m", with: "", options: .regularExpression))
}

/// The first `<name>` of a notification, as written (the CLI escapes nothing it would need undone here).
func notificationField(_ body: String, _ name: String) -> String? {
    guard let start = body.range(of: "<\(name)>") else { return nil }
    guard let end = body.range(of: "</\(name)>", range: start.upperBound..<body.endIndex) else { return nil }
    return String(body[start.upperBound..<end.lowerBound])
}

private func decodeUserBlock(_ block: JsonObject, _ at: String, _ f: Fields) throws -> [UserBlock] {
    let type = try f.string(block["type"], "\(at).type")
    switch type {
    case "text":
        return textBlock(try f.string(block["text"], "\(at).text"))
    case "tool_result":
        return [
            .toolResult(
                toolUseId: try f.string(block["tool_use_id"], "\(at).tool_use_id"),
                isError: block["is_error"] == nil ? false : try f.boolean(block["is_error"], "\(at).is_error"),
                parts: try toolResultParts(block["content"], "\(at).content", f))
        ]
    case "image":
        return [.image(try decodeImage(block, at, f))]
    default:
        return [.unknown(key: "content/\(type)", raw: block)]
    }
}

/// A tool result's content: a string, or blocks, each read as a message's blocks are.
private func toolResultParts(_ content: JsonValue?, _ at: String, _ f: Fields) throws -> [ResultPart] {
    guard let content, content != .null else { return [] }
    if case .string(let text) = content { return [.text(text)] }
    return try f.array(content, at).enumerated().map { index, each in
        let path = "\(at)[\(index)]"
        let block = try f.object(each, path)
        let type = try f.string(block["type"], "\(path).type")
        switch type {
        case "text": return .text(try f.string(block["text"], "\(path).text"))
        case "image": return .image(try decodeImage(block, path, f))
        case "tool_reference": return .reference(name: try f.string(block["tool_name"], "\(path).tool_name"))
        default: return .unknown(key: "tool_result/\(type)", raw: block)
        }
    }
}

/// An image block: its pixels inline (base64), or where they are (url).
private func decodeImage(_ block: JsonObject, _ at: String, _ f: Fields) throws -> ImageRef {
    let source = try f.object(block["source"], "\(at).source")
    let type = try f.string(source["type"], "\(at).source.type")
    switch type {
    case "base64":
        return ImageRef(
            mediaType: try f.string(source["media_type"], "\(at).source.media_type"),
            source: .data(base64: try f.string(source["data"], "\(at).source.data")), label: "image")
    case "url":
        let url = try f.string(source["url"], "\(at).source.url")
        return ImageRef(mediaType: "image/*", source: .url(url), label: url)
    // An image the API's file store holds: named by its id, not drawable here.
    case "file":
        let id = try f.string(source["file_id"], "\(at).source.file_id")
        return ImageRef(mediaType: "image/*", source: .file(path: id), label: id)
    default:
        throw f.fail("\(at).source.type", "\"base64\", \"url\" or \"file\", not \(JsonValue.quoted(type))")
    }
}

private func decodeResult(_ raw: JsonObject, _ f: Fields) throws -> ClaudeResult {
    let usage = raw["usage"] == nil || raw["usage"] == .null ? nil : try f.object(raw["usage"], "result.usage")
    return ClaudeResult(
        isError: try f.boolean(raw["is_error"], "result.is_error"),
        subtype: try f.string(raw["subtype"], "result.subtype"),
        durationMs: try f.optionalNumber(raw["duration_ms"], "result.duration_ms"),
        result: try f.optionalString(raw["result"], "result.result"),
        modelTurns: try f.optionalNumber(raw["num_turns"], "result.num_turns"),
        errors: try (raw["errors"] == nil ? [] : try f.array(raw["errors"], "result.errors")).enumerated().map {
            index, each in try f.string(each, "result.errors[\(index)]")
        },
        costUsd: try f.optionalNumber(raw["total_cost_usd"], "result.total_cost_usd"),
        usage: try usage.map { usage in
            ResultUsage(
                inputTokens: try f.optionalNumber(usage["input_tokens"], "result.usage.input_tokens"),
                outputTokens: try f.optionalNumber(usage["output_tokens"], "result.usage.output_tokens"),
                cacheReadTokens: try f.optionalNumber(usage["cache_read_input_tokens"], "result.usage.cache_read_input_tokens"))
        },
        contextWindows: try contextWindows(raw["modelUsage"], f))
}

/// A `rate_limit_event`. The CLI reports every window it tracks under
/// `unifiedWindows`, keyed by its name (`five_hour`, `seven_day`, …); the
/// top-level fields repeat one of them, named by `rateLimitType`. An event
/// without `unifiedWindows` reports that one window alone.
private func decodeRateLimit(_ raw: JsonObject, _ f: Fields) throws -> ClaudeLine {
    let at = "rate_limit_event.rate_limit_info"
    let info = try f.object(raw["rate_limit_info"], at)
    // The limiting window is named only when the CLI knows it
    // (`rateLimitType` is optional): an event that names none says nothing
    // about any one window.
    let limiting = try f.optionalString(info["rateLimitType"], "\(at).rateLimitType")
    let resetsAt = try f.optionalNumber(info["resetsAt"], "\(at).resetsAt")
    let windows: [(String, JsonObject, String)]
    if info["unifiedWindows"] == nil {
        windows = limiting.map { [($0, info, at)] } ?? []
    } else {
        windows = try f.object(info["unifiedWindows"], "\(at).unifiedWindows").map { key, value in
            let path = "\(at).unifiedWindows.\(key)"
            return (key, try f.object(value, path), path)
        }
    }
    return .rateLimit(
        windows: try windows.map { key, window, path in
            let utilization = try f.optionalNumber(window["utilization"], "\(path).utilization")
            let resetsAt = try f.optionalNumber(window["resetsAt"], "\(path).resetsAt")
            let (name, minutes) = claudeWindow(key)
            return RateLimit(
                window: name, durationMinutes: minutes,
                // A fraction on the wire; a percentage in the model.
                usedPercent: utilization.map { $0 * 100 },
                // Epoch seconds on the wire; milliseconds in the model.
                resetsAt: resetsAt.map { $0 * 1000 })
        },
        status: try f.optionalString(info["status"], "\(at).status"),
        // Epoch seconds on the wire; milliseconds in the model.
        resetsAt: resetsAt.map { $0 * 1000 })
}

/// The length of each window Claude names by a key (`unifiedWindows`,
/// `rateLimitType`, `get_usage`'s `rate_limits`) that Anthropic documents:
/// the five-hour session window and the seven-day one.
private let CLAUDE_WINDOW_MINUTES: [String: Double] = ["five_hour": 5 * 60, "seven_day": 7 * 24 * 60]

/// A window's name and length, decided once from Claude's key for it: a
/// window of known length is named by it, as Codex's are, and any other by
/// its own key, with no length.
private func claudeWindow(_ key: String) -> (String, Double?) {
    guard let minutes = CLAUDE_WINDOW_MINUTES[key] else {
        return (key.replacingOccurrences(of: "_", with: " "), nil)
    }
    return (rateLimitWindowName(minutes), minutes)
}

/// The windows `get_usage` names that DevHub shows: the two the stream's
/// `rate_limit_event` reports under the same keys.
private let CLAUDE_USAGE_WINDOWS = ["five_hour", "seven_day"]

/// The payload of the CLI's success response to `get_usage`
/// (`SDKControlGetUsageResponse`, marked experimental by the SDK).
///
/// `rate_limits_available: false` is a sign-in with no plan limits — an API
/// key, Bedrock — and says so. Otherwise the two windows are read strictly,
/// because the request is experimental: a shape other than the one decoded
/// here is a mismatch that says where, never a guess. Unlike the stream's
/// event, utilization is already 0–100 here and the reset an ISO time.
public func decodeUsage(_ payload: JsonObject?, version: String?) throws -> UsageReading? {
    let f = Fields(version: version)
    let at = "control_response(get_usage).response.response"
    let body = try f.object(payload.map(JsonValue.object), at)
    if !(try f.boolean(body["rate_limits_available"], "\(at).rate_limits_available")) { return .noPlanLimits }
    // The plan has limits but the CLI could not fetch them this time: no
    // reading, not a mismatch — the next request may have one.
    if body["rate_limits"] == .null { return nil }
    let limits = try f.object(body["rate_limits"], "\(at).rate_limits")
    return .windows(
        try CLAUDE_USAGE_WINDOWS.compactMap { key in
            // A window the account has not started is null: not reported.
            guard let value = limits[key], value != .null else { return nil }
            let path = "\(at).rate_limits.\(key)"
            let window = try f.object(value, path)
            let (name, minutes) = claudeWindow(key)
            return RateLimit(
                window: name, durationMinutes: minutes,
                usedPercent: try f.number(window["utilization"], "\(path).utilization"),
                resetsAt: try f.optionalTime(window["resets_at"], "\(path).resets_at"))
        })
}

/// A line of `in.log`. DevHub wrote every one of them, so a line of any other
/// shape is not the CLI's doing and not a version skew: it is DevHub's own
/// writer and reader disagreeing.
public func decodeSent(_ line: String) throws -> SentLine {
    let f = Fields(version: nil)
    let raw = try parse(line, f, "sent line")
    let type = try f.string(raw["type"], "sent line.type")
    switch type {
    case "user":
        let message = try f.object(raw["message"], "sent user.message")
        let originText = try f.string(raw[ORIGIN_KEY], "sent user.\(ORIGIN_KEY)")
        guard let origin = SentOrigin(rawValue: originText) else {
            throw f.fail(
                "sent user.\(ORIGIN_KEY)", SentOrigin.allCases.map { JsonValue.quoted($0.rawValue) }.joined(separator: " or "))
        }
        let content = message["content"]
        if case .string(let text)? = content { return .user(text: text, images: [], origin: origin) }
        var texts: [String] = []
        var images: [ImageRef] = []
        for (index, each) in try f.array(content, "sent user.message.content").enumerated() {
            let at = "sent user.message.content[\(index)]"
            let block = try f.object(each, at)
            switch try f.string(block["type"], "\(at).type") {
            case "text": texts.append(try f.string(block["text"], "\(at).text"))
            case "image": images.append(try decodeImage(block, at, f))
            default: throw f.fail("\(at).type", "\"text\" or \"image\"")
            }
        }
        return .user(text: texts.joined(separator: "\n"), images: images, origin: origin)
    case "control_request":
        let request = try f.object(raw["request"], "sent control_request.request")
        return .controlRequest(
            requestId: try f.string(raw["request_id"], "sent control_request.request_id"),
            subtype: try f.string(request["subtype"], "sent control_request.request.subtype"),
            request: request)
    case "control_response":
        let response = try f.object(raw["response"], "sent control_response.response")
        let requestId = try f.string(response["request_id"], "sent control_response.response.request_id")
        if try f.string(response["subtype"], "sent control_response.response.subtype") == "error" {
            return .controlRefusal(requestId: requestId)
        }
        let inner = try f.object(response["response"], "sent control_response.response.response")
        // A permission's answer says how it behaves; an elicitation's, what
        // the person did with it.
        let (key, answers): (String, [String]) =
            inner["behavior"] != nil ? ("behavior", ["allow", "deny"]) : ("action", ["accept", "decline", "cancel"])
        let path = "sent control_response.response.response.\(key)"
        let answer = try f.string(inner[key], path)
        guard answers.contains(answer), let sent = SentAnswer(rawValue: answer) else {
            throw f.fail(path, answers.map { "\"\($0)\"" }.joined(separator: " or "))
        }
        return .controlResponse(requestId: requestId, answer: sent)
    default:
        throw f.fail("sent line.type", "a line DevHub writes, not \(JsonValue.quoted(type))")
    }
}
