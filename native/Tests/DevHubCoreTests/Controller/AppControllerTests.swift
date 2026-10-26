// The app controller driven end to end with fake services: what a request
// from the window, a `devhub` command or a `--tell` does to the model, which
// services it asks, what reaches the window, and what is written to
// `state.json`. The rules under test are appController.ts's: every effect is
// completed (never left to its deadline), a failure is shown at its subject,
// and a request is answered with what its operation finally produced.

import XCTest
@testable import DevHubCore

// MARK: - Fakes

final class Recorder<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [T] = []
    func add(_ item: T) { lock.withLock { items.append(item) } }
    var all: [T] { lock.withLock { items } }
}

struct FakePaths: MachinePaths {
    var home = "/home/person"
    var directories: Set<String>
    var files: Set<String> = []
    /// What a path resolves to (a symlink), when it is not itself.
    var links: [String: String] = [:]

    func home() async throws -> String { home }
    func realpath(_ path: String) async throws -> String {
        let resolved = links[path] ?? path
        if !directories.contains(resolved) && !files.contains(resolved) {
            throw RuntimeFileError(path: resolved, code: "ENOENT")
        }
        return resolved
    }
    func isDirectory(_ path: String) async throws -> Bool { directories.contains(path) }
    func stat(_ path: String) async throws -> PathMachineKind {
        let resolved = links[path] ?? path
        if directories.contains(resolved) { return .directory }
        if files.contains(resolved) { return .file }
        return .absent
    }
}

struct FakeMachines: MachinePort {
    var paths: FakePaths
    var missing: Set<String> = []

    func paths(_ machine: RuntimeId) throws -> any MachinePaths { paths }
    func whereText(_ machine: RuntimeId) -> String { machine.isLocal ? "" : " on \(machine.rawValue.dropFirst(4))" }
    func resolveProgram(_ machine: RuntimeId, _ command: String, searchPath: String) async throws -> ProgramResolution {
        if missing.contains(command) {
            return .unavailable(configured: command, lookup: .path(directories: ["/usr/bin"]), where: nil)
        }
        return .absolutePath("/usr/local/bin/\(command)")
    }
}

final class FakeAgents: AgentPort, @unchecked Sendable {
    let launches = Recorder<(AgentId, AgentProfile, AgentPresentation, String)>()
    let stops = Recorder<AgentId>()
    let closed = Recorder<WorkspaceId>()
    let injections = Recorder<(AgentId, String)>()
    var launchResult: AgentLaunchResult = .started
    var hangLaunch = false
    var reconciliation: (String, AgentId?) throws -> AgentReconciliation = { _, _ in AgentReconciliation() }
    var closeFailure: Error?

    func launch(workspaceId: WorkspaceId, agentId: AgentId, profile: AgentProfile, presentation: AgentPresentation, root: String) async -> AgentLaunchResult {
        launches.add((agentId, profile, presentation, root))
        if hangLaunch { try? await Task.sleep(nanoseconds: 30_000_000_000) }
        return launchResult
    }
    func stop(_ agentId: AgentId) async -> AgentStopResult {
        stops.add(agentId)
        return .stopped
    }
    func terminate(_ agentId: AgentId) async -> AgentStopResult { await stop(agentId) }
    func restartTerminal(_ agentId: AgentId) async throws {}
    func restartConversation(_ agentId: AgentId) async throws {}
    func reconcile(machine: String, agentId: AgentId?) async throws -> AgentReconciliation { try reconciliation(machine, agentId) }
    func closeWorkspaceAgents(_ workspaceId: WorkspaceId) async throws {
        closed.add(workspaceId)
        if let closeFailure { throw closeFailure }
    }
    let reviews = Recorder<Bool>()
    func queueInjection(_ agentId: AgentId, text: String, review: Bool) throws -> String {
        injections.add((agentId, text))
        reviews.add(review)
        return "injection"
    }
    func confirmInjection(_ agentId: AgentId, injectionId: String, text: String) throws -> Bool { true }
    func cancelInjection(_ agentId: AgentId, injectionId: String) -> Bool { true }
    func conversation(_ agentId: AgentId) async throws -> (any TellConversation)? { nil }
}

final class FakeTerminals: TerminalPort, @unchecked Sendable {
    let closedWorkspaces = Recorder<TerminalWorkspacePlace>()
    let launched = Recorder<PaneTerminalTarget>()
    let typed = Recorder<String>()
    let closedPanes = Recorder<PaneTerminalTarget>()
    let profiles = Recorder<TerminalTarget>()
    private let lock = NSLock()
    private var live: [PaneTerminalPane] = []

    func inspect(_ place: TerminalWorkspacePlace) async -> TerminalInspection { .clean }
    func closeWorkspaceTerminals(_ place: TerminalWorkspacePlace) async throws { closedWorkspaces.add(place) }
    func unavailableReason(_ machine: RuntimeId) async throws -> String? { nil }
    func tmuxPath(_ machine: RuntimeId) async throws -> String { "/usr/local/bin/tmux" }
    func paneTerminals(_ machine: RuntimeId) async throws -> [PaneTerminalPane] { lock.withLock { live } }
    func workspacePanes(_ machine: RuntimeId) async throws -> [WorkspacePane] { [] }
    func launchTerminal(_ target: PaneTerminalTarget) async throws {
        launched.add(target)
        lock.withLock { live.append(PaneTerminalPane(pane: Self.pane(target), terminalId: target.terminalId)) }
    }
    func typeIntoTerminal(_ target: PaneTerminalTarget, text: String) async throws { typed.add(text) }
    func closePaneTerminal(_ target: PaneTerminalTarget) async throws {
        closedPanes.add(target)
        lock.withLock { live.removeAll { $0.terminalId == target.terminalId } }
    }
    func closeTerminal(_ target: PaneTerminalTarget) async throws { try await closePaneTerminal(target) }
    func joinIntoTerminal(_ target: PaneTerminalTarget, paneId: String, replace: Bool) async throws {}
    func moveTerminalToWorkspace(_ target: PaneTerminalTarget) async throws {}
    var panes: [PaneSample] = []
    func terminalPanes(_ machine: RuntimeId) async throws -> (panes: [PaneSample], terminals: [TerminalSessionSample]) {
        (panes, lock.withLock { live.map { TerminalSessionSample(terminalId: $0.terminalId, workspaceId: $0.pane.workspaceId) } })
    }
    func configuredShell(_ machine: RuntimeId) async throws -> String? { "zsh" }
    let forgotten = Recorder<RuntimeId>()
    func forget(_ machine: RuntimeId) { forgotten.add(machine) }
    func profile(_ target: TerminalTarget) async throws -> TerminalProfileAnswer {
        profiles.add(target)
        return TerminalProfileAnswer(file: "/usr/local/bin/tmux", args: ["attach"], env: [:])
    }

    static func pane(_ target: PaneTerminalTarget) -> MarkedPane {
        MarkedPane(
            workspaceId: target.workspaceId, sessionName: "tm-\(target.terminalId)", windowId: "@1", windowIndex: 0,
            paneId: "%1", paneIndex: 0, active: true, windowActive: true, windowName: "zsh", command: "zsh", title: "",
            cwd: target.root, dead: false, socketPath: "/tmp/tmux-501/devhub", left: 0, top: 0, width: 80, height: 24, pid: 42)
    }
}

final class RecordingShell: AppShell, @unchecked Sendable {
    let snapshots = Recorder<AppSnapshotWire>()
    let errors = Recorder<AppError>()
    let conditions = Recorder<(String, String?)>()
    let fronts = Recorder<Void>()
    func publishSnapshot(_ snapshot: AppSnapshotWire) async { snapshots.add(snapshot) }
    func publishError(_ error: AppError) async { errors.add(error) }
    func publishCondition(source: String, summary: String?, reason: String) async { conditions.add((source, summary)) }
    func bringToFront() async { fronts.add(()) }
    func placeKeyboardOnSurface() async {}
    func notify(_ text: String) async throws {}
    func runCommand(_ id: CommandId) async -> Bool { true }
    let modals = Recorder<ModalRequest>()
    func openModal(_ request: ModalRequest) async { modals.add(request) }
    func quit() async {}
}

// MARK: - The rig

final class ControllerRig {
    let directory: String
    let store: JsonStateStore
    let agents = FakeAgents()
    let terminals = FakeTerminals()
    let shell = RecordingShell()
    let crashes = Recorder<String>()
    let controller: AppController

    init(
        directories: Set<String> = ["/work/api", "/work/web", "/scratch-test/junk/20260923"],
        files: Set<String> = ["/work/api/README.md"], missing: Set<String> = [], operationTimeoutMs: Int = 5_000,
        withAgents: Bool = true, issueAssigner: (any IssueAssigner)? = nil
    ) {
        directory = NSTemporaryDirectory() + "devhub-controller-\(UUID().uuidString)"
        try! FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        store = JsonStateStore(path: directory + "/state.json")
        let crashes = crashes
        controller = AppController(model: scratchModel(), options: AppControllerOptions(
            stateStore: store, state: .fresh(), config: Config.defaults, agents: withAgents ? agents : nil,
            terminals: terminals, machines: FakeMachines(paths: FakePaths(directories: directories, files: files), missing: missing),
            shell: shell, issueAssigner: issueAssigner, operationTimeoutMs: operationTimeoutMs, crash: { crashes.add(String(describing: $0)) },
            log: { _ in }
        ))
    }

    deinit { try? FileManager.default.removeItem(atPath: directory) }

    func open(_ path: String) async throws -> WorkspaceId {
        _ = try await controller.dispatch(.openFolder(.local(path: path)))
        let model = await controller.model
        guard let workspace = model.workspaces.first(where: { $0.root == path }) else { throw InvariantViolation("not opened") }
        return workspace.id
    }

    func createAgent(_ workspaceId: WorkspaceId, profile: String = "codex") async throws -> AgentId {
        _ = try await controller.dispatch(.createAgent(workspaceId: workspaceId, profileId: profile))
        let model = await controller.model
        guard let agent = model.workspace(workspaceId)?.agents.last else { throw InvariantViolation("no agent") }
        return agent.id
    }

    /// Everything queued for the window has been heard.
    func settled() async {
        for _ in 0..<50 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }

    func savedText() -> String { (try? String(contentsOfFile: directory + "/state.json", encoding: .utf8)) ?? "" }
}

private func refusal(_ body: () async throws -> Void) async -> AppError? {
    do {
        try await body()
        return nil
    } catch {
        return errorWire(error)
    }
}

// MARK: - Tests

final class AppControllerTests: XCTestCase {
    func testOpensAFolderOnItsMachineSelectsItAndSavesIt() async throws {
        let rig = ControllerRig()
        let id = try await rig.open("/work/api")
        let model = await rig.controller.model
        XCTAssertEqual(model.selection.context, .workspace(id))
        await rig.settled()
        XCTAssertTrue(rig.savedText().contains("/work/api"))
        XCTAssertEqual(rig.shell.snapshots.all.last?.workspaces.contains { $0.root == "/work/api" }, true)
    }

    func testOpensAFolderByWhatItsNameResolvesTo() async throws {
        let rig = ControllerRig(directories: ["/work/api", "/home/person/web", "/scratch-test/junk/20260923"])
        // `~` is the machine's own home, expanded there.
        let web = try await rig.open("/home/person/web")
        _ = try await rig.controller.dispatch(.openFolder(.local(path: "~/web")))
        let model = await rig.controller.model
        XCTAssertEqual(model.workspaces.filter { $0.root == "/home/person/web" }.count, 1)
        XCTAssertEqual(model.selection.context, .workspace(web))
        XCTAssertFalse(model.workspaces.contains { $0.root.hasPrefix("~") })
    }

    func testRefusesAFolderThatIsNotThereSayingWhere() async throws {
        let rig = ControllerRig()
        let error = await refusal { _ = try await rig.controller.dispatch(.openFolder(.local(path: "~/gone"))) }
        XCTAssertEqual(error?.code, .workspaceUnavailable)
        XCTAssertEqual(error?.detail?.hasPrefix("~/gone could not be opened as a workspace: "), true)
    }

    func testRefusesAFileWhereAFolderWasExpectedInItsOwnWords() async throws {
        let rig = ControllerRig()
        let error = await refusal { _ = try await rig.controller.dispatch(.openFolder(.local(path: "/work/api/README.md"))) }
        XCTAssertEqual(error?.code, .workspaceUnavailable)
        XCTAssertEqual(error?.detail, "/work/api/README.md could not be opened as a workspace: not a directory: /work/api/README.md")
        XCTAssertEqual(error?.reported, true)
        await rig.settled()
        // Drawn once, as the app's notice, because it has no other subject.
        XCTAssertEqual(rig.shell.errors.all.filter { $0.code == .workspaceUnavailable }.count, 1)
    }

    func testStartsAnAgentFromItsProfileResolvedOnTheWorkspacesMachine() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let agent = try await rig.createAgent(workspace)
        let launches = rig.agents.launches.all
        XCTAssertEqual(launches.count, 1)
        XCTAssertEqual(launches[0].0, agent)
        XCTAssertEqual(launches[0].1.command, "/usr/local/bin/codex")
        XCTAssertEqual(launches[0].3, "/work/api")
        let model = await rig.controller.model
        XCTAssertEqual(model.selection.context, .agent(agent))
    }

    func testRefusesAProfileWhoseProgramIsNotThereSayingWhichAndWhere() async throws {
        let rig = ControllerRig(missing: ["codex"])
        let workspace = try await rig.open("/work/api")
        let error = await refusal { _ = try await rig.controller.dispatch(.createAgent(workspaceId: workspace, profileId: "codex")) }
        XCTAssertEqual(error?.code, .agentProfileUnavailable)
        XCTAssertNotNil(error?.detail)
        XCTAssertTrue(rig.agents.launches.all.isEmpty)
    }

    func testRefusesAProfileTheSettingsDoNotHave() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let error = await refusal { _ = try await rig.controller.dispatch(.createAgent(workspaceId: workspace, profileId: "gemini")) }
        XCTAssertEqual(error?.code, .agentProfileUnavailable)
        XCTAssertEqual(error?.detail, "There is no agent profile called “gemini”.")
    }

    func testSaysWhichOfTheTwoWasMissingWhenNothingCanLaunchAnAgent() async throws {
        let rig = ControllerRig(withAgents: false)
        let workspace = try await rig.open("/work/api")
        let error = await refusal { _ = try await rig.controller.dispatch(.createAgent(workspaceId: workspace, profileId: "codex")) }
        XCTAssertEqual(error?.code, .agentRuntimeUnavailable)
        XCTAssertEqual(error?.detail, "The Agent runtime is not running, so no Agent can be started.")
    }

    func testARequestNothingCompletesIsRefusedAtItsDeadline() async throws {
        let rig = ControllerRig(operationTimeoutMs: 100)
        rig.agents.hangLaunch = true
        let workspace = try await rig.open("/work/api")
        let error = await refusal { _ = try await rig.controller.dispatch(.createAgent(workspaceId: workspace, profileId: "codex")) }
        XCTAssertEqual(error?.code, .operationTimedOut)
    }

    func testProjectsARoundOntoTheRows() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let agent = try await rig.createAgent(workspace)
        rig.agents.reconciliation = { _, _ in
            AgentReconciliation(observations: [AgentObservation(agentId: agent, status: .working, runtimeHealth: .healthy, activity: "Reading")])
        }
        _ = try await rig.controller.dispatch(.reconcileAgents(machine: "local"))
        let model = await rig.controller.model
        XCTAssertEqual(model.agent(agent)?.status, .working)
        XCTAssertEqual(model.agent(agent)?.activity, "Reading")
    }

    func testAMachineThatDoesNotAnswerIsAConditionSaidOnce() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        _ = try await rig.createAgent(workspace)
        rig.agents.reconciliation = { _, _ in throw PortFailure(.timedOut) }
        for _ in 0..<3 {
            _ = await refusal { _ = try await rig.controller.dispatch(.reconcileAgents(machine: "local")) }
        }
        await rig.settled()
        let raised = rig.shell.conditions.all.filter { $0.1 != nil }
        XCTAssertEqual(raised.count, 1)
        XCTAssertEqual(raised.first?.0, "machine:local")
        XCTAssertEqual(raised.first?.1, "DevHub is not getting an answer from local.")
        // Not also an app notice per round.
        XCTAssertTrue(rig.shell.errors.all.isEmpty)
    }

    func testAnAgentTheRoundSaysIsGoneLeavesItsRow() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let agent = try await rig.createAgent(workspace)
        rig.agents.reconciliation = { _, _ in AgentReconciliation(exited: [agent]) }
        _ = try await rig.controller.dispatch(.reconcileAgent(agent))
        let model = await rig.controller.model
        XCTAssertNil(model.agent(agent))
    }

    func testClosesAWorkspaceStepByStepAndForgetsIt() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        _ = try await rig.controller.dispatch(.requestCloseWorkspace(workspace, worktree: .keep))
        XCTAssertEqual(rig.agents.closed.all, [workspace])
        XCTAssertEqual(rig.terminals.closedWorkspaces.all.map(\.root), ["/work/api"])
        let model = await rig.controller.model
        XCTAssertNil(model.workspace(workspace))
        await rig.settled()
        XCTAssertFalse(rig.savedText().contains("/work/api"))
    }

    func testAsksBeforeClosingAWorkspaceWhoseAgentIsWorking() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let agent = try await rig.createAgent(workspace)
        rig.agents.reconciliation = { _, _ in
            AgentReconciliation(observations: [AgentObservation(agentId: agent, status: .working, runtimeHealth: .healthy)])
        }
        _ = try await rig.controller.dispatch(.reconcileAgents(machine: "local"))
        let outcome = try await rig.controller.dispatch(.requestCloseWorkspace(workspace, worktree: .keep))
        guard case let .confirmationRequired(confirmation, _, _) = outcome else { return XCTFail("\(outcome.kind)") }
        XCTAssertTrue(rig.agents.closed.all.isEmpty)
        _ = try await rig.controller.dispatch(.confirmCloseWorkspace(confirmation))
        XCTAssertEqual(rig.agents.closed.all, [workspace])
    }

    func testAClosePastAMachineThatDidNotAnswerCompletesAndSaysWhatWasLeft() async throws {
        let rig = ControllerRig()
        rig.agents.closeFailure = NamedFailure.at(.workspaceUnavailable, "DevHub cannot reach this Mac.")
        let workspace = try await rig.open("/work/api")
        _ = try await rig.controller.dispatch(.requestCloseWorkspace(workspace, worktree: .keep))
        let model = await rig.controller.model
        XCTAssertNil(model.workspace(workspace))
        await rig.settled()
        let left = rig.shell.errors.all.filter { $0.code == .workspaceSessionsLeftRunning }
        XCTAssertEqual(left.count, 1)
        XCTAssertTrue(left[0].detail?.hasPrefix("Agent sessions on local.") == true)
    }

    func testACloseThatFailsAtAStepNamesItAndKeepsTheWorkspace() async throws {
        let rig = ControllerRig()
        rig.agents.closeFailure = NamedFailure(AppError.at(.tmuxCommandFailed).withSummary("no such session"))
        let workspace = try await rig.open("/work/api")
        _ = await refusal { _ = try await rig.controller.dispatch(.requestCloseWorkspace(workspace, worktree: .keep)) }
        let model = await rig.controller.model
        guard case let .failed(step, _, detail)? = model.workspace(workspace)?.close else {
            return XCTFail("\(String(describing: model.workspace(workspace)?.close))")
        }
        XCTAssertEqual(step, .agents)
        XCTAssertEqual(detail, "no such session")
    }

    func testOpensAnAgentsOwnTerminalOnceAndShowsItAfterwards() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let agent = try await rig.createAgent(workspace)
        let first = try await rig.controller.openAgentTerminal(agent, command: "make test", focus: true)
        XCTAssertTrue(first.created)
        XCTAssertEqual(first.terminalId, agent.rawValue)
        XCTAssertEqual(rig.terminals.typed.all, ["make test"])
        let again = try await rig.controller.openAgentTerminal(agent, command: "make test", focus: false)
        XCTAssertFalse(again.created)
        XCTAssertEqual(rig.terminals.launched.all.count, 1)
        // Typed only into a terminal this call started.
        XCTAssertEqual(rig.terminals.typed.all, ["make test"])
        let model = await rig.controller.model
        XCTAssertEqual(model.agentTerminal(agent)?.open, true)
        let closed = try await rig.controller.closeAgentTerminal(agent)
        XCTAssertTrue(closed)
        let after = await rig.controller.model
        XCTAssertNil(after.agentTerminal(agent))
    }

    // MARK: the command line

    func testAnAgentFromTheCommandLineNeedsAWorkspaceAroundTheDirectory() async throws {
        let rig = ControllerRig(directories: ["/work/api", "/work/api/src", "/elsewhere", "/scratch-test/junk/20260923"])
        _ = try await rig.open("/work/api")
        let outside = await refusal { _ = try await rig.controller.addAgent(profileId: "codex", args: [], cwd: "/elsewhere") }
        XCTAssertEqual(
            outside?.detail,
            "/elsewhere is not inside any open DevHub workspace, and an agent needs one — open the folder first with 'devhub <folder>'.")
        let said = try await rig.controller.addAgent(profileId: "codex", args: ["--model", "o3"], cwd: "/work/api/src")
        XCTAssertEqual(said, "Codex 1 is running in the workspace at /work/api.")
        XCTAssertEqual(rig.agents.launches.all.first?.1.args, ["--model", "o3"])
    }

    func testAnUnknownProfileOnTheCommandLineNamesTheOnesThereAre() async throws {
        let rig = ControllerRig()
        do {
            _ = try await rig.controller.addAgent(profileId: "gemini", args: [], cwd: "/work/api")
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(
                controlFailureText(error),
                "there is no agent profile called 'gemini'. Configured profiles: codex, claude, cursor.")
        }
    }

    func testDevhubWithNothingAfterItBringsDevHubForward() async throws {
        let rig = ControllerRig()
        let said = try await rig.controller.activate()
        XCTAssertEqual(said, "DevHub is in front.")
        await rig.settled()
        XCTAssertEqual(rig.shell.fronts.all.count, 1)
    }

    func testATerminalIsAttachedToTheWorkspaceAroundItsDirectoryOrScratch() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        _ = try await rig.controller.terminalProfile(machine: "local", root: "/work/api/src", workspace: nil)
        _ = try await rig.controller.terminalProfile(machine: "local", root: "/nowhere", workspace: nil)
        let targets = rig.terminals.profiles.all
        guard case let .workspace(first) = targets[0], case let .workspace(second) = targets[1] else { return XCTFail() }
        XCTAssertEqual(first.workspaceId, workspace.rawValue)
        XCTAssertEqual(second.root, "/scratch-test/junk/20260923")
        let far = await refusal { _ = try await rig.controller.terminalProfile(machine: "ssh:box", root: "/srv", workspace: nil) }
        XCTAssertNotNil(far)
    }

    func testTellsTheWorkspacesAndTheirAgents() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let agent = try await rig.createAgent(workspace)
        let listed = await rig.controller.workspaces()
        XCTAssertEqual(listed.count, 2)
        let api = listed.first { $0.root == "/work/api" }
        XCTAssertEqual(api?.agents.map(\.id), [agent.rawValue])
        XCTAssertEqual(api?.agents.first?.kind, "codex")
        XCTAssertEqual(listed.first { $0.scratch }?.root, "/scratch-test/junk/20260923")
        // Creating an Agent selects it, so its Workspace is the selected one.
        XCTAssertEqual(api?.selected, true)
    }

    func testTellCreatesAnAgentAndAnswersItsId() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let id = try await rig.controller.createAgent(workspaceId: workspace.rawValue, profileId: "claude", presentation: nil)
        let model = await rig.controller.model
        XCTAssertEqual(model.agent(AgentId(unchecked: id))?.profile.id, "claude")
        try await rig.controller.queueText(id, text: "hello")
        XCTAssertEqual(rig.agents.injections.all.map(\.1), ["hello"])
    }

    func testTellsThePaletteCommandsWithoutTheOnesThatOnlyMakeSenseAtAKeyboard() async throws {
        let rig = ControllerRig()
        let commands = await rig.controller.commands()
        XCTAssertFalse(commands.contains { $0.id == "forward_prefix" || $0.id == "open_command_palette" })
        XCTAssertEqual(commands.count, Commands.all.count - 2)
    }

    func testTheEditorHostFindsTheWorkspaceAFileIsIn() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let place = try await rig.controller.place(root: "/work/api", machine: "local")
        XCTAssertEqual(place.workspaceId, workspace.rawValue)
        XCTAssertTrue(place.supported)
        let scratch = try await rig.controller.scratchPlace()
        XCTAssertEqual(scratch.root, "/scratch-test/junk/20260923")
        let routable = await rig.controller.routableWorkspaces()
        XCTAssertEqual(Set(routable.map(\.root)), ["/work/api", "/scratch-test/junk/20260923"])
    }

    func testAJumpBesideAnAgentSelectsTheSplit() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let agent = try await rig.createAgent(workspace)
        try await rig.controller.select(workspaceId: workspace.rawValue, besideAgent: agent.rawValue)
        let model = await rig.controller.model
        XCTAssertEqual(model.selection.context, .workspace(workspace))
        XCTAssertEqual(model.selection.presentation, .beside)
    }

    // MARK: agent actions

    func testSaysASmartButtonsActionToTheAgentFilledFromTheRepository() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let agent = try await rig.createAgent(workspace, profile: "claude")
        await rig.controller.repositoryStatusChanged([WorkspaceRepositoryWire(
            workspaceId: workspace.rawValue, branch: "feature/7-x", dirty: true, ahead: 0, defaultBranch: "main")])
        _ = try await rig.controller.runAgentAction(agentId: agent.rawValue, actionId: "commit_changes")
        let said = rig.agents.injections.all.filter { $0.0 == agent }
        XCTAssertFalse(said.isEmpty)
        XCTAssertEqual(rig.agents.reviews.all.last, false)
        await rig.settled()
        XCTAssertTrue(rig.shell.modals.all.isEmpty)
    }

    func testRefusesAnActionTheConfigurationDoesNotHaveInItsOwnWords() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let agent = try await rig.createAgent(workspace)
        let error = await refusal { _ = try await rig.controller.runAgentAction(agentId: agent.rawValue, actionId: "nope") }
        XCTAssertEqual(error?.summary, "There is no agent action called `nope` in the configuration.")
        let gone = await refusal { _ = try await rig.controller.runAgentAction(agentId: "nobody", actionId: "commit_changes") }
        XCTAssertEqual(gone?.summary, "That agent is not running.")
    }

    func testFiresATickedAutomaticActionWhenItsConditionArrives() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let agent = try await rig.createAgent(workspace)
        rig.agents.reconciliation = { _, _ in
            AgentReconciliation(observations: [AgentObservation(agentId: agent, status: .idle, runtimeHealth: .healthy)])
        }
        _ = try await rig.controller.dispatch(.reconcileAgents(machine: "local"))
        _ = try await rig.controller.dispatch(.setAutomaticAction(agent, actionId: "commit_changes", automatic: true))
        XCTAssertTrue(rig.agents.injections.all.isEmpty)
        await rig.controller.repositoryStatusChanged([WorkspaceRepositoryWire(
            workspaceId: workspace.rawValue, branch: "feature/7-x", dirty: true, ahead: 0, defaultBranch: "main")])
        XCTAssertEqual(rig.agents.injections.all.count, 1)
        // Once: the condition holding on is not news.
        await rig.controller.repositoryStatusChanged([WorkspaceRepositoryWire(
            workspaceId: workspace.rawValue, branch: "feature/7-x", dirty: true, ahead: 0, defaultBranch: "main")])
        XCTAssertEqual(rig.agents.injections.all.count, 1)
    }

    func testAssignsAnIssueFromTheCommandLineAndTellsTheAgentWhatItIsFor() async throws {
        struct Folder: IssueAssigner {
            func prepare(_ request: IssueAssignRequest) async throws -> RequestedWorkspaceLocation { .local(path: "/work/web") }
        }
        let rig = ControllerRig(issueAssigner: Folder())
        let assigned = try await rig.controller.assignIssue(IssueAssignRequest(
            url: "https://github.com/example/widget/issues/128", repo: nil, branch: nil, place: .worktree, profile: "claude",
            action: nil, editorOnly: false, presentation: nil))
        let model = await rig.controller.model
        XCTAssertEqual(model.workspace(WorkspaceId(unchecked: assigned.workspaceId))?.root, "/work/web")
        let agent = try XCTUnwrap(assigned.agentId)
        let said = try XCTUnwrap(rig.agents.injections.all.first { $0.0.rawValue == agent }?.1)
        XCTAssertTrue(said.contains("https://github.com/example/widget/issues/128"), said)
        // The Issue flow's first message is looked at before it goes.
        await rig.settled()
        guard case let .injectionReview(agentId, _, _, text)? = rig.shell.modals.all.last else { return XCTFail() }
        XCTAssertEqual(agentId, agent)
        XCTAssertEqual(text, said)
    }

    // MARK: the rounds

    func testATerminalRoundCarriesWhatTheWorkspacesPanesAreDoingOntoItsRow() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        rig.terminals.panes = [PaneSample(
            workspaceId: workspace.rawValue, pane: "%1", window: "@1", inView: false, command: "make", dead: false,
            windowActivity: nil, screen: "1:0:0")]
        await rig.controller.observeTerminals(on: "local")
        // Its screen moved since the round before: it is writing.
        rig.terminals.panes[0].screen = "2:0:0"
        await rig.controller.observeTerminals(on: "local")
        let model = await rig.controller.model
        XCTAssertEqual(model.snapshot().workspaces.first { $0.id == workspace }?.terminals.status, .working)
    }

    func testATerminalRoundTakesDownAnAgentTerminalWhoseShellEnded() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let agent = try await rig.createAgent(workspace)
        _ = try await rig.controller.openAgentTerminal(agent, command: nil, focus: false)
        // The shell exited: its session is gone from the server.
        let target = try await rig.controller.terminalTarget(agent).target
        try await rig.terminals.closePaneTerminal(target)
        try await Task.sleep(nanoseconds: 5_000_000)
        await rig.controller.observeTerminals(on: "local")
        let model = await rig.controller.model
        XCTAssertNil(model.agentTerminal(agent))
    }

    func testWritesDownEveryMachineAWorkspaceIsOpenOn() async throws {
        let rig = ControllerRig()
        _ = try await rig.open("/work/api")
        await rig.settled()
        XCTAssertEqual(rig.savedText().contains("\"session_machines\": [\n    \"local\"\n  ]"), true, rig.savedText())
    }

    func testReportsTheMachinesWithAgentsAndWithWorkspaces() async throws {
        let rig = ControllerRig()
        let workspace = try await rig.open("/work/api")
        let none = await rig.controller.agentMachines()
        XCTAssertEqual(none, [])
        _ = try await rig.createAgent(workspace)
        let some = await rig.controller.agentMachines()
        XCTAssertEqual(some, ["local"])
        let terminals = await rig.controller.terminalMachines()
        XCTAssertEqual(terminals, ["local"])
    }

    // MARK: startup

    func testAStateFileThatWouldNotLoadIsSaidOnceTheWindowIsListening() async throws {
        let directory = NSTemporaryDirectory() + "devhub-controller-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let path = directory + "/state.json"
        FileManager.default.createFile(atPath: path, contents: Data("{ not json".utf8), attributes: [.posixPermissions: 0o600])
        let shell = RecordingShell()
        let store = JsonStateStore(path: path)
        let controller = try await AppController.start(
            stateStore: store, config: Config.defaults, home: directory, now: Date(timeIntervalSince1970: 1_790_000_000)
        ) { options in options.shell = shell }
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertTrue(shell.errors.all.isEmpty)
        await controller.shellReady()
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(shell.errors.all.map(\.code), [.persistenceDegraded])
        // And the app started, on today's Scratch, with the file kept aside.
        let model = await controller.model
        XCTAssertEqual(model.workspaces.count, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: path + ".corrupt.0"))
    }

    func testAShutdownIsSavedAsAClean() async throws {
        let rig = ControllerRig()
        _ = try await rig.open("/work/api")
        await rig.controller.shutdown()
        let saved = rig.savedText()
        XCTAssertTrue(saved.contains("\"clean\": true"))
        XCTAssertTrue(saved.contains("/work/api"))
    }
}
