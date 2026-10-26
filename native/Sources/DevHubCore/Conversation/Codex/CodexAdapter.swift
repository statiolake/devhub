// Port of apps/desktop/src/main/agent/conversation/codex/adapter.ts
//
// The Codex protocol adapter: `codex app-server`'s JSON-RPC lines in,
// `ConversationEvent`s out; DevHub's commands in, JSON-RPC lines out.
//
// Pure: no I/O, no process, no clock. Whoever holds it (the conversation)
// moves the lines.
//
// It implements the `ProtocolAdapter` seam both adapters share
// (`ProtocolAdapter.swift`); what follows is what Codex adds to it.
//
// # One path for live and replay
//
// The adapter learns what DevHub said only from `sent(line)`, and what the
// server said only from `received(line)`. Replies to a request are matched to
// it by id, so after a restart a replay can feed all of `in.log` to `sent`
// and then all of `out` to `received`, with the same code that runs live.
//
// The handshake is a chain: `initialize`, then (once it is answered)
// `initialized` and `account/read`, then `thread/start` or `thread/resume`,
// then `model/list`. `opening()` returns only the first link; each later one
// is a `reply` to the answer before it, and is returned only while nothing
// fed to `sent` says it was already made. So a replay does not repeat a
// step, and a DevHub that died between two steps finishes the handshake when
// it comes back.
//
// # Failure
//
// A known message of the wrong shape, or one that contradicts what the
// adapter was told before (a reply to a request DevHub never made, a delta
// for a message that never started), throws the shared `ProtocolMismatch`,
// and the adapter is spent. A notification DevHub does not know is an
// information `notice` (once per method) and the conversation goes on; an
// item DevHub does not know is a warning, since it is part of the
// conversation not drawn; a request DevHub does not know is also answered
// with a JSON-RPC error, because leaving it unanswered would stall the turn
// with nothing on screen saying why. A signed-out account or a refused
// handshake is not a mismatch: it is `state: broken` with its own code, and
// the adapter reads nothing further after it.
//
// A command DevHub's own page should never have sent (answering a request
// that is not open, sending while broken) throws an `AdapterRefusal`: that
// is DevHub's bug, not Codex's, and the caller's root reports it.
//
// # Wire compatibility
//
// Every line this writes is the line the TS adapter writes for the same
// command, byte for byte (keys in the same order, `JSON.stringify`'s
// spelling of numbers), because both apps read each other's `in.log`.

import Foundation

public struct CodexAdapterOptions: Sendable {
    /// DevHub's own version, sent as `clientInfo.version`.
    public var clientVersion: String
    /// The Workspace folder the thread works in.
    public var cwd: String
    /// Continue this thread (`thread/resume`) instead of starting one.
    public var resumeThreadId: String?
    /// DevHub's own instructions for the thread (the `/devhub` skill's
    /// pointer, `DevhubSkill`), sent with `thread/start` and `thread/resume`.
    /// Asked each time: on a host the skill's path is known only once DevHub
    /// has written it there, which is after this adapter is made.
    public var developerInstructions: (@Sendable () -> String?)?

    public init(
        clientVersion: String, cwd: String, resumeThreadId: String?,
        developerInstructions: (@Sendable () -> String?)? = nil
    ) {
        self.clientVersion = clientVersion
        self.cwd = cwd
        self.resumeThreadId = resumeThreadId
        self.developerInstructions = developerInstructions
    }

    /// Instructions that are known when the adapter is made.
    public init(clientVersion: String, cwd: String, resumeThreadId: String?, developerInstructions text: String?) {
        let given: (@Sendable () -> String?)? = text.map { text in { @Sendable in text } }
        self.init(clientVersion: clientVersion, cwd: cwd, resumeThreadId: resumeThreadId, developerInstructions: given)
    }
}

// MARK: - Modes: Codex TUI's approval presets, as approval policy + sandbox pairs.

private struct Mode {
    let id: String
    let label: String
    let approvalPolicy: CodexAskForApproval
    /// The `SandboxPolicy`, as written on `turn/start`.
    let sandboxPolicy: JsonValue
    var sandboxType: String { sandboxPolicy["type"]?.stringValue ?? "" }
}

private let MODES: [Mode] = [
    Mode(
        id: "read-only", label: "Read only", approvalPolicy: .onRequest,
        sandboxPolicy: .object(JsonObject([("type", "readOnly"), ("networkAccess", false)]))),
    Mode(
        id: "auto", label: "Auto", approvalPolicy: .onRequest,
        sandboxPolicy: .object(
            JsonObject([
                ("type", "workspaceWrite"), ("writableRoots", .array([])), ("networkAccess", false),
                ("excludeTmpdirEnvVar", false), ("excludeSlashTmp", false),
            ]))),
    Mode(
        id: "full-access", label: "Full access", approvalPolicy: .never,
        sandboxPolicy: .object(JsonObject([("type", "dangerFullAccess")]))),
]

/// The preset a thread's policy pair is, if it is one; a hand-written config may be none.
private func modeOf(_ approvalPolicy: JsonValue, _ sandbox: JsonValue) -> String? {
    let sandboxType = sandbox.objectValue?["type"]
    return MODES.first { mode in
        approvalPolicy == .string(mode.approvalPolicy.rawValue) && sandboxType == .string(mode.sandboxType)
    }?.id
}

// MARK: - MCP servers

/// A server as the panel draws it. Codex's connection state leads; one it
/// has none for that waits on a sign-in (`authStatus` `notLoggedIn`) needs
/// one. `sign-in` is offered wherever Codex says there is none, `reconnect`
/// for every server that is not disabled (Codex keeps that in its config,
/// which DevHub does not write).
private func codexMcpServer(_ server: CodexMcpServer) -> McpServer {
    let status = codexMcpStatus(server)
    let signIn = status == .needsSignIn || server.authStatus == "notLoggedIn"
    var actions: [McpAction] = []
    if signIn && status != .disabled { actions.append(.signIn) }
    if status != .disabled { actions.append(.reconnect) }
    return McpServer(
        name: server.name, status: status, said: server.runtimeStatus ?? server.authStatus, error: server.toolsError,
        source: server.pluginId.map { "plugin \($0)" }, actions: actions)
}

private func codexMcpStatus(_ server: CodexMcpServer) -> McpServerStatus {
    switch server.runtimeStatus {
    case "connected": return .connected
    case "starting", "notStarted": return .connecting
    case "authenticationRequired": return .needsSignIn
    case "failed", "cancelled": return .failed
    case "disabled": return .disabled
    case nil: return server.authStatus == "notLoggedIn" ? .needsSignIn : .unknown
    default: return .unknown
    }
}

// MARK: - Constants

/// How many words (an item, a turn's start or end) DevHub keeps of a child
/// thread it cannot place yet. Many more than a subagent says in the moment
/// between its thread starting and the call that started it being reported;
/// a bound so a thread that is never placed cannot grow without end. A thread
/// that says more is given up (`abandoned`).
private let HELD_LIMIT = 1000

private let SUBAGENT_TURN_UNKNOWN =
    "Codex has not yet said which turn this subagent is running, so there is nothing to interrupt."

/// JSON-RPC's own "method not found".
private let METHOD_NOT_FOUND = -32601

/// `devhub-<origin>-<n>`: the id DevHub gives a user message it sends.
private let USER_MESSAGE_ID = "^devhub-(\(SentOrigin.allCases.map(\.rawValue).joined(separator: "|")))-(\\d+)$"

/// Whom DevHub sent a user message for, and its number, by the id it gave it.
private func sentMessage(_ clientId: String?) -> (origin: SentOrigin, number: Int)? {
    guard let clientId, let match = matches(USER_MESSAGE_ID, in: clientId).first,
        let origin = match[1].flatMap(SentOrigin.init(rawValue:)), let number = match[2].flatMap({ Int($0) })
    else { return nil }
    return (origin, number)
}

/// The skill names words mention: each `$name` that starts a word, without
/// the punctuation a sentence puts after it.
private func mentions(_ text: String) -> Set<String> {
    Set(matches(#"(?:^|\s)\$([A-Za-z0-9_:-]+(?:\.[A-Za-z0-9_:-]+)*)"#, in: text).compactMap { $0[1] })
}

/// `model/list` leaves out the models hidden from the default picker unless
/// asked (`ModelListParams.includeHidden`), and a thread can be on one.
private let LIST_EVERY_MODEL: [(String, JsonValue)] = [("includeHidden", true)]

private let COLLAB_TITLES: [CodexCollabAgentTool: String] = [
    .spawnAgent: "Start a subagent",
    .sendInput: "Message a subagent",
    .resumeAgent: "Resume a subagent",
    .wait: "Wait for subagents",
    .closeAgent: "Close a subagent",
    .sendMessage: "Message a subagent",
    .followupTask: "Give a subagent a follow-up task",
    .interruptAgent: "Interrupt a subagent",
    .listAgents: "List subagents",
]

private func firstLine(_ text: String) -> String {
    let line = text.components(separatedBy: "\n").first ?? ""
    return JSString.length(line) > 80 ? "\(jsSlice(line, 79))…" : line
}

/// How to sign Codex in again, in its documented command.
let CODEX_SIGN_IN = "Sign in with `codex login` in a terminal on this Agent's machine, then try again."

// MARK: - Bookkeeping types

/// A request the server made that DevHub is showing, and how each answer is spelled.
private struct OpenRequest {
    let rpcId: CodexRpcId
    let respond: (RequestAnswer) throws -> JsonValue
    /// For questions: the person's answer, as the reply DevHub wrote says it.
    let answered: ((JsonValue) throws -> AnswerEntry)?
}

/// How a request answered by filling something in — questions, an
/// elicitation's form — is answered, and, for questions, how the answer
/// reads back.
private struct FormReply {
    let build: ([(String, AnswerValue)]) throws -> JsonValue
    let answered: ((JsonValue) throws -> AnswerEntry)?
}

private struct ChoiceWithResult {
    let choice: RequestChoice
    let result: JsonValue
}

private struct Chosen {
    var model: String?
    var effort: String?
    var mode: String?
}

private struct ThreadDefaults {
    let model: String
    let effort: String?
    let mode: String?
    let cwd: String
}

private struct Tokens {
    let input: Double
    let output: Double
    let cached: Double
}

private struct Sending {
    let thread: String
    let message: SendingMessage
    var turn: String?
}

private enum Listing {
    case listing([CodexModelChoice])
    case listed([CodexModelChoice])
    case failed(why: String)
}

/// A JavaScript `Map`: insertion order kept, a key set again keeps its place.
struct OrderedMap<Key: Hashable, Value> {
    private(set) var keys: [Key] = []
    private var storage: [Key: Value] = [:]

    subscript(key: Key) -> Value? {
        get { storage[key] }
        set {
            if let newValue {
                if storage.updateValue(newValue, forKey: key) == nil { keys.append(key) }
            } else if storage.removeValue(forKey: key) != nil {
                keys.removeAll { $0 == key }
            }
        }
    }

    @discardableResult
    mutating func removeValue(forKey key: Key) -> Value? {
        let value = storage.removeValue(forKey: key)
        if value != nil { keys.removeAll { $0 == key } }
        return value
    }

    mutating func removeAll() {
        keys = []
        storage = [:]
    }

    var isEmpty: Bool { keys.isEmpty }
    var count: Int { keys.count }
    var entries: [(key: Key, value: Value)] { keys.map { ($0, storage[$0]!) } }
    var values: [Value] { keys.map { storage[$0]! } }
    func has(_ key: Key) -> Bool { storage[key] != nil }
}

/// A JavaScript `Set`: insertion order kept.
struct OrderedSet<Element: Hashable> {
    private(set) var elements: [Element] = []
    private var members: Set<Element> = []

    mutating func insert(_ element: Element) {
        if members.insert(element).inserted { elements.append(element) }
    }

    mutating func remove(_ element: Element) {
        if members.remove(element) != nil { elements.removeAll { $0 == element } }
    }
}

// MARK: - The adapter

public final class CodexAdapter: ProtocolAdapter {
    private var current = EMPTY_TRANSCRIPT
    /// An earlier call threw; the bookkeeping may be half-updated.
    private var spent = false
    /// The conversation is broken (signed out, refused, or a failure it reported).
    private var broken = false
    private var version: String?
    /// How many times app-server was started again (Restart session). A new
    /// server numbers its requests afresh, so what DevHub names after one of
    /// them is named in the server's start too (`serverKey`).
    private var starts = 0
    /// app-server was started again and its thread is not open yet: the
    /// thread DevHub draws is resumed, not drawn again.
    private var reopening = false

    // What DevHub said (from `sent`), and the counters `encode` draws ids from.
    private var nextRpcId = 0
    private var nextUserMessage = 0
    private var calls: [String: CodexClientMethod] = [:]
    /// The messages written and not yet taken, by the call that wrote each,
    /// with the thread it went to and, once app-server has answered the call,
    /// the turn it went to: the `turn/completed` of that turn answers it,
    /// whether or not its item came back.
    private var sending = OrderedMap<String, Sending>()
    private var sentMethods: Set<String> = []
    private var responded: Set<String> = []
    /// `thread/revert` requests DevHub made, by id: the turn each takes back from.
    private var reverts: [String: String] = [:]
    /// `thread/resume` requests made once a thread was open (`/resume`), by id.
    private var switches: Set<String> = []
    /// `turn/interrupt` requests DevHub made, by id: the thread each interrupts.
    private var interrupts: [String: String] = [:]
    private var chosen = Chosen()

    // What the server said (from `received`).
    private var mainThread: String?
    /// Only a paginated thread can be reverted (`thread/revert`).
    private var historyMode: CodexHistoryMode?
    /// The main thread's turns, each by the first message the person sent in it.
    private var turnMessages = OrderedMap<String, EntryId>()
    private var runningTurn: String?
    /// The end of the last main-thread turn, when the plan's usage limit
    /// stopped it and no rate limit known then was used up: the rate limits
    /// Codex reports before the next turn starts say when it resets.
    private var unresetLimit: EntryId?
    private var defaults: ThreadDefaults?
    /// What `model/list` said: the pages so far while it is still listing,
    /// every model once the last page is in, or why it could not list them.
    /// Hidden models are listed too, since a thread may be on one (a resumed
    /// thread keeps the model it was on); the picker offers them only then.
    private var listing = Listing.listing([])
    /// The skills `skills/list` named for the thread's directory; none until it answers.
    private var skills: [CodexSkillChoice] = []
    /// The MCP servers the last full `mcpServerStatus/list` named; nil until
    /// one has. The pages of one still listing are `mcpPages`.
    private var mcpServers: [CodexMcpServer]?
    private var mcpPages: [CodexMcpServer] = []
    /// The last MCP request of the person's Codex refused (`McpState.failure`).
    private var mcpFailure: String?
    /// The `config/mcpServer/reload` calls Codex has not answered, by id.
    private var reloads: Set<String> = []
    private var open = OrderedMap<RequestId, OpenRequest>()
    /// Child thread → the tool entry that started it.
    private var threadParents = OrderedMap<String, EntryId>()
    /// When each item started, by app-server's clock, as `item/started` said.
    private var itemTimes: [EntryId: Double] = [:]
    private var threadLabels: [String: String] = [:]
    /// Child threads app-server says the person may start and steer turns of.
    private var directInput: Set<String> = []
    /// The turn each child thread is running, while it runs one.
    private var childTurns: [String: String] = [:]
    /// What child threads said before DevHub knew which call started them,
    /// by thread, to be drawn once each is linked (`link`): each item's
    /// latest word and each turn's start and end, in the order first said, at
    /// most `HELD_LIMIT` of them a thread. Deltas are not kept: the item's
    /// completion carries what they add up to.
    private var held = OrderedMap<String, OrderedMap<String, () throws -> Void>>()
    /// Child threads that said more than `HELD_LIMIT` before being placed:
    /// what they say is not drawn, even once the call that started one is
    /// named, since part of it is gone. One warning says so.
    private var abandoned: Set<String> = []
    /// Running tools and streaming messages, by thread: a thread runs one turn at a time.
    private var unfinished: [String: OrderedSet<EntryId>] = [:]
    private var commandOutput: [EntryId: String] = [:]
    private var fileChanges: [EntryId: [CodexFileChange]] = [:]
    private var noticeCount = 0
    /// The keys of the notices said once (`noticeOnce`).
    private var said: Set<String> = []
    private var total: Tokens?
    private var totalAtTurnStart: Tokens?
    private var usage: Usage?

    // What the current call produced.
    private var events: [ConversationEvent] = []
    private var writes: [String] = []

    private let options: CodexAdapterOptions

    public init(_ options: CodexAdapterOptions) {
        self.options = options
    }

    public var transcript: Transcript { current }

    // MARK: The port

    public func opening() throws -> [String] {
        try lines { initialize() }
    }

    /// The handshake's first link, for the first server and each one started again.
    private func initialize() {
        call(
            .initialize,
            obj([
                (
                    "clientInfo",
                    obj([("name", "devhub"), ("title", "DevHub"), ("version", .string(options.clientVersion))])
                ),
                // The stable surface only: it is the one the vendored types describe.
                ("capabilities", obj([("experimentalApi", false), ("requestAttestation", false)])),
            ]))
    }

    public func encode(_ command: ConversationCommand) throws -> [String] {
        try lines {
            if broken { throw AdapterRefusal("the Codex conversation is broken and takes no more commands") }
            switch command {
            case .send(let text, let images, let origin): try send(text, images, origin)
            case .instruct(let subagent, let text): try instruct(subagent, text)
            case .interrupt: interrupt()
            case .stopTask(let task): try stopSubagent(task)
            case .answer(let request, let answer): try self.answer(request, answer)
            case .mcp(let request): try mcpRequest(request)
            }
        }
    }

    /// The call that carries an MCP request: `mcpServerStatus/list` for the
    /// thread, or `config/mcpServer/reload`, which reconnects every server
    /// with the configuration as it is now — Codex has no request that
    /// reconnects one. An action not offered for that server now is DevHub's
    /// bug: the panel draws only the offered.
    private func mcpRequest(_ request: McpRequest) throws {
        switch request {
        case .refresh:
            listMcpServers(nil)
        case .act(let action, let name):
            guard let server = current.mcp.servers?.first(where: { $0.name == name }), server.actions.contains(action)
            else {
                throw AdapterRefusal("\(action.rawValue) is not offered for the MCP server \(name) now")
            }
            call(.configMcpServerReload, nil)
        }
    }

    private func listMcpServers(_ cursor: String?) {
        var params: [(String, JsonValue)] = [("detail", "toolsAndAuthOnly")]
        if let mainThread { params.append(("threadId", .string(mainThread))) }
        if let cursor { params.append(("cursor", .string(cursor))) }
        call(.mcpServerStatusList, obj(params))
    }

    public func configure(_ which: SettingName, _ id: String) throws -> AdapterStep {
        // Checked before the step, so a choice DevHub should not have offered
        // is refused and leaves the adapter as it was, not spent.
        try refuseIfSpent()
        let facts = sessionFacts()
        let setting: Setting
        switch which {
        case .model: setting = facts.model
        case .effort: setting = facts.effort
        case .mode: setting = facts.mode
        }
        if !setting.choices.contains(where: { $0.id == id }) {
            throw AdapterRefusal("\(id) is not a \(which.rawValue) this Codex offers")
        }
        return try step {
            choose(which, id)
            try publishSession()
        }
    }

    public func rewind(_ message: EntryId) throws -> RewindPlan {
        let lines = try self.lines {
            if broken { throw AdapterRefusal("the Codex conversation is broken and takes no more commands") }
            guard let mainThread, historyMode == .paginated else {
                throw AdapterRefusal(
                    "\(codexName) cannot take back a turn of this thread: only a paginated thread can be reverted")
            }
            if !rewindTargets(current).contains(message) {
                throw AdapterRefusal("\(message) is not a message the conversation can be rewound to now")
            }
            guard let turn = turnMessages.entries.first(where: { $0.value == message }) else {
                throw AdapterRefusal("\(message) did not start a turn, so there is no turn to take back from it")
            }
            call(.threadRevert, obj([("threadId", .string(mainThread)), ("beforeTurnId", .string(turn.key))]))
        }
        return .write(lines: lines)
    }

    public func resumeSession(_ session: String, history: [String]) throws -> RewindPlan {
        if !history.isEmpty {
            throw AdapterRefusal("Codex hands back a thread's past itself: a resume takes no history")
        }
        let lines = try self.lines {
            if broken || current.state != .ready(turn: .none) || !current.requests.isEmpty {
                throw AdapterRefusal("the Codex conversation is not idle, so it cannot go on with another thread now")
            }
            call(
                .threadResume,
                obj([("threadId", .string(session)), ("cwd", .string(options.cwd))] + instructions()))
        }
        return .write(lines: lines)
    }

    public func restart() throws -> RestartPlan {
        try refuseIfSpent()
        // A conversation app-server stopped (signed out, a refused handshake)
        // is the one a restart is most for: the new server's start ends it.
        // app-server takes no thread on its command line: the new one is
        // handed the thread in the handshake (`openThread`).
        return RestartPlan(session: [], mark: [RESTART_MARK])
    }

    public func sent(_ line: String) throws -> AdapterStep {
        try step { try noteSent(line) }
    }

    public func received(_ line: String) throws -> AdapterStep {
        try step {
            // A stopped conversation reads nothing but a new server's start.
            if !broken || line == RESTART_MARK { try dispatch(line) }
            try reportBackground()
        }
    }

    // MARK: Call plumbing

    private func refuseIfSpent() throws {
        if spent {
            throw AdapterRefusal(
                "this Codex adapter is spent: an earlier line broke it, and it takes nothing further")
        }
    }

    /// Runs one call. A throw leaves the adapter spent, since its bookkeeping may be half-updated.
    private func step(_ work: () throws -> Void) throws -> AdapterStep {
        try refuseIfSpent()
        spent = true
        events = []
        writes = []
        try work()
        try publishMcp()
        spent = false
        return AdapterStep(events: events, replies: writes)
    }

    /// The MCP servers as they stand after a step, emitted when that is news.
    /// A reload DevHub asked for and Codex has not answered is working on
    /// every server, since it reconnects them all.
    private func publishMcp() throws {
        let servers = mcpServers?.map(codexMcpServer)
        let mcp = McpState(
            servers: servers, pluginErrors: [],
            working: reloads.isEmpty ? [] : (servers ?? []).map { McpWork(server: $0.name, action: .reconnect) },
            failure: mcpFailure)
        if mcp == current.mcp { return }
        try emit(.mcp(mcp))
    }

    /// `encode` and `opening`: lines only. Nothing is emitted, and nothing
    /// moves but the id counters, and those only after every check has passed
    /// — so a refused command (DevHub's own bug) leaves the adapter as it
    /// was, not spent.
    private func lines(_ work: () throws -> Void) throws -> [String] {
        try refuseIfSpent()
        events = []
        writes = []
        let rpcId = nextRpcId, userMessage = nextUserMessage
        do {
            try work()
        } catch {
            nextRpcId = rpcId
            nextUserMessage = userMessage
            throw error
        }
        if !events.isEmpty { throw AdapterRefusal("encoding a Codex command produced events") }
        return writes
    }

    /// The reader for one line, knowing the CLI's version for the failure it may raise.
    private var reader: CodexReader { CodexReader(version: version) }

    private func mismatch(_ path: String, _ expected: String) -> ProtocolMismatch {
        ProtocolMismatch(path: path, expected: expected, agentVersion: version)
    }

    /// Every event goes through here, so the adapter's own copy is the fold's.
    private func emit(_ event: ConversationEvent) throws {
        current = try applyEvent(current, event)
        events.append(event)
    }

    private func entry(_ id: EntryId) -> TranscriptEntry? {
        current.entries.last { $0.id == id }
    }

    private func setState(_ state: ConversationState) throws {
        try emit(.state(state))
    }

    /// Whether a turn is under way on the conversation's thread: one
    /// app-server started, or a message written to it that the end of no
    /// turn has answered yet.
    private func turnState() -> TurnState {
        let written = sending.values.contains { $0.thread == mainThread }
        return runningTurn != nil || written ? .running : .none
    }

    /// The turn state again, after a write or a refusal, while the
    /// conversation is ready and not being taken back.
    private func publishTurn() throws {
        guard let turn = current.state.turn, turn != .rewinding else { return }
        let now = turnState()
        if turn != now { try setState(.ready(turn: now)) }
    }

    /// A turn of the conversation's thread ended: each message written to it
    /// that app-server never handed back as an item is answered all the same,
    /// drawn as the person's words where it was sending.
    private func answerSent(_ threadId: String, _ turn: String) throws {
        if threadId != mainThread { return }
        var answered = false
        for (call, each) in sending.entries {
            if each.thread != threadId || each.turn != turn { continue }
            sending.removeValue(forKey: call)
            answered = true
            try emit(
                .entry(
                    .user(
                        UserEntry(
                            id: EntryId("\(threadId)/sent/\(each.message.id)"), parent: nil, text: each.message.text,
                            images: each.message.images, origin: UserOrigin(each.message.origin), rewindable: false))))
        }
        if answered { try emitSending() }
    }

    /// Whether app-server is compacting the conversation now, which only a turn running does.
    private func setCompacting(_ compacting: Bool) throws {
        if compacting && current.state != .ready(turn: .running) { return }
        if current.compacting != compacting { try emit(.compacting(compacting)) }
    }

    private func notice(
        _ level: NoticeLevel, _ text: String, _ raw: JsonValue?, parent: EntryId? = nil, id: EntryId? = nil
    ) throws {
        let id = id ?? {
            noticeCount += 1
            return EntryId("notice/\(noticeCount)")
        }()
        try emit(.entry(.notice(NoticeEntry(id: id, parent: parent, level: level, text: text, raw: raw))))
    }

    /// A notice said once per `key` for the adapter's life: news that every
    /// message carrying it would otherwise repeat, a flood saying one thing.
    private func noticeOnce(_ key: String, _ level: NoticeLevel, _ text: String, _ raw: JsonValue?) throws {
        if said.contains(key) { return }
        said.insert(key)
        try notice(level, text, raw)
    }

    private var codexName: String { version.map { "codex \($0)" } ?? "codex" }

    // MARK: Writing

    private func call(_ method: CodexClientMethod, _ params: JsonValue?) {
        let id = nextRpcId
        nextRpcId += 1
        // A request that takes no params (`config/mcpServer/reload`) is sent without them.
        var message: [(String, JsonValue)] = [("id", .number(Double(id))), ("method", .string(method.rawValue))]
        if let params { message.append(("params", params)) }
        writes.append(obj(message).jsonText)
    }

    /// A handshake step: made only if no line DevHub has sent already made it.
    private func callOnce(_ method: CodexClientMethod, _ params: JsonValue?) {
        if !sentMethods.contains(method.rawValue) { call(method, params) }
    }

    private func respond(_ id: CodexRpcId, _ result: JsonValue) {
        writes.append(obj([("id", id.json), ("result", result)]).jsonText)
    }

    /// The conversation's messages written and not yet taken, as the
    /// transcript shows them sending: those to its own thread, not to a
    /// subagent's.
    private func emitSending() throws {
        try emit(.sending(sending.values.compactMap { $0.thread == mainThread ? $0.message : nil }))
    }

    private func noteSent(_ line: String) throws {
        guard case .object(let message) = try JsonValue.parse(line) else {
            throw AdapterRefusal("DevHub sent Codex a line that is not a JSON object: \(line)")
        }
        let id: CodexRpcId?
        switch message["id"] {
        case .number(let value)?: id = .number(value)
        case .string(let text)?: id = .string(text)
        default: id = nil
        }
        guard case .string(let method)? = message["method"] else {
            guard let id else {
                throw AdapterRefusal("DevHub sent Codex a line with neither method nor id: \(line)")
            }
            responded.insert(id.key)
            for request in open.values {
                if let answered = request.answered, request.rpcId.key == id.key {
                    try emit(.entry(.answer(try answered(message["result"] ?? .null))))
                }
            }
            return
        }
        let threadOpen = sentMethods.contains(CodexClientMethod.threadStart.rawValue)
            || sentMethods.contains(CodexClientMethod.threadResume.rawValue)
        sentMethods.insert(method)
        guard let id else { return }
        if method == CodexClientMethod.threadResume.rawValue && threadOpen {
            switches.insert(id.key)
            try setState(.ready(turn: .rewinding))
        }
        guard let known = CodexClientMethod(rawValue: method) else {
            throw AdapterRefusal("DevHub sent Codex a request it has no reader for: \(line)")
        }
        calls[id.key] = known
        if case .number(let number) = id { nextRpcId = max(nextRpcId, Int(number) + 1) }
        let params = message["params"]?.objectValue ?? JsonObject()
        if known == .turnStart || known == .turnSteer {
            let clientId = params["clientUserMessageId"]?.stringValue
            if let sent = sentMessage(clientId) {
                nextUserMessage = max(nextUserMessage, sent.number + 1)
                let input = params["input"]?.arrayValue ?? []
                let thread = params["threadId"]?.stringValue ?? ""
                // Sending until its item comes back, or its turn ends.
                sending[id.key] = Sending(
                    thread: thread,
                    message: SendingMessage(
                        id: clientId!,
                        text: input.compactMap { $0["type"] == "text" ? $0["text"]?.stringValue : nil }
                            .joined(separator: "\n"),
                        images: input.compactMap { each in
                            each["type"] == "image" ? each["url"]?.stringValue.map(dataImage) : nil
                        },
                        origin: sent.origin),
                    turn: nil)
                try emitSending()
                // A message written is a turn under way until the turn that answers it ends.
                if thread == mainThread { try publishTurn() }
            }
        }
        // The person's next MCP request: what the last one ended in has been
        // read, and this one's outcome replaces it.
        if known == .configMcpServerReload {
            mcpFailure = nil
            reloads.insert(id.key)
        }
        if known == .turnInterrupt {
            interrupts[id.key] = params["threadId"]?.stringValue ?? ""
        }
        if known == .threadRevert {
            reverts[id.key] = params["beforeTurnId"]?.stringValue ?? ""
            try setState(.ready(turn: .rewinding))
        }
        if known == .turnStart {
            // What a turn was started with is what the next one starts with too.
            if case .string(let model)? = params["model"] { chosen.model = model }
            if case .string(let effort)? = params["effort"] { chosen.effort = effort }
            let sandboxType = params["sandboxPolicy"]?["type"]
            if let mode = MODES.first(where: { candidate in
                params["approvalPolicy"] == .string(candidate.approvalPolicy.rawValue)
                    && sandboxType == .string(candidate.sandboxType)
            }) {
                chosen.mode = mode.id
            }
            try publishSession()
        }
    }

    // MARK: Reading

    private func dispatch(_ line: String) throws {
        switch try codexDecodeLine(reader, line) {
        case .restart:
            try takeRestart()
        case .response(let id, let result):
            try onResponse(id, result)
        case .error(let id, let code, let message, let data):
            try onErrorResponse(id, code, message, data)
        case .notification(let method, let params):
            guard let known = CodexServerNotification(rawValue: method) else {
                // A notification is Codex's word about the conversation, whose
                // content arrives as items; one DevHub does not know is said
                // quietly, once per method, so a new one Codex sends often is
                // not a flood.
                return try noticeOnce(
                    "method/\(method)", .info, "\(codexName) reported `\(method)`", try JsonValue.parse(line))
            }
            try onNotification(known, params)
        case .request(let id, let method, let params):
            guard let known = CodexServerRequest(rawValue: method) else {
                return try decline(id, method, nil, try JsonValue.parse(line))
            }
            try onRequest(known, id, params, try JsonValue.parse(line))
        }
    }

    /// The host stopped app-server and started it again on the same thread:
    /// the conversation stays, and nothing the server that was stopped had
    /// going goes on (`restarted`). What DevHub kept about that server goes
    /// with it — its requests, the calls DevHub made of it, the handshake —
    /// and the new one is greeted afresh, as a reply, so a replay does not
    /// greet it twice; the handshake then resumes the thread already drawn.
    private func takeRestart() throws {
        broken = false
        try emit(.restarted)
        try notice(.info, RESTARTED, nil)
        try processEnded()
        starts += 1
        reopening = true
        sending.removeAll()
        open.removeAll()
        responded = []
        calls = [:]
        reloads = []
        mcpPages = []
        sentMethods = []
        reverts = [:]
        switches = []
        interrupts = [:]
        runningTurn = nil
        childTurns = [:]
        directInput = []
        held.removeAll()
        abandoned = []
        unfinished = [:]
        listing = .listing([])
        try setState(.ready(turn: .rewinding))
        initialize()
    }

    /// A request of the server's, named apart from a request of an earlier server's with the same id.
    private func serverKey(_ rpcId: CodexRpcId) -> String { "\(starts)/\(rpcId.key)" }

    private func methodOf(_ id: CodexRpcId?, _ path: String) throws -> CodexClientMethod {
        guard let id, let method = calls[id.key] else {
            throw mismatch(path, "a reply to a request DevHub made, got one to \(id?.key ?? "null")")
        }
        return method
    }

    private func onResponse(_ id: CodexRpcId, _ result: JsonValue?) throws {
        let method = try methodOf(id, "message.id")
        switch method {
        case .initialize:
            version = versionOf(try codexInitializeResponse(reader, result))
            try publishSession()
            if !sentMethods.contains("initialized") {
                writes.append(obj([("method", "initialized")]).jsonText)
            }
            callOnce(.accountRead, .object(JsonObject()))
        case .accountRead:
            let account = try codexAccountResponse(reader, result)
            if account.account == nil && account.requiresOpenaiAuth {
                broken = true
                return try setState(
                    .broken(
                        ConversationFailure(
                            code: .notSignedIn, detail: "\(codexName) is not signed in. \(CODEX_SIGN_IN)")))
            }
            try openThread()
        case .threadStart, .threadResume:
            let opened = try codexThreadOpenedResponse(reader, result)
            if switches.remove(id.key) != nil { try leaveThread(opened) }
            try onThreadOpened(opened)
        case .modelList:
            let page = try codexModelListResponse(reader, result)
            var models: [CodexModelChoice]
            switch listing {
            case .listing(let so), .listed(let so): models = so
            case .failed: models = []
            }
            models += page.models
            if let next = page.next {
                listing = .listing(models)
                return call(.modelList, obj(LIST_EVERY_MODEL + [("cursor", .string(next))]))
            }
            listing = .listed(models)
            try publishSession()
        case .skillsList:
            skills = try codexSkillsListResponse(reader, result)
            try publishSession()
        case .mcpServerStatusList:
            let page = try codexMcpServerStatusListResponse(reader, result)
            mcpPages += page.servers
            if let next = page.next { return listMcpServers(next) }
            mcpServers = mcpPages
            mcpPages = []
        case .configMcpServerReload:
            // Done: how the servers stand now is asked again.
            try codexAnyObjectResponse(reader, result)
            reloads.remove(id.key)
            listMcpServers(nil)
        case .threadRevert:
            try codexThreadRevertResponse(reader, result)
            try onReverted(id)
        case .turnInterrupt:
            interrupts.removeValue(forKey: id.key)
            try codexAnyObjectResponse(reader, result)
        case .turnStart, .turnSteer:
            // What else these say arrives again as `turn/started` and the
            // items; the turn is what answers the message.
            let turn = try codexMessageTurn(reader, steer: method == .turnSteer, result)
            guard var sent = sending[id.key] else { return }
            sent.turn = turn
            sending[id.key] = sent
            // Its turn already ended (`turn/completed` came first).
            if entry(EntryId("\(sent.thread)/turn/\(turn)")) != nil { try answerSent(sent.thread, turn) }
        }
    }

    private func onErrorResponse(_ id: CodexRpcId?, _ code: Double, _ message: String, _ data: JsonValue) throws {
        let method = try methodOf(id, "message.id")
        let key = id!.key
        let raw = obj([("code", .number(code)), ("message", .string(message)), ("data", data)])
        if method == .threadResume && switches.remove(key) != nil {
            try notice(.error, "\(codexName) did not go on with that thread: \(message)", raw)
            return try setState(.ready(turn: turnState()))
        }
        switch method {
        case .initialize, .threadStart, .threadResume:
            broken = true
            try setState(
                .broken(
                    ConversationFailure(
                        code: .refused,
                        detail: "\(method.rawValue) failed: \(message) (\(JsonValue.javaScriptNumber(code)))")))
        case .accountRead:
            // The account is read only to say "sign in" early; the thread will say it too.
            try notice(.warning, "\(codexName) could not read its account: \(message)", raw)
            try openThread()
        case .modelList:
            listing = .failed(why: message)
            try publishSession()
            try notice(
                .warning, "\(codexName) could not list its models: \(message). The model can't be changed here.", raw)
        case .skillsList:
            try notice(.warning, "\(codexName) could not list its skills: \(message). None are offered after $.", raw)
        // Said in the MCP panel, where the request was made.
        case .mcpServerStatusList:
            mcpPages = []
            mcpFailure = "Listing the MCP servers failed: \(message)"
        case .configMcpServerReload:
            reloads.remove(key)
            mcpFailure = "Reconnecting the MCP servers failed: \(message)"
        case .threadRevert:
            reverts.removeValue(forKey: key)
            try notice(.error, "\(codexName) did not take back the last turn: \(message)", raw)
            try setState(.ready(turn: turnState()))
        case .turnStart:
            sending.removeValue(forKey: key)
            try emitSending()
            try publishTurn()
            try notice(.error, "\(codexName) did not start the turn: \(message)", raw)
        case .turnSteer:
            sending.removeValue(forKey: key)
            try emitSending()
            try publishTurn()
            try notice(.error, "\(codexName) did not take the message: \(message)", raw)
        case .turnInterrupt:
            let thread = interrupts.removeValue(forKey: key)
            try notice(
                .error,
                thread == mainThread
                    ? "\(codexName) did not interrupt the turn: \(message)"
                    : "\(codexName) did not stop the subagent: \(message)",
                raw)
        }
    }

    /// `developerInstructions` as of now: a host's skill is known only once the host is.
    private func instructions() -> [(String, JsonValue)] {
        guard let text = options.developerInstructions?() else { return [] }
        return [("developerInstructions", .string(text))]
    }

    private func openThread() throws {
        let cwd = options.cwd
        let instructions = self.instructions()
        // A server started again goes on with the thread already open.
        let resumeThreadId = mainThread ?? options.resumeThreadId
        if sentMethods.contains(CodexClientMethod.threadStart.rawValue)
            || sentMethods.contains(CodexClientMethod.threadResume.rawValue)
        {
            return
        }
        if let resumeThreadId {
            call(.threadResume, obj([("threadId", .string(resumeThreadId)), ("cwd", .string(cwd))] + instructions))
        } else {
            call(.threadStart, obj([("cwd", .string(cwd))] + instructions))
        }
    }

    private func onThreadOpened(_ opened: CodexThreadOpened) throws {
        let thread = opened.thread
        mainThread = thread.id
        historyMode = thread.historyMode
        defaults = ThreadDefaults(
            model: opened.model, effort: opened.reasoningEffort, mode: modeOf(opened.approvalPolicy, opened.sandbox),
            cwd: opened.cwd)
        try publishSession()
        // The thread a restarted server resumes is the one drawn already.
        if !reopening {
            for turn in thread.turns { try replayTurn(thread.id, turn) }
        }
        reopening = false
        // Its history tells of no subagent running on this server now.
        try processEnded()
        try emitSending()
        try setState(.ready(turn: turnState()))
        callOnce(.modelList, obj(LIST_EVERY_MODEL))
        callOnce(.skillsList, obj([("cwds", .array([.string(opened.cwd)]))]))
    }

    /// The thread `/resume` left: everything DevHub kept about it goes,
    /// before the other one is drawn. The server keeps the old thread loaded;
    /// it is idle (a resume is refused while a turn runs), so nothing more of
    /// it is expected.
    private func leaveThread(_ opened: CodexThreadOpened) throws {
        try reportBackground { _ in false }
        try emit(.sessionSwitched(session: opened.thread.id))
        sending.removeAll()
        try emitSending()
        turnMessages.removeAll()
        runningTurn = nil
        threadParents.removeAll()
        threadLabels = [:]
        held.removeAll()
        abandoned = []
        unfinished = [:]
        commandOutput = [:]
        fileChanges = [:]
        total = nil
        totalAtTurnStart = nil
        usage = nil
    }

    /// What works in the background, as the transcript has it, after each
    /// line: every subagent running. Codex starts each on a thread of its own
    /// that runs beside the turn that started it, and tells of no other
    /// background task — a command it keeps running after its call has
    /// returned reports no end, so it cannot be listed honestly. `keep`
    /// leaves out calls about to be taken back.
    private func reportBackground(_ keep: (TranscriptEntry) -> Bool = { _ in true }) throws {
        let tasks: [RunningTask] = current.entries.compactMap { entry in
            guard case .tool(let tool) = entry, let spawns = tool.spawns, spawns.state == .running, keep(entry) else {
                return nil
            }
            return RunningTask(
                id: tool.id.raw, kind: "subagent", title: spawns.label, call: tool.id, startedAt: itemTimes[tool.id],
                // Stopped by interrupting its threads' turns, once one is known.
                stoppable: runningThreadsOf(tool.id).isEmpty ? .no(reason: SUBAGENT_TURN_UNKNOWN) : .yes)
        }
        if sameRunningTasks(tasks, current.backgroundTasks) { return }
        try emit(.backgroundTasks(tasks))
    }

    /// A turn `thread/resume` hands back whole: its items as completed, then its end.
    private func replayTurn(_ threadId: String, _ turn: CodexTurnFacts) throws {
        for item in turn.items { try onItem(threadId, turn.id, item, completed: true) }
        if turn.status == .inProgress {
            runningTurn = turn.id
        } else {
            // What a past turn used is not in what `thread/resume` hands back;
            // a limit that stopped it is over by now, and was not this Agent's.
            try endTurn(threadId, turn, nil, nil)
        }
    }

    // MARK: Session and usage

    private func publishSession() throws {
        let session = sessionFacts()
        if session == current.session { return }
        try emit(.session(session))
    }

    /// The session as DevHub knows it now, the choices not yet sent included.
    private func sessionFacts() -> SessionFacts {
        let model = chosen.model ?? defaults?.model
        let models: [CodexModelChoice]
        let listed: Bool
        let failedWhy: String?
        switch listing {
        case .listed(let all): models = all; listed = true; failedWhy = nil
        case .listing: models = []; listed = false; failedWhy = nil
        case .failed(let why): models = []; listed = false; failedWhy = why
        }
        let listedIndex = models.firstIndex { $0.model == model }
        let found = listedIndex.map { models[$0] }
        // A model the whole list does not name is still the thread's: a
        // choice of its own, with no efforts DevHub could offer for it.
        let own = listed && model != nil && found == nil ? model : nil
        let unchangeable: String? =
            failedWhy.map { "\(codexName) could not list its models: \($0)" }
            ?? own.map { "\(codexName)'s model list does not name \($0), so its reasoning efforts are not known here" }
        let efforts = found?.efforts ?? []
        var choices: [SettingChoice] = own.map { [SettingChoice(id: $0, label: $0)] } ?? []
        for (index, candidate) in models.enumerated() where !candidate.hidden || index == listedIndex {
            // Read by the name the thread reports, in the list and as the
            // current value alike; Codex's display name goes beside it.
            choices.append(SettingChoice(id: candidate.model, label: candidate.model, detail: candidate.displayName))
        }
        var commands: [SlashCommand] = [
            SlashCommand(trigger: .slash, name: "model", description: "Choose the model", argumentHint: nil, route: .model),
            SlashCommand(
                trigger: .slash, name: "effort", description: "Choose the reasoning effort", argumentHint: nil,
                route: .effort),
            SlashCommand(
                trigger: .slash, name: "approvals", description: "Choose what Codex may do without asking",
                argumentHint: nil, route: .mode),
            SlashCommand(
                trigger: .slash, name: "resume", description: "Go on with an earlier thread in this Workspace",
                argumentHint: nil, route: .resume),
            SlashCommand(
                trigger: .slash, name: "restart",
                description: "Restart the session: start Codex again, reconnecting its MCP servers", argumentHint: nil,
                route: .restart),
            SlashCommand(
                trigger: .slash, name: "mcp", description: "MCP servers: how each stands, reconnect, sign in",
                argumentHint: nil, route: .mcp),
        ]
        commands += skills.map {
            SlashCommand(trigger: .dollar, name: $0.name, description: $0.description, argumentHint: nil, route: .message)
        }
        return SessionFacts(
            agentVersion: version,
            sessionId: mainThread,
            cwd: defaults?.cwd,
            model: Setting(current: model, choices: choices, unchangeable: failedWhy == nil ? nil : unchangeable),
            // What the next turn runs at: the effort chosen here, else the
            // thread's own while its model is the one it opened with, else
            // the model's default, which `model/list` names (a turn given no
            // effort runs at it).
            effort: Setting(
                current: chosen.effort ?? (chosen.model == nil ? defaults?.effort : nil) ?? found?.defaultEffort,
                choices: efforts.map { SettingChoice(id: $0, label: $0) }, unchangeable: unchangeable),
            mode: Setting(
                current: chosen.mode ?? defaults?.mode, choices: MODES.map { SettingChoice(id: $0.id, label: $0.label) }),
            commands: commands,
            canRewind: historyMode == .paginated)
    }

    private func publishUsage(_ change: (inout Usage) -> Void) throws {
        var next = usage ?? Usage()
        change(&next)
        usage = next
        try emit(.usage(next))
    }

    // MARK: Threads, turns, items

    /// Where a thread's entries hang: the top level (`.some(nil)`), under the
    /// call that started it, or nowhere known (`nil`).
    private func parentOf(_ threadId: String) -> EntryId?? {
        if threadId == mainThread { return .some(nil) }
        return threadParents[threadId].map { .some($0) } ?? nil
    }

    /// `parentOf`, nowhere known read as the top level.
    private func parentOrTop(_ threadId: String) -> EntryId? {
        parentOf(threadId) ?? nil
    }

    /// Whether what `threadId` says can be drawn now: the main thread's
    /// always, a child thread's once it is linked to the call that started
    /// it, unless it was given up before that.
    private func placed(_ threadId: String) -> Bool {
        !abandoned.contains(threadId) && parentOf(threadId) != nil
    }

    /// Whether what `threadId` says is not to be drawn now. If the thread
    /// waits for its link, `replay` waits under `key`: a later word under the
    /// same key (an item's completion after its start) takes the earlier
    /// one's place.
    private func waits(_ threadId: String, _ key: String, _ replay: @escaping () throws -> Void) throws -> Bool {
        if placed(threadId) { return false }
        if abandoned.contains(threadId) { return true }
        var waiting = held[threadId] ?? OrderedMap()
        if !waiting.has(key) && waiting.count == HELD_LIMIT {
            held.removeValue(forKey: threadId)
            abandoned.insert(threadId)
            try noticeOnce(
                "unplaced/\(threadId)", .warning,
                "\(codexName) said more on subagent thread \(threadId) than DevHub keeps before it knows which call started the thread, so what that thread did is not shown.",
                nil)
            return true
        }
        waiting[key] = replay
        held[threadId] = waiting
        return true
    }

    /// A child thread is the work of the call `spawn`: its entries hang under
    /// that call's, and what it said before DevHub knew so is drawn now, in
    /// the order it said it. Codex names the call either way it reports one
    /// — a `collabAgentToolCall` `spawnAgent` naming the thread, or a
    /// `subAgentActivity` `started` (multi-agent v2, which draws no call
    /// item) — and the first call named for a thread keeps it.
    private func link(_ threadId: String, _ spawn: EntryId) throws {
        if threadParents.has(threadId) { return }
        threadParents[threadId] = spawn
        // Given up: how the subagent stands is not known either.
        if abandoned.contains(threadId) { return try setSpawnState(threadId, .unknown, nil) }
        let waiting = held.removeValue(forKey: threadId)
        for replay in waiting?.values ?? [] { try replay() }
    }

    private func idOf(_ threadId: String, _ itemId: String) -> EntryId { EntryId("\(threadId)/\(itemId)") }

    private func onTurnStarted(_ params: JsonValue?) throws {
        let (threadId, turn) = try codexTurnNotification(reader, params)
        if try waits(threadId, "turn/started/\(turn.id)", { [unowned self] in try self.onTurnStarted(params) }) { return }
        if threadId != mainThread {
            childTurns[threadId] = turn.id
            // A subagent's thread taking a turn is the subagent running,
            // whether or not a `subAgentActivity` item says so too.
            return try setSpawnState(threadId, .running, nil)
        }
        runningTurn = turn.id
        unresetLimit = nil
        totalAtTurnStart = total
        try setState(.ready(turn: .running))
    }

    /// The reset of the usage limit the last turn stopped at, once a used-up window says it.
    private func fillLimitReset() throws {
        guard let limited = unresetLimit, let resetsAt = usedUpReset(usage?.rateLimits) else { return }
        // Rewound away, or left with another thread: nothing to fill in.
        guard let end = entry(limited) else {
            unresetLimit = nil
            return
        }
        guard case .turnEnd(var turnEnd) = end else {
            throw AdapterRefusal("\(limited), the end of a turn a usage limit stopped, is a \(end.kind) entry")
        }
        unresetLimit = nil
        turnEnd.limit = LimitStop(resetsAt: resetsAt)
        try emit(.entry(.turnEnd(turnEnd)))
    }

    private func onTurnCompleted(_ params: JsonValue?) throws {
        let (threadId, turn) = try codexTurnNotification(reader, params)
        if turn.status == .inProgress {
            throw mismatch("params.turn.status", "a finished turn, got inProgress")
        }
        if try waits(threadId, "turn/completed/\(turn.id)", { [unowned self] in try self.onTurnCompleted(params) }) {
            return
        }
        // The plan's usage limit stopped the turn: the window it reset is the
        // one used up, as the rate limits last reported it — or, when Codex
        // says so only after the turn, as they report it then.
        try endTurn(
            threadId, turn, turnUsage(),
            turn.usageLimited ? LimitStop(resetsAt: usedUpReset(usage?.rateLimits)) : nil)
        // The provider refused the sign-in: the thread takes no turn until the
        // person signs in again, and Restart Session starts app-server afresh
        // to read the new sign-in. What it said is the reason.
        if turn.unauthorized && threadId == mainThread {
            broken = true
            try setState(
                .broken(
                    ConversationFailure(
                        code: .notSignedIn,
                        detail: "\(turn.error.map { "\(codexName) said: “\($0)”. " } ?? "")\(CODEX_SIGN_IN)")))
        }
    }

    /// A turn is over: whatever of it was still running is not any more, and
    /// for the main thread the turn ends in the transcript. A subagent's turn
    /// ends only in its `spawns.state`, which its thread's turn ending sets —
    /// app-server does not always follow it with a `subAgentActivity` item: a
    /// turn-end entry has no parent to hang under.
    private func endTurn(_ threadId: String, _ turn: CodexTurnFacts, _ usage: Usage?, _ limit: LimitStop?) throws {
        for id in unfinished[threadId]?.elements ?? [] {
            switch entry(id) {
            case .tool(var tool)? where tool.status == .running:
                tool.status = .interrupted
                try emit(.entry(.tool(tool)))
            case .assistant(var assistant)? where assistant.streaming:
                assistant.streaming = false
                try emit(.entry(.assistant(assistant)))
            default:
                break
            }
        }
        unfinished.removeValue(forKey: threadId)
        if threadId != mainThread {
            childTurns.removeValue(forKey: threadId)
            return try setSpawnState(threadId, turn.status == .completed ? .completed : .failed, nil)
        }
        // Every call a turn made is reported by its end, so a child thread
        // still waiting to be placed was started by none DevHub was told of.
        for thread in held.keys {
            try noticeOnce(
                "unplaced/\(thread)", .warning,
                "\(codexName) ran subagent thread \(thread) but never said which call started it, so what that thread did is not shown.",
                nil)
        }
        try answerSent(threadId, turn.id)
        let outcome: TurnOutcome
        switch turn.status {
        case .completed: outcome = .completed
        case .interrupted: outcome = .interrupted
        case .failed, .inProgress: outcome = .failed
        }
        let endId = EntryId("\(threadId)/turn/\(turn.id)")
        try emit(
            .entry(
                .turnEnd(
                    TurnEndEntry(
                        id: endId, outcome: outcome, detail: turn.error, usage: usage, durationMs: turn.durationMs,
                        limit: limit))))
        unresetLimit = limit != nil && limit!.resetsAt == nil ? endId : nil
        if runningTurn == turn.id { runningTurn = nil }
        try setState(.ready(turn: turnState()))
    }

    private func turnUsage() -> Usage? {
        guard let now = total else { return nil }
        let before = totalAtTurnStart ?? Tokens(input: 0, output: 0, cached: 0)
        return Usage(
            inputTokens: now.input - before.input, outputTokens: now.output - before.output,
            cachedInputTokens: now.cached - before.cached, contextTokens: usage?.contextTokens,
            contextWindow: usage?.contextWindow)
    }

    /// Adds or replaces an item's entry, and remembers whether its thread's turn has to finish it.
    private func put(_ entry: TranscriptEntry, _ threadId: String) throws {
        try emit(.entry(entry))
        let isOpen: Bool
        switch entry {
        case .tool(let tool): isOpen = tool.status == .running
        case .assistant(let assistant): isOpen = assistant.streaming
        default: isOpen = false
        }
        var set = unfinished[threadId] ?? OrderedSet()
        if isOpen { set.insert(entry.id) } else { set.remove(entry.id) }
        unfinished[threadId] = set
    }

    private func onItemNotification(_ params: JsonValue?, completed: Bool) throws {
        let note = try codexItemNotification(reader, params)
        if try waits(note.threadId, "item/\(note.item.id)", { [unowned self] in
            try self.onItemNotification(params, completed: completed)
        }) {
            return
        }
        if !completed, let startedAtMs = note.startedAtMs { itemTimes[idOf(note.threadId, note.item.id)] = startedAtMs }
        try onItem(note.threadId, note.turnId, note.item, completed: completed)
    }

    /// The thread was reverted to before a turn: that turn's first message and all after it go.
    private func onReverted(_ id: CodexRpcId) throws {
        guard let turn = reverts[id.key], let from = turnMessages[turn] else {
            throw AdapterRefusal(
                "app-server answered thread/revert \(id.key), which names no turn DevHub knows the first message of")
        }
        reverts.removeValue(forKey: id.key)
        let start = current.entries.firstIndex { $0.id == from } ?? current.entries.count
        let gone = Set(current.entries[start...].map(\.id))
        // A subagent started in what goes is no longer the conversation's to show.
        try reportBackground { !gone.contains($0.id) }
        try emit(.rewound(from: from))
        for (turnId, message) in turnMessages.entries where gone.contains(message) {
            turnMessages.removeValue(forKey: turnId)
        }
        try setState(.ready(turn: turnState()))
    }

    private func onItem(_ threadId: String, _ turnId: String, _ item: CodexItem, completed: Bool) throws {
        let id = idOf(threadId, item.id)
        guard let parentPlace = parentOf(threadId) else {
            throw AdapterRefusal("item \(item.id) of thread \(threadId) was drawn before that thread was placed")
        }
        let parent = parentPlace
        let streaming = !completed
        switch item {
        case .userMessage(_, let clientId, let content):
            let sent = sentMessage(clientId)
            if threadId == mainThread && !turnMessages.has(turnId) { turnMessages[turnId] = id }
            let origin: UserOrigin =
                sent.map { UserOrigin($0.origin) }
                // DevHub's own id says whom it sent the message for. Without
                // one, a subagent's message is its parent Agent's, not the
                // person's; the Agent's own is the person's, typed at Codex's
                // terminal in a thread read back.
                ?? (threadId == mainThread ? .person : .other)
            try put(
                .user(
                    UserEntry(
                        id: id, parent: parent,
                        text: content.compactMap { if case .text(let text) = $0 { return text } else { return nil } }
                            .joined(separator: "\n"),
                        images: content.compactMap { if case .image(let image) = $0 { return image } else { return nil } },
                        origin: origin,
                        rewindable: threadId == mainThread && turnMessages[turnId] == id)),
                threadId)
            // In the conversation now, no longer sending: in the same step.
            for (call, each) in sending.entries where each.message.id == clientId {
                sending.removeValue(forKey: call)
            }
            try emitSending()
        case .agentMessage(_, let text), .plan(_, let text):
            try put(
                .assistant(AssistantEntry(id: id, parent: parent, blocks: [.text(markdown: text)], streaming: streaming)),
                threadId)
        case .reasoning(_, let summary, let content):
            try put(
                .assistant(
                    AssistantEntry(
                        id: id, parent: parent, blocks: summary.map { .thinking(text: $0) }, streaming: streaming)),
                threadId)
            let rawId = EntryId("\(id.raw)#raw")
            if !content.isEmpty || entry(rawId) != nil {
                try put(
                    .assistant(
                        AssistantEntry(
                            id: rawId, parent: parent, blocks: content.map { .thinking(text: $0) }, streaming: streaming)),
                    threadId)
            }
        case .commandExecution(_, let command, let cwd, let status, let aggregatedOutput, let exitCode):
            let streamed = commandOutput[id]
            let output: ToolOutput? =
                aggregatedOutput != nil || exitCode != nil || streamed != nil
                ? [commandPart(exitCode, aggregatedOutput ?? streamed ?? "")] : nil
            if completed { commandOutput.removeValue(forKey: id) }
            try put(
                .tool(
                    tool(
                        id, parent, "commandExecution", command, obj([("command", .string(command)), ("cwd", .string(cwd))]),
                        commandStatus(status), output)),
                threadId)
        case .fileChange(_, let status, let changes):
            fileChanges[id] = changes
            try put(.tool(fileChangeEntry(id, parent, changes, commandStatus(status))), threadId)
        case .mcpToolCall(_, let server, let toolName, let status, let arguments, let result, let error):
            let output: ToolOutput? = error.map { [.text($0)] } ?? (result == .null ? nil : mcpParts(result))
            try put(
                .tool(
                    tool(
                        id, parent, "mcp:\(server)/\(toolName)",
                        toolTitle("mcp__\(server)__\(toolName)", argumentsOf(arguments)), arguments, commandStatus(status),
                        output)),
                threadId)
        case .dynamicToolCall(_, let namespace, let toolName, let status, let arguments, let output):
            try put(
                .tool(
                    tool(
                        id, parent, namespace.map { "\($0)/\(toolName)" } ?? toolName,
                        toolTitle(toolName, argumentsOf(arguments)), arguments, commandStatus(status),
                        output.isEmpty ? nil : [.text(output.joined(separator: "\n"))])),
                threadId)
        case .collabAgentToolCall(_, let toolName, let status, let receivers, let prompt, let model, let states):
            try onCollab(id, parent, threadId, toolName, status, receivers, prompt, model, states)
        case .subAgentActivity(let itemId, let kind, let child, let path):
            try onSubagentActivity(id, itemId, parent, threadId, kind, child, path)
        case .webSearch(_, let query, let results):
            try put(
                .tool(
                    tool(
                        id, parent, "webSearch", "Search: \(query)", obj([("query", .string(query))]),
                        streaming ? .running : .succeeded, results == .null ? nil : [.text(results.jsonText(indent: 2))])),
                threadId)
        case .imageView(_, let path):
            try put(
                .tool(
                    tool(
                        id, parent, "imageView", "View image: \(path)", obj([("path", .string(path))]),
                        streaming ? .running : .succeeded,
                        // A file on the Agent's machine, which the page names rather than opens.
                        [.image(ImageRef(mediaType: "image/*", source: .file(path: path), label: path))])),
                threadId)
        case .enteredReviewMode(_, let review):
            try notice(.info, "Review started: \(review)", nil, parent: parent, id: id)
        case .exitedReviewMode(_, let review):
            try notice(.info, "Review finished: \(review)", nil, parent: parent, id: id)
        case .contextCompaction:
            // The conversation's own compaction runs from the item's start
            // to its end, and is drawn once done; a subagent's is only drawn.
            if threadId == mainThread {
                try setCompacting(streaming)
                if streaming { return }
            }
            try put(
                .compaction(CompactionEntry(id: id, parent: parent, trigger: nil, preTokens: nil, postTokens: nil)),
                threadId)
        case .other(let itemType, _, let raw):
            try notice(.info, "\(codexName) \(itemType.rawValue) item", raw, parent: parent, id: id)
        case .unknown(let itemType, _, let raw):
            try notice(
                .warning, "\(codexName) sent a `\(itemType)` item, which DevHub does not know.", raw, parent: parent,
                id: id)
        }
    }

    private func tool(
        _ id: EntryId, _ parent: EntryId?, _ tool: String, _ title: String, _ input: JsonValue, _ status: ToolStatus,
        _ output: ToolOutput?, _ spawns: SubagentInfo? = nil, _ change: [FileDiff]? = nil
    ) -> ToolEntry {
        ToolEntry(
            id: id, parent: parent, tool: tool, title: title, input: input, status: status, output: output,
            spawns: spawns,
            // Codex tells of no background task but a subagent's.
            background: nil,
            // Codex sandboxes a turn, by its policy, not a call.
            outsideSandbox: false,
            // Codex's plan is an item of its own (`turn/plan/updated`).
            plan: nil,
            change: change,
            // Codex's questions are a request of their own, not a call's.
            asked: nil, denial: nil)
    }

    private func fileChangeEntry(_ id: EntryId, _ parent: EntryId?, _ changes: [CodexFileChange], _ status: ToolStatus)
        -> ToolEntry
    {
        let title = changes.count == 1 ? "Edit: \(changes[0].path)" : "Edit \(changes.count) files"
        return tool(
            id, parent, "fileChange", title,
            obj([
                (
                    "changes",
                    .array(changes.map { obj([("path", .string($0.path)), ("kind", .string($0.kind.rawValue))]) })
                )
            ]), status, nil, nil, changes.map { FileDiff(path: $0.path, unifiedDiff: $0.diff) })
    }

    private func onCollab(
        _ id: EntryId, _ parent: EntryId?, _ threadId: String, _ toolName: CodexCollabAgentTool,
        _ status: CodexCallStatus, _ receivers: [String], _ prompt: String?, _ model: String?,
        _ states: [CodexAgentState]
    ) throws {
        var spawns: SubagentInfo?
        if toolName == .spawnAgent {
            let receiver = receivers.first
            let agentState = receiver.flatMap { receiver in states.first { $0.thread == receiver }?.status }
            spawns = SubagentInfo(
                label: receiver.flatMap { threadLabels[$0] } ?? "subagent",
                prompt: prompt ?? "", model: model,
                state: agentState.map(subagentState) ?? (status == .failed ? .failed : .running),
                takesMessages: receiver.map { directInput.contains($0) } ?? false)
        }
        let title = prompt.map { "\(COLLAB_TITLES[toolName]!): \(firstLine($0))" } ?? COLLAB_TITLES[toolName]!
        try put(
            .tool(
                tool(
                    id, parent, toolName.rawValue, title,
                    obj([
                        ("prompt", prompt.map(JsonValue.string) ?? .null), ("model", model.map(JsonValue.string) ?? .null),
                        ("receiverThreadIds", .array(receivers.map(JsonValue.string))),
                    ]), collabStatus(status), nil, spawns)),
            threadId)
        if toolName == .spawnAgent {
            for receiver in receivers { try link(receiver, id) }
        }
        // Any collab call may report on agents another call started.
        for state in states where threadParents[state.thread] != id {
            try setSpawnState(state.thread, subagentState(state.status), nil)
        }
    }

    /// A subagent's news in the thread of the agent that runs it, as
    /// multi-agent v2 reports its calls instead of a `collabAgentToolCall`.
    /// `started` is the spawn call itself, by its call id: the subagent's
    /// card, and the link from its thread to that card. `interacted` (a
    /// message or a follow-up task) and `interrupted` are calls about a
    /// subagent already started, drawn as such; the subagent's state follows
    /// its thread's turns, since a message need not start one. `completed` is
    /// not a call but a turn of the subagent's having ended, which its own
    /// `turn/completed` says too; it counts unless the subagent is running a
    /// later turn.
    private func onSubagentActivity(
        _ id: EntryId, _ itemId: String, _ parent: EntryId?, _ threadId: String, _ kind: CodexSubagentActivityKind, _ child: String,
        _ agentPath: String
    ) throws {
        try relabel(child, agentPath)
        let input = obj([("agentThreadId", .string(child)), ("agentPath", .string(agentPath))])
        switch kind {
        case .started:
            // Its start and its completion each say it: the second keeps what
            // the subagent's thread said in between.
            let drawn = entry(id)?.toolEntry?.spawns
            try put(
                .tool(
                    tool(
                        id, parent, "spawnAgent", "\(COLLAB_TITLES[.spawnAgent]!): \(agentPath)", input, .succeeded, nil,
                        drawn
                            ?? SubagentInfo(
                                label: agentPath, prompt: "", model: nil, state: .running,
                                takesMessages: directInput.contains(child)))),
                threadId)
            try link(child, id)
        case .interacted, .interrupted:
            let toolName: CodexCollabAgentTool = kind == .interacted ? .sendMessage : .interruptAgent
            try put(
                .tool(
                    tool(
                        id, parent, toolName.rawValue, "\(COLLAB_TITLES[toolName]!): \(agentPath)", input, .succeeded, nil)),
                threadId)
        case .completed:
            if childTurns[child] != nil { return }
            try setSpawnState(
                child, .completed,
                obj([
                    ("type", "subAgentActivity"), ("id", .string(itemId)),
                    ("kind", "completed"), ("agentThreadId", .string(child)), ("agentPath", .string(agentPath)),
                ]))
        }
    }

    /// The spawn entry of a child thread, if DevHub knows it.
    private func spawnEntry(_ threadId: String) -> ToolEntry? {
        guard let id = threadParents[threadId], let tool = entry(id)?.toolEntry, tool.spawns != nil else { return nil }
        return tool
    }

    private func setSpawnState(_ threadId: String, _ state: SubagentState, _ about: JsonValue?) throws {
        guard let tool = spawnEntry(threadId) else {
            guard let about else { return }  // a status report about an agent DevHub never saw started
            return try noticeOnce(
                "unstarted/\(threadId)", .warning,
                "\(codexName) reported on subagent thread \(threadId), which DevHub never saw started.", about)
        }
        try spawnState(tool, state)
    }

    /// Where every change of a drawn subagent's state is made.
    private func spawnState(_ entry: ToolEntry, _ state: SubagentState) throws {
        if entry.spawns!.state == state { return }
        var changed = entry
        changed.spawns!.state = state
        try emit(.entry(.tool(changed)))
    }

    /// The app-server that ran the subagents drawn so far is not the one
    /// DevHub hears live: it was started again (a restart, live or read back
    /// from the journal), or they were read from a thread's history. A
    /// subagent it ran cannot be running now, and how it ended nobody said —
    /// so one drawn as running is unknown, until its thread's own turn says
    /// otherwise.
    private func processEnded() throws {
        for entry in current.entries {
            if case .tool(let tool) = entry, tool.spawns?.state == .running { try spawnState(tool, .unknown) }
        }
    }

    /// A child thread takes the person's messages: its spawn entry says so, once DevHub knows it.
    private func takesMessages(_ threadId: String) throws {
        guard var tool = spawnEntry(threadId), !tool.spawns!.takesMessages else { return }
        tool.spawns!.takesMessages = true
        try emit(.entry(.tool(tool)))
    }

    private func relabel(_ threadId: String, _ label: String) throws {
        threadLabels[threadId] = label
        guard var tool = spawnEntry(threadId), tool.spawns!.label != label else { return }
        tool.spawns!.label = label
        try emit(.entry(.tool(tool)))
    }

    // MARK: Deltas

    /// The streaming assistant entry a delta is for.
    private func streamingEntry(_ threadId: String, _ itemId: String, _ id: EntryId? = nil) throws -> AssistantEntry {
        let found = entry(id ?? idOf(threadId, itemId))
        guard case .assistant(let assistant)? = found, assistant.streaming else {
            throw mismatch(
                "params.itemId",
                "a delta for a streaming message, got one for \(itemId) (\(found.map { "a \($0.kind) entry" } ?? "never started"))")
        }
        return assistant
    }

    private func onTextDelta(_ params: JsonValue?) throws {
        let delta = try codexTextDelta(reader, params)
        // A thread not yet placed: its item's completion, held, says it whole.
        if !placed(delta.threadId) { return }
        let entry = try streamingEntry(delta.threadId, delta.itemId)
        try emit(.textDelta(entry: entry.id, block: 0, text: delta.delta))
    }

    /// Makes sure the reasoning entry has a thinking block at `index`, adding empty ones up to it.
    private func reasoningBlock(_ threadId: String, _ itemId: String, _ index: Int, raw: Bool) throws -> EntryId? {
        if !placed(threadId) { return nil }
        let base = idOf(threadId, itemId)
        let id = raw ? EntryId("\(base.raw)#raw") : base
        if raw && entry(id) == nil {
            var summary = try streamingEntry(threadId, itemId)
            summary.id = id
            summary.blocks = []
            try put(.assistant(summary), threadId)
        }
        var found = try streamingEntry(threadId, itemId, id)
        if found.blocks.count <= index {
            while found.blocks.count <= index { found.blocks.append(.thinking(text: "")) }
            try emit(.entry(.assistant(found)))
        }
        return id
    }

    private func onReasoningDelta(_ delta: CodexReasoningDelta, raw: Bool) throws {
        guard let id = try reasoningBlock(delta.threadId, delta.itemId, delta.index, raw: raw) else { return }
        try emit(.textDelta(entry: id, block: delta.index, text: delta.delta))
    }

    private func onCommandOutput(_ params: JsonValue?) throws {
        let delta = try codexTextDelta(reader, params)
        if !placed(delta.threadId) { return }
        let id = idOf(delta.threadId, delta.itemId)
        guard case .tool(var tool)? = entry(id), tool.status == .running else {
            throw mismatch("params.itemId", "output for a running command, got output for \(delta.itemId)")
        }
        let output = (commandOutput[id] ?? "") + delta.delta
        commandOutput[id] = output
        tool.output = [commandPart(nil, output)]
        try emit(.entry(.tool(tool)))
    }

    private func onPatchUpdated(_ params: JsonValue?) throws {
        let patch = try codexPatchUpdated(reader, params)
        if !placed(patch.threadId) { return }
        let id = idOf(patch.threadId, patch.itemId)
        guard case .tool(let tool)? = entry(id) else {
            throw mismatch("params.itemId", "a patch for a file change, got one for \(patch.itemId)")
        }
        fileChanges[id] = patch.changes
        try emit(.entry(.tool(fileChangeEntry(id, tool.parent, patch.changes, tool.status))))
    }

    private func onPlanUpdated(_ params: JsonValue?) throws {
        let update = try codexPlanUpdated(reader, params)
        if try waits(update.threadId, "plan/\(update.turnId)", { [unowned self] in try self.onPlanUpdated(params) }) {
            return
        }
        try emit(
            .entry(
                .assistant(
                    AssistantEntry(
                        id: EntryId("\(update.threadId)/plan/\(update.turnId)"), parent: parentOrTop(update.threadId),
                        blocks: [.plan(steps: update.plan)], streaming: false))))
    }

    // MARK: Requests from the server

    private func openRequest(
        _ rpcId: CodexRpcId, _ threadId: String, _ itemId: String?, _ subject: RequestSubject,
        _ choices: [ChoiceWithResult], _ answers: FormReply?
    ) throws {
        let id = RequestId("codex/\(serverKey(rpcId))")
        let about = itemId.flatMap { entry(idOf(threadId, $0)) }
        let byChoice = Dictionary(choices.map { ($0.choice.id, $0.result) }, uniquingKeysWith: { first, _ in first })
        open[id] = OpenRequest(
            rpcId: rpcId,
            respond: { answer in
                switch answer {
                case .answers(let values, _):
                    guard let answers else { throw AdapterRefusal("request \(id) takes a choice, not answers") }
                    return try answers.build(values)
                case .choice(let choiceId, let text):
                    guard let result = byChoice[choiceId] else {
                        throw AdapterRefusal("request \(id) has no choice \(choiceId)")
                    }
                    if text != nil { throw AdapterRefusal("choice \(choiceId) of request \(id) takes no text") }
                    return result
                }
            },
            answered: answers?.answered)
        try emit(
            .requestOpened(
                PendingRequest(
                    id: id, entry: about?.toolEntry?.id, subject: subject, choices: choices.map(\.choice))))
    }

    private func onCommandApproval(_ rpcId: CodexRpcId, _ params: JsonValue?) throws {
        let request = try codexCommandApproval(reader, params)
        func decide(_ decision: JsonValue) -> JsonValue { obj([("decision", decision)]) }
        var choices: [ChoiceWithResult] = [
            ChoiceWithResult(
                choice: RequestChoice(id: "accept", label: "Allow once", tone: .allow, takesText: false),
                result: decide("accept")),
            ChoiceWithResult(
                choice: RequestChoice(id: "acceptForSession", label: "Allow for this session", tone: .allow, takesText: false),
                result: decide("acceptForSession")),
        ]
        if let amendment = request.execpolicyAmendment {
            choices.append(
                ChoiceWithResult(
                    choice: RequestChoice(
                        id: "execpolicy", label: "Always allow `\(amendment.joined(separator: " "))`", tone: .allow,
                        takesText: false),
                    result: decide(
                        obj([
                            (
                                "acceptWithExecpolicyAmendment",
                                obj([("execpolicy_amendment", .array(amendment.map(JsonValue.string)))])
                            )
                        ]))))
        }
        for (index, amendment) in request.networkAmendments.enumerated() {
            choices.append(
                ChoiceWithResult(
                    choice: RequestChoice(
                        id: "network:\(index)", label: "Always \(amendment.action) network access to \(amendment.host)",
                        tone: amendment.action == "allow" ? .allow : .deny, takesText: false),
                    result: decide(
                        obj([
                            (
                                "applyNetworkPolicyAmendment",
                                obj([
                                    (
                                        "network_policy_amendment",
                                        obj([("host", .string(amendment.host)), ("action", .string(amendment.action))])
                                    )
                                ])
                            )
                        ]))))
        }
        choices += [
            ChoiceWithResult(
                choice: RequestChoice(id: "decline", label: "Decline", tone: .deny, takesText: false),
                result: decide("decline")),
            ChoiceWithResult(
                choice: RequestChoice(id: "cancel", label: "Decline and stop the turn", tone: .deny, takesText: false),
                result: decide("cancel")),
        ]
        let subject: RequestSubject
        if let command = request.command {
            subject = .command(command: command, cwd: request.cwd ?? "", reason: request.reason)
        } else {
            subject = .tool(
                tool: request.networkHost != nil ? "network" : request.kind,
                title: request.networkHost.map { "Network access to \($0)" }
                    ?? (request.kind == "writeStdin" ? "Write to a running command" : "Run a command"),
                input: params ?? .null, reason: request.reason)
        }
        try openRequest(rpcId, request.threadId, request.itemId, subject, choices, nil)
    }

    private func onFileChangeApproval(_ rpcId: CodexRpcId, _ params: JsonValue?) throws {
        let request = try codexFileChangeApproval(reader, params)
        func decide(_ decision: String) -> JsonValue { obj([("decision", .string(decision))]) }
        let changes = fileChanges[idOf(request.threadId, request.itemId)] ?? []
        try openRequest(
            rpcId, request.threadId, request.itemId,
            .fileChange(files: changes.map { FileDiff(path: $0.path, unifiedDiff: $0.diff) }),
            [
                ChoiceWithResult(
                    choice: RequestChoice(id: "accept", label: "Allow once", tone: .allow, takesText: false),
                    result: decide("accept")),
                ChoiceWithResult(
                    choice: RequestChoice(
                        id: "acceptForSession", label: "Allow for this session", tone: .allow, takesText: false),
                    result: decide("acceptForSession")),
                ChoiceWithResult(
                    choice: RequestChoice(id: "decline", label: "Decline", tone: .deny, takesText: false),
                    result: decide("decline")),
                ChoiceWithResult(
                    choice: RequestChoice(id: "cancel", label: "Decline and stop the turn", tone: .deny, takesText: false),
                    result: decide("cancel")),
            ], nil)
    }

    private func onPermissionsApproval(_ rpcId: CodexRpcId, _ params: JsonValue?) throws {
        let request = try codexPermissionsApproval(reader, params)
        var granted: [(String, JsonValue)] = []
        if request.network != .null { granted.append(("network", request.network)) }
        if request.fileSystem != .null { granted.append(("fileSystem", request.fileSystem)) }
        func grant(_ scope: String, _ permissions: JsonValue) -> JsonValue {
            obj([("permissions", permissions), ("scope", .string(scope))])
        }
        try openRequest(
            rpcId, request.threadId, request.itemId,
            .tool(
                tool: "permissions", title: "Grant more permissions", input: obj([("cwd", .string(request.cwd))] + granted),
                reason: request.reason),
            [
                ChoiceWithResult(
                    choice: RequestChoice(id: "turn", label: "Allow for this turn", tone: .allow, takesText: false),
                    result: grant("turn", obj(granted))),
                ChoiceWithResult(
                    choice: RequestChoice(id: "session", label: "Allow for this session", tone: .allow, takesText: false),
                    result: grant("session", obj(granted))),
                // Granting nothing is how a permission request is declined.
                ChoiceWithResult(
                    choice: RequestChoice(id: "decline", label: "Decline", tone: .deny, takesText: false),
                    result: grant("turn", .object(JsonObject()))),
            ], nil)
    }

    private func onUserInput(_ rpcId: CodexRpcId, _ params: JsonValue?) throws {
        let request = try codexUserInputRequest(reader, params)
        let questions = request.questions.map { question in
            Question(
                id: question.id, header: question.header, text: question.question,
                options: question.options.map { QuestionOption(label: $0.label, description: $0.description, preview: nil) },
                multiSelect: false, allowsOther: question.isOther)
        }
        let parent = parentOrTop(request.threadId)
        let answerId = EntryId("answer/\(serverKey(rpcId))")
        try openRequest(
            rpcId, request.threadId, request.itemId, .question(questions: questions), [],
            FormReply(
                build: { values in
                    let given = Dictionary(values, uniquingKeysWith: { _, last in last })
                    var answers: [(String, JsonValue)] = []
                    for question in request.questions {
                        guard let value = given[question.id] else {
                            throw AdapterRefusal("no answer to question \(question.id)")
                        }
                        answers.append((question.id, obj([("answers", .array(value.asList.map(JsonValue.string)))])))
                    }
                    return obj([("answers", obj(answers))])
                },
                answered: { result in
                    let answers = result["answers"]?.objectValue ?? JsonObject()
                    return AnswerEntry(
                        id: answerId, parent: parent,
                        answers: zip(questions, request.questions).map { question, asked in
                            answerTo(
                                question,
                                given: answers[question.id]?["answers"]?.arrayValue?.compactMap(\.stringValue) ?? [],
                                notes: nil, secret: asked.isSecret)
                        })
                }))
    }

    /// An elicitation, answered by the one rule both CLIs' are
    /// (`Elicitation.swift`), in app-server's words: remembering an acceptance
    /// is `_meta.persist`, as Codex's own terminal UI sends it.
    private func onElicitation(_ rpcId: CodexRpcId, _ params: JsonValue?) throws {
        let (threadId, request) = try codexElicitation(reader, params)
        let name = rpcId.key
        func wire(_ answer: RequestAnswer) throws -> JsonValue {
            let reply = try elicitationReply(request, answer, request: name)
            return obj([
                ("action", .string(reply.action.rawValue)),
                ("content", reply.content.map(JsonValue.object) ?? .null),
                ("_meta", reply.remember.map { obj([("persist", .string($0.rawValue))]) } ?? .null),
            ])
        }
        try openRequest(
            rpcId, threadId, nil, elicitationSubject(request),
            try elicitationChoices(request).map { choice in
                ChoiceWithResult(choice: choice, result: try wire(.choice(choiceId: choice.id, text: nil)))
            },
            FormReply(build: { values in try wire(.answers(values: values, notes: nil)) }, answered: nil))
    }

    /// A request DevHub will not handle is answered with an error, never left to stall the turn.
    private func decline(_ rpcId: CodexRpcId, _ method: String, _ unused: String?, _ raw: JsonValue) throws {
        try notice(
            .warning,
            unused.map {
                "\(codexName) asked DevHub for `\(method)`, which DevHub does not do (\($0)); DevHub answered that it cannot."
            } ?? "\(codexName) asked DevHub for `\(method)`, which DevHub does not know; DevHub answered that it cannot.",
            raw)
        if responded.contains(rpcId.key) { return }
        writes.append(
            obj([
                ("id", rpcId.json),
                (
                    "error",
                    obj([
                        ("code", .number(Double(METHOD_NOT_FOUND))), ("message", .string("DevHub does not handle \(method)")),
                    ])
                ),
            ]).jsonText)
    }

    private func onResolved(_ params: JsonValue?) throws {
        let (_, rpcId) = try codexRequestResolved(reader, params)
        let id = RequestId("codex/\(serverKey(rpcId))")
        // A request DevHub declined with an error was never opened.
        guard open.has(id) else { return }
        open.removeValue(forKey: id)
        try emit(.requestClosed(id))
    }

    // MARK: Commands

    /// A message as app-server takes it: its words, each skill they mention
    /// (`$name`) as the protocol's `skill` input, the way a client hands
    /// Codex a skill, and its images.
    private func inputOf(_ text: String, _ images: [ImageRef]) throws -> JsonValue {
        var input: [JsonValue] = []
        if !text.isEmpty {
            input.append(obj([("type", "text"), ("text", .string(text)), ("text_elements", .array([]))]))
        }
        let mentioned = mentions(text)
        for skill in skills where mentioned.contains(skill.name) {
            input.append(obj([("type", "skill"), ("name", .string(skill.name)), ("path", .string(skill.path))]))
        }
        // Images as data URLs, which app-server takes as it takes any image
        // URL: the file is on the page's machine, not necessarily the Agent's.
        for image in images {
            guard case .data(let base64) = image.source else {
                let kind: String
                switch image.source {
                case .url: kind = "url"
                case .file: kind = "file"
                case .data: kind = "data"
                }
                throw AdapterRefusal(
                    "Codex is sent only an image's own bytes, not \(kind) \(JsonValue.quoted(image.label))")
            }
            input.append(obj([("type", "image"), ("url", .string("data:\(image.mediaType);base64,\(base64)"))]))
        }
        return .array(input)
    }

    private func send(_ text: String, _ images: [ImageRef], _ origin: SentOrigin) throws {
        guard current.state.turn != nil, let mainThread else {
            throw AdapterRefusal("cannot send to a Codex conversation that is \(current.state.phase)")
        }
        let input = try inputOf(text, images)
        let clientUserMessageId = "devhub-\(origin.rawValue)-\(nextUserMessage)"
        nextUserMessage += 1
        if let runningTurn {
            // Typing during a turn adds to it, as it does in Codex's own TUI.
            return call(
                .turnSteer,
                obj([
                    ("threadId", .string(mainThread)), ("input", input),
                    ("clientUserMessageId", .string(clientUserMessageId)), ("expectedTurnId", .string(runningTurn)),
                ]))
        }
        var params: [(String, JsonValue)] = [
            ("threadId", .string(mainThread)), ("input", input), ("clientUserMessageId", .string(clientUserMessageId)),
        ]
        if let model = chosen.model { params.append(("model", .string(model))) }
        if let effort = chosen.effort { params.append(("effort", .string(effort))) }
        if let mode = MODES.first(where: { $0.id == chosen.mode }) {
            params.append(("approvalPolicy", .string(mode.approvalPolicy.rawValue)))
            params.append(("sandboxPolicy", mode.sandboxPolicy))
        }
        call(.turnStart, obj(params))
    }

    /// The person's words to a subagent's thread: steered into the turn it is
    /// running, or starting one. Its thread is the first the spawn call
    /// names, the one its entry is drawn for.
    private func instruct(_ subagent: EntryId, _ text: String) throws {
        guard let thread = threadParents.entries.first(where: { $0.value == subagent })?.key, directInput.contains(thread)
        else {
            throw AdapterRefusal("\(subagent) started no subagent thread that takes the person's messages")
        }
        let input = try inputOf(text, [])
        let clientUserMessageId = "devhub-person-\(nextUserMessage)"
        nextUserMessage += 1
        if let running = childTurns[thread] {
            return call(
                .turnSteer,
                obj([
                    ("threadId", .string(thread)), ("input", input), ("clientUserMessageId", .string(clientUserMessageId)),
                    ("expectedTurnId", .string(running)),
                ]))
        }
        call(
            .turnStart,
            obj([("threadId", .string(thread)), ("input", input), ("clientUserMessageId", .string(clientUserMessageId))]))
    }

    /// Interrupting when no turn runs asks for what is already true, and sends nothing.
    private func interrupt() {
        guard let runningTurn, let mainThread else { return }
        call(.turnInterrupt, obj([("threadId", .string(mainThread)), ("turnId", .string(runningTurn))]))
    }

    /// A subagent stopped: the turn each of its threads is running is
    /// interrupted, as the main thread's is. Its row goes when those turns end.
    private func stopSubagent(_ task: String) throws {
        let running = try requireStoppable(current.backgroundTasks, task)
        for (thread, turnId) in runningThreadsOf(running.call!) {
            call(.turnInterrupt, obj([("threadId", .string(thread)), ("turnId", .string(turnId))]))
        }
    }

    /// The subagent threads a spawn call started that are running a turn now, with that turn.
    private func runningThreadsOf(_ spawn: EntryId) -> [(String, String)] {
        threadParents.entries.compactMap { thread, parent in
            guard parent == spawn, let turn = childTurns[thread] else { return nil }
            return (thread, turn)
        }
    }

    private func answer(_ id: RequestId, _ answer: RequestAnswer) throws {
        guard let request = open[id] else { throw AdapterRefusal("request \(id) is not open") }
        if responded.contains(request.rpcId.key) { throw AdapterRefusal("request \(id) was already answered") }
        respond(request.rpcId, try request.respond(answer))
    }

    /// Codex keeps no setting on the thread: model, effort and mode travel on
    /// each `turn/start`, so choosing one writes nothing. The choice is held
    /// here, shown at once (`configure` publishes the session), and carried
    /// by the next `turn/start`, whose `sent` makes it survive a replay.
    private func choose(_ which: SettingName, _ id: String) {
        switch which {
        case .model:
            chosen.model = id
            chosen.effort = nil
        case .effort: chosen.effort = id
        case .mode: chosen.mode = id
        }
    }

    // MARK: The method tables

    /// Every method the server can send is placed here, so a method a new
    /// Codex adds is a compile error until someone decides what it means: a
    /// reader, or the reason DevHub reads nothing from it.
    private func onNotification(_ method: CodexServerNotification, _ params: JsonValue?) throws {
        switch method {
        case .error:
            let error = try codexErrorNotification(reader, params)
            try notice(
                error.willRetry ? .warning : .error, error.willRetry ? "\(error.message) (retrying)" : error.message,
                params ?? .null, parent: parentOrTop(error.threadId))
        case .threadStarted:
            let thread = try codexThreadStarted(reader, params)
            if thread.parentThreadId != nil, let nickname = thread.agentNickname { try relabel(thread.id, nickname) }
            if thread.parentThreadId != nil && thread.takesDirectInput {
                directInput.insert(thread.id)
                try takesMessages(thread.id)
            }
        case .threadClosed:
            let threadId = try codexThreadClosed(reader, params)
            if threadId == mainThread {
                try notice(.warning, "\(codexName) closed this conversation's thread.", params ?? .null)
            }
        case .threadTokenUsageUpdated:
            let usage = try codexTokenUsage(reader, params)
            guard usage.threadId == mainThread else { return }
            total = Tokens(
                input: usage.total.inputTokens, output: usage.total.outputTokens, cached: usage.total.cachedInputTokens)
            try publishUsage { next in
                next.inputTokens = usage.total.inputTokens
                next.outputTokens = usage.total.outputTokens
                next.cachedInputTokens = usage.total.cachedInputTokens
                next.contextTokens = usage.last.totalTokens
                next.contextWindow = usage.modelContextWindow
            }
        case .turnStarted: try onTurnStarted(params)
        case .turnCompleted: try onTurnCompleted(params)
        case .turnPlanUpdated: try onPlanUpdated(params)
        case .itemStarted: try onItemNotification(params, completed: false)
        case .itemCompleted: try onItemNotification(params, completed: true)
        case .itemAgentMessageDelta, .itemPlanDelta: try onTextDelta(params)
        case .itemCommandExecutionOutputDelta: try onCommandOutput(params)
        case .itemFileChangePatchUpdated: try onPatchUpdated(params)
        case .serverRequestResolved: try onResolved(params)
        case .accountRateLimitsUpdated:
            let windows = try codexRateLimits(reader, params)
            try publishUsage { $0.rateLimits = withRateLimits($0.rateLimits, windows) }
            try fillLimitReset()
        case .itemReasoningSummaryTextDelta:
            try onReasoningDelta(try codexReasoningSummaryDelta(reader, params), raw: false)
        case .itemReasoningSummaryPartAdded:
            let part = try codexSummaryPartAdded(reader, params)
            _ = try reasoningBlock(part.threadId, part.itemId, part.summaryIndex, raw: false)
        case .itemReasoningTextDelta:
            try onReasoningDelta(try codexReasoningTextDelta(reader, params), raw: true)
        case .modelRerouted:
            let reroute = try codexRerouted(reader, params)
            try notice(
                .info, "\(reroute.fromModel) was rerouted to \(reroute.toModel) (\(reroute.reason))", params ?? .null,
                parent: parentOrTop(reroute.threadId))
        case .warning, .guardianWarning:
            let note = try codexWarning(reader, params)
            try notice(.warning, note.message, params ?? .null, parent: note.threadId.flatMap(parentOrTop))
        case .deprecationNotice, .configWarning:
            let note = try codexSummaryNotice(reader, params)
            try notice(.warning, note.details.map { "\(note.summary)\n\($0)" } ?? note.summary, params ?? .null)
        case .threadStatusChanged:
            unused("DevHub reads the status off turns and requests")
        case .threadArchived, .threadDeleted, .threadUnarchived:
            unused("DevHub keeps no thread list")
        case .threadReverted:
            unused("the answer to DevHub's thread/revert says the same, for the one thread DevHub reverts")
        case .skillsChanged: unused("DevHub lists the skills once, when the thread opens")
        case .threadNameUpdated: unused("the Agent's name is DevHub's")
        case .threadAttachmentUpdated: unused("DevHub attaches nothing")
        case .threadGoalUpdated, .threadGoalCleared: unused("DevHub sets no goals")
        case .threadQueueChanged: unused("DevHub queues nothing on the thread")
        case .projectChanged, .threadProjectUpdated: unused("DevHub keeps no Codex projects")
        case .threadEnvironmentConnected, .threadEnvironmentDisconnected:
            unused("DevHub runs Codex where the Agent lives")
        case .threadSettingsUpdated: unused("DevHub holds the next turn's settings itself")
        case .hookStarted, .hookCompleted: unused("hook events are not drawn in v1")
        case .turnDiffUpdated: unused("each file change shows its own diff")
        case .itemAutoApprovalReviewStarted, .itemAutoApprovalReviewCompleted, .autoApprovalReviewStrictReviewRequired:
            unused("DevHub does not run automatic approval review")
        case .rawResponseItemCompleted, .rawResponseCompleted: unused("DevHub does not ask for raw events")
        case .commandExecOutputDelta, .processOutputDelta, .processExited: unused("DevHub runs no command/exec")
        case .itemCommandExecutionTerminalInteraction: unused("the command's output already shows what it printed")
        case .itemFileChangeOutputDelta: unused("deprecated; the server no longer sends it")
        case .itemMcpToolCallProgress: unused("progress messages are not drawn in v1")
        case .mcpServerOauthLoginCompleted: unused("DevHub starts no MCP login")
        case .mcpServerStartupStatusUpdated: unused("MCP server status is not drawn in v1")
        case .mcpServerEventStreamNotification: unused("MCP server events are not drawn in v1")
        case .accountUpdated, .accountGatewayOAuthChanged, .accountLoginCompleted,
            .modelProviderAuthRecoveryStarted, .modelProviderAuthRecoveryCompleted:
            unused("sign-in happens in a terminal")
        case .appListUpdated: unused("DevHub lists no Codex apps")
        case .remoteControlStatusChanged: unused("DevHub is the remote control")
        case .externalAgentConfigImportProgress, .externalAgentConfigImportCompleted:
            unused("DevHub imports no agent config")
        case .fsChanged: unused("DevHub watches no files through Codex")
        case .threadCompacted: unused("the contextCompaction item says it")
        case .modelVerification: unused("model verification is not drawn in v1")
        case .turnModerationMetadata: unused("moderation metadata is not drawn")
        case .modelSafetyBufferingUpdated: unused("safety buffering is not drawn in v1")
        case .fuzzyFileSearchSessionUpdated, .fuzzyFileSearchSessionCompleted:
            unused("DevHub runs no fuzzy file search through Codex")
        case .threadRealtimeStarted, .threadRealtimeItemAdded, .threadRealtimeItemStarted,
            .threadRealtimeItemTranscriptDelta, .threadRealtimeItemCompleted, .threadRealtimeTranscriptDelta,
            .threadRealtimeTranscriptDone, .threadRealtimeOutputAudioDelta, .threadRealtimeSdp, .threadRealtimeError,
            .threadRealtimeClosed:
            unused("DevHub has no voice mode")
        case .windowsWorldWritableWarning, .windowsSandboxSetupCompleted: unused("DevHub runs on macOS and Unix hosts")
        }
    }

    /// A method DevHub reads nothing from, and why: the reason is the table's.
    private func unused(_ why: String) {}

    /// Every request the server can make of DevHub, placed: answered, or
    /// declined with the reason DevHub does not do it.
    private func onRequest(_ method: CodexServerRequest, _ id: CodexRpcId, _ params: JsonValue?, _ raw: JsonValue) throws {
        switch method {
        case .commandExecutionRequestApproval: try onCommandApproval(id, params)
        case .fileChangeRequestApproval: try onFileChangeApproval(id, params)
        case .toolRequestUserInput: try onUserInput(id, params)
        case .mcpServerElicitationRequest: try onElicitation(id, params)
        case .permissionsRequestApproval: try onPermissionsApproval(id, params)
        case .toolCall: try decline(id, method.rawValue, "DevHub registers no dynamic tools", raw)
        case .chatgptAuthTokensRefresh: try decline(id, method.rawValue, "DevHub never hands Codex credentials", raw)
        case .attestationGenerate: try decline(id, method.rawValue, "DevHub does not offer attestation", raw)
        case .applyPatchApproval, .execCommandApproval:
            try decline(id, method.rawValue, "a v1 approval; DevHub speaks v2", raw)
        }
    }
}

// MARK: - Status words

private func commandStatus(_ status: CodexCallStatus) -> ToolStatus {
    switch status {
    case .inProgress: return .running
    case .completed: return .succeeded
    case .failed: return .failed
    case .declined: return .denied
    case .interrupted: return .interrupted
    }
}

private func collabStatus(_ status: CodexCallStatus) -> ToolStatus {
    status == .interrupted ? .interrupted : commandStatus(status)
}

private func subagentState(_ status: CodexCollabAgentStatus) -> SubagentState {
    switch status {
    case .pendingInit, .running: return .running
    case .completed, .shutdown: return .completed
    case .errored, .interrupted: return .failed
    case .notFound: return .unknown
    }
}

/// A call's arguments, as a title reads them: an object, or nothing to read.
private func argumentsOf(_ value: JsonValue) -> JsonObject {
    value.objectValue ?? JsonObject()
}

/// An image sent as a data URL, read back as the page draws it.
private func dataImage(_ url: String) -> ImageRef {
    ImageRef(mediaType: dataUrlMediaType(url), source: .url(url), label: "image")
}

/// A command's output as Codex gives it: stdout and stderr as one.
private func commandPart(_ exitCode: Double?, _ output: String) -> ToolOutputPart {
    .command(exitCode: exitCode, output: output, stderr: nil, interrupted: false)
}

/// An MCP tool's result, as MCP content: its text and its images (which
/// carry their pixels inline), in order. A result with neither is shown as
/// the JSON it is.
private func mcpParts(_ result: JsonValue) -> ToolOutput {
    let content = result.objectValue?["content"]?.arrayValue ?? []
    let parts: [ToolOutputPart] = content.compactMap { part in
        guard case .object(let fields) = part else { return nil }
        if fields["type"] == "text", case .string(let text)? = fields["text"] { return .text(text) }
        if fields["type"] == "image", case .string(let data)? = fields["data"],
            case .string(let mimeType)? = fields["mimeType"]
        {
            return .image(ImageRef(mediaType: mimeType, source: .data(base64: data), label: "image"))
        }
        return nil
    }
    return parts.isEmpty ? [.text(result.jsonText(indent: 2))] : parts
}

/// Codex's version, from the user agent `initialize` answers with.
///
/// The agent is `<client name>/<codex version> (<platform>) …` — the name at
/// its head is the one DevHub sent as `clientInfo.name`, so the whole string
/// reads as DevHub's, not Codex's. The version after the slash is Codex's own.
private func versionOf(_ userAgent: String) -> String? {
    matches(#"^[^/\s]+/(\S+)"#, in: userAgent).first?[1] ?? nil
}

/// A JSON object of these pairs, in this order.
private func obj(_ pairs: [(String, JsonValue)]) -> JsonValue {
    .object(JsonObject(pairs))
}
