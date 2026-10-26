// Port of `adapterFor` in apps/desktop/src/main/shell/agentWiring.ts: the
// protocol adapter of a GUI Agent, by its profile's kind.

import Foundation

/// The adapter that reads a GUI Agent's CLI: Claude's stream-json, or
/// Codex's app-server, which resumes the thread its profile's argv ended with
/// (`codexStructuredArgs`) by `thread/resume` rather than on its command line.
public func guiConversationAdapter(
    _ kind: SessionCLIKind, profileArgs: [String], bootId: String, cwd: String, clientVersion: String,
    developerInstructions: (@Sendable () -> String?)? = nil
) -> any ProtocolAdapter {
    switch kind {
    case .claude:
        return ClaudeAdapter(bootId: bootId)
    case .codex:
        return CodexAdapter(
            CodexAdapterOptions(
                clientVersion: clientVersion, cwd: cwd, resumeThreadId: codexStructuredArgs(profileArgs).resumeThreadId,
                developerInstructions: developerInstructions))
    }
}
