// Port of apps/desktop/src/main/cli/tell/service.ts
//
// The app's answer to `devhub --tell`.
//
// Everything here is phrased against `TellPorts`, which the app's coordinator
// implements with the very calls its own window makes (`appController.ts`
// `tellPorts` in the TypeScript app), so a command line and a click cannot
// disagree about what an operation means. This file only resolves names to
// ids, enforces what a command line may not do, and words the answer twice:
// as a sentence for a person, and as data for `--json`.
//
// The data is built in the TypeScript app's key order, so `devhub --tell
// --json` prints the same bytes from either app.

import Foundation

public struct TellAgent: Equatable, Sendable {
    public var id: String
    public var name: String
    public var workspaceId: String
    public var profileId: String
    /// `claude`, `codex`, or the profile's other kind.
    public var kind: String
    public var presentation: TellPresentation
    /// working, background, waiting, idle, error, unknown.
    public var status: String
    public var unread: String?
    public var activity: String?

    public init(
        id: String, name: String, workspaceId: String, profileId: String, kind: String,
        presentation: TellPresentation, status: String, unread: String? = nil, activity: String? = nil
    ) {
        self.id = id
        self.name = name
        self.workspaceId = workspaceId
        self.profileId = profileId
        self.kind = kind
        self.presentation = presentation
        self.status = status
        self.unread = unread
        self.activity = activity
    }

    var fields: [(String, WireJSON?)] {
        [
            ("id", .string(id)), ("name", .string(name)), ("workspaceId", .string(workspaceId)),
            ("profileId", .string(profileId)), ("kind", .string(kind)),
            ("presentation", .string(presentation.rawValue)), ("status", .string(status)),
            ("unread", .optional(unread)), ("activity", .optional(activity)),
        ]
    }
}

public struct TellWorkspace: Equatable, Sendable {
    public var id: String
    public var name: String
    public var root: String
    /// `local`, or `ssh:<host>`.
    public var machine: String
    public var scratch: Bool
    public var selected: Bool
    public var branch: String?
    /// The main checkout, when this workspace is a worktree of one.
    public var worktreeOf: String?
    public var repositoryUrl: String?
    public var issue: String?
    /// The dev container the editor is attached to, when it is.
    public var container: String?
    public var agents: [TellAgent]

    public init(
        id: String, name: String, root: String, machine: String = "local", scratch: Bool = false,
        selected: Bool = false, branch: String? = nil, worktreeOf: String? = nil, repositoryUrl: String? = nil,
        issue: String? = nil, container: String? = nil, agents: [TellAgent] = []
    ) {
        self.id = id
        self.name = name
        self.root = root
        self.machine = machine
        self.scratch = scratch
        self.selected = selected
        self.branch = branch
        self.worktreeOf = worktreeOf
        self.repositoryUrl = repositoryUrl
        self.issue = issue
        self.container = container
        self.agents = agents
    }
}

// MARK: - A GUI Agent's conversation, as far as a command line reaches into it

/// A transcript entry as `agent read` words it: the fields of
/// `model/conversation.ts`'s `TranscriptEntry` it reads, and no more. The
/// coordinator maps WP5's entries into these.
public enum TellTranscriptEntry: Equatable, Sendable {
    case user(id: String, text: String)
    /// The person's answer to questions the Agent asked.
    case answer(id: String, answers: [TellQuestionAnswer])
    /// A command the CLI ran itself (`/model sonnet`, `! ls`) and what it printed.
    case command(id: String, line: String?, output: String?)
    /// The markdown of its text blocks, in order (other blocks left out).
    case assistant(id: String, texts: [String])
    case tool(id: String, tool: String, title: String, status: String)
    case notice(id: String, text: String)
    case compaction(id: String)
    case turnEnd(id: String, outcome: String, detail: String?)

    public var id: String {
        switch self {
        case let .user(id, _), let .answer(id, _), let .command(id, _, _), let .assistant(id, _),
            let .tool(id, _, _, _), let .notice(id, _), let .compaction(id), let .turnEnd(id, _, _):
            return id
        }
    }

    public var kind: String {
        switch self {
        case .user: return "user"
        case .answer: return "answer"
        case .command: return "command"
        case .assistant: return "assistant"
        case .tool: return "tool"
        case .notice: return "notice"
        case .compaction: return "compaction"
        case .turnEnd: return "turn-end"
        }
    }
}

public struct TellQuestionAnswer: Equatable, Sendable {
    public var question: String
    public var chosen: [String]
    public var written: String?

    public init(question: String, chosen: [String], written: String? = nil) {
        self.question = question
        self.chosen = chosen
        self.written = written
    }
}

/// One question of an AskUserQuestion / requestUserInput.
public struct TellQuestion: Equatable, Sendable {
    /// The key its answer is filed under in the answer's values.
    public var id: String
    public var header: String
    public var text: String
    public var options: [TellQuestionOption]
    public var multiSelect: Bool
    /// Whether a free-text "Other" answer is accepted.
    public var allowsOther: Bool

    public init(
        id: String, header: String, text: String, options: [TellQuestionOption], multiSelect: Bool, allowsOther: Bool
    ) {
        self.id = id
        self.header = header
        self.text = text
        self.options = options
        self.multiSelect = multiSelect
        self.allowsOther = allowsOther
    }
}

public struct TellQuestionOption: Equatable, Sendable {
    public var label: String
    public var description: String

    public init(label: String, description: String = "") {
        self.label = label
        self.description = description
    }
}

/// What an open request is about (`RequestSubject`).
public enum TellRequestSubject: Equatable, Sendable {
    case tool(tool: String, title: String)
    case command(command: String)
    case fileChange(paths: [String])
    case question([TellQuestion])
    /// An MCP server asking the person something through the Agent.
    case elicitation(server: String, message: String)

    public var kind: String {
        switch self {
        case .tool: return "tool"
        case .command: return "command"
        case .fileChange: return "file-change"
        case .question: return "question"
        case .elicitation: return "elicitation"
        }
    }
}

public struct TellPendingRequest: Equatable, Sendable {
    public var id: String
    public var subject: TellRequestSubject

    public init(id: String, subject: TellRequestSubject) {
        self.id = id
        self.subject = subject
    }
}

/// The answer to a question request (`RequestAnswer` of kind `answers`).
public struct TellRequestAnswer: Equatable, Sendable {
    public enum Value: Equatable, Sendable {
        case one(String)
        case many([String])

        var json: WireJSON {
            switch self {
            case let .one(text): return .string(text)
            case let .many(texts): return .strings(texts)
            }
        }
    }

    /// By question id, in the questions' order.
    public var values: [(id: String, value: Value)]
    /// A note per question, by the same key: who answered.
    public var notes: [(id: String, note: String)]

    public init(values: [(id: String, value: Value)], notes: [(id: String, note: String)]) {
        self.values = values
        self.notes = notes
    }

    public static func == (lhs: TellRequestAnswer, rhs: TellRequestAnswer) -> Bool {
        lhs.values.map(\.id) == rhs.values.map(\.id) && lhs.values.map(\.value) == rhs.values.map(\.value)
            && lhs.notes.map(\.id) == rhs.notes.map(\.id) && lhs.notes.map(\.note) == rhs.notes.map(\.note)
    }

    public var json: WireJSON {
        .object([
            (key: "kind", value: .string("answers")),
            (key: "values", value: .object(values.map { (key: $0.id, value: $0.value.json) })),
            (key: "notes", value: .object(notes.map { (key: $0.id, value: .string($0.note)) })),
        ])
    }
}

/// One GUI Agent's conversation, as far as a command line reaches into it.
public protocol TellConversation: Sendable {
    func entries() async -> [TellTranscriptEntry]
    func requests() async -> [TellPendingRequest]
    /// `none`, `running`, `rewinding`, `connecting` or `broken`.
    func turn() async -> String
    /// The person's words, held while a turn runs — the composer's own path.
    func submit(_ text: String) async throws
    func interrupt() async throws
    func answer(_ request: String, _ answer: TellRequestAnswer) async throws
}

public struct IssueAssignRequest: Equatable, Sendable {
    public var url: String
    public var repo: String?
    public var branch: String?
    public var place: IssuePlace
    public var profile: String?
    public var action: String?
    public var editorOnly: Bool
    public var presentation: TellPresentation?

    /// As the TypeScript service builds it (every key, `undefined` dropped).
    public var json: WireJSON {
        .object(dropping: [
            ("url", .string(url)), ("repo", .optional(repo)), ("branch", .optional(branch)),
            ("place", .string(place.rawValue)), ("profile", .optional(profile)), ("action", .optional(action)),
            ("editorOnly", .bool(editorOnly)), ("presentation", .optional(presentation?.rawValue)),
        ])
    }
}

// MARK: - Terminals

/// One tmux pane inside an Agent's terminal, read live. Everything is on the
/// Workspace's machine, so the paths are paths there.
public struct TellTerminalPane: Equatable, Sendable {
    /// tmux's window id (`@3`), index and name.
    public var window: String
    public var windowIndex: Int
    public var windowName: String
    /// The window is the one the session shows.
    public var windowActive: Bool
    /// tmux's pane id (`%7`): unique on the server, the target to use.
    public var pane: String
    public var paneIndex: Int
    /// Its window's active pane, in the session's active window.
    public var active: Bool
    /// Where it is in its window, in cells from the top left.
    public var left: Int
    public var top: Int
    public var width: Int
    public var height: Int
    public var cwd: String
    /// The foreground process, as tmux names it: the shell at a prompt.
    public var command: String
    public var title: String
    public var dead: Bool

    public init(
        window: String, windowIndex: Int, windowName: String, windowActive: Bool, pane: String, paneIndex: Int,
        active: Bool, left: Int, top: Int, width: Int, height: Int, cwd: String, command: String, title: String,
        dead: Bool
    ) {
        self.window = window
        self.windowIndex = windowIndex
        self.windowName = windowName
        self.windowActive = windowActive
        self.pane = pane
        self.paneIndex = paneIndex
        self.active = active
        self.left = left
        self.top = top
        self.width = width
        self.height = height
        self.cwd = cwd
        self.command = command
        self.title = title
        self.dead = dead
    }

    var fields: [(String, WireJSON?)] {
        [
            ("window", .string(window)), ("windowIndex", .int(windowIndex)), ("windowName", .string(windowName)),
            ("windowActive", .bool(windowActive)), ("pane", .string(pane)), ("paneIndex", .int(paneIndex)),
            ("active", .bool(active)), ("left", .int(left)), ("top", .int(top)), ("width", .int(width)),
            ("height", .int(height)), ("cwd", .string(cwd)), ("command", .string(command)),
            ("title", .string(title)), ("dead", .bool(dead)),
        ]
    }
}

/// One pane of the asking Agent's Workspace's editor terminals: the tmux
/// session the editor attaches to, on the same server.
public struct TellEditorPane: Equatable, Sendable {
    public var pane: TellTerminalPane
    public var session: String
    /// What its terminal runs in front, as a command line (`ssh prod`), when known.
    public var argv: String?

    public init(pane: TellTerminalPane, session: String, argv: String?) {
        self.pane = pane
        self.session = session
        self.argv = argv
    }

    public var json: WireJSON {
        .object(dropping: pane.fields + [("session", .string(session)), ("argv", .optional(argv))])
    }
}

/// The asking Agent's own terminal, as the app knows it now.
public struct TellTerminal: Equatable, Sendable {
    public struct Live: Equatable, Sendable {
        /// The tmux DevHub runs there, which may not be the one on PATH.
        public var tmux: String
        /// The server's socket, absolute: what `tmux -S` takes.
        public var socket: String
        public var panes: [TellTerminalPane]

        public init(tmux: String, socket: String, panes: [TellTerminalPane]) {
            self.tmux = tmux
            self.socket = socket
            self.panes = panes
        }
    }

    public struct Session: Equatable, Sendable {
        public var id: String
        /// `tm-<id>`.
        public var name: String
        /// Its pane is shown when its Agent is the view's.
        public var open: Bool
        /// On screen now: open, and its Agent on screen with it.
        public var visible: Bool
        /// It has the person's keyboard.
        public var focused: Bool
        /// The live half, from tmux; absent when tmux could not be asked.
        public var tmux: Live?

        public init(id: String, name: String, open: Bool, visible: Bool, focused: Bool, tmux: Live?) {
            self.id = id
            self.name = name
            self.open = open
            self.visible = visible
            self.focused = focused
            self.tmux = tmux
        }
    }

    public var agentId: String
    public var workspaceId: String
    /// Its session is up. Absent: it has none yet, or it was closed.
    public var session: Session?

    public init(agentId: String, workspaceId: String, session: Session?) {
        self.agentId = agentId
        self.workspaceId = workspaceId
        self.session = session
    }
}

/// What the app does for `devhub --tell`: the coordinator implements these
/// with the calls its own window makes (WP2/Wave 2).
public protocol TellPorts: Sendable {
    func workspaces() async -> [TellWorkspace]
    func profiles() async -> [(id: String, kind: String)]
    /// Open (or select) the folder; answers the workspace's id.
    func openWorkspace(path: String, machine: String, worktree: String?) async throws -> String
    /// Start an Agent; answers its id.
    func createAgent(workspaceId: String, profileId: String, presentation: TellPresentation?) async throws -> String
    func renameAgent(_ agentId: String, name: String) async throws
    /// Queue words for an Agent: sent once it is idle, through the same queue
    /// DevHub's own injections go through. The one way to reach a terminal Agent.
    func queueText(_ agentId: String, text: String) async throws
    func assignIssue(_ request: IssueAssignRequest) async throws -> (workspaceId: String, agentId: String?)
    /// A GUI Agent's conversation; nil for a terminal Agent.
    func conversation(_ agentId: String) async throws -> (any TellConversation)?
    func commands() async -> [TellPaletteCommand]
    /// Run a palette command the way the palette does; false if it had nothing to do.
    func runCommand(_ id: String) async -> Bool
    func focusWorkspace(_ workspaceId: String) async throws
    func focusAgent(_ agentId: String) async throws
    func notify(_ text: String) async throws
    /// An Agent's own terminal, read live.
    func agentTerminal(_ agentId: String) async throws -> TellTerminal
    /// Open an Agent's terminal, or show the one it has (idempotent). Answers
    /// whether this call started its session; `command` is typed only then.
    func openAgentTerminal(_ agentId: String, command: String?, focus: Bool) async throws -> Bool
    /// Close an Agent's terminal and its session; whether it had one.
    func closeAgentTerminal(_ agentId: String) async throws -> Bool
    /// The panes of an Agent's Workspace's editor terminals, read live.
    func editorPanes(_ agentId: String) async throws -> [TellEditorPane]
    /// Move one of them (by tmux id) into the Agent's terminal, still running.
    /// Answers whether the terminal was created by it.
    func bringPane(_ agentId: String, pane: String, focus: Bool) async throws -> Bool
}

public struct TellPaletteCommand: Equatable, Sendable {
    public var id: String
    public var label: String
    public var category: String
    public var available: Bool

    public init(id: String, label: String, category: String, available: Bool) {
        self.id = id
        self.label = label
        self.category = category
        self.available = available
    }

    var json: WireJSON {
        ["id": .string(id), "label": .string(label), "category": .string(category), "available": .bool(available)]
    }
}

/// Which Agent is asking, from its pane's `DEVHUB_ORIGIN`.
public struct TellCaller: Equatable, Sendable {
    public var machine: String
    public var agentId: String?
    public var workspaceId: String?
    /// Known only by `DEVHUB_MACHINE`: not a DevHub pane, so no workspace or agent.
    public var paneless: Bool

    public init(machine: String, agentId: String?, workspaceId: String?, paneless: Bool = false) {
        self.machine = machine
        self.agentId = agentId
        self.workspaceId = workspaceId
        self.paneless = paneless
    }

    /// `<machine>\t<workspace | "scratch">\t<agent | "none">`, as tmux.ts writes it.
    public static func fromOrigin(_ origin: String?) -> TellCaller? {
        guard let origin else { return nil }
        let parts = origin.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 3 else { return nil }
        return TellCaller(
            machine: parts[0], agentId: parts[2] == "none" ? nil : parts[2],
            workspaceId: parts[1] == "scratch" ? nil : parts[1])
    }

    /// Who is asking, from both things a request can carry: the pane's
    /// `DEVHUB_ORIGIN` and the shim's `DEVHUB_MACHINE`. The origin wins where
    /// it is there; a `devhub` on a host run from somewhere that is not a
    /// DevHub pane still says which machine its paths are on.
    public static func from(origin: String?, machine: String?) -> TellCaller? {
        if let caller = fromOrigin(origin) { return caller }
        guard let machine, !machine.isEmpty else { return nil }
        return TellCaller(machine: machine, agentId: nil, workspaceId: nil, paneless: true)
    }
}

/// What a tell answers: a sentence and the same as data.
public struct TellAnswer: Equatable, Sendable {
    public var message: String
    public var data: WireJSON

    public init(message: String, data: WireJSON) {
        self.message = message
        self.data = data
    }
}

/// A tell refused, in a sentence.
public struct TellRefusal: Error, Equatable, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public protocol TellClock: Sendable {
    func now() async -> Double
    func sleep(milliseconds: Int) async throws
}

public struct SystemTellClock: TellClock {
    public init() {}
    public func now() async -> Double { Date().timeIntervalSince1970 * 1000 }
    public func sleep(milliseconds: Int) async throws { try await Task.sleep(for: .milliseconds(milliseconds)) }
}

public struct TellService: Sendable {
    static let waitPollMs = 500
    static let defaultReadLast = 20
    /// The longest a transcript line gets in text: a tool's output is a summary.
    static let lineLimit = 2000

    private let ports: any TellPorts
    private let clock: any TellClock

    public init(ports: any TellPorts, clock: any TellClock = SystemTellClock()) {
        self.ports = ports
        self.clock = clock
    }

    public func run(_ command: TellCommand, caller: TellCaller?) async throws -> TellAnswer {
        let run = Run(ports: ports, clock: clock, caller: caller)
        switch command {
        case .help:
            return TellAnswer(message: tellUsage, data: ["usage": .string(tellUsage)])
        case .workspaces:
            return await run.listWorkspaces()
        case let .workspaceOpen(path, worktree):
            return try await run.openWorkspace(path, worktree)
        case let .agents(workspace):
            return try await run.listAgents(workspace)
        case let .agentNew(new):
            return try await run.newAgent(new)
        case let .issueAssign(issue):
            return try await run.assignIssue(issue)
        case let .agentRead(agent, last, since):
            return try await run.read(agent, last, since)
        case let .agentSend(agent, text):
            return try await run.send(agent, text)
        case let .agentInterrupt(agent):
            return try await run.interrupt(agent)
        case let .agentRequests(agent):
            return try await run.requests(agent)
        case let .agentAnswer(agent, request, options, text):
            return try await run.answer(agent, request, options, text)
        case let .agentWait(agent, until, timeoutSeconds):
            return try await run.wait(agent, until, timeoutSeconds)
        case .commands:
            return await run.listCommands()
        case let .run(id):
            return try await run.runCommand(id)
        case let .focus(target):
            return try await run.focus(target)
        case let .notify(text):
            try await ports.notify(text)
            return TellAnswer(message: "Shown in DevHub.", data: ["ok": true])
        case let .terminalOpen(command, focus):
            return try await run.openTerminal(command, focus)
        case .terminalStatus:
            return try await run.terminalStatus()
        case .terminalClose:
            return try await run.closeTerminal()
        case .terminalPanes:
            return try await run.editorPanes()
        case let .terminalBring(pane, focus):
            return try await run.bring(pane, focus)
        }
    }

    /// One command's run: the caller it names things for.
    private struct Run {
        let ports: any TellPorts
        let clock: any TellClock
        let caller: TellCaller?

        // MARK: terminals

        /// The Agent a terminal command is about: the asker itself, and no
        /// other. There is no `--agent` for these on purpose — reaching into
        /// another Agent's shell is not something one Agent may do to another.
        func callerAgent() async throws -> TellAgent {
            guard let caller, !caller.paneless else {
                throw TellRefusal(
                    "terminal commands work only from inside a DevHub agent: they are about the asking agent's own terminal, and this devhub is not running in one."
                )
            }
            guard let agentId = caller.agentId else {
                throw TellRefusal(
                    "terminal commands are an agent's: run them from the agent's own pane. (This is a terminal, not an agent.)"
                )
            }
            for workspace in await ports.workspaces() {
                if let agent = workspace.agents.first(where: { $0.id == agentId }) { return agent }
            }
            throw TellRefusal("the agent asking (\(agentId)) is not one DevHub has open any more.")
        }

        func openTerminal(_ command: String?, _ focus: Bool) async throws -> TellAnswer {
            let agent = try await callerAgent()
            let created = try await ports.openAgentTerminal(agent.id, command: command, focus: focus)
            let terminal = try await ports.agentTerminal(agent.id)
            guard terminal.session != nil else {
                throw TellRefusal("the terminal opened and was gone again at once: its shell exited. Check --command.")
            }
            let described = DescribedTerminal(terminal)
            let notTyped =
                !created && command != nil
                ? [
                    "It was already running, so --command was not typed into it: send it with send-keys (below) if you still want it."
                ] : []
            return TellAnswer(
                message: (["\(created ? "Opened" : "Showing") your terminal: \(TellWords.terminalLine(described))."]
                    + notTyped + TellWords.driveHints(described)).joined(separator: "\n"),
                data: ["terminal": described.json, "created": .bool(created)])
        }

        func terminalStatus() async throws -> TellAnswer {
            let agent = try await callerAgent()
            let terminal = try await ports.agentTerminal(agent.id)
            let described = DescribedTerminal(terminal)
            if terminal.session == nil {
                return TellAnswer(
                    message: "You have no terminal open. 'devhub --tell terminal open' opens one, beside your pane.",
                    data: ["terminal": described.json])
            }
            return TellAnswer(
                message: ([TellWords.terminalLine(described)] + TellWords.paneLines(described)
                    + TellWords.driveHints(described)).joined(separator: "\n"),
                data: ["terminal": described.json])
        }

        func closeTerminal() async throws -> TellAnswer {
            let agent = try await callerAgent()
            let before = try await ports.agentTerminal(agent.id)
            let closed = try await ports.closeAgentTerminal(agent.id)
            return TellAnswer(
                message: closed
                    ? "Closed your terminal (\(before.session?.name ?? "its session"))." : "You had no terminal open.",
                data: .object(dropping: [("closed", .bool(closed)), ("session", .optional(before.session?.name))]))
        }

        func editorPanes() async throws -> TellAnswer {
            let agent = try await callerAgent()
            let panes = try await ports.editorPanes(agent.id)
            return TellAnswer(
                message: panes.isEmpty
                    ? "Your workspace's editor has no DevHub terminal open."
                    : ([
                        "Your workspace's editor terminals ('devhub --tell terminal bring <pane>' moves one into your terminal):"
                    ] + panes.map(TellWords.editorPaneLine)).joined(separator: "\n"),
                data: ["panes": .array(panes.map(\.json))])
        }

        func bring(_ paneId: String, _ focus: Bool) async throws -> TellAnswer {
            let agent = try await callerAgent()
            let panes = try await ports.editorPanes(agent.id)
            guard let pane = panes.first(where: { $0.pane.pane == paneId }) else {
                throw TellRefusal(
                    "\(paneId) is not a pane of your workspace's editor terminals (see 'devhub --tell terminal panes'). Agents' own panes and terminals are never moved."
                )
            }
            let created = try await ports.bringPane(agent.id, pane: paneId, focus: focus)
            let described = DescribedTerminal(try await ports.agentTerminal(agent.id))
            let left = panes.filter { $0.pane.window == pane.pane.window }.count == 1
            let first =
                "Brought \(paneId) (\(pane.argv ?? pane.pane.command)) \(created ? "into your new terminal" : "into your terminal, as a split"): \(TellWords.terminalLine(described))."
            let closing =
                left
                ? [
                    "It was the only pane of its editor terminal window, so that window closed (and the editor's tab with it, if it was the last)."
                ] : []
            return TellAnswer(
                message: ([first] + closing + TellWords.paneLines(described) + TellWords.driveHints(described))
                    .joined(separator: "\n"),
                data: ["terminal": described.json, "created": .bool(created), "pane": .string(paneId)])
        }

        // MARK: names

        /// `<w>` as given, or the workspace of the pane asking when it is left out.
        func workspaceOrCallers(_ name: String?) throws -> String {
            if let name { return name }
            if let caller, !caller.paneless { return caller.workspaceId ?? "scratch" }
            throw TellRefusal(
                "agent new needs --workspace <w> here: this devhub is not running in a DevHub terminal or agent, so there is no workspace to default to."
            )
        }

        func workspace(_ name: String) async throws -> TellWorkspace {
            let all = await ports.workspaces()
            if name == "scratch", let scratch = all.first(where: \.scratch) { return scratch }
            var trimmed = name
            if name.count > 1 {
                while trimmed.hasSuffix("/") { trimmed.removeLast() }
            }
            // A folder is a folder on the machine the asking `devhub` runs on:
            // `/srv/app` typed on a host is not this Mac's `/srv/app`. A caller
            // that cannot say which machine it is on matches any.
            let machine = caller?.machine
            let exact = all.filter {
                $0.id == name || ($0.root == trimmed && (machine == nil || $0.machine == machine)) || $0.name == name
            }
            if exact.count == 1 { return exact[0] }
            if exact.count > 1 {
                throw TellRefusal(
                    "\(WireJSON.quoted(name)) names \(exact.count) workspaces; use an id: \(exact.map(\.id).joined(separator: ", "))."
                )
            }
            let prefixed = all.filter { name.utf16.count >= 4 && $0.id.hasPrefix(name) }
            if prefixed.count == 1 { return prefixed[0] }
            throw TellRefusal(
                "no open workspace is called \(WireJSON.quoted(name)). Run 'devhub --tell workspaces' to see them.")
        }

        func allAgents() async -> [TellAgent] {
            await ports.workspaces().flatMap(\.agents)
        }

        func agent(_ name: String) async throws -> TellAgent {
            let all = await allAgents()
            let exact = all.filter { $0.id == name || $0.name == name }
            if exact.count == 1 { return exact[0] }
            if exact.count > 1 {
                throw TellRefusal(
                    "\(WireJSON.quoted(name)) names \(exact.count) agents; use an id: \(exact.map(\.id).joined(separator: ", "))."
                )
            }
            let prefixed = all.filter { name.utf16.count >= 4 && $0.id.hasPrefix(name) }
            if prefixed.count == 1 { return prefixed[0] }
            if prefixed.count > 1 {
                throw TellRefusal("\(WireJSON.quoted(name)) is the start of more than one agent's id.")
            }
            throw TellRefusal("no agent is called \(WireJSON.quoted(name)). Run 'devhub --tell agents' to see them.")
        }

        func profile(_ id: String?) async throws -> String {
            let profiles = await ports.profiles()
            guard let id else {
                guard let first = profiles.first else { throw TellRefusal("no agent profiles are configured.") }
                return first.id
            }
            guard profiles.contains(where: { $0.id == id }) else {
                let known = profiles.map(\.id).joined(separator: ", ")
                throw TellRefusal(
                    "there is no agent profile called '\(id)'. Configured profiles: \(known.isEmpty ? "none" : known).")
            }
            return id
        }

        func guiConversation(_ agent: TellAgent) async throws -> any TellConversation {
            let conversation = agent.presentation == .gui ? try await ports.conversation(agent.id) : nil
            guard let conversation else {
                throw TellRefusal(
                    "\(agent.name) is a terminal agent, and only a GUI agent's conversation can be read or answered from here. 'agent send' and 'agent wait' work for both."
                )
            }
            return conversation
        }

        // MARK: workspaces

        func listWorkspaces() async -> TellAnswer {
            let workspaces = await ports.workspaces()
            let lines = workspaces.map { workspace -> String in
                let facts = [
                    workspace.machine == "local" ? nil : workspace.machine,
                    workspace.branch.map { "branch \($0)" },
                    workspace.worktreeOf.map { "worktree of \($0)" },
                    workspace.issue,
                    workspace.container.map { "container \($0)" },
                    "\(workspace.agents.count) agent\(workspace.agents.count == 1 ? "" : "s")",
                ].compactMap { $0 }
                return
                    "\(workspace.selected ? "*" : " ") \(workspace.id)  \(workspace.scratch ? "Scratch" : workspace.name)  \(workspace.root)  (\(facts.joined(separator: ", ")))"
            }
            let data: [WireJSON] = workspaces.map { workspace in
                .object(dropping: [
                    ("id", .string(workspace.id)), ("name", .string(workspace.name)), ("root", .string(workspace.root)),
                    ("machine", .string(workspace.machine)), ("scratch", .bool(workspace.scratch)),
                    ("selected", .bool(workspace.selected)), ("branch", .optional(workspace.branch)),
                    ("worktreeOf", .optional(workspace.worktreeOf)),
                    ("repositoryUrl", .optional(workspace.repositoryUrl)), ("issue", .optional(workspace.issue)),
                    ("container", .optional(workspace.container)),
                    ("agents", .strings(workspace.agents.map(\.id))),
                ])
            }
            return TellAnswer(
                message: lines.isEmpty ? "No workspaces are open." : lines.joined(separator: "\n"),
                data: ["workspaces": .array(data)])
        }

        func openWorkspace(_ path: String, _ worktree: String?) async throws -> TellAnswer {
            // The path is a path on the machine the asking `devhub` runs on.
            let machine = caller?.machine ?? "local"
            let id = try await ports.openWorkspace(path: path, machine: machine, worktree: worktree)
            let root = await ports.workspaces().first(where: { $0.id == id })?.root ?? path
            return TellAnswer(
                message: "Workspace \(id) is open at \(root).",
                data: ["workspaceId": .string(id), "root": .string(root)])
        }

        // MARK: agents

        func requestCount(_ agent: TellAgent) async -> Int? {
            guard agent.presentation == .gui else { return nil }
            guard let conversation = try? await ports.conversation(agent.id) else { return nil }
            return await conversation.requests().count
        }

        func listAgents(_ workspace: String?) async throws -> TellAnswer {
            let workspaces = workspace == nil ? await ports.workspaces() : [try await self.workspace(workspace!)]
            var rows: [(agent: TellAgent, workspace: String, requests: Int?)] = []
            for each in workspaces {
                for agent in each.agents {
                    rows.append((agent, each.scratch ? "Scratch" : each.name, await requestCount(agent)))
                }
            }
            let lines = rows.map { row -> String in
                [
                    row.agent.id,
                    row.agent.name,
                    "\(row.agent.kind)/\(row.agent.presentation.rawValue)",
                    row.agent.status,
                    row.agent.unread == nil ? nil : "unread",
                    (row.requests ?? 0) != 0 ? "\(row.requests!) request(s)" : nil,
                    "in \(row.workspace)",
                    row.agent.activity.map { "— \($0)" },
                ].compactMap { $0 }.joined(separator: "  ")
            }
            let data: [WireJSON] = rows.map { row in
                .object(
                    dropping: row.agent.fields + [
                        ("workspace", .string(row.workspace)), ("requests", .optional(row.requests)),
                    ])
            }
            return TellAnswer(
                message: lines.isEmpty ? "No agents are running." : lines.joined(separator: "\n"),
                data: ["agents": .array(data)])
        }

        func newAgent(_ command: TellAgentNew) async throws -> TellAnswer {
            let workspace = try await self.workspace(try workspaceOrCallers(command.workspace))
            let profile = try await self.profile(command.profile)
            let agentId = try await ports.createAgent(
                workspaceId: workspace.id, profileId: profile, presentation: command.presentation)
            if let name = command.name { try await ports.renameAgent(agentId, name: name) }
            if let prompt = command.prompt { try await ports.queueText(agentId, text: prompt) }
            return TellAnswer(
                message:
                    "Agent \(agentId) (\(profile)) is starting in \(workspace.root)\(command.prompt == nil ? "" : "; it is told the prompt once it is ready").",
                data: ["agentId": .string(agentId), "workspaceId": .string(workspace.id), "profile": .string(profile)])
        }

        func assignIssue(_ command: TellIssueAssign) async throws -> TellAnswer {
            let profile = command.editorOnly ? nil : try await self.profile(command.profile)
            let assigned = try await ports.assignIssue(
                IssueAssignRequest(
                    url: command.url, repo: command.repo, branch: command.branch, place: command.place,
                    profile: profile, action: command.action, editorOnly: command.editorOnly,
                    presentation: command.presentation))
            if let prompt = command.prompt, let agentId = assigned.agentId {
                try await ports.queueText(agentId, text: prompt)
            }
            let root = await ports.workspaces().first(where: { $0.id == assigned.workspaceId })?.root
            return TellAnswer(
                message: assigned.agentId == nil
                    ? "Opened \(root ?? "the workspace") for \(command.url)."
                    : "Agent \(assigned.agentId!) is taking \(command.url) in \(root ?? "its workspace").",
                data: .object(dropping: [
                    ("workspaceId", .string(assigned.workspaceId)), ("agentId", .optional(assigned.agentId)),
                    ("root", .optional(root)),
                ]))
        }

        // MARK: one agent

        func read(_ name: String, _ last: Int?, _ since: String?) async throws -> TellAnswer {
            let agent = try await self.agent(name)
            let conversation = try await guiConversation(agent)
            let entries = await conversation.entries()
            var from = max(0, entries.count - (last ?? TellService.defaultReadLast))
            if let since {
                // A cursor that is gone (a rewind, a compaction) reads from the tail.
                if let at = entries.firstIndex(where: { $0.id == since }) { from = at + 1 }
                if let last { from = max(from, entries.count - last) }
            }
            let shown = Array(entries[min(from, entries.count)...])
            let cursor = entries.last?.id ?? since ?? ""
            let lines = shown.compactMap(TellWords.entryLine)
            let requests = await conversation.requests().count
            let turn = await conversation.turn()
            return TellAnswer(
                message: (lines + [
                    "-- \(agent.name): \(agent.status), turn \(turn)\(requests > 0 ? ", \(requests) open request(s)" : ""); cursor \(cursor)"
                ]).joined(separator: "\n"),
                data: [
                    "agentId": .string(agent.id), "status": .string(agent.status), "turn": .string(turn),
                    "requests": .int(requests), "cursor": .string(cursor),
                    "entries": .array(
                        shown.map { entry in
                            .object(dropping: [
                                ("id", .string(entry.id)), ("kind", .string(entry.kind)),
                                ("text", .optional(TellWords.entryLine(entry))),
                            ])
                        }),
                ])
        }

        func send(_ name: String, _ text: String) async throws -> TellAnswer {
            let agent = try await self.agent(name)
            if agent.presentation == .gui {
                let conversation = try await guiConversation(agent)
                try await conversation.submit(text)
                let running = await conversation.turn() == "running"
                return TellAnswer(
                    message: "Sent to \(agent.name)\(running ? " (held until its turn ends)" : "").",
                    data: ["agentId": .string(agent.id), "queued": .bool(running)])
            }
            try await ports.queueText(agent.id, text: text)
            return TellAnswer(
                message: "Queued for \(agent.name); it is typed once the agent is idle.",
                data: ["agentId": .string(agent.id), "queued": true])
        }

        func interrupt(_ name: String) async throws -> TellAnswer {
            let agent = try await self.agent(name)
            let conversation = try await guiConversation(agent)
            try await conversation.interrupt()
            return TellAnswer(message: "Interrupted \(agent.name).", data: ["agentId": .string(agent.id)])
        }

        func requests(_ name: String) async throws -> TellAnswer {
            let agent = try await self.agent(name)
            let conversation = try await guiConversation(agent)
            let views = await conversation.requests().map(TellWords.requestView)
            return TellAnswer(
                message: views.isEmpty
                    ? "\(agent.name) is not waiting on anything." : views.map(\.text).joined(separator: "\n\n"),
                data: ["agentId": .string(agent.id), "requests": .array(views.map(\.json))])
        }

        func answer(_ name: String, _ requestId: String, _ options: [Int], _ text: String?) async throws
            -> TellAnswer
        {
            let agent = try await self.agent(name)
            if let asking = caller?.agentId, asking == agent.id {
                throw TellRefusal("an agent cannot answer its own question.")
            }
            let conversation = try await guiConversation(agent)
            guard let request = await conversation.requests().first(where: { $0.id == requestId }) else {
                throw TellRefusal(
                    "\(agent.name) has no open request \(requestId). Run 'devhub --tell agent requests \(agent.id)'.")
            }
            guard case let .question(questions) = request.subject else {
                throw TellRefusal(
                    "request \(requestId) is \(TellWords.requestKind(request)), and only questions can be answered from the command line. The person answers it in DevHub."
                )
            }
            let answer = try TellWords.questionAnswer(
                questions, options: options, text: text,
                note: TellWords.answeredBy(caller, workspaces: await ports.workspaces()))
            try await conversation.answer(request.id, answer)
            return TellAnswer(
                message: "Answered \(agent.name)'s question.",
                data: ["agentId": .string(agent.id), "request": .string(request.id), "answer": answer.json])
        }

        func wait(_ name: String, _ until: AgentWaitUntil, _ timeoutSeconds: Int) async throws -> TellAnswer {
            let id = try await self.agent(name).id
            let deadline = await clock.now() + Double(timeoutSeconds) * 1000
            while true {
                guard let agent = await allAgents().first(where: { $0.id == id }) else {
                    return TellAnswer(
                        message: "Agent \(id) is gone.",
                        data: ["agentId": .string(id), "status": "gone", "reached": true])
                }
                let requests = await requestCount(agent) ?? 0
                let waiting = agent.status == "waiting" || requests > 0
                let idle = agent.status == "idle" || agent.status == "error"
                let reached: Bool
                switch until {
                case .idle: reached = idle
                case .waiting: reached = waiting
                case .any: reached = idle || waiting
                }
                let now = await clock.now()
                if reached || now >= deadline {
                    return TellAnswer(
                        message:
                            "\(agent.name) is \(agent.status)\(requests > 0 ? " with \(requests) open request(s)" : "")\(reached ? "" : " (still, after \(timeoutSeconds)s)").",
                        data: [
                            "agentId": .string(id), "status": .string(agent.status), "requests": .int(requests),
                            "reached": .bool(reached),
                        ])
                }
                try await clock.sleep(milliseconds: TellService.waitPollMs)
            }
        }

        // MARK: the app

        func listCommands() async -> TellAnswer {
            let commands = await ports.commands()
            return TellAnswer(
                message: commands.map { "\($0.available ? " " : "-") \($0.id)  \($0.category): \($0.label)" }
                    .joined(separator: "\n"),
                data: ["commands": .array(commands.map(\.json))])
        }

        func runCommand(_ id: String) async throws -> TellAnswer {
            guard let known = await ports.commands().first(where: { $0.id == id }) else {
                throw TellRefusal("there is no command \(WireJSON.quoted(id)). Run 'devhub --tell commands'.")
            }
            let ran = await ports.runCommand(id)
            return TellAnswer(
                message: ran
                    ? "Ran \(known.category): \(known.label)."
                    : "\(known.category): \(known.label) has nothing to do right now.",
                data: ["command": .string(id), "ran": .bool(ran)])
        }

        func focus(_ target: String) async throws -> TellAnswer {
            if let agent = try? await self.agent(target) {
                try await ports.focusAgent(agent.id)
                return TellAnswer(message: "Selected \(agent.name).", data: ["agentId": .string(agent.id)])
            }
            let workspace = try await self.workspace(target)
            try await ports.focusWorkspace(workspace.id)
            return TellAnswer(
                message: "Selected \(workspace.scratch ? "Scratch" : workspace.name).",
                data: ["workspaceId": .string(workspace.id)])
        }
    }
}

// MARK: - Words

/// One tmux pane of the terminal as `--json` writes it, with what a person
/// calls it: `where` is its place in its window — `top-left`, `bottom-right`,
/// `right`, `whole` — so "the bottom-right pane" is a lookup, not a sum.
public struct DescribedTerminalPane: Equatable, Sendable {
    public var pane: TellTerminalPane
    public var `where`: String
    /// `-t` this.
    public var target: String
    /// The same pane as `session:window.pane`.
    public var fullTarget: String

    var json: WireJSON {
        .object(
            dropping: pane.fields + [
                ("where", .string(`where`)), ("target", .string(target)), ("fullTarget", .string(fullTarget)),
            ])
    }
}

/// The asking Agent's terminal as `--json` writes it: the handle to drive it by.
public struct DescribedTerminal: Equatable, Sendable {
    public struct Handle: Equatable, Sendable {
        public var tmux: String
        public var socket: String
        public var session: String
        /// The active pane of the active window: the one the person sees typed into.
        public var window: String
        public var windowIndex: Int
        public var pane: String
        public var paneIndex: Int
        /// `-t` this: the pane id, which nothing else on the server has.
        public var target: String
        /// The same pane as `session:window.pane`.
        public var fullTarget: String
        /// Every command starts with these: `tmux -S <socket>`.
        public var prefix: [String]
        public var cwd: String
        public var command: String
        public var title: String

        var json: WireJSON {
            [
                "tmux": .string(tmux), "socket": .string(socket), "session": .string(session),
                "window": .string(window), "windowIndex": .int(windowIndex), "pane": .string(pane),
                "paneIndex": .int(paneIndex), "target": .string(target), "fullTarget": .string(fullTarget),
                "prefix": .strings(prefix), "cwd": .string(cwd), "command": .string(command),
                "title": .string(title),
            ]
        }
    }

    public var agentId: String
    public var workspaceId: String
    /// It has a session. The rest is absent when it does not.
    public var exists: Bool
    public var id: String?
    public var session: String?
    public var open: Bool
    public var visible: Bool
    public var focused: Bool
    /// The tmux handle, with the active pane as its target. Absent when there
    /// is no session or tmux could not be asked.
    public var tmux: Handle?
    /// Every tmux pane in the session, every window's, in tmux's order.
    public var panes: [DescribedTerminalPane]

    public init(_ terminal: TellTerminal) {
        let session = terminal.session
        let live = session?.tmux
        var panes: [DescribedTerminalPane] = []
        if let live, let session {
            panes = live.panes.map { pane in
                DescribedTerminalPane(
                    pane: pane,
                    where: TellWords.paneWhere(pane, window: live.panes.filter { $0.window == pane.window }),
                    target: pane.pane,
                    fullTarget: "\(session.name):\(pane.windowIndex).\(pane.paneIndex)")
            }
        }
        let front = panes.first(where: \.pane.active) ?? panes.first(where: \.pane.windowActive) ?? panes.first
        agentId = terminal.agentId
        workspaceId = terminal.workspaceId
        exists = session != nil
        id = session?.id
        self.session = session?.name
        open = session?.open ?? false
        visible = session?.visible ?? false
        focused = session?.focused ?? false
        if let live, let session, let front {
            tmux = Handle(
                tmux: live.tmux, socket: live.socket, session: session.name, window: front.pane.window,
                windowIndex: front.pane.windowIndex, pane: front.pane.pane, paneIndex: front.pane.paneIndex,
                target: front.target, fullTarget: front.fullTarget, prefix: [live.tmux, "-S", live.socket],
                cwd: front.pane.cwd, command: front.pane.command, title: front.pane.title)
        } else {
            tmux = nil
        }
        self.panes = panes
    }

    public var json: WireJSON {
        .object(dropping: [
            ("agentId", .string(agentId)), ("workspaceId", .string(workspaceId)), ("exists", .bool(exists)),
            ("id", .optional(id)), ("session", .optional(session)), ("open", .bool(open)),
            ("visible", .bool(visible)), ("focused", .bool(focused)), ("tmux", tmux?.json),
            ("panes", .array(panes.map(\.json))),
        ])
    }
}

public enum TellWords {
    /// `top-left`, `bottom`, `right`, `whole`: where a pane is in its window.
    public static func paneWhere(_ pane: TellTerminalPane, window: [TellTerminalPane]) -> String {
        let right = window.map { $0.left + $0.width }.max() ?? 0
        let bottom = window.map { $0.top + $0.height }.max() ?? 0
        let minLeft = window.map(\.left).min() ?? 0
        let minTop = window.map(\.top).min() ?? 0
        func across(_ start: Int, _ size: Int, _ min: Int, _ end: Int) -> String? {
            let first = start <= min
            let last = start + size >= end
            if first && last { return nil }
            return first ? "first" : last ? "last" : "middle"
        }
        let column = across(pane.left, pane.width, minLeft, right)
        let row = across(pane.top, pane.height, minTop, bottom)
        let vertical = row.map { $0 == "first" ? "top" : $0 == "last" ? "bottom" : "middle" }
        let horizontal = column.map { $0 == "first" ? "left" : $0 == "last" ? "right" : "middle" }
        let words = [vertical, horizontal].compactMap { $0 }
        if words.isEmpty { return "whole" }
        if words == ["middle", "middle"] { return "middle" }
        return words.joined(separator: "-")
    }

    /// A word for the shell, quoted only when it has to be.
    public static func shellWord(_ word: String) -> String {
        let plain = !word.isEmpty
            && word.unicodeScalars.allSatisfy { scalar in
                (scalar.value >= 0x41 && scalar.value <= 0x5A) || (scalar.value >= 0x61 && scalar.value <= 0x7A)
                    || (scalar.value >= 0x30 && scalar.value <= 0x39) || "_@%+=:,./-".unicodeScalars.contains(scalar)
            }
        return plain ? word : "'" + word.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    static func terminalLine(_ terminal: DescribedTerminal) -> String {
        let tmux = terminal.tmux
        let parts: [String?] = [
            terminal.session ?? "no session",
            terminal.visible
                ? "on screen, with your pane (right of it, or under it beside the editor)"
                : terminal.open
                    ? "open, not on screen (your pane is not: another Agent or the editor alone is in front)"
                    : "hidden (Cmd+Q V shows it)",
            tmux.map { "\(shellWord($0.tmux)) -S \(shellWord($0.socket)) … -t \($0.target)" }
                ?? "tmux could not be asked about it",
            tmux.map { "cwd \($0.cwd)" },
            tmux.map { "running \($0.command)" },
            terminal.panes.count > 1 ? "\(terminal.panes.count) tmux panes" : nil,
            terminal.focused ? "has the keyboard" : nil,
        ]
        return parts.compactMap { $0 }.joined(separator: "  ")
    }

    /// One line per tmux pane, when the person has split it.
    static func paneLines(_ terminal: DescribedTerminal) -> [String] {
        if terminal.panes.count < 2 { return [] }
        return ["panes:"]
            + terminal.panes.map { described in
                let pane = described.pane
                return
                    "  \(described.target)  window \(pane.windowIndex) (\(pane.windowName))  \(described.where)  \(pane.width)x\(pane.height) at \(pane.left),\(pane.top)  running \(pane.command)\(pane.active ? "  active" : "")"
            }
    }

    /// One editor-terminal pane, as `terminal panes` lists it.
    static func editorPaneLine(_ editor: TellEditorPane) -> String {
        let pane = editor.pane
        let parts: [String?] = [
            "  \(pane.pane)",
            "\(editor.session):\(pane.windowIndex).\(pane.paneIndex)",
            "window \(pane.windowIndex) (\(pane.windowName))",
            "running \(editor.argv ?? pane.command)",
            "cwd \(pane.cwd)",
            pane.title.isEmpty ? nil : "title \(WireJSON.quoted(pane.title))",
            pane.active ? "active" : nil,
            pane.dead ? "dead" : nil,
        ]
        return parts.compactMap { $0 }.joined(separator: "  ")
    }

    /// How to type into it and read it back, with this terminal's own handle.
    static func driveHints(_ terminal: DescribedTerminal) -> [String] {
        guard let tmux = terminal.tmux else { return [] }
        let base = "\(shellWord(tmux.tmux)) -S \(shellWord(tmux.socket))"
        return [
            "send:  \(base) send-keys -t \(tmux.target) -l -- 'make test' && \(base) send-keys -t \(tmux.target) Enter",
            "read:  \(base) capture-pane -p -J -t \(tmux.target) -S -200",
            "panes: \(base) list-panes -s -t \(shellWord(tmux.session)) -F '#{pane_id} #{window_index} #{pane_left},#{pane_top} #{pane_width}x#{pane_height} #{pane_current_command}'",
            "close: devhub --tell terminal close",
        ]
    }

    /// `text.trim()`, cut at the line limit (in UTF-16 units, as JavaScript counts).
    static func clip(_ text: String) -> String {
        let flat = jsTrim(text)
        let units = Array(flat.utf16)
        if units.count > TellService.lineLimit {
            return String(decoding: units.prefix(TellService.lineLimit), as: UTF16.self) + "…"
        }
        return flat
    }

    /// `String.prototype.trim`.
    static func jsTrim(_ text: String) -> String {
        let space: (Unicode.Scalar) -> Bool = { scalar in
            switch scalar.value {
            case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
                return true
            default: return false
            }
        }
        var scalars = Substring(text).unicodeScalars[...]
        while let first = scalars.first, space(first) { scalars = scalars.dropFirst() }
        while let last = scalars.last, space(last) { scalars = scalars.dropLast() }
        return String(String.UnicodeScalarView(scalars))
    }

    /// One transcript entry, as a line or two of text.
    public static func entryLine(_ entry: TellTranscriptEntry) -> String? {
        switch entry {
        case let .user(_, text):
            return "> \(clip(text))"
        case let .answer(_, answers):
            return "> (answered) "
                + answers.map { answer in
                    [
                        answer.question, "→",
                        (answer.chosen + [answer.written ?? ""]).filter { !$0.isEmpty }.joined(separator: ", "),
                    ].joined(separator: " ")
                }.joined(separator: "; ")
        case let .command(_, line, output):
            return "$ \(line ?? "")\(output.map { "\n\(clip($0))" } ?? "")"
        case let .assistant(_, texts):
            let text = texts.joined(separator: "\n")
            return jsTrim(text).isEmpty ? nil : clip(text)
        case let .tool(_, tool, title, status):
            return "[\(tool)] \(clip(title)) (\(status))"
        case let .notice(_, text):
            return "! \(clip(text))"
        case .compaction:
            return "-- compacted --"
        case let .turnEnd(_, outcome, detail):
            return "-- turn \(outcome)\(detail.map { ": \(clip($0))" } ?? "") --"
        }
    }

    static func requestKind(_ request: TellPendingRequest) -> String {
        switch request.subject {
        case .question: return "a question"
        case let .elicitation(server, _): return "an MCP server's request (\(server))"
        default: return "a permission prompt"
        }
    }

    /// A request as `agent requests` shows it. Permission prompts are listed, not offered.
    public struct RequestView: Equatable, Sendable {
        public var id: String
        public var kind: String
        public var answerable: Bool
        public var questions: WireJSON?
        public var text: String

        public var json: WireJSON {
            .object(dropping: [
                ("id", .string(id)), ("kind", .string(kind)), ("answerable", .bool(answerable)),
                ("questions", questions), ("text", .string(text)),
            ])
        }
    }

    public static func requestView(_ request: TellPendingRequest) -> RequestView {
        guard case let .question(questions) = request.subject else {
            let what: String
            switch request.subject {
            case let .tool(tool, title): what = "\(tool): \(title)"
            case let .command(command): what = "run \(command)"
            case let .fileChange(paths): what = "change \(paths.joined(separator: ", "))"
            case let .elicitation(_, message): what = message
            case .question: what = ""
            }
            return RequestView(
                id: request.id, kind: request.subject.kind, answerable: false, questions: nil,
                text: "\(request.id)  \(requestKind(request)): \(clip(what))\n  (answer in DevHub)")
        }
        let json: WireJSON = .array(
            questions.map { question in
                [
                    "header": .string(question.header), "text": .string(question.text),
                    "multiSelect": .bool(question.multiSelect), "allowsOther": .bool(question.allowsOther),
                    "options": .array(
                        question.options.enumerated().map { index, option in
                            [
                                "n": .int(index + 1), "label": .string(option.label),
                                "description": .string(option.description),
                            ]
                        }),
                ]
            })
        var lines = ["\(request.id)  question"]
        for (index, question) in questions.enumerated() {
            lines.append(
                "  \(questions.count > 1 ? "[\(index + 1)] " : "")\(question.header): \(question.text)\(question.multiSelect ? " (several)" : "")"
            )
            for (offset, option) in question.options.enumerated() {
                lines.append(
                    "    \(offset + 1). \(option.label)\(option.description.isEmpty ? "" : " — \(option.description)")")
            }
            if question.allowsOther { lines.append("    (or --text <your own answer>)") }
        }
        return RequestView(
            id: request.id, kind: "question", answerable: true, questions: json,
            text: lines.joined(separator: "\n"))
    }

    /// The answer to a question request, built from option numbers and words.
    ///
    /// Options number the questions' options in order across all of them —
    /// for the usual single question that is simply 1…n. Every question must
    /// get an answer, as the window's card requires.
    public static func questionAnswer(_ questions: [TellQuestion], options: [Int], text: String?, note: String)
        throws -> TellRequestAnswer
    {
        var values: [(id: String, value: TellRequestAnswer.Value)] = []
        var notes: [(id: String, note: String)] = []
        let total = questions.reduce(0) { $0 + $1.options.count }
        if options.contains(where: { $0 < 1 || $0 > total }) {
            throw TellRefusal("there are \(total) options to choose from.")
        }
        var offset = 0
        for question in questions {
            let chosen = options.filter { $0 > offset && $0 <= offset + question.options.count }
                .map { question.options[$0 - offset - 1].label }
            offset += question.options.count
            let written = questions.count == 1 ? text : nil
            if written != nil && !question.allowsOther && chosen.isEmpty {
                throw TellRefusal("\"\(question.header)\" takes one of its options, not words of its own.")
            }
            let given = chosen + (written.map { [$0] } ?? [])
            if given.isEmpty {
                throw TellRefusal("\"\(question.header)\" has no answer; choose with --option <n>.")
            }
            if !question.multiSelect && given.count > 1 {
                throw TellRefusal("\"\(question.header)\" takes one answer.")
            }
            let value: TellRequestAnswer.Value = question.multiSelect ? .many(given) : .one(given[0])
            if let existing = values.firstIndex(where: { $0.id == question.id }) {
                values[existing].value = value
                notes[existing].note = note
            } else {
                values.append((question.id, value))
                notes.append((question.id, note))
            }
        }
        return TellRequestAnswer(values: values, notes: notes)
    }

    /// "answered via devhub CLI by <agent>", the line the target's transcript keeps.
    public static func answeredBy(_ caller: TellCaller?, workspaces: [TellWorkspace]) -> String {
        let agent = caller?.agentId.flatMap { id in workspaces.flatMap(\.agents).first(where: { $0.id == id }) }
        let who: String
        if let agent {
            who = "\(agent.name) (\(agent.id))"
        } else if let id = caller?.agentId {
            who = id
        } else {
            who = "a terminal outside any agent"
        }
        return "answered via devhub CLI by \(who)"
    }
}
