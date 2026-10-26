// Port of apps/desktop/src/main/agent/conversation/registry.ts
//
// The GUI Agents' conversations in this DevHub, one per Agent.
//
// A conversation exists from the first time anything asks for it — the round
// that first finds its Agent's session, or the view attaching — until its
// Agent is stopped or ends. It is never remembered across a restart: the host
// is, and a new conversation on the same host replays to the same transcript
// (see AgentConversation.swift), so there is nothing here worth keeping.
//
// Every conversation's events leave through one listener list, tagged with
// their Agent, so the view is fed from one place.

import Foundation

public typealias ConversationEventListener = @Sendable (_ agentId: String, _ revision: Int, _ event: ConversationEvent) ->
    Void

public actor ConversationRegistry {
    private var conversations: [String: AgentConversation] = [:]
    private let listeners = Guarded<[Int: ConversationEventListener]>([:])
    private var nextListener = 0

    public init() {}

    public func get(_ agentId: String) -> AgentConversation? { conversations[agentId] }

    /// The Agent's conversation, made and started by `create` if it has none.
    public func open(
        _ agentId: String, create: (_ publish: @escaping ConversationPublish) -> AgentConversation
    ) async throws -> AgentConversation {
        if let existing = conversations[agentId] { return existing }
        let listeners = self.listeners
        let conversation = create { revision, event in
            for listener in listeners.with({ Array($0.sorted { $0.key < $1.key }.map(\.value)) }) {
                listener(agentId, revision, event)
            }
        }
        conversations[agentId] = conversation
        try await conversation.start()
        return conversation
    }

    /// Stop following the Agent's host, and forget the conversation. The host is untouched.
    public func close(_ agentId: String) async {
        guard let conversation = conversations.removeValue(forKey: agentId) else { return }
        await conversation.stop()
    }

    /// `[agents] auto_compact_*` may have changed: every conversation judges itself again.
    public func reconsiderCacheKeeping() async {
        for conversation in conversations.values { await conversation.reconsiderCacheKeeping() }
    }

    /// `listener` hears every conversation's events until the returned closure is called.
    public func onEvent(_ listener: @escaping ConversationEventListener) -> @Sendable () -> Void {
        nextListener += 1
        let id = nextListener
        listeners.with { $0[id] = listener }
        return { [listeners] in _ = listeners.with { $0.removeValue(forKey: id) } }
    }
}
