// Port of apps/desktop/src/main/agent/conversation/limitResume.ts
//
// Going on with a GUI Agent's conversation once the usage limit that stopped
// it has reset.
//
// A turn a usage limit stopped ends with the limit on its `turn-end` entry
// (the adapter reads its CLI's own signals for it), and while that end is the
// last thing in the conversation the conversation stands stopped at the
// limit (`limitStop`). DevHub then writes a fixed message for the person
// (`[agents] resume_after_limit_message`) through the conversation's one
// send, `RESET_MARGIN_MS` after the window resets — never sooner than
// `SOONEST_MS` after it was set to — and says so meanwhile as one line at the
// end of the conversation (`Transcript.limitResume`).
//
// # One rule ends it
//
// The resume is for one stop, and it holds exactly while that stop stands.
// Whatever moves the conversation on ends it: the person's words, a turn the
// Agent starts on its own, a restart of its CLI, a rewind, another session —
// each of them leaves the stop no longer standing, and that is the only thing
// looked at. So is the person pressing Cancel, and the Agent going away (its
// conversation stops, and its record goes with it).
//
// # Across a restart of DevHub
//
// What DevHub decided about a stop is kept per Agent (`LimitResumeRecord`, in
// `limit-resumes.json`): which stop, where in the journal it first stood, and
// when its resume is due — or that it is over (sent, cancelled, failed). A
// new DevHub replays the journal from the start, and the stops it passes on
// the way are told apart by that record: the recorded stop picks up its
// resume again (a time that passed while DevHub was down is `SOONEST_MS`
// after it is seen), a stop before it in the journal is history, and a stop
// after it is new. A new stop whose reset has already passed is not resumed:
// it is one the journal holds from before, or one that ended while nobody was
// following, and a message nobody asked for long after is not what the person
// set this up for.

import Foundation

/// How long after the reset the CLI reported the message is written: its clock and ours differ.
public let RESET_MARGIN_MS: Double = 30_000
/// The soonest a resume is written after it was set: time to see it, and to cancel it.
public let SOONEST_MS: Double = 30_000

public struct LimitResumeSettings: Hashable, Sendable {
    /// `[agents] resume_after_limit`.
    public var enabled: Bool
    /// `[agents] resume_after_limit_message`: what is written for the person.
    public var message: String

    public init(enabled: Bool, message: String) {
        self.enabled = enabled
        self.message = message
    }
}

/// What DevHub decided about the last usage-limit stop of one Agent.
public struct LimitResumeRecord: Hashable, Sendable {
    /// The stop's `turn-end` entry.
    public var entry: String
    /// The journal offset the conversation had read when the stop first stood.
    public var since: Double
    /// When the message is due, in epoch ms; nil once it is over.
    public var at: Double?

    public init(entry: String, since: Double, at: Double?) {
        self.entry = entry
        self.since = since
        self.at = at
    }
}

public let LIMIT_RESUME_RECORDS = AgentRecordsKind<LimitResumeRecord>(
    key: "resumes",
    lost: "no GUI Agent resumes by itself after a usage limit it had stopped at",
    decode: { value, agentId in
        guard case .object(let record) = value, case .string(let entry)? = record["entry"],
              case .number(let since)? = record["since"]
        else {
            throw RecordRefused("the resume of \(agentId) is not an entry, an offset and a time")
        }
        switch record["at"] {
        case nil: return LimitResumeRecord(entry: entry, since: since, at: nil)
        case .number(let at)?: return LimitResumeRecord(entry: entry, since: since, at: at)
        default: throw RecordRefused("the resume of \(agentId) is not an entry, an offset and a time")
        }
    },
    encode: { record in
        var object: JsonObject = ["entry": .string(record.entry), "since": .number(record.since)]
        if let at = record.at { object["at"] = .number(at) }
        return .object(object)
    })

/// When things happen: the real clock in DevHub, a hand-turned one in a test.
public protocol ConversationClock: Sendable {
    /// Ms since the epoch.
    func now() -> Double
    /// Call `then` after `ms`; the function returned calls it off.
    func after(_ ms: Double, _ then: @escaping @Sendable () -> Void) -> @Sendable () -> Void
}

/// The longest delay a timer takes; a resume further off is timed again when it comes.
private let LONGEST_TIMER_MS: Double = 2_147_483_647

public struct RealClock: ConversationClock {
    public init() {}

    public func now() -> Double { Date().timeIntervalSince1970 * 1000 }

    public func after(_ ms: Double, _ then: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        let off = Guarded(false)
        DispatchQueue.global().asyncAfter(deadline: .now() + min(max(ms, 0), LONGEST_TIMER_MS) / 1000) {
            if !off.with({ $0 }) { then() }
        }
        return { off.with { $0 = true } }
    }
}

public let REAL_CLOCK: ConversationClock = RealClock()

/// This Agent's record, kept across restarts.
public struct LimitResumeRecordSlot: Sendable {
    public var get: @Sendable () -> LimitResumeRecord?
    public var set: @Sendable (LimitResumeRecord) -> Void

    public init(get: @escaping @Sendable () -> LimitResumeRecord?, set: @escaping @Sendable (LimitResumeRecord) -> Void) {
        self.get = get
        self.set = set
    }
}

public struct LimitResumeOptions: Sendable {
    public var settings: @Sendable () -> LimitResumeSettings
    public var record: LimitResumeRecordSlot
    public var clock: ConversationClock

    public init(
        settings: @escaping @Sendable () -> LimitResumeSettings, record: LimitResumeRecordSlot, clock: ConversationClock
    ) {
        self.settings = settings
        self.record = record
        self.clock = clock
    }
}

/// The stop standing now, as first seen.
private struct Standing {
    let entry: EntryId
    var resetsAt: Double?
    let since: Double
}

/// Not Sendable: one belongs to one conversation, which calls it from its own isolation.
public final class LimitResumer {
    private let options: LimitResumeOptions
    private let show: (LimitResume?) throws -> Void
    private let due: @Sendable () -> Void
    private var standing: Standing?
    private var armed: (at: Double, disarm: @Sendable () -> Void)?
    private var shown: LimitResume?
    /// The conversation is no longer followed: nothing is timed again.
    private var stopped = false

    /// - Parameters:
    ///   - show: put what DevHub will do in the transcript (`limit-resume`).
    ///   - due: the message is due: the conversation takes it (`take`) in its turn.
    public init(
        _ options: LimitResumeOptions, show: @escaping (LimitResume?) throws -> Void, due: @escaping @Sendable () -> Void
    ) {
        self.options = options
        self.show = show
        self.due = due
    }

    /// The conversation after an event (any but a `limit-resume`, which this
    /// made), and the journal offset it had read then.
    public func observe(_ transcript: Transcript, offset: Int) throws {
        let stop = limitStop(transcript)
        if let stop, stop.entry == standing?.entry {
            standing?.resetsAt = stop.resetsAt
        } else {
            // The stop that stood is over, and so is anything about it.
            if armed != nil { over() }
            try display(nil)
            standing = stop.map { Standing(entry: $0.entry, resetsAt: $0.resetsAt, since: Double(offset)) }
        }
        try decide()
    }

    /// The person pressed Cancel (or Dismiss): nothing is written for this
    /// stop, now or after a restart.
    public func cancel() throws {
        guard let standing else { return }
        armed?.disarm()
        armed = nil
        record(standing, nil)
        try display(nil)
    }

    /// The message is due: its words, once, or nothing when it is not due
    /// after all — cancelled meanwhile, turned off in Settings, or a timer
    /// that came early. Whatever it returns, the resume is over; the caller
    /// writes the words and says, through `failed`, if that did not happen.
    public func take() throws -> String? {
        guard let armed, let standing else { return nil }
        let left = armed.at - options.clock.now()
        if left > 0 {
            self.armed = (armed.at, options.clock.after(left, due))
            return nil
        }
        self.armed = nil
        record(standing, nil)
        try display(nil)
        let settings = options.settings()
        return settings.enabled ? settings.message : nil
    }

    /// Writing the message failed, for `why`: said until the conversation
    /// moves on or it is dismissed.
    public func failed(_ why: String) throws {
        guard standing != nil else { return }
        try display(.failed(failure: why))
    }

    /// Stop timing: the conversation is no longer followed. What was decided is kept.
    public func stop() {
        stopped = true
        armed?.disarm()
        armed = nil
    }

    private func decide() throws {
        guard let standing, armed == nil else { return }
        if case .failed? = shown { return }
        let recorded = options.record.get()
        if let recorded, recorded.entry == standing.entry.raw {
            if let at = recorded.at { try arm(at) }
            return
        }
        // A stop before the recorded one, passed on the way through the
        // journal: what happened to it is history.
        if let recorded, standing.since < recorded.since { return }
        let settings = options.settings()
        if !settings.enabled { return }
        guard let resetsAt = standing.resetsAt else {
            try display(.unscheduled(reason: "the CLI did not say when the limit resets"))
            return
        }
        if resetsAt <= options.clock.now() {
            try display(.unscheduled(reason: "the limit had already reset when DevHub read it"))
            return
        }
        let at = resetsAt + RESET_MARGIN_MS
        record(standing, at)
        try arm(at)
    }

    private func arm(_ dueAt: Double) throws {
        if stopped { return }
        let now = options.clock.now()
        let at = max(dueAt, now + SOONEST_MS)
        armed = (at, options.clock.after(at - now, due))
        try display(.scheduled(at: at))
    }

    private func over() {
        armed?.disarm()
        armed = nil
        if let standing { record(standing, nil) }
    }

    private func record(_ standing: Standing, _ at: Double?) {
        options.record.set(LimitResumeRecord(entry: standing.entry.raw, since: standing.since, at: at))
    }

    private func display(_ resume: LimitResume?) throws {
        if resume == shown { return }
        shown = resume
        try show(resume)
    }
}
