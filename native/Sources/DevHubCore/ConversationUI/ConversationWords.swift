// The words and small readings of a drawn conversation, ported from the TS
// view so the native one says exactly what it says:
//
//   activity.ts            deriveActivity, estimateTokens, activityLabel, formatElapsed, formatTokens
//   StatusMark.tsx         WORK_STATE_LABELS, workNote
//   Composer.tsx           inputRefusal, composerPlaceholder, REWIND_NOTE, pendingStatus, draftWords,
//                          COMPOSER_PLACEHOLDER, readImages' refusal
//   messageKeys.ts         SEND_KEY
//   EntryView.tsx          ORIGIN_NOTES, answerText, answerSource, NOT_FROM_YOU_LINES, STEP_LABELS,
//                          OUTCOME_LABELS, limitResumeLine, the compaction's facts
//   ConversationSurface.tsx waitingSentence, the empty transcript, conversationFontSize
//   ContextUsage.tsx       contextPercent, the readout's words
//   BackgroundTasks.tsx    elapsedText, backgroundSentence, stopQuestion
//   McpPanel.tsx           statusText, the status and action words
//   FindBar.tsx            countText
//   EntryParts.tsx         diffRows, shownPath, imageUrl

import Foundation

// MARK: - Activity (activity.ts)

public enum ConversationActivity: Equatable, Sendable {
    case thinking
    case responding
    case tool(String)
    case permission
    case compacting

    /// What the Agent is doing while a turn runs; nil when no turn is running.
    public static func of(_ transcript: Transcript) -> ConversationActivity? {
        guard transcript.state.turn == .running else { return nil }
        if !transcript.requests.isEmpty { return .permission }
        if transcript.compacting { return .compacting }
        for entry in transcript.entries.reversed() {
            switch entry {
            case .user, .turnEnd: return .thinking
            case .assistant(let assistant) where assistant.streaming:
                if case .text? = assistant.blocks.last { return .responding }
                return .thinking
            case .tool(let tool) where tool.status == .running:
                return .tool(tool.tool)
            default: continue
            }
        }
        return .thinking
    }

    public var label: String {
        switch self {
        case .thinking: return "Thinking…"
        case .responding: return "Responding…"
        case .tool(let tool): return "Running \(tool)…"
        case .permission: return "Waiting for permission"
        case .compacting: return "Compacting…"
        }
    }

    public var phase: String {
        switch self {
        case .thinking: return "thinking"
        case .responding: return "responding"
        case .tool: return "tool"
        case .permission: return "permission"
        case .compacting: return "compacting"
        }
    }

    /// A rough count of the tokens the Agent has produced since the person's
    /// last message (characters over four), from what it has streamed.
    public static func estimateTokens(_ transcript: Transcript) -> Int {
        var chars = 0
        for entry in transcript.entries.reversed() {
            if case .user = entry { break }
            if case .turnEnd = entry { break }
            guard case .assistant(let assistant) = entry else { continue }
            for block in assistant.blocks {
                switch block {
                case .text(let markdown): chars += (markdown as NSString).length
                case .thinking(let text): chars += (text as NSString).length
                case .plan: break
                }
            }
        }
        return Int((Double(chars) / 4).rounded(.toNearestOrAwayFromZero))
    }

    /// `45s`, `2m 05s`.
    public static func formatElapsed(_ ms: Double) -> String {
        let seconds = max(0, Int((ms / 1000).rounded(.down)))
        if seconds < 60 { return "\(seconds)s" }
        return "\(seconds / 60)m \(String(format: "%02d", seconds % 60))s"
    }

    /// `850`, `1.2k`.
    public static func formatTokens(_ count: Int) -> String {
        count < 1000 ? String(count) : String(format: "%.1fk", Double(count) / 1000)
    }

    /// The line's meta: `12s · ↓ ~1.2k tokens`.
    public static func meta(elapsedMs: Double, tokens: Int) -> String {
        formatElapsed(elapsedMs) + (tokens > 0 ? " · ↓ ~\(formatTokens(tokens)) tokens" : "")
    }

    /// How long the line takes to fade out once the turn ends (`--motion-base`).
    public static let exitMs: Double = 180
}

// MARK: - Status marks (StatusMark.tsx)

public enum WorkStateWords {
    public static func label(_ state: WorkState) -> String {
        switch state {
        case .running: return "Running"
        case .succeeded: return "Done"
        case .failed: return "Failed"
        case .denied: return "Denied"
        case .interrupted: return "Interrupted"
        case .idle: return "Idle"
        case .unknown: return "Unknown"
        }
    }

    /// What a call's row says at its right, beside the glyph: only what the
    /// glyph does not. Nil when there is nothing more to say.
    public static func note(_ entry: ToolEntry) -> String? {
        let state = workState(entry)
        var notes: [String] = []
        if [.denied, .interrupted, .idle, .unknown].contains(state) { notes.append(label(state)) }
        if state == .running, entry.status == .succeeded { notes.append("In the background") }
        for part in entry.output ?? [] {
            if case .command(let exitCode, _, _, _) = part, let code = exitCode, code != 0 {
                notes.append("Exit code \(JsonValue.javaScriptNumber(code))")
            }
        }
        return notes.isEmpty ? nil : notes.joined(separator: " · ")
    }
}

// MARK: - The composer (Composer.tsx, messageKeys.ts)

public enum ComposerWords {
    /// How the send key is written wherever a GUI Agent names it.
    public static let sendKey = "⌘Return"

    public static let placeholder = "Message the Agent — / for commands, \(sendKey) to send"

    static func brokenRefusal(_ code: ConversationFailureCode) -> String {
        switch code {
        case .protocolMismatch:
            return "This conversation takes no more input: DevHub could not read what the Agent said."
        case .notSignedIn:
            return "This conversation takes no more input until the Agent's CLI is signed in again and restarted."
        case .refused:
            return "This conversation takes no more input: the Agent's CLI refused to start."
        }
    }

    /// Why the composer takes no input right now, or nil when it does: only a
    /// conversation that takes no more input refuses it.
    public static func inputRefusal(_ state: ConversationState) -> String? {
        if case .broken(let failure) = state { return brokenRefusal(failure.code) }
        return nil
    }

    /// What the empty composer says: why the Agent would hold a message now, if it would.
    public static func placeholder(_ state: ConversationState) -> String {
        switch state {
        case .connecting: return "Connecting to the Agent… What you send now is sent once it is ready."
        case .ready(let turn):
            return turn == .rewinding
                ? "Taking the conversation back… What you send now is sent once that is done." : placeholder
        case .broken(let failure): return brokenRefusal(failure.code)
        }
    }

    /// What Rewind says before it drops anything.
    public static let rewindNote =
        "Rewind to before this message? It and everything after it leave the conversation, and its words come back to the composer. Files the Agent changed are not changed back."

    /// What a held message says about itself.
    public static func pendingStatus(_ message: PendingMessage) -> String {
        if let failure = message.failure { return "Not sent: \(failure)" }
        return message.editing
            ? "Being changed: not sent until you save or cancel" : "Waiting: sent when the Agent is ready for it"
    }

    /// The label over a held message.
    public static func pendingLabel(_ message: PendingMessage, position: Int, total: Int) -> String {
        if message.failure != nil { return "Not sent" }
        return total > 1 ? "Queued \(position) of \(total) · sends after this turn" : "Queued · sends after this turn"
    }

    /// The draft: the words of the waiting messages being changed, oldest first, then the field's.
    public static func draftWords(_ pending: [PendingMessage], _ edits: [PendingId: String], _ text: String) -> String {
        (pending.compactMap { edits[$0.id] } + [text])
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .joined(separator: "\n\n")
    }

    /// How long typing pauses before the draft is reported.
    public static let draftPauseMs: Double = 400

    /// A file that is not an image a model takes, refused by name.
    public static func imageRefusal(_ name: String?) -> String {
        "\((name?.isEmpty == false ? name! : "The pasted file")) cannot be attached: the Agent takes PNG, JPEG, GIF or WebP images."
    }

    /// Whether the CLI can take a message now (a running turn takes it in), and a setting.
    public static func canSendNow(_ state: ConversationState) -> Bool {
        guard let turn = state.turn else { return false }
        return turn != .rewinding
    }

    /// What ⌘Return does with what is in the composer (`submit`).
    public enum Submission: Equatable, Sendable {
        /// A command DevHub answers itself, typed out whole: that command chosen.
        case command(SlashCommand)
        case send(text: String)
        /// The field is empty: the oldest held message not open for change goes now.
        case sendPendingNow(PendingId)
        case nothing
    }

    public static func submission(
        text: String, images: Int, transcript: Transcript, editing: Set<PendingId>
    ) -> Submission {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let answered = transcript.session.commands.first(where: {
            $0.route != .message && trimmed == "\($0.trigger.rawValue)\($0.name)"
        }) {
            return .command(answered)
        }
        let refusal = inputRefusal(transcript.state)
        if (trimmed.isEmpty && images == 0) || refusal != nil {
            if trimmed.isEmpty, images == 0, canSendNow(transcript.state),
               let held = transcript.pending.first(where: { !editing.contains($0.id) })
            {
                return .sendPendingNow(held.id)
            }
            return .nothing
        }
        return .send(text: text)
    }
}

// MARK: - Entries (EntryView.tsx)

public enum EntryWords {
    /// What DevHub says over a message it sent for the person.
    public static func originNote(_ origin: SentOrigin) -> String? {
        switch origin {
        case .person: return nil
        case .injection: return "Sent by a template"
        case .afterLimit: return "Sent automatically after the limit reset"
        case .autoCompact: return "Sent automatically to compact before the prompt cache expired"
        }
    }

    /// The same for an echoed message's origin (`other` draws no bubble at all).
    public static func originNote(_ origin: UserOrigin) -> String? {
        switch origin {
        case .person, .other: return nil
        case .injection: return originNote(SentOrigin.injection)
        case .afterLimit: return originNote(SentOrigin.afterLimit)
        case .autoCompact: return originNote(SentOrigin.autoCompact)
        }
    }

    static func answerLines(_ answer: QuestionAnswer) -> [String] {
        if answer.secret { return ["(hidden)"] }
        let lines = answer.chosen + (answer.written.map { [$0] } ?? [])
        return (lines.isEmpty ? ["(no answer)"] : lines) + (answer.notes.map { ["Note: \($0)"] } ?? [])
    }

    /// What "Copy" on an answer to the Agent's questions copies: each question, then its answer.
    public static func answerText(_ entry: AnswerEntry) -> String {
        entry.answers.map { answer in
            ([answer.header.isEmpty ? answer.question : "\(answer.header): \(answer.question)"] + answerLines(answer))
                .joined(separator: "\n")
        }.joined(separator: "\n\n")
    }

    /// What "Copy" on an answer copies: its Markdown, block after block.
    public static func answerSource(_ entry: AssistantEntry) -> String {
        entry.blocks.compactMap { block -> String? in
            if case .text(let markdown) = block { return markdown }
            return nil
        }.joined(separator: "\n\n")
    }

    /// Past this many lines, a message not from the person is folded.
    public static let notFromYouLines = 8

    public static let notFromYouLabel = "Message to the Agent (not from you)"

    public static func stepLabel(_ status: PlanStatus) -> String {
        switch status {
        case .pending: return "To do"
        case .inProgress: return "Under way"
        case .completed: return "Done"
        }
    }

    public static func outcomeLabel(_ outcome: TurnOutcome) -> String? {
        switch outcome {
        case .completed: return nil
        case .interrupted: return "Turn interrupted"
        case .failed: return "Turn failed"
        }
    }

    /// `1,234`: a count as `toLocaleString("en-US")` writes it.
    public static func grouped(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 3
        return formatter.string(from: NSNumber(value: value)) ?? JsonValue.javaScriptNumber(value)
    }

    /// The compaction divider's words.
    public static func compaction(_ entry: CompactionEntry) -> String {
        var facts: [String] = []
        if let trigger = entry.trigger { facts.append(trigger) }
        if let pre = entry.preTokens {
            if let post = entry.postTokens {
                facts.append("from \(grouped(pre)) to \(grouped(post)) tokens")
            } else {
                facts.append("from \(grouped(pre)) tokens")
            }
        }
        return "Conversation compacted" + (facts.isEmpty ? "" : " · " + facts.joined(separator: " · "))
    }

    public static let compacting = "Compacting the conversation…"

    public enum LineLevel: String, Sendable { case info, warning }

    /// The usage-limit line's words, its level, and what its button says.
    public static func limitResumeLine(_ resume: LimitResume, now: Double, timeZone: TimeZone = .current, locale: Locale = .current)
        -> (text: String, level: LineLevel, action: String)
    {
        switch resume {
        case .scheduled(let at):
            return ("Rate limited — resuming at \(ResetTime.clockTime(at, now: now, timeZone: timeZone, locale: locale))", .info, "Cancel")
        case .unscheduled(let reason):
            return ("Rate limited — not resuming by itself: \(reason)", .info, "Dismiss")
        case .failed(let failure):
            return ("Rate limited — could not resume: \(failure)", .warning, "Dismiss")
        }
    }

    /// The fold of a thinking block.
    public static func thinking(streaming: Bool) -> String { streaming ? "Thinking…" : "Thought" }

    public static let eventAsReceived = "Event as received"
    public static let sending = "Sending…"
}

// MARK: - The surface (ConversationSurface.tsx)

public enum SurfaceWords {
    public static func waitingSentence(_ count: Int) -> String {
        count == 1 ? "1 request is waiting for an answer" : "\(count) requests are waiting for an answer"
    }

    public static let emptyTitle = "What should the Agent do?"
    public static let emptyHint = "\(ComposerWords.sendKey) sends, Return starts a new line, and / lists the Agent's commands."

    /// The terminal's text size when there is no appearance yet.
    public static let defaultFontSize: Double = 13

    /// The conversation's text size, a step larger than the terminal's.
    /// Proportional prose at a terminal's size reads smaller than its monospace
    /// does; at this step the terminal's 13 px is 15 px of prose, and the
    /// transcript's code (0.88em) lands back near the terminal's own size.
    public static func fontSize(terminal: Double) -> Double { terminal * 15 / 13 }

    public static let latest = "Latest"
    public static let newOutput = "New output"
}

// MARK: - The context readout (ContextUsage.tsx)

public enum ContextWords {
    static func tokens(_ count: Double) -> String {
        if count < 1000 { return JsonValue.javaScriptNumber(count) }
        if count < 1_000_000 { return "\(Int((count / 1000).rounded(.toNearestOrAwayFromZero)))k" }
        return String(format: "%.1fM", count / 1_000_000)
    }

    /// How full the context window is, when the CLI has said: 0–100.
    public static func percent(_ usage: Usage) -> Int? {
        guard let tokens = usage.contextTokens, let window = usage.contextWindow, window > 0 else { return nil }
        return Int((tokens / window * 100).rounded(.toNearestOrAwayFromZero))
    }

    /// The readout's words; nil when nothing is drawn.
    public static func words(_ usage: Usage?) -> String? {
        guard let usage, let tokens = usage.contextTokens else { return nil }
        if let percent = percent(usage) {
            return "Context \(percent)% · \(self.tokens(tokens)) of \(self.tokens(usage.contextWindow!))"
        }
        return "Context \(self.tokens(tokens))"
    }

    public static func level(_ usage: Usage?) -> UsageLevel {
        UsageLevel(percent: usage.flatMap(percent).map(Double.init))
    }
}

// MARK: - Background tasks (BackgroundTasks.tsx)

public enum BackgroundWords {
    /// How long something has run: `45s`, `3m 12s`, `1h 5m`.
    public static func elapsed(_ ms: Double) -> String {
        let seconds = max(0, Int((ms / 1000).rounded(.down)))
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        if hours > 0 { return "\(hours)h \(minutes)m" }
        if minutes > 0 { return "\(minutes)m \(seconds % 60)s" }
        return "\(seconds)s"
    }

    public static func sentence(_ count: Int) -> String {
        count == 1 ? "1 background task" : "\(count) background tasks"
    }

    /// What pressing Stop asks before it stops, by the task's kind.
    public static func stopQuestion(_ kind: String) -> String {
        switch kind {
        case "shell": return "Stop this background shell? The command it's running will be terminated."
        case "subagent": return "Stop this subagent? Its work so far stays, and it won't resume on its own."
        default: return "Stop this background task?"
        }
    }

    public static func stopTitle(_ stoppable: Stoppable) -> String {
        switch stoppable {
        case .yes: return "Stop this task"
        case .no(let reason): return reason
        }
    }
}

// MARK: - The MCP panel (McpPanel.tsx)

public enum McpWords {
    public static func status(_ status: McpServerStatus) -> String {
        switch status {
        case .connected: return "Connected"
        case .needsSignIn: return "Needs sign-in"
        case .failed: return "Failed"
        case .connecting: return "Connecting…"
        case .disabled: return "Disabled"
        case .unknown: return "Unknown"
        }
    }

    public static func action(_ action: McpAction) -> String {
        switch action {
        case .signIn: return "Sign In…"
        case .reconnect: return "Reconnect"
        case .enable: return "Enable"
        case .disable: return "Disable"
        }
    }

    /// How a server's status reads: DevHub's word, and the CLI's when DevHub has none.
    public static func statusText(_ server: McpServer) -> String {
        server.status == .unknown ? "\(status(.unknown)) (\(server.said))" : status(server.status)
    }

    public static func question(_ label: String) -> String { "\(label)'s MCP servers, as its CLI reports them." }

    public static func signInTitle(_ signIn: McpSignIn) -> String {
        switch signIn.phase {
        case .running: return "Signing in to \(signIn.server)…"
        case .succeeded: return "Signed in to \(signIn.server)"
        case .failed: return "The sign-in to \(signIn.server) failed"
        }
    }

    public static func callback(_ callback: McpCallback) -> String {
        switch callback {
        case let .forwarded(port, to):
            return "localhost:\(port) on this Mac is forwarded to \(to) while the sign-in runs, so the browser's redirect reaches it."
        case let .unforwarded(port, why):
            return "localhost:\(port) could not be forwarded: \(why) Paste the address the browser ends on below instead."
        }
    }

    /// The URLs in the sign-in's output (`/https?:\/\/[^\s"'<>`]+/gu`), as UTF-16 ranges.
    public static func urls(_ text: String) -> [NSRange] {
        let regex = try! NSRegularExpression(pattern: "https?://[^\\s\"'<>`]+")
        return regex.matches(in: text, range: NSRange(location: 0, length: (text as NSString).length)).map(\.range)
    }
}

// MARK: - Find (FindBar.tsx)

public enum FindWords {
    /// How many matches, and which is current: `3 of 2,596,112`, with `…` while the count still grows.
    public static func countText(_ query: String, total: Int, current: Int?, complete: Bool) -> String {
        if query.isEmpty { return "" }
        if total == 0 { return complete ? "No results" : "Searching…" }
        let which = current.map { EntryWords.grouped(Double($0 + 1)) } ?? "–"
        return "\(which) of \(EntryWords.grouped(Double(total)))\(complete ? "" : "…")"
    }

    public static let conversationScope = "Searching the conversation"
    public static func subagentScope(_ label: String) -> String { "Searching subagent \(label)" }
}

// MARK: - Diffs, paths, images (EntryParts.tsx)

public struct DiffRow: Equatable, Sendable {
    public enum Kind: String, Sendable { case add, remove, hunk, context }
    public var kind: Kind
    public var text: String
    /// The line's number in the file before and after, where the hunk says.
    public var old: Int?
    public var new: Int?
}

public enum DiffRows {
    static func kind(_ line: String) -> DiffRow.Kind {
        if line.hasPrefix("@@") { return .hunk }
        if line.hasPrefix("+"), !line.hasPrefix("+++") { return .add }
        if line.hasPrefix("-"), !line.hasPrefix("---") { return .remove }
        return .context
    }

    /// A unified diff as rows, each numbered as its hunk header says. A hunk
    /// without numbers (`@@` alone, a diff made from a call's input) numbers nothing.
    public static func of(_ unifiedDiff: String) -> [DiffRow] {
        var old: Int?
        var new: Int?
        let header = try! NSRegularExpression(pattern: "^@@ -([0-9]+)(?:,[0-9]+)? \\+([0-9]+)(?:,[0-9]+)? @@")
        return unifiedDiff.components(separatedBy: "\n").map { text in
            let kind = kind(text)
            if kind == .hunk {
                let ns = text as NSString
                if let match = header.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) {
                    old = Int(ns.substring(with: match.range(at: 1)))
                    new = Int(ns.substring(with: match.range(at: 2)))
                } else {
                    old = nil
                    new = nil
                }
                return DiffRow(kind: kind, text: text, old: nil, new: nil)
            }
            let row = DiffRow(kind: kind, text: text, old: kind == .add ? nil : old, new: kind == .remove ? nil : new)
            if kind != .add, let current = old { old = current + 1 }
            if kind != .remove, let current = new { new = current + 1 }
            return row
        }
    }

    /// The first line a diff's hunks name in the file after it, where one does.
    public static func firstNewLine(_ rows: [DiffRow]) -> Int? { rows.first { $0.new != nil }?.new }

    /// A path inside the Agent's directory, relative to it; any other, whole.
    public static func shownPath(_ path: String, cwd: String?) -> String {
        guard let cwd, !cwd.isEmpty else { return path }
        let base = cwd.hasSuffix("/") ? cwd : cwd + "/"
        return path.hasPrefix(base) ? String(path.dropFirst(base.count)) : path
    }
}

public enum ImageSourceReading {
    /// Where the view can read an image from: its own bytes, or a `data:` /
    /// `https:` URL. A file on the Agent's machine, or a URL of another
    /// scheme, it does not open (`imageUrl`).
    public enum Readable: Equatable, Sendable {
        case bytes(Data)
        case url(String)
    }

    public static func readable(_ image: ImageRef) -> Readable? {
        switch image.source {
        case .data(let base64):
            return Data(base64Encoded: base64, options: .ignoreUnknownCharacters).map { .bytes($0) }
        case .url(let url):
            if url.hasPrefix("data:") {
                guard let comma = url.firstIndex(of: ","),
                      let data = Data(base64Encoded: String(url[url.index(after: comma)...]), options: .ignoreUnknownCharacters)
                else { return nil }
                return .bytes(data)
            }
            return url.hasPrefix("https:") ? .url(url) : nil
        case .file:
            return nil
        }
    }

    public static func missing(_ image: ImageRef) -> String { "Image not shown here: \(image.label)" }
}

/// Where the scroller must be for an element that moved from `before` to
/// `after` (its top on screen) to be back where it was (Clip.tsx).
public func anchoredScrollTop(_ scrollTop: Double, before: Double, after: Double) -> Double {
    scrollTop + (after - before)
}

/// How close to the end still counts as the end (followScroll.ts).
public let BOTTOM_SLACK_PX: Double = 2

public func isAtBottom(scrollTop: Double, scrollHeight: Double, clientHeight: Double) -> Bool {
    scrollHeight - scrollTop - clientHeight <= BOTTOM_SLACK_PX
}
