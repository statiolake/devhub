// Port of apps/desktop/src/main/agent/conversation/failures.ts
//
// The failures a GUI Agent's conversation and the sessions of its CLI end in
// that DevHub knows by name.
//
// Each has its own code (the app's error wire code), so it is drawn with its
// own title and the sentence it was raised with as the detail, wherever it
// ends — a notice, the session picker, a launch. A plain error from this part
// of Core is kept for what DevHub did not expect.
//
// Which kind a failure is decides only its title; the words that say what
// happened are the raiser's, its detail.

import Foundation

public struct ConversationError: Error, CustomStringConvertible, Equatable, Sendable {
    public enum Kind: String, Sendable {
        /// The conversation will not take what it was asked, now or with this
        /// CLI, and `reason` says what to do instead.
        case refused = "conversation_refused"
        /// The conversation stopped while, or before, it was doing what it was asked.
        case stopped = "conversation_stopped"
        /// A session DevHub was asked to go on with cannot be gone on with:
        /// the one a launch or a `/resume` names is not there, or not whole,
        /// or the one a terminal Agent is in cannot be told, or a GUI Agent's
        /// CLI has named none yet.
        case notResumable = "conversation_not_resumable"
        /// What a CLI keeps of its sessions could not be read on the
        /// Workspace's machine.
        case sessionsUnreadable = "sessions_unreadable"
    }

    public let kind: Kind
    /// The raiser's sentence: the failure's detail.
    public let reason: String

    /// The app's error wire code (`AppErrorCodeWire`).
    public var code: String { kind.rawValue }
    public var description: String { reason }

    public static func refused(_ reason: String) -> ConversationError { ConversationError(kind: .refused, reason: reason) }
    public static func stopped(_ reason: String) -> ConversationError { ConversationError(kind: .stopped, reason: reason) }
    public static func notResumable(_ reason: String) -> ConversationError {
        ConversationError(kind: .notResumable, reason: reason)
    }
    public static func sessionsUnreadable(_ reason: String) -> ConversationError {
        ConversationError(kind: .sessionsUnreadable, reason: reason)
    }
}
