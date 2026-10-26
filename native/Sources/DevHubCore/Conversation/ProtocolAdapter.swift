// Port of apps/desktop/src/main/agent/conversation/protocolAdapter.ts
//
// The seam between a structured CLI's lines and the normalized conversation.
//
// One adapter per GUI Agent, one implementation per protocol (Claude's
// stream-json, Codex's app-server JSON-RPC). It does no I/O: it is handed the
// lines the CLI printed and the lines DevHub wrote, and it answers with
// `ConversationEvent`s and with the lines to write. That is what lets the same
// code replay a journal after a restart and follow a live stream — and lets a
// test drive it with nothing but NDJSON.
//
// # Writing is two steps
//
// `encode` turns a command into lines and changes nothing. Only when a line
// has actually been written does the caller hand it back through `sent` — the
// same call a replay makes for each line of `in.log`. So what the adapter
// believes DevHub said is exactly what reached the CLI, and a write that
// failed leaves no trace in the conversation (the request it answered stays
// open, the message it carried was never said).
//
// # Failure
//
// A line of a type the adapter knows, in a shape it does not, throws
// `ProtocolMismatch` naming where in the line it went wrong. The adapter does
// not catch it: the one loop that feeds lines in turns it into a broken
// conversation. After a throw the adapter is spent and refuses every further
// call, because its bookkeeping may be half-updated.
//
// # A second protocol (Codex, WP6)
//
// A Codex adapter is another `ProtocolAdapter`: the conversation, the host and
// the journal are the same; only the lines differ. Everything a protocol has
// of its own — how it greets (`opening`), how a rewind or a `/resume` is
// carried out (`RewindPlan.write` for a protocol with a request for it,
// `.restart` for one whose CLI must be started again) — is said through this
// one surface.

import Foundation

public enum ConversationCommand: Hashable, Sendable {
    /// A user message: a person's words, an injection, the message DevHub
    /// sends for the person once a usage limit reset, or a slash command typed
    /// as text. Written while a turn runs, it is taken into that turn (Codex's
    /// `turn/steer`, Claude's message queued for the turn's next step);
    /// written while none runs, it starts one. Images are each their own
    /// bytes (`source` `.data`).
    case send(text: String, images: [ImageRef], origin: SentOrigin)
    /// The person's words to a subagent, named by the call that started it,
    /// whose `spawns.takesMessages` is true.
    case instruct(subagent: EntryId, text: String)
    case interrupt
    /// Stop one of `Transcript.backgroundTasks`, by its `RunningTask.id`,
    /// whose `stoppable` is `.yes`.
    case stopTask(task: String)
    case answer(request: RequestId, answer: RequestAnswer)
    /// Ask the CLI about its MCP servers (`refresh`), or do one of the
    /// `McpServer.actions` the adapter offers for a server.
    case mcp(McpRequest)
}

public enum McpRequest: Hashable, Sendable {
    case refresh
    /// `action` is never `.signIn`.
    case act(action: McpAction, server: String)
}

/// The three settings a session offers choices for, as `SessionFacts` names them.
public enum SettingName: String, Hashable, Sendable {
    case model, effort, mode
}

/// The CLI started again by its host: the arguments that pick the session it
/// starts on (`withSession`; none, a new one), and the lines — one at least —
/// the host puts in the journal between the two CLIs, which is how the
/// adapter, live or replaying, learns what happened and where.
public struct RestartPlan: Hashable, Sendable {
    public var session: [String]
    public var mark: [String]

    public init(session: [String], mark: [String]) {
        self.session = session
        self.mark = mark
    }
}

/// How a rewind is carried out. Either the protocol has a request for it,
/// whose lines are written like a command's (Codex), or the CLI has to be
/// started again by its host on the session cut short (Claude).
public enum RewindPlan: Hashable, Sendable {
    case write(lines: [String])
    case restart(RestartPlan)
}

/// The line the host puts in the journal between the CLI a restart stopped and the one it started.
public let RESTART_MARK = #"{"type":"devhub_restart"}"#

/// What the transcript says where the CLI was started again.
public let RESTARTED = "Session restarted"

public struct AdapterStep: Sendable, Equatable {
    public var events: [ConversationEvent]
    /// Lines the protocol requires DevHub to write back at once.
    public var replies: [String]

    public init(events: [ConversationEvent] = [], replies: [String] = []) {
        self.events = events
        self.replies = replies
    }

    public static let none = AdapterStep()
}

/// A protocol's reading of its CLI. Not Sendable: one belongs to one
/// conversation, which calls it from one place at a time.
public protocol ProtocolAdapter: AnyObject {
    /// Every event this adapter has produced, folded.
    var transcript: Transcript { get }
    /// The lines to write right after the CLI starts (the handshake). Not for
    /// a replay: those are in `in.log`.
    func opening() throws -> [String]
    /// The lines that carry `command`. Changes nothing until they come back through `sent`.
    func encode(_ command: ConversationCommand) throws -> [String]
    /// A setting chosen: one of `SessionFacts[which].choices`.
    ///
    /// The one call that may change what the adapter holds without a line
    /// coming back through `sent`, because a protocol may carry settings on
    /// the next turn rather than set them (Codex): the choice is held, and its
    /// session event is in the step. A protocol that does set them (Claude)
    /// returns the lines that do as `replies`; the caller writes them and
    /// hands them back through `sent`, and the setting changes when the CLI
    /// says it has.
    func configure(_ which: SettingName, _ id: String) throws -> AdapterStep
    /// How to take the conversation back to before `message`, one of
    /// `rewindTargets`. Changes nothing, like `encode`. The adapter emits
    /// `rewound` once the CLI has done it, and holds the turn `rewinding` in
    /// between; a CLI that refused says so in a notice and the turn goes back
    /// to `none` with nothing dropped. Throws for a message that is not a
    /// rewind target.
    func rewind(_ message: EntryId) throws -> RewindPlan
    /// How to go on with another session of the CLI instead of this one
    /// (`/resume`). `history` is the session's past as `devhub_history`
    /// lines, for a protocol whose CLI prints none of it; a protocol that is
    /// handed its past takes none. Changes nothing. The adapter emits
    /// `sessionSwitched` once the CLI has the other session, followed by that
    /// session's past, and holds the turn `rewinding` in between. Throws
    /// while a turn runs or a request is open.
    func resumeSession(_ session: String, history: [String]) throws -> RewindPlan
    /// How to stop the CLI and start it again on the session it is on
    /// (Restart session): always the CLI started again by its host, with
    /// `RESTART_MARK` between the two. Once the mark is read the adapter
    /// emits `restarted` and the `RESTARTED` notice, and holds the turn
    /// `rewinding` until the new CLI is ready.
    func restart() throws -> RestartPlan
    /// A line DevHub wrote to the CLI's stdin — live, or read back from `in.log`.
    func sent(_ line: String) throws -> AdapterStep
    /// A line the CLI printed on stdout.
    func received(_ line: String) throws -> AdapterStep
}

/// A line of a known type whose shape the decoder does not accept, or a line
/// that is not JSON. The CLI and DevHub disagree about the protocol (version
/// skew), which is not something either side can talk its way past.
public struct ProtocolMismatch: Error, CustomStringConvertible, Equatable {
    /// Where in the line: `assistant.message.content[2].id`.
    public let path: String
    public let expected: String
    /// The CLI's version, when the handshake got far enough to say.
    public let agentVersion: String?

    public init(path: String, expected: String, agentVersion: String?) {
        self.path = path
        self.expected = expected
        self.agentVersion = agentVersion
    }

    public var message: String {
        "\(path): expected \(expected)\(agentVersion.map { " (CLI \($0))" } ?? "")"
    }

    public var description: String { message }
}

/// A call into an adapter that it must refuse: its bookkeeping broke earlier,
/// or the caller asked for something the view should not have offered.
public struct AdapterRefusal: Error, CustomStringConvertible, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// The background task a `stopTask` command names, which must be running and
/// stoppable: the view offers the command for no other, so any other is a bug.
public func requireStoppable(_ tasks: [RunningTask], _ id: String) throws -> RunningTask {
    guard let task = tasks.first(where: { $0.id == id }) else {
        throw AdapterRefusal("\(id) is not a background task running now")
    }
    if case .no(let reason) = task.stoppable {
        throw AdapterRefusal("background task \(id) cannot be stopped from DevHub: \(reason)")
    }
    return task
}
