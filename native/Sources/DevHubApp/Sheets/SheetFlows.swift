// Every `ModalRequest`, as the run of sheets it is in the TS app:
//
//   workspacePicker     WorkspacePicker.tsx (+ ProjectSheets.tsx, and the agent
//                       question ⌘Return asks first)
//   agentPicker         picker/AgentPickerSheet.tsx
//   issueAssignment     picker/IssueAssignmentSheet.tsx (Core's `IssueFlow`)
//   agentRename         picker/AgentRenameSheet.tsx
//   agentActions        picker/AgentActionsSheet.tsx
//   tabPicker           picker/TabPickerSheet.tsx
//   worktreeClose       picker/WorktreeCloseSheet.tsx
//   chordHelp           picker/ChordHelpSheet.tsx
//   commandPalette      picker/CommandPaletteSheet.tsx
//   injectionReview     picker/InjectionReviewSheet.tsx
//   closeConfirmation   picker/CloseConfirmationSheet.tsx
//
// and `/resume`'s session picker (SessionPicker.tsx), for a GUI Agent.

import AppKit
import DevHubCore

@MainActor
enum SheetFlows {
    static func run(_ request: ModalRequest, flow: SheetFlow, layer: SheetLayer) async -> ModalAnswer {
        switch request {
        case .workspacePicker:
            await workspacePicker(flow)
            return .dismissed
        case let .agentPicker(workspaceId):
            await agentPicker(flow, workspaceId: workspaceId)
            return .dismissed
        case .issueAssignment:
            await issueAssignment(flow)
            return .dismissed
        case let .agentRename(agentId):
            await rename(flow, agentId: agentId)
            return .dismissed
        case let .agentActions(agentId):
            await agentActions(flow, agentId: agentId)
            return .dismissed
        case .tabPicker:
            return await tabPicker(flow)
        case let .worktreeClose(workspaceId, label, root, branch, dirty):
            let picker = PickerView(prompt: SheetRows.worktreeClose(label: label, root: root, branch: branch, dirty: dirty), style: flow.style)
            guard case let .choose(choice) = await flow.run(picker) else { return .dismissed }
            return .worktreeClose(workspaceId: workspaceId, deleteFolder: choice.id == "delete")
        case let .chordHelp(rows):
            await chordHelp(flow, rows: rows)
            return .dismissed
        case let .commandPalette(rows):
            let picker = PickerView(prompt: SheetRows.commandPalette(rows), style: flow.style)
            guard case let .choose(choice) = await flow.run(picker), let index = Int(choice.id), index < rows.count else {
                return .dismissed
            }
            return .command(rows[index].commandId)
        case let .injectionReview(agentId, injectionId, actionName, text):
            await injectionReview(flow, layer: layer, agentId: agentId, injectionId: injectionId, actionName: actionName, text: text)
            return .dismissed
        case let .closeConfirmation(confirmationId, purpose):
            let name = SheetRows.agentId(of: purpose).flatMap { id in SheetFlows.agent(flow.snapshot, id)?.displayName }
            let picker = PickerView(prompt: SheetRows.closeConfirmation(purpose, agentName: name), style: flow.style)
            guard case let .choose(choice) = await flow.run(picker) else { return .dismissed }
            return .confirmed(confirmationId: confirmationId, purpose: purpose, moveTerminal: choice.id == SheetRows.moveTerminalRow)
        }
    }

    static func agent(_ snapshot: AppSnapshotWire?, _ id: String) -> AgentWire? {
        snapshot?.workspaces.lazy.flatMap(\.agents).first { $0.id == id }
    }

    /// Why a call failed, in the sheet's words (`reasonOf`).
    static func reason(_ error: Error) -> String { errorWire(error).summary }

    // MARK: - Open Workspace

    /// What the search has found so far, for one picker.
    @MainActor
    final class WorkspaceSearch {
        var pool = WorkspacePickerPool()
        var busy = true
        var sourceCount: Int?
        var task: Task<Void, Never>?
        var dirty = false
        weak var picker: PickerView?

        var prompt: PickerPrompt { SheetRows.workspacePicker(pool: pool, busy: busy, sourceCount: sourceCount) }

        func search(_ query: String, services: any SheetServices) {
            task?.cancel()
            busy = true
            changed()
            task = Task { @MainActor [weak self] in
                let (stream, continuation) = AsyncStream<WorkspacePickerEvent>.makeStream()
                let producer = Task.detached {
                    await services.searchWorkspaces(query) { event in _ = continuation.yield(event) }
                    continuation.finish()
                }
                await withTaskCancellationHandler {
                    for await event in stream {
                        if Task.isCancelled { break }
                        self?.handle(event)
                    }
                } onCancel: {
                    producer.cancel()
                    continuation.finish()
                }
            }
        }

        func stop() {
            task?.cancel()
            task = nil
        }

        private func handle(_ event: WorkspacePickerEvent) {
            switch event {
            case let .started(sourceCount):
                self.sourceCount = sourceCount
            case let .candidate(candidate):
                guard pool.add(candidate) else { return }
            case .completed, .cancelled:
                busy = false
            case .sourceError, .sourceCompleted:
                return
            }
            changed()
        }

        /// A burst of candidates is one redraw.
        private func changed() {
            guard !dirty else { return }
            dirty = true
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.dirty = false
                    self.picker?.update(self.prompt)
                }
            }
        }
    }

    private enum Chosen {
        case open(path: String, create: Bool)
        case new(query: String)
        case clone(query: String)
    }

    static func workspacePicker(_ flow: SheetFlow) async {
        guard let services = flow.services else { return }
        let search = WorkspaceSearch()
        defer { search.stop() }
        var query = ""
        while true {
            var prompt = search.prompt
            prompt.initialQuery = query
            let picker = PickerView(prompt: prompt, style: flow.style)
            search.picker = picker
            picker.onQueryChange = { [weak search] typed in search?.search(typed, services: services) }
            picker.scheduleQuery()
            let outcome = await flow.run(picker)
            guard case let .choose(choice) = outcome else { return }
            query = choice.query
            if choice.id == SheetRows.otherFolder {
                search.stop()
                guard let path = await chooseFolder(flow.window) else { return }
                await open(flow) { try await services.openPicked(path, create: false, withAgent: nil) }
                return
            }
            let row: Chosen
            switch choice.id {
            case SheetRows.newProject: row = .new(query: choice.query)
            case SheetRows.cloneProject: row = .clone(query: choice.query)
            default: row = .open(path: choice.id, create: search.pool.candidate(choice.id)?.missing ?? false)
            }
            var launch: AgentLaunch?
            if choice.alternate {
                search.stop()
                let sheet = AgentPickerSheet(
                    flow: flow, title: "New Agent",
                    question: "Which agent profile should start in the workspace being opened?", step: 2,
                    hint: SheetRows.openingAgentHint, failure: nil, place: nil, openEditor: false)
                guard case let .agent(agentChoice) = await sheet.ask(in: flow) else {
                    // Escape: back to the list, as it was.
                    search.search(query, services: services)
                    continue
                }
                launch = AgentLaunch(profileId: agentChoice.profileId, presentation: agentChoice.presentation)
            }
            search.stop()
            let step = launch == nil ? 2 : 3
            switch row {
            case let .open(path, create):
                await open(flow) { try await services.openPicked(path, create: create, withAgent: launch) }
            case let .new(typed):
                await newProject(flow, services: services, typed: typed, step: step, launch: launch)
            case let .clone(typed):
                await cloneProject(flow, services: services, typed: typed, step: step, launch: launch)
            }
            return
        }
    }

    /// Open, and say so if it did not: the sheet goes either way.
    private static func open(_ flow: SheetFlow, _ action: @escaping @Sendable () async throws -> Void) async {
        do {
            try await action()
        } catch {
            flow.host?.publishError(errorWire(error))
        }
    }

    /// `chooseWorkspaceFolder`: the Mac's own folder panel.
    static func chooseFolder(_ window: NSWindow?) async -> String? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Open"
        let response: NSApplication.ModalResponse
        if let window {
            response = await panel.beginSheetModal(for: window)
        } else {
            response = panel.runModal()
        }
        return response == .OK ? panel.url?.path : nil
    }

    // MARK: New Project, Clone Project (ProjectSheets.tsx)

    static func newProject(_ flow: SheetFlow, services: any SheetServices, typed: String, step: Int, launch: AgentLaunch?) async {
        let picker = PickerView(prompt: SheetRows.newProject(start: nil, step: step, failure: nil), style: flow.style)
        flow.show(flow.card(for: picker))
        let directory = await services.projectDefaultDirectory()
        let start = SheetRows.newProjectStart(defaultDirectory: directory, typed: typed)
        let ready = PickerView(prompt: SheetRows.newProject(start: start, step: step, failure: nil), style: flow.style)
        while true {
            guard case let .choose(choice) = await flow.run(ready) else { return }
            do {
                try await services.createProject(choice.query, withAgent: launch)
                return
            } catch {
                ready.release(failure: reason(error))
            }
        }
    }

    /// Clone Project's state across its two questions.
    @MainActor
    final class CloneState {
        var login = GitHubLogin.pending
        var parents: [String]?
        var failure: String?
        var typed: String
        var draft: String
        var name: String?
        weak var repository: PickerView?
        weak var destination: PickerView?
        let step: Int

        init(typed: String, step: Int) {
            self.typed = typed
            draft = typed
            self.step = step
        }

        var repositoryPrompt: PickerPrompt {
            SheetRows.cloneRepository(typed: typed, draft: draft, login: login, step: step, failure: nil)
        }

        var destinationPrompt: PickerPrompt {
            SheetRows.cloneDestination(name: name, parents: parents, step: step, failure: failure)
        }
    }

    static func cloneProject(_ flow: SheetFlow, services: any SheetServices, typed: String, step: Int, launch: AgentLaunch?) async {
        let state = CloneState(typed: typed, step: step)
        let parentsTask = Task { @MainActor in
            do {
                state.parents = try await services.cloneParentDirectories()
            } catch {
                state.parents = []
                state.failure = SheetFlows.reason(error)
            }
            state.destination?.update(state.destinationPrompt)
        }
        let loginTask = Task { @MainActor in
            state.login = await services.githubLogin()
            state.repository?.update(state.repositoryPrompt)
        }
        defer {
            parentsTask.cancel()
            loginTask.cancel()
        }
        while true {
            // Which repository.
            state.draft = state.typed
            let repository = PickerView(prompt: state.repositoryPrompt, style: flow.style)
            repository.queryDelay = 0
            state.repository = repository
            repository.onQueryChange = { [weak repository] text in
                state.draft = text
                repository?.update(state.repositoryPrompt)
            }
            guard case let .choose(chosen) = await flow.run(repository) else { return }
            state.typed = chosen.query
            state.failure = nil
            guard case let .clone(url, name) = Projects.cloneTarget(state.typed, login: state.login) else { continue }
            // Which folder.
            state.name = name
            let picker = PickerView(prompt: state.destinationPrompt, style: flow.style)
            state.destination = picker
            while true {
                guard case let .choose(choice) = await flow.run(picker) else { break }
                let parent = choice.id == SheetRows.cloneIntoTyped ? choice.query : choice.id
                do {
                    try await services.cloneProject(url: url, parentDirectory: parent, withAgent: launch)
                    return
                } catch {
                    picker.release(failure: reason(error))
                }
            }
            state.destination = nil
        }
    }

    // MARK: - New Agent

    static func agentPicker(_ flow: SheetFlow, workspaceId: String) async {
        guard let services = flow.services else { return }
        let workspace = flow.snapshot?.workspace(workspaceId)
        let place: WorkspacePlace? = workspace.map { workspace in
            switch workspace.location {
            case .local: return .local(path: workspace.root)
            case let .ssh(host): return .ssh(host: host, path: workspace.root)
            }
        }
        let sheet = AgentPickerSheet(
            flow: flow, title: "New Agent", question: SheetRows.folderAgentQuestion, step: nil, hint: SheetRows.folderAgentHint,
            failure: nil, place: place, openEditor: false)
        guard case let .agent(choice) = await sheet.ask(in: flow) else { return }
        await services.createAgent(
            workspaceId: workspaceId, profileId: choice.profileId, split: choice.split, presentation: choice.presentation,
            resume: choice.resume)
    }

    // MARK: - Assign an Issue

    static func issueAssignment(_ flow: SheetFlow) async {
        guard let services = flow.services else { return }
        do {
            try await Wizard.run(IssueFlow.start(services) as WizardStep<SheetFlow>, presenter: flow)
        } catch {
            // No words means nothing for the person to retype: the shell says it.
            flow.host?.publishError(errorWire(error))
        }
    }

    // MARK: - Rename Agent

    static func rename(_ flow: SheetFlow, agentId: String) async {
        guard let services = flow.services, let current = SheetFlows.agent(flow.snapshot, agentId), current.controlState == .running else {
            return
        }
        let picker = PickerView(prompt: SheetRows.rename(current: current.displayName, failure: nil), style: flow.style)
        // The agent going away takes the question with it.
        let watch = flow.sheets.watch { [weak picker] snapshot in
            if let still = SheetFlows.agent(snapshot, agentId), still.controlState == .running { return }
            picker?.cancel()
        }
        defer { flow.sheets.unwatch(watch) }
        while true {
            guard case let .choose(choice) = await flow.run(picker) else { return }
            switch SheetRows.renamed(choice.query) {
            case let .failure(refusal):
                picker.release(failure: refusal.summary)
            case let .success(name):
                if await services.dispatch(.renameAgent(agentId: agentId, displayName: name)) { return }
                picker.release(failure: "The agent could not be renamed. Try again.")
            }
        }
    }

    // MARK: - Send to agent

    static func agentActions(_ flow: SheetFlow, agentId: String) async {
        guard let services = flow.services else { return }
        let name = SheetFlows.agent(flow.snapshot, agentId)?.displayName
        let picker = PickerView(prompt: SheetRows.agentActions(nil, agentName: name), style: flow.style)
        Task { @MainActor [weak picker] in
            let actions = await services.agentActions()
            picker?.update(SheetRows.agentActions(actions, agentName: name))
        }
        guard case let .choose(choice) = await flow.run(picker) else { return }
        let host = flow.host
        Task { @MainActor in
            do {
                try await services.runAgentAction(agentId: agentId, actionId: choice.id)
            } catch {
                host?.publishError(errorWire(error))
            }
        }
    }

    // MARK: - Go to

    static func tabPicker(_ flow: SheetFlow) async -> ModalAnswer {
        let picker = PickerView(prompt: SheetRows.tabPicker(flow.snapshot), style: flow.style)
        let watch = flow.sheets.watch { [weak picker] snapshot in picker?.update(SheetRows.tabPicker(snapshot)) }
        defer { flow.sheets.unwatch(watch) }
        guard case let .choose(choice) = await flow.run(picker), let intent = SheetRows.tabTarget(choice) else { return .dismissed }
        let host = flow.host
        // After the sheet has gone, so the keys land where the row went.
        Task { @MainActor in host?.arriveFromSheet(intent) }
        return .dismissed
    }

    // MARK: - Keyboard shortcuts

    static func chordHelp(_ flow: SheetFlow, rows: [ChordHelpRow]) async {
        let view = ChordHelpView(rows: rows, style: flow.style)
        let card = SheetCard(content: view, width: 560, style: flow.style) { [weak view] width in
            view?.preferredHeight(width: width) ?? 400
        }
        card.sheetMaxHeight = 640
        card.keyView = view.catcher
        let answer = Answer<Void>()
        view.onDone = { answer.give(.success(())) }
        card.onCancel = { answer.give(.success(())) }
        flow.show(card)
        _ = try? await answer.wait()
    }

    // MARK: - Review the prompt

    static func injectionReview(
        _ flow: SheetFlow, layer: SheetLayer, agentId: String, injectionId: String, actionName: String, text: String
    ) async {
        guard let services = flow.services else { return }
        let view = InjectionReviewView(actionName: actionName, text: text, style: flow.style)
        view.observe(agent: SheetFlows.agent(flow.snapshot, agentId), known: flow.snapshot != nil)
        let card = SheetCard(content: view, width: 680, style: flow.style) { [weak view] width in
            view?.preferredHeight(width: width) ?? 360
        }
        card.keyView = view.field
        let watch = layer.watch { [weak view] snapshot in view?.observe(agent: SheetFlows.agent(snapshot, agentId), known: true) }
        defer { layer.unwatch(watch) }
        let answer = Answer<Void>()
        let cancel = { [weak view] in
            guard view?.busy != true else { return }
            Task { @MainActor in
                await services.cancelInjection(agentId: agentId, injectionId: injectionId)
                answer.give(.success(()))
            }
        }
        view.onCancel = cancel
        card.onCancel = cancel
        view.onSend = { [weak view] message in
            Task { @MainActor in
                do {
                    try await services.confirmInjection(agentId: agentId, injectionId: injectionId, text: message)
                    answer.give(.success(()))
                } catch {
                    guard SpokenFailure.of(error) != nil else {
                        flow.host?.publishError(errorWire(error))
                        answer.give(.success(()))
                        return
                    }
                    view?.failed(SpokenFailure.said(error))
                }
            }
        }
        flow.show(card)
        _ = try? await answer.wait()
    }

    // MARK: - /resume (SessionPicker.tsx)

    /// Where a GUI Agent's `/resume` lists its sessions and reads one's end.
    struct SessionSource {
        var list: @MainActor (SessionScope) async throws -> [PastSession]
        var preview: @MainActor (_ session: String, _ cwd: String) async throws -> [PreviewLine]
    }

    /// Which earlier session to go on with; nil when the person cancelled.
    /// One listing of the session picker.
    @MainActor
    final class SessionPickState {
        var sessions: [PastSession] = []
        var previews: [String: SheetRows.Preview] = [:]
        var pointedAt: String?
        var nextScope: SessionScope?
    }

    static func sessionPicker(_ flow: SheetFlow, title: String, question: String, cli: String, source: SessionSource) async -> PastSession? {
        var scope = SessionScope.here
        while true {
            let listedScope = scope
            let state = SessionPickState()
            let preview = SessionPreviewView(style: flow.style)
            let toolbar = ScopeToolbar(style: flow.style, scope: scope)
            func prompt(_ sessions: [PastSession]?, _ refusal: String?) -> PickerPrompt {
                SheetRows.sessionPicker(
                    title: title, question: question, cli: cli, scope: listedScope, sessions: sessions, refusal: refusal,
                    now: Date().timeIntervalSince1970 * 1000)
            }
            let picker = PickerView(prompt: prompt(nil, nil), style: flow.style, toolbar: toolbar, aside: preview)
            let listing = Task { @MainActor [weak picker] in
                do {
                    state.sessions = try await source.list(listedScope)
                    picker?.update(prompt(state.sessions, nil))
                } catch {
                    picker?.update(prompt([], SpokenFailure.said(error)))
                }
            }
            picker.onActiveChange = { [weak preview] item in
                state.pointedAt = item?.id
                guard let preview else { return }
                guard let item, let session = state.sessions.first(where: { $0.id == item.id }) else {
                    preview.show(nil)
                    return
                }
                if let known = state.previews[item.id] {
                    preview.show(known)
                    return
                }
                guard let cwd = session.cwd else {
                    preview.show(.failed(SheetRows.previewWithoutDirectory(cli)))
                    return
                }
                preview.show(.reading)
                let key = item.id
                Task { @MainActor [weak preview] in
                    let read: SheetRows.Preview
                    do {
                        read = .read(try await source.preview(session.id, cwd))
                        state.previews[key] = read
                    } catch {
                        read = .failed(SpokenFailure.said(error))
                    }
                    if state.pointedAt == key { preview?.show(read) }
                }
            }
            toolbar.onScope = { [weak picker] chosen in
                guard chosen != listedScope else { return }
                state.nextScope = chosen
                picker?.cancel()
            }
            let outcome = await flow.run(picker, width: 840)
            listing.cancel()
            if let next = state.nextScope {
                scope = next
                continue
            }
            guard case let .choose(choice) = outcome else { return nil }
            return state.sessions.first { $0.id == choice.id }
        }
    }

    private static func now() -> Double { Date().timeIntervalSince1970 * 1000 }
}

/// "This project" / "All projects" over the session list.
@MainActor
final class ScopeToolbar: NSView, RestylableSheetContent {
    private var buttons: [(SessionScope, QuietButton)] = []
    private var scope: SessionScope
    private var style: ShellStyle
    var onScope: ((SessionScope) -> Void)?

    init(style: ShellStyle, scope: SessionScope) {
        self.style = style
        self.scope = scope
        super.init(frame: .zero)
        for (value, label) in [(SessionScope.here, "This project"), (.everywhere, "All projects")] {
            let button = QuietButton(title: label, style: style) { [weak self] in self?.onScope?(value) }
            button.refusesFirstResponder = true
            buttons.append((value, button))
            addSubview(button)
        }
        wantsLayer = true
        restyle(style)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func restyle(_ style: ShellStyle) {
        self.style = style
        for (value, button) in buttons {
            button.style = style
            button.wantsLayer = true
            button.layer?.cornerRadius = 6
            button.layer?.backgroundColor = value == scope ? style.tokens.selection.cgColor : nil
        }
    }

    override func layout() {
        super.layout()
        var x: CGFloat = 0
        for (_, button) in buttons {
            let size = button.intrinsicContentSize
            button.frame = CGRect(x: x, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
            x += size.width + Space.s1
        }
    }
}
