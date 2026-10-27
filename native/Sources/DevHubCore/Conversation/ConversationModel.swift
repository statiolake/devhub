// Port of apps/desktop/src/model/conversation.ts (types).
//
// The conversation of a GUI Agent, normalized: one shape for Claude and Codex.
//
// A protocol adapter turns what its CLI prints into `ConversationEvent`s, and
// `applyEvent` folds them into a `Transcript`. That fold is the only one. The
// coordinator holds the true Transcript and folds every event into it; the
// view takes a snapshot and folds the events that follow into its copy — with
// this same function, because a second reducer would be a second path that
// says the same thing, and one of the two would drift.
//
// Nothing here does I/O, and nothing here knows which CLI is on the other end.
//
// # What the fold refuses
//
// An event is the adapter's claim about the conversation. An event that cannot
// be true of the Transcript it lands on — a delta for an entry that does not
// exist, an entry that changes its kind, a request about a tool call nobody
// made — means the adapter's bookkeeping has broken, and the fold throws
// `TranscriptInvariantError` rather than drawing something plausible. The
// adapter's caller turns that into a broken conversation at its one root.
//
// What the *CLI* says that DevHub does not understand is a different thing and
// is not refused here: the adapter reports it as a `notice` entry (an unknown
// event) or as `state: broken` (a known event of the wrong shape).
//
// # What the fold does not infer
//
// Every event says one thing and the fold records exactly that thing. A
// `turn-end` entry does not end the turn in `state`; a finished tool does not
// close the request about it. The adapter sends each fact it knows, so there
// is one place each fact comes from.

import Foundation

// MARK: - Ids

public struct EntryId: Hashable, Sendable, Comparable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let raw: String
    public init(_ raw: String) { self.raw = raw }
    public init(stringLiteral value: String) { raw = value }
    public var description: String { raw }
    public static func < (lhs: EntryId, rhs: EntryId) -> Bool { lhs.raw < rhs.raw }
}

public struct RequestId: Hashable, Sendable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let raw: String
    public init(_ raw: String) { self.raw = raw }
    public init(stringLiteral value: String) { raw = value }
    public var description: String { raw }
}

public struct PendingId: Hashable, Sendable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let raw: String
    public init(_ raw: String) { self.raw = raw }
    public init(stringLiteral value: String) { raw = value }
    public var description: String { raw }
}

// MARK: - Images

/// An image in the conversation: one the person attached to a message, or one
/// a tool gave back (a screenshot, a picture it read).
public struct ImageRef: Hashable, Sendable {
    /// `image/png` and the like; `image/*` when the CLI did not say.
    public var mediaType: String
    public var source: ImageSource
    /// What the image is called, for a reader who cannot see it: a file name, or `image`.
    public var label: String

    public init(mediaType: String, source: ImageSource, label: String) {
        self.mediaType = mediaType
        self.source = source
        self.label = label
    }
}

/// Where an image's pixels are. `data` and `url` a view can draw; `file` is a
/// path on the Agent's machine, which is named and not drawn.
public enum ImageSource: Hashable, Sendable {
    case data(base64: String)
    case url(String)
    case file(path: String)
}

/// The kinds of image a person can send: the ones both CLIs' models take.
public let SENDABLE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]

public struct AttachedImageRefused: Error, CustomStringConvertible, Equatable {
    public let message: String
    public var description: String { message }
}

/// Images a view says the person attached, checked: each its own bytes, of a
/// kind a model takes. Anything else is refused, with what was wrong.
public func attachedImages(_ images: [ImageRef]) throws -> [ImageRef] {
    try images.enumerated().map { index, image in
        guard SENDABLE_IMAGE_TYPES.contains(image.mediaType), case .data(let base64) = image.source else {
            throw AttachedImageRefused(
                message: "attached image \(index) is not a PNG, JPEG, GIF or WebP image's own bytes")
        }
        return ImageRef(mediaType: image.mediaType, source: .data(base64: base64), label: image.label)
    }
}

// MARK: - Entries

/// Whom DevHub wrote a user message for: the person (at the composer), a
/// template (an injection), or the person again, by DevHub on their behalf,
/// once a usage limit that stopped the Agent had reset (`after-limit`), or
/// DevHub compacting an idle conversation before its prompt cache went cold
/// (`auto-compact`). Written into the line itself, so a replay says the same.
public enum SentOrigin: String, Hashable, Sendable, CaseIterable {
    case person
    case injection
    case afterLimit = "after-limit"
    case autoCompact = "auto-compact"
}

public enum UserOrigin: String, Hashable, Sendable {
    case person
    case injection
    case afterLimit = "after-limit"
    case autoCompact = "auto-compact"
    case other

    public init(_ sent: SentOrigin) { self = UserOrigin(rawValue: sent.rawValue)! }
}

public enum TranscriptEntry: Hashable, Sendable {
    case user(UserEntry)
    case answer(AnswerEntry)
    case command(CommandEntry)
    case assistant(AssistantEntry)
    case tool(ToolEntry)
    case notice(NoticeEntry)
    case compaction(CompactionEntry)
    case turnEnd(TurnEndEntry)

    public var id: EntryId {
        switch self {
        case .user(let e): return e.id
        case .answer(let e): return e.id
        case .command(let e): return e.id
        case .assistant(let e): return e.id
        case .tool(let e): return e.id
        case .notice(let e): return e.id
        case .compaction(let e): return e.id
        case .turnEnd(let e): return e.id
        }
    }

    /// The entry's parent: the call that started the subagent it belongs to.
    /// A command and a turn's end are always at the top level.
    public var parent: EntryId? {
        switch self {
        case .user(let e): return e.parent
        case .answer(let e): return e.parent
        case .command: return nil
        case .assistant(let e): return e.parent
        case .tool(let e): return e.parent
        case .notice(let e): return e.parent
        case .compaction(let e): return e.parent
        case .turnEnd: return nil
        }
    }

    /// The kind, in the TS model's words: `user`, `tool`, `turn-end`.
    public var kind: String {
        switch self {
        case .user: return "user"
        case .answer: return "answer"
        case .command: return "command"
        case .assistant: return "assistant"
        case .tool: return "tool"
        case .notice: return "notice"
        case .compaction: return "compaction"
        case .turnEnd: return "turn-end"
        }
    }

    public var userEntry: UserEntry? { if case .user(let e) = self { return e }; return nil }
    public var answerEntry: AnswerEntry? { if case .answer(let e) = self { return e }; return nil }
    public var commandEntry: CommandEntry? { if case .command(let e) = self { return e }; return nil }
    public var assistantEntry: AssistantEntry? { if case .assistant(let e) = self { return e }; return nil }
    public var toolEntry: ToolEntry? { if case .tool(let e) = self { return e }; return nil }
    public var noticeEntry: NoticeEntry? { if case .notice(let e) = self { return e }; return nil }
    public var compactionEntry: CompactionEntry? { if case .compaction(let e) = self { return e }; return nil }
    public var turnEndEntry: TurnEndEntry? { if case .turnEnd(let e) = self { return e }; return nil }
}

public struct UserEntry: Hashable, Sendable {
    public var id: EntryId
    public var parent: EntryId?
    public var text: String
    public var images: [ImageRef]
    /// Who made the Agent say it: the person (at the composer, or at the CLI's
    /// terminal in a session read back), a template injection, DevHub for the
    /// person once a usage limit reset (`after-limit`), or `other` — something
    /// that reached the Agent as a user message DevHub did not send.
    public var origin: UserOrigin
    /// Whether the CLI can cut the conversation right before this message,
    /// when its session can take turns back at all (`SessionFacts.canRewind`).
    public var rewindable: Bool

    public init(
        id: EntryId, parent: EntryId? = nil, text: String, images: [ImageRef] = [],
        origin: UserOrigin, rewindable: Bool
    ) {
        self.id = id
        self.parent = parent
        self.text = text
        self.images = images
        self.origin = origin
        self.rewindable = rewindable
    }
}

/// The person's answer to questions the Agent asked (Claude's
/// AskUserQuestion, Codex's requestUserInput), drawn as their message.
public struct AnswerEntry: Hashable, Sendable {
    public var id: EntryId
    public var parent: EntryId?
    /// One per question, in the order they were asked.
    public var answers: [QuestionAnswer]

    public init(id: EntryId, parent: EntryId? = nil, answers: [QuestionAnswer]) {
        self.id = id
        self.parent = parent
        self.answers = answers
    }
}

/// A question a call asked, as it was asked, and how the person answered it.
public struct AskedQuestion: Hashable, Sendable {
    public var question: Question
    public var answer: QuestionAnswer

    public init(question: Question, answer: QuestionAnswer) {
        self.question = question
        self.answer = answer
    }
}

public struct QuestionAnswer: Hashable, Sendable {
    public var header: String
    public var question: String
    /// The options chosen, by label, in the order the answer gave them.
    public var chosen: [String]
    /// What the person wrote instead of (or beside) an option, as written.
    public var written: String?
    /// The person's note on their choice, when they added one.
    public var notes: String?
    /// The question asked for a secret, whose answer is not drawn.
    public var secret: Bool

    public init(header: String, question: String, chosen: [String], written: String?, notes: String?, secret: Bool) {
        self.header = header
        self.question = question
        self.chosen = chosen
        self.written = written
        self.notes = notes
        self.secret = secret
    }
}

/// An answer as a question's options read it: what names an option is
/// chosen, and anything else is what the person wrote.
public func answerTo(_ question: Question, given: [String], notes: String?, secret: Bool) -> QuestionAnswer {
    let labels = Set(question.options.map(\.label))
    let written = given.filter { !labels.contains($0) && $0 != "" }
    return QuestionAnswer(
        header: question.header,
        question: question.text,
        chosen: secret ? [] : given.filter { labels.contains($0) },
        written: secret || written.isEmpty ? nil : written.joined(separator: "\n"),
        notes: secret ? nil : notes,
        secret: secret)
}

/// A command the CLI ran itself rather than the model — a slash command
/// (`/model sonnet`), a shell-mode line (`! ls`) — and what it printed.
public struct CommandEntry: Hashable, Sendable {
    public var id: EntryId
    /// As typed: `/model sonnet`, `! ls`. Absent when only its output was recorded.
    public var line: String?
    /// What it printed, once it has.
    public var output: String?
    /// It printed an error.
    public var failed: Bool

    public init(id: EntryId, line: String?, output: String?, failed: Bool) {
        self.id = id
        self.line = line
        self.output = output
        self.failed = failed
    }
}

public struct AssistantEntry: Hashable, Sendable {
    public var id: EntryId
    public var parent: EntryId?
    public var blocks: [AssistantBlock]
    /// Deltas land only while this is true.
    public var streaming: Bool

    public init(id: EntryId, parent: EntryId? = nil, blocks: [AssistantBlock], streaming: Bool) {
        self.id = id
        self.parent = parent
        self.blocks = blocks
        self.streaming = streaming
    }
}

public enum ToolStatus: String, Hashable, Sendable, CaseIterable {
    case running, succeeded, failed, denied, interrupted
}

public struct ToolEntry: Hashable, Sendable {
    public var id: EntryId
    public var parent: EntryId?
    public var tool: String
    /// The Agent's own words for the call: `Bash: npm test`, `Edit: src/x.ts`.
    public var title: String
    public var input: JsonValue
    public var status: ToolStatus
    public var output: ToolOutput?
    /// Set on a call that starts a subagent; that subagent's entries name this one as their parent.
    public var spawns: SubagentInfo?
    /// Set on a call that started a background task other than a subagent (a
    /// command run in the background): how that task stands.
    public var background: BackgroundTask?
    /// The call asked to run outside the CLI's sandbox (Claude's Bash with
    /// `dangerouslyDisableSandbox`). Drawn quietly: it is an everyday thing.
    public var outsideSandbox: Bool
    /// The plan the call set (Claude's TodoWrite), whole, as it stands after it.
    public var plan: [PlanStep]?
    /// The change the call makes to files (Claude's Edit, MultiEdit and Write;
    /// Codex's file changes), as unified diffs.
    public var change: [FileDiff]?
    /// The questions the call asked the person (Claude's AskUserQuestion),
    /// each with the answer it was given, once it has one.
    public var asked: [AskedQuestion]?
    /// The call was refused by the CLI's own permission check (a rule, auto
    /// mode's classifier), not by the person: who refused it and why.
    public var denial: Denial?

    public init(
        id: EntryId, parent: EntryId? = nil, tool: String, title: String, input: JsonValue,
        status: ToolStatus, output: ToolOutput? = nil, spawns: SubagentInfo? = nil,
        background: BackgroundTask? = nil, outsideSandbox: Bool = false, plan: [PlanStep]? = nil,
        change: [FileDiff]? = nil, asked: [AskedQuestion]? = nil, denial: Denial? = nil
    ) {
        self.id = id
        self.parent = parent
        self.tool = tool
        self.title = title
        self.input = input
        self.status = status
        self.output = output
        self.spawns = spawns
        self.background = background
        self.outsideSandbox = outsideSandbox
        self.plan = plan
        self.change = change
        self.asked = asked
        self.denial = denial
    }
}

public struct Denial: Hashable, Sendable {
    /// In a line: `Denied by auto mode: Modify Shared Resources`.
    public var summary: String
    /// The CLI's whole account of it, when it gave one.
    public var detail: String?

    public init(summary: String, detail: String?) {
        self.summary = summary
        self.detail = detail
    }
}

/// How the work a call stands for is going. A call that returned once it had
/// set something going apart from the turn — a command in the background, a
/// subagent in the background or as a teammate — stands for that work, so it
/// is running while the work runs and ends as the work ends; any other call is
/// its own status. A call that failed, was denied or was interrupted is that,
/// whatever it started.
public enum WorkState: String, Hashable, Sendable {
    case running, succeeded, failed, denied, interrupted, idle, unknown

    init(_ status: ToolStatus) { self = WorkState(rawValue: status.rawValue)! }
}

public func workState(_ entry: ToolEntry) -> WorkState {
    guard let started = entry.background?.state ?? entry.spawns?.state,
          entry.status == .running || entry.status == .succeeded
    else { return WorkState(entry.status) }
    switch started {
    case .running: return .running
    case .idle: return .idle
    case .completed: return .succeeded
    case .failed: return .failed
    case .unknown: return .unknown
    }
}

public struct BackgroundTask: Hashable, Sendable {
    public var state: SubagentState
    /// The CLI's one line about how it ended, once it has.
    public var summary: String?

    public init(state: SubagentState, summary: String?) {
        self.state = state
        self.summary = summary
    }
}

/// Something the Agent set going that runs on its own, apart from its turn:
/// a command run in the background, a subagent started in the background, a
/// teammate at work, a watcher. It stays in `Transcript.backgroundTasks`
/// while it works and leaves when it ends (or, for a subagent that can be
/// told something again, when it goes idle).
public struct RunningTask: Hashable, Sendable {
    /// The CLI's own name for the task; unique among those running.
    public var id: String
    /// What kind of task it is, in a word: `shell`, `subagent`, or the CLI's
    /// own name for a kind DevHub has no word for.
    public var kind: String
    /// The CLI's words for it: the command's description, the subagent's errand.
    public var title: String
    /// The call that started it, once the CLI has said which.
    public var call: EntryId?
    /// When it started, in ms since the epoch, by the CLI's own clock.
    public var startedAt: Double?
    /// Whether DevHub can ask the CLI to stop it (the `stop-task` command),
    /// or, when it cannot, why not, in words for the person.
    public var stoppable: Stoppable

    public init(id: String, kind: String, title: String, call: EntryId?, startedAt: Double?, stoppable: Stoppable) {
        self.id = id
        self.kind = kind
        self.title = title
        self.call = call
        self.startedAt = startedAt
        self.stoppable = stoppable
    }
}

public enum Stoppable: Hashable, Sendable {
    case yes
    case no(reason: String)

    public var isStoppable: Bool { self == .yes }
}

public enum NoticeLevel: String, Hashable, Sendable {
    case info, warning, error
}

public struct NoticeEntry: Hashable, Sendable {
    public var id: EntryId
    public var parent: EntryId?
    public var level: NoticeLevel
    public var text: String
    /// The event as the CLI printed it, when the notice is about an event.
    public var raw: JsonValue?

    public init(id: EntryId, parent: EntryId? = nil, level: NoticeLevel, text: String, raw: JsonValue? = nil) {
        self.id = id
        self.parent = parent
        self.level = level
        self.text = text
        self.raw = raw
    }
}

/// The CLI compacted the conversation here: what came before is, to the
/// model, a summary of it from now on.
public struct CompactionEntry: Hashable, Sendable {
    public var id: EntryId
    /// A subagent's own context can be compacted too (Codex).
    public var parent: EntryId?
    /// `manual` (the person asked) or `auto`, as the CLI says.
    public var trigger: String?
    /// How many tokens the conversation held before.
    public var preTokens: Double?
    /// How many it holds after, when the CLI says.
    public var postTokens: Double?

    public init(id: EntryId, parent: EntryId? = nil, trigger: String?, preTokens: Double?, postTokens: Double?) {
        self.id = id
        self.parent = parent
        self.trigger = trigger
        self.preTokens = preTokens
        self.postTokens = postTokens
    }
}

public enum TurnOutcome: String, Hashable, Sendable {
    case completed, interrupted, failed
}

public struct TurnEndEntry: Hashable, Sendable {
    public var id: EntryId
    public var outcome: TurnOutcome
    public var detail: String?
    public var usage: Usage?
    public var durationMs: Double?
    /// The turn ended because a usage or rate limit of the CLI's plan stopped
    /// it, by the CLI's own documented signals. Set only on a turn that did
    /// not complete.
    public var limit: LimitStop?

    public init(
        id: EntryId, outcome: TurnOutcome, detail: String? = nil, usage: Usage? = nil,
        durationMs: Double? = nil, limit: LimitStop? = nil
    ) {
        self.id = id
        self.outcome = outcome
        self.detail = detail
        self.usage = usage
        self.durationMs = durationMs
        self.limit = limit
    }
}

/// What stopped a turn at a usage limit.
public struct LimitStop: Hashable, Sendable {
    /// When the window that stopped it resets, in epoch ms, as the CLI
    /// reported it; nil while it has not said.
    public var resetsAt: Double?

    public init(resetsAt: Double?) { self.resetsAt = resetsAt }
}

/// The reset of the window a usage limit stopped the CLI at, from the windows
/// it reports: one that is used up (100%). With more than one, the latest
/// reset, since the CLI cannot go on before every one of them has reset.
public func usedUpReset(_ windows: [RateLimit]?) -> Double? {
    var latest: Double?
    for window in windows ?? [] {
        guard (window.usedPercent ?? 0) >= 100, let resetsAt = window.resetsAt else { continue }
        if latest == nil || resetsAt > latest! { latest = resetsAt }
    }
    return latest
}

public enum AssistantBlock: Hashable, Sendable {
    case text(markdown: String)
    case thinking(text: String)
    case plan(steps: [PlanStep])
}

public enum PlanStatus: String, Hashable, Sendable {
    case pending
    case inProgress = "in_progress"
    case completed
}

public struct PlanStep: Hashable, Sendable {
    public var text: String
    public var status: PlanStatus

    public init(text: String, status: PlanStatus) {
        self.text = text
        self.status = status
    }
}

/// What a tool call gave back: its parts in the order the tool gave them.
public typealias ToolOutput = [ToolOutputPart]

public enum ToolOutputPart: Hashable, Sendable {
    case text(String)
    case image(ImageRef)
    /// A tool the call made available (a tool search's find), by name.
    case reference(name: String)
    /// `exitCode` is nil when the CLI did not say; never assumed to be 0.
    /// `output` is stdout alone when `stderr` is apart, else both.
    case command(exitCode: Double?, output: String, stderr: String?, interrupted: Bool)
    /// Output too large for the conversation, which the CLI saved to a file
    /// and gave the model only the start of. `note` is the CLI's own sentence
    /// about it.
    case persisted(note: String, path: String?, preview: String)
}

public struct FileDiff: Hashable, Sendable {
    public var path: String
    public var unifiedDiff: String

    public init(path: String, unifiedDiff: String) {
        self.path = path
        self.unifiedDiff = unifiedDiff
    }
}

/// `idle`: alive and waiting to be told something (a Claude teammate between
/// tasks). `unknown`: nothing says how it stands, which is what a subagent
/// whose CLI has ended is unless its end was recorded.
public enum SubagentState: String, Hashable, Sendable {
    case running, idle, completed, failed, unknown
}

public struct SubagentInfo: Hashable, Sendable {
    public var label: String
    public var prompt: String
    public var model: String?
    public var state: SubagentState
    /// Whether the person can say something to this subagent directly.
    public var takesMessages: Bool

    public init(label: String, prompt: String, model: String?, state: SubagentState, takesMessages: Bool) {
        self.label = label
        self.prompt = prompt
        self.model = model
        self.state = state
        self.takesMessages = takesMessages
    }
}

// MARK: - Requests

public struct PendingRequest: Hashable, Sendable {
    public var id: RequestId
    /// The tool call the request is about, when it is about one.
    public var entry: EntryId?
    public var subject: RequestSubject
    /// What can be answered is the adapter's to decide; the view lays these out and presses one.
    public var choices: [RequestChoice]

    public init(id: RequestId, entry: EntryId?, subject: RequestSubject, choices: [RequestChoice]) {
        self.id = id
        self.entry = entry
        self.subject = subject
        self.choices = choices
    }
}

public enum RequestSubject: Hashable, Sendable {
    case tool(tool: String, title: String, input: JsonValue, reason: String?)
    case command(command: String, cwd: String, reason: String?)
    case fileChange(files: [FileDiff])
    case question(questions: [Question])
    /// An MCP server asking the person something through the Agent. It is
    /// always answered by accepting its form — no fields at all for a plain
    /// confirmation, or for a page to visit (`url`) — or by the adapter's
    /// other choices.
    case elicitation(server: String, message: String, url: String?, fields: [FormField])
}

/// One question of an AskUserQuestion / requestUserInput.
public struct Question: Hashable, Sendable {
    /// The key its answer is filed under in `RequestAnswer.answers`.
    public var id: String
    public var header: String
    public var text: String
    public var options: [QuestionOption]
    public var multiSelect: Bool
    /// Whether a free-text "Other" answer is accepted.
    public var allowsOther: Bool

    public init(id: String, header: String, text: String, options: [QuestionOption], multiSelect: Bool, allowsOther: Bool) {
        self.id = id
        self.header = header
        self.text = text
        self.options = options
        self.multiSelect = multiSelect
        self.allowsOther = allowsOther
    }
}

public struct QuestionOption: Hashable, Sendable {
    public var label: String
    public var description: String
    /// What choosing it would look like — a mockup, a snippet — as Markdown.
    public var preview: String?

    public init(label: String, description: String, preview: String? = nil) {
        self.label = label
        self.description = description
        self.preview = preview
    }
}

public enum ChoiceTone: String, Hashable, Sendable {
    case allow, deny, neutral
}

public struct RequestChoice: Hashable, Sendable {
    /// The adapter's key for building the answer.
    public var id: String
    public var label: String
    public var tone: ChoiceTone
    /// Whether choosing it opens a text field (a reason, a further instruction).
    public var takesText: Bool

    public init(id: String, label: String, tone: ChoiceTone, takesText: Bool) {
        self.id = id
        self.label = label
        self.tone = tone
        self.takesText = takesText
    }
}

/// One answer value: a single string, or several (a multi-select).
public enum AnswerValue: Hashable, Sendable {
    case one(String)
    case many([String])

    public var asList: [String] {
        switch self {
        case .one(let value): return [value]
        case .many(let values): return values
        }
    }
}

public enum RequestAnswer: Hashable, Sendable {
    case choice(choiceId: String, text: String?)
    /// `values` by question id; `notes` a note per question, by the same key:
    /// who answered, when it was not the person at the card.
    case answers(values: [(String, AnswerValue)], notes: [String: String]?)

    public static func == (lhs: RequestAnswer, rhs: RequestAnswer) -> Bool {
        switch (lhs, rhs) {
        case let (.choice(a, b), .choice(c, d)): return a == c && b == d
        case let (.answers(a, b), .answers(c, d)):
            return Dictionary(a, uniquingKeysWith: { $1 }) == Dictionary(c, uniquingKeysWith: { $1 }) && b == d
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case let .choice(id, text):
            hasher.combine(0)
            hasher.combine(id)
            hasher.combine(text)
        case let .answers(values, notes):
            hasher.combine(1)
            hasher.combine(Dictionary(values, uniquingKeysWith: { $1 }))
            hasher.combine(notes)
        }
    }
}

// MARK: - Session

public struct SessionFacts: Hashable, Sendable {
    public var agentVersion: String?
    /// Claude's session_id / Codex's threadId: what "continue in terminal" resumes.
    public var sessionId: String?
    public var cwd: String?
    public var model: Setting
    public var effort: Setting
    public var mode: Setting
    /// The Agent's own slash commands.
    public var commands: [SlashCommand]
    /// Whether this session can take turns back, so the conversation can be
    /// rewound to before one of the person's messages (`rewindTargets`).
    public var canRewind: Bool

    public init(
        agentVersion: String? = nil, sessionId: String? = nil, cwd: String? = nil,
        model: Setting = .none, effort: Setting = .none, mode: Setting = .none,
        commands: [SlashCommand] = [], canRewind: Bool = false
    ) {
        self.agentVersion = agentVersion
        self.sessionId = sessionId
        self.cwd = cwd
        self.model = model
        self.effort = effort
        self.mode = mode
        self.commands = commands
        self.canRewind = canRewind
    }
}

public struct SettingChoice: Hashable, Sendable {
    public var id: String
    public var label: String
    public var detail: String?
    /// A model choice's full model name, as a session reports its model.
    public var resolved: String?
    /// The choice the CLI itself starts a new session on when its settings
    /// name none: the model Codex's `model/list` marks as its default, and
    /// that model's default effort. Claude lists its own as the choice
    /// `default` instead.
    public var builtInDefault: Bool

    public init(
        id: String, label: String, detail: String? = nil, resolved: String? = nil, builtInDefault: Bool = false
    ) {
        self.id = id
        self.label = label
        self.detail = detail
        self.resolved = resolved
        self.builtInDefault = builtInDefault
    }
}

public struct Setting: Hashable, Sendable {
    public var current: String?
    /// What can be chosen: `label` is how a choice reads, in the list and as
    /// the current value alike; `detail` is the Agent's own words for it.
    public var choices: [SettingChoice]
    /// Why the setting can't be changed here, when the Agent listed nothing to
    /// choose from for it.
    public var unchangeable: String?

    public init(current: String?, choices: [SettingChoice], unchangeable: String? = nil) {
        self.current = current
        self.choices = choices
        self.unchangeable = unchangeable
    }

    public static let none = Setting(current: nil, choices: [])
}

public enum SlashTrigger: String, Hashable, Sendable {
    case slash = "/"
    case dollar = "$"
}

/// How the composer carries a slash command out.
public enum SlashRoute: String, Hashable, Sendable {
    case message, resume, restart, mcp, model, effort, mode
}

public struct SlashCommand: Hashable, Sendable {
    /// The character the composer offers it after: `/` for a command (only as
    /// the message's first word), `$` for a Codex skill, mentioned anywhere.
    public var trigger: SlashTrigger
    public var name: String
    public var description: String
    public var argumentHint: String?
    /// `message`: sent as the text of a user message. `resume`: DevHub's
    /// picker of earlier sessions. `restart`: DevHub's Restart session. `mcp`:
    /// DevHub's MCP panel. Otherwise the header picker for that setting.
    public var route: SlashRoute

    public init(trigger: SlashTrigger, name: String, description: String, argumentHint: String?, route: SlashRoute) {
        self.trigger = trigger
        self.name = name
        self.description = description
        self.argumentHint = argumentHint
        self.route = route
    }
}

// MARK: - MCP

/// How an MCP server stands, in one vocabulary for both CLIs. `unknown` is a
/// word of the CLI's DevHub does not know (`McpServer.said` has it).
public enum McpServerStatus: String, Hashable, Sendable {
    case connected
    case needsSignIn = "needs-sign-in"
    case failed, connecting, disabled, unknown
}

/// What can be done about one MCP server from the panel.
public enum McpAction: String, Hashable, Sendable {
    case reconnect, enable, disable
    case signIn = "sign-in"
}

public struct McpServer: Hashable, Sendable {
    public var name: String
    public var status: McpServerStatus
    /// The CLI's own word for the status (`needs-auth`, `authenticationRequired`).
    public var said: String
    /// Why it failed, when the CLI says.
    public var error: String?
    /// Where it is configured, in the CLI's words; nil when the CLI does not say.
    public var source: String?
    /// The actions the adapter offers for it now, in the order they are drawn.
    public var actions: [McpAction]

    public init(name: String, status: McpServerStatus, said: String, error: String?, source: String?, actions: [McpAction]) {
        self.name = name
        self.status = status
        self.said = said
        self.error = error
        self.source = source
        self.actions = actions
    }
}

public struct PluginError: Hashable, Sendable {
    public var plugin: String
    public var message: String

    public init(plugin: String, message: String) {
        self.plugin = plugin
        self.message = message
    }
}

public struct McpWork: Hashable, Sendable {
    public var server: String
    /// Never `sign-in`.
    public var action: McpAction

    public init(server: String, action: McpAction) {
        self.server = server
        self.action = action
    }
}

/// The Agent's MCP servers as its CLI last reported them, and DevHub's
/// requests about them. The adapter's, replaced whole (`mcp` events).
public struct McpState: Hashable, Sendable {
    /// Nil until the CLI has said which servers it has.
    public var servers: [McpServer]?
    /// Plugins the CLI said did not load, and why.
    public var pluginErrors: [PluginError]
    /// The person's MCP requests the CLI has not answered yet.
    public var working: [McpWork]
    /// The last of the person's MCP requests the CLI refused, in its words.
    public var failure: String?

    public init(servers: [McpServer]?, pluginErrors: [PluginError], working: [McpWork], failure: String?) {
        self.servers = servers
        self.pluginErrors = pluginErrors
        self.working = working
        self.failure = failure
    }

    public static let none = McpState(servers: nil, pluginErrors: [], working: [], failure: nil)
}

public enum McpSignInPhase: String, Hashable, Sendable {
    case running, succeeded, failed
}

public enum McpCallback: Hashable, Sendable {
    case forwarded(port: Int, to: String)
    case unforwarded(port: Int, why: String)
}

/// An MCP sign-in DevHub is running for the Agent, or ran last: the CLI's own
/// `mcp login <server>` on the Agent's machine. DevHub's own, like `pending`.
public struct McpSignIn: Hashable, Sendable {
    public var server: String
    public var phase: McpSignInPhase
    /// What the command printed so far, as text (terminal escapes taken out).
    public var output: String
    /// The browser's way back to the command, when it needed one made.
    public var callback: McpCallback?
    /// Why it failed, when it did.
    public var failure: String?

    public init(server: String, phase: McpSignInPhase, output: String, callback: McpCallback?, failure: String?) {
        self.server = server
        self.phase = phase
        self.output = output
        self.callback = callback
        self.failure = failure
    }
}

// MARK: - Usage

/// Tokens and money, as far as the CLI reports them. Every field is optional
/// because neither CLI reports all of them; an absent field is "not
/// reported", never zero.
public struct Usage: Hashable, Sendable {
    public var inputTokens: Double?
    public var outputTokens: Double?
    public var cachedInputTokens: Double?
    /// How much of the context window the conversation fills now.
    public var contextTokens: Double?
    public var contextWindow: Double?
    public var costUsd: Double?
    /// Every rate-limit window the CLI has reported, each as last reported.
    public var rateLimits: [RateLimit]?
    /// The main conversation's prompt cache, as DevHub works it out.
    public var promptCache: PromptCache?

    public init(
        inputTokens: Double? = nil, outputTokens: Double? = nil, cachedInputTokens: Double? = nil,
        contextTokens: Double? = nil, contextWindow: Double? = nil, costUsd: Double? = nil,
        rateLimits: [RateLimit]? = nil, promptCache: PromptCache? = nil
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cachedInputTokens = cachedInputTokens
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.costUsd = costUsd
        self.rateLimits = rateLimits
        self.promptCache = promptCache
    }
}

/// A conversation's prompt cache: when it goes cold and how well it is used.
///
/// Claude Code computes the same statistics for its status line
/// (`prompt_cache`), but a status line never runs in the `-p` stream-json mode
/// DevHub drives, so DevHub derives them itself from each main-conversation
/// response's `usage` (`Claude/PromptCache.swift`).
public struct PromptCache: Hashable, Sendable {
    /// How long the cached prefix lives after it was last read or written.
    public var ttlSeconds: Double
    /// Whether the TTL was read off the response rather than assumed.
    public var ttlKnown: Bool
    /// When the cached prefix goes cold, in ms since the epoch; nil when the
    /// last response reported no cache tokens at all.
    public var expiresAt: Double?
    /// Cache reads over all input tokens this session, 0..1.
    public var hitRatio: Double?
    public var requests: Int
    /// Requests that re-processed a prefix the cache should still have held.
    public var misses: Int
    /// Tokens the next request writes again if the cache is cold by then.
    public var recacheTokens: Double?
    /// When DevHub will compact the idle conversation before the cache goes
    /// cold; nil when it will not. The coordinator's, never the adapter's.
    public var autoCompactAt: Double?

    public init(
        ttlSeconds: Double, ttlKnown: Bool, expiresAt: Double?, hitRatio: Double?, requests: Int,
        misses: Int, recacheTokens: Double?, autoCompactAt: Double? = nil
    ) {
        self.ttlSeconds = ttlSeconds
        self.ttlKnown = ttlKnown
        self.expiresAt = expiresAt
        self.hitRatio = hitRatio
        self.requests = requests
        self.misses = misses
        self.recacheTokens = recacheTokens
        self.autoCompactAt = autoCompactAt
    }
}

public struct RateLimit: Hashable, Sendable {
    /// Which window, in words: `5-hour`, `7-day`, or the CLI's own name for it.
    public var window: String
    /// How long the window is, in minutes, as the CLI says; nil when it does not.
    public var durationMinutes: Double?
    /// 0–100.
    public var usedPercent: Double?
    /// Epoch milliseconds.
    public var resetsAt: Double?

    public init(window: String, durationMinutes: Double?, usedPercent: Double?, resetsAt: Double?) {
        self.window = window
        self.durationMinutes = durationMinutes
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
    }
}

/// What a CLI's account said of its plan's limits when DevHub asked it.
public enum UsageReading: Hashable, Sendable {
    case windows([RateLimit])
    case noPlanLimits
}

/// A window's name from its length: `5-hour`, `7-day`, `90-minute`.
public func rateLimitWindowName(_ minutes: Double) -> String {
    let m = JsonValue.javaScriptNumber
    if minutes.truncatingRemainder(dividingBy: 1440) == 0 { return "\(m(minutes / 1440))-day" }
    if minutes.truncatingRemainder(dividingBy: 60) == 0 { return "\(m(minutes / 60))-hour" }
    return "\(m(minutes))-minute"
}

/// The windows known after a report: each window the report names replaces
/// the one of the same name, and a window it does not name stays as last
/// seen — a report that leaves a window out has not said it cleared.
public func withRateLimits(_ known: [RateLimit]?, _ reported: [RateLimit]) -> [RateLimit] {
    var result = known ?? []
    for one in reported {
        if let at = result.firstIndex(where: { $0.window == one.window }) {
            result[at] = one
        } else {
            result.append(one)
        }
    }
    return result
}

// MARK: - State

public enum ConversationFailureCode: String, Hashable, Sendable {
    /// A known event did not have the shape its decoder expects, or a line was not JSON.
    case protocolMismatch = "protocol_mismatch"
    /// The CLI is not signed in.
    case notSignedIn = "not_signed_in"
    /// The CLI refused to start (bad arguments and the like).
    case refused
}

public struct ConversationFailure: Hashable, Sendable {
    public var code: ConversationFailureCode
    /// The failing side's own words: the decoder path and CLI version, the CLI's stderr.
    public var detail: String

    public init(code: ConversationFailureCode, detail: String) {
        self.code = code
        self.detail = detail
    }
}

public enum TurnState: String, Hashable, Sendable {
    case none, running, rewinding
}

public enum ConversationState: Hashable, Sendable {
    /// Attaching to the host, handshaking, or replaying the journal.
    case connecting
    /// `rewinding`: turns are being taken back (the person rewound the
    /// conversation). It takes no input until the CLI says it is done.
    case ready(turn: TurnState)
    /// Takes no more input. The Transcript up to here stays readable.
    case broken(ConversationFailure)

    public var phase: String {
        switch self {
        case .connecting: return "connecting"
        case .ready: return "ready"
        case .broken: return "broken"
        }
    }

    /// The turn, when ready.
    public var turn: TurnState? {
        if case .ready(let turn) = self { return turn }
        return nil
    }
}

/// DevHub going on with a conversation a usage limit stopped, once the limit
/// has reset: by writing a fixed message for the person, at `at`.
/// `unscheduled` is a limit whose reset the CLI did not say, so nothing is
/// written; `failed` is a write that did not happen, and why.
public enum LimitResume: Hashable, Sendable {
    case scheduled(at: Double)
    case unscheduled(reason: String)
    case failed(failure: String)
}

/// What a GUI Agent is told, for the person, once a usage limit it stopped at has reset.
public let DEFAULT_RESUME_MESSAGE = "続けて"

/// Whether `text` cannot be the message written after a usage limit: empty, or with a null character.
public func resumeMessageProblem(_ text: String) -> Bool {
    text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.contains("\0")
}

public struct SendingMessage: Hashable, Sendable {
    /// Unique among the messages sending; not the entry id the echo will have.
    public var id: String
    public var text: String
    public var images: [ImageRef]
    public var origin: SentOrigin

    public init(id: String, text: String, images: [ImageRef], origin: SentOrigin) {
        self.id = id
        self.text = text
        self.images = images
        self.origin = origin
    }
}

/// A message the person sent that DevHub has not written to the CLI yet. It
/// is written when the turn running ends, or at once if the person says so
/// (which a running turn takes in as it goes). Until then it can be changed
/// or taken back.
public struct PendingMessage: Hashable, Sendable {
    public var id: PendingId
    public var text: String
    /// The images attached to it, sent with its words.
    public var images: [ImageRef]
    /// Why the last try to write it failed, if it did.
    public var failure: String?
    /// The person has it open to change it: it is not written until they save
    /// the change or give it up, or the view that had it open goes away.
    public var editing: Bool

    public init(id: PendingId, text: String, images: [ImageRef], failure: String?, editing: Bool) {
        self.id = id
        self.text = text
        self.images = images
        self.failure = failure
        self.editing = editing
    }
}

public struct Transcript: Hashable, Sendable {
    /// Display order. Subagent entries are here too; `parent` makes the tree.
    public var entries: [TranscriptEntry]
    /// Unanswered requests only.
    public var requests: [PendingRequest]
    public var session: SessionFacts
    public var state: ConversationState
    public var usage: Usage?
    /// The person's messages DevHub holds because the Agent could not take
    /// them when they were sent, oldest first.
    public var pending: [PendingMessage]
    /// The messages written to the CLI that it has not taken yet (not echoed
    /// back), oldest first. The adapter's, from what was written (`in.log`).
    public var sending: [SendingMessage]
    /// What the Agent set going that is still working apart from its turn,
    /// oldest first. The adapter's.
    public var backgroundTasks: [RunningTask]
    /// The Agent's MCP servers (the adapter's).
    public var mcp: McpState
    /// The MCP sign-in running or run last (DevHub's).
    public var mcpSignIn: McpSignIn?
    /// What DevHub will do about the usage limit the last turn stopped at,
    /// while that turn's end is the last thing in the conversation.
    public var limitResume: LimitResume?
    /// The CLI is compacting the conversation now, as part of the turn
    /// running. Only ever true while a turn runs.
    public var compacting: Bool

    public init(
        entries: [TranscriptEntry] = [], requests: [PendingRequest] = [], session: SessionFacts = SessionFacts(),
        state: ConversationState = .connecting, usage: Usage? = nil, pending: [PendingMessage] = [],
        sending: [SendingMessage] = [], backgroundTasks: [RunningTask] = [], mcp: McpState = .none,
        mcpSignIn: McpSignIn? = nil, limitResume: LimitResume? = nil, compacting: Bool = false
    ) {
        self.entries = entries
        self.requests = requests
        self.session = session
        self.state = state
        self.usage = usage
        self.pending = pending
        self.sending = sending
        self.backgroundTasks = backgroundTasks
        self.mcp = mcp
        self.mcpSignIn = mcpSignIn
        self.limitResume = limitResume
        self.compacting = compacting
    }

    /// The Transcript before the first event: nothing said, still connecting.
    public static let empty = Transcript()
}

public let EMPTY_SESSION = SessionFacts()
public let EMPTY_TRANSCRIPT = Transcript.empty

// MARK: - Events

public enum ConversationEvent: Hashable, Sendable {
    /// Adds the entry, or replaces the entry with the same id whole, in place.
    case entry(TranscriptEntry)
    /// Appends to one text or thinking block of a streaming assistant entry.
    case textDelta(entry: EntryId, block: Int, text: String)
    case requestOpened(PendingRequest)
    case requestClosed(RequestId)
    /// Replaces the session facts whole.
    case session(SessionFacts)
    case state(ConversationState)
    /// Replaces the conversation's usage whole.
    case usage(Usage)
    /// Replaces the messages DevHub holds whole. DevHub's own, not an adapter's.
    case pending([PendingMessage])
    /// Replaces the messages written and not yet taken whole. The adapter's.
    case sending([SendingMessage])
    /// Replaces the tasks working in the background whole. The adapter's.
    case backgroundTasks([RunningTask])
    /// Replaces the MCP servers' state whole. The adapter's.
    case mcp(McpState)
    /// Replaces the MCP sign-in whole. DevHub's own, not an adapter's.
    case mcpSignIn(McpSignIn?)
    /// Replaces what DevHub will do about a usage limit whole. DevHub's own.
    case limitResume(LimitResume?)
    /// Whether the CLI is compacting the conversation now. The adapter's.
    case compacting(Bool)
    /// The CLI took back the turns from a message of the person's on: that
    /// message and every entry after it are no longer part of the conversation.
    case rewound(from: EntryId)
    /// The Agent went on with another session of its CLI (`/resume`): every
    /// entry, and the usage, belonged to the one it left.
    case sessionSwitched(session: String)
    /// The CLI was stopped and started again on the same session (Restart
    /// session): the entries stay, and nothing the CLI that was stopped had
    /// going goes on.
    case restarted

    /// The event's `type`, in the TS model's words.
    public var type: String {
        switch self {
        case .entry: return "entry"
        case .textDelta: return "text-delta"
        case .requestOpened: return "request-opened"
        case .requestClosed: return "request-closed"
        case .session: return "session"
        case .state: return "state"
        case .usage: return "usage"
        case .pending: return "pending"
        case .sending: return "sending"
        case .backgroundTasks: return "background-tasks"
        case .mcp: return "mcp"
        case .mcpSignIn: return "mcp-sign-in"
        case .limitResume: return "limit-resume"
        case .compacting: return "compacting"
        case .rewound: return "rewound"
        case .sessionSwitched: return "session-switched"
        case .restarted: return "restarted"
        }
    }
}

/// An event that cannot be true of the Transcript it was applied to. It is
/// the adapter's bookkeeping that broke, never the CLI's output, so nothing
/// recovers from it in place.
public struct TranscriptInvariantError: Error, CustomStringConvertible, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// How a rewind ended: the conversation was taken back to before the
/// message, or the CLI would not take it back — the conversation has a
/// notice saying why, and nothing was dropped.
public enum RewindOutcome: String, Hashable, Sendable {
    case rewound, refused
}

/// An Agent's status as its conversation says it; the same words as the
/// model's `AgentStatus` (`model/domain.ts` `AGENT_STATUSES`).
public enum ConversationAgentStatus: String, Hashable, Sendable {
    case unknown, idle, working, waiting, background, error
}
