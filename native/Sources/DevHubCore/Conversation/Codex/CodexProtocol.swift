// Port of apps/desktop/src/main/agent/conversation/codex/protocol/ (vendored).
//
// The `codex app-server` protocol, as far as DevHub's Codex adapter names it:
// every method the server can send (`ServerNotification`, `ServerRequest`),
// every item type a thread can hold (`v2/ThreadItem`), the closed sets the
// decoder checks words against, and the methods DevHub itself calls.
//
// - Source: <https://github.com/openai/codex>, directory
//   `codex-rs/app-server-protocol/schema/typescript`, the types
//   `codex app-server generate-ts` prints — the same files the TS app vendors
//   under `codex/protocol/`, at tag `rust-v0.158.0` (commit
//   `064c6b8c737f5b41d171fdda80bd9ef10ad06eb3`).
// - Licence: Apache License 2.0. Upstream's `LICENSE` and `NOTICE` are kept
//   unchanged in `native/Resources/ThirdParty/codex-app-server-protocol/`.
// - What changed: the TypeScript types became Swift enums of the names they
//   spell. The TS app's types are erased at compile time; what they buy it —
//   a method or item type a new Codex adds is a compile error in the adapter
//   until someone places it — the adapter's exhaustive `switch`es over these
//   enums buy here. Regenerating means re-reading the upstream files at the
//   new tag and updating these lists (and the TS app's vendored copy with
//   `apps/desktop/scripts/vendor-codex-protocol.mjs`).

import Foundation

/// Every method of `ServerNotification`, in upstream's order.
public enum CodexServerNotification: String, CaseIterable, Sendable {
    case error
    case threadStarted = "thread/started"
    case threadStatusChanged = "thread/status/changed"
    case threadArchived = "thread/archived"
    case threadDeleted = "thread/deleted"
    case threadUnarchived = "thread/unarchived"
    case threadClosed = "thread/closed"
    case threadReverted = "thread/reverted"
    case skillsChanged = "skills/changed"
    case threadNameUpdated = "thread/name/updated"
    case threadAttachmentUpdated = "thread/attachment/updated"
    case threadGoalUpdated = "thread/goal/updated"
    case threadGoalCleared = "thread/goal/cleared"
    case threadQueueChanged = "thread/queue/changed"
    case projectChanged = "project/changed"
    case threadProjectUpdated = "thread/project/updated"
    case threadEnvironmentConnected = "thread/environment/connected"
    case threadEnvironmentDisconnected = "thread/environment/disconnected"
    case threadSettingsUpdated = "thread/settings/updated"
    case threadTokenUsageUpdated = "thread/tokenUsage/updated"
    case turnStarted = "turn/started"
    case hookStarted = "hook/started"
    case turnCompleted = "turn/completed"
    case hookCompleted = "hook/completed"
    case turnDiffUpdated = "turn/diff/updated"
    case turnPlanUpdated = "turn/plan/updated"
    case itemStarted = "item/started"
    case itemAutoApprovalReviewStarted = "item/autoApprovalReview/started"
    case itemAutoApprovalReviewCompleted = "item/autoApprovalReview/completed"
    case autoApprovalReviewStrictReviewRequired = "autoApprovalReview/strictReviewRequired"
    case itemCompleted = "item/completed"
    case rawResponseItemCompleted = "rawResponseItem/completed"
    case rawResponseCompleted = "rawResponse/completed"
    case itemAgentMessageDelta = "item/agentMessage/delta"
    case itemPlanDelta = "item/plan/delta"
    case commandExecOutputDelta = "command/exec/outputDelta"
    case processOutputDelta = "process/outputDelta"
    case processExited = "process/exited"
    case itemCommandExecutionOutputDelta = "item/commandExecution/outputDelta"
    case itemCommandExecutionTerminalInteraction = "item/commandExecution/terminalInteraction"
    case itemFileChangeOutputDelta = "item/fileChange/outputDelta"
    case itemFileChangePatchUpdated = "item/fileChange/patchUpdated"
    case serverRequestResolved = "serverRequest/resolved"
    case itemMcpToolCallProgress = "item/mcpToolCall/progress"
    case mcpServerOauthLoginCompleted = "mcpServer/oauthLogin/completed"
    case mcpServerStartupStatusUpdated = "mcpServer/startupStatus/updated"
    case mcpServerEventStreamNotification = "mcpServer/event/stream/notification"
    case accountUpdated = "account/updated"
    case accountGatewayOAuthChanged = "account/gatewayOAuth/changed"
    case accountRateLimitsUpdated = "account/rateLimits/updated"
    case appListUpdated = "app/list/updated"
    case remoteControlStatusChanged = "remoteControl/status/changed"
    case externalAgentConfigImportProgress = "externalAgentConfig/import/progress"
    case externalAgentConfigImportCompleted = "externalAgentConfig/import/completed"
    case fsChanged = "fs/changed"
    case itemReasoningSummaryTextDelta = "item/reasoning/summaryTextDelta"
    case itemReasoningSummaryPartAdded = "item/reasoning/summaryPartAdded"
    case itemReasoningTextDelta = "item/reasoning/textDelta"
    case threadCompacted = "thread/compacted"
    case modelRerouted = "model/rerouted"
    case modelVerification = "model/verification"
    case modelProviderAuthRecoveryStarted = "modelProvider/authRecoveryStarted"
    case modelProviderAuthRecoveryCompleted = "modelProvider/authRecoveryCompleted"
    case turnModerationMetadata = "turn/moderationMetadata"
    case modelSafetyBufferingUpdated = "model/safetyBuffering/updated"
    case warning
    case guardianWarning
    case deprecationNotice
    case configWarning
    case fuzzyFileSearchSessionUpdated = "fuzzyFileSearch/sessionUpdated"
    case fuzzyFileSearchSessionCompleted = "fuzzyFileSearch/sessionCompleted"
    case threadRealtimeStarted = "thread/realtime/started"
    case threadRealtimeItemAdded = "thread/realtime/itemAdded"
    case threadRealtimeItemStarted = "thread/realtime/item/started"
    case threadRealtimeItemTranscriptDelta = "thread/realtime/item/transcript/delta"
    case threadRealtimeItemCompleted = "thread/realtime/item/completed"
    case threadRealtimeTranscriptDelta = "thread/realtime/transcript/delta"
    case threadRealtimeTranscriptDone = "thread/realtime/transcript/done"
    case threadRealtimeOutputAudioDelta = "thread/realtime/outputAudio/delta"
    case threadRealtimeSdp = "thread/realtime/sdp"
    case threadRealtimeError = "thread/realtime/error"
    case threadRealtimeClosed = "thread/realtime/closed"
    case windowsWorldWritableWarning = "windows/worldWritableWarning"
    case windowsSandboxSetupCompleted = "windowsSandbox/setupCompleted"
    case accountLoginCompleted = "account/login/completed"
}

/// Every method of `ServerRequest`: what the server may ask of DevHub.
public enum CodexServerRequest: String, CaseIterable, Sendable {
    case commandExecutionRequestApproval = "item/commandExecution/requestApproval"
    case fileChangeRequestApproval = "item/fileChange/requestApproval"
    case toolRequestUserInput = "item/tool/requestUserInput"
    case mcpServerElicitationRequest = "mcpServer/elicitation/request"
    case permissionsRequestApproval = "item/permissions/requestApproval"
    case toolCall = "item/tool/call"
    case chatgptAuthTokensRefresh = "account/chatgptAuthTokens/refresh"
    case attestationGenerate = "attestation/generate"
    case applyPatchApproval
    case execCommandApproval
}

/// Every `type` of `v2/ThreadItem`, and whether the adapter draws it. A type
/// it does not draw is shown whole, as an information notice.
public enum CodexThreadItemType: String, CaseIterable, Sendable {
    case userMessage, hookPrompt, agentMessage, functionCallOutput, plan, reasoning, commandExecution, fileChange
    case mcpToolCall, dynamicToolCall, collabAgentToolCall, subAgentActivity, webSearch, imageView, sleep
    case imageGeneration, enteredReviewMode, exitedReviewMode, contextCompaction

    public var drawn: Bool {
        switch self {
        case .hookPrompt, .functionCallOutput, .sleep, .imageGeneration: return false
        case .userMessage, .agentMessage, .plan, .reasoning, .commandExecution, .fileChange, .mcpToolCall,
            .dynamicToolCall, .collabAgentToolCall, .subAgentActivity, .webSearch, .imageView, .enteredReviewMode,
            .exitedReviewMode, .contextCompaction:
            return true
        }
    }
}

/// The methods DevHub calls on app-server (`ClientRequest`, the ones it uses).
public enum CodexClientMethod: String, CaseIterable, Sendable {
    case initialize
    case accountRead = "account/read"
    case threadStart = "thread/start"
    case threadResume = "thread/resume"
    case threadRevert = "thread/revert"
    case modelList = "model/list"
    case skillsList = "skills/list"
    case mcpServerStatusList = "mcpServerStatus/list"
    case configMcpServerReload = "config/mcpServer/reload"
    case turnStart = "turn/start"
    case turnSteer = "turn/steer"
    case turnInterrupt = "turn/interrupt"
}

/// `v2/CollabAgentTool`.
public enum CodexCollabAgentTool: String, CaseIterable, Sendable {
    case spawnAgent, sendInput, resumeAgent, wait, closeAgent, sendMessage, followupTask, interruptAgent, listAgents
}

/// `v2/CollabAgentStatus`.
public enum CodexCollabAgentStatus: String, CaseIterable, Sendable {
    case pendingInit, running, interrupted, completed, errored, shutdown, notFound
}

/// The words of `v2/CodexErrorInfo` (its object variants carry an HTTP status beside the word).
public enum CodexErrorInfo: String, CaseIterable, Sendable {
    case contextWindowExceeded, sessionBudgetExceeded, usageLimitExceeded, rateLimitExceeded, flexUnavailable
    case serverOverloaded, cyberPolicy, misalignmentPolicyViolation, internalServerError, unauthorized, badRequest
    case threadRollbackFailed, sandboxError, other
}

/// `v2/ThreadSourceKind`: what started a thread, as `thread/list` filters by it.
public enum CodexThreadSourceKind: String, CaseIterable, Sendable {
    case cli, vscode, exec, appServer, subAgent, subAgentReview, subAgentCompact, subAgentThreadSpawn, subAgentOther
    case unknown
}

/// `v2/AskForApproval`, the words DevHub's modes use.
public enum CodexAskForApproval: String, Sendable {
    case untrusted
    case onRequest = "on-request"
    case never
}
