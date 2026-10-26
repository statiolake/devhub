// Port of the model-driving half of apps/desktop/src/main/shell/appController.ts
// (`AppController`: the coordinator's driver, its effect executor, and the
// failure routing), for terminal mode. Everything that is Electron's — the
// workbench views, their lifecycle, the BrowserWindow pages — is not here:
// terminal mode has no workbench, and the window is WP9's (`AppShell`).
//
// The controller owns the coordinator (a value), feeds it the person's
// intents and the services' completions, and carries out every effect it
// emits through the ports (`ControllerPorts.swift`). A request is answered
// with what its operation finally produced: a chain — inspect, confirm,
// clean up, save — keeps one operation identity, and the request waits for
// the end of it (`dispatchAwaiting`), bounded by `operationTimeoutMs`.
//
// The control socket (`ControlHandlers`), `devhub --tell` (`TellPorts`) and
// the file jump (`EditorOpenHost`) are implemented in
// `AppControllerControl.swift` on the same actor, with the calls the window
// makes, so an operation asked for on a command line is the one a click
// would have been.

import Foundation

/// What the controller is built from.
public struct AppControllerOptions: Sendable {
    public var stateStore: JsonStateStore
    /// The state file as loaded and marked starting.
    public var state: PersistedAppState
    /// The settings in force; nil when none could be read (the failure is
    /// already on its way to the person).
    public var config: Config?
    public var agents: (any AgentPort)?
    public var terminals: (any TerminalPort)?
    public var repositories: (any RepositoryPort)?
    public var machines: any MachinePort
    public var shell: any AppShell
    public var neovims: ManagedNeovims?
    /// What the control socket answers that is not the model's.
    public var controlExtras: ControlExtras
    /// The Issue flow, for `devhub --tell issue assign`.
    public var issueAssigner: (any IssueAssigner)?
    /// The login environment's PATH, which every profile lookup searches.
    public var launchPath: String
    /// Why the login environment could not be imported, when it could not.
    public var loginFailure: String?
    /// `DevHub <version>`.
    public var version: String
    /// How long a request waits for its operation (`OPERATION_TIMEOUT_MS`).
    public var operationTimeoutMs: Int
    /// Called with a broken invariant: the stack at that moment is the whole
    /// diagnosis, so the app stops (`crash`).
    public var crash: @Sendable (Error) -> Void
    /// The log.
    public var log: @Sendable (String) -> Void
    public var now: @Sendable () -> Double

    public init(
        stateStore: JsonStateStore, state: PersistedAppState, config: Config?, agents: (any AgentPort)? = nil,
        terminals: (any TerminalPort)? = nil, repositories: (any RepositoryPort)? = nil,
        machines: any MachinePort = RuntimeMachines(), shell: any AppShell = HeadlessShell(),
        neovims: ManagedNeovims? = nil, controlExtras: ControlExtras = ControlExtras(),
        issueAssigner: (any IssueAssigner)? = nil, launchPath: String = ProcessInfo.processInfo.environment["PATH"] ?? "",
        loginFailure: String? = nil, version: String = DevHubVersion.marketing,
        operationTimeoutMs: Int = CloseDeadline.budgetMs + 20_000,
        crash: @escaping @Sendable (Error) -> Void = { preconditionFailure(String(describing: $0)) },
        log: @escaping @Sendable (String) -> Void = { FileHandle.standardError.write(Data(($0 + "\n").utf8)) },
        now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.stateStore = stateStore
        self.state = state
        self.config = config
        self.agents = agents
        self.terminals = terminals
        self.repositories = repositories
        self.machines = machines
        self.shell = shell
        self.neovims = neovims
        self.controlExtras = controlExtras
        self.issueAssigner = issueAssigner
        self.launchPath = launchPath
        self.loginFailure = loginFailure
        self.version = version
        self.operationTimeoutMs = operationTimeoutMs
        self.crash = crash
        self.log = log
        self.now = now
    }
}

/// What the last repository round said, shared with the coordinator's
/// drawn-order rule (which is synchronous, and runs inside the coordinator).
final class RepositoryFactsBox: @unchecked Sendable {
    private let lock = NSLock()
    private var byWorkspace: [String: WorkspaceRepositoryWire] = [:]

    func replace(_ workspaces: [WorkspaceRepositoryWire]) {
        lock.withLock { byWorkspace = Dictionary(workspaces.map { ($0.workspaceId, $0) }, uniquingKeysWith: { _, last in last }) }
    }

    func status(_ workspaceId: String) -> WorkspaceRepositoryWire? { lock.withLock { byWorkspace[workspaceId] } }

    /// `repositoryOf`: the main worktree a Workspace's folder belongs to.
    func mainWorktree(_ workspaceId: String) -> String? { status(workspaceId)?.mainWorktree }
}

/// One message to the window, in the order the controller produced them.
enum ShellMessage: Sendable {
    case snapshot(AppSnapshotWire)
    case error(AppError)
    case condition(source: String, summary: String?, reason: String)
    case bringToFront
    case placeKeyboard
    case modal(ModalRequest)
    case quit
}

public actor AppController {
    var coordinator: AppCoordinator
    private var cursor = 0
    private var draining = false
    var state: PersistedAppState
    let stateStore: JsonStateStore
    var config: Config?
    let agents: (any AgentPort)?
    let terminals: (any TerminalPort)?
    let repositories: (any RepositoryPort)?
    let machines: any MachinePort
    let shell: any AppShell
    let neovims: ManagedNeovims?
    let controlExtras: ControlExtras
    let issueAssigner: (any IssueAssigner)?
    let launchPath: String
    let loginFailure: String?
    let version: String
    let operationTimeoutMs: Int
    let crash: @Sendable (Error) -> Void
    let log: @Sendable (String) -> Void
    let now: @Sendable () -> Double
    let repositoryFacts: RepositoryFactsBox
    /// The model as WP3's rounds read it (`TerminalAgentModel`).
    public nonisolated let mirror = ControllerModelMirror()
    let machineConditions: MachineConditions
    /// Each machine's pane activity, across rounds.
    var paneTrackers: [String: PaneActivityTracker] = [:]
    /// A terminal round's failure, said once per reason.
    var terminalActivityFailures = FailureOnce()
    /// The machines last seen with a Workspace, for `releaseIdleMachines`.
    var knownMachines: Set<String> = ["local"]
    /// Which automatic actions have fired, and for what.
    var automaticActions = AutomaticActions()
    /// Each machine's home, learned as it answers; this Mac's is known.
    var homes: [String: String] = ["local": NSHomeDirectory()]
    /// Agent terminals being started, which a tmux reading must not judge.
    var launchingTerminals: Set<String> = []
    /// Failures from before there was a window, kept until there is one.
    private var startupFailures: [AppError] = []
    private var shellOpen = false
    /// The file jump, built on first use (it needs the managed Neovims).
    var editorOpeningValue: EditorOpening<AppController>?

    private struct Pending {
        var waiters: [CheckedContinuation<IntentOutcome, Error>]
        var timer: Task<Void, Never>?
    }

    private var pending: [OperationId: Pending] = [:]
    private let outbox: AsyncStream<ShellMessage>.Continuation
    private let outboxReader: Task<Void, Never>

    public init(model: AppModel, options: AppControllerOptions) {
        let facts = RepositoryFactsBox()
        repositoryFacts = facts
        coordinator = AppCoordinator(model: model, drawnOrder: { snapshot in
            Projection.drawnWorkspaceOrder(snapshot, { facts.mainWorktree($0) })
        })
        state = options.state
        stateStore = options.stateStore
        config = options.config
        agents = options.agents
        terminals = options.terminals
        repositories = options.repositories
        machines = options.machines
        shell = options.shell
        neovims = options.neovims
        controlExtras = options.controlExtras
        issueAssigner = options.issueAssigner
        launchPath = options.launchPath
        loginFailure = options.loginFailure
        version = options.version
        operationTimeoutMs = options.operationTimeoutMs
        crash = options.crash
        log = options.log
        now = options.now
        let (stream, continuation) = AsyncStream<ShellMessage>.makeStream()
        outbox = continuation
        let shell = options.shell
        // One reader, so the window hears things in the order they happened.
        outboxReader = Task {
            for await message in stream {
                switch message {
                case let .snapshot(snapshot): await shell.publishSnapshot(snapshot)
                case let .error(error): await shell.publishError(error)
                case let .condition(source, summary, reason):
                    await shell.publishCondition(source: source, summary: summary, reason: reason)
                case .bringToFront: await shell.bringToFront()
                case .placeKeyboard: await shell.placeKeyboardOnSurface()
                case let .modal(request): await shell.openModal(request)
                case .quit: await shell.quit()
                }
            }
        }
        machineConditions = MachineConditions(publish: { source, summary, reason in
            continuation.yield(.condition(source: source, summary: summary, reason: reason))
        })
        mirror.update(coordinator.snapshot())
    }

    deinit {
        outbox.finish()
        outboxReader.cancel()
    }

    // MARK: - Startup and shutdown

    /// `createAppController`'s model half: the state file loaded, marked
    /// starting and saved, Scratch worked out for today, and the model
    /// hydrated from the file — a file the domain refuses kept and said,
    /// never silently started empty over.
    public static func start(
        stateStore: JsonStateStore, config: Config?, home: String = NSHomeDirectory(), now: Date = Date(),
        configure: (inout AppControllerOptions) -> Void = { _ in }
    ) async throws -> AppController {
        let load = try await stateStore.loadState()
        var state = load.state
        state.markStarting()
        try await stateStore.saveState(state)
        let profiles = (config?.agentProfiles ?? []).compactMap { profile in
            try? AgentProfile.create(
                id: profile.id, displayName: profile.displayName, kind: profile.kind, command: profile.command,
                args: profile.args, env: Array(profile.env.map { ($0.0, $0.1) }),
                presentation: profilePresentation(profile, agents: config!.agents)
            )
        }
        let daily = config?.scratch.daily ?? ScratchDaily.defaultTemplate
        let folder = try ScratchFolder.make(daily: daily, now: now, home: home)
        let today = Workspace(
            id: WorkspaceId(unchecked: UUID().uuidString.lowercased()), location: .local(path: folder.path),
            selectedPath: try DomainPaths.displayPath(folder.path)
        )
        var model: AppModel
        var projectionFailure: String?
        do {
            model = try StatePersistence.hydrate(state, profiles: profiles, today: today)
        } catch let error as StateError {
            projectionFailure = error.describe(stateStore.path)
            model = AppModel(scratch: today)
        }
        if folder.failure != nil {
            try model.markWorkspaceUnavailable(model.scratchWorkspaceId, .rootInaccessible)
        }
        var options = AppControllerOptions(stateStore: stateStore, state: state, config: config)
        configure(&options)
        let controller = AppController(model: model, options: options)
        if let detail = load.metadata.corruptionDetail ?? projectionFailure {
            await controller.noteStartupFailure(AppError.at(.persistenceDegraded).withDetail(detail))
        }
        if let failure = folder.failure {
            await controller.noteStartupFailure(AppError.at(.workspaceUnavailable).withDetail(failure))
        }
        if !load.metadata.migrationNotes.isEmpty {
            await controller.noteStartupFailure(
                AppError.at(.stateMigrated).withDetail(load.metadata.migrationNotes.joined(separator: " ")))
        }
        return controller
    }

    /// The window is up and listening: the failures from before it are
    /// delivered, once, in order, and the first snapshot with them.
    public func shellReady() {
        shellOpen = true
        publishSnapshot()
        for failure in startupFailures { outbox.yield(.error(failure)) }
        startupFailures = []
    }

    /// `noteStartupFailure`: a failure from before there was a window.
    public func noteStartupFailure(_ error: AppError) {
        if shellOpen {
            outbox.yield(.error(error))
        } else {
            startupFailures.append(error)
        }
    }

    /// `markReady`: the runtimes are up; the readiness the snapshot carries.
    public func markReady() {
        coordinator.markReady()
        publishSnapshot()
    }

    /// `shutdown`: the state saved as a clean exit.
    public func shutdown() async {
        do {
            state = try StatePersistence.apply(coordinator.snapshot(), to: state)
            state.markCleanShutdown()
            try await saveState()
        } catch {
            log("[devhub] the state could not be saved at shutdown: \(persistenceReason(error))")
        }
    }

    // MARK: - Reading

    public var model: AppModel { coordinator.model }
    public func snapshot() -> AppSnapshot { coordinator.snapshot() }
    public var currentConfig: Config? { config }

    /// The projection the window draws.
    public func snapshotWire() throws -> AppSnapshotWire {
        try Projection.snapshotWire(
            coordinator.snapshot(), readiness: coordinator.readiness, repositoryOf: repositoryOf, homeOf: homeOf
        )
    }

    nonisolated var repositoryOf: Projection.RepositoryOf {
        let facts = repositoryFacts
        return { facts.mainWorktree($0) }
    }

    var homeOf: Projection.HomeOf {
        let homes = homes
        return { location in homes[location.runtimeId] }
    }

    /// WP4's repository round answered: the facts the rows are drawn with.
    public func repositoryStatusChanged(_ workspaces: [WorkspaceRepositoryWire]) {
        repositoryFacts.replace(workspaces)
        publishSnapshot()
    }

    /// `adoptConfig`: settings accepted while running.
    public func adoptConfig(_ config: Config) {
        self.config = config
    }

    /// `learnHome`: a machine said where its home is.
    public func learnHome(_ machine: String, _ home: String) {
        if homes[machine] == home { return }
        homes[machine] = home
        publishSnapshot()
    }

    func publishSnapshot() {
        mirror.update(coordinator.snapshot())
        runAutomaticActions()
        do {
            outbox.yield(.snapshot(try snapshotWire()))
        } catch {
            crash(error)
        }
    }

    func publishError(_ error: AppError) { outbox.yield(.error(error)) }

    func bringToFrontNow() { outbox.yield(.bringToFront) }

    func placeKeyboardOnSurface() { outbox.yield(.placeKeyboard) }

    func openModal(_ request: ModalRequest) { outbox.yield(.modal(request)) }

    // MARK: - Dispatch

    /// The person did something in the window. Answered once its operation
    /// has an answer; refused with the words the refusal was drawn with.
    public func dispatch(_ intent: UserIntent) async throws -> IntentOutcome {
        try await dispatchAwaiting(intent)
    }

    /// A wire intent from the window, validated first.
    public func dispatchWire(_ intent: AppIntentWire) async throws -> IntentOutcome {
        try await dispatchAwaiting(try UserIntent.fromWire(intent))
    }

    /// `dispatchOwn`: an intent DevHub itself raised. Its refusal is drawn.
    @discardableResult
    func dispatchOwn(_ intent: UserIntent) -> IntentOutcome? {
        do {
            let outcome = try coordinator.dispatchUser(IntentEnvelope(intent: intent))
            drain()
            return outcome
        } catch {
            drain()
            if error is InvariantViolation {
                crash(error)
                return nil
            }
            publishError(errorWire(error))
            return nil
        }
    }

    /// `dispatchAwaiting`: dispatch, and take hold of the answer before the
    /// chain is allowed to run — some effects complete inside the drain, so
    /// a waiter registered afterwards would wait for an operation that ended.
    func dispatchAwaiting(_ intent: UserIntent) async throws -> IntentOutcome {
        do {
            return try await dispatchSettled(intent)
        } catch let error as NamedFailure {
            throw error
        } catch let error as StaleCompletion {
            throw error
        } catch {
            throw namedFailure(error)
        }
    }

    private func dispatchSettled(_ intent: UserIntent) async throws -> IntentOutcome {
        let outcome: IntentOutcome
        do {
            outcome = try coordinator.dispatchUser(IntentEnvelope(intent: intent))
        } catch {
            drain()
            switch Refusals.refusalOf(error, drawnAtSubject: false) {
            case .crash:
                crash(error)
                throw error
            case let .answer(publish, rejection):
                if let publish { publishError(publish) }
                throw rejection
            }
        }
        guard case let .deferred(operationId, _) = outcome else {
            drain()
            return outcome
        }
        return try await withCheckedThrowingContinuation { continuation in
            register(operationId, continuation)
            drain()
        }
    }

    /// `awaitOutcome`: one more waiter on an operation, bounded.
    private func register(_ id: OperationId, _ continuation: CheckedContinuation<IntentOutcome, Error>) {
        if pending[id] != nil {
            pending[id]!.waiters.append(continuation)
            return
        }
        let timeout = operationTimeoutMs
        let timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeout) * 1_000_000)
            if Task.isCancelled { return }
            await self?.reject(id, NamedFailure.at(.operationTimedOut))
        }
        pending[id] = Pending(waiters: [continuation], timer: timer)
    }

    private func settle(_ id: OperationId, _ outcome: IntentOutcome) {
        guard let waiting = pending[id] else { return }
        if case let .deferred(next, _) = outcome {
            // Still the same operation, one link further along — or carried
            // on under a new identity, which the waiters follow.
            if next == id { return }
            pending[id] = nil
            pending[next] = waiting
            return
        }
        pending[id] = nil
        waiting.timer?.cancel()
        for waiter in waiting.waiters { waiter.resume(returning: outcome) }
    }

    private func reject(_ id: OperationId, _ error: Error) {
        guard let waiting = pending[id] else { return }
        pending[id] = nil
        waiting.timer?.cancel()
        for waiter in waiting.waiters { waiter.resume(throwing: error) }
    }

    /// Feed a service's completion back in.
    func accept(_ event: ProviderEvent) {
        let id = event.token.operationId
        do {
            let outcome = try coordinator.acceptProviderEvent(ProviderEventEnvelope(event: event))
            settle(id, outcome)
        } catch {
            switch Refusals.completionRefusal(event, error) {
            case .crash:
                crash(error)
                reject(id, error)
            case let .answer(publish, rejection):
                if let publish { publishError(publish) }
                reject(id, rejection)
            }
        }
        drain()
    }

    /// Bound on the rounds one drain may take: a chain that does not settle
    /// in this many is a cycle.
    static let maxDrainRounds = 512

    /// Move everything the coordinator emitted since the last drain: the
    /// newest snapshot to the window, errors to the error surface, effects
    /// started.
    func drain() {
        if draining { return }
        draining = true
        defer { draining = false }
        var round = 0
        while true {
            round += 1
            if round > Self.maxDrainRounds {
                crash(InvariantViolation("the coordinator did not settle: an effect chain is cycling"))
                return
            }
            let subscription = coordinator.subscribeFrom(cursor)
            if subscription.events.isEmpty { break }
            cursor = subscription.cursor
            var latest = false
            var effects: [Effect] = []
            for sequenced in subscription.events {
                switch sequenced.event {
                case .snapshot: latest = true
                case let .error(failure): publishError(failure.wire)
                case let .effect(effect): effects.append(effect)
                case let .operationCompleted(token):
                    // A chain that ends without a provider event of its own —
                    // a reconcile superseded by a newer one — still ends.
                    if !coordinator.hasPending(token.operationId) {
                        settle(token.operationId, .noop(coordinator.snapshot()))
                    }
                case .noop: break
                }
            }
            if latest { publishSnapshot() }
            for effect in effects {
                // Performed with nobody waiting on them: a failure goes to the
                // error surface, a broken invariant stops the app.
                Task { await self.performReporting(effect) }
            }
        }
    }

    private func performReporting(_ effect: Effect) async {
        do {
            try await perform(effect)
        } catch {
            if error is InvariantViolation {
                crash(error)
                return
            }
            publishError(errorWire(error))
        }
    }

    // MARK: - Failures

    /// `failOperation`: refuse an operation, and say why where its subject is.
    func failOperation(_ token: OperationToken, _ failure: RefusedOperation) {
        reportFailure(failure)
        accept(.operationFailed(token, failure.wire))
    }

    /// `reportFailure`: deliver a failure to its subject's surface.
    func reportFailure(_ failure: RefusedOperation) {
        switch failure {
        case let .agent(id, code, detail):
            do {
                try coordinator.withModel { try $0.markAgentFailed(id, AgentFailure(code: code, detail: detail)) }
            } catch {
                // An Agent that has gone has no pane to draw it in.
                log("[devhub] a failure of agent \(id.rawValue) arrived after it went: \(code.rawValue)")
            }
            drain()
        case let .workspace(id, code, _):
            do {
                try coordinator.withModel { try $0.markWorkspaceUnavailable(id, code) }
            } catch {
                log("[devhub] a failure of workspace \(id.rawValue) arrived after it went: \(code.rawValue)")
            }
            drain()
        case let .machine(machine, _, detail):
            machineConditions.failed(
                machine,
                summary: detail.map { "DevHub is not getting an answer from \(machine). \($0)" }
                    ?? "DevHub is not getting an answer from \(machine)."
            )
        case .app:
            publishError(failure.wire)
        }
    }

    /// `saveState`: the state file, with the machines DevHub owns sessions on
    /// brought up to date. The list only grows here; the sweep is the one
    /// thing that shortens it.
    func saveState() async throws {
        var remembered = state.sessionMachines
        for machine in workspaceMachines() where !remembered.contains(machine) { remembered.append(machine) }
        state.sessionMachines = remembered
        try await stateStore.saveState(state)
    }

    /// `workspaceMachines`: every machine a Workspace is open on, this one
    /// always among them.
    func workspaceMachines() -> [String] {
        var machines = ["local"]
        for workspace in coordinator.model.workspaces where !machines.contains(workspace.location.runtimeId) {
            machines.append(workspace.location.runtimeId)
        }
        return machines
    }

    /// `persistenceReason`: what to tell the person about a save that did
    /// not happen.
    func persistenceReason(_ error: Error) -> String {
        if let error = error as? StateError { return error.describe(stateStore.path) }
        return "\(stateStore.path): \(failureText(error))"
    }

    // MARK: - Effects

    func perform(_ effect: Effect) async throws {
        switch effect {
        case .noop:
            return
        case .detach:
            outbox.yield(.quit)
        case let .persistState(token):
            await persist(token)
        case let .resolveWorkspacePath(token, location):
            await resolvePath(token, location)
        case let .generateWorkspaceId(token, _, _):
            accept(.workspaceIdGenerated(token, WorkspaceId(unchecked: UUID().uuidString.lowercased())))
        case let .generateAgentId(token, workspaceId):
            accept(.agentIdGenerated(token, workspaceId, AgentId(unchecked: UUID().uuidString.lowercased())))
        case let .generateConfirmationId(token, _):
            accept(.confirmationIdGenerated(token, ConfirmationId.random()))
        case let .resolveAgentProfile(token, workspaceId, profileId, extraArgs, resume):
            let result = await profileResolution(workspaceId, profileId, extraArgs, resume)
            accept(.profileResolutionCompleted(token, workspaceId, result))
        case let .inspectWorkspace(token, workspaceId):
            await inspect(token, workspaceId)
        case let .launchAgent(token, workspaceId, agentId, profile, presentation):
            await launchAgent(token, workspaceId, agentId, profile, presentation)
        case let .stopAgent(token, agentId, moveTerminal):
            await stopAgent(token, agentId, terminate: false, moveTerminal: moveTerminal)
        case let .terminateAgent(token, agentId):
            await stopAgent(token, agentId, terminate: true, moveTerminal: false)
        case let .restartAgent(token, agentId):
            try await restartAgent(token, agentId)
        case let .reconcileAgents(token, machine):
            try await reconcile(token, agentId: nil, machine: machine)
        case let .reconcileAgent(token, agentId):
            try await reconcile(token, agentId: agentId, machine: nil)
        case let .closeWorkspace(token, workspaceId, worktree):
            await closeWorkspaceResources(token, workspaceId, worktree)
        }
    }

    private func persist(_ token: OperationToken) async {
        do {
            state = try StatePersistence.apply(coordinator.snapshot(), to: state)
            try await saveState()
        } catch {
            // Reported as degraded, with the reason, so the model can roll back
            // a close that depended on it. Not also published here: the
            // coordinator says it once.
            accept(.statePersistenceFailed(token, reason: persistenceReason(error)))
            return
        }
        accept(.statePersisted(token))
    }

    private struct NotADirectory: Error, CustomStringConvertible {
        let path: String
        var description: String { "not a directory: \(path)" }
    }

    private func resolvePath(_ token: OperationToken, _ requested: RequestedWorkspaceLocation) async {
        let path = requested.path
        do {
            let machine: RuntimeId
            switch requested {
            case .local: machine = .local
            case let .ssh(host, _): machine = .ssh(host)
            }
            let paths = try machines.paths(machine)
            // `~` is the *far* machine's home for a far place.
            let expanded: String
            if path == "~" {
                expanded = try await paths.home()
            } else if path.hasPrefix("~/") {
                expanded = Path.join(try await paths.home(), String(path.dropFirst(2)))
            } else {
                expanded = path
            }
            let canonical = try await paths.realpath(expanded)
            if !(try await paths.isDirectory(canonical)) { throw NotADirectory(path: canonical) }
            let location: WorkspaceLocation
            switch requested {
            case .local: location = try WorkspaceLocation.make(.local(path: canonical))
            case let .ssh(host, _): location = try WorkspaceLocation.make(.ssh(host: host, path: canonical))
            }
            accept(.workspacePathResolved(token, location: location, selectedPath: try DomainPaths.displayPath(canonical)))
        } catch {
            failOperation(token, .app(
                code: .workspaceUnavailable,
                detail: "\(path)\(requested.whereText) could not be opened as a workspace: \(failureText(error))"
            ))
        }
    }

    /// `profileResolution`.
    func profileResolution(
        _ workspaceId: WorkspaceId, _ profileId: String, _ extraArgs: [String], _ resume: String?
    ) async -> AgentProfileResolution {
        guard let workspace = coordinator.model.workspace(workspaceId) else {
            return .failed(code: .workspaceUnavailable, detail: "The workspace this Agent belongs to is no longer open.")
        }
        return await profileOn(workspace.location, profileId, extraArgs, resume)
    }

    /// `profileOn`: the profile as a launch on `location`'s machine runs it.
    func profileOn(
        _ location: WorkspaceLocation, _ profileId: String, _ extraArgs: [String], _ resume: String?
    ) async -> AgentProfileResolution {
        guard let config, let configured = config.agentProfiles.first(where: { $0.id == profileId }) else {
            return .failed(code: .agentProfileUnavailable, detail: "There is no agent profile called “\(profileId)”.")
        }
        if resume != nil, configured.kind != .claude, configured.kind != .codex {
            return .failed(
                code: .agentProfileUnavailable,
                detail: "“\(configured.displayName)” is a \(configured.kind.rawValue) profile, which has no sessions to resume."
            )
        }
        // A resumed launch picks its session in place of any the profile's
        // own arguments pick, so its record says exactly one.
        var args = configured.args + extraArgs
        if let resume {
            do {
                args = try TerminalAgentCommand.withSession(
                    configured.kind, args: args, session: try TerminalAgentCommand.resumeArgs(configured.kind, session: resume))
            } catch {
                return .failed(code: .agentProfileUnavailable, detail: failureText(error))
            }
        }
        let resolution: ProgramResolution
        do {
            resolution = try await machines.resolveProgram(
                try RuntimeId.parse(location.runtimeId), configured.command, searchPath: launchPath)
        } catch {
            return .failed(code: .agentProfileUnavailable, detail: failureText(error))
        }
        guard let command = resolution.path else {
            return .failed(
                code: .agentProfileUnavailable,
                detail: Runtimes.executableMissingMessage(resolution, loginFailure: loginFailure)
                    ?? "DevHub could not find '\(configured.command)'."
            )
        }
        do {
            return .resolved(try AgentProfile.create(
                id: configured.id, displayName: configured.displayName, kind: configured.kind, command: command,
                args: args, env: Array(configured.env.map { ($0.0, $0.1) }),
                presentation: profilePresentation(configured, agents: config.agents)
            ))
        } catch {
            return .failed(code: .agentProfileUnavailable, detail: failureText(error))
        }
    }

    /// The terminal half of the close inspection, in the model's words.
    static func resource(_ inspection: TerminalResourceInspection) -> ResourceInspection {
        switch inspection {
        case .clean: return .clean
        case let .busy(count): return .busy(count: count)
        case let .unknown(diagnostic, reason):
            return .unknownResource(DiagnosticCode(rawValue: diagnostic) ?? .closeTerminalUnknown, reason: reason)
        }
    }

    private func inspect(_ token: OperationToken, _ workspaceId: WorkspaceId) async {
        let workspace = coordinator.model.workspace(workspaceId)
        // Only the Agents stopping would interrupt (`agentsInspection`).
        let agentsInspection = ResourceInspection.agents((workspace?.agents ?? []).map { ($0.status, $0.failure) })
        var terminal = TerminalInspection.clean
        if let terminals, let workspace, let machine = try? RuntimeId.parse(workspace.location.runtimeId) {
            terminal = await terminals.inspect(
                TerminalWorkspacePlace(machine: machine, workspaceId: workspace.id.rawValue, root: workspace.root))
        }
        accept(.workspaceInspectionCompleted(token, workspaceId, CloseInspectionInputs(
            agents: agentsInspection,
            terminalProcesses: Self.resource(terminal.process),
            terminalPanes: Self.resource(terminal.extraPanes),
            terminalWindows: Self.resource(terminal.extraWindows),
            // Terminal mode's editor is the managed Neovim, which keeps its
            // own buffers: there is no workbench to ask about unsaved tabs.
            unsavedEditors: .clean
        )))
    }

    private func launchAgent(
        _ token: OperationToken, _ workspaceId: WorkspaceId, _ agentId: AgentId, _ profile: AgentProfile,
        _ presentation: AgentPresentation
    ) async {
        let workspace = coordinator.model.workspace(workspaceId)
        guard let agents, let workspace else {
            failOperation(token, agents == nil
                ? .agent(agentId, code: .agentRuntimeUnavailable, detail: "The Agent runtime is not running, so no Agent can be started.")
                : .agent(agentId, code: .workspaceUnavailable, detail: "The workspace this Agent belongs to is no longer open."))
            return
        }
        let result = await agents.launch(
            workspaceId: workspaceId, agentId: agentId, profile: profile, presentation: presentation, root: workspace.root)
        accept(.agentLaunchCompleted(token, workspaceId, agentId, result))
    }

    private func stopAgent(_ token: OperationToken, _ agentId: AgentId, terminate: Bool, moveTerminal: Bool) async {
        guard let agents else {
            failOperation(token, .agent(
                agentId, code: .agentRuntimeUnavailable, detail: "The Agent runtime is not running, so no Agent can be stopped."))
            return
        }
        if moveTerminal {
            do {
                try await moveAgentTerminalToEditor(agentId)
            } catch {
                // Not stopped: stopping would end what the person chose to keep.
                accept(.agentStopCompleted(token, agentId, .failed(
                    code: .tmuxCommandFailed,
                    detail: "DevHub could not move the terminal to the editor, so the Agent was not stopped: \(failureText(error))"
                )))
                return
            }
        }
        if terminate {
            accept(.agentTerminationCompleted(token, agentId, await agents.terminate(agentId)))
        } else {
            accept(.agentStopCompleted(token, agentId, await agents.stop(agentId)))
        }
    }

    private func restartAgent(_ token: OperationToken, _ agentId: AgentId) async throws {
        guard let agents else {
            throw InvariantViolation("a restart was dispatched before the Agent adapter was wired")
        }
        if coordinator.model.agent(agentId)?.presentation == .tui {
            do {
                try await agents.restartTerminal(agentId)
            } catch let error as NamedFailure {
                publishError(error.wire)
                accept(.operationFailed(token, error.wire))
                return
            } catch {
                let refusal = agentPortRefusal(error)
                failOperation(token, .agent(
                    agentId, code: refusal.code,
                    detail: refusal.detail ?? "DevHub could not start the CLI again: \(failureText(error))"))
                return
            }
            accept(.agentRestartCompleted(token, agentId))
            return
        }
        do {
            try await agents.restartConversation(agentId)
        } catch let error as NamedFailure {
            // The conversation's refusal or failure, and a host that could not
            // start it again, are the person's news; anything else is a bug.
            publishError(error.wire)
            accept(.operationFailed(token, error.wire))
            return
        }
        accept(.agentRestartCompleted(token, agentId))
    }

    /// The machine an Agent runs on: the one its Workspace's folder is on.
    func machineOfAgent(_ agentId: AgentId) -> String? {
        coordinator.model.workspaceForAgent(agentId)?.location.runtimeId
    }

    func machineOf(_ workspaceId: WorkspaceId) -> String? {
        coordinator.model.workspace(workspaceId)?.location.runtimeId
    }

    private func reconcile(_ token: OperationToken, agentId: AgentId?, machine: String?) async throws {
        guard let agents else {
            // DevHub's own adapter not being there is DevHub's bug, not the
            // machine's failure, and a bug is not a notice.
            throw InvariantViolation("a reconcile round was dispatched before the Agent adapter was wired")
        }
        guard let asked = machine ?? agentId.flatMap(machineOfAgent) else {
            failOperation(token, .agentSubject(
                agentId, code: .agentRuntimeUnavailable,
                detail: "The Workspace this Agent belongs to is no longer open, so there is no machine to ask about it."))
            return
        }
        let reconciliation: AgentReconciliation
        do {
            reconciliation = try await agents.reconcile(machine: asked, agentId: agentId)
        } catch {
            log("[devhub] a reconcile round on \(asked) failed: \(failureText(error))")
            let refusal = agentPortRefusal(error)
            failOperation(token, .agentSubject(agentId, code: refusal.code, detail: refusal.detail, machine: asked))
            return
        }
        machineConditions.succeeded(asked)
        guard let agentId else {
            accept(.agentsReconciled(token, reconciliation))
            return
        }
        if reconciliation.exited.contains(agentId) {
            accept(.agentExited(token, agentId))
            return
        }
        guard let observation = reconciliation.observations.first(where: { $0.agentId == agentId }) else {
            failOperation(token, .agent(
                agentId, code: .tmuxCommandFailed, detail: "The Agent runtime answered without saying anything about this Agent."))
            return
        }
        accept(.agentStatusChanged(token, agentId, status: observation.status, runtimeHealth: observation.runtimeHealth))
    }

    /// Run the whole close, in order, and answer with one outcome. Every step
    /// after the editor treats "already gone" as success, so repeating a
    /// failed close is correct; a step that genuinely fails names itself.
    private func closeWorkspaceResources(
        _ token: OperationToken, _ workspaceId: WorkspaceId, _ worktree: WorktreeDisposition
    ) async {
        var step = CloseStep.editor
        var leftRunning: [String] = []
        let closing = coordinator.model.workspace(workspaceId)
        do {
            // Terminal mode's editor is the managed Neovim: it goes with its
            // Workspace, in the step a workbench's unload is in.
            if let closing, TerminalMode.supports(location: closing.location, editor: closing.editor), let neovims {
                let target = WorkspaceTerminalTarget(machine: .local, workspaceId: closing.id.rawValue, root: closing.root)
                try await CloseDeadline.run(step) { try await neovims.close(target) }
            }

            step = .agents
            if let agents {
                try await closeSessionsOnMachine(step, workspaceId, &leftRunning) {
                    try await agents.closeWorkspaceAgents(workspaceId)
                }
            }

            step = .terminal
            if let terminals, let closing, let machine = try? RuntimeId.parse(closing.location.runtimeId) {
                let place = TerminalWorkspacePlace(machine: machine, workspaceId: closing.id.rawValue, root: closing.root)
                try await closeSessionsOnMachine(step, workspaceId, &leftRunning) {
                    try await terminals.closeWorkspaceTerminals(place)
                }
            }

            // Terminal mode has no workbench view to take down and no
            // container it attached.
            step = .view

            step = .worktree
            try await disposeWorktree(workspaceId, worktree)
        } catch {
            let diagnostic = (error as? CloseTimeout)?.diagnostic ?? .cleanupFailed
            accept(.workspaceCloseCompleted(token, workspaceId, .failed(
                step: step, diagnostic: diagnostic, detail: error is NamedFailure || error is CodedFailure ? failureText(error) : nil)))
            return
        }
        if !leftRunning.isEmpty {
            publishError(AppError.at(.workspaceSessionsLeftRunning).withDetail(CloseDeadline.sessionsLeftRunningDetail(leftRunning)))
        }
        accept(.workspaceCloseCompleted(token, workspaceId, .closed))
    }

    /// `closeSessionsOnMachine`: a machine that does not answer cannot have
    /// anything stopped on it; the close goes on and says what was left.
    private func closeSessionsOnMachine(
        _ step: CloseStep, _ workspaceId: WorkspaceId, _ leftRunning: inout [String],
        _ work: @escaping @Sendable () async throws -> Void
    ) async throws {
        do {
            try await CloseDeadline.run(step, work)
        } catch {
            let worded: Error = error is CodedFailure ? namedFailure(error) : error
            guard let machine = machineOf(workspaceId), let left = CloseDeadline.sessionsLeftRunning(step, machine: machine, worded) else {
                throw error
            }
            log("[devhub] close: \(left) could not be stopped — \(failureText(error))")
            leftRunning.append(left)
        }
    }

    /// `disposeWorktree`: do what the person said about the folder. The
    /// branch is never touched.
    private func disposeWorktree(_ workspaceId: WorkspaceId, _ disposition: WorktreeDisposition) async throws {
        if disposition == .keep { return }
        guard let workspace = coordinator.model.workspace(workspaceId) else { return }
        guard let repositories else {
            throw CodedFailure.workspace("This workspace is not a worktree of a repository DevHub can see.")
        }
        let repository = repositoryFacts.status(workspaceId.rawValue)
        try await CloseDeadline.run(.worktree) {
            try await repositories.disposeWorktree(
                location: workspace.location, root: workspace.root, repository: repository, force: disposition == .removeAnyway)
        }
    }
}
