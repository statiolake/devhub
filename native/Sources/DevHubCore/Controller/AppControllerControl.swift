// Port of the command-line half of apps/desktop/src/main/shell/appController.ts
// for terminal mode: what the control socket's requests do
// (`activateFromCli`, `openFromCli`, `waitEndedFromCli`, `addAgentFromCli`,
// `versionFromCli`, `tellFromCli`, `terminalProfileFor`), the `devhub --tell`
// ports (`tellPorts`, `tellWorkspaces`), the file jump's host (the model half
// of `openInManagedNeovim`), and an Agent's own terminal (`openAgentTerminal`,
// `closeAgentTerminal`, `bringPane`, `moveAgentTerminalToEditor`).
//
// Every port is a call the window itself makes, so an operation asked for on
// a command line is the operation a click would have been.

import Foundation

/// What the control socket answers that is not the model's: set by the app
/// when it wires the socket (`bootstrapShell`).
public struct ControlExtras: Sendable {
    /// `devhub --install-cli`.
    public var installCli: @Sendable () async throws -> String
    /// `devhub --metrics`: a reading of the app's own cost, as JSON text.
    public var metrics: @Sendable () async throws -> String
    /// Where a workbench on a machine connects. The native app has no
    /// workbenches, so the default refuses.
    public var resolveRemote: @Sendable (String, Int) async throws -> RemoteResolution

    public init(
        installCli: @escaping @Sendable () async throws -> String = {
            throw ControlRefusal("This DevHub was started without its command-line installer.")
        },
        metrics: @escaping @Sendable () async throws -> String = {
            throw ControlRefusal("This DevHub was started without its metrics reading.")
        },
        resolveRemote: @escaping @Sendable (String, Int) async throws -> RemoteResolution = { _, _ in
            .refused(message: "DevHub (native) has no remote workbenches to connect.", retry: false)
        }
    ) {
        self.installCli = installCli
        self.metrics = metrics
        self.resolveRemote = resolveRemote
    }
}

/// A refusal of a command-line request, printed as it is.
public struct ControlRefusal: Error, Equatable, Sendable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

extension AppController {
    // MARK: - Lookups the command line shares

    /// `workspaceIdOf`: the model's own id for a Workspace named by its string.
    func workspaceIdOf(_ id: String) throws -> WorkspaceId {
        guard let workspace = coordinator.model.workspaces.first(where: { $0.id.rawValue == id }) else {
            throw ControlRefusal("no workspace \(id) is open")
        }
        return workspace.id
    }

    /// `workspaceAt`: the one Workspace rooted at a path on a machine.
    func workspaceAt(_ root: String, machine: String) throws -> Workspace {
        guard let workspace = coordinator.model.workspaces.first(where: { $0.root == root && $0.location.runtimeId == machine }) else {
            throw ControlRefusal("no workspace is rooted at \(root)")
        }
        return workspace
    }

    /// `workspaceRoots`: the roots of the open Workspaces on one machine.
    func workspaceRoots(_ machine: String) -> [String] {
        coordinator.model.workspaces.filter { $0.location.runtimeId == machine }.map(\.root)
    }

    /// `scratchWorkspace`.
    func scratchWorkspace() throws -> Workspace {
        let model = coordinator.model
        guard let scratch = model.workspace(model.scratchWorkspaceId) else {
            throw InvariantViolation("Scratch is not one of the model's workspaces")
        }
        return scratch
    }

    /// `openedWorkspaceId`: what an open just selected.
    func openedWorkspaceId(_ path: String) throws -> WorkspaceId {
        if case let .workspace(id) = coordinator.model.selection.context { return id }
        throw ControlRefusal("opening \(path) did not select a workspace")
    }

    func modelAgentIds() -> Set<AgentId> {
        Set(coordinator.model.workspaces.flatMap { $0.agents.map(\.id) })
    }

    func newAgent(_ before: Set<AgentId>) -> AgentId? {
        coordinator.model.workspaces.flatMap(\.agents).first { !before.contains($0.id) }?.id
    }

    /// `openFolder`: opening a folder is going there, keyboard and all.
    func openFolder(_ location: RequestedWorkspaceLocation, withAgent: (profileId: String, presentation: AgentPresentation)? = nil) async throws -> IntentOutcome {
        let opened = try await dispatchAwaiting(.openFolder(location))
        guard let withAgent else {
            placeKeyboardOnSurface()
            return opened
        }
        let settled = try await dispatchAwaiting(.createAgent(
            workspaceId: try openedWorkspaceId(location.path), profileId: withAgent.profileId, presentation: .full,
            agentPresentation: withAgent.presentation))
        placeKeyboardOnSurface()
        return settled
    }

    // MARK: - An Agent's own terminal

    /// `toggleAgentTerminal` (`Cmd+Q V`).
    public func toggleAgentTerminal(_ agentId: AgentId) async throws {
        let model = coordinator.model
        if let terminal = model.agentTerminal(agentId), terminal.open, model.terminalAgentId() == agentId {
            let focused = model.paneFocus != nil
            dispatchOwn(.agentTerminalShown(agentId, open: false, focus: false))
            if focused { placeKeyboardOnSurface() }
            return
        }
        _ = try await openAgentTerminal(agentId, command: nil, focus: true)
    }

    private func terminalPort() throws -> any TerminalPort {
        guard let terminals else { throw ControlRefusal("the terminal runtime is not running") }
        return terminals
    }

    /// `terminalOf`: an Agent's terminal's target on its Workspace's machine.
    func terminalTarget(_ agentId: AgentId, terminalId: String? = nil) throws -> (machine: RuntimeId, workspaceId: WorkspaceId, target: PaneTerminalTarget) {
        let model = coordinator.model
        guard let workspace = model.workspaceForAgent(agentId) else { throw ControlRefusal("there is no Agent \(agentId.rawValue)") }
        let machine = try RuntimeId.parse(workspace.location.runtimeId)
        return (machine, workspace.id, PaneTerminalTarget(
            machine: machine, terminalId: terminalId ?? model.agentTerminal(agentId)?.terminalId ?? agentId.rawValue,
            workspaceId: workspace.id.rawValue, root: workspace.root))
    }

    /// `openAgentTerminal`: open an Agent's own terminal, or show the one it
    /// has. Idempotent. Only once the session exists is the model told, so a
    /// pane is never drawn for a session that failed to start; `command` is
    /// typed only into a terminal this call started.
    public func openAgentTerminal(_ agentId: AgentId, command: String?, focus: Bool) async throws -> (terminalId: String, created: Bool) {
        let terminals = try terminalPort()
        let model = coordinator.model
        guard let workspace = model.workspaceForAgent(agentId) else { throw ControlRefusal("there is no Agent \(agentId.rawValue)") }
        let machine = try RuntimeId.parse(workspace.location.runtimeId)
        if let reason = try await terminals.unavailableReason(machine) { throw ControlRefusal(reason) }
        let live = try await terminals.paneTerminals(machine)
        let workspaceId = workspace.id
        func alive(_ terminalId: String) -> Bool {
            live.contains { $0.terminalId == terminalId && $0.pane.workspaceId == workspaceId.rawValue }
        }
        func reveal(_ terminalId: String, known: Bool) -> (terminalId: String, created: Bool) {
            dispatchOwn(known
                ? .agentTerminalShown(agentId, open: true, focus: focus)
                : .agentTerminalOpened(agentId, terminalId: terminalId, focus: focus))
            if focus { placeKeyboardOnSurface() }
            return (terminalId, false)
        }
        if let existing = coordinator.model.agentTerminal(agentId), alive(existing.terminalId) {
            return reveal(existing.terminalId, known: true)
        }
        let terminalId = agentId.rawValue
        if alive(terminalId) { return reveal(terminalId, known: false) }
        guard let current = coordinator.model.workspace(workspaceId), current.canCreateAgent else {
            throw ControlRefusal("\(workspace.root) is closing or unavailable, so there is no folder to open a terminal in.")
        }
        let target = PaneTerminalTarget(machine: machine, terminalId: terminalId, workspaceId: workspaceId.rawValue, root: workspace.root)
        launchingTerminals.insert(terminalId)
        defer { launchingTerminals.remove(terminalId) }
        try await terminals.launchTerminal(target)
        if let command, !command.isEmpty {
            try await terminals.typeIntoTerminal(target, text: command)
        }
        do {
            _ = try coordinator.dispatchUser(IntentEnvelope(intent: .agentTerminalOpened(agentId, terminalId: terminalId, focus: focus)))
            drain()
        } catch {
            drain()
            try? await terminals.closeTerminal(target)
            throw namedFailure(error)
        }
        if focus { placeKeyboardOnSurface() }
        return (terminalId, true)
    }

    /// `closeAgentTerminal`: its clients, its session, then its pane.
    @discardableResult
    public func closeAgentTerminal(_ agentId: AgentId) async throws -> Bool {
        let model = coordinator.model
        guard let terminal = model.agentTerminal(agentId) else { return false }
        if let terminals, let workspace = model.workspaceForAgent(agentId) {
            try await terminals.closePaneTerminal(PaneTerminalTarget(
                machine: try RuntimeId.parse(workspace.location.runtimeId), terminalId: terminal.terminalId,
                workspaceId: workspace.id.rawValue, root: workspace.root))
        }
        let focused = coordinator.model.paneFocus == terminal.terminalId
        dispatchOwn(.agentTerminalClosed(agentId))
        // The keyboard was in the pane that went: back to the content.
        if focused { placeKeyboardOnSurface() }
        return true
    }

    /// `closePaneTerminal`: `Cmd+Q X` in the terminal, by the terminal's id.
    public func closePaneTerminal(_ terminalId: String) async throws {
        if let terminal = coordinator.model.agentTerminalById(terminalId) {
            try await closeAgentTerminal(terminal.agentId)
        }
    }

    /// `bringPane`: one pane of the Workspace's editor terminal into the
    /// Agent's, its process running on.
    public func bringPane(_ agentId: AgentId, paneId: String, focus: Bool) async throws -> Bool {
        let opened = try await openAgentTerminal(agentId, command: nil, focus: focus)
        let (_, _, target) = try terminalTarget(agentId, terminalId: opened.terminalId)
        try await terminalPort().joinIntoTerminal(target, paneId: paneId, replace: opened.created)
        return opened.created
    }

    /// `moveAgentTerminalToEditor`: the stop sheet's "Move the terminal to
    /// the editor".
    func moveAgentTerminalToEditor(_ agentId: AgentId) async throws {
        if coordinator.model.agentTerminal(agentId) == nil { return }
        let (_, _, target) = try terminalTarget(agentId)
        try await terminalPort().moveTerminalToWorkspace(target)
        try await closeAgentTerminal(agentId)
    }

    // MARK: - devhub --tell

    /// `tellWorkspaces`: the open Workspaces as `--tell workspaces` reports them.
    func tellWorkspaces() throws -> [TellWorkspace] {
        let snapshot = try snapshotWire()
        let model = coordinator.model
        let selected: WorkspaceId? = {
            switch model.selection.context {
            case let .workspace(id): return id
            case let .agent(id): return model.workspaceForAgent(id)?.id
            }
        }()
        return snapshot.workspaces.map { workspace in
            let repository = repositoryFacts.status(workspace.id)
            let number = repository?.branch.flatMap { GitHubBranchNaming.issueNumber(fromBranch: $0) }
            let issue: String? = {
                guard let number, let name = repository?.issueRepository else { return nil }
                return "https://github.com/\(name.owner)/\(name.repository)/issues/\(number)"
            }()
            let container: String? = {
                if case let .devContainer(label) = workspace.editor { return label ?? "default" }
                return nil
            }()
            let machine: String = {
                if case let .ssh(host) = workspace.location { return "ssh:\(host)" }
                return "local"
            }()
            return TellWorkspace(
                id: workspace.id, name: workspace.label, root: workspace.root, machine: machine,
                scratch: workspace.id == snapshot.scratchWorkspaceId, selected: workspace.id == selected?.rawValue,
                branch: repository?.branch,
                worktreeOf: repository?.mainWorktree.flatMap { $0 != workspace.root ? $0 : nil },
                repositoryUrl: repository?.repositoryUrl, issue: issue, container: container,
                agents: workspace.agents.map { agent in
                    TellAgent(
                        id: agent.id, name: agent.displayName, workspaceId: workspace.id, profileId: agent.profileId,
                        kind: agent.profileKind.rawValue, presentation: agent.presentation == .gui ? .gui : .tui,
                        status: agent.status.rawValue, unread: agent.unread?.rawValue, activity: agent.activity)
                })
        }
    }

    /// `agentTerminal`: an Agent's own terminal, read live where tmux answers.
    func tellAgentTerminal(_ agentId: String) async throws -> TellTerminal {
        let model = coordinator.model
        let id = AgentId(unchecked: agentId)
        guard let workspace = model.workspaceForAgent(id) else { throw ControlRefusal("there is no agent \(agentId)") }
        guard let terminal = model.agentTerminal(id) else {
            return TellTerminal(agentId: agentId, workspaceId: workspace.id.rawValue, session: nil)
        }
        var live: TellTerminal.Live?
        if let terminals, let machine = try? RuntimeId.parse(workspace.location.runtimeId) {
            do {
                if try await terminals.unavailableReason(machine) == nil {
                    let panes = try await terminals.paneTerminals(machine)
                        .filter { $0.terminalId == terminal.terminalId && $0.pane.workspaceId == workspace.id.rawValue }
                    if let socket = panes.first?.pane.socketPath {
                        live = TellTerminal.Live(
                            tmux: try await terminals.tmuxPath(machine), socket: socket,
                            panes: panes.map { Self.tellPane($0.pane) })
                    }
                }
            } catch {
                live = nil
            }
        }
        let current = coordinator.model
        let visible = current.visibleTerminal()?.agentId == id
        return TellTerminal(agentId: agentId, workspaceId: workspace.id.rawValue, session: TellTerminal.Session(
            id: terminal.terminalId, name: AgentTerminals.sessionName(terminal.terminalId), open: terminal.open,
            visible: visible, focused: visible && current.paneFocus == terminal.terminalId, tmux: live))
    }

    /// `tellTerminalPane`.
    static func tellPane(_ pane: MarkedPane) -> TellTerminalPane {
        TellTerminalPane(
            window: pane.windowId, windowIndex: pane.windowIndex, windowName: pane.windowName,
            windowActive: pane.windowActive, pane: pane.paneId, paneIndex: pane.paneIndex, active: pane.active,
            left: pane.left, top: pane.top, width: pane.width, height: pane.height, cwd: pane.cwd,
            command: pane.command, title: pane.title, dead: pane.dead)
    }

    /// The palette's commands, with whether each can run now.
    func tellCommands() throws -> [TellPaletteCommand] {
        let snapshot = try snapshotWire()
        return Commands.all
            .filter { $0.id != .forwardPrefix && $0.id != .openCommandPalette }
            .map { command in
                TellPaletteCommand(
                    id: command.id.rawValue, label: command.label, category: command.category.rawValue,
                    available: ((try? Chords.resolve(command.id, snapshot)) ?? nil) != nil)
            }
    }
}

// MARK: - ControlHandlers

extension AppController: ControlHandlers {
    public func personStarted() async {}

    /// `activateFromCli`: nothing chosen, DevHub in front.
    public func activate() async throws -> String {
        bringToFrontNow()
        return "DevHub is in front."
    }

    /// `openFromCli`.
    public func open(_ request: ControlOpenRequest) async throws -> String {
        try await editorOpening().openFromCli(request)
    }

    /// `waitEndedFromCli`.
    public func waitEnded(_ waitMarkerPath: String) async throws -> String {
        try await editorOpening().waitEnded(waitMarkerPath)
    }

    /// `addAgentFromCli`: the Workspace comes from the current directory, by
    /// the same ancestor walk a file uses.
    public func addAgent(profileId: String, args: [String], cwd: String) async throws -> String {
        let configured = config?.agentProfiles ?? []
        if !configured.contains(where: { $0.id == profileId }) {
            let known = configured.map(\.id).joined(separator: ", ")
            throw ControlRefusal(
                "there is no agent profile called '\(profileId)'. Configured profiles: \(known.isEmpty ? "none" : known).")
        }
        let here = try await PathCanonicalisation.canonicalise(try machines.paths(.local), cwd)
        guard let root = PathResolution.workspaceRoot(for: here.path, roots: workspaceRoots("local")) else {
            throw ControlRefusal(
                "\(here.path) is not inside any open DevHub workspace, and an agent needs one — open the folder first with 'devhub <folder>'.")
        }
        let workspace = try workspaceAt(root, machine: "local")
        _ = try await dispatchAwaiting(.createAgent(
            workspaceId: workspace.id, profileId: profileId, extraArgs: args, presentation: .full))
        bringToFrontNow()
        var name: String?
        if case let .agent(id) = coordinator.model.selection.context {
            name = coordinator.model.workspace(workspace.id)?.agent(id)?.displayName
        }
        return "\(name ?? "The agent") is running in the workspace at \(root)."
    }

    public func version() async throws -> String { DevHubVersion.description }

    public func metrics() async throws -> String { try await controlExtras.metrics() }

    /// `tellFromCli`.
    public func tell(_ command: TellCommand, origin: String?, machine: String?) async throws -> TellAnswer {
        try await TellService(ports: self).run(command, caller: TellCaller.from(origin: origin, machine: machine))
    }

    public func installCli() async throws -> String { try await controlExtras.installCli() }

    public func resolveRemote(machine: String, attempt: Int) async throws -> RemoteResolution {
        try await controlExtras.resolveRemote(machine, attempt)
    }

    /// `terminalProfileFor`: the command line a terminal rooted at `root` on
    /// `machine` attaches with — the Workspace that contains it, on the
    /// machine that asked, or Scratch on this Mac.
    public func terminalProfile(machine: String, root: String?, workspace workspaceKey: String?) async throws -> TerminalProfileAnswer {
        guard let terminals else { throw ControlRefusal("the terminal runtime is not running") }
        let asking = try RuntimeId.parse(machine)
        if let workspaceKey {
            guard let named = coordinator.model.workspaces.first(where: { $0.key == workspaceKey }) else {
                throw ControlRefusal("No Workspace \(workspaceKey) is open, so there is no terminal session for this window.")
            }
            if !asking.isLocal {
                throw ControlRefusal(
                    "A terminal on \(asking.rawValue) named Workspace \(workspaceKey), and only a terminal on this Mac does that.")
            }
            return try await terminals.profile(.workspace(
                machine: try RuntimeId.parse(named.location.runtimeId), workspaceId: named.id.rawValue, root: named.root))
        }
        let workspaces = coordinator.model.workspaces.filter { $0.location.runtimeId == machine }
        let enclosing = TerminalLauncher.enclosingRoot(workspaces.map(\.root), root)
        guard let workspace = workspaces.first(where: { $0.root == enclosing }) else {
            if !asking.isLocal {
                throw ControlRefusal(
                    "\(root ?? "this directory")\(machines.whereText(asking)) is not inside any Workspace DevHub has open there, so there is no terminal session for it.")
            }
            let scratch = try scratchWorkspace()
            return try await terminals.profile(.workspace(machine: asking, workspaceId: scratch.id.rawValue, root: scratch.root))
        }
        return try await terminals.profile(.workspace(machine: asking, workspaceId: workspace.id.rawValue, root: workspace.root))
    }
}

// MARK: - TellPorts

extension AppController: TellPorts {
    public func workspaces() async -> [TellWorkspace] { (try? tellWorkspaces()) ?? [] }

    public func profiles() async -> [(id: String, kind: String)] {
        (config?.agentProfiles ?? []).map { (id: $0.id, kind: $0.kind.rawValue) }
    }

    public func openWorkspace(path: String, machine: String, worktree: String?) async throws -> String {
        var target = path
        if let worktree {
            guard let number = GitHubBranchNaming.issueNumber(fromBranch: worktree) else {
                throw ControlRefusal(
                    "\(worktree) names no Issue number, and a worktree folder is named by one (like 123-fix-login). Use a branch with the number in it, or 'issue assign'.")
            }
            guard let repositories else { throw ControlRefusal("DevHub's git is not running yet.") }
            let place: WorkspaceLocation = machine.hasPrefix("ssh:")
                ? try WorkspaceLocation.make(.ssh(host: String(machine.dropFirst(4)), path: path))
                : try WorkspaceLocation.make(.local(path: path))
            target = try await repositories.ensureWorktree(location: place, mainWorktree: path, issue: number, branch: worktree)
        }
        let location: RequestedWorkspaceLocation = machine.hasPrefix("ssh:")
            ? try RequestedWorkspaceLocation.make(.ssh(host: String(machine.dropFirst(4)), path: target))
            : try RequestedWorkspaceLocation.make(.local(path: target))
        _ = try await openFolder(location)
        return try openedWorkspaceId(target).rawValue
    }

    public func createAgent(workspaceId: String, profileId: String, presentation: TellPresentation?) async throws -> String {
        let before = modelAgentIds()
        _ = try await dispatchAwaiting(.createAgent(
            workspaceId: try workspaceIdOf(workspaceId), profileId: profileId, presentation: .full,
            agentPresentation: presentation.map { $0 == .gui ? .gui : .tui }))
        guard let created = newAgent(before) else { throw ControlRefusal("DevHub did not start the agent.") }
        return created.rawValue
    }

    public func renameAgent(_ agentId: String, name: String) async throws {
        _ = try await dispatchAwaiting(.renameAgent(AgentId(unchecked: agentId), displayName: name))
    }

    public func queueText(_ agentId: String, text: String) async throws {
        guard let agents else { throw ControlRefusal("DevHub's agents are not running yet.") }
        _ = try agents.queueInjection(AgentId(unchecked: agentId), text: text, review: false)
    }

    public func assignIssue(_ request: IssueAssignRequest) async throws -> (workspaceId: String, agentId: String?) {
        guard let issues = issueAssigner else {
            throw ControlRefusal("DevHub cannot assign Issues from the command line in this build.")
        }
        let before = modelAgentIds()
        let folder = try await issues.prepare(request)
        guard !request.editorOnly else {
            _ = try await openFolder(folder)
            return (try openedWorkspaceId(folder.path).rawValue, nil)
        }
        let configured = config?.agentProfiles ?? []
        guard let profile = configured.first(where: { $0.id == request.profile }) else {
            throw ControlRefusal("there is no agent profile called '\(request.profile ?? "undefined")'.")
        }
        let presentation: AgentPresentation = request.presentation.map { $0 == .gui ? .gui : .tui } ?? profile.presentation ?? .tui
        _ = try await openFolder(folder, withAgent: (profile.id, presentation))
        if let agent = newAgent(before), let text = try await issues.firstMessage(request, profile: profile) {
            _ = try agents?.queueInjection(agent, text: text, review: false)
        }
        let agent = newAgent(before)
        let workspace = try agent.flatMap { coordinator.model.workspaceForAgent($0)?.id } ?? openedWorkspaceId(folder.path)
        return (workspace.rawValue, agent?.rawValue)
    }

    public func conversation(_ agentId: String) async throws -> (any TellConversation)? {
        let id = AgentId(unchecked: agentId)
        guard let agent = coordinator.model.agent(id), agent.presentation == .gui, let agents else { return nil }
        return try await agents.conversation(id)
    }

    public func commands() async -> [TellPaletteCommand] { (try? tellCommands()) ?? [] }

    public func runCommand(_ id: String) async -> Bool {
        guard let command = CommandId(rawValue: id) else { return false }
        return await shell.runCommand(command)
    }

    public func focusWorkspace(_ workspaceId: String) async throws {
        _ = try await dispatchAwaiting(.selectContext(.workspace(try workspaceIdOf(workspaceId)), presentation: .full))
        placeKeyboardOnSurface()
        bringToFrontNow()
    }

    public func focusAgent(_ agentId: String) async throws {
        let id = AgentId(unchecked: agentId)
        if coordinator.model.agent(id) == nil { throw NamedFailure.domain(.unknownAgent) }
        _ = try await dispatchAwaiting(.selectContext(.agent(id), presentation: .full))
        bringToFrontNow()
    }

    public func notify(_ text: String) async throws { try await shell.notify(text) }

    public func agentTerminal(_ agentId: String) async throws -> TellTerminal { try await tellAgentTerminal(agentId) }

    public func openAgentTerminal(_ agentId: String, command: String?, focus: Bool) async throws -> Bool {
        try await openAgentTerminal(AgentId(unchecked: agentId), command: command, focus: focus).created
    }

    public func closeAgentTerminal(_ agentId: String) async throws -> Bool {
        try await closeAgentTerminal(AgentId(unchecked: agentId))
    }

    public func editorPanes(_ agentId: String) async throws -> [TellEditorPane] {
        let (machine, workspaceId, _) = try terminalTarget(AgentId(unchecked: agentId))
        guard let terminals else { throw ControlRefusal("the terminal runtime is not running") }
        return try await terminals.workspacePanes(machine)
            .filter { $0.pane.workspaceId == workspaceId.rawValue }
            .map { TellEditorPane(pane: Self.tellPane($0.pane), session: $0.pane.sessionName, argv: $0.argv) }
    }

    public func bringPane(_ agentId: String, pane: String, focus: Bool) async throws -> Bool {
        try await bringPane(AgentId(unchecked: agentId), paneId: pane, focus: focus)
    }
}

// MARK: - EditorOpenHost

extension AppController: EditorOpenHost {
    public typealias Selection = NavigationSelection

    /// The file jump, built on first use.
    func editorOpening() throws -> EditorOpening<AppController> {
        if let editorOpeningValue { return editorOpeningValue }
        guard let neovims else { throw ControlRefusal("the terminal runtime is not running") }
        let built = EditorOpening(host: self, neovims: neovims)
        editorOpeningValue = built
        return built
    }

    /// A file link in a GUI Agent's conversation, clicked.
    public func openFromConversation(agentId: AgentId, path: String, selection: FileSelection?) async throws {
        try await editorOpening().openFromConversation(agentId: agentId.rawValue, path: path, selection: selection)
    }

    public func selection() async -> NavigationSelection { coordinator.model.selection }

    public func pathMachine(_ machine: String) async throws -> any PathMachine {
        try machines.paths(try RuntimeId.parse(machine))
    }

    public func whereOnMachine(_ machine: String) async -> String {
        guard let id = try? RuntimeId.parse(machine) else { return "" }
        return machines.whereText(id)
    }

    /// `routableWorkspaces`: every open Workspace, as the routing rule reads one.
    public func routableWorkspaces() async -> [RoutableWorkspace] {
        coordinator.model.workspaces.map {
            RoutableWorkspace(
                workspaceId: $0.id.rawValue, root: $0.root, machine: $0.location.runtimeId,
                agents: $0.agents.map(\.id.rawValue))
        }
    }

    static func editorPlace(_ workspace: Workspace) -> EditorPlace {
        EditorPlace(
            workspaceId: workspace.id.rawValue, root: workspace.root,
            supported: TerminalMode.supports(location: workspace.location, editor: workspace.editor),
            unsupportedReason: TerminalMode.unsupported(location: workspace.location))
    }

    public func place(root: String, machine: String) async throws -> EditorPlace {
        Self.editorPlace(try workspaceAt(root, machine: machine))
    }

    public func scratchPlace() async throws -> EditorPlace { Self.editorPlace(try scratchWorkspace()) }

    public func runningAgentName(_ agentId: String) async -> String? {
        coordinator.model.agent(AgentId(unchecked: agentId))?.displayName
    }

    public func agentPlace(_ agentId: String) async throws -> (workspaceId: String, machine: String) {
        guard let workspace = coordinator.model.workspaceForAgent(AgentId(unchecked: agentId)) else {
            throw ControlRefusal("no Agent \(agentId) is open")
        }
        return (workspace.id.rawValue, workspace.location.runtimeId)
    }

    public func openFolder(_ path: String, machine: String) async throws {
        let location: RequestedWorkspaceLocation = machine.hasPrefix("ssh:")
            ? try RequestedWorkspaceLocation.make(.ssh(host: String(machine.dropFirst(4)), path: path))
            : try RequestedWorkspaceLocation.make(.local(path: path))
        _ = try await openFolder(location)
    }

    public func showScratch() async throws {
        _ = try await dispatchAwaiting(.newWindow(path: nil))
    }

    public func select(workspaceId: String, besideAgent agentId: String?) async throws {
        let id = try workspaceIdOf(workspaceId)
        if let agentId {
            _ = try await dispatchAwaiting(.selectContext(.agent(AgentId(unchecked: agentId)), presentation: .beside))
        }
        _ = try await dispatchAwaiting(.selectContext(.workspace(id), presentation: agentId == nil ? .full : .beside))
    }

    public func keyboardToEditorArea() async {
        if coordinator.model.paneFocus != nil { dispatchOwn(.focusPane(.content)) }
        placeKeyboardOnSurface()
    }

    public func bringToFront() async { bringToFrontNow() }

    public func personStartedAction() async {}

    /// `contextStillExists`.
    public func stillExists(_ selection: NavigationSelection) async -> Bool {
        switch selection.context {
        case let .workspace(id): return coordinator.model.workspace(id) != nil
        case let .agent(id): return coordinator.model.agent(id) != nil
        }
    }

    public func restore(_ selection: NavigationSelection) async throws {
        _ = try await dispatchAwaiting(.selectContext(selection.context, presentation: selection.presentation))
        placeKeyboardOnSurface()
    }
}

/// The Issue flow's two halves the command line needs (the Assign Issue
/// sheet's steps, `assignIssueFromCli`): the folder made ready for the
/// branch, and the first message the chosen Issue action sends.
public protocol IssueAssigner: Sendable {
    /// The clone found (or the one given), the branch chosen, the folder
    /// made: where the Workspace opens.
    func prepare(_ request: IssueAssignRequest) async throws -> RequestedWorkspaceLocation
    /// The configured Issue action's message for the new Agent, if any.
    func firstMessage(_ request: IssueAssignRequest, profile: ConfiguredAgentProfile) async throws -> String?
}
