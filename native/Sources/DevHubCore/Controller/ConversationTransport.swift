// Port of apps/desktop/src/main/shell/conversationIpc.ts, and of the fold
// half of `useConversation` in apps/desktop/src/shell/agents/ConversationPane.tsx
// (`ConversationFollower`).
//
// The conversation view's side of the GUI Agents' conversations (WP10).
//
// In the TS app this is an IPC surface only the Agents page may reach; in one
// process the view holds the transport itself, so what TS checks of an
// untyped message is here the type. What is left is the protocol:
//
// 1. The view takes the one stream of updates (`updates()`), once per view.
// 2. It attaches to an Agent (`attach`): the Agent is subscribed *before* the
//    snapshot is taken, so no event can fall between them; the snapshot
//    carries the revision it holds, and the draft kept for the Agent.
// 3. It folds every update for that Agent into its copy with the same
//    `applyEvent` Core used (`ConversationFollower`): an update the snapshot
//    already holds is dropped by its revision, one that arrived before the
//    snapshot is held and folded after it, and a gap in the revisions is a
//    broken promise of Core's, reported rather than folded over.
// 4. It detaches when it stops drawing the Agent; a view that goes away
//    (`viewGone`, or a new `updates()`) takes every attachment with it.
//
// A person's words arrive here as the person's: the view cannot claim to be
// an injection, which is the queue's alone (`ConversationCommandWire.send`).

import Foundation

/// One event of one Agent's conversation, numbered: the next after
/// `revision - 1`.
public struct ConversationUpdate: Sendable, Equatable {
    public let agentId: String
    public let revision: Int
    public let event: ConversationEvent

    public init(agentId: String, revision: Int, event: ConversationEvent) {
        self.agentId = agentId
        self.revision = revision
        self.event = event
    }
}

/// What the transport does besides the conversations themselves — each the
/// app's own call, so the view and every other way in mean one thing.
public struct ConversationTransportOptions: Sendable {
    public var conversations: GuiAgentWiring
    /// Each GUI Agent's unsent draft, handed out with the attachment and kept as the view reports it.
    public var drafts: AgentDrafts
    /// Ask the model to carry an Agent on in the other presentation, resuming this session.
    public var continueIn: @Sendable (AgentId, AgentPresentation, String?) async throws -> Void
    /// Ask the model to restart an Agent's session: the one way the Sidebar and the chord go too.
    public var restart: @Sendable (AgentId) async throws -> Void
    /// The session a terminal Agent's CLI is in (`terminalSession`).
    public var terminalSession: @Sendable (AgentId) async throws -> String
    /// Open a file a conversation links to, in the editor the routing rule says.
    public var openFile: @Sendable (AgentId, String, FileSelection?) async throws -> Void
    /// The app's one conversion of a failure into what the view is handed.
    public var fail: @Sendable (Error) -> Error

    public init(
        conversations: GuiAgentWiring, drafts: AgentDrafts,
        continueIn: @escaping @Sendable (AgentId, AgentPresentation, String?) async throws -> Void,
        restart: @escaping @Sendable (AgentId) async throws -> Void,
        terminalSession: @escaping @Sendable (AgentId) async throws -> String,
        openFile: @escaping @Sendable (AgentId, String, FileSelection?) async throws -> Void,
        fail: @escaping @Sendable (Error) -> Error = { namedFailure($0) }
    ) {
        self.conversations = conversations
        self.drafts = drafts
        self.continueIn = continueIn
        self.restart = restart
        self.terminalSession = terminalSession
        self.openFile = openFile
        self.fail = fail
    }
}

public final class ConversationTransport: @unchecked Sendable {
    private let options: ConversationTransportOptions
    private let lock = NSLock()
    private var attached: Set<String> = []
    private var view: AsyncStream<ConversationUpdate>.Continuation?
    private var unsubscribe: (@Sendable () -> Void)?

    private init(_ options: ConversationTransportOptions) { self.options = options }

    /// The transport, listening to every conversation from now on.
    public static func start(_ options: ConversationTransportOptions) async -> ConversationTransport {
        let transport = ConversationTransport(options)
        let stop = await options.conversations.registry.onEvent { [weak transport] agentId, revision, event in
            transport?.deliver(agentId, revision, event)
        }
        transport.lock.withLock { transport.unsubscribe = stop }
        return transport
    }

    deinit {
        unsubscribe?()
        view?.finish()
    }

    /// Only the attached conversations' events, to the one view there is.
    private func deliver(_ agentId: String, _ revision: Int, _ event: ConversationEvent) {
        lock.withLock {
            guard attached.contains(agentId), let view else { return }
            view.yield(ConversationUpdate(agentId: agentId, revision: revision, event: event))
        }
    }

    /// The view's one stream of updates. A new view replaces the old one,
    /// whose attachments go with it.
    public func updates() -> AsyncStream<ConversationUpdate> {
        let (stream, continuation) = AsyncStream<ConversationUpdate>.makeStream()
        let gone = lock.withLock { () -> (Set<String>, AsyncStream<ConversationUpdate>.Continuation?) in
            let previous = (attached, view)
            attached = []
            view = continuation
            return previous
        }
        gone.1?.finish()
        letGoOfEdits(gone.0)
        return stream
    }

    /// The view went away: it is detached from everything.
    public func viewGone() {
        let gone = lock.withLock { () -> (Set<String>, AsyncStream<ConversationUpdate>.Continuation?) in
            let previous = (attached, view)
            attached = []
            view = nil
            return previous
        }
        gone.1?.finish()
        letGoOfEdits(gone.0)
    }

    /// The view no longer has the Agents' held messages open: none of them
    /// is being changed any more, so they are written in their turn rather
    /// than waiting for an edit nobody can finish.
    private func letGoOfEdits(_ agents: Set<String>) {
        let registry = options.conversations.registry
        for agentId in agents {
            Task { await registry.get(agentId)?.stopEditingAll() }
        }
    }

    /// Every request: about an Agent, refused in the app's own shape.
    private func handle<T: Sendable>(_ work: () async throws -> T) async throws -> T {
        do {
            return try await work()
        } catch {
            throw options.fail(error)
        }
    }

    public var attachedAgents: Set<String> { lock.withLock { attached } }

    // MARK: - Attaching

    public func attach(_ agentId: String) async throws -> ConversationAttachment {
        try await handle {
            if lock.withLock({ view == nil }) {
                throw GuiAgentMissing("there is no conversation view to attach")
            }
            let conversation = try await options.conversations.of(agentId)
            // Subscribed before the snapshot is taken, so no event can fall
            // between them; the view drops what the snapshot already holds by
            // its revision.
            lock.withLock { _ = attached.insert(agentId) }
            return await conversation.attachment(draft: options.drafts.get(agentId))
        }
    }

    public func detach(_ agentId: String) async {
        lock.withLock { _ = attached.remove(agentId) }
        await options.conversations.registry.get(agentId)?.stopEditingAll()
    }

    public func saveDraft(_ agentId: String, _ text: String) {
        options.drafts.set(agentId, text)
    }

    // MARK: - The Agent's session

    public func continueInTerminal(_ agentId: String) async throws {
        try await handle {
            // Before the CLI names a session (its first turn) there is nothing
            // to resume: the terminal Agent starts a new one, in the same place.
            let session = try await options.conversations.session(agentId)
            try await options.continueIn(AgentId(unchecked: agentId), .tui, session)
        }
    }

    public func continueInGui(_ agentId: String) async throws {
        try await handle {
            let session = try await options.terminalSession(AgentId(unchecked: agentId))
            try await options.continueIn(AgentId(unchecked: agentId), .gui, session)
        }
    }

    public func restartSession(_ agentId: String) async throws {
        try await handle { try await options.restart(AgentId(unchecked: agentId)) }
    }

    public func listSessions(_ agentId: String, scope: SessionScope) async throws -> [PastSession] {
        try await handle { try await options.conversations.pastSessions(agentId, scope: scope) }
    }

    public func previewSession(_ agentId: String, session: String, cwd: String) async throws -> [PreviewLine] {
        try await handle { try await options.conversations.previewSession(agentId, session: session, cwd: cwd) }
    }

    public func resumeSession(_ agentId: String, session: String) async throws {
        try await handle { try await options.conversations.resume(agentId, session: session) }
    }

    // MARK: - MCP sign-in

    public func mcpSignIn(_ agentId: String, server: String) async throws {
        try await handle { try await options.conversations.signIn(agentId, server: server) }
    }

    public func mcpSignInInput(_ agentId: String, text: String) async throws {
        try await handle { try options.conversations.signInInput(agentId, text: text) }
    }

    public func mcpSignInCancel(_ agentId: String) async throws {
        try await handle { options.conversations.cancelSignIn(agentId) }
    }

    public func mcpSignInDismiss(_ agentId: String) async throws {
        try await handle { try await options.conversations.dismissSignIn(agentId) }
    }

    // MARK: - Links and settings

    public func resolvePaths(_ agentId: String, cwd: String?, _ paths: [String]) async throws -> [String?] {
        try await handle { try await options.conversations.resolvePaths(agentId, cwd: cwd, paths) }
    }

    public func openFile(_ agentId: String, path: String, range: FileRange?) async throws {
        try await handle {
            if !path.hasPrefix("/") { throw ConversationCommandRefused(message: "\(JsonValue.quoted(path)) is not a file to open") }
            try await options.openFile(AgentId(unchecked: agentId), path, fileSelection(range))
        }
    }

    public func cliDefaults(_ agentId: String, model: String?) async throws -> CliDefaults? {
        try await handle { try await options.conversations.cliDefaults(agentId, model: model) }
    }

    public func setCliDefault(_ agentId: String, _ which: ClaudeDefaultName, value: String, model: String?) async throws {
        try await handle { try await options.conversations.setCliDefault(agentId, which, value: value, model: model) }
    }

    // MARK: - The conversation itself

    public func rewind(_ agentId: String, to message: EntryId) async throws -> RewindOutcome {
        try await handle { try await (try await options.conversations.of(agentId)).rewind(message) }
    }

    public func command(_ agentId: String, _ wire: ConversationCommandWire) async throws {
        try await handle { try await (try await options.conversations.of(agentId)).perform(wire) }
    }
}

// MARK: - The view's copy

/// A gap in a conversation's revisions, or an event its fold refused: what
/// is drawn stops where it was still true.
public struct ConversationFollowerBroken: Error, Equatable, Sendable, CustomStringConvertible {
    public let description: String
}

/// One Agent's transcript as the view holds it, kept current from its
/// attachment and the updates after it (`useConversation`).
///
/// Until the attachment answers it is the empty transcript, which is
/// `connecting` — exactly what the Agent is to the view until then. Updates
/// that arrive before the attachment are held and folded after it; one the
/// snapshot already holds is dropped by its revision; a gap is reported
/// rather than folded over, and the follower takes nothing more.
public struct ConversationFollower: Sendable {
    public let agentId: String
    public private(set) var transcript: Transcript = EMPTY_TRANSCRIPT
    /// The revision folded last; nil until the attachment answered.
    public private(set) var revision: Int?
    /// The unsent draft kept for this Agent; nil until the attachment answered.
    public private(set) var draft: String?
    /// Why it stopped following, once it has.
    public private(set) var broken: ConversationFollowerBroken?
    private var early: [(Int, ConversationEvent)] = []

    public init(agentId: String) { self.agentId = agentId }

    /// The attachment answered: its transcript, then whatever arrived first.
    public mutating func attached(_ attachment: ConversationAttachment) throws {
        if broken != nil { return }
        transcript = attachment.transcript
        revision = attachment.revision
        draft = attachment.draft
        let held = early
        early = []
        for (revision, event) in held { _ = try take(revision, event) }
    }

    /// One update; whether it changed the transcript. Another Agent's is
    /// none of this follower's business.
    @discardableResult
    public mutating func take(_ update: ConversationUpdate) throws -> Bool {
        guard update.agentId == agentId else { return false }
        return try take(update.revision, update.event)
    }

    private mutating func take(_ next: Int, _ event: ConversationEvent) throws -> Bool {
        if broken != nil { return false }
        guard let current = revision else {
            early.append((next, event))
            return false
        }
        if next <= current { return false }
        do {
            if next != current + 1 {
                throw ConversationFollowerBroken(
                    description: "the conversation of Agent \(agentId) skipped from event \(current) to \(next)")
            }
            transcript = try applyEvent(transcript, event)
            revision = next
            return true
        } catch {
            let stop = error as? ConversationFollowerBroken ?? ConversationFollowerBroken(description: "\(error)")
            broken = stop
            throw stop
        }
    }

    /// The view stopped drawing it: nothing more is taken.
    public mutating func stop() {
        if broken == nil { broken = ConversationFollowerBroken(description: "the view stopped following Agent \(agentId)") }
    }
}
