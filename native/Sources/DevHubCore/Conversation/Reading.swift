// Port of apps/desktop/src/main/agent/conversation/reading.ts
//
// A GUI Agent's conversation, read as the round reads a terminal's screen.
//
// The round has one question for every Agent — what is its status, what does
// it say it is doing, is anything wrong with it — and this answers it for a
// GUI Agent from its conversation (design §5.1). The answer travels the same
// way a screen's does: as the round's observation, never pushed to the model
// from the side, so "where does an Agent's status come from" has one answer.

import Foundation

public struct ConversationObservation: Sendable, Equatable {
    public var status: ConversationAgentStatus
    public var activity: String?
    public var promptCache: PromptCache?
    /// An `AgentFailureCode` and its sentence, when something is wrong.
    public var failure: AgentRefusal?

    public init(
        status: ConversationAgentStatus, activity: String?, promptCache: PromptCache? = nil, failure: AgentRefusal?
    ) {
        self.status = status
        self.activity = activity
        self.promptCache = promptCache
        self.failure = failure
    }
}

/// The Agent's failure code for each way a conversation breaks (`AgentFailureCode`).
public func agentFailureCode(_ code: ConversationFailureCode) -> String {
    switch code {
    case .protocolMismatch: return "conversation_protocol_mismatch"
    case .notSignedIn: return "conversation_not_signed_in"
    case .refused: return "conversation_refused"
    }
}

/// The cache with when DevHub will compact it.
private func promptCacheOf(_ cache: PromptCache?, _ autoCompactAt: Double?) -> PromptCache? {
    guard var cache, let autoCompactAt else { return cache }
    cache.autoCompactAt = autoCompactAt
    return cache
}

public func observeConversation(_ reading: ConversationReading) -> ConversationObservation {
    if let crashed = reading.crashed {
        return ConversationObservation(
            status: .error, activity: nil, failure: AgentRefusal(code: "conversation_failed", detail: "\(crashed)"))
    }
    // A conversation DevHub cannot follow is not read at all, whatever the last
    // thing it said was: the status is the one for "nobody is reading it".
    if let lost = reading.lost {
        return ConversationObservation(
            status: .unknown, activity: nil, failure: AgentRefusal(code: "conversation_host_lost", detail: lost.message))
    }
    let transcript = reading.transcript
    var failure: AgentRefusal?
    if case .broken(let broken) = transcript.state {
        failure = AgentRefusal(code: agentFailureCode(broken.code), detail: broken.detail)
    }
    return ConversationObservation(
        status: conversationStatus(transcript), activity: conversationActivity(transcript),
        promptCache: promptCacheOf(transcript.usage?.promptCache, reading.autoCompactAt), failure: failure)
}
