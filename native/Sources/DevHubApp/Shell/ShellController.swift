// The window's side of main/shell/appController.ts: what the window knows
// that the model does not (the arrangement it last drew, a drag in progress,
// whether the keys are in the Sidebar, the repository facts, the appearance),
// the chord host (`ChordHost` there, `perform`), the questions it asks
// (`raiseCloseConfirmation`, `closeWorkspaceOrWorktree`) and how their answers
// come back as intents, and the attention it asks for (the Dock, the
// notifications).
//
// The model is Core's `AppController`; it is told everything through
// `dispatchFromWindow` and the window entry points, and tells the window
// everything through `AppShell` (`WindowShell` below).

import AppKit
import DevHubCore

@MainActor
final class ShellController {
    /// The runtime, once it is up (nil in the self-test's fixture window).
    private(set) var runtime: DevHubRuntime?
    var controller: AppController? { runtime?.controller }
    let window: MainWindowController
    let appearance: AppearanceController
    let style: ShellStyle
    let titleBar: TitleBarMode
    let modals: ModalPresenting
    let notices: NoticePresenting
    let conversations: ConversationViewProviding
    private(set) var snapshot: AppSnapshotWire?
    private(set) var config: Config?
    private(set) var repositories = RepositoryStatusWire()
    private(set) var usageLimits: UsageLimitsWire?
    private(set) var keyboardInSidebar = false
    private(set) var preview = LayoutPreview()
    private var shown = EditorTerminalsShown()
    private(set) var arrangement: ShellArrangement?
    private var exiting: [ExitingRow] = []
    private var previousRows: [(id: String, label: String, closing: Bool)] = []
    private var recentCommands: [CommandId] = []
    private(set) var armed = false
    private(set) var windowFocused = false
    private var chords: ChordDispatcher?
    private let dock = AppDock()
    private lazy var attention = WindowAttention(dock: dock)
    let notifications = Notifications()
    /// ⌘⇧M: speech into the text the keyboard is in.
    private(set) lazy var dictation: DictationController = {
        let controller = DictationController(style: style)
        controller.onFailure = { [weak self] error in self?.publishError(error) }
        return controller
    }()
    private var notifier: AgentNotifier?
    private var notifierBridge: NotifierBridge?

    init(
        titleBar: TitleBarMode, appearance: AppearanceController, transport: TerminalAttachTransport,
        modals: ModalPresenting? = nil, notices: NoticePresenting? = nil, conversations: ConversationViewProviding? = nil
    ) {
        self.titleBar = titleBar
        self.appearance = appearance
        let tokens = appearance.tokens(titleBar: titleBar == .shown ? .shown : .hidden, density: .compact, terminalFontFamily: nil)
        let style = ShellStyle(
            tokens: tokens,
            terminal: TerminalAppearance(
                fontFamily: TerminalFontStack.defaultFamily, fontSize: 13, lineHeight: 1, scrollSensitivity: 3,
                margin: TerminalAppearance.defaultMargin,
                theme: terminalPalettes(for: .vscode, fromVSCode: appearance.theme.terminalPalette())),
            dark: NSApp.effectiveAppearance.isDarkAppearance, terminalFontSize: 13)
        self.style = style
        let presenter = modals ?? SheetLayer(style: style)
        self.modals = presenter
        let noticeLayer = notices ?? NoticeLayer(style: style)
        self.notices = noticeLayer
        let slot = conversations ?? PlaceholderConversations()
        self.conversations = slot
        window = MainWindowController(titleBar: titleBar, style: style, transport: transport, conversations: slot)
        window.shell = self
        window.sidebar.host = self
        window.backdrop.host = self
        if let alerts = presenter as? AlertModalPresenter {
            alerts.nameOfAgent = { [weak self] id in
                self?.snapshot?.workspaces.lazy.flatMap(\.agents).first { $0.id == id }?.displayName
            }
            alerts.onUnsupported = { [weak self] request in self?.unsupported(request) }
        }
        if let sheets = presenter as? SheetLayer { sheets.host = self }
        if let layer = noticeLayer as? NoticeLayer {
            layer.onMeasuredChange = { [weak self] in self?.window.applyLayout() }
            layer.onCenterClosed = { [weak self] in self?.placeKeyboardOnSurface() }
            layer.onOpenSettings = { [weak self] in self?.openSettings?() }
            layer.onRetry = { [weak self] in self?.retry() }
        }
        appearance.onChange = { [weak self] in self?.restyle() }
        let bridge = NotifierBridge(shell: self)
        notifierBridge = bridge
        notifier = AgentNotifier(host: bridge)
        notifications.onAgentClicked = { [weak self] agentId in
            guard let self else { return }
            self.bringToFront()
            self.dispatch(.selectContext(.agent(agentId)))
        }
        notifications.onClicked = { [weak self] in self?.bringToFront() }
    }

    /// The runtime is up: everything from here on is real.
    func adopt(_ runtime: DevHubRuntime) {
        self.runtime = runtime
        repositories = runtime.repositories
    }

    func installKeyboard() {
        let dispatcher = ChordDispatcher(host: self, layout: config.map { ChordLayout.of($0.keybindings) } ?? .defaults(), inputSources: TISInputSources())
        dispatcher.install()
        chords = dispatcher
        dictation.installKeys()
        notifications.install()
    }

    // MARK: What the model says (AppShell)

    func apply(_ snapshot: AppSnapshotWire) {
        let previous = self.snapshot
        // `useClosingExit`: a row that just left stands as a ghost a moment.
        let left = Sidebar.rowsThatLeft(previousRows, (try? snapshot.sidebarWorkspaces().rows) ?? [])
        if !left.isEmpty {
            exiting += left
            DispatchQueue.main.asyncAfter(deadline: .now() + Sidebar.closingExitMs / 1000) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.exiting.removeAll { ghost in left.contains { $0.id == ghost.id } }
                    self.render()
                }
            }
        }
        previousRows = ((try? snapshot.sidebarWorkspaces().rows) ?? []).map { ($0.id, $0.label, $0.close.isRunning) }
        self.snapshot = snapshot
        if previous?.terminalZoomOffset != snapshot.terminalZoomOffset { restyle() }
        render()
        attention.observe(snapshot)
        notifierBridge?.observed(snapshot)
        notifier?.observe(snapshot)
        (modals as? SheetLayer)?.observe(snapshot)
    }

    /// Try Again on an app-scoped notice (`retry_app`): the projection and
    /// the repository facts asked for afresh.
    private func retry() {
        guard let runtime, let controller else { return }
        Task { @MainActor [weak self] in
            if let snapshot = try? await controller.snapshotWire() { self?.apply(snapshot) }
            await runtime.refreshRepositories()
        }
    }

    func repositoriesChanged(_ status: RepositoryStatusWire) {
        repositories = status
        render()
    }

    func usageLimitsChanged(_ limits: UsageLimitsWire) {
        usageLimits = limits
        window.sidebar.usageLimitsChanged(limits)
    }

    func configAccepted(_ config: Config) {
        self.config = config
        appearance.configure(mode: config.appearance.mode, names: ColorThemeNames(dark: config.appearance.themeDark, light: config.appearance.themeLight))
        chords?.setLayout(ChordLayout.of(config.keybindings))
        (notices as? NoticeLayer)?.configure(noticeSeconds: config.general.noticeSeconds)
        if let settingsWindow { Task { await settingsWindow.refresh() } }
        restyle()
    }

    func publishError(_ error: AppError) {
        notices.error(error)
    }

    func publishCondition(source: String, summary: String?, reason: String) {
        notices.condition(source: source, summary: summary, reason: reason)
    }

    func bringToFront() {
        NSApp.activate()
        window.showWindow(nil)
        window.window?.makeKeyAndOrderFront(nil)
    }

    func placeKeyboardOnSurface(_ landing: Landing? = nil) {
        keyboardInSidebar = false
        render()
        window.placeKeyboard(force: true, landing: landing)
    }

    func notifyTold(_ text: String) throws {
        try notifications.postTold(text)
    }

    func openModal(_ request: ModalRequest) {
        guard let nsWindow = window.window else { return }
        notices.personStartedAction()
        window.tooltip.hideNow()
        modals.present(request, in: nsWindow, style: style) { [weak self] answer in self?.answered(answer) }
        window.applyLayout()
    }

    // MARK: Drawing

    private func chrome() -> ShellChrome {
        ShellChrome(titleBar: titleBar, density: style.tokens.density)
    }

    func render() {
        guard let snapshot else { return }
        var shown = self.shown
        let arrangement = ShellLayout.arrangement(
            snapshot, chrome: chrome(), keyboardInSidebar: keyboardInSidebar, preview: preview, shown: &shown)
        self.shown = shown
        self.arrangement = arrangement
        let sidebar = try? Sidebar.model(
            snapshot, repositories: repositories, profiles: SidebarProfiles.of(config), armed: armed, exiting: exiting)
        window.render(snapshot: snapshot, arrangement: arrangement, sidebar: sidebar)
    }

    private func restyle() {
        let density = DevHubTheme.Density(setting: config?.appearance.sidebarDensity ?? "compact")
        let tokens = appearance.tokens(
            titleBar: titleBar == .shown ? .shown : .hidden, density: density,
            terminalFontFamily: config?.appearance.terminalFontFamily)
        let settings = config?.appearance ?? AppearanceConfig()
        let base = settings.terminalFontSize
        let zoomed = Double(TerminalZoom.zoomedFontSize(base: base, offset: snapshot?.terminalZoomOffset ?? 0))
        let terminal = TerminalAppearance(
            fontFamily: settings.terminalFontFamily, fontSize: zoomed, lineHeight: settings.terminalLineHeight,
            scrollSensitivity: settings.terminalScrollSensitivity, margin: settings.terminalMargin,
            theme: terminalPalettes(for: settings.terminalTheme, fromVSCode: appearance.theme.terminalPalette()))
        style.update(tokens: tokens, terminal: terminal, dark: NSApp.effectiveAppearance.isDarkAppearance, terminalFontSize: zoomed)
        window.restyle(style)
        settingsWindow?.restyle(style)
        dictation.restyle(style)
        render()
    }

    // MARK: Intents

    func dispatch(_ intent: AppIntentWire) {
        guard let controller else { return }
        notices.personStartedAction()
        Task { await controller.dispatchFromWindow(intent) }
    }

    /// `arrive`: an intent the keys follow, to wherever it lands.
    private func arrive(_ intent: UserIntent, landing: Landing? = nil) {
        keyboardInSidebar = false
        guard let controller else { return }
        notices.personStartedAction()
        Task { @MainActor [weak self] in
            await controller.dispatchFromWindow(intent)
            self?.placeKeyboardOnSurface(landing)
        }
    }

    private func arrive(_ wire: AppIntentWire, landing: Landing? = nil) {
        guard let intent = try? UserIntent.fromWire(wire) else { return dispatch(wire) }
        arrive(intent, landing: landing)
    }

    /// Ask, and put the question up if the answer is one.
    private func ask(_ question: @escaping @Sendable (AppController) async -> ModalRequest?) {
        guard let controller else { return }
        Task { @MainActor [weak self] in
            if let request = await question(controller) { self?.openModal(request) }
        }
    }

    func requestCloseWorkspace(_ workspaceId: String) {
        ask { await $0.requestCloseWorkspace(workspaceId) }
    }

    func requestStopAgent(_ agentId: String) {
        ask { await $0.requestStopAgent(agentId) }
    }

    func requestRestartAgent(_ agentId: String) {
        ask { await $0.requestRestartAgent(agentId) }
    }

    func continueAgent(_ agentId: String) {
        ask { await $0.continueAgent(agentId, session: nil) }
    }

    private func answered(_ answer: ModalAnswer) {
        window.applyLayout()
        switch answer {
        case .dismissed:
            placeKeyboardOnSurface()
        case let .confirmed(confirmationId, purpose, moveTerminal):
            switch purpose {
            case .workspaceClose: dispatch(.confirmCloseWorkspace(confirmationId: confirmationId))
            case .agentStop: dispatch(.confirmStopAgent(confirmationId: confirmationId, moveTerminal: moveTerminal))
            case .agentContinue: dispatch(.confirmContinueAgent(confirmationId: confirmationId))
            case .agentRestart: dispatch(.confirmRestartAgent(confirmationId: confirmationId))
            }
            placeKeyboardOnSurface()
        case let .worktreeClose(workspaceId, deleteFolder):
            ask { await $0.answerWorktreeClose(workspaceId, deleteFolder: deleteFolder) }
        case let .command(id):
            recentCommands = CommandPalette.remember(recentCommands, id)
            runCommand(id)
        case let .renamed(agentId, displayName):
            dispatch(.renameAgent(agentId: agentId, displayName: displayName))
            placeKeyboardOnSurface()
        }
    }

    /// What the stand-in questions layer cannot ask yet (WP11), done the
    /// plainest native way there is.
    private func unsupported(_ request: ModalRequest) {
        switch request {
        case let .agentPicker(workspaceId):
            showProfileMenu(workspaceId)
        case .workspacePicker:
            chooseFolder { [weak self] path in
                guard let self, let controller = self.controller else { return }
                Task { try? await controller.openFolder(path, machine: "local") }
            }
        default:
            MainLog.shared.log("[devhub] the \(String(describing: request).prefix(40)) sheet is not drawn in this build yet")
        }
    }

    private func showProfileMenu(_ workspaceId: String) {
        let profiles = config?.agentProfiles ?? []
        guard !profiles.isEmpty, let view = window.window?.contentView else { return }
        let menu = NSMenu()
        for profile in profiles {
            let item = ClosureMenuItem(title: profile.displayName) { [weak self] in
                self?.dispatch(.requestCreateAgent(workspaceId: workspaceId, profileId: profile.id))
            }
            menu.addItem(item)
        }
        let point = view.convert(window.window?.mouseLocationOutsideOfEventStream ?? .zero, from: nil)
        _ = menu.popUp(positioning: nil, at: point, in: view)
    }

    private func chooseFolder(_ then: @escaping (String) -> Void) {
        guard let nsWindow = window.window else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Open"
        Task { @MainActor in
            let response = await panel.beginSheetModal(for: nsWindow)
            if response == .OK, let url = panel.url { then(url.path) }
        }
    }

    // MARK: The window's own requests

    func windowFocusChanged(_ focused: Bool) {
        windowFocused = focused
        attention.windowFocusChanged(focused)
        if let controller { Task { await controller.windowFocusChanged(focused) } }
        if focused, let runtime { Task { await runtime.windowFocused() } }
        if !focused { window.tooltip.hideNow() }
        window.sidebar.list.needsDisplay = true
    }

    func paneFocused(_ pane: ContentFocus) {
        if keyboardInSidebar { keyboardInSidebar = false }
        guard let controller else { return }
        Task { await controller.paneFocused(pane) }
    }

    func keyboardInSidebarCleared() {
        keyboardInSidebar = false
    }

    func setPreview(_ next: LayoutPreview) {
        preview = next
        render()
    }

    /// The person asked for the Sidebar (`focusSidebar`).
    func focusSidebar() {
        keyboardInSidebar = true
        render()
        window.placeKeyboard(force: true, landing: nil)
    }

    func openExternal(_ link: String) {
        guard let url = URL(string: link), url.scheme != nil else { return }
        NSWorkspace.shared.open(url)
    }

    func armedChanged(_ armed: Bool) {
        self.armed = armed
        render()
    }

    // MARK: Commands (`runCommand`, `perform`)

    /// The last command a chord or the palette ran (the self-test reads it).
    private(set) var lastCommand: CommandId?

    /// The chord dispatcher, once the keyboard is installed.
    var chordDispatcher: ChordDispatcher? { chords }

    @discardableResult
    func runCommand(_ id: CommandId) -> Bool {
        lastCommand = id
        guard let snapshot, let effect = try? Chords.resolve(id, snapshot) else { return false }
        perform(effect)
        return true
    }

    private func perform(_ effect: ChordEffect) {
        switch effect {
        case let .selectContext(context, presentation, focus, _):
            arrive(.selectContext(context, split: presentation == .beside), landing: focus)
        case .swapSplitFocus:
            arrive(.swapSplitFocus)
        case .cyclePaneFocus:
            arrive(.cyclePaneFocus(direction: 1))
        case let .toggleTerminal(agentId):
            guard let controller, let id = try? AgentId(agentId) else { return }
            Task { @MainActor [weak self] in
                do {
                    try await controller.toggleAgentTerminal(id)
                } catch {
                    self?.publishError(errorWire(error))
                }
            }
        case .terminalNeedsAgent:
            publishError(AppError.at(.terminalNeedsAgent))
        case .terminalNeedsAgentView:
            publishError(AppError.at(.terminalNeedsAgentView))
        case let .closeTerminal(terminalId):
            guard let controller else { return }
            Task { @MainActor [weak self] in
                do {
                    try await controller.closePaneTerminal(terminalId)
                } catch {
                    self?.publishError(errorWire(error))
                }
            }
        case .focusSidebar:
            focusSidebar()
        case .toggleSidebar:
            dispatch(.toggleSidebar)
        case let .toggleScratch(focus):
            arrive(.toggleScratch, landing: focus)
        case .openWorkspacePicker:
            openModal(.workspacePicker)
        case .openTabPicker:
            openModal(.tabPicker)
        case let .openAgentPicker(workspaceId):
            openModal(.agentPicker(workspaceId: workspaceId))
        case .openIssuePicker:
            openModal(.issueAssignment)
        case let .openAgentActions(agentId):
            openModal(.agentActions(agentId: agentId))
        case let .renameAgent(agentId):
            openModal(.agentRename(agentId: agentId))
        case let .markAgentUnread(agentId):
            dispatch(.markAgentUnread(agentId: agentId))
        case .dismissAlert:
            notices.dismissAlert()
        case .showNotifications:
            if modals.isPresenting { return }
            notices.showNotifications()
        case let .closeAgent(agentId):
            placeKeyboardOnSurface()
            requestStopAgent(agentId)
        case let .restartAgent(agentId):
            requestRestartAgent(agentId)
        case let .closeWorkspace(workspaceId):
            placeKeyboardOnSurface()
            requestCloseWorkspace(workspaceId)
        case let .reorderEntries(workspaceId, order):
            if let workspaceId {
                dispatch(.reorderAgents(workspaceId: workspaceId, order: order))
            } else {
                dispatch(.reorderWorkspaces(order))
            }
        case .refreshRepositories:
            if let runtime { Task { await runtime.refreshRepositories() } }
        case .openChordHelp:
            guard let controller else { return openModal(.chordHelp(rows: ChordHelpRow.rows(prefix: ChordLayout.defaults().prefix, bindings: ChordLayout.defaults().table))) }
            Task { @MainActor [weak self] in
                let rows = await controller.chordHelpRows()
                self?.openModal(.chordHelp(rows: rows))
            }
        case .openSettings:
            openSettings?()
        case .openLog:
            openLog()
        case .openCommandPalette:
            guard let controller else { return }
            let recent = recentCommands
            Task { @MainActor [weak self] in
                let rows = await controller.commandPaletteRows(recent: recent)
                self?.openModal(.commandPalette(rows: rows))
            }
        case let .navigateHistory(direction):
            _ = navigateHistory(direction)
        }
    }

    /// The Settings window (`Cmd+Q ,`, the menu, a notice's Open Settings).
    var openSettings: (() -> Void)?
    private(set) var settingsWindow: SettingsWindowController?

    /// Open Settings, or close it when it is the front window already.
    func toggleSettings() {
        guard let service = runtime?.settings else { return }
        if settingsWindow == nil { settingsWindow = SettingsWindowController(service: service, style: style) }
        settingsWindow?.toggle()
    }

    private func openLog() {
        guard let runtime else { return }
        let path = runtime.environment.locations.mainLogPath
        MainLog.shared.log("[devhub] log: opening \(path)")
        if !NSWorkspace.shared.open(URL(fileURLWithPath: path)) {
            publishError(AppError.at(.fileNotFound).withSummary("The log could not be opened.").withDetail(path))
        }
    }

    func navigateHistory(_ direction: NavigationDirection) -> Bool {
        if modals.isPresenting { return false }
        arrive(UserIntent.navigateHistory(direction))
        return true
    }

    func terminalZoom(_ direction: TerminalZoom.Direction) -> Bool {
        if modals.isPresenting { return false }
        guard let controller, config != nil else { return false }
        Task { _ = await controller.terminalZoom(direction) }
        return true
    }
}

// MARK: - The questions layer's host

extension ShellController: SheetHost {
    var sheetServices: (any SheetServices)? { runtime?.sheets }
    var currentSnapshot: AppSnapshotWire? { snapshot }
    func arriveFromSheet(_ intent: AppIntentWire) { arrive(intent) }
}

// MARK: - The chord host

extension ShellController: ChordHost {
    func keySurface(for nsWindow: NSWindow?) -> KeySurface {
        window.keySurface(for: nsWindow)
    }

    func chordArmedChanged(_ armed: Bool) {
        armedChanged(armed)
    }

    func focusedTerminalPane() -> TerminalPaneView? {
        window.focusedTerminalPane()
    }

    func report(_ error: Error) {
        publishError(errorWire(error))
    }
}

// MARK: - The notifications (`AgentNotifier`)

/// `AgentNotifier`'s host: the settings, the window's focus, the projection
/// and a timer, from the window.
@MainActor
final class NotifierBridge: NotifierHost {
    private weak var shell: ShellController?
    private var latest: AppSnapshotWire?
    private var timers: [Int: Timer] = [:]
    private var next = 1

    init(shell: ShellController) { self.shell = shell }

    func observed(_ snapshot: AppSnapshotWire) { latest = snapshot }

    nonisolated func notifierSettings() -> NotifierSettings {
        MainActor.assumeIsolated {
            let general = shell?.config?.general
            return NotifierSettings(enabled: general?.notifyOnIdle ?? true, sound: general?.notifySound ?? true)
        }
    }

    nonisolated func windowFocused() -> Bool {
        MainActor.assumeIsolated { shell?.windowFocused ?? false }
    }

    nonisolated func snapshot() -> AppSnapshotWire {
        MainActor.assumeIsolated { latest ?? shell?.snapshot ?? WindowFixtures.emptySnapshot() }
    }

    nonisolated func notify(_ notification: AgentNotification) {
        MainActor.assumeIsolated {
            shell?.notifications.post(
                title: notification.title, body: notification.body, sound: notification.sound, agentId: notification.agentId)
            shell?.notices.notice("\(notification.title): \(notification.body)")
        }
    }

    nonisolated func setTimer(_ ms: Double, _ fire: @escaping () -> Void) -> Int {
        nonisolated(unsafe) let fire = fire
        return MainActor.assumeIsolated {
            let handle = next
            next += 1
            let timer = Timer(timeInterval: ms / 1000, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.timers[handle] = nil
                    fire()
                }
            }
            RunLoop.main.add(timer, forMode: .common)
            timers[handle] = timer
            return handle
        }
    }

    nonisolated func clearTimer(_ handle: Int) {
        MainActor.assumeIsolated {
            timers[handle]?.invalidate()
            timers[handle] = nil
        }
    }
}

/// A menu item that runs a closure.
final class ClosureMenuItem: NSMenuItem {
    private let run: () -> Void

    init(title: String, run: @escaping () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(chosen), keyEquivalent: "")
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("not used") }

    @objc private func chosen() { run() }
}

// MARK: - AppShell

/// The window, as the controller's `AppShell`: every message hops to the main
/// actor and to the `ShellController`, in the order the controller sent it.
final class WindowShell: AppShell {
    let box: ShellBox

    init(box: ShellBox) { self.box = box }

    func publishSnapshot(_ snapshot: AppSnapshotWire) async {
        await MainActor.run { box.shell?.apply(snapshot) }
    }

    func publishError(_ error: AppError) async {
        await MainActor.run { box.shell?.publishError(error) }
    }

    func publishCondition(source: String, summary: String?, reason: String) async {
        await MainActor.run { box.shell?.publishCondition(source: source, summary: summary, reason: reason) }
    }

    func bringToFront() async {
        await MainActor.run { box.shell?.bringToFront() }
    }

    func placeKeyboardOnSurface() async {
        await MainActor.run { box.shell?.placeKeyboardOnSurface() }
    }

    func notify(_ text: String) async throws {
        try await MainActor.run {
            guard let shell = box.shell else { throw DevhubFailure("DevHub has no window yet.") }
            try shell.notifyTold(text)
        }
    }

    func runCommand(_ id: CommandId) async -> Bool {
        await MainActor.run { box.shell?.runCommand(id) ?? false }
    }

    func openModal(_ request: ModalRequest) async {
        await MainActor.run { box.shell?.openModal(request) }
    }

    func quit() async {
        await MainActor.run { NSApp.terminate(nil) }
    }
}

/// The window controller, for the actor-free side.
@MainActor
final class ShellBox: Sendable {
    weak var shell: ShellController?
    init() {}
}
