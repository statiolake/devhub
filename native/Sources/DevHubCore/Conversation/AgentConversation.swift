// Port of apps/desktop/src/main/agent/conversation/conversation.ts
//
// One GUI Agent's conversation, as Core holds it.
//
// It owns three things and nothing else: the protocol adapter, the true
// `Transcript` (every event the adapter produced, folded with the same
// `applyEvent` the view uses), and the loop that feeds the adapter from the
// host. The reconcile round reads it, the view subscribes to it, and commands
// go through it to the host.
//
// # One order, live or replayed
//
// The adapter sees two kinds of line: what the CLI printed (the journal) and
// what DevHub wrote (`in.log`). A transcript is only reproducible if the two
// reach the adapter in the same order every time, so every adapter call goes
// through one turnstile, and every write records the journal offset the
// conversation had consumed when it was made. Attaching — the first time or
// after a restart of DevHub — reads the journal from 0 and feeds each written
// line back at the offset it was written after. That is the same sequence of
// calls the live conversation made, so it folds to the same transcript.
//
// The CLI is greeted (the adapter's `opening`) exactly when nothing has ever
// been written to it, which is a fact `in.log` states: a restart finds the
// greeting there and does not greet again. The same fact settles the replies
// a protocol demands of a line (Codex's handshake is made of them): a line
// the last write came after was answered when it was read, so replaying it
// writes nothing, and a line past that — printed while no DevHub was
// following — is answered now.
//
// # Failure, at the one root
//
// The loop is the root the design names (§6.2), and it tells two families
// apart:
//
// - The link to the host failed (`HostLinkFailure`). The conversation is
//   intact in the host, so this is recoverable: the reading carries it as
//   `lost` for the round to show, and `reattach` — once a round — follows the
//   journal again from where it stopped, with the same adapter.
// - The adapter could not read a line (`ProtocolMismatch`, or a
//   `TranscriptInvariantError` from its own fold). That is version skew and
//   nothing retries it: the conversation turns `broken` and takes no input.
//
// Anything else is a broken assumption of DevHub's own — a host that could
// not even be opened, a bug — and it is not turned into either. It stops the
// conversation for good, goes to the log, and is read as this Agent's failure
// (`crashed`): on its pane and its row, where its subject is. It is not thrown
// at the round, which would fail every Agent on the machine and show on none
// of them — the spinner that never ends.
//
// # Rewinding
//
// `rewind` takes the conversation back to before one of the person's
// messages: the adapter's plan is carried out (lines written, or the CLI
// started again by its host), and the adapter reports the turn `rewinding`
// until the CLI has done it. Nothing else may be written meanwhile. The
// rewind itself is in the journal (a request and its answer, or the host's
// mark between two CLIs), so a replay rebuilds the rewound transcript like
// everything else.
//
// # The person's messages, held
//
// The person's words (`submit`) are written at once when the Agent is idle.
// Otherwise — a turn running, a request open, the CLI still connecting or
// being started again — DevHub holds them (`Transcript.pending`), and the
// person can change them, take them back, or have one written at once
// (`sendPendingNow`), which a running turn takes in as it goes. Each time the
// Agent becomes idle, the oldest held message is written and starts the next
// turn. A held message is DevHub's alone, not in the journal: it is lost if
// DevHub quits before writing it. A write of one that fails leaves it held,
// saying why, until the person tries again. One the person has open to
// change (`startEditingPending`) is not written, nor anything behind it,
// until they save the change (`editPending`) or give it up
// (`stopEditingPending`); the view that had it open going away gives it up
// (`stopEditingAll`).
//
// # After a usage limit
//
// A turn a usage limit stopped is gone on with once the limit has reset: the
// conversation's `LimitResumer` (LimitResume.swift) watches every event, and
// when the message it times is due the conversation writes it here, in the
// turnstile, as the person's (`after-limit`) — or says why it could not.
//
// # Asleep
//
// Once DevHub's own compaction before the cache expires (`CacheKeeper`) has
// ended and nothing at all is going on, the CLI is stopped to free its
// memory: the host runs `sleep` in its place (`ConversationHost.sleep`),
// with `SLEEP_MARK` in the journal, which is how a replay knows. The
// conversation, its session and its row stay. Whatever needs the CLI next
// starts it again on its session as Restart session does (`wake`); the
// person's message is held until it is ready. Little cache is lost: the
// compacted conversation was never cached, and a new CLI rebuilds its
// system prompt (date, git status) anyway.
//
// # In Swift
//
// The TS class lives on one event loop; this is an actor, whose isolation is
// that loop: its state changes only between suspension points, and the
// turnstile (`serial`) orders the adapter's calls exactly as the TS promise
// chain does — fixed when each call is made, not when it first suspends.

import Foundation

/// What a conversation needs of its host. `HostLink`, through `hostOn`, is the real one.
public protocol ConversationHost: Sendable {
    func lines(from fromOffset: Int, cancel: CancellationFlag) -> AsyncThrowingStream<JournalLine, Error>
    func write(_ line: String, afterOffset: Int) async throws
    /// Have the host start the CLI again on the session `session` picks (the
    /// arguments that pick it; none, a new session), the lines of `mark` in
    /// the journal between the two.
    func restart(session: [String], mark: [String]) async throws
    /// Have the host stop the CLI and wait in its place, `mark` in the journal.
    func sleep(mark: [String]) async throws
    func sentLog() async throws -> [SentRecord]
}

/// The line the host puts in the journal where it stopped the CLI to sleep.
public let SLEEP_MARK = #"{"type":"devhub_sleep"}"#

/// What the host runs while the CLI sleeps: reads nothing, waits to be stopped.
let SLEEPER = RestartedCLI(file: "sleep", args: ["2147483647"])

/// What a conversation's host is made of: `HostLink`, whose restart takes the CLI whole.
public protocol HostOnLink: Sendable {
    func lines(from fromOffset: Int, cancel: CancellationFlag) -> AsyncThrowingStream<JournalLine, Error>
    func write(_ line: String, afterOffset: Int) async throws
    func restart(_ cli: RestartedCLI, mark: [String]) async throws
    func sentLog() async throws -> [SentRecord]
}

extension HostLink: HostOnLink {}

/// The conversation's host on `link`, whose CLI is started again as
/// `cliOn(session)`: the CLI whole, on the session a rewind or a `/resume`
/// picks, composed as the launch's was (`guiAgentCli`).
public func hostOn(_ link: any HostOnLink, cliOn: @escaping @Sendable ([String]) -> RestartedCLI) -> any ConversationHost {
    LinkedHost(link: link, cliOn: cliOn)
}

private struct LinkedHost: ConversationHost {
    let link: any HostOnLink
    let cliOn: @Sendable ([String]) -> RestartedCLI

    func lines(from fromOffset: Int, cancel: CancellationFlag) -> AsyncThrowingStream<JournalLine, Error> {
        link.lines(from: fromOffset, cancel: cancel)
    }

    func write(_ line: String, afterOffset: Int) async throws { try await link.write(line, afterOffset: afterOffset) }

    func restart(session: [String], mark: [String]) async throws { try await link.restart(cliOn(session), mark: mark) }

    func sleep(mark: [String]) async throws { try await link.restart(SLEEPER, mark: mark) }

    func sentLog() async throws -> [SentRecord] { try await link.sentLog() }
}

/// A host that is opened by the first call that needs it.
///
/// Opening one asks the machine where its home is, which can fail; done here,
/// inside the conversation's own calls, the failure reaches the conversation's
/// root like every other, instead of whoever asked for the conversation.
public func openedLater(_ open: @escaping @Sendable () async throws -> any ConversationHost) -> any ConversationHost {
    LaterHost(open: open)
}

private final class LaterHost: ConversationHost {
    private let open: @Sendable () async throws -> any ConversationHost
    private let opening = Guarded<Task<any ConversationHost, Error>?>(nil)

    init(open: @escaping @Sendable () async throws -> any ConversationHost) { self.open = open }

    private func host() async throws -> any ConversationHost {
        let task = opening.with { opening in
            if let opening { return opening }
            let task = Task { [open] in try await open() }
            opening = task
            return task
        }
        return try await task.value
    }

    func lines(from fromOffset: Int, cancel: CancellationFlag) -> AsyncThrowingStream<JournalLine, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await line in try await self.host().lines(from: fromOffset, cancel: cancel) {
                        continuation.yield(line)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func write(_ line: String, afterOffset: Int) async throws {
        try await host().write(line, afterOffset: afterOffset)
    }

    func restart(session: [String], mark: [String]) async throws {
        try await host().restart(session: session, mark: mark)
    }

    func sleep(mark: [String]) async throws { try await host().sleep(mark: mark) }

    func sentLog() async throws -> [SentRecord] { try await host().sentLog() }
}

public struct ConversationReading: Sendable {
    public let transcript: Transcript
    /// Why the journal is not being followed now, if it is not.
    public let lost: HostLinkFailure?
    /// What stopped the conversation for good, if something DevHub did not expect did.
    public let crashed: (any Error)?
    /// When DevHub will compact the idle conversation to beat its cache's expiry, if it will.
    public let autoCompactAt: Double?

    public init(transcript: Transcript, lost: HostLinkFailure?, crashed: (any Error)?, autoCompactAt: Double?) {
        self.transcript = transcript
        self.lost = lost
        self.crashed = crashed
        self.autoCompactAt = autoCompactAt
    }
}

/// The view's starting point: everything up to `revision`; events after it follow.
public struct ConversationSnapshot: Sendable, Equatable {
    public let transcript: Transcript
    public let revision: Int
}

/// An event as the view receives it: numbered, so a gap is visible.
public typealias ConversationPublish = @Sendable (_ revision: Int, _ event: ConversationEvent) -> Void

/// How the conversation keeps the prompt cache: the settings, read each time, and the clock.
public struct CacheKeeping: Sendable {
    public var settings: @Sendable () -> CacheKeepSettings
    public var clock: ConversationClock

    public init(settings: @escaping @Sendable () -> CacheKeepSettings, clock: ConversationClock = REAL_CLOCK) {
        self.settings = settings
        self.clock = clock
    }

    public static let off = CacheKeeping(settings: { CACHE_KEEP_OFF })
}

/// A conversation asked to do what only a fresh one does: start twice.
public struct ConversationMisuse: Error, CustomStringConvertible, Equatable {
    public let message: String
    public var description: String { message }
}

/// An edit waiting for its rewind to be over.
private struct PendingRewind {
    let settled: OneShot<Void>
    /// What the switch is, as a conversation that stops first says it stopped before.
    let awaited: String
    /// The turn has been `rewinding` since the plan was carried out.
    var begun = false
}

/// The conversation, reached from what it hands its timers: set once, as its init ends.
private final class ConversationRef: @unchecked Sendable {
    weak var conversation: AgentConversation?
}

public actor AgentConversation {
    private let host: any ConversationHost
    private let adapter: any ProtocolAdapter
    private let publish: ConversationPublish

    private var transcript = EMPTY_TRANSCRIPT
    private var revision = 0
    /// The journal, consumed up to here.
    private var offset = 0
    /// Lines of `in.log` not yet fed back, in order.
    private var replay: [SentRecord] = []
    /// How far into the journal an earlier DevHub had read when it last wrote.
    /// It answered every line up to here already, so a reply a replayed line
    /// demands again is not written again. -1 is "it never wrote".
    private var answeredUpTo = -1
    private var tail: Task<Void, Never>?

    private let cancel = CancellationFlag()
    private var following: Task<Void, Never>?
    private var attached = false
    private var lost: HostLinkFailure?
    private var crashed: (any Error)?
    private var pendingRewind: PendingRewind?
    /// Whether the Agent was idle after the last event: becoming idle writes a held message.
    private var idle = false
    private var heldCount = 0

    private enum Sleep { case falling, asleep }
    /// The CLI is being stopped to sleep (`falling`), or is (see the file's head).
    private var sleep: Sleep?
    /// Settles once the sleep mark is read, or following ends.
    private var fell: OneShot<Void>?
    /// The sleeping CLI is being started again: settles once it is ready.
    private var waking: OneShot<Void>?

    private enum Compacted { case written, ended }
    /// DevHub's compaction was written, or its turn has ended: then the CLI may sleep.
    private var compacted: Compacted?

    private let limits: LimitResumer
    private let cacheKeeper: CacheKeeper

    /// What is under way and not yet waited for: turnstile work, a timer's
    /// hop into the conversation, a journal line being taken. What a test
    /// settles on; nothing else reads it.
    nonisolated let activity = Guarded(0)

    public init(
        host: any ConversationHost, adapter: sending any ProtocolAdapter, publish: @escaping ConversationPublish,
        limits: LimitResumeOptions, cacheKeeping: CacheKeeping = .off
    ) {
        let ref = ConversationRef()
        self.host = host
        self.adapter = adapter
        self.publish = publish
        self.limits = LimitResumer(
            limits,
            show: { [ref] resume in
                try ref.conversation?.assumeIsolated { try $0.apply(.limitResume(resume)) }
            },
            due: { [ref, activity] in
                Self.hop(ref, activity) { $0.resumeAfterLimit() }
            })
        self.cacheKeeper = CacheKeeper(
            settings: cacheKeeping.settings, clock: cacheKeeping.clock,
            due: { [ref, activity] in
                Self.hop(ref, activity) { $0.compactBeforeCacheExpires() }
            })
        ref.conversation = self
    }

    /// A timer came due: into the conversation, in its turn.
    private static func hop(
        _ ref: ConversationRef, _ activity: Guarded<Int>,
        _ work: @escaping @Sendable (isolated AgentConversation) -> Void
    ) {
        guard let conversation = ref.conversation else { return }
        activity.with { $0 += 1 }
        Task {
            await conversation.run(work)
            activity.with { $0 -= 1 }
        }
    }

    private func run(_ work: @Sendable (isolated AgentConversation) -> Void) { work(self) }

    /// Start following the host. Once; `reattach` is how it starts again.
    public func start() throws {
        if following != nil { throw ConversationMisuse(message: "this conversation has already started") }
        beginFollowing()
    }

    /// Follow the journal again after the link was lost, from where it stopped.
    /// The round calls it once per round; a conversation that is not lost is
    /// left alone.
    public func reattach() {
        if lost == nil || cancel.isCancelled { return }
        lost = nil
        beginFollowing()
    }

    /// The attach is queued now, before anything that could be written after
    /// it: a command between reading `in.log` and greeting would be in the
    /// log and missing from the replay, or the other way round.
    private func beginFollowing() {
        let attach = attached ? nil : attachment()
        following = Task { await self.follow(attach) }
    }

    public func reading() -> ConversationReading {
        ConversationReading(transcript: transcript, lost: lost, crashed: crashed, autoCompactAt: cacheKeeper.dueAt())
    }

    /// The view's starting point: everything up to `revision`; events after it follow.
    public func snapshot() -> ConversationSnapshot { ConversationSnapshot(transcript: transcript, revision: revision) }

    /// Carry out one command: its lines written to the host, then taken back
    /// as sent. Throws if it could not be — a write that failed leaves no trace.
    public func command(_ command: ConversationCommand) async throws {
        try await wake()
        try await serial { me in
            try me.refuseIfBusy()
            try await me.write(me.adapter.encode(command))
        }.value
    }

    /// Take the conversation back to before `message`, one of `rewindTargets`:
    /// that message and everything after it go. Refused, with the reason, when
    /// it cannot be rewound to now; `refused` when the CLI would not (the
    /// conversation says why, and nothing was dropped); throws when the plan
    /// could not be carried out or the conversation stopped first.
    public func rewind(_ message: EntryId) async throws -> RewindOutcome {
        try await wake()
        let over = try await serial { me in
            try me.refuseIfBusy()
            try me.refuseRewind(message)
            return try await me.carryOut(me.adapter.rewind(message), "the CLI had taken the turns back")
        }.value
        try await over.value()
        return transcript.entries.contains { $0.id == message } ? .refused : .rewound
    }

    /// The person's words to the Agent: written at once when it is idle and
    /// holds nothing of theirs, else held until it is (see the file's head).
    public func submit(_ text: String, images: [ImageRef]) async throws {
        try await submitting(text, images: images).value
    }

    /// `submit`, queued now and not waited for.
    @discardableResult
    public func submitting(_ text: String, images: [ImageRef]) -> Task<Void, Error> {
        serial { me in
            try me.refuseIfBroken()
            _ = try await me.wakeNow()
            if me.idleNow() && me.transcript.pending.isEmpty {
                try await me.write(me.adapter.encode(.send(text: text, images: images, origin: .person)))
                return
            }
            me.heldCount += 1
            try me.setPending(
                me.transcript.pending + [
                    PendingMessage(
                        id: PendingId("held:\(me.heldCount)"), text: text, images: images, failure: nil, editing: false)
                ])
        }
    }

    /// The person opened a held message to change it: it is not written until
    /// they save (`editPending`) or give the edit up (`stopEditingPending`).
    public func startEditingPending(_ id: PendingId) async throws {
        try await serial { me in
            _ = try me.held(id)
            try me.setEditing({ $0.id == id }, true)
        }.value
    }

    /// Change the words of a held message, and let it be written again.
    public func editPending(_ id: PendingId, text: String) async throws {
        try await serial { me in
            _ = try me.held(id)
            try me.setPending(
                me.transcript.pending.map { each in
                    guard each.id == id else { return each }
                    var edited = each
                    edited.text = text
                    edited.failure = nil
                    edited.editing = false
                    return edited
                })
        }.value
        writeNextHeld()
    }

    /// The person gave up changing a held message: it is written as it was.
    /// A message no longer waiting has nothing to give up — the view lets go
    /// of an edit when it closes, and the message may have been taken back.
    public func stopEditingPending(_ id: PendingId) async throws {
        try await serial { me in try me.setEditing({ $0.id == id }, false) }.value
        writeNextHeld()
    }

    /// The view that had held messages open went away: none is being changed.
    /// Nobody waits on this, so a failure in it is the conversation's own.
    public func stopEditingAll() {
        let edited = serial { me in try me.setEditing({ _ in true }, false) }
        then(edited) { $0.writeNextHeld() }
    }

    private func setEditing(_ which: (PendingMessage) -> Bool, _ editing: Bool) throws {
        let pending = transcript.pending
        if !pending.contains(where: { which($0) && $0.editing != editing }) { return }
        try setPending(
            pending.map { each in
                guard which(each) else { return each }
                var changed = each
                changed.editing = editing
                return changed
            })
    }

    /// How the MCP sign-in DevHub runs for this Agent stands now
    /// (`Transcript.mcpSignIn`), or none. DevHub's own, like the held
    /// messages: it is not in the journal, and a restart of DevHub forgets it
    /// along with the command it ran.
    public func showSignIn(_ signIn: McpSignIn?) async throws {
        try await serial { me in try me.apply(.mcpSignIn(signIn)) }.value
    }

    /// The person does not want the Agent gone on with after the usage limit
    /// it stopped at (Cancel), or has read why that failed (Dismiss).
    public func cancelLimitResume() async throws {
        try await serial { me in try me.limits.cancel() }.value
    }

    /// The message that goes on after a usage limit is due: written in the
    /// turnstile, as the person's, if it still is (`LimitResumer.take`). A
    /// write that fails is said where the resume was; nothing retries it.
    /// Nobody waits on this, so a failure DevHub did not expect is the
    /// conversation's own.
    private func resumeAfterLimit() {
        orCrash(
            serial { me in
                guard let text = try me.limits.take() else { return }
                do {
                    try await me.write(me.adapter.encode(.send(text: text, images: [], origin: .afterLimit)))
                } catch let error as HostLinkFailure {
                    try me.limits.failed(error.message)
                }
            })
    }

    /// The cache-keeping settings may have changed (`CacheKeeper.reconsider`).
    public func reconsiderCacheKeeping() {
        cacheKeeper.reconsider()
    }

    /// The prompt cache is about to go cold on an idle conversation: `/compact`
    /// is written, marked as DevHub's (`auto-compact`), if it still should be
    /// (`CacheKeeper.take`). A write that fails is let go: the next warm
    /// period gets its own chance.
    private func compactBeforeCacheExpires() {
        orCrash(
            serial { me in
                if me.cancel.isCancelled || me.pendingRewind != nil { return }
                if me.sleep != nil { return }
                if !me.cacheKeeper.take(me.transcript) { return }
                do {
                    try await me.write(
                        me.adapter.encode(.send(text: AUTO_COMPACT_COMMAND, images: [], origin: .autoCompact)))
                    me.compacted = .written
                } catch is HostLinkFailure {}
            })
    }

    /// DevHub's compaction ended: the CLI is put to sleep if nothing at all is
    /// going on — no turn, request, message held or on its way, background
    /// task, subagent, MCP sign-in or usage-limit resume. Else it stays up.
    private func sleepIfRestful() {
        if compacted != .ended { return }
        compacted = nil
        orCrash(
            serial { me in
                let t = me.transcript
                if !me.idleNow() || me.cancel.isCancelled || me.lost != nil || !t.pending.isEmpty
                    || !t.sending.isEmpty || !t.backgroundTasks.isEmpty || t.compacting || t.limitResume != nil
                    || t.mcpSignIn?.phase == .running || !t.entries.allSatisfy({ withProcessEnded($0) == $0 })
                {
                    return
                }
                me.sleep = .falling
                let fell = OneShot<Void>()
                me.fell = fell
                do {
                    try await me.host.sleep(mark: [SLEEP_MARK])
                } catch {
                    me.sleep = nil
                    me.fell?.resolve()
                    if !(error is HostLinkFailure) { throw error }
                }
            })
    }

    /// A sleeping CLI is started again, and is ready, before anything else is written to it.
    private func wake() async throws {
        if sleep == nil && waking == nil { return }
        // The host takes a restart only once the sleeper is in the CLI's place.
        try await fell?.value()
        let over = try await serial { me -> OneShot<Void>? in
            me.cancel.isCancelled ? nil : try await me.wakeNow()
        }.value
        try await over?.value()
    }

    /// Inside the turnstile only: start the sleeping CLI again on its session,
    /// once; the shot settles when it is ready. A held message waits for it.
    private func wakeNow() async throws -> OneShot<Void> {
        if sleep == .asleep && waking == nil {
            let over = try await carryOut(.restart(adapter.restart()), "the CLI had started again")
            // Cleared as the switch ends (`endRewind`), which may already have.
            if !over.isSettled { waking = over }
        }
        return waking ?? .settled(())
    }

    /// Take a held message back: it is never written.
    public func removePending(_ id: PendingId) async throws {
        try await serial { me in
            _ = try me.held(id)
            try me.setPending(me.transcript.pending.filter { $0.id != id })
        }.value
    }

    /// Write a held message now, without waiting for the Agent to be idle: a
    /// running turn takes it in as it goes (the adapter's `send`). Refused
    /// while the CLI cannot take a message at all.
    public func sendPendingNow(_ id: PendingId) async throws {
        try await wake()
        try await serial { me in
            try me.refuseIfBusy()
            if try me.held(id).editing {
                throw ConversationError.refused("That message is being edited. Save or cancel the change first.")
            }
            guard case .ready(let turn) = me.transcript.state, turn != .rewinding else {
                throw ConversationError.refused(
                    "The Agent cannot take a message yet. It is sent when the Agent is ready.")
            }
            try await me.writeHeld(id)
        }.value
    }

    private func held(_ id: PendingId) throws -> PendingMessage {
        guard let found = transcript.pending.first(where: { $0.id == id }) else {
            throw ConversationError.refused("That message is no longer waiting: it was sent or taken back.")
        }
        return found
    }

    /// Inside the turnstile only: write a held message and let it go, or keep
    /// it held with the reason its write failed, which it shows. That is the
    /// one place a held message's failure is reported.
    private func writeHeld(_ id: PendingId) async throws {
        let message = try held(id)
        do {
            try await write(adapter.encode(.send(text: message.text, images: message.images, origin: .person)))
        } catch let error as HostLinkFailure {
            try setPending(
                transcript.pending.map { each in
                    guard each.id == id else { return each }
                    var failed = each
                    failed.failure = error.message
                    return failed
                })
            return
        }
        try setPending(transcript.pending.filter { $0.id != id })
    }

    private func setPending(_ pending: [PendingMessage]) throws {
        try apply(.pending(pending))
    }

    /// Nothing running, waiting or being taken back: a message written now starts a turn.
    private func idleNow() -> Bool {
        transcript.state == .ready(turn: .none) && transcript.requests.isEmpty && pendingRewind == nil && sleep == nil
    }

    private static func writable(_ transcript: Transcript) -> PendingMessage? {
        guard let next = transcript.pending.first, next.failure == nil, !next.editing else { return nil }
        return next
    }

    /// The Agent became idle, or the oldest held message may be written now:
    /// it is written, in the turnstile after whatever made it so. A held
    /// message whose last write failed, or that the person has open to change,
    /// waits for the person, and so does everything behind it.
    private func writeNextHeld() {
        if Self.writable(transcript) == nil { return }
        orCrash(
            serial { me in
                guard let next = Self.writable(me.transcript), me.idleNow() else { return }
                try await me.writeHeld(next.id)
            })
    }

    /// Go on with another session of the CLI, `session` (`/resume`), in place
    /// of this one: the adapter's plan is carried out as an edit's is, and this
    /// returns once the CLI has the other session (the adapter emitted
    /// `session-switched` and the turn is no longer `rewinding`). `history` is
    /// that session's past, for a protocol whose CLI prints none of it. The
    /// switch is in the journal like a rewind, so a replay draws the same.
    /// Refused while a turn runs, a request is open or an edit is under way.
    public func resumeSession(_ session: String, history: [String]) async throws {
        try await wake()
        let over = try await serial { me in
            try me.refuseIfBusy()
            if me.transcript.state != .ready(turn: .none) || !me.transcript.requests.isEmpty {
                throw ConversationError.refused(
                    "The Agent is in the middle of a turn. Stop it before going on with another session.")
            }
            return try await me.carryOut(
                me.adapter.resumeSession(session, history: history), "it went on with session \(session)")
        }.value
        try await over.value()
    }

    /// Stop the CLI and start it again on the session it is on (Restart
    /// session), carried out as a rewind's plan is: returns once the new CLI
    /// is ready. Taken whatever the Agent is doing — whether to ask first is
    /// the coordinator's (`askAbout`) — so a running turn, a question it is
    /// waiting on and what it started in the background stop with the CLI.
    /// The messages DevHub holds for it stay held, and go to the new CLI.
    ///
    /// A conversation its CLI stopped (signed out, refusing to start) is the
    /// case it is most for: DevHub still reads the journal, and the new CLI's
    /// start lifts the stop. One whose journal DevHub stopped reading is
    /// refused — nothing would read what the new CLI said.
    public func restart() async throws {
        try await fell?.value()
        let over = try await serial { me -> OneShot<Void> in
            if let crashed = me.crashed { throw crashed }
            if me.cancel.isCancelled {
                if case .broken(let failure) = me.transcript.state {
                    throw ConversationError.stopped(
                        "DevHub stopped reading this conversation, so it cannot follow a CLI started again: \(failure.detail)"
                    )
                }
                throw ConversationError.stopped(
                    "DevHub stopped following this conversation, so it cannot follow a CLI started again.")
            }
            if me.sleep == .asleep || me.waking != nil { return try await me.wakeNow() }
            try me.refuseIfRewinding()
            return try await me.carryOut(.restart(me.adapter.restart()), "the CLI had started again")
        }.value
        try await over.value()
    }

    /// Inside the turnstile only: carry out the adapter's plan for a rewind, a
    /// `/resume` or a restart — its lines written, or the CLI started again —
    /// and hand back the shot that settles when the adapter says the switch is
    /// done (`pendingRewind`). A plan that could not be carried out leaves
    /// nothing under way. Handed back unawaited: awaited in the turnstile, it
    /// would wait for lines the turnstile could then never read. `awaited` is
    /// what the switch is, as a conversation that stops first says it stopped
    /// before.
    private func carryOut(_ plan: RewindPlan, _ awaited: String) async throws -> OneShot<Void> {
        let settled = OneShot<Void>()
        pendingRewind = PendingRewind(settled: settled, awaited: awaited)
        do {
            switch plan {
            case .write(let lines): try await write(lines)
            case .restart(let restart): try await host.restart(session: restart.session, mark: restart.mark)
            }
        } catch {
            pendingRewind = nil
            throw error
        }
        return settled
    }

    private enum RewindEnd {
        case done
        /// The conversation stopped first; `why`, when it broke, is what broke it.
        case stopped(why: String?)
    }

    private func endRewind(_ rewind: PendingRewind, _ end: RewindEnd) {
        if waking === rewind.settled { waking = nil }
        switch end {
        case .done: rewind.settled.resolve()
        case .stopped(let why):
            rewind.settled.reject(
                ConversationError.stopped("The conversation stopped before \(rewind.awaited)\(why.map { ": \($0)" } ?? ".")"))
        }
    }

    private func refuseRewind(_ message: EntryId) throws {
        if rewindTargets(transcript).contains(message) { return }
        if !transcript.session.canRewind {
            throw ConversationError.refused(
                "This Agent's CLI cannot take turns back, so the conversation cannot be rewound.")
        }
        if !transcript.requests.isEmpty || (transcript.state.turn.map { $0 != .none } ?? false) {
            throw ConversationError.refused("The Agent is in the middle of a turn. Stop it before rewinding.")
        }
        if !transcript.pending.isEmpty {
            throw ConversationError.refused(
                "Messages of yours are waiting to be sent. Send or remove them before rewinding.")
        }
        throw ConversationError.refused("The conversation cannot be rewound to before that message.")
    }

    private func refuseIfBusy() throws {
        try refuseIfBroken()
        try refuseIfRewinding()
        if sleep != nil {
            throw ConversationError.refused("The Agent's CLI was stopped while it sat idle. Try again in a moment.")
        }
    }

    private func refuseIfRewinding() throws {
        if pendingRewind != nil {
            throw ConversationError.refused("The conversation is being taken back. Wait until that is done.")
        }
    }

    private func refuseIfBroken() throws {
        if let crashed { throw crashed }
        if case .broken(let failure) = transcript.state {
            throw ConversationError.stopped("This conversation has stopped taking input: \(failure.detail)")
        }
    }

    /// Choose a setting. Whatever lines the protocol sets it with are written
    /// and taken back as sent, like a command's; a protocol that carries it on
    /// the next turn instead has already said so in the step's events.
    public func configure(_ which: SettingName, _ id: String) async throws {
        try await wake()
        try await serial { me in
            try me.refuseIfBusy()
            let step = try me.adapter.configure(which, id)
            try me.take(step)
            try await me.write(step.replies)
        }.value
    }

    /// Stop following. The host and its CLI are untouched.
    public func stop() async {
        cancel.cancel()
        limits.stop()
        cacheKeeper.stop()
        await following?.value
    }

    private func follow(_ attach: Task<Void, Error>?) async {
        await followJournal(attach)
        // However following ended, an edit waiting on the CLI will not hear
        // from it now.
        if let rewind = pendingRewind {
            pendingRewind = nil
            endRewind(rewind, .stopped(why: nil))
        }
        fell?.resolve()
    }

    /// The greeting, or none when `in.log` says the CLI was greeted. It counts
    /// as done only once it is: a greeting whose write failed is looked for
    /// again, in `in.log`, by the next attach.
    private func attachment() -> Task<Void, Error> {
        serial { me in
            me.replay = try await me.host.sentLog()
            me.answeredUpTo = max(-1, me.replay.map(\.afterOffset).max() ?? -1)
            if me.replay.isEmpty { try await me.write(me.adapter.opening()) }
            try me.feedSentUpTo(me.offset)
            me.attached = true
        }
    }

    private func followJournal(_ attach: Task<Void, Error>?) async {
        do {
            if let attach {
                try await attach.value
            } else if !attached {
                try await attachment().value
            }
            for try await journal in host.lines(from: offset, cancel: cancel) {
                activity.with { $0 += 1 }
                defer { activity.with { $0 -= 1 } }
                let line = journal.line
                let at = journal.offset
                let replies = try await serial { me -> [String] in
                    // The sleep mark is DevHub's, not the CLI's: the adapter never sees it.
                    let asleep = line == SLEEP_MARK
                    if asleep || me.sleep == .asleep { me.sleep = asleep ? .asleep : nil }
                    let step = asleep ? AdapterStep.none : try me.adapter.received(line)
                    try me.take(step)
                    me.offset = at
                    try me.feedSentUpTo(at)
                    if asleep {
                        me.fell?.resolve()
                        // A message held while it fell asleep.
                        if !me.transcript.pending.isEmpty { _ = try await me.wakeNow() }
                    }
                    // A line an earlier DevHub read had its replies written then;
                    // they are in `in.log`, and fed back above as sent.
                    return at <= me.answeredUpTo ? [] : step.replies
                }.value
                if !replies.isEmpty { try await serial { me in try await me.write(replies) }.value }
                // After the replies, which the sleeper would leave in its pipe.
                sleepIfRestful()
            }
        } catch let error as HostLinkFailure {
            lost = error
        } catch let error where error is ProtocolMismatch || error is TranscriptInvariantError {
            cancel.cancel()
            do {
                try apply(
                    .state(.broken(ConversationFailure(code: .protocolMismatch, detail: "\(error)"))))
            } catch {
                crash(error)
            }
        } catch {
            crash(error)
        }
    }

    /// A failure DevHub did not expect stops the conversation for good (see the file's head).
    private func crash(_ error: any Error) {
        cancel.cancel()
        limits.stop()
        cacheKeeper.stop()
        crashed = error
        FileHandle.standardError.write(
            Data("[devhub] a GUI Agent's conversation stopped on a failure DevHub did not expect: \(error)\n".utf8))
    }

    /// Nobody waits on `task`: a failure in it is the conversation's own.
    private func orCrash<T: Sendable>(_ task: Task<T, Error>) {
        then(task) { _ in }
    }

    /// `next` once `task` is done; a failure in either is the conversation's own.
    private func then<T: Sendable>(
        _ task: Task<T, Error>, _ next: @escaping @Sendable (isolated AgentConversation) throws -> Void
    ) {
        activity.with { $0 += 1 }
        Task {
            do {
                _ = try await task.value
                try self.runThrowing(next)
            } catch {
                self.crash(error)
            }
            self.activity.with { $0 -= 1 }
        }
    }

    private func runThrowing(_ work: @Sendable (isolated AgentConversation) throws -> Void) throws { try work(self) }

    /// Feed back what DevHub wrote after the journal reached `offset`.
    private func feedSentUpTo(_ offset: Int) throws {
        while let next = replay.first, next.afterOffset <= offset {
            replay.removeFirst()
            try take(adapter.sent(next.line))
        }
    }

    /// Inside the turnstile only: write, then take each line back as sent.
    private func write(_ lines: [String]) async throws {
        for line in lines {
            try await host.write(line, afterOffset: offset)
            try take(adapter.sent(line))
        }
    }

    private func take(_ step: AdapterStep) throws {
        for event in step.events { try apply(event) }
    }

    private func apply(_ event: ConversationEvent) throws {
        transcript = try applyEvent(transcript, event)
        revision += 1
        publish(revision, event)
        watchRewind()
        let idleNow = idleNow()
        if idleNow && !idle {
            writeNextHeld()
            if compacted == .written { compacted = .ended }
        }
        idle = idleNow
        // What DevHub will do about a usage limit follows from the rest of
        // the conversation, never the other way round.
        if case .limitResume = event {} else { try limits.observe(transcript, offset: offset) }
        cacheKeeper.observe(transcript)
    }

    /// An edit's rewind is over once the turn has been `rewinding` and is not any more.
    private func watchRewind() {
        guard var rewind = pendingRewind else { return }
        if transcript.state == .ready(turn: .rewinding) {
            rewind.begun = true
            pendingRewind = rewind
            return
        }
        if !rewind.begun { return }
        pendingRewind = nil
        if case .broken(let failure) = transcript.state {
            endRewind(rewind, .stopped(why: failure.detail))
            return
        }
        endRewind(rewind, .done)
    }

    /// Runs `work` after everything already queued, and before anything queued later.
    private func serial<T: Sendable>(
        _ work: @escaping @Sendable (isolated AgentConversation) async throws -> T
    ) -> Task<T, Error> {
        let previous = tail
        activity.with { $0 += 1 }
        let task = Task<T, Error> {
            await previous?.value
            return try await work(self)
        }
        tail = Task { [activity] in
            _ = await task.result
            activity.with { $0 -= 1 }
        }
        return task
    }
}
