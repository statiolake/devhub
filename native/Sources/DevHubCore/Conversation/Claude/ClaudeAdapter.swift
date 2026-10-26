// Port of apps/desktop/src/main/agent/conversation/claude/adapter.ts
//
// Claude's stream-json conversation, as a `ProtocolAdapter`.
//
// # Entry ids
//
// Every entry's id is built from the CLI's own ids, so the same lines always
// make the same transcript — live, or replayed from the journal by another
// boot of DevHub (this app's or the TS app's):
//
// - `user:<uuid>` for a user message, by the uuid the CLI gave its echo;
// - `assistant:<message id>:<first block>` for a run of text and thinking
//   blocks of one message. A message that says something, calls a tool and
//   says something more is two assistant entries with the tool between them,
//   so the transcript keeps the order it was said in;
// - `tool:<tool_use id>` for a tool call; a subagent's entries name the call
//   that started it (`parent_tool_use_id`) as their parent;
// - `notice:<n>` and `turn:<n>`, counted, for what has no id of its own.
//
// # Streaming
//
// `stream_event`s open a message and its blocks and grow them by deltas; the
// complete `assistant` message that follows each block finalizes it. The CLI
// prints the complete message one block at a time, so the n-th block of all
// complete messages with one id is the n-th block that streamed. A message
// that never streamed (a subagent's, without partial messages) arrives whole
// and final from its complete messages alone, through the same code.
//
// # User messages
//
// A user message is written with the origin DevHub gave it (`devhub_origin`),
// and it enters the transcript when the CLI echoes it back
// (`--replay-user-messages`): that is when the CLI took it, which puts it in
// its true place among the CLI's own lines, and it is when the turn starts.
// An echo is matched to the first message DevHub sent with the same text. A
// user message DevHub did not send (`[Request interrupted by user]`, the text
// of a command's output) is shown as a notice — it is the CLI speaking, not
// the person.

import Foundation

/// Commands DevHub answers with its own picker rather than sending: the
/// header picker of a setting, or the Workspace's earlier sessions.
private let PICKED: [String: SlashRoute] = [
    "model": .model, "effort": .effort, "permissions": .mode, "resume": .resume, "restart": .restart, "mcp": .mcp,
]

/// DevHub's own commands, offered whether or not the CLI lists them:
/// `/resume`, since stream-json has no picker of its own, `/restart`, since
/// only DevHub can start the CLI again, and `/mcp`, since -p mode has no MCP
/// panel of its own.
private let DEVHUB_COMMANDS: [InitializeCommand] = [
    InitializeCommand(name: "resume", description: "Go on with an earlier session in this Workspace", argumentHint: nil),
    InitializeCommand(
        name: "restart", description: "Restart the session: start the CLI again, reconnecting its MCP servers",
        argumentHint: nil),
    InitializeCommand(
        name: "mcp", description: "MCP servers: how each stands, reconnect, enable or disable, sign in",
        argumentHint: nil),
]

/// Claude's word for an MCP server's status, in the conversation's vocabulary.
private func mcpStatus(_ said: String) -> McpServerStatus {
    switch said {
    case "connected": return .connected
    case "needs-auth": return .needsSignIn
    case "failed": return .failed
    case "pending": return .connecting
    case "disabled": return .disabled
    default: return .unknown
    }
}

/// What the panel offers for a server that stands so: each a documented
/// control request (`mcp_reconnect`, `mcp_toggle`) or the documented
/// `claude mcp login`. A server still connecting is left to finish.
private func mcpActions(_ status: McpServerStatus) -> [McpAction] {
    switch status {
    case .connected, .failed, .unknown: return [.reconnect, .disable]
    case .needsSignIn: return [.signIn, .reconnect, .disable]
    case .connecting: return [.disable]
    case .disabled: return [.enable]
    }
}

/// The person's MCP request a control request of DevHub's is, if it is one.
private func mcpWorking(_ request: JsonObject) -> [McpWork] {
    guard case .string(let server)? = request["serverName"] else { return [] }
    if request["subtype"] == "mcp_reconnect" { return [McpWork(server: server, action: .reconnect)] }
    if request["subtype"] == "mcp_toggle" {
        return [McpWork(server: server, action: request["enabled"] == .bool(true) ? .enable : .disable)]
    }
    return []
}

/// How a refused MCP request reads in the panel.
private let MCP_ACTION_NAMES: [String: String] = [
    "mcp_status": "Listing the MCP servers",
    "mcp_reconnect": "Reconnecting",
    "mcp_toggle": "Enabling or disabling",
]

/// Commands that only work in the TUI; "continue in terminal" is the way to them.
private let TUI_ONLY: Set<String> = ["login", "logout"]

/// The values `--permission-mode` takes, and the one the CLI reports when none was given.
let CLAUDE_MODES: [SettingChoice] = [
    SettingChoice(id: "default", label: "Default"),
    SettingChoice(id: "acceptEdits", label: "Accept edits"),
    SettingChoice(id: "plan", label: "Plan"),
    SettingChoice(id: "auto", label: "Auto"),
    SettingChoice(id: "dontAsk", label: "Don't ask"),
    SettingChoice(id: "bypassPermissions", label: "Bypass permissions"),
]

/// `/^\/effort\s+(\S+)\s*$/`: the level an `/effort` command sets.
private func effortCommand(_ text: String) -> String? {
    matches(#"^/effort\s+(\S+)\s*$"#, in: text).first?[1] ?? nil
}

/// The suffix that picks a model's 1M token context window, on an alias or a
/// full model name alike (`opus[1m]`, `claude-opus-4-8[1m]`).
private let LONG_CONTEXT = "[1m]"

/// The handshake's choice a model name is: the choice by that value (what
/// `set_model` was given), else one that resolves to it — a named alias
/// before `default`, which resolves to whatever the default is today.
private func listedAs(_ models: [InitializeModel], _ name: String) -> InitializeModel? {
    models.first { $0.id == name }
        ?? models.first { $0.id != "default" && $0.resolved == name }
        ?? models.first { $0.resolved == name }
}

/// How a model choice reads, in the picker's list and as its current value
/// alike: the full model name the session would report for it, and the value
/// `/model` is given for it when that is another name (`opus`, `default`),
/// so two choices that resolve to the same model today still read apart. The
/// CLI's own display name goes beside it (`detail`).
private func modelChoice(_ value: String, _ resolved: String?, _ displayName: String?) -> SettingChoice {
    SettingChoice(
        id: value,
        label: resolved == nil || resolved == value ? value : "\(resolved!) (\(value))",
        detail: displayName,
        resolved: resolved)
}

/// What a message the CLI wrote itself (an error, an interruption) names as its model.
private let SYNTHETIC_MODEL = "<synthetic>"

/// The tools that start a subagent.
private let SUBAGENT_TOOLS: Set<String> = ["Task", "Agent"]

/// A subagent whose starting call this transcript never drew (`parentOf`), in the words its card has.
private let EARLIER_SUBAGENT = "A subagent started earlier in this session"

private let NO_USAGE = Usage()

private let ALLOW_ONCE = RequestChoice(id: "allow", label: "Allow once", tone: .allow, takesText: false)
private let DENY = RequestChoice(id: "deny", label: "Deny", tone: .deny, takesText: true)
private let DECLINE_QUESTIONS = RequestChoice(id: "deny", label: "Decline", tone: .deny, takesText: true)

/// The `error` of an assistant message whose request the API refused as unauthenticated.
private let SIGNED_OUT = "authentication_failed"
/// How to sign claude in again, in its documented commands (CLI reference).
let CLAUDE_SIGN_IN =
    "Sign in with `claude auth login` (or `/login` in claude) in a terminal on this Agent's machine, then try again."
/// The API error of an answer a usage or rate limit refused (`SDKAssistantMessageError`).
private let RATE_LIMITED = "rate_limit"

private let DENIED_WITHOUT_WORDS = "The person denied this in DevHub."

/// The first CLI whose print mode resumes a session cut after a message
/// (`--resume-session-at`, the Agent SDK's `resumeSessionAt`) together with
/// `--resume-drops-turn`, documented as needing it. DevHub does not pass
/// `--resume-drops-turn`: it declares the one turn a cut drops and refuses a
/// cut that drops more, and a rewind drops every turn after the cut.
let RESUMES_AT_A_MESSAGE = [2, 1, 223]

/// Said after the `/compact` DevHub sent by itself (`CacheKeeper`).
let AUTO_COMPACTED =
    "Auto-compacted to keep the prompt cache warm: the conversation was idle and its cache was about to expire."

/// One block of a message, as far as it has come.
private enum Slot {
    case segment(kind: SegmentKind, entry: EntryId, block: Int, final: Bool)
    case tool(entry: EntryId, id: String)
    /// A thinking block with no text yet. The API may withhold thinking and
    /// send only its signature, so the block is drawn once it has something
    /// to say, and never if it has not.
    case unsaid
    case ignored
}

private enum SegmentKind: String {
    case text, thinking
}

private final class MessageState {
    let id: String
    let parent: EntryId?
    var slots: [Int: Slot] = [:]
    /// How many of its blocks complete messages have delivered.
    var finals = 0

    init(id: String, parent: EntryId?) {
        self.id = id
        self.parent = parent
    }
}

/// A permission request (`can_use_tool`).
private struct Permission {
    let input: JsonObject
    let suggestions: [JsonObject]
    let choices: [RequestChoice]
    let asksQuestions: Bool
    let entry: EntryId?
}

/// A request of the CLI's that DevHub has not answered.
private enum Pending {
    case permission(Permission)
    /// An MCP server's elicitation, which is about no call.
    case elicitation(Elicitation)

    var entry: EntryId? {
        if case .permission(let permission) = self { return permission.entry }
        return nil
    }
}

/// A user message DevHub wrote, waiting for the end of the turn that answers it.
private struct Unanswered {
    let message: SendingMessage
    /// The CLI echoed it into the conversation: drawn as an entry, no longer sending.
    var taken: Bool
}

public final class ClaudeAdapter: ProtocolAdapter {
    private var current = Transcript.empty
    private var spent = false
    private var events: [ConversationEvent] = []
    private var replies: [String] = []

    /// Names this boot of DevHub in the ids of its control requests, so none repeats across restarts.
    private let bootId: String
    /// Ms since the epoch: when a response without a timestamp of its own was received.
    private let now: () -> Double

    private var nextRequest = 1
    /// Control requests DevHub wrote that the CLI has not answered, by id, in order.
    private var ours = JsonObject()
    /// The user messages DevHub wrote that the CLI has not answered yet,
    /// oldest first: each until the end of the turn that answers it (the
    /// `result`), whatever the CLI printed or did not print on the way.
    /// `taken` once the CLI echoed it into the conversation; until then it is
    /// drawn as sending.
    private var unanswered: [Unanswered] = []
    /// How many user messages DevHub has written: what names each while it is sending.
    private var written = 0
    private var pending: [String: Pending] = [:]
    private var denied = Set<EntryId>()
    /// The CLI's requests DevHub has answered. The CLI prints each answer back
    /// (as it replays user messages), and an echo is not a response to a
    /// request of DevHub's own.
    private var answered = Set<String>()
    /// DevHub asked the running turn to stop.
    private var interrupting = false
    /// What of a usage limit the turn under way has been told: the model's
    /// answer was the API's `rate_limit` error (`limitAnswered`), and the
    /// reset of the window a `rate_limit_event` with status `rejected` named
    /// (`rejected`, whose `resetsAt` may be unknown). Read when the turn ends.
    private var limitAnswered = false
    private var rejected: LimitStop?
    /// The end of the last turn, when a usage limit stopped it and the CLI
    /// has not said when that limit resets: a `rate_limit_event` that says so
    /// before the next turn starts fills it in.
    private var unresetLimit: EntryId?
    /// The subagent call each background task belongs to, by task id.
    private var tasks: [String: EntryId] = [:]
    /// When each call was made, by the CLI's own clock.
    private var callTimes: [EntryId: Double] = [:]
    /// The call that spawned each teammate, by the name its messages come from, in order.
    private var teammates: [(String, EntryId)] = []
    /// The tasks the CLI last said it has working in the background.
    private var background: [ClaudeBackgroundTaskInfo] = []

    private var messages: [String: MessageState] = [:]
    /// The message streaming now, per parent (nil for the top level).
    private var streaming: [EntryId?: MessageState] = [:]

    private var described: [InitializeCommand] = []
    /// The models the handshake listed; none known until it answers.
    private var models: [InitializeModel]?
    /// The model the top level last wrote with: whose context window the usage is measured against.
    private var mainModel: String?
    private var announced: [String] = []
    /// The session's MCP servers as the CLI last reported them; nil until it has.
    private var mcpServers: [McpServerState]?
    /// The plugins the CLI last said did not load (`system/init`).
    private var pluginErrors: [PluginError] = []
    /// The last MCP request of the person's the CLI refused (`McpState.failure`).
    private var mcpFailure: String?
    private var unknownSeen = Set<String>()
    private var notices = 0
    private var commandCount = 0
    private var compactions = 0
    /// The main conversation's prompt cache, from each response's usage.
    private var promptCache = PromptCacheTracker()
    /// The last message the prompt cache counted: the CLI writes one line per block.
    private var promptCacheMessage: String?
    private var turns = 0
    private var users = 0

    /// The uuid of the last top-level message the session holds: where a resume would cut it now.
    private var lastUuid: String?
    /// For each of the person's messages that has a uuid, where a resume cuts
    /// the session to leave that message out: the message before it, or
    /// `.some(nil)` for the first, which leaves nothing to resume.
    private var cutBefore: [EntryId: String?] = [:]
    private var cutOrder: [EntryId] = []

    public init(bootId: String, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.bootId = bootId
        self.now = now
    }

    public var transcript: Transcript { current }

    public func opening() throws -> [String] {
        try refuseIfSpent()
        return [controlRequest(["subtype": "initialize"])]
    }

    public func encode(_ command: ConversationCommand) throws -> [String] {
        try refuseIfSpent()
        switch command {
        case .send(let text, let images, let origin):
            return [try userLine(text, images, origin, midTurn: running())]
        case .instruct:
            throw AdapterRefusal(
                "Claude Code's stream-json has no way to say something to a subagent, so no subagent takes the person's messages")
        case .interrupt:
            return [controlRequest(["subtype": "interrupt"])]
        case .stopTask(let task):
            _ = try requireStoppable(current.backgroundTasks, task)
            return [controlRequest(["subtype": "stop_task", "task_id": .string(task)])]
        case .answer(let request, let answer):
            return [try answerLine(request, answer)]
        case .mcp(let request):
            return [controlRequest(try mcpRequest(request))]
        }
    }

    /// The control request that carries an MCP request: the SDK's
    /// `mcpServerStatus()`, `reconnectMcpServer(name)` and
    /// `toggleMcpServer(name, enabled)`. An action the adapter does not offer
    /// for that server now is DevHub's bug: the panel draws only the offered.
    private func mcpRequest(_ request: McpRequest) throws -> JsonObject {
        guard case .act(let action, let name) = request else { return ["subtype": "mcp_status"] }
        guard let server = current.mcp.servers?.first(where: { $0.name == name }), server.actions.contains(action) else {
            throw AdapterRefusal("\(action.rawValue) is not offered for the MCP server \(name) now")
        }
        switch action {
        case .reconnect: return ["subtype": "mcp_reconnect", "serverName": .string(name)]
        case .enable, .disable:
            return ["subtype": "mcp_toggle", "serverName": .string(name), "enabled": .bool(action == .enable)]
        case .signIn:
            throw AdapterRefusal("sign-in is not offered for the MCP server \(name) now")
        }
    }

    public func configure(_ which: SettingName, _ id: String) throws -> AdapterStep {
        try step {
            switch which {
            case .model: replies.append(controlRequest(["subtype": "set_model", "model": .string(id)]))
            case .mode: replies.append(controlRequest(["subtype": "set_permission_mode", "mode": .string(id)]))
            case .effort: replies.append(try userLine("/effort \(id)", [], .person))
            }
        }
    }

    public func rewind(_ message: EntryId) throws -> RewindPlan {
        try refuseIfSpent()
        let session = current.session
        guard session.canRewind, let sessionId = session.sessionId else {
            throw AdapterRefusal(
                "claude \(session.agentVersion ?? "(version unknown)") cannot take back a turn: resuming at a message needs \(RESUMES_AT_A_MESSAGE.map(String.init).joined(separator: ".")) or later")
        }
        if !rewindTargets(current).contains(message) {
            throw AdapterRefusal("\(message) is not a message the conversation can be rewound to now")
        }
        guard let cut = cutBefore[message] else {
            throw AdapterRefusal(
                "\(message) has no place in the session DevHub knows of, so its turn cannot be taken back")
        }
        let mark: JsonValue = ["type": "devhub_rewind", "message": .string(message.raw)]
        return .restart(
            RestartPlan(
                session: cut.map { ["--resume", sessionId, "--resume-session-at", $0] } ?? [],
                mark: [mark.jsonText]))
    }

    public func resumeSession(_ session: String, history: [String]) throws -> RewindPlan {
        try refuseIfSpent()
        guard current.state == .ready(turn: .none), current.requests.isEmpty else {
            throw AdapterRefusal("the Claude conversation is not idle, so it cannot go on with another session now")
        }
        let mark: JsonValue = ["type": "devhub_resume", "session": .string(session)]
        return .restart(RestartPlan(session: ["--resume", session], mark: [mark.jsonText] + history))
    }

    public func restart() throws -> RestartPlan {
        try refuseIfSpent()
        return RestartPlan(session: current.session.sessionId.map { ["--resume", $0] } ?? [], mark: [RESTART_MARK])
    }

    public func sent(_ line: String) throws -> AdapterStep {
        try step {
            switch try decodeSent(line) {
            case .user(let text, let images, let origin):
                written += 1
                unanswered.append(
                    Unanswered(
                        message: SendingMessage(id: "sent:\(written)", text: text, images: images, origin: origin),
                        taken: false))
                try emitSending()
                // A message written is a turn under way until the CLI ends
                // the turn that answers it.
                if current.state == .ready(turn: .none) { try turn(.running) }
                if let effort = effortCommand(text) {
                    var session = current.session
                    session.effort.current = effort
                    try setSession(session)
                }
            case .controlRequest(let requestId, let subtype, let request):
                ours[requestId] = .object(request)
                if subtype == "interrupt" { interrupting = true }
                // The person's next MCP request: what the last one ended in
                // has been read, and this one's outcome replaces it.
                if subtype == "mcp_reconnect" || subtype == "mcp_toggle" { mcpFailure = nil }
            case .controlResponse(let requestId, let answer):
                answered.insert(requestId)
                // Cancelled by the CLI before the answer reached it: already closed.
                guard let request = pending.removeValue(forKey: requestId) else { return }
                if answer == .deny, let entry = request.entry { denied.insert(entry) }
                try emit(.requestClosed(RequestId(requestId)))
            case .controlRefusal:
                return
            }
        }
    }

    public func received(_ line: String) throws -> AdapterStep {
        try step {
            try take(try decodeReceived(line, version: current.session.agentVersion))
            try reportBackground()
        }
    }

    // MARK: - Bookkeeping

    private func refuseIfSpent() throws {
        if spent {
            throw AdapterRefusal(
                "this Claude adapter is spent: an earlier line broke it, and it takes nothing further")
        }
    }

    /// Runs one call. A throw leaves the adapter spent, since its bookkeeping may be half-updated.
    private func step(_ work: () throws -> Void) throws -> AdapterStep {
        try refuseIfSpent()
        spent = true
        events = []
        replies = []
        try work()
        try publishMcp()
        spent = false
        return AdapterStep(events: events, replies: replies)
    }

    /// The MCP servers as they stand after a step, emitted when that is news:
    /// what the CLI last reported, the person's requests it has not answered
    /// (the MCP control requests of `ours`), and the last it refused.
    private func publishMcp() throws {
        let mcp = McpState(
            servers: mcpServers?.map { server in
                let status = mcpStatus(server.status)
                return McpServer(
                    name: server.name, status: status, said: server.status, error: server.error, source: server.scope,
                    actions: mcpActions(status))
            },
            pluginErrors: pluginErrors,
            working: ours.values.compactMap(\.objectValue).flatMap(mcpWorking),
            failure: mcpFailure)
        if mcp == current.mcp { return }
        try emit(.mcp(mcp))
    }

    private func emit(_ event: ConversationEvent) throws {
        current = try applyEvent(current, event)
        events.append(event)
    }

    private func mismatch(_ path: String, _ expected: String) -> ProtocolMismatch {
        ProtocolMismatch(path: path, expected: expected, agentVersion: current.session.agentVersion)
    }

    private func controlRequest(_ request: JsonObject) -> String {
        let id = "\(bootId):\(nextRequest)"
        nextRequest += 1
        let line: JsonValue = ["type": "control_request", "request_id": .string(id), "request": .object(request)]
        return line.jsonText
    }

    private func answerLine(_ request: RequestId, _ answer: RequestAnswer) throws -> String {
        guard let pending = pending[request.raw] else {
            throw AdapterRefusal("request \(request) is not pending, so it cannot be answered")
        }
        let response: JsonObject
        switch pending {
        case .permission(let permission): response = try answerResponse(permission, answer, request)
        case .elicitation(let elicitation): response = try elicitationResponse(elicitation, answer, request)
        }
        let line: JsonValue = [
            "type": "control_response",
            "response": ["subtype": "success", "request_id": .string(request.raw), "response": .object(response)],
        ]
        return line.jsonText
    }

    private func find(_ id: EntryId) -> TranscriptEntry? {
        indexOfEntry(current.entries, id).map { current.entries[$0] }
    }

    private func tool(_ id: EntryId) -> ToolEntry? {
        find(id)?.toolEntry
    }

    /// The call a message's `parent_tool_use_id` names: the one that started
    /// the subagent the message is from.
    ///
    /// A subagent outlives what DevHub drew of its session. Its transcript is
    /// kept apart from the conversation, through a compaction and across a
    /// restart, and `SendMessage` wakes it again with its messages still
    /// naming the call that first started it. So that call can be one this
    /// transcript never drew: made before the history DevHub read back
    /// begins, or cut by a rewind. Such a call is drawn where its subagent is
    /// first heard of, as a subagent from earlier in the session whose state
    /// nothing here says, and the subagent's messages go under it as under
    /// any other call.
    private func parentOf(_ parent: String?) throws -> EntryId? {
        guard let parent else { return nil }
        let id = toolEntryId(parent)
        if tool(id) == nil {
            try emit(
                .entry(
                    .tool(
                        ToolEntry(
                            id: id, parent: nil, tool: "Agent",
                            title: toolTitle("Agent", ["description": .string(EARLIER_SUBAGENT)]),
                            input: .object(JsonObject()), status: .succeeded,
                            spawns: SubagentInfo(
                                label: EARLIER_SUBAGENT, prompt: "", model: nil, state: .unknown, takesMessages: false)))))
        }
        return id
    }

    private func setSession(_ next: SessionFacts) throws {
        if next == current.session { return }
        try emit(.session(next))
    }

    private func patchSession(_ change: (inout SessionFacts) -> Void) throws {
        var next = current.session
        change(&next)
        try setSession(next)
    }

    private func commands() -> [SlashCommand] {
        let describedNames = Set(described.map(\.name))
        let announcedCommands = announced.filter { !describedNames.contains($0) }.map {
            InitializeCommand(name: $0, description: "", argumentHint: nil)
        }
        let listed = described + announcedCommands
        return (listed + DEVHUB_COMMANDS.filter { own in !listed.contains { $0.name == own.name } })
            .filter { !TUI_ONLY.contains($0.name) }
            .map {
                SlashCommand(
                    trigger: .slash, name: $0.name, description: $0.description, argumentHint: $0.argumentHint,
                    route: PICKED[$0.name] ?? .message)
            }
    }

    /// The model a session reports, as one of the choices the handshake
    /// listed, and the effort that model takes. Every way a session names its
    /// model — `system/init` on a fresh start, a resume, a rewind; a
    /// `set_model` the CLI agreed to — comes here, so they all read the same.
    ///
    /// A session names its model in full (`claude-haiku-4-5-…`) and the
    /// choices are aliases (`haiku`), so the choice is found by what it
    /// resolves to (`listedAs`). A resumed session keeps the model its
    /// transcript was saved with, whatever the current setting, so it can
    /// report a model the list does not resolve to — typically the 1M context
    /// variant (`claude-opus-5-5[1m]`) of a model the list offers only as
    /// `opus`. That name is itself a value `/model` takes, so it is a choice
    /// of its own, under its own name. Its effort levels are the model's: the
    /// `[1m]` suffix picks the context window, not the model, so they are
    /// those of the choice the name without the suffix resolves to. A model
    /// the list names in neither form has no effort levels DevHub could
    /// offer, and the effort says so.
    ///
    /// The effort is the one the session last said it runs at
    /// (`system/init`'s `effort`) or was set to here with `/effort`. An effort
    /// nothing named is whatever the CLI resolves, and it stays unnamed.
    private func modelSettings(_ reported: String?, _ effort: String?) -> (model: Setting, effort: Setting) {
        let models = self.models ?? []
        let listed = reported.flatMap { listedAs(models, $0) }
        // Until the handshake has listed the models, nothing is known to be missing.
        let own = reported != nil && self.models != nil && listed == nil ? reported : nil
        let model = listed ?? own.flatMap { own in
            own.hasSuffix(LONG_CONTEXT) ? listedAs(models, String(own.dropLast(LONG_CONTEXT.count))) : nil
        }
        let efforts = model?.efforts ?? []
        return (
            Setting(
                current: listed?.id ?? reported,
                choices: (own.map { [modelChoice($0, $0, nil)] } ?? [])
                    + models.map { modelChoice($0.id, $0.resolved, $0.label) }),
            Setting(
                current: effort.flatMap { efforts.contains($0) ? $0 : nil },
                choices: efforts.map { SettingChoice(id: $0, label: $0) },
                unchangeable: own != nil && model == nil
                    ? "claude's model list does not name \(own!), so its effort levels are not known here" : nil)
        )
    }

    private func setModelSettings(_ reported: String?, _ effort: String?) throws {
        let (model, effortSetting) = modelSettings(reported, effort)
        try patchSession {
            $0.model = model
            $0.effort = effortSetting
        }
    }

    /// The CLI is up: a conversation that was connecting, or waiting for a CLI started again, is ready.
    private func becomeReady() throws {
        if current.state == .connecting || current.state == .ready(turn: .rewinding) {
            try turn(unanswered.isEmpty ? .none : .running)
        }
    }

    /// The host started the CLI again without the turns from `message` on.
    /// What DevHub kept about the CLI that is gone goes with it, and the new
    /// one is greeted as the first was: a reply, so a replay does not greet
    /// it twice.
    private func takeRewind(_ message: EntryId) throws {
        try endBackground()
        try emit(.rewound(from: message))
        lastUuid = cutBefore[message] ?? nil
        let kept = Set(current.entries.map(\.id))
        for id in cutOrder where !kept.contains(id) { cutBefore.removeValue(forKey: id) }
        cutOrder.removeAll { !kept.contains($0) }
        ours = JsonObject()
        unanswered.removeAll()
        try emitSending()
        answered.removeAll()
        streaming.removeAll()
        interrupting = false
        try processEnded(current.entries)
        try forgetEffort()
        try turn(.rewinding)
        replies.append(controlRequest(["subtype": "initialize"]))
    }

    /// A CLI started again on this session (a rewind, Restart session) keeps
    /// its model — the transcript's — but not an effort set with `/effort`,
    /// which `-p` applies to that process only: it resolves the effort afresh,
    /// so the effort is unnamed again.
    private func forgetEffort() throws {
        try setModelSettings(current.session.model.current, nil)
    }

    /// The host started the CLI again on another session. Everything DevHub
    /// kept about the one it left goes; that session's past follows as
    /// history lines, and the new CLI is greeted as a rewound one is.
    private func takeResume(_ session: String) throws {
        try endBackground()
        try emit(.sessionSwitched(session: session))
        // The CLI started on the other session takes that session's model,
        // read from its history below (`takeAssistant`) until it names it,
        // and resolves its effort afresh: neither is the session it left.
        try setModelSettings(nil, nil)
        lastUuid = nil
        cutBefore.removeAll()
        cutOrder.removeAll()
        ours = JsonObject()
        unanswered.removeAll()
        try emitSending()
        pending.removeAll()
        denied.removeAll()
        answered.removeAll()
        messages.removeAll()
        streaming.removeAll()
        tasks.removeAll()
        teammates.removeAll()
        callTimes.removeAll()
        interrupting = false
        try turn(.rewinding)
        replies.append(controlRequest(["subtype": "initialize"]))
    }

    /// The host stopped the CLI and started it again on the same session: the
    /// conversation stays, and nothing the CLI that was stopped had going
    /// goes on (`restarted`). What DevHub kept about that CLI goes with it,
    /// and the new one is greeted as a rewound one is.
    private func takeRestart() throws {
        background = []
        try emit(.restarted)
        try notice(.info, RESTARTED, nil)
        ours = JsonObject()
        unanswered.removeAll()
        pending.removeAll()
        answered.removeAll()
        streaming.removeAll()
        interrupting = false
        try forgetEffort()
        // Not `turn`, which never moves a broken conversation: a new CLI is
        // the one thing that ends what the stopped one said (signed out, a
        // refused handshake), and it is greeted afresh.
        try emit(.state(.ready(turn: .rewinding)))
        replies.append(controlRequest(["subtype": "initialize"]))
    }

    /// Where a resume would now cut the session: after this top-level message.
    private func placed(_ uuid: String?, _ parent: EntryId?) {
        if parent == nil, let uuid { lastUuid = uuid }
    }

    /// Whether a turn is running.
    private func running() -> Bool {
        current.state == .ready(turn: .running)
    }

    /// The one way the state moves, and it never moves a broken conversation:
    /// what broke it stays the last word, whatever the CLI goes on to print
    /// about the turn it was in.
    private func turn(_ turn: TurnState) throws {
        if case .broken = current.state { return }
        if current.state == .ready(turn: turn) { return }
        if turn == .running {
            // A turn starts: what a limit said of the last one is over.
            limitAnswered = false
            rejected = nil
            unresetLimit = nil
        }
        try emit(.state(.ready(turn: turn)))
    }

    /// What works in the background, as the transcript has it, after each
    /// line: each task the CLI lists, with the call that started it once a
    /// task event or the call's result has named it, and each teammate at
    /// work that the list does not already name. A subagent that sits idle
    /// waiting to be told something is not working, whatever the list says.
    /// Re-read after every line, because the list, the call a task belongs to
    /// and a subagent's state each arrive on lines of their own, in no fixed
    /// order.
    private func reportBackground() throws {
        var running: [RunningTask] = []
        for task in background {
            let call = tasks[task.taskId]
            let tool = call.flatMap { self.tool($0) }
            if tool?.spawns?.state == .idle { continue }
            running.append(
                RunningTask(
                    id: task.taskId, kind: TASK_KINDS[task.taskType] ?? task.taskType, title: task.description,
                    call: tool?.id, startedAt: tool.flatMap { callTimes[$0.id] },
                    // The SDK's `stop_task` stops any task the CLI lists.
                    stoppable: .yes))
        }
        for (name, call) in teammates {
            guard let tool = self.tool(call), let spawns = tool.spawns, spawns.state == .running else { continue }
            if running.contains(where: { $0.call == call }) { continue }
            running.append(
                RunningTask(
                    id: "teammate:\(name)", kind: "teammate", title: spawns.label, call: call,
                    startedAt: callTimes[call],
                    // Only the tasks the CLI lists are documented to take `stop_task`.
                    stoppable: .no(reason: TEAMMATE_UNSTOPPABLE)))
        }
        if sameRunningTasks(running, current.backgroundTasks) { return }
        try emit(.backgroundTasks(running))
    }

    /// The CLI that ran them is being replaced (a rewind, a resume): nothing
    /// it had working in the background is, before what it started is taken back.
    private func endBackground() throws {
        background = []
        if !current.backgroundTasks.isEmpty { try emit(.backgroundTasks([])) }
    }

    /// The messages written and not yet taken, as the transcript shows them sending.
    private func emitSending() throws {
        try emit(.sending(unanswered.filter { !$0.taken }.map(\.message)))
    }

    /// Whether the CLI is compacting the conversation now: a turn is under way while it does.
    private func setCompacting(_ compacting: Bool) throws {
        if compacting {
            try turn(.running)
            if !running() { return }
        }
        if current.compacting != compacting { try emit(.compacting(compacting)) }
    }

    /// The messages a turn's end answers, out of those waiting for one. The
    /// CLI reads its input in order, so it has answered every message up to
    /// the last one this turn took in (echoed); when the turn took none, it
    /// answered the oldest. A message it answered without echoing it — a
    /// command it ran by itself (`/compact`, `/clear`, `/cost`), or anything
    /// else it printed nothing of — is answered all the same, and drawn where
    /// it was sending: as the command line, or as the person's words. With
    /// nothing waiting, the turn was one the CLI started by itself.
    private func answer(_ line: ClaudeResult) throws {
        let last = unanswered.lastIndex { $0.taken } ?? -1
        let count = min(unanswered.count, last >= 0 ? last + 1 : 1)
        let answeredNow = Array(unanswered.prefix(count))
        unanswered.removeFirst(count)
        for each in answeredNow where !each.taken {
            let message = each.message
            if invocation(message.text) != nil {
                try emit(
                    .entry(
                        .command(
                            CommandEntry(
                                id: EntryId("command:\(message.id)"), line: JSString.trim(message.text),
                                // What the CLI said, when it answered without the model.
                                output: line.modelTurns == 0 && line.result != "" ? line.result : nil,
                                failed: line.isError))))
            } else {
                try emit(
                    .entry(
                        .user(
                            UserEntry(
                                id: EntryId("user:\(message.id)"), text: message.text, images: message.images,
                                origin: UserOrigin(message.origin), rewindable: false))))
            }
            if message.origin == .autoCompact { try notice(.info, AUTO_COMPACTED, nil) }
        }
        if answeredNow.contains(where: { !$0.taken }) { try emitSending() }
    }

    private func notice(_ level: NoticeLevel, _ text: String, _ raw: JsonValue?, parent: EntryId? = nil) throws {
        notices += 1
        try emit(.entry(.notice(NoticeEntry(id: EntryId("notice:\(notices)"), parent: parent, level: level, text: text, raw: raw))))
    }

    /// An event DevHub does not know, said once per kind of event, so a new
    /// event the CLI prints often is one line in the transcript, not a flood.
    /// What may have carried part of the conversation is a warning; a system
    /// event, the CLI's word beside the conversation, is information.
    private func unknown(_ key: String, _ raw: JsonObject) throws {
        try once(key, .warning, "claude \(versionName()) printed a \"\(key)\" event DevHub does not know", raw)
    }

    private func reported(_ subtype: String, _ raw: JsonObject) throws {
        try once("system/\(subtype)", .info, "claude \(versionName()) reported \"\(subtype)\"", raw)
    }

    private func once(_ key: String, _ level: NoticeLevel, _ text: String, _ raw: JsonObject) throws {
        if unknownSeen.contains(key) { return }
        unknownSeen.insert(key)
        try notice(level, text, .object(raw))
    }

    private func versionName() -> String {
        current.session.agentVersion ?? "(version not yet known)"
    }

    // MARK: - What the CLI printed

    private func take(_ line: ClaudeLine) throws {
        switch line {
        case .controlResponse(let requestId, let outcome):
            try takeControlResponse(requestId, outcome)
        case .canUseTool(let request):
            try takePermission(request)
        case .elicitation(let requestId, let elicitation):
            pending[requestId] = .elicitation(elicitation)
            try emit(
                .requestOpened(
                    PendingRequest(
                        id: RequestId(requestId), entry: nil, subject: elicitationSubject(elicitation),
                        choices: elicitationChoices(elicitation))))
        case .controlRequestUnserved(let requestId, let subtype, let raw):
            let refusal: JsonValue = [
                "type": "control_response",
                "response": [
                    "subtype": "error", "request_id": .string(requestId),
                    "error": .string("DevHub does not serve the control request \"\(subtype)\""),
                ],
            ]
            replies.append(refusal.jsonText)
            try notice(
                .warning, "claude asked DevHub for \"\(subtype)\", which DevHub does not serve; DevHub refused it",
                .object(raw))
        case .controlCancelRequest(let requestId):
            guard pending.removeValue(forKey: requestId) != nil else { return }
            try emit(.requestClosed(RequestId(requestId)))
        case .initialized(let initialized):
            try takeInit(initialized)
        case .stream(let parent, let event):
            try takeStream(try parentOf(parent), event)
        case .assistant(let assistant):
            try takeAssistant(assistant, live: true)
        case .user(let user):
            try takeUser(user, live: true)
        case .rewind(let message):
            try takeRewind(EntryId(message))
        case .resume(let session):
            try takeResume(session)
        case .restart:
            try takeRestart()
        // The resumed session's past: the same messages, drawn the same way,
        // except that they are not a turn running now.
        case .history(.assistant(let assistant)):
            try takeAssistant(assistant, live: false)
        case .history(.user(let user)):
            try takeUser(user, live: false)
        case .result(let result):
            try takeResult(result)
        case .apiRetry(let attempt, let maxRetries, let retryDelayMs, let errorStatus, let raw):
            try notice(
                .warning, retrySentence(attempt: attempt, maxRetries: maxRetries, retryDelayMs: retryDelayMs, errorStatus: errorStatus),
                .object(raw))
        case .compactBoundary(let trigger, let preTokens, let postTokens):
            try setCompacting(false)
            compactions += 1
            promptCache.compacted()
            try emit(
                .entry(
                    .compaction(
                        CompactionEntry(
                            id: EntryId("compaction:\(compactions)"), trigger: trigger, preTokens: preTokens,
                            postTokens: postTokens))))
        case .status(let permissionMode, let compacting, let compactFailure):
            if let permissionMode {
                try patchSession { $0.mode = Setting(current: permissionMode, choices: CLAUDE_MODES) }
            }
            if let compacting { try setCompacting(compacting) }
            if let compactFailure {
                try notice(.error, "Compacting the conversation failed: \(compactFailure)", nil)
            }
        case .permissionDenied(let denial):
            try takeDenial(denial)
        case .said(let level, let text):
            try notice(level, text, nil)
        case .localCommand(let blocks):
            try takeUser(ClaudeUser(parent: nil, uuid: nil, content: blocks, toolResult: NO_TOOL_RESULT), live: false)
        case .task(let task):
            try takeTask(task)
        case .backgroundTasks(let tasks):
            background = tasks
        case .rateLimit(let windows, let status, let resetsAt):
            try takeRateLimit(windows: windows, status: status, resetsAt: resetsAt)
        case .unused:
            return
        case .reported(let subtype, let raw):
            try reported(subtype, raw)
        case .unknown(let key, let raw):
            try unknown(key, raw)
        }
    }

    private func takeInit(_ line: ClaudeInit) throws {
        announced = line.slashCommands
        let (model, effort) = modelSettings(line.model, line.effort ?? current.session.effort.current)
        var next = current.session
        next.agentVersion = line.version
        next.canRewind = resumesAtAMessage(line.version)
        next.sessionId = line.sessionId
        next.cwd = line.cwd
        next.model = model
        next.effort = effort
        next.mode = Setting(current: line.permissionMode ?? current.session.mode.current, choices: CLAUDE_MODES)
        next.commands = commands()
        try setSession(next)
        if let servers = line.mcpServers {
            // `system/init` does not say where a server is configured; what
            // `mcp_status` said of it stands.
            let before = Dictionary((mcpServers ?? []).map { ($0.name, $0) }, uniquingKeysWith: { $1 })
            mcpServers = servers.map { server in
                var server = server
                server.scope = server.scope ?? before[server.name]?.scope
                return server
            }
        }
        pluginErrors = line.pluginErrors
        try becomeReady()
    }

    private func takeControlResponse(_ requestId: String, _ outcome: ControlOutcome) throws {
        let found = ours[requestId]?.objectValue
        // DevHub's own answer to one of the CLI's requests, printed back.
        if found == nil && answered.contains(requestId) { return }
        guard let request = found else {
            throw mismatch("control_response.response.request_id", "a request DevHub made")
        }
        ours[requestId] = nil
        let subtype = request["subtype"]?.stringValue ?? ""
        if case .error(let error) = outcome {
            if let action = MCP_ACTION_NAMES[subtype] {
                // Said in the panel, where the request was made.
                let server = request["serverName"]?.stringValue.map { " \($0)" } ?? ""
                mcpFailure = "\(action)\(server) failed: \(error)"
                return
            }
            // Without the handshake there is no conversation to have; any
            // other refusal is one request that did not happen, said where it
            // happened.
            if subtype == "initialize" {
                try emit(
                    .state(
                        .broken(ConversationFailure(code: .refused, detail: "claude refused the handshake: \(error)"))))
                return
            }
            try notice(.error, "\(subtype) was refused: \(error)", nil)
            return
        }
        guard case .ok(let payload) = outcome else { return }
        switch subtype {
        case "initialize":
            let facts = try decodeInitialize(payload, version: current.session.agentVersion)
            described = facts.commands
            models = facts.models
            let (model, effort) = modelSettings(current.session.model.current, current.session.effort.current)
            var next = current.session
            next.model = model
            next.effort = effort
            next.mode = Setting(current: current.session.mode.current ?? facts.currentMode, choices: CLAUDE_MODES)
            next.commands = commands()
            try setSession(next)
            askMcpStatus()
            try becomeReady()
        case "mcp_status":
            mcpServers = try decodeMcpStatus(payload, version: current.session.agentVersion)
        case "mcp_reconnect", "mcp_toggle":
            // Done: how the servers stand now is asked again.
            askMcpStatus()
        case "set_model":
            try setModelSettings(request["model"]?.stringValue, current.session.effort.current)
        case "set_permission_mode":
            try patchSession { $0.mode = Setting(current: request["mode"]?.stringValue, choices: CLAUDE_MODES) }
        default:
            return
        }
    }

    private func takePermission(_ line: ClaudeCanUseTool) throws {
        let about = line.toolUseId.map(toolEntryId)
        let entry = about.flatMap { tool($0) != nil ? $0 : nil }
        let asksQuestions = line.questions != nil
        let choices =
            asksQuestions
            ? [DECLINE_QUESTIONS]
            : [ALLOW_ONCE]
                + line.suggestions.enumerated().map { index, suggestion in
                    RequestChoice(
                        id: "suggestion:\(index)", label: suggestionLabel(suggestion), tone: .allow, takesText: false)
                } + [DENY]
        pending[line.requestId] = .permission(
            Permission(
                input: line.input, suggestions: line.suggestions, choices: choices, asksQuestions: asksQuestions,
                entry: entry))
        let subject: RequestSubject =
            line.questions.map { .question(questions: $0) }
            ?? .tool(
                tool: line.toolName, title: toolTitle(line.toolName, line.input), input: .object(line.input),
                reason: line.reason)
        try emit(.requestOpened(PendingRequest(id: RequestId(line.requestId), entry: entry, subject: subject, choices: choices)))
    }

    private func takeStream(_ parent: EntryId?, _ event: StreamEvent) throws {
        switch event {
        case .messageStart(let messageId):
            let message = MessageState(id: messageId, parent: parent)
            messages[messageId] = message
            streaming[parent] = message
            // The model is answering at the top level, so a turn is under way
            // — one the CLI can start by itself, with no message of DevHub's
            // to echo, when a background subagent finishes.
            if parent == nil { try turn(.running) }
        case .blockStart(let index, let block):
            try openBlock(try streamingUnder(parent, "content_block_start"), Int(index), block, final: false)
        case .delta(let index, let delta):
            let message = try streamingUnder(parent, "content_block_delta")
            guard let slot = message.slots[Int(index)] else {
                throw mismatch("stream_event.event(content_block_delta).index", "a block that started")
            }
            let kind: SegmentKind
            let text: String
            switch delta {
            case .text(let t):
                kind = .text
                text = t
            case .thinking(let t):
                kind = .thinking
                text = t
            case .unused:
                return
            case .unknown(let key, let raw):
                return try unknown(key, raw)
            }
            if case .unsaid = slot, kind == .thinking {
                if text.isEmpty { return }
                return try openBlock(message, Int(index), .thinking(text), final: false)
            }
            guard case .segment(let slotKind, let entry, let block, _) = slot, slotKind == kind else {
                throw mismatch(
                    "stream_event.event(content_block_delta).delta.type",
                    "a delta for the \(slotKindName(slot)) block that started")
            }
            try emit(.textDelta(entry: entry, block: block, text: text))
        case .messageStop:
            streaming.removeValue(forKey: parent)
        case .unused:
            return
        case .unknown(let key, let raw):
            try unknown(key, raw)
        }
    }

    private func slotKindName(_ slot: Slot) -> String {
        switch slot {
        case .segment(let kind, _, _, _): return kind.rawValue
        case .tool: return "tool"
        case .unsaid: return "unsaid"
        case .ignored: return "ignored"
        }
    }

    private func streamingUnder(_ parent: EntryId?, _ event: String) throws -> MessageState {
        guard let message = streaming[parent] else {
            throw mismatch("stream_event.event(\(event))", "a message_start before it")
        }
        return message
    }

    private func takeAssistant(_ line: ClaudeAssistant, live: Bool) throws {
        let parent = try parentOf(line.parent)
        placed(line.uuid, parent)
        if parent == nil && live { try turn(.running) }
        if parent == nil, !live, let model = line.model, model != SYNTHETIC_MODEL {
            // A resumed session keeps the model it was saved with: its last
            // top-level message's, until the CLI names it on its first turn.
            try setModelSettings(model, current.session.effort.current)
        }
        if parent == nil, let cache = line.cache, line.model != SYNTHETIC_MODEL, line.messageId != promptCacheMessage {
            // One count per response, the main conversation's only: Claude
            // Code's own `prompt_cache` leaves subagents out too.
            promptCacheMessage = line.messageId
            let state = promptCache.record(cache, at: line.timestamp ?? now())
            var usage = current.usage ?? NO_USAGE
            usage.promptCache = state
            try emit(.usage(usage))
        }
        if parent == nil, let contextTokens = line.contextTokens {
            // The conversation's size is its latest top-level message's: a
            // subagent's messages are its own context, not this one's.
            mainModel = line.model
            var usage = current.usage ?? NO_USAGE
            usage.contextTokens = contextTokens
            try emit(.usage(usage))
        }
        let message: MessageState
        if let known = messages[line.messageId] {
            message = known
        } else {
            message = MessageState(id: line.messageId, parent: parent)
            messages[line.messageId] = message
        }
        if let timestamp = line.timestamp {
            for case .toolUse(let id, _, _) in line.content { callTimes[toolEntryId(id)] = timestamp }
        }
        for (position, block) in line.content.enumerated() {
            let index = message.finals
            message.finals += 1
            if let slot = message.slots[index] {
                try finalize(message, index, slot, block, "assistant.message.content[\(position)]")
            } else {
                try openBlock(message, index, block, final: true)
            }
        }
        // The CLI that made the calls of a message read back from a session
        // file has ended: none of its subagents runs now.
        if !live {
            let calls = message.slots.sorted { $0.key < $1.key }.compactMap { _, slot -> TranscriptEntry? in
                if case .tool(let entry, _) = slot, let tool = tool(entry) { return .tool(tool) }
                return nil
            }
            try processEnded(calls)
        }
        if line.error == SIGNED_OUT {
            // The one API error no turn can get past: the CLI has no sign-in
            // to use. What it said stays in the transcript above, and is the
            // reason the failure gives; the fix is the CLI's documented
            // sign-in, after which Restart Session starts it again on the same
            // session.
            let said = line.content.compactMap { block -> String? in
                guard case .text(let text) = block else { return nil }
                let trimmed = JSString.trim(text)
                return trimmed.isEmpty ? nil : trimmed
            }.joined(separator: " ")
            try emit(
                .state(
                    .broken(
                        ConversationFailure(
                            code: .notSignedIn,
                            detail: "\(said.isEmpty ? "" : "claude said: “\(said)”. ")\(CLAUDE_SIGN_IN)"))))
        } else if let error = line.error {
            if error == RATE_LIMITED && parent == nil && live { limitAnswered = true }
            try notice(.error, "The API refused the request: \(error)", nil)
        }
    }

    /// A block first heard of: from its stream start, or whole from a complete message.
    private func openBlock(_ message: MessageState, _ index: Int, _ block: ContentBlock, final: Bool) throws {
        if case .thinking("") = block {
            message.slots[index] = final ? .ignored : .unsaid
            return
        }
        switch block {
        case .text, .thinking:
            let kind: SegmentKind
            let content: AssistantBlock
            if case .text(let text) = block {
                kind = .text
                content = .text(markdown: text)
            } else if case .thinking(let text) = block {
                kind = .thinking
                content = .thinking(text: text)
            } else {
                return
            }
            if case .segment(_, let previousEntry, _, _)? = message.slots[index - 1] {
                guard var segment = find(previousEntry)?.assistantEntry else {
                    throw AdapterRefusal("\(previousEntry) is not an assistant entry")
                }
                message.slots[index] = .segment(kind: kind, entry: previousEntry, block: segment.blocks.count, final: final)
                segment.blocks.append(content)
                segment.streaming = segmentStreaming(message, previousEntry)
                return try emit(.entry(.assistant(segment)))
            }
            let id = EntryId("assistant:\(message.id):\(index)")
            message.slots[index] = .segment(kind: kind, entry: id, block: 0, final: final)
            try emit(.entry(.assistant(AssistantEntry(id: id, parent: message.parent, blocks: [content], streaming: !final))))
        case .toolUse(let toolUseId, let name, let input):
            let id = toolEntryId(toolUseId)
            message.slots[index] = .tool(entry: id, id: toolUseId)
            try emit(
                .entry(
                    .tool(
                        ToolEntry(
                            id: id, parent: message.parent, tool: name, title: toolTitle(name, input),
                            input: .object(input), status: .running, spawns: spawnsOf(name, input, nil),
                            outsideSandbox: input["dangerouslyDisableSandbox"] == .bool(true),
                            plan: planOf(name, input), change: changeOf(name, input, nil),
                            // Known once answered: the result says what was asked and chosen.
                            asked: nil))))
        case .unused:
            message.slots[index] = .ignored
        case .unknown(let key, let raw):
            message.slots[index] = .ignored
            try unknown(key, raw)
        }
    }

    /// A streamed block, made final by its complete message.
    private func finalize(_ message: MessageState, _ index: Int, _ slot: Slot, _ block: ContentBlock, _ path: String)
        throws
    {
        switch slot {
        case .unsaid:
            guard case .thinking = block else { throw mismatch("\(path).type", "the thinking block that streamed") }
            try openBlock(message, index, block, final: true)
        case .segment(let kind, let entry, let blockIndex, _):
            let content: AssistantBlock
            switch (kind, block) {
            case (.text, .text(let text)): content = .text(markdown: text)
            case (.thinking, .thinking(let text)): content = .thinking(text: text)
            default: throw mismatch("\(path).type", "the \(kind.rawValue) block that streamed")
            }
            message.slots[index] = .segment(kind: kind, entry: entry, block: blockIndex, final: true)
            guard var segment = find(entry)?.assistantEntry else {
                throw AdapterRefusal("\(entry) is not an assistant entry")
            }
            segment.blocks[blockIndex] = content
            segment.streaming = segmentStreaming(message, entry)
            try emit(.entry(.assistant(segment)))
        case .tool(let entry, let id):
            guard case .toolUse(let blockId, let name, let input) = block, blockId == id else {
                throw mismatch(path, "the tool_use \(id) that streamed")
            }
            guard var tool = tool(entry) else { throw AdapterRefusal("\(entry) is not a tool call") }
            tool.title = toolTitle(name, input)
            tool.input = .object(input)
            tool.spawns = spawnsOf(name, input, tool.spawns)
            tool.outsideSandbox = input["dangerouslyDisableSandbox"] == .bool(true)
            tool.plan = planOf(name, input)
            try emit(.entry(.tool(tool)))
        case .ignored:
            return
        }
    }

    private func segmentStreaming(_ message: MessageState, _ segment: EntryId) -> Bool {
        message.slots.values.contains { slot in
            if case .segment(_, let entry, _, let final) = slot { return entry == segment && !final }
            return false
        }
    }

    private func takeUser(_ line: ClaudeUser, live: Bool) throws {
        let parent = try parentOf(line.parent)
        let before = lastUuid
        // A message that only tells of tasks ending is the CLI's, not a
        // message of the conversation's own: no place for a resume to cut.
        if line.content.contains(where: { if case .taskNotification = $0 { return false }; return true }) {
            placed(line.uuid, parent)
        }
        var texts: [String] = []
        var images: [ImageRef] = []
        for (position, block) in line.content.enumerated() {
            switch block {
            case .text(let text): texts.append(text)
            case .image(let image): images.append(image)
            case .command(let commandLine): try takeCommand(line.uuid, commandLine, live: live, parent)
            case .commandOutput(let output, let failed): try takeCommandOutput(line.uuid, output, failed, parent)
            case .teammateMessage(let from, let text, let signal): try takeTeammateMessage(from, text, signal)
            case .taskNotification(let taskId, let toolUseId, let status, let summary, let raw):
                try takeTask(
                    ClaudeTask(
                        subtype: "task_notification", taskId: taskId, toolUseId: toolUseId, status: status, text: summary,
                        raw: raw))
            case .toolResult(let toolUseId, let isError, let parts):
                try takeToolResult(toolUseId, isError, parts, line.toolResult, "user.message.content[\(position)]", live: live)
            case .unused: continue
            case .unknown(let key, let raw): try unknown(key, raw)
            }
        }
        // A subagent's first user message is the prompt it was given, which
        // the Task call that started it already carries (`spawns.prompt`).
        if (texts.isEmpty && images.isEmpty) || parent != nil { return }
        let text = texts.joined(separator: "\n")
        // Live, a message is whoever DevHub wrote it for, and one DevHub did
        // not write is not from the person: only DevHub writes to the CLI. A
        // message of the past is the person's: nothing DevHub wrote this time
        // is waiting to be matched with it, and the session file does not say who.
        var origin = UserOrigin.person
        if live {
            if let at = unanswered.firstIndex(where: { !$0.taken && $0.message.text == text }) {
                unanswered[at].taken = true
                origin = UserOrigin(unanswered[at].message.origin)
            } else {
                origin = .other
            }
        }
        users += 1
        let id = EntryId("user:\(line.uuid ?? "#\(users)")")
        if line.uuid != nil {
            if cutBefore[id] == nil { cutOrder.append(id) }
            cutBefore[id] = .some(before)
        }
        try emit(.entry(.user(UserEntry(id: id, text: text, images: images, origin: origin, rewindable: line.uuid != nil))))
        // The message is in the conversation now, no longer sending: in the
        // same step, so it is never drawn twice or not at all. One DevHub did
        // not send was never sending, and the model's answer to it starts
        // whatever turn it starts.
        if live && origin != .other {
            try emitSending()
            try turn(.running)
        }
    }

    /// A command the CLI ran itself. One DevHub sent (a slash command typed
    /// in the composer, or a template's) comes back in this form — echoed, or
    /// answered by the CLI on its own — and is taken as sent then: the oldest
    /// message sending that invokes a command, since the CLI reads its input
    /// in order. Neither the text nor the name has to match: the CLI reads
    /// the command's arguments its own way, and names the command it ran, not
    /// the alias sent (`/cost` runs `usage`).
    private func takeCommand(_ uuid: String?, _ line: String, live: Bool, _ parent: EntryId?) throws {
        if parent != nil { return }
        var automatic = false
        if live, let at = unanswered.firstIndex(where: { !$0.taken && invocation($0.message.text) != nil }) {
            unanswered[at].taken = true
            automatic = unanswered[at].message.origin == .autoCompact
            try emitSending()
            try turn(.running)
        }
        commandCount += 1
        try emit(
            .entry(
                .command(CommandEntry(id: EntryId("command:\(uuid ?? "#\(commandCount)")"), line: line, output: nil, failed: false))))
        if automatic { try notice(.info, AUTO_COMPACTED, nil) }
    }

    /// What a command printed: on the command it follows, or alone when none said what ran.
    private func takeCommandOutput(_ uuid: String?, _ output: String, _ failed: Bool, _ parent: EntryId?) throws {
        if parent != nil { return }
        if case .command(var last)? = current.entries.last, last.output == nil {
            last.output = output
            last.failed = failed
            return try emit(.entry(.command(last)))
        }
        commandCount += 1
        try emit(
            .entry(
                .command(
                    CommandEntry(id: EntryId("command:\(uuid ?? "#\(commandCount)")"), line: nil, output: output, failed: failed))))
    }

    /// A teammate's message. The team protocol's messages say how it stands —
    /// idle between tasks, failed, or shut down — and are not drawn; its
    /// words are a quiet line from it, never the person's.
    private func takeTeammateMessage(_ from: String, _ text: String, _ signal: TeamSignal?) throws {
        guard let signal else { return try notice(.info, "From \(from): \(text)", nil) }
        guard let call = teammates.first(where: { $0.0 == from })?.1, var tool = tool(call), let spawns = tool.spawns
        else { return }
        let state: SubagentState?
        switch signal.type {
        case "idle_notification": state = signal.failure == nil ? .idle : .failed
        case "shutdown_approved", "teammate_terminated": state = .completed
        default: state = nil
        }
        guard let state, state != spawns.state else { return }
        tool.spawns?.state = state
        try emit(.entry(.tool(tool)))
    }

    /// A tool call's result. A subagent call's result is also the subagent's
    /// end — unless the call only started it in the background
    /// (`launchedTask`), whose end a task notification tells later.
    private func takeToolResult(
        _ toolUseId: String, _ isError: Bool, _ parts: [ResultPart], _ result: ToolUseResult, _ path: String, live: Bool
    ) throws {
        let id = toolEntryId(toolUseId)
        guard var tool = tool(id) else { throw mismatch("\(path).tool_use_id", "a tool call that was made") }
        for case .unknown(let key, let raw) in parts { try unknown(key, raw) }
        let launchedTask = result.launchedTask
        let status: ToolStatus =
            denied.contains(id) ? .denied : isError && interrupting ? .interrupted : isError ? .failed : .succeeded
        if tool.spawns != nil, let launchedTask { bindTask(launchedTask, id) }
        if let backgroundTask = result.backgroundTask { bindTask(backgroundTask, id) }
        if tool.spawns != nil, let teammate = result.teammate {
            if let at = teammates.firstIndex(where: { $0.0 == teammate }) {
                teammates[at].1 = id
            } else {
                teammates.append((teammate, id))
            }
        }
        // A call that only started its subagent — in the background, or as a
        // teammate — does not end it.
        let started = launchedTask != nil || result.teammate != nil
        let asksQuestions = tool.tool == ASK_USER_QUESTION && status == .succeeded
        if asksQuestions && result.answered == nil {
            throw mismatch("user.tool_use_result.answers", "the answers to the questions an AskUserQuestion call asked")
        }
        let asked = asksQuestions ? result.answered.map(askedOf) : nil
        let previous = tool
        tool.status = status
        tool.output = toolOutput(previous, isError, parts, result)
        tool.asked = asked ?? previous.asked
        if let patch = result.patch {
            tool.change = changeOf(previous.tool, previous.input.objectValue ?? JsonObject(), patch)
        }
        // A command that went on in the background — asked to, or moved there
        // when it outran its timeout — runs on from here, until news of its
        // task says how it ended. One read back from a session file ran in a
        // CLI that has ended.
        if result.backgroundTask != nil && previous.background == nil {
            tool.background = BackgroundTask(state: live ? .running : .unknown, summary: nil)
        }
        if previous.spawns != nil && !started {
            tool.spawns?.state = status == .succeeded ? .completed : .failed
        }
        try emit(.entry(.tool(tool)))
        // The person's answer is their message, as well as the call's record.
        if let asked {
            try emit(.entry(.answer(AnswerEntry(id: EntryId("answer:\(toolUseId)"), parent: tool.parent, answers: asked.map(\.answer)))))
        }
    }

    /// The CLI process that ran these calls has ended (it was replaced, or
    /// the calls are read back from a session file): a subagent or background
    /// task it was running cannot run now, and how it ended nobody recorded —
    /// unless a notification or its call's result says so later.
    private func processEnded(_ entries: [TranscriptEntry]) throws {
        for case .tool(var each) in entries {
            if each.spawns?.state == .running || each.spawns?.state == .idle {
                each.spawns?.state = .unknown
                try emit(.entry(.tool(each)))
            } else if each.background?.state == .running {
                each.background = BackgroundTask(state: .unknown, summary: nil)
                try emit(.entry(.tool(each)))
            }
        }
    }

    /// A `rate_limit_event`: the windows it reports are the conversation's
    /// usage, and one whose status is `rejected` is a usage limit refusing
    /// the CLI — the turn under way's, or, when the CLI says it after that
    /// turn's end, the reset that end did not know.
    private func takeRateLimit(windows: [RateLimit], status: String?, resetsAt reported: Double?) throws {
        let rateLimits = withRateLimits(current.usage?.rateLimits, windows)
        var usage = current.usage ?? NO_USAGE
        usage.rateLimits = rateLimits
        try emit(.usage(usage))
        let resetsAt = (status == "rejected" ? reported : nil) ?? usedUpReset(rateLimits)
        if let unreset = unresetLimit {
            guard let resetsAt else { return }
            // Rewound away, or left with another session: nothing to fill in.
            guard let end = current.entries.first(where: { $0.id == unreset }) else {
                unresetLimit = nil
                return
            }
            guard case .turnEnd(var turnEnd) = end else {
                throw AdapterRefusal("\(unreset), the end of a turn a usage limit stopped, is a \(end.kind) entry")
            }
            unresetLimit = nil
            turnEnd.limit = LimitStop(resetsAt: resetsAt)
            try emit(.entry(.turnEnd(turnEnd)))
            return
        }
        if status == "rejected" { rejected = LimitStop(resetsAt: resetsAt) }
    }

    private func takeResult(_ line: ClaudeResult) throws {
        let outcome: TurnOutcome = interrupting ? .interrupted : line.isError ? .failed : .completed
        // A usage limit stopped the turn: the model's answer was the API's
        // limit error, or the turn failed after the CLI was refused by a
        // limit. A turn the person stopped was stopped by them.
        let limit: LimitStop? =
            outcome != .interrupted && (limitAnswered || (outcome == .failed && rejected != nil))
            ? LimitStop(resetsAt: (rejected?.resetsAt ?? nil) ?? usedUpReset(current.usage?.rateLimits))
            : nil
        limitAnswered = false
        rejected = nil
        try answer(line)
        let contextWindow =
            mainModel.flatMap { model in line.contextWindows.first(where: { $0.0 == model })?.1 }
            ?? current.usage?.contextWindow
        let usage = Usage(
            inputTokens: line.usage?.inputTokens, outputTokens: line.usage?.outputTokens,
            cachedInputTokens: line.usage?.cacheReadTokens, contextTokens: current.usage?.contextTokens,
            contextWindow: contextWindow, costUsd: line.costUsd, rateLimits: current.usage?.rateLimits,
            promptCache: current.usage?.promptCache)
        turns += 1
        try emit(
            .entry(
                .turnEnd(
                    TurnEndEntry(
                        id: EntryId("turn:\(turns)"), outcome: outcome,
                        detail: outcome != .failed
                            ? nil : !line.errors.isEmpty ? line.errors.joined(separator: "\n") : line.result,
                        usage: usage, durationMs: line.durationMs, limit: limit))))
        try emit(.usage(usage))
        // A message written and not answered yet is the next turn, under way.
        try turn(unanswered.isEmpty ? .none : .running)
        unresetLimit = limit != nil && limit?.resetsAt == nil ? EntryId("turn:\(turns)") : nil
        interrupting = false
        // A server still connecting when the turn began (`system/init`) has
        // settled one way or the other by now, most likely.
        askMcpStatus()
    }

    /// Ask the CLI how its MCP servers stand now (`mcp_status`, the SDK's
    /// `mcpServerStatus()`): once it is up, after each turn, since
    /// `system/init` reports them only as each turn begins, and after each of
    /// the person's MCP requests is done — so the MCP panel (`/mcp`) opens on
    /// what is true now and shows what a request changed.
    private func askMcpStatus() {
        replies.append(controlRequest(["subtype": "mcp_status"]))
    }

    /// A call the CLI's own permission check refused. It is told on the
    /// call, wherever that call is drawn; a call not drawn is told in the
    /// subagent it was made in (`agent_id`), and only one that names neither
    /// is told in the conversation itself.
    private func takeDenial(_ line: ClaudePermissionDenied) throws {
        let denial = Denial(summary: denialSummary(line.reasonType, line.reason), detail: line.message)
        if let toolUseId = line.toolUseId, var call = tool(toolEntryId(toolUseId)) {
            denied.insert(call.id)
            call.denial = denial
            return try emit(.entry(.tool(call)))
        }
        let text = line.toolName.map { "\($0): \(denial.summary)" } ?? denial.summary
        try notice(.info, text, .object(line.raw), parent: callOfTask(line.agentId))
    }

    /// The call a task id names — a background command's, or a subagent's by
    /// its agent id — once a task event or the call's result has said so.
    private func callOfTask(_ task: String?) -> EntryId? {
        guard let task, let call = tasks[task], tool(call) != nil else { return nil }
        return call
    }

    /// Ties a task to the call that started it — once. A subagent's task
    /// keeps its id when SendMessage wakes it again, and the CLI then names
    /// the SendMessage call on its task events; the task is still the
    /// subagent the Agent call started, whose state the news is about.
    private func bindTask(_ task: String, _ call: EntryId) {
        if tasks[task] == nil { tasks[task] = call }
    }

    /// A background task's news, from the CLI's `task_*` events or from a
    /// notification in the conversation (all a session file keeps). It is
    /// matched to the call its task was first tied to (`bindTask`), or else
    /// to the call it names.
    private func takeTask(_ line: ClaudeTask) throws {
        let bound = line.taskId.flatMap { tasks[$0] }
        let call = bound ?? line.toolUseId.map(toolEntryId)
        let state: SubagentState
        if line.subtype != "task_notification" {
            state = .running
        } else if line.status == "completed" {
            state = .completed
        } else if line.status == "failed" || line.status == "stopped" || line.status == "killed" {
            state = .failed
        } else {
            state = .unknown
        }
        // A task no call DevHub drew started (a session file that never named
        // it, a check-in about all of them): only its end is news.
        guard var tool = call.flatMap({ self.tool($0) }) else {
            if line.subtype != "task_notification" { return }
            return try notice(.info, "Background task \(line.status ?? "ended"): \(line.text ?? "")", .object(line.raw))
        }
        if let taskId = line.taskId { bindTask(taskId, tool.id) }
        if let spawns = tool.spawns {
            if state == spawns.state { return }
            tool.spawns?.state = state
            return try emit(.entry(.tool(tool)))
        }
        // Any other task a call started (a command run in the background)
        // stands on that call, quietly.
        let summary = state == .running ? nil : line.text
        if tool.background?.state == state && tool.background?.summary == summary { return }
        tool.background = BackgroundTask(state: state, summary: summary)
        try emit(.entry(.tool(tool)))
    }
}

/// Who refused a call, by the CLI's `decision_reason_type`.
private let DENIED_BY: [String: String] = [
    "classifier": "auto mode", "rule": "a permission rule", "mode": "the permission mode", "hook": "a hook",
]

/// A refusal in a line: `Denied by auto mode: Modify Shared Resources`. The
/// reason's brackets, which the CLI writes around a classifier's category,
/// are left off.
func denialSummary(_ type: String?, _ reason: String?) -> String {
    let who = type.map { "Denied by \(DENIED_BY[$0] ?? $0)" } ?? "Denied"
    var why = reason.map(JSString.trim)
    if let text = why, text.hasPrefix("["), text.hasSuffix("]"), text.count >= 2 {
        why = String(text.dropFirst().dropLast())
    }
    guard let why, !why.isEmpty else { return who }
    return "\(who): \(why)"
}

private let TEAMMATE_UNSTOPPABLE = "A teammate can't be stopped from here."

/// The CLI's kinds of background task, in DevHub's word; any other goes by the CLI's own name.
private let TASK_KINDS: [String: String] = ["local_bash": "shell", "local_agent": "subagent"]

/// Whether a CLI of this version can be resumed at a message (`RESUMES_AT_A_MESSAGE`).
func resumesAtAMessage(_ version: String?) -> Bool {
    guard let parts = matches(#"^(\d+)\.(\d+)\.(\d+)"#, in: version ?? "").first else { return false }
    for (index, need) in RESUMES_AT_A_MESSAGE.enumerated() {
        let have = Int(parts[index + 1] ?? "") ?? 0
        if have != need { return have > need }
    }
    return true
}

func toolEntryId(_ toolUseId: String) -> EntryId {
    EntryId("tool:\(toolUseId)")
}

/// The command a line invokes: the `/name` of a slash command, or `!` of a
/// shell-mode one; nothing for words to the model.
func invocation(_ text: String) -> String? {
    matches(#"^\s*(/\S+|!)"#, in: text).first?[1] ?? nil
}

/// A user message for stdin. One written while a turn runs is queued for
/// that turn's next step (`priority: "next"`, which the CLI also assumes when
/// none is given): the running turn takes it in between tool calls instead
/// of it waiting for the turn to end (`later`) or stopping the turn (`now`).
func userLine(_ text: String, _ images: [ImageRef], _ origin: SentOrigin, midTurn: Bool = false) throws -> String {
    // Plain words stay a string, as the CLI's own messages are; with images,
    // the images come first, as the API advises.
    let content: JsonValue =
        images.isEmpty
        ? .string(text)
        : .array(try images.map(imageBlock) + (text.isEmpty ? [] : [["type": "text", "text": .string(text)]]))
    var line: JsonObject = [
        "type": "user",
        "message": ["role": "user", "content": content],
        "parent_tool_use_id": .null,
        "session_id": "",
    ]
    if midTurn { line["priority"] = "next" }
    line[ORIGIN_KEY] = .string(origin.rawValue)
    return line.jsonText
}

/// An image the person attached, as the API's image block.
private func imageBlock(_ image: ImageRef) throws -> JsonValue {
    guard case .data(let base64) = image.source else {
        let kind: String
        switch image.source {
        case .url: kind = "url"
        case .file: kind = "file"
        case .data: kind = "data"
        }
        throw AdapterRefusal("Claude is sent only an image's own bytes, not \(kind) \(JsonValue.quoted(image.label))")
    }
    return ["type": "image", "source": ["type": "base64", "media_type": .string(image.mediaType), "data": .string(base64)]]
}

private func answerResponse(_ permission: Permission, _ answer: RequestAnswer, _ request: RequestId) throws -> JsonObject {
    switch answer {
    case .answers(let values, let notes):
        if !permission.asksQuestions {
            throw AdapterRefusal("request \(request) asks no questions, so it cannot be answered with answers")
        }
        var updated = permission.input
        updated["answers"] = .object(
            JsonObject(
                values.map { question, value in
                    switch value {
                    case .one(let text): return (question, .string(text))
                    case .many(let labels): return (question, .string(labels.joined(separator: ", ")))
                    }
                }))
        if let notes {
            updated["annotations"] = .object(
                JsonObject(notes.sorted { $0.key < $1.key }.map { ($0.key, ["notes": .string($0.value)]) }))
        }
        return ["behavior": "allow", "updatedInput": .object(updated)]
    case .choice(let choiceId, let text):
        if !permission.choices.contains(where: { $0.id == choiceId }) {
            throw AdapterRefusal("request \(request) did not offer the choice \(JsonValue.quoted(choiceId))")
        }
        if choiceId == DENY.id { return ["behavior": "deny", "message": .string(text ?? DENIED_WITHOUT_WORDS)] }
        if choiceId == ALLOW_ONCE.id { return ["behavior": "allow", "updatedInput": .object(permission.input)] }
        guard let index = Int(choiceId.dropFirst("suggestion:".count)), index < permission.suggestions.count else {
            throw AdapterRefusal("request \(request) did not offer the choice \(JsonValue.quoted(choiceId))")
        }
        return [
            "behavior": "allow", "updatedInput": .object(permission.input),
            "updatedPermissions": [.object(permission.suggestions[index])],
        ]
    }
}

/// An elicitation's answer, by the one rule both CLIs' are (`Elicitation.swift`),
/// as the SDK's `ElicitationResult`: MCP's `ElicitResult`, whose `content` is
/// there only for an accepted form.
private func elicitationResponse(_ elicitation: Elicitation, _ answer: RequestAnswer, _ request: RequestId) throws
    -> JsonObject
{
    let reply = try elicitationReply(elicitation, answer, request: request.raw)
    if reply.remember != nil {
        throw AdapterRefusal("elicitation \(request) was answered with remembering, which Claude never offers")
    }
    guard let content = reply.content else { return ["action": .string(reply.action.rawValue)] }
    return ["action": .string(reply.action.rawValue), "content": .object(content)]
}

/// What the person answered, question by question, as the CLI recorded it:
/// the record the live answer, a replay and a resumed session all read.
private func askedOf(_ answered: AnsweredQuestions) -> [AskedQuestion] {
    answered.questions.map { question in
        AskedQuestion(
            question: question,
            answer: answerTo(
                question, given: givenAnswers(question, answered.answers[question.id] ?? .one("")),
                notes: answered.notes[question.id], secret: false))
    }
}

/// A question's answer as the answers it gives. A multi-select one's labels
/// come joined with `", "` — and a label, or the words written beside them,
/// may hold a `", "` too — so the joined answer is read back label by label:
/// the longest run of pieces that names an option is that option, and a run
/// that names none is what the person wrote.
func givenAnswers(_ question: Question, _ answer: AnswerValue) -> [String] {
    guard case .one(let joined) = answer else { return answer.asList }
    if !question.multiSelect { return [joined] }
    let labels = Set(question.options.map(\.label))
    let pieces = joined.components(separatedBy: ", ")
    var given: [String] = []
    var written: [String] = []
    var at = 0
    while at < pieces.count {
        var end = pieces.count
        while end > at && !labels.contains(pieces[at..<end].joined(separator: ", ")) { end -= 1 }
        if end == at {
            written.append(pieces[at])
            at += 1
            continue
        }
        if !written.isEmpty { given.append(written.joined(separator: ", ")) }
        written = []
        given.append(pieces[at..<end].joined(separator: ", "))
        at = end
    }
    if !written.isEmpty { given.append(written.joined(separator: ", ")) }
    return given
}

/// The plan a call sets: TodoWrite's.
private func planOf(_ name: String, _ input: JsonObject) -> [PlanStep]? {
    name == "TodoWrite" ? todoPlan(input) : nil
}

/// The tools whose result is a file they changed.
private let FILE_TOOLS: Set<String> = ["Edit", "MultiEdit", "Write"]

/// A tool call's result, drawn as what it gave back: the blocks the model
/// read (text, images, tools it made available), with what the tool says of
/// its own result standing in where it says more — a command's streams and
/// exit code, a file tool's diff, output too large for the conversation.
private func toolOutput(_ tool: ToolEntry, _ isError: Bool, _ blockParts: [ResultPart], _ result: ToolUseResult)
    -> ToolOutput
{
    let parts: [ToolOutputPart] = blockParts.compactMap { part in
        switch part {
        case .unknown: return nil
        case .text(let text): return persistedPart(text, result)
        case .image(let image): return .image(image)
        case .reference(let name): return .reference(name: name)
        }
    }
    if parts.contains(where: { if case .persisted = $0 { return true }; return false }) { return parts }
    let text = parts.compactMap { part -> String? in
        if case .text(let text) = part { return text }
        return nil
    }.joined(separator: "\n")
    let others = parts.filter { if case .text = $0 { return false }; return true }
    if tool.tool == "Bash" {
        if isError, let exit = matches(#"^Exit code (\d+)\n?"#, in: text).first, let whole = exit[0],
           let code = exit[1]
        {
            return [
                .command(
                    exitCode: Double(code), output: String(text.dropFirst(whole.count)), stderr: nil, interrupted: false)
            ] + others
        }
        if let stdout = result.stdout {
            return [
                .command(
                    exitCode: nil, output: stdout, stderr: result.stderr == "" ? nil : result.stderr,
                    interrupted: result.interrupted)
            ] + others
        }
    }
    return parts
}

/// A text that is the CLI's note of output it saved to a file, as that note; any other, as itself.
private func persistedPart(_ text: String, _ result: ToolUseResult) -> ToolOutputPart {
    guard let found = matches(#"<persisted-output>\n?([\s\S]*?)\n?</persisted-output>"#, in: text).first,
          let inner = found[1]
    else { return .text(text) }
    let path = result.persistedPath ?? (matches(#"saved to:\s*(\S+)"#, in: inner).first?[1] ?? nil)
    guard let preview = inner.range(of: #"\n\s*Preview[^\n]*:\n"#, options: .regularExpression) else {
        return .persisted(note: JSString.trim(inner), path: path, preview: "")
    }
    return .persisted(
        note: JSString.trim(String(inner[..<preview.lowerBound])), path: path, preview: String(inner[preview.upperBound...]))
}

/// The change a file tool's call makes: the CLI's own patch once its result
/// gives one, else what its input asks for. Nil for any other tool.
private func changeOf(_ name: String, _ input: JsonObject, _ patch: (path: String, hunks: String)?) -> [FileDiff]? {
    guard FILE_TOOLS.contains(name) else { return nil }
    if let patch { return [FileDiff(path: patch.path, unifiedDiff: patch.hunks)] }
    return inputDiff(name, input).map { [$0] }
}

private func inputDiff(_ name: String, _ input: JsonObject) -> FileDiff? {
    guard case .string(let path)? = input["file_path"] else { return nil }
    func lines(_ mark: String, _ text: JsonValue?) -> [String] {
        guard case .string(let text)? = text else { return [] }
        return text.components(separatedBy: "\n").map { mark + $0 }
    }
    func replaced(_ edit: JsonValue) -> [String] {
        lines("-", edit["old_string"]) + lines("+", edit["new_string"])
    }
    let hunks: [[String]]
    if name == "Write" {
        hunks = [lines("+", input["content"])]
    } else if name == "MultiEdit" {
        hunks = (input["edits"]?.arrayValue ?? []).map(replaced)
    } else {
        hunks = [replaced(.object(input))]
    }
    let written = hunks.filter { !$0.isEmpty }
    if written.isEmpty { return nil }
    return FileDiff(path: path, unifiedDiff: written.map { (["@@"] + $0).joined(separator: "\n") }.joined(separator: "\n"))
}

private func spawnsOf(_ name: String, _ input: JsonObject, _ before: SubagentInfo?) -> SubagentInfo? {
    guard SUBAGENT_TOOLS.contains(name) else { return nil }
    func text(_ key: String) -> String? { input[key]?.stringValue }
    return SubagentInfo(
        label: text("subagent_type") ?? text("description") ?? name, prompt: text("prompt") ?? "", model: text("model"),
        state: before?.state ?? .running, takesMessages: false)
}

/// What a permission suggestion does, in a sentence. The suggestion itself
/// goes back to the CLI untouched; this is only its label, so a shape DevHub
/// cannot describe still offers the choice, named by its type.
func suggestionLabel(_ suggestion: JsonObject) -> String {
    let type = suggestion["type"]
    if type == "addRules", case .array(let rules)? = suggestion["rules"] {
        let named = rules.compactMap { rule -> String? in
            guard case .object(let rule) = rule, case .string(let toolName)? = rule["toolName"] else { return nil }
            if case .string(let content)? = rule["ruleContent"] { return "\(toolName)(\(content))" }
            return toolName
        }
        if !named.isEmpty { return "Always allow \(named.joined(separator: ", "))" }
    }
    if type == "setMode", case .string(let mode)? = suggestion["mode"] { return "Switch to \(mode)" }
    if type == "addDirectories", case .array(let directories)? = suggestion["directories"] {
        return "Always allow access to \(directories.map(javaScriptString).joined(separator: ", "))"
    }
    return "Apply the suggested permission (\(type?.stringValue ?? "unnamed"))"
}

/// `String(value)` of a JSON value, as an array's `join` writes each item.
func javaScriptString(_ value: JsonValue) -> String {
    switch value {
    case .null: return ""
    case .bool(let flag): return flag ? "true" : "false"
    case .number(let number): return JsonValue.javaScriptNumber(number)
    case .string(let text): return text
    case .array(let items): return items.map(javaScriptString).joined(separator: ",")
    case .object: return "[object Object]"
    }
}

private func retrySentence(attempt: Double?, maxRetries: Double?, retryDelayMs: Double?, errorStatus: Double?) -> String {
    let n = JsonValue.javaScriptNumber
    let status = errorStatus.map { " (\(n($0)))" } ?? ""
    let delay = retryDelayMs.map { " in \(n(($0 / 1000 + 0.5).rounded(.down)))s" } ?? ""
    let tries = attempt.map { attempt in " (attempt \(n(attempt))\(maxRetries.map { " of \(n($0))" } ?? ""))" } ?? ""
    return "The API request failed\(status); retrying\(delay)\(tries)"
}
