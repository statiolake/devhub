// Port of apps/desktop/src/shell/picker/PickerApp.tsx and of the presenter half
// of shell/components/shell/Wizard.tsx: the questions layer. Every
// `ModalRequest` is one flow on it — a run of sheets that ends in one answer —
// and the layer is up for as long as any flow is.
//
// A flow draws one sheet at a time in its own place in the stack; its next
// question replaces its last, so nothing jumps between them. A sheet another
// flow opens over it (the review sheet over the Issue flow) stands on top of
// it, and the keyboard goes to whichever sheet is on top.

import AppKit
import DevHubCore

/// What the questions layer needs from the window.
@MainActor
protocol SheetHost: AnyObject {
    var sheetServices: (any SheetServices)? { get }
    var currentSnapshot: AppSnapshotWire? { get }
    func publishError(_ error: AppError)
    /// A row that goes somewhere: the keys follow it there.
    func arriveFromSheet(_ intent: AppIntentWire)
}

/// One answer, given once and waited for once.
@MainActor
final class Answer<T> {
    private var result: Result<T, Error>?
    private var waiting: CheckedContinuation<Void, Never>?

    var isGiven: Bool { result != nil }

    func give(_ value: Result<T, Error>) {
        guard result == nil else { return }
        result = value
        waiting?.resume()
        waiting = nil
    }

    func wait() async throws -> T {
        if result == nil {
            await withCheckedContinuation { continuation in waiting = continuation }
        }
        guard let result else { throw WizardSignal.cancelled }
        return try result.get()
    }
}

@MainActor
final class SheetLayer: ModalPresenting {
    let view: SheetLayerView
    weak var host: SheetHost?
    private(set) var style: ShellStyle
    private var running: [ObjectIdentifier: SheetFlow] = [:]
    private var observers: [Int: (AppSnapshotWire) -> Void] = [:]
    private var nextObserver = 0
    private(set) weak var window: NSWindow?

    init(style: ShellStyle) {
        self.style = style
        view = SheetLayerView(style: style)
    }

    var isPresenting: Bool { !running.isEmpty }
    var scope: PickerScope { .window }
    var layerView: NSView? { view }

    /// What the sheets on screen say now (the self-test reads it).
    var topTitle: String? {
        guard let content = view.cards.last?.content else { return nil }
        if let picker = content as? PickerView { return picker.state.prompt.title }
        return content.accessibilityLabel()
    }

    func applyStyle(_ style: ShellStyle) {
        self.style = style
        view.restyle(style)
    }

    /// The projection changed: the sheets that follow it hear about it.
    func observe(_ snapshot: AppSnapshotWire) {
        for observer in observers.values { observer(snapshot) }
    }

    func watch(_ observer: @escaping (AppSnapshotWire) -> Void) -> Int {
        let key = nextObserver
        nextObserver += 1
        observers[key] = observer
        return key
    }

    func unwatch(_ key: Int) { observers[key] = nil }

    func present(_ request: ModalRequest, in window: NSWindow, style: ShellStyle, answer: @escaping (ModalAnswer) -> Void) {
        self.window = window
        if style !== self.style { applyStyle(style) }
        let flow = SheetFlow(layer: self, answer: answer)
        running[ObjectIdentifier(flow)] = flow
        Task { @MainActor [weak self] in
            guard let self else { return }
            let result = await SheetFlows.run(request, flow: flow, layer: self)
            self.finish(flow, result)
        }
    }

    /// A GUI Agent's `/resume`: the session picker, on the same layer as
    /// every other question.
    func presentSessionPicker(
        _ request: SessionPickerRequest, in window: NSWindow, style: ShellStyle,
        chosen: @escaping (PastSession?) -> Void
    ) {
        if style !== self.style { applyStyle(style) }
        let picked = SheetFlows.SessionPickState()
        presentFlow(in: window, { flow in
            let session = await SheetFlows.sessionPicker(
                flow, title: request.title, question: request.question, cli: request.cli, source: request.source)
            picked.sessions = session.map { [$0] } ?? []
        }, done: { chosen(picked.sessions.first) })
    }

    /// A question asked by something other than a `ModalRequest` (a GUI
    /// Agent's `/resume`), on the same layer.
    func presentFlow(in window: NSWindow, _ body: @escaping @MainActor (SheetFlow) async -> Void, done: @escaping () -> Void) {
        self.window = window
        let flow = SheetFlow(layer: self) { _ in done() }
        running[ObjectIdentifier(flow)] = flow
        Task { @MainActor [weak self] in
            await body(flow)
            self?.finish(flow, .dismissed)
        }
    }

    private func finish(_ flow: SheetFlow, _ result: ModalAnswer) {
        flow.close()
        running[ObjectIdentifier(flow)] = nil
        flow.answer?(result)
        flow.answer = nil
    }
}

/// One request's run of sheets, and the wizard's presenter for it.
@MainActor
final class SheetFlow: IssueFlowPresenter {
    typealias Drawing = SheetCard

    private unowned let layer: SheetLayer
    fileprivate var answer: ((ModalAnswer) -> Void)?
    private(set) var card: SheetCard?

    init(layer: SheetLayer, answer: @escaping (ModalAnswer) -> Void) {
        self.layer = layer
        self.answer = answer
    }

    var style: ShellStyle { layer.style }
    var host: SheetHost? { layer.host }
    var services: (any SheetServices)? { layer.host?.sheetServices }
    var snapshot: AppSnapshotWire? { layer.host?.currentSnapshot }
    var window: NSWindow? { layer.window }
    var sheets: SheetLayer { layer }

    /// This flow's sheet becomes `next`.
    func show(_ next: SheetCard) {
        if let card {
            if card === next { return }
            layer.view.replace(card, with: next)
        } else {
            layer.view.push(next)
        }
        card = next
    }

    fileprivate func close() {
        if let card { layer.view.remove(card) }
        card = nil
    }

    /// A picker in a sheet of its own.
    func card(for picker: PickerView, width: CGFloat = 560) -> SheetCard {
        let card = SheetCard(content: picker, width: width, style: style) { [weak picker] width in
            picker?.preferredHeight(width: width) ?? 200
        }
        card.keyView = picker.field
        card.onCancel = { [weak picker] in picker?.cancel() }
        return card
    }

    /// Put `picker` up (unless it is up already) and wait for its answer.
    func run(_ picker: PickerView, width: CGFloat? = nil) async -> PickerOutcome {
        if card?.content !== picker { show(card(for: picker, width: width ?? 560)) }
        let answer = Answer<PickerOutcome>()
        picker.onOutcome = { [weak picker] outcome in
            picker?.onOutcome = nil
            answer.give(.success(outcome))
        }
        picker.focusField()
        return (try? await answer.wait()) ?? .cancel
    }

    // MARK: WizardPresenter

    func prompt(_ prompt: PickerPrompt, asking: WizardAsking) async throws -> PickerChoice {
        var shown = prompt
        if shown.step == nil { shown.step = asking.step }
        shown = shown.failing(asking.failure)
        let picker = PickerView(prompt: shown, style: style)
        switch await run(picker) {
        case let .choose(choice): return choice
        case .cancel: throw WizardSignal.back
        }
    }

    func sheet<T>(_ draw: @escaping (WizardSheetControls<T>) -> SheetCard, asking: WizardAsking) async throws -> T {
        let answer = Answer<T>()
        let controls = WizardSheetControls<T>(
            step: asking.step, failure: asking.failure,
            answer: { value in answer.give(.success(value)) },
            back: { answer.give(.failure(WizardSignal.back)) })
        show(draw(controls))
        return try await answer.wait()
    }

    func working<T: Sendable>(_ message: String, _ task: @escaping @Sendable () async throws -> T) async throws -> T {
        let answer = Answer<T>()
        let work = Task { @MainActor in
            do {
                let value = try await task()
                answer.give(.success(value))
            } catch {
                answer.give(.failure(error))
            }
        }
        let view = WorkingView(message: message, style: style)
        let stop = {
            // Escape while something slow runs: stop waiting, ask again.
            work.cancel()
            answer.give(.failure(WizardSignal.abandoned))
        }
        view.catcher.onEscape = stop
        let card = SheetCard(content: view, width: 560, style: style) { _ in WorkingView.height }
        card.keyView = view.catcher
        card.onCancel = stop
        show(card)
        return try await answer.wait()
    }

    // MARK: IssueFlowPresenter

    func folderAgentSheet(title: String, place: WorkspacePlace, controls: WizardSheetControls<FolderAgentAnswer>) -> SheetCard {
        let sheet = AgentPickerSheet(
            flow: self, title: title, question: SheetRows.folderAgentQuestion, step: controls.step,
            hint: SheetRows.folderAgentHint, failure: controls.failure, place: place, openEditor: true)
        sheet.onAnswer = { answer in
            switch answer {
            case let .agent(choice): controls.answer(.agent(choice))
            case .editorOnly: controls.answer(.editorOnly)
            case .cancelled: controls.back()
            }
        }
        return sheet.card
    }
}

// MARK: - New Agent's sheet (AgentProfilePicker.tsx)

/// The profiles, and every earlier session in the folder with a preview of
/// how it ended beside the list.
@MainActor
final class AgentPickerSheet {
    enum Result {
        case agent(AgentChoice)
        case editorOnly
        case cancelled
    }

    let picker: PickerView
    let card: SheetCard
    var onAnswer: ((Result) -> Void)?
    private let preview: SessionPreviewView?
    private let title: String
    private let question: String
    private let step: Int?
    private let hint: String
    private var failure: String?
    private let place: WorkspacePlace?
    private let openEditor: Bool
    private var profiles: SheetProfiles?
    private var listings: [String: SheetRows.Listing] = [:]
    private var rows = SheetRows.AgentRows(items: [], targets: [:], sessionCount: 0, refusals: [])
    private var previews: [String: SheetRows.Preview] = [:]
    private var previewTimer: Timer?
    private var previewKey: String?
    private weak var flow: SheetFlow?

    init(
        flow: SheetFlow, title: String, question: String, step: Int?, hint: String, failure: String?, place: WorkspacePlace?,
        openEditor: Bool
    ) {
        self.flow = flow
        self.title = title
        self.question = question
        self.step = step
        self.hint = hint
        self.failure = failure
        self.place = place
        self.openEditor = openEditor
        let preview = place == nil ? nil : SessionPreviewView(style: flow.style)
        self.preview = preview
        let initial = SheetRows.agentPicker(
            title: title, question: question, step: step, hint: hint, failure: failure, rows: rows,
            availability: .ready)
        var busy = initial
        busy.busy = true
        picker = PickerView(prompt: busy, style: flow.style, aside: preview)
        picker.asideShown = false
        card = flow.card(for: picker)
        card.owner = self
        picker.onActiveChange = { [weak self] item in self?.pointed(at: item) }
        picker.onOutcome = { [weak self] outcome in self?.answered(outcome) }
        Task { @MainActor [weak self] in await self?.load() }
    }

    private func load() async {
        guard let services = flow?.services else {
            profiles = SheetProfiles(profiles: [], availability: .unavailable)
            refresh()
            return
        }
        let profiles = await services.profiles()
        self.profiles = profiles
        if let place {
            for profile in profiles.profiles where SheetRows.lists(profile.kind) {
                listings[profile.id] = .reading
                let id = profile.id
                Task { @MainActor [weak self] in
                    do {
                        let sessions = try await services.listAgentSessions(place: place, profileId: id)
                        self?.settle(id, .listed(sessions))
                    } catch {
                        self?.settle(id, .failed(SpokenFailure.said(error)))
                    }
                }
            }
        }
        refresh()
    }

    private func settle(_ id: String, _ listing: SheetRows.Listing) {
        listings[id] = listing
        refresh()
    }

    private func refresh() {
        guard let profiles else { return }
        rows = SheetRows.agentRows(profiles.profiles, listings: listings, openEditor: openEditor, now: Date().timeIntervalSince1970 * 1000)
        let prompt = SheetRows.agentPicker(
            title: title, question: question, step: step, hint: hint, failure: failure, rows: rows,
            availability: profiles.availability)
        let showAside = preview != nil && rows.sessionCount > 0
        if showAside != picker.asideShown {
            card.preferredWidth = showAside ? 840 : 560
            picker.asideShown = showAside
        }
        picker.update(prompt)
    }

    private func pointed(at item: PickerItem?) {
        guard let preview, let place else { return }
        previewTimer?.invalidate()
        guard let item, let target = rows.targets[item.id], let session = target.session else {
            previewKey = nil
            preview.show(nil)
            return
        }
        let key = item.id
        previewKey = key
        if let known = previews[key] {
            preview.show(known)
            return
        }
        preview.show(.reading)
        guard let cwd = session.cwd else {
            let failed = SheetRows.Preview.failed(SheetRows.previewWithoutDirectory(target.profile.displayName))
            previews[key] = failed
            preview.show(failed)
            return
        }
        let profileId = target.profile.id
        let timer = Timer(timeInterval: 0.15, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let services = self.flow?.services else { return }
                Task { @MainActor [weak self] in
                    let read: SheetRows.Preview
                    do {
                        read = .read(try await services.previewAgentSession(place: place, profileId: profileId, session: session.id, cwd: cwd))
                        self?.previews[key] = read
                    } catch {
                        read = .failed(SpokenFailure.said(error))
                    }
                    if self?.previewKey == key { self?.preview?.show(read) }
                }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        previewTimer = timer
    }

    private func answered(_ outcome: PickerOutcome) {
        previewTimer?.invalidate()
        switch outcome {
        case .cancel:
            onAnswer?(.cancelled)
        case let .choose(choice):
            if choice.id == SheetRows.openEditorRow {
                onAnswer?(.editorOnly)
                return
            }
            guard let target = rows.targets[choice.id] else {
                picker.release(failure: nil)
                return
            }
            onAnswer?(.agent(AgentChoice(
                profileId: target.profile.id, split: choice.split,
                presentation: target.profile.launchPresentation(alternate: choice.alternate), resume: target.session?.id)))
        }
    }

    /// Show it in `flow` and wait for its answer.
    func ask(in flow: SheetFlow) async -> Result {
        let answer = Answer<Result>()
        onAnswer = { answer.give(.success($0)) }
        flow.show(card)
        picker.focusField()
        return (try? await answer.wait()) ?? .cancelled
    }
}
