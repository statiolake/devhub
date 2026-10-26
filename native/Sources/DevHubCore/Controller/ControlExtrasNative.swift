// Port of the Core halves of `installCli` (apps/desktop/src/main/shell/bootstrapShell.ts)
// and `metricsFromCli` (apps/desktop/src/main/shell/appController.ts): what
// `devhub --install-cli` and `devhub --metrics` answer, on WP7a's
// `DevhubInstall` and `MetricsReport`.
//
// The parts of a metrics reading only the window knows — which views there
// are and which is on screen, the title bar the window took, the processes
// the platform reports — are inputs the App supplies (`MetricsSources`);
// everything DevHub counts itself (counters, reconcile rounds, the runtimes,
// the tmux clients, the sweeps, the repository rounds) is read here.

import Foundation

#if canImport(Glibc)
    import Glibc
#elseif canImport(Darwin)
    import Darwin
#endif

/// What `devhub --metrics` is read from.
public struct MetricsSources: Sendable {
    /// When this process started, in milliseconds since the epoch.
    public var startedAt: Double
    /// `appearance.title_bar` as the window took it at launch.
    public var titleBar: @Sendable () async -> String
    /// DevHub's own views (`chrome:<name>` and the Workspace surfaces), the
    /// App's to say.
    public var views: @Sendable () async -> [ViewIdentity]
    /// The processes the platform reports for this app.
    public var processMetrics: @Sendable () async -> [ProcessMetricInput]
    /// This Mac's tmux, when its runtime is up; nil before (a reading taken
    /// before the runtime is up has no clients to report).
    public var localTmux: @Sendable () async -> TmuxTerminalRuntime?
    public var runtimes: @Sendable () -> [RuntimeReading]
    public var terminalLauncher: @Sendable () -> [TerminalLauncherStatus]
    public var pendingSweeps: @Sendable () -> [String]
    public var repositoryRounds: @Sendable () -> [WorkspaceRepositoryRound]
    /// `NoticesReading`, as JSON.
    public var notices: @Sendable () -> WireJSON
    public var counters: ActivityCounters
    public var rounds: ReconcileRounds
    /// This process's own CPU time so far.
    public var cpu: @Sendable () -> (userMs: Double, systemMs: Double)
    public var now: @Sendable () -> Double

    public init(
        startedAt: Double, titleBar: @escaping @Sendable () async -> String = { "native" },
        views: @escaping @Sendable () async -> [ViewIdentity] = { [] },
        processMetrics: @escaping @Sendable () async -> [ProcessMetricInput] = { [] },
        localTmux: @escaping @Sendable () async -> TmuxTerminalRuntime? = { nil },
        runtimes: @escaping @Sendable () -> [RuntimeReading] = { MachineRuntimes.live().map { $0.reading() } },
        terminalLauncher: @escaping @Sendable () -> [TerminalLauncherStatus] = { [] },
        pendingSweeps: @escaping @Sendable () -> [String] = { [] },
        repositoryRounds: @escaping @Sendable () -> [WorkspaceRepositoryRound] = { [] },
        notices: @escaping @Sendable () -> WireJSON = { ["lastMinute": .object([]), "flickering": []] },
        counters: ActivityCounters = .shared, rounds: ReconcileRounds = .shared,
        cpu: @escaping @Sendable () -> (userMs: Double, systemMs: Double) = { MetricsSources.ownCpu() },
        now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.startedAt = startedAt
        self.titleBar = titleBar
        self.views = views
        self.processMetrics = processMetrics
        self.localTmux = localTmux
        self.runtimes = runtimes
        self.terminalLauncher = terminalLauncher
        self.pendingSweeps = pendingSweeps
        self.repositoryRounds = repositoryRounds
        self.notices = notices
        self.counters = counters
        self.rounds = rounds
        self.cpu = cpu
        self.now = now
    }

    /// `process.cpuUsage()`: this process's user and system time, in ms.
    public static func ownCpu() -> (userMs: Double, systemMs: Double) {
        var usage = rusage()
        #if os(Linux)
            let who = __rusage_who_t(RUSAGE_SELF.rawValue)
        #else
            let who = RUSAGE_SELF
        #endif
        guard getrusage(who, &usage) == 0 else { return (0, 0) }
        func ms(_ time: timeval) -> Double { (Double(time.tv_sec) * 1000 + Double(time.tv_usec) / 1000).rounded() }
        return (ms(usage.ru_utime), ms(usage.ru_stime))
    }

    /// How long a reading waits for tmux's client list (`METRICS_CLIENT_TIMEOUT_MS`).
    public static let clientTimeoutMs: Double = 2_000

    /// One reading (`metricsFromCli`), as the JSON `devhub --metrics` prints.
    public func reading() async throws -> WireJSON {
        // A terminal DevHub cannot reach has no clients to report; anything
        // else the runtime says goes up: a socket that will not answer is a
        // fact about DevHub, and `--metrics` is where those are read.
        var clients: [TerminalClientReading] = []
        if let tmux = await localTmux(), tmux.adapterAvailable {
            clients = try await tmux.listClientsUnlocked(
                cancel: CancellationToken(), deadline: .within(Self.clientTimeoutMs)
            ).map { TerminalClientReading(tty: $0.tty, session: $0.session) }
        }
        let now = now()
        let rounds = self.rounds
        return MetricsReport.report(MetricsInput(
            takenAt: now, uptimeMs: (now - startedAt).rounded(), titleBar: await titleBar(), workbench: "terminal",
            mainProcessCpu: cpu(), processMetrics: await processMetrics(), views: await views(),
            counters: counters.read(), terminalClients: clients, runtimes: runtimes(),
            terminalLauncher: terminalLauncher(), pendingSweeps: pendingSweeps(), repositoryRounds: repositoryRounds(),
            notices: notices(), roundsLastMinute: { rounds.lastMinute($0) }))
    }
}

extension ControlExtras {
    /// The native app's answers: `--install-cli` writes the launcher for
    /// `install` (the bundle's own `devhub`, this app's socket and profile),
    /// and `--metrics` is one reading of `metrics`, printed as
    /// `JSON.stringify(…, null, 2)` prints it.
    public static func native(install: @escaping @Sendable () -> InstallRequest, metrics: MetricsSources) -> ControlExtras {
        ControlExtras(
            installCli: { try DevhubInstall.installLauncher(install()).message },
            metrics: { try await metrics.reading().pretty })
    }
}

extension InstallRequest {
    /// The launcher for the app running now: the `devhub` beside it in the
    /// bundle (`Contents/Resources/bin/devhub`), started again by the bundle
    /// when nothing is listening on its socket.
    public static func forApp(
        appExecutable: String, cliExecutable: String, socketPath: String, commandName: String, profile: String,
        home: String = NSHomeDirectory(), pathValue: String = ProcessInfo.processInfo.environment["PATH"] ?? ""
    ) -> InstallRequest {
        InstallRequest(
            executable: cliExecutable, socketPath: socketPath, commandName: commandName, profile: profile,
            launchCommand: DevhubLaunch.launchCommand(forAppExecutable: appExecutable), home: home, pathValue: pathValue)
    }
}
