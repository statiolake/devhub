// Port of apps/desktop/src/model/conversation.ts (the fold and the readings).

import Foundation

extension Transcript {
    /// The one fold. Returns a new Transcript; this one is not touched.
    public func applying(_ event: ConversationEvent) throws -> Transcript {
        try applyEvent(self, event)
    }
}

/// The one fold. Returns a new Transcript; the one passed in is not touched.
public func applyEvent(_ transcript: Transcript, _ event: ConversationEvent) throws -> Transcript {
    var next = transcript
    switch event {
    case .entry(let entry):
        next.entries = try putEntry(transcript.entries, entry)
    case .textDelta(let entry, let block, let text):
        next.entries = try appendDelta(transcript.entries, entry, block, text)
    case .requestOpened(let request):
        next.requests = try openRequest(transcript, request)
    case .requestClosed(let request):
        next.requests = try closeRequest(transcript.requests, request)
    case .session(let session):
        next.session = session
    case .state(let state):
        next.state = state
        // A compaction is part of a turn: no turn running, none going on.
        next.compacting = state == .ready(turn: .running) ? transcript.compacting : false
    case .usage(let usage):
        next.usage = usage
    case .pending(let pending):
        next.pending = pending
    case .sending(let sending):
        next.sending = sending
    case .backgroundTasks(let tasks):
        next.backgroundTasks = try backgroundTasks(transcript, tasks)
    case .mcp(let mcp):
        next.mcp = mcp
    case .mcpSignIn(let signIn):
        next.mcpSignIn = signIn
    case .limitResume(let resume):
        next.limitResume = resume
    case .compacting(let compacting):
        if compacting, transcript.state != .ready(turn: .running) {
            throw TranscriptInvariantError("a compaction started while no turn is running")
        }
        next.compacting = compacting
    case .rewound(let from):
        next.entries = try rewind(transcript, from)
    case .sessionSwitched(let session):
        if let open = transcript.requests.first {
            throw TranscriptInvariantError("a switch to session \(session) while request \(open.id) is open")
        }
        if let running = transcript.backgroundTasks.first {
            throw TranscriptInvariantError(
                "a switch to session \(session) while background task \(running.id) is running")
        }
        next.entries = []
        next.usage = nil
        next.session.sessionId = session
    case .restarted:
        next.entries = transcript.entries.map(withProcessEnded)
        next.requests = []
        next.sending = []
        next.backgroundTasks = []
        next.compacting = false
    }
    return next
}

/// `applyEvent` over a sequence, in order: a replayed journal, a batch off the wire.
public func applyEvents<S: Sequence>(_ transcript: Transcript, _ events: S) throws -> Transcript
where S.Element == ConversationEvent {
    var folded = transcript
    for event in events { folded = try applyEvent(folded, event) }
    return folded
}

/// Searched from the end: the entries events touch — the one streaming, the
/// tool running — are almost always the last few.
func indexOfEntry(_ entries: [TranscriptEntry], _ id: EntryId) -> Int? {
    var index = entries.count - 1
    while index >= 0 {
        if entries[index].id == id { return index }
        index -= 1
    }
    return nil
}

private func parentText(_ parent: EntryId?) -> String {
    parent.map(\.raw) ?? "null"
}

private func requireToolEntry(_ entries: [TranscriptEntry], _ id: EntryId, _ role: String) throws {
    guard let index = indexOfEntry(entries, id) else {
        throw TranscriptInvariantError("\(role) \(id) is not an entry")
    }
    let kind = entries[index].kind
    if kind != "tool" {
        throw TranscriptInvariantError("\(role) \(id) is a \(kind) entry, not a tool call")
    }
}

private func putEntry(_ entries: [TranscriptEntry], _ entry: TranscriptEntry) throws -> [TranscriptEntry] {
    guard let index = indexOfEntry(entries, entry.id) else {
        // A child arrives after the call that started it: the parent must
        // already be here, which is also what keeps the tree free of cycles.
        if let parent = entry.parent {
            try requireToolEntry(entries, parent, "parent of \(entry.id)")
        }
        return entries + [entry]
    }
    let previous = entries[index]
    if previous.kind != entry.kind {
        throw TranscriptInvariantError(
            "entry \(entry.id) was a \(previous.kind) and cannot become a \(entry.kind)")
    }
    if previous.parent != entry.parent {
        throw TranscriptInvariantError(
            "entry \(entry.id) cannot move from parent \(parentText(previous.parent)) to \(parentText(entry.parent))")
    }
    var copy = entries
    copy[index] = entry
    return copy
}

private func appendDelta(_ entries: [TranscriptEntry], _ id: EntryId, _ block: Int, _ text: String) throws
    -> [TranscriptEntry]
{
    guard let index = indexOfEntry(entries, id) else {
        throw TranscriptInvariantError("text delta for \(id), which is not an entry")
    }
    guard case .assistant(var entry) = entries[index] else {
        throw TranscriptInvariantError("text delta for \(id), which is a \(entries[index].kind) entry")
    }
    if !entry.streaming {
        throw TranscriptInvariantError("text delta for \(id), which is no longer streaming")
    }
    guard block >= 0, block < entry.blocks.count else {
        throw TranscriptInvariantError("text delta for block \(block) of \(id), which has \(entry.blocks.count)")
    }
    switch entry.blocks[block] {
    case .text(let markdown): entry.blocks[block] = .text(markdown: markdown + text)
    case .thinking(let thinking): entry.blocks[block] = .thinking(text: thinking + text)
    case .plan:
        throw TranscriptInvariantError("text delta for block \(block) of \(id), which is a plan")
    }
    var copy = entries
    copy[index] = .assistant(entry)
    return copy
}

private func openRequest(_ transcript: Transcript, _ request: PendingRequest) throws -> [PendingRequest] {
    if transcript.requests.contains(where: { $0.id == request.id }) {
        throw TranscriptInvariantError("request \(request.id) is already open")
    }
    if let entry = request.entry {
        try requireToolEntry(transcript.entries, entry, "subject of request \(request.id)")
    }
    return transcript.requests + [request]
}

/// `entry` once the CLI process that was running it has ended (it was
/// replaced, or the entry is read back from a session file): a call still
/// running was interrupted, a message still streaming ends where it got to,
/// and a subagent or background task it started cannot run now, though how
/// it ended nobody recorded. Anything else is as it was.
public func withProcessEnded(_ entry: TranscriptEntry) -> TranscriptEntry {
    switch entry {
    case .assistant(var assistant):
        if !assistant.streaming { return entry }
        assistant.streaming = false
        return .assistant(assistant)
    case .tool(var tool):
        if tool.status == .running { tool.status = .interrupted }
        if tool.spawns?.state == .running || tool.spawns?.state == .idle { tool.spawns?.state = .unknown }
        if tool.background?.state == .running { tool.background = BackgroundTask(state: .unknown, summary: nil) }
        return .tool(tool)
    default:
        return entry
    }
}

private func closeRequest(_ requests: [PendingRequest], _ id: RequestId) throws -> [PendingRequest] {
    let remaining = requests.filter { $0.id != id }
    if remaining.count == requests.count {
        throw TranscriptInvariantError("request \(id) is not open")
    }
    return remaining
}

private func backgroundTasks(_ transcript: Transcript, _ tasks: [RunningTask]) throws -> [RunningTask] {
    var seen = Set<String>()
    for task in tasks {
        if seen.contains(task.id) {
            throw TranscriptInvariantError("background task \(task.id) is listed twice")
        }
        seen.insert(task.id)
        if let call = task.call {
            try requireToolEntry(transcript.entries, call, "call of background task \(task.id)")
        }
    }
    return tasks
}

private func rewind(_ transcript: Transcript, _ from: EntryId) throws -> [TranscriptEntry] {
    if let open = transcript.requests.first {
        throw TranscriptInvariantError("a rewind to \(from) while request \(open.id) is open")
    }
    guard let index = indexOfEntry(transcript.entries, from) else {
        throw TranscriptInvariantError("a rewind to \(from), which is not an entry")
    }
    let entry = transcript.entries[index]
    guard case .user(let user) = entry, user.parent == nil else {
        throw TranscriptInvariantError(
            "a rewind to \(from): \(from) is a \(entry.kind) entry, not a message the person sent")
    }
    let kept = Array(transcript.entries[..<index])
    if let orphan = transcript.backgroundTasks.first(where: { task in
        task.call != nil && indexOfEntry(kept, task.call!) == nil
    }) {
        throw TranscriptInvariantError(
            "a rewind to \(from) takes back \(orphan.call!), which started background task \(orphan.id), still running")
    }
    return kept
}

// MARK: - Readings
//
// Pure derivations the reconcile round and the view both take from a
// Transcript, so neither works them out a second time.

/// Whether two lists of background tasks say the same, task for task.
public func sameRunningTasks(_ one: [RunningTask], _ other: [RunningTask]) -> Bool {
    one == other
}

/// The entries directly under `parent` (nil for the top level), in display order.
public func childrenOf(_ transcript: Transcript, _ parent: EntryId?) -> [TranscriptEntry] {
    transcript.entries.filter { $0.parent == parent }
}

/// The usage limit the conversation stands stopped at, if it does: its last
/// top-level entry is the end of a turn a limit stopped, and nothing has
/// happened since — no turn running, nothing written and not taken, nothing
/// held, no question open.
public func limitStop(_ transcript: Transcript) -> (entry: EntryId, resetsAt: Double?)? {
    guard transcript.state == .ready(turn: .none) else { return nil }
    if !transcript.requests.isEmpty || !transcript.pending.isEmpty || !transcript.sending.isEmpty { return nil }
    for entry in transcript.entries.reversed() {
        if entry.parent != nil { continue }
        if case .turnEnd(let end) = entry, let limit = end.limit {
            return (end.id, limit.resetsAt)
        }
        return nil
    }
    return nil
}

/// Whether the most recent turn ended in failure. False before any turn has ended.
public func lastTurnFailed(_ transcript: Transcript) -> Bool {
    for entry in transcript.entries.reversed() {
        if case .turnEnd(let end) = entry { return end.outcome == .failed }
    }
    return false
}

/// The Agent's status, read off its conversation. A failed turn stays `error`
/// until the next turn starts; a pending request is `waiting` even mid-turn,
/// because somebody has to answer it before the turn goes anywhere.
///
/// Working is the turn's alone: the adapter says a turn runs from the moment a
/// message is written to the CLI until the CLI's own end of the turn that
/// answers it, whatever the CLI printed or did not print in between. DevHub's
/// hold on the person's words counts too: one DevHub holds at the prompt waits
/// on the person (`waiting`).
///
/// With no turn running, what the Agent set going apart from its turn is
/// `background`: it is not idle, because stopping it stops them, and it is
/// not working, because it takes the person's next message as an idle Agent
/// does. A failed last turn still says `error` first.
public func conversationStatus(_ transcript: Transcript) -> ConversationAgentStatus {
    switch transcript.state {
    case .connecting: return .unknown
    case .broken: return .error
    case .ready(let turn):
        if !transcript.requests.isEmpty { return .waiting }
        if turn != .none { return .working }
        if !transcript.pending.isEmpty { return .waiting }
        if lastTurnFailed(transcript) { return .error }
        return transcript.backgroundTasks.isEmpty ? .idle : .background
    }
}

/// What the Agent is doing, in its own words: the title of the latest running
/// tool call, else the in-progress step of the latest plan. Outside a turn,
/// what works in the background: the one task's title, or how many there are.
public func conversationActivity(_ transcript: Transcript) -> String? {
    guard case .ready(let turn) = transcript.state else { return nil }
    if turn != .running {
        if turn != .none || transcript.backgroundTasks.isEmpty { return nil }
        return transcript.backgroundTasks.count == 1
            ? transcript.backgroundTasks[0].title
            : "\(transcript.backgroundTasks.count) background tasks"
    }
    for entry in transcript.entries.reversed() {
        if case .tool(let tool) = entry, tool.status == .running { return tool.title }
    }
    return latestPlan(transcript)?.steps.first(where: { $0.status == .inProgress })?.text
}

/// The Agent's plan as it last stood: the latest plan block of an answer
/// (Codex) or plan a call set (Claude's TodoWrite), and the entry it is on.
public func latestPlan(_ transcript: Transcript) -> (entry: EntryId, steps: [PlanStep])? {
    for entry in transcript.entries.reversed() {
        if case .tool(let tool) = entry, let plan = tool.plan { return (tool.id, plan) }
        guard case .assistant(let assistant) = entry else { continue }
        for block in assistant.blocks.reversed() {
            if case .plan(let steps) = block { return (assistant.id, steps) }
        }
    }
    return nil
}

/// The messages the conversation can be rewound to before now: the person's
/// top-level messages, those DevHub sent for them after a usage limit
/// included, that the CLI can cut before, when the session can take turns
/// back, nothing is running or waiting, and DevHub holds no message of the
/// person's. Rewinding drops the message and everything after it.
public func rewindTargets(_ transcript: Transcript) -> Set<EntryId> {
    if !transcript.session.canRewind || !transcript.requests.isEmpty || !transcript.pending.isEmpty { return [] }
    guard transcript.state == .ready(turn: .none) else { return [] }
    return Set(
        transcript.entries.compactMap { entry -> EntryId? in
            guard case .user(let user) = entry, user.parent == nil,
                  user.origin == .person || user.origin == .afterLimit, user.rewindable
            else { return nil }
            return user.id
        })
}
