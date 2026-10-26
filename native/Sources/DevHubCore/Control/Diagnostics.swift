// Port of apps/desktop/src/main/diagnostics/counters.ts, rollingTally.ts,
// rounds.ts and metrics.ts (X-03): what `devhub --metrics` reads.
//
// The complaint these exist for is "DevHub is warmer than the editors it
// replaces", and a complaint about heat is a question about rates: how many
// processes a minute does an idle DevHub start, how many rounds does a loop
// run, how often is a repository asked about itself. None of that is visible
// from the outside, so the counting happens at the choke points themselves,
// and a reading is a pure join of what was counted with what the app knows.

import Foundation

// MARK: - counters.ts

/// One counter, as of a reading.
public struct CounterReading: Equatable, Sendable {
    public var name: String
    /// How many times it happened since the process started.
    public var total: Int
    /// That total spread over the process's life, for a first look.
    public var perMinuteSinceStart: Double

    var json: WireJSON {
        ["name": .string(name), "total": .int(total), "perMinuteSinceStart": .number(perMinuteSinceStart)]
    }
}

public struct CountersReading: Equatable, Sendable {
    /// How long the counters have been counting.
    public var elapsedMs: Double
    /// Every counter that has fired at least once, by name.
    public var counters: [CounterReading]

    public var json: WireJSON {
        ["elapsedMs": .number(elapsedMs), "counters": .array(counters.map(\.json))]
    }
}

/// The names, spelled once: a counter named at its call site is one typo
/// away from being a second counter nobody adds up.
public enum CounterName {
    /// A child process DevHub started, by program: `process.tmux`, `.git`, `.gh`.
    public static func process(_ program: String) -> String { "process.\(program)" }
    /// One completed round of the Agent reconciler.
    public static let agentReconcileRound = "agent.reconcile.round"
    /// One round of the Workspace terminals' activity loop: one `list-panes -a`.
    public static let terminalActivityRound = "terminal.activity.round"
    /// One `capture-pane` of one Agent's screen.
    public static let agentScreenCapture = "agent.screen.capture"
    /// One `list-sessions` on the Agent socket.
    public static let tmuxListSessions = "tmux.list-sessions"
    /// One slow round of the repository watcher: git status and GitHub.
    public static let repositoryStatusRound = "repository.status.round"
    /// One fast round of the repository watcher: which branch is checked out.
    public static let repositoryBranchRound = "repository.branch.round"
    /// One checkout whose git directory DevHub is watching for a checkout.
    public static let repositoryHeadWatch = "repository.head.watch"
    /// One checkout DevHub could not watch, and is therefore only polling.
    public static let repositoryHeadWatchFailed = "repository.head.watch.failed"
    /// One command the ssh ControlMaster refused, run on its own connection.
    public static let sshMuxFallback = "ssh.mux.fallback"
}

/// Totals since the process started. Reading is non-destructive: two
/// readings and the time between them is a rate, and any number of readers
/// can take one without taking it away from another.
public final class ActivityCounters: @unchecked Sendable {
    private let lock = NSLock()
    private var totals: [String: Int] = [:]
    private let clock: @Sendable () -> Double
    private let startedAt: Double

    public init(clock: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.clock = clock
        startedAt = clock()
    }

    public func record(_ name: String) {
        lock.lock()
        totals[name, default: 0] += 1
        lock.unlock()
    }

    public func read() -> CountersReading {
        lock.lock()
        let snapshot = totals
        lock.unlock()
        // A rate over zero time is not a number: it is reported as zero, the
        // only honest thing to say about a rate nobody has had time to observe.
        let elapsedMs = max(0, clock() - startedAt)
        let minutes = elapsedMs / 60_000
        let counters = snapshot.map { name, total in
            CounterReading(name: name, total: total, perMinuteSinceStart: minutes == 0 ? 0 : Double(total) / minutes)
        }.sorted { $0.name < $1.name }
        return CountersReading(elapsedMs: elapsedMs, counters: counters)
    }

    /// The process's one registry: the choke points that record are three
    /// layers below anything that could hand them a dependency. Tests make
    /// their own.
    public static let shared = ActivityCounters()
}

// MARK: - rollingTally.ts

/// How often something happened lately, in memory that does not grow.
///
/// A fixed ring of buckets covers the window; each event finds its bucket by
/// arithmetic and adds one; a bucket overtaken by the ring is cleared as it
/// is reused. The memory is the ring, whatever the rate, and nothing is
/// pruned on read, so nothing depends on being read. The oldest bucket is
/// included whole: a minute in sixty buckets answers for the last minute give
/// or take a second.
public final class RollingTally: @unchecked Sendable {
    private let lock = NSLock()
    private let bucketMs: Double
    private var epochs: [Int]
    private var counts: [[String: Int]]
    private let clock: @Sendable () -> Double

    public struct Refusal: Error, Equatable, CustomStringConvertible, Sendable {
        public let description: String
    }

    /// - Parameters:
    ///   - windowMs: how far back a reading looks.
    ///   - buckets: how finely the window is divided — the resolution of its
    ///     edge, and the whole of the memory this costs.
    public init(
        windowMs: Double, buckets: Int = 60,
        clock: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) throws {
        guard buckets >= 1 else { throw Refusal(description: "a rolling tally needs at least one bucket") }
        guard windowMs > 0 else { throw Refusal(description: "a rolling tally needs a window") }
        bucketMs = (windowMs / Double(buckets)).rounded(.up)
        epochs = Array(repeating: -1, count: buckets)
        counts = Array(repeating: [:], count: buckets)
        self.clock = clock
    }

    /// How many buckets the ring has. Fixed at construction.
    public var buckets: Int { epochs.count }

    private func epoch() -> Int { Int((clock() / bucketMs).rounded(.down)) }

    /// Count one event.
    public func record(_ key: String = "") {
        lock.lock()
        defer { lock.unlock() }
        let now = epoch()
        let index = ((now % epochs.count) + epochs.count) % epochs.count
        if epochs[index] != now {
            epochs[index] = now
            counts[index].removeAll(keepingCapacity: true)
        }
        counts[index][key, default: 0] += 1
    }

    private func live() -> [[String: Int]] {
        let oldest = epoch() - epochs.count + 1
        return epochs.indices.filter { epochs[$0] >= oldest }.map { counts[$0] }
    }

    /// How many of this key were counted inside the window.
    public func count(_ key: String = "") -> Int {
        lock.lock()
        defer { lock.unlock() }
        return live().reduce(0) { $0 + ($1[key] ?? 0) }
    }

    /// Every key with something in the window, and how much.
    public func totals() -> [String: Int] {
        lock.lock()
        defer { lock.unlock() }
        var totals: [String: Int] = [:]
        for bucket in live() {
            for (key, value) in bucket { totals[key, default: 0] += value }
        }
        return totals
    }

    /// How many counters this tally holds right now: at most one per key per
    /// bucket — the bound, said out loud.
    public func retained() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return counts.reduce(0) { $0 + $1.count }
    }
}

// MARK: - rounds.ts

/// How often each machine is being reconciled: a rolling minute per machine.
public final class ReconcileRounds: Sendable {
    private let rounds: RollingTally

    public init(clock: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        rounds = try! RollingTally(windowMs: 60_000, buckets: 60, clock: clock)
    }

    public func record(_ machine: String) { rounds.record(machine) }

    /// Rounds this machine completed in the last minute.
    public func lastMinute(_ machine: String) -> Int { rounds.count(machine) }

    public static let shared = ReconcileRounds()
}

// `RepositoryRoundTrigger` and `WorkspaceRepositoryRound` are WP4's
// (Git/RepositoryStatus.swift); a reading writes them as the TypeScript one does.
extension WorkspaceRepositoryRound {
    var json: WireJSON {
        [
            "workspaceId": .string(workspaceId),
            "lastRepositoryRound": [
                "at": .string(lastRepositoryRound.at), "trigger": .string(lastRepositoryRound.trigger.rawValue),
            ],
        ]
    }
}

// MARK: - metrics.ts

/// What DevHub knows about one of its own views: the process it runs in, what
/// it shows (a Workspace's surface key, or `chrome:<name>`), and whether it is
/// on screen.
public struct ViewIdentity: Equatable, Sendable {
    public var pid: Int
    public var id: Int
    public var surfaceKey: String?
    public var onScreen: Bool

    public init(pid: Int, id: Int, surfaceKey: String?, onScreen: Bool) {
        self.pid = pid
        self.id = id
        self.surfaceKey = surfaceKey
        self.onScreen = onScreen
    }

    var json: WireJSON {
        .object(dropping: [
            ("pid", .int(pid)), ("id", .int(id)), ("surfaceKey", .optional(surfaceKey)), ("onScreen", .bool(onScreen)),
        ])
    }
}

/// One process's CPU and memory, as the platform reports it.
public struct ProcessMetricInput: Equatable, Sendable {
    public var pid: Int
    public var type: String
    public var name: String?
    public var cpuPercent: Double
    public var memoryKb: Double

    public init(pid: Int, type: String, name: String? = nil, cpuPercent: Double, memoryKb: Double = 0) {
        self.pid = pid
        self.type = type
        self.name = name
        self.cpuPercent = cpuPercent
        self.memoryKb = memoryKb
    }
}

public struct ProcessReading: Equatable, Sendable {
    public var pid: Int
    public var type: String
    public var name: String?
    public var cpuPercent: Double
    public var memoryKb: Double
    /// Present only for a process DevHub recognises as one of its views.
    public var workbench: ViewIdentity?

    var json: WireJSON {
        .object(dropping: [
            ("pid", .int(pid)), ("type", .string(type)), ("name", .optional(name)), ("cpuPercent", .number(cpuPercent)),
            ("memoryKb", .number(memoryKb)), ("workbench", workbench?.json),
        ])
    }
}

/// One machine's answer to "is there a `devhub-terminal` on it".
public struct TerminalLauncherStatus: Equatable, Sendable {
    public var machine: String
    public var installed: Bool
    public var path: String?
    public var reason: String?

    public init(machine: String, installed: Bool, path: String? = nil, reason: String? = nil) {
        self.machine = machine
        self.installed = installed
        self.path = path
        self.reason = reason
    }

    var json: WireJSON {
        .object(dropping: [
            ("machine", .string(machine)), ("installed", .bool(installed)), ("path", .optional(path)),
            ("reason", .optional(reason)),
        ])
    }
}

/// One attached tmux client.
public struct TerminalClientReading: Equatable, Sendable {
    public var tty: String
    public var session: String

    public init(tty: String, session: String) {
        self.tty = tty
        self.session = session
    }
}

public struct MetricsInput: Sendable {
    public var takenAt: Double
    public var uptimeMs: Double
    /// `appearance.title_bar` as the window took it at launch.
    public var titleBar: String
    /// The native app is always `terminal`.
    public var workbench: String
    public var mainProcessCpu: (userMs: Double, systemMs: Double)
    public var processMetrics: [ProcessMetricInput]
    public var views: [ViewIdentity]
    public var counters: CountersReading
    public var terminalClients: [TerminalClientReading]
    /// WP3's readings, one per machine.
    public var runtimes: [RuntimeReading]
    public var terminalLauncher: [TerminalLauncherStatus]
    public var pendingSweeps: [String]
    public var repositoryRounds: [WorkspaceRepositoryRound]
    /// `NoticesReading` (diagnostics/notices.ts, the notices package's), as JSON.
    public var notices: WireJSON
    /// Reconcile rounds in the last minute, by machine.
    public var roundsLastMinute: @Sendable (String) -> Int

    public init(
        takenAt: Double, uptimeMs: Double, titleBar: String, workbench: String = "terminal",
        mainProcessCpu: (userMs: Double, systemMs: Double), processMetrics: [ProcessMetricInput] = [],
        views: [ViewIdentity] = [], counters: CountersReading, terminalClients: [TerminalClientReading] = [],
        runtimes: [RuntimeReading] = [], terminalLauncher: [TerminalLauncherStatus] = [], pendingSweeps: [String] = [],
        repositoryRounds: [WorkspaceRepositoryRound] = [],
        notices: WireJSON = ["lastMinute": .object([]), "flickering": []],
        roundsLastMinute: @escaping @Sendable (String) -> Int = { _ in 0 }
    ) {
        self.takenAt = takenAt
        self.uptimeMs = uptimeMs
        self.titleBar = titleBar
        self.workbench = workbench
        self.mainProcessCpu = mainProcessCpu
        self.processMetrics = processMetrics
        self.views = views
        self.counters = counters
        self.terminalClients = terminalClients
        self.runtimes = runtimes
        self.terminalLauncher = terminalLauncher
        self.pendingSweeps = pendingSweeps
        self.repositoryRounds = repositoryRounds
        self.notices = notices
        self.roundsLastMinute = roundsLastMinute
    }
}

public enum MetricsReport {
    /// `Date.prototype.toISOString`.
    public static func isoString(milliseconds: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: Date(timeIntervalSince1970: milliseconds / 1000))
    }

    /// The processes joined to DevHub's names for them, heaviest first: the
    /// question a reading answers is always "what is at the top". Several
    /// views can share one process; the one on screen names it.
    public static func processes(_ input: MetricsInput) -> [ProcessReading] {
        var byPid: [Int: ViewIdentity] = [:]
        for view in input.views {
            if let existing = byPid[view.pid], !(view.onScreen && !existing.onScreen) { continue }
            byPid[view.pid] = view
        }
        let readings = input.processMetrics.map {
            ProcessReading(
                pid: $0.pid, type: $0.type, name: $0.name, cpuPercent: $0.cpuPercent, memoryKb: $0.memoryKb,
                workbench: byPid[$0.pid])
        }
        // Stable, as `Array.prototype.sort` is.
        return readings.enumerated().sorted { left, right in
            left.element.cpuPercent != right.element.cpuPercent
                ? left.element.cpuPercent > right.element.cpuPercent : left.offset < right.offset
        }.map(\.element)
    }

    /// The reading `devhub --metrics` prints (`JSON.stringify(…, null, 2)`).
    public static func report(_ input: MetricsInput) -> WireJSON {
        let processes = processes(input)
        let runtimes: [WireJSON] = input.runtimes.map { runtime in
            let rounds = input.roundsLastMinute(runtime.id)
            return .object(dropping: [
                ("id", .string(runtime.id)), ("connected", .bool(runtime.connected)),
                ("masterPid", runtime.masterPid.map { .int(Int($0)) }),
                ("medianRoundTripMs", .number(runtime.medianRoundTripMs)),
                ("reconcileIntervalMs", .number(runtime.reconcileIntervalMs)),
                ("execsLastMinute", .int(runtime.execsLastMinute)), ("muxSessionsHeld", .int(runtime.muxSessionsHeld)),
                ("muxSessionsWaiting", .int(runtime.muxSessionsWaiting)), ("muxFallbacks", .int(runtime.muxFallbacks)),
                ("loginEnvironmentNames", .strings(runtime.loginEnvironmentNames)),
                ("lastFailure", .optional(runtime.lastFailure)), ("roundsPerMin", .int(rounds)),
                ("execPerRound", .number(rounds == 0 ? 0 : Double(runtime.execsLastMinute) / Double(rounds))),
            ])
        }
        return [
            "takenAt": .string(isoString(milliseconds: input.takenAt)),
            "uptimeMs": .number(input.uptimeMs),
            "titleBar": .string(input.titleBar),
            "workbench": .string(input.workbench),
            "mainProcessCpu": ["userMs": .number(input.mainProcessCpu.userMs), "systemMs": .number(input.mainProcessCpu.systemMs)],
            "processes": .array(processes.map(\.json)),
            "views": .array(input.views.map(\.json)),
            "totalCpuPercent": .number(processes.reduce(0) { $0 + $1.cpuPercent }),
            "counters": input.counters.json,
            "terminalClients": .array(input.terminalClients.map { ["tty": .string($0.tty), "session": .string($0.session)] }),
            "terminalLauncher": .array(input.terminalLauncher.map(\.json)),
            "pendingSweeps": .strings(input.pendingSweeps),
            "repositoryRounds": .array(input.repositoryRounds.map(\.json)),
            "notices": input.notices,
            "runtimes": .array(runtimes),
        ]
    }
}
