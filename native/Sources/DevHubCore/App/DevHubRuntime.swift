// Port of apps/desktop/src/main/shell/bootstrapShell.ts and of the runtime half
// of main/shell/appController.ts (`createAppController`, `startRuntimes`,
// `projectionChanged`'s nudges, `watchConfig`, `adoptConfig`'s model half,
// `startUsageReaders`, `adoptScratchDay`, `watchForWake`, `shutdown`), and of
// main/shell/terminalWiring.ts (`wireTerminals`, its terminal adapter).
//
// Bring everything up in the order the TS app does, which is the whole reason
// this is one place: the settings and the state first, because which tmux and
// which socket come from them; the login environment before anything is looked
// up in it; the terminal runtimes, the Agents on them, the managed Neovims and
// the `/devhub` skill; the controller around them; the sweep of what nothing
// accounts for; the loops; and the control socket last, because every request
// it accepts is answered by all of the above.
//
// Foundation only: the window is the App's (`AppShell`), handed in.

import Foundation

/// What the App knows about itself that Core cannot.
public struct RuntimeEnvironment: Sendable {
    public var locations: ProfileLocations
    /// This app's own executable: what `devhub` launches when nothing listens.
    public var appExecutable: String
    /// The `devhub` command inside the bundle, which the launchers exec.
    public var cliExecutable: String
    public var version: String
    public var processEnvironment: [String: String]
    /// `appearance.title_bar` as the window was made.
    public var titleBar: TitleBarMode

    public init(
        locations: ProfileLocations, appExecutable: String, cliExecutable: String, version: String = DevHubVersion.marketing,
        processEnvironment: [String: String] = ProcessInfo.processInfo.environment, titleBar: TitleBarMode = .shown
    ) {
        self.locations = locations
        self.appExecutable = appExecutable
        self.cliExecutable = cliExecutable
        self.version = version
        self.processEnvironment = processEnvironment
        self.titleBar = titleBar
    }
}

/// What the runtime tells the window that is not the model's projection.
public struct RuntimeHooks: Sendable {
    /// Each Workspace's branch, Issue and pull request, as of the last look.
    public var repositories: @Sendable (RepositoryStatusWire) -> Void
    /// The CLIs' plan limits.
    public var usageLimits: @Sendable (UsageLimitsWire) -> Void
    /// Settings were accepted (at launch, and on every save).
    public var config: @Sendable (Config) -> Void

    public init(
        repositories: @escaping @Sendable (RepositoryStatusWire) -> Void = { _ in },
        usageLimits: @escaping @Sendable (UsageLimitsWire) -> Void = { _ in },
        config: @escaping @Sendable (Config) -> Void = { _ in }
    ) {
        self.repositories = repositories
        self.usageLimits = usageLimits
        self.config = config
    }
}

/// The model as WP3's rounds read it, before the controller that keeps it
/// exists: everything is built before the controller is, and the controller
/// is built from everything.
final class LateModel: TerminalAgentModel, @unchecked Sendable {
    private let lock = NSLock()
    private var mirror: ControllerModelMirror?

    func set(_ mirror: ControllerModelMirror) { lock.withLock { self.mirror = mirror } }

    func workspaces() -> [TerminalAgentWorkspace] { lock.withLock { mirror }?.workspaces() ?? [] }
    func machine(of workspaceId: String) -> RuntimeId? { lock.withLock { mirror }?.machine(of: workspaceId) }
}

/// `TerminalAdapter` (terminalWiring.ts): WP3's port, with the close and the
/// inspection that count a Workspace's Agent terminals too.
struct WiredTerminalPort: TerminalPort {
    let base: TmuxTerminalPort
    let runtimeFor: @Sendable (RuntimeId) async throws -> TmuxTerminalRuntime

    func inspect(_ place: TerminalWorkspacePlace) async -> TerminalInspection {
        let runtime: TmuxTerminalRuntime
        do {
            runtime = try await runtimeFor(place.machine)
        } catch {
            return TerminalInspection.unknownRuntime("DevHub could not reach \(place.machine.rawValue): \(failureText(error))")
        }
        if let missing = runtime.unavailableReason { return TerminalInspection.unknownRuntime(missing) }
        var inspection = await base.inspect(place)
        // A busy Agent terminal of this Workspace is a process the close would end.
        let busy = ((try? await runtime.paneTerminals()) ?? []).filter { pane in
            pane.pane.workspaceId == place.workspaceId && !pane.pane.dead
                && !PaneActivity.isShellCommand(pane.pane.command, configuredShell: runtime.configuredShell)
        }.count
        if busy > 0 {
            switch inspection.process {
            case .unknown: break
            case .clean: inspection.process = .busy(count: busy)
            case let .busy(count): inspection.process = .busy(count: count + busy)
            }
        }
        return inspection
    }

    func closeWorkspaceTerminals(_ place: TerminalWorkspacePlace) async throws {
        let runtime = try await runtimeFor(place.machine)
        if runtime.unavailableReason == nil {
            for pane in try await runtime.paneTerminals() where pane.pane.workspaceId == place.workspaceId {
                try await base.surfaces.closePaneTerminal(PaneTerminalTarget(
                    machine: place.machine, terminalId: pane.terminalId, workspaceId: place.workspaceId, root: place.root))
            }
        }
        try await base.closeWorkspaceTerminals(place)
    }

    func unavailableReason(_ machine: RuntimeId) async throws -> String? { try await base.unavailableReason(machine) }
    func tmuxPath(_ machine: RuntimeId) async throws -> String { try await base.tmuxPath(machine) }
    func paneTerminals(_ machine: RuntimeId) async throws -> [PaneTerminalPane] { try await base.paneTerminals(machine) }
    func workspacePanes(_ machine: RuntimeId) async throws -> [WorkspacePane] { try await base.workspacePanes(machine) }
    func launchTerminal(_ target: PaneTerminalTarget) async throws { try await base.launchTerminal(target) }
    func typeIntoTerminal(_ target: PaneTerminalTarget, text: String) async throws { try await base.typeIntoTerminal(target, text: text) }
    func closePaneTerminal(_ target: PaneTerminalTarget) async throws { try await base.closePaneTerminal(target) }
    func closeTerminal(_ target: PaneTerminalTarget) async throws { try await base.closeTerminal(target) }
    func joinIntoTerminal(_ target: PaneTerminalTarget, paneId: String, replace: Bool) async throws {
        try await base.joinIntoTerminal(target, paneId: paneId, replace: replace)
    }
    func moveTerminalToWorkspace(_ target: PaneTerminalTarget) async throws { try await base.moveTerminalToWorkspace(target) }
    func profile(_ target: TerminalTarget) async throws -> TerminalProfileAnswer { try await base.profile(target) }
    func terminalPanes(_ machine: RuntimeId) async throws -> (panes: [PaneSample], terminals: [TerminalSessionSample]) {
        try await base.terminalPanes(machine)
    }
    func configuredShell(_ machine: RuntimeId) async throws -> String? { try await base.configuredShell(machine) }
    func forget(_ machine: RuntimeId) { base.forget(machine) }
}

extension TerminalInspection {
    /// A machine that cannot be asked: every resource is unknown, with the
    /// runtime's reason (`unknownResource("runtime_unavailable", reason)`).
    static func unknownRuntime(_ reason: String) -> TerminalInspection {
        let unknown = TerminalResourceInspection.unknown(diagnostic: DiagnosticCode.runtimeUnavailable.rawValue, reason: reason)
        return TerminalInspection(process: unknown, extraPanes: unknown, extraWindows: unknown)
    }
}

/// `SessionSweeper`'s world, on the real runtimes.
struct RuntimeSweepWorld: SessionSweepWorld {
    let runtimes: TerminalRuntimes
    let profileTag: String
    let controller: @Sendable () -> AppController?
    let accountedNow: @Sendable () -> SweepAccounting
    let machinesNow: @Sendable () -> [RuntimeId]
    let rememberedNow: @Sendable () -> [String]
    let forgetMachine: @Sendable (RuntimeId) -> Void

    func adapter(for machine: RuntimeId) async throws -> any SweepAdapter {
        try await runtimes.adapter(for: try MachineRuntimes.runtime(for: machine))
    }

    func hostFiles(for machine: RuntimeId) async throws -> any AgentHostFiles {
        try await agentHostFiles(RuntimeHostMachine(try MachineRuntimes.runtime(for: machine)), profileTag: profileTag)
    }

    func accounted() -> SweepAccounting { accountedNow() }
    func workspaceMachines() -> [RuntimeId] { machinesNow() }
    func remembered() -> [String] { rememberedNow() }
    func forget(_ machine: RuntimeId) { forgetMachine(machine) }
}

/// A sweep's view of the model, kept current by every snapshot.
final class Accounting: @unchecked Sendable {
    private let lock = NSLock()
    private var value = SweepAccounting()
    private var machines: [RuntimeId] = [.local]
    private var sessionMachines: [String] = ["local"]

    func update(_ snapshot: AppSnapshot, sessionMachines: [String]) {
        var workspaces = Set<String>(), agents = Set<String>(), terminals = Set<String>()
        var machines: [RuntimeId] = [.local]
        for workspace in snapshot.workspaces {
            workspaces.insert(workspace.id.rawValue)
            for agent in workspace.agents {
                agents.insert(agent.id.rawValue)
                if let terminal = agent.terminal { terminals.insert(terminal.terminalId) }
            }
            if let machine = try? RuntimeId.parse(workspace.location.runtimeId), !machines.contains(machine) {
                machines.append(machine)
            }
        }
        lock.withLock {
            value = SweepAccounting(workspaces: workspaces, agents: agents, terminals: terminals)
            self.machines = machines
            self.sessionMachines = sessionMachines
        }
    }

    var accounted: SweepAccounting { lock.withLock { value } }
    var workspaceMachines: [RuntimeId] { lock.withLock { machines } }
    var remembered: [String] { lock.withLock { sessionMachines } }
}

/// The shell the controller is given: the App's, with the runtime's own
/// nudges in front of every projection (`projectionChanged`).
final class RuntimeShell: AppShell, @unchecked Sendable {
    let app: any AppShell
    weak var runtime: DevHubRuntime?

    init(app: any AppShell) { self.app = app }

    func publishSnapshot(_ snapshot: AppSnapshotWire) async {
        await runtime?.projectionChanged()
        await app.publishSnapshot(snapshot)
    }

    func publishError(_ error: AppError) async { await app.publishError(error) }
    func publishCondition(source: String, summary: String?, reason: String) async {
        await app.publishCondition(source: source, summary: summary, reason: reason)
    }
    func bringToFront() async { await app.bringToFront() }
    func placeKeyboardOnSurface() async { await app.placeKeyboardOnSurface() }
    func notify(_ text: String) async throws { try await app.notify(text) }
    func runCommand(_ id: CommandId) async -> Bool { await app.runCommand(id) }
    func openModal(_ request: ModalRequest) async { await app.openModal(request) }
    func quit() async { await app.quit() }
}

/// Everything DevHub runs, brought up and taken down in one place.
public final class DevHubRuntime: @unchecked Sendable {
    /// How long a quit waits for the runtimes to let go (`SHUTDOWN_DEADLINE_MS`).
    public static let shutdownDeadlineMs = 3_000

    public let environment: RuntimeEnvironment
    public let configStore: ConfigStore
    public let stateStore: JsonStateStore
    public let controller: AppController
    public let terminalRuntimes: TerminalRuntimes
    public let surfaces: TerminalSurfaces
    /// The attach transport every terminal view uses.
    public let transport: SurfacesTransport
    public let agentWiring: TerminalAgentWiring
    public let neovims: ManagedNeovims
    public let finderOpens = FinderOpens()
    public let usageLimits = UsageLimits()
    public let startedAt: Double

    let hooks: RuntimeHooks
    let shell: RuntimeShell
    let accounting: Accounting
    let refusal: SettingsRefusal
    let reconcilers: AgentReconcilers
    let terminalActivity: AgentReconcilers
    var repositoryWatcher: RepositoryStatusWatcher?
    var usageReaders: UsageReaders?
    var sweeper: SessionSweeper?
    var scratch: ScratchFollower?
    var control: ControlServer?
    private var configWatch: UUID?
    private let lock = NSLock()
    private var lastRepositories = RepositoryStatusWire()
    private var stopped = false

    /// The control socket's path, for the app's single-instance check.
    public var controlSocketPath: String { environment.locations.controlSocketPath }

    /// The Workspaces' branch and pull-request facts, as of the last look.
    public var repositories: RepositoryStatusWire { lock.withLock { lastRepositories } }

    private init(
        environment: RuntimeEnvironment, configStore: ConfigStore, stateStore: JsonStateStore, controller: AppController,
        terminalRuntimes: TerminalRuntimes, surfaces: TerminalSurfaces, transport: SurfacesTransport,
        agentWiring: TerminalAgentWiring, neovims: ManagedNeovims, hooks: RuntimeHooks, shell: RuntimeShell,
        accounting: Accounting, refusal: SettingsRefusal
    ) {
        self.environment = environment
        self.configStore = configStore
        self.stateStore = stateStore
        self.controller = controller
        self.terminalRuntimes = terminalRuntimes
        self.surfaces = surfaces
        self.transport = transport
        self.agentWiring = agentWiring
        self.neovims = neovims
        self.hooks = hooks
        self.shell = shell
        self.accounting = accounting
        self.refusal = refusal
        startedAt = Date().timeIntervalSince1970 * 1000
        let controllerRef = controller
        reconcilers = AgentReconcilers(
            reconcile: { host in await controllerRef.reconcileAgents(on: host.id.rawValue) },
            onFailure: { error in MainLog.shared.error("[devhub] a reconcile round failed: \(failureText(error))") },
            record: { ActivityCounters.shared.record(CounterName.agentReconcileRound) }
        )
        terminalActivity = AgentReconcilers(
            reconcile: { host in await controllerRef.observeTerminals(on: host.id.rawValue) },
            onFailure: { error in MainLog.shared.error("[devhub] a terminal activity round failed: \(failureText(error))") },
            record: { ActivityCounters.shared.record(CounterName.terminalActivityRound) }
        )
    }

    /// `bootstrapShell` + `createAppController` + `startRuntimes`. The window
    /// (`app`) must already be able to take the controller's messages; they
    /// are delivered once `shellReady` is said.
    public static func start(_ environment: RuntimeEnvironment, app: any AppShell, hooks: RuntimeHooks = RuntimeHooks()) async throws
        -> DevHubRuntime
    {
        let locations = environment.locations
        let log: @Sendable (String) -> Void = { MainLog.shared.log($0) }
        MainLog.shared.install(path: locations.mainLogPath)
        log("[devhub] \(DevHubVersion.description) starting (profile \(locations.profile))")

        // The settings first: which tmux and which socket come from them. A
        // file that will not load is said, and the run is on the defaults.
        let configStore = ConfigStore(paths: ConfigPaths.defaults(for: locations))
        let refusal = SettingsRefusal(file: configStore.paths.file)
        var config: Config
        var startupFailures: [AppError] = []
        do {
            let loaded = try await configStore.load()
            config = loaded.config
        } catch {
            config = Config.defaults
            let notice = refusal.atLaunch(error)
            startupFailures.append(AppError.at(.settingsRefused).withDetail(notice.detail))
        }
        config = config.withProfileRuntimes(locations).config

        // The state's socket: a fresh state file adopts the configured one;
        // so does a profile that is not the default, whose whole purpose is
        // to share no tmux server.
        let stateStore = JsonStateStore(path: locations.stateFilePath)
        let fresh = !FileManager.default.fileExists(atPath: locations.stateFilePath)
        let recorded = (try? await stateStore.loadState())?.state.tmux.effectiveSocketName ?? StateSchema.defaultTmuxSocketName
        let socketName = fresh || !locations.isDefault ? config.runtimes.tmuxSocketName : recorded

        // The environment, resolved once, before anything is looked up in it.
        let login = await LoginEnvironment.resolve(
            enabled: config.general.importLoginEnvironment, processEnvironment: environment.processEnvironment)
        LoginEnvironment.adoptIntoProcess(login)
        let launch = LoginEnvironment.launchEnvironment(ProcessInfo.processInfo.environment)
        let launchPath = launch["PATH"] ?? ""
        let loginFailure: String? = { if case let .failed(shell, reason) = login { return "\(shell): \(reason)" } else { return nil } }()

        // The terminal runtimes, one per machine, and the surfaces on them.
        let terminalRuntimes = TerminalRuntimes(TerminalRuntimes.Options(
            settings: TmuxRuntimeSettings(config.runtimes),
            effectiveSocketName: socketName,
            userTmuxConfigPath: Path.join(locations.configDirectory, "tmux.conf"),
            controlSocketPath: locations.controlSocketPath,
            log: log,
            count: { ActivityCounters.shared.record($0) }
        ))
        let runtimeFor: @Sendable (RuntimeId) async throws -> TmuxTerminalRuntime = { machine in
            try await terminalRuntimes.adapter(for: try MachineRuntimes.runtime(for: machine))
        }
        let surfaces = TerminalSurfaces(runtimeFor: runtimeFor)

        // The `/devhub` skill and its launcher, rewritten for this run.
        let skill = DevhubSkill(userDataPath: locations.userDataDirectory)
        let skillWritten: DevhubSkill?
        do {
            try skill.write(launcher: DevhubInstall.launcherScript(InstallRequest(
                executable: environment.cliExecutable, socketPath: locations.controlSocketPath,
                commandName: locations.cliCommandName, profile: locations.profile,
                launchCommand: DevhubLaunch.launchCommand(forAppExecutable: environment.appExecutable),
                home: NSHomeDirectory(), pathValue: launchPath)))
            skillWritten = skill
        } catch {
            skillWritten = nil
            log("[devhub] could not write the /devhub agent skill: \(failureText(error))")
        }
        let model = LateModel()
        let wiring = TerminalAgentWiring(
            runtimeFor: runtimeFor, model: model,
            skilled: { machine, profile, args in
                DevhubSkill.arguments(kind: profile.kind.rawValue, args: args, skill: machine.isLocal ? skillWritten : nil)
            },
            log: log
        )
        let neovims = ControllerNeovims.make(
            userDataPath: locations.userDataDirectory, launchPath: { launchPath }, loginFailure: { loginFailure },
            local: { try await runtimeFor(.local) }, log: log
        )
        let base = TmuxTerminalPort(surfaces: surfaces, runtimeFor: runtimeFor, forget: { terminalRuntimes.forget($0) })
        let terminals = WiredTerminalPort(base: base, runtimeFor: runtimeFor)
        let shell = RuntimeShell(app: app)
        let accounting = Accounting()
        let gitPath = config.runtimes.git
        let extrasBox = ExtrasBox()

        let controller = try await AppController.start(stateStore: stateStore, config: config) { options in
            options.agents = TerminalAgentPort(wiring: wiring)
            options.terminals = terminals
            options.repositories = GitRepositoryPort(gitCommand: { _ in
                GitCommand(runtime: LocalRepositoryRuntime(), git: gitPath, environment: launch)
            })
            options.shell = shell
            options.neovims = neovims
            options.launchPath = launchPath
            options.loginFailure = loginFailure
            options.version = environment.version
            options.log = log
            options.crash = { error in
                MainLog.shared.error("[devhub] a broken invariant stopped DevHub: \(error)")
                preconditionFailure(String(describing: error))
            }
            options.controlExtras = ControlExtras(
                installCli: {
                    try DevhubInstall.installLauncher(InstallRequest(
                        executable: environment.cliExecutable, socketPath: locations.controlSocketPath,
                        commandName: locations.cliCommandName, profile: locations.profile,
                        launchCommand: DevhubLaunch.launchCommand(forAppExecutable: environment.appExecutable),
                        home: NSHomeDirectory(), pathValue: launchPath)).message
                },
                metrics: { try await extrasBox.runtime?.metrics() ?? "{}" }
            )
        }
        model.set(controller.mirror)
        for failure in startupFailures { await controller.noteStartupFailure(failure) }
        if case let .failed(shell, reason) = login {
            log("[devhub] the login environment could not be imported from \(shell): \(reason)")
        }

        let transport = SurfacesTransport(surfaces: surfaces) { [weak controller] key in
            guard let controller else { return nil }
            return try ShellLayout.target(forSurfaceKey: key, model: await controller.model)
        }
        let runtime = DevHubRuntime(
            environment: environment, configStore: configStore, stateStore: stateStore, controller: controller,
            terminalRuntimes: terminalRuntimes, surfaces: surfaces, transport: transport, agentWiring: wiring,
            neovims: neovims, hooks: hooks, shell: shell, accounting: accounting, refusal: refusal
        )
        extrasBox.runtime = runtime
        shell.runtime = runtime
        hooks.config(config)

        // The sweep of what nothing accounts for, on every machine DevHub has
        // ever owned sessions on — after a save, so a crash cannot make it
        // forget where they are.
        runtime.accounting.update(await controller.snapshot(), sessionMachines: await controller.state.sessionMachines)
        let sweeper = SessionSweeper(world: RuntimeSweepWorld(
            runtimes: terminalRuntimes,
            profileTag: TerminalLauncher.remoteProfileTag(controlSocketPath: locations.controlSocketPath),
            controller: { [weak controller] in controller },
            accountedNow: { [accounting] in accounting.accounted },
            machinesNow: { [accounting] in accounting.workspaceMachines },
            rememberedNow: { [accounting] in accounting.remembered },
            forgetMachine: { machine in Task { await controller.forgetSessionMachine(machine.rawValue) } }
        ), log: log)
        runtime.sweeper = sweeper
        await sweeper.sweepAll()

        await runtime.startLoops(config: config, launch: launch, launchPath: launchPath)
        await controller.markReady()
        return runtime
    }

    /// The loops and watchers, after the runtimes: the readers need the login
    /// environment, and nothing they do is on the way to a window.
    func startLoops(config: Config, launch: [String: String], launchPath: String) async {
        let controller = self.controller
        let mirror = controller.mirror
        let hooks = self.hooks
        let gitPath = config.runtimes.git
        let watcher = RepositoryStatusWatcher(deps: RepositoryStatusDeps(
            gitCommand: { runtime in GitCommand(runtime: runtime, git: gitPath, environment: launch) },
            environment: launch,
            workspaces: {
                mirror.workspaces().compactMap { workspace in
                    mirror.machine(of: workspace.id)?.isLocal == true
                        ? WatchedWorkspace(id: workspace.id, root: workspace.root, runtime: LocalRepositoryRuntime())
                        : nil
                }
            },
            publish: { [weak self] wire in
                self?.lock.withLock { self?.lastRepositories = wire }
                Task { await controller.repositoryStatusChanged(wire.workspaces) }
                hooks.repositories(wire)
            }
        ))
        repositoryWatcher = watcher
        await watcher.start()

        let usageLimits = self.usageLimits
        usageReaders = UsageReaders.start(UsageReaderDeps(
            profiles: config.agentProfiles,
            resolveProgram: { command in await MachineRuntimes.local.resolveProgram(command, searchPath: launchPath).path },
            environment: { launch },
            home: { NSHomeDirectory() },
            clientVersion: environment.version,
            deliver: { cli, reading in UsageLimitsFeed.deliver(usageLimits, cli, reading) { hooks.usageLimits($0) } },
            note: { cli, note in UsageLimitsFeed.note(usageLimits, cli, note) { hooks.usageLimits($0) } },
            report: { failure in Task { await controller.noteStartupFailure(errorWire(failure)) } }
        ))

        let home = NSHomeDirectory()
        let follower = ScratchFollower(daily: config.scratch.daily, home: home) { folder in
            await controller.adoptScratchDay(folder)
        }
        scratch = follower
        await follower.start()

        configWatch = await configStore.watch(intervalMs: 2_000) { [weak self] outcome in
            guard let self else { return }
            switch outcome {
            case let .success(loaded):
                Task { await self.adoptConfig(loaded.config) }
            case let .failure(failure):
                let notice = self.refusal.onReload(failure.diagnostic, running: true)
                Task { await controller.noteStartupFailure(AppError.at(.settingsRefused).withDetail(notice.detail)) }
            }
        }
        await projectionChanged()
    }

    /// `adoptConfig`: settings accepted while running — from the file or from
    /// the Settings window — and this run is on them from now on.
    public func adoptConfig(_ accepted: Config) async {
        let config = accepted.withProfileRuntimes(environment.locations).config
        refusal.accepted()
        await controller.adoptConfig(config)
        await scratch?.settingsAccepted(daily: config.scratch.daily)
        hooks.config(config)
    }

    /// What has to be true again whenever the projection changes: a machine
    /// that gained its first Agent gets a loop, one that lost its last has it
    /// stopped; the repository watcher looks at what is open now.
    func projectionChanged() async {
        if lock.withLock({ stopped }) { return }
        let controller = self.controller
        let agentMachines = await controller.agentMachines()
        let terminalMachines = await controller.terminalMachines()
        reconcilers.follow(agentMachines.compactMap(Self.host))
        terminalActivity.follow(terminalMachines.compactMap { Self.host($0).map(TerminalActivityLoop.host) })
        await controller.releaseIdleMachines()
        accounting.update(await controller.snapshot(), sessionMachines: await controller.state.sessionMachines)
        await repositoryWatcher?.observe()
    }

    static func host(_ machine: String) -> (any ReconcileHost)? {
        guard let id = try? RuntimeId.parse(machine), let runtime = try? MachineRuntimes.runtime(for: id) else { return nil }
        return ReconcileHostValue(runtime)
    }

    /// `Cmd+Q R`: look at every Workspace's branch, pull request and Issue now.
    public func refreshRepositories() async {
        await repositoryWatcher?.look()
    }

    /// The window came forward: the repository facts are refreshed, at most
    /// once a while (`RepositoryStatus.focused`).
    public func windowFocused() async {
        await repositoryWatcher?.focused()
    }

    /// A sleep ended (`watchForWake`): every loop asks again now, and Scratch
    /// catches up with a midnight it slept through.
    public func resumed() async {
        reconcilers.wake()
        terminalActivity.wake()
        await scratch?.resumed()
    }

    /// The control socket, opened once everything it answers exists. A socket
    /// another DevHub holds is the single-instance claim: it throws.
    public func openControlSocket() async throws {
        control = try await ControlServer.start(socketPath: environment.locations.controlSocketPath, handlers: controller)
        // The desktop's door, onto the same room: `devhub <path>`'s own entry.
        let controller = self.controller
        try await finderOpens.answer(
            with: FinderOpens.finderOpen { request in try await controller.open(request) },
            report: { error in await controller.noteStartupFailure(errorWire(error)) }
        )
    }

    /// `devhub --metrics`: a reading of the app's own cost.
    func metrics() async throws -> String {
        var usage = rusage()
        #if os(Linux)
        getrusage(RUSAGE_SELF.rawValue, &usage)
        #else
        getrusage(RUSAGE_SELF, &usage)
        #endif
        func ms(_ time: timeval) -> Double { Double(time.tv_sec) * 1000 + Double(time.tv_usec) / 1000 }
        let now = Date().timeIntervalSince1970 * 1000
        let input = MetricsInput(
            takenAt: now, uptimeMs: now - startedAt, titleBar: environment.titleBar.rawValue,
            mainProcessCpu: (ms(usage.ru_utime), ms(usage.ru_stime)),
            counters: ActivityCounters.shared.read(),
            pendingSweeps: sweeper?.pending.map(\.rawValue) ?? [],
            repositoryRounds: await repositoryWatcher?.rounds() ?? [],
            roundsLastMinute: { ReconcileRounds.shared.lastMinute($0) }
        )
        return MetricsReport.report(input).pretty
    }

    /// `shutdown`: the state written as a clean exit first — it records that
    /// the person asked to quit, whether or not the teardown below finishes —
    /// then every loop stopped, every client detached and every session left
    /// running. Bounded by `shutdownDeadlineMs`.
    public func shutdown() async {
        lock.withLock { stopped = true }
        control?.close()
        if let configWatch { await configStore.unwatch(configWatch) }
        await controller.shutdown()
        reconcilers.stop()
        terminalActivity.stop()
        await scratch?.stop()
        await repositoryWatcher?.stop()
        usageReaders?.stop()
        surfaces.detachAll()
        await neovims.dispose()
        MainLog.shared.log("[devhub] quit: shutdown finished")
    }
}

/// The runtime, for the metrics closure handed to the controller before the
/// runtime exists.
private final class ExtrasBox: @unchecked Sendable {
    weak var runtime: DevHubRuntime?
}

extension AppController {
    /// `adoptScratchDay`: make today's folder Scratch; one that cannot be made
    /// is said, and Scratch is unavailable with Retry and Locate….
    public func adoptScratchDay(_ folder: ScratchFolder) async {
        guard let location = try? WorkspaceLocation.make(.local(path: folder.path)),
              let selectedPath = try? DomainPaths.displayPath(folder.path) else { return }
        _ = try? await dispatchAwaiting(.adoptScratchDay(
            WorkspaceId(unchecked: UUID().uuidString.lowercased()), location: location, selectedPath: selectedPath))
        if let failure = folder.failure {
            _ = try? await dispatchAwaiting(.workspaceRootUnreadable(coordinator.model.scratchWorkspaceId, reason: .rootInaccessible))
            publishError(AppError.at(.workspaceUnavailable).withDetail(failure))
        }
    }

    /// The sweep has nothing left on a machine: it is not remembered any more.
    func forgetSessionMachine(_ machine: String) async {
        state.sessionMachines.removeAll { $0 == machine }
        try? await saveState()
    }
}
