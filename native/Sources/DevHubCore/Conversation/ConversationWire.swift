// Port of apps/desktop/src/ipc/conversation.ts (the types) and the command
// dispatch of apps/desktop/src/main/shell/conversationIpc.ts.
//
// The GUI Agents' conversations, as the Agents view reaches them.
//
// Core holds each conversation's true `Transcript`; the view asks for it once
// (`ConversationAttachment`) and is then handed every event after it,
// numbered, to fold into its copy with the same `applyEvent` Core used.
// Nothing else crosses: the view never learns a protocol, and Core never
// learns what the view drew. In one process there is no channel to name, so
// what TS checks of an untyped message is here the type itself; what is left
// to check (images, a sign-in through `mcp`) is checked in `perform`.

import Foundation

/// What the view may ask of a conversation. A person's words are always the person's.
public enum ConversationCommandWire: Hashable, Sendable {
    /// The person's words: written at once when the Agent is idle, else held (`Transcript.pending`).
    /// Attached images are each their own bytes (`source` `.data`).
    case send(text: String, images: [ImageRef])
    /// The person opened a held message to change it: it is not written until they save or cancel.
    case startEditingPending(PendingId)
    /// Save the change: new words, and the message is written again in its turn.
    case editPending(PendingId, text: String)
    /// The person gave the change up: the message is written as it was.
    case stopEditingPending(PendingId)
    case removePending(PendingId)
    /// Write a held message now: a running turn takes it in as it goes.
    case sendPendingNow(PendingId)
    /// The person's words to a subagent whose `spawns.takesMessages` is true.
    case instruct(subagent: EntryId, text: String)
    case interrupt
    /// Stop one of the background tasks, by its `RunningTask.id`, whose `stoppable` is true.
    case stopTask(String)
    case answer(request: RequestId, answer: RequestAnswer)
    case setSetting(SettingName, id: String)
    /// Ask about the MCP servers, or do one of a server's `McpServer.actions` but `sign-in`.
    case mcp(McpRequest)
    /// Nothing is to be written after the usage limit the Agent stopped at
    /// (`Transcript.limitResume`'s Cancel), or its failure has been read (Dismiss).
    case cancelLimitResume

    /// The wire's name for it (`kind`).
    public var kind: String {
        switch self {
        case .send: return "send"
        case .startEditingPending: return "start-editing-pending"
        case .editPending: return "edit-pending"
        case .stopEditingPending: return "stop-editing-pending"
        case .removePending: return "remove-pending"
        case .sendPendingNow: return "send-pending-now"
        case .instruct: return "instruct"
        case .interrupt: return "interrupt"
        case .stopTask: return "stop-task"
        case .answer: return "answer"
        case .setSetting: return "set-setting"
        case .mcp: return "mcp"
        case .cancelLimitResume: return "cancel-limit-resume"
        }
    }
}

/// A command the view sent that is not one DevHub takes.
public struct ConversationCommandRefused: Error, CustomStringConvertible, Equatable {
    public let message: String
    public var description: String { message }
}

/// Where in a file a link in the conversation points, beyond the file itself:
/// a line (and column), or a range of lines. One-based, as every editor counts.
public enum FileRange: Hashable, Sendable {
    case line(line: Int, column: Int)
    case lines(from: Int, to: Int)

    /// A range as the wire spells one (`{"kind":"line",…}`); throws for anything else.
    public static func parse(_ wire: JsonValue) throws -> FileRange {
        func whole(_ value: JsonValue?) -> Int? {
            guard case .number(let number)? = value, number >= 1, number.rounded() == number,
                number <= Double(END_OF_LINE)
            else { return nil }
            return Int(number)
        }
        if case .object(let range) = wire {
            if range["kind"] == "line", let line = whole(range["line"]), let column = whole(range["column"]) {
                return .line(line: line, column: column)
            }
            if range["kind"] == "lines", let from = whole(range["from"]), let to = whole(range["to"]), to >= from {
                return .lines(from: from, to: to)
            }
        }
        throw ConversationCommandRefused(message: "\(wire.jsonText) is not a place in a file")
    }
}

/// `fileSelection` of a range as the wire spells it; nil is no range.
public func fileSelection(wire: JsonValue?) throws -> FileSelection? {
    guard let wire else { return nil }
    return fileSelection(try FileRange.parse(wire))
}

public struct ConversationAttachment: Sendable, Equatable {
    public let transcript: Transcript
    /// The number of the last event folded into `transcript`; the next event is one more.
    public let revision: Int
    /// What the person was typing to this Agent and had not sent, as last
    /// saved (`AgentDrafts`) — before a restart of DevHub too. Empty when
    /// there is none.
    public let draft: String

    public init(transcript: Transcript, revision: Int, draft: String) {
        self.transcript = transcript
        self.revision = revision
        self.draft = draft
    }
}

extension AgentConversation {
    /// The view's command, carried out by the conversation call it names.
    public func perform(_ wire: ConversationCommandWire) async throws {
        switch wire {
        case .send(let text, let images): try await submit(text, images: try attachedImages(images))
        case .startEditingPending(let id): try await startEditingPending(id)
        case .editPending(let id, let text): try await editPending(id, text: text)
        case .stopEditingPending(let id): try await stopEditingPending(id)
        case .removePending(let id): try await removePending(id)
        case .sendPendingNow(let id): try await sendPendingNow(id)
        case .cancelLimitResume: try await cancelLimitResume()
        case .setSetting(let which, let id): try await configure(which, id)
        case .instruct(let subagent, let text): try await command(.instruct(subagent: subagent, text: text))
        case .interrupt: try await command(.interrupt)
        case .stopTask(let task): try await command(.stopTask(task: task))
        case .answer(let request, let answer): try await command(.answer(request: request, answer: answer))
        case .mcp(let request):
            if case .act(.signIn, _) = request {
                throw ConversationCommandRefused(
                    message: "an MCP sign-in is DevHub's own (`signIn`), not a request to the CLI")
            }
            try await command(.mcp(request))
        }
    }

    /// What the view attaches to: the conversation so far, and the Agent's draft.
    public func attachment(draft: String) -> ConversationAttachment {
        let snapshot = snapshot()
        return ConversationAttachment(transcript: snapshot.transcript, revision: snapshot.revision, draft: draft)
    }
}
