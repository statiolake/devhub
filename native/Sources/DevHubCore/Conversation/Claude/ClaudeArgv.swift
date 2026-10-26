// Port of apps/desktop/src/main/agent/conversation/claude/argv.ts
//
// The command line that puts `claude` into its structured mode.
//
// The profile's own command and arguments come first and are left as they
// are — a `--permission-mode` or `--model` the owner put there is theirs to
// keep — and the flags that make the conversation readable follow them.
// `--bare` is never added: it reads an API key only, and a GUI Agent runs on
// the owner's own sign-in exactly as the TUI does.

import Foundation

/// A CLI to start: its file, its whole argv after it, and the variables it
/// gets on top of the session's (`AgentSessionCommand` in the TS app).
public struct CLICommand: Hashable, Sendable {
    public var file: String
    public var args: [String]
    /// Extra variables for this Agent only, on top of the server's.
    public var env: [String: String]

    public init(file: String, args: [String], env: [String: String] = [:]) {
        self.file = file
        self.args = args
        self.env = env
    }
}

public let CLAUDE_STRUCTURED_FLAGS = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", "--forward-subagent-text", "--replay-user-messages",
    "--permission-prompt-tool", "stdio",
]

public func claudeStructuredCommand(_ cli: CLICommand) -> CLICommand {
    var command = cli
    command.args += CLAUDE_STRUCTURED_FLAGS
    return command
}

/// The command line of the background usage reader's `claude`
/// (`main/shell/usageReaders.ts`): structured input and output, and nothing
/// that could make it a conversation. It is sent control requests only,
/// never a message, so it never starts a turn; `--no-session-persistence`
/// keeps it from writing a session, and `disableAllHooks` keeps the owner's
/// hooks — `SessionStart` among them — from running for a process that is
/// not a session anybody opened.
public let CLAUDE_USAGE_FLAGS = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--no-session-persistence", "--settings", #"{"disableAllHooks":true}"#,
]
