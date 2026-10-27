// Port of apps/desktop/src/settings/SettingsApp.tsx and of
// main/shell/settingsWindow.ts's window half: DevHub Settings, a Mac
// preferences window. Seven screens in its toolbar; a change applies as it is
// made, saved 400ms after the last one against the revision it was drafted
// from; a refused save, or a file that does not parse, is a band across the
// top with Reload; a key DevHub stopped reading is a quieter band. Escape
// lets go of a field first and closes the window after. The socket and the
// reset links ask first, with the same questions sheet the main window uses.
//
// Opening it while it is already the front window closes it (the menu item
// and `Cmd+Q ,` toggle it).

import AppKit
import DevHubCore

/// The window: Escape, with nothing to let go of, closes it.
@MainActor
final class SettingsWindow: NSWindow {
    override func cancelOperation(_ sender: Any?) { performClose(sender) }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 0x35 {
            performClose(nil)
            return
        }
        super.keyDown(with: event)
    }
}

@MainActor
final class SettingsWindowController: NSWindowController, NSWindowDelegate, NSToolbarDelegate, SettingsContext {
    static let identifier = NSUserInterfaceItemIdentifier("devhub.settings")
    private let service: SettingsService
    private var style: ShellStyle
    private var session = SettingsSession()
    private var section: SettingsSection = .general
    private var selections: [SettingsSection: Int] = [:]
    private var saveTimer: Timer?
    private(set) var busy = false
    private(set) var status: String?
    private var shownConfig: Config?
    private let root = FlippedView()
    private let bands = NSStackView()
    private var body: NSView?
    private var kit: SettingsKit
    private let sheets: SheetLayerView
    /// The keyboard went back to the main window when this one closed.
    var onClose: (() -> Void)?

    init(service: SettingsService, style: ShellStyle) {
        self.service = service
        self.style = style
        kit = SettingsKit(style: style)
        sheets = SheetLayerView(style: style)
        let window = SettingsWindow(
            contentRect: NSRect(x: 0, y: 0, width: 880, height: 640),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "DevHub Settings"
        window.identifier = Self.identifier
        window.minSize = NSSize(width: 740, height: 420)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.toolbarStyle = .preference
        super.init(window: window)
        window.delegate = self
        window.setFrameAutosaveName("DevHubSettingsWindow")
        if !window.setFrameUsingName("DevHubSettingsWindow") { window.center() }
        let toolbar = NSToolbar(identifier: "devhub.settings.toolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconAndLabel
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar
        toolbar.selectedItemIdentifier = Self.item(.general)
        root.wantsLayer = true
        window.contentView = root
        bands.orientation = .vertical
        bands.spacing = 0
        bands.alignment = .leading
        bands.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(bands)
        sheets.isHidden = true
        sheets.translatesAutoresizingMaskIntoConstraints = true
        root.addSubview(sheets)
        NSLayoutConstraint.activate([
            bands.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            bands.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            bands.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor),
        ])
        restyle(style)
        showLoading()
        Task { await self.load() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: Opening and closing

    /// Show it, or close it when it is already the front window.
    func toggle() {
        guard let window else { return }
        if window.isKeyWindow && window.isVisible {
            window.performClose(nil)
            return
        }
        NSApp.activate()
        showWindow(nil)
        window.makeKeyAndOrderFront(nil)
        Task { await refresh() }
    }

    func windowWillClose(_ notification: Notification) {
        // What is being typed is applied, as leaving the field would.
        window?.makeFirstResponder(nil)
        flushSave()
        onClose?()
    }

    private var paintedWith: [String: String] = [:]

    func restyle(_ style: ShellStyle) {
        self.style = style
        let css = style.tokens.cssVariables
        if css == paintedWith, session.snapshot != nil { return }
        paintedWith = css
        kit = SettingsKit(style: style)
        root.layer?.backgroundColor = style.tokens.canvas.cgColor
        window?.appearance = style.tokens.palette.base == .dark ? NSAppearance(named: .darkAqua) : NSAppearance(named: .aqua)
        sheets.restyle(style)
        if session.snapshot != nil { rebuild() }
    }

    // MARK: The snapshot

    private func load() async {
        do {
            adopt(try await service.snapshot())
        } catch {
            session.refuse(SettingsRules.Refusal.of(error))
            showLoading()
        }
    }

    /// The config changed somewhere (a save here, or the file edited elsewhere).
    func refresh() async {
        guard let next = try? await service.snapshot() else { return }
        adopt(next)
    }

    private func adopt(_ next: SettingsSnapshot) {
        session.adopt(next)
        if session.draft != shownConfig || body == nil { rebuild() } else { renderBands() }
    }

    private func showLoading() {
        body?.removeFromSuperview()
        let state = SurfaceStateView(style: style)
        state.paintsSurface = false
        if let notice = session.notice {
            state.show(.failure(title: "Settings could not be read", detail: notice, actions: [SurfaceAction(label: "Reload", primary: true) { [weak self] in self?.reload() }]))
        } else {
            state.show(.waiting("Loading settings"))
        }
        place(state)
    }

    private func place(_ view: NSView) {
        body?.removeFromSuperview()
        body = view
        view.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(view, positioned: .below, relativeTo: sheets)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            view.topAnchor.constraint(equalTo: bands.bottomAnchor),
            view.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])
    }

    /// The screen, drawn again from the draft.
    private func rebuild() {
        guard session.snapshot != nil, let draft = session.draft else { return showLoading() }
        let scroll = (body as? FormScrollView)?.scrollY
        let focused = (window?.firstResponder as? NSView).flatMap(Self.fieldLabel)
        shownConfig = draft
        renderBands()
        let view = SettingsSections.view(section, kit: kit, context: self)
        place(view)
        root.layoutSubtreeIfNeeded()
        if let scroll, let form = view as? FormScrollView { form.scrollY = scroll }
        if let focused, let field = Self.field(labelled: focused, in: view) {
            window?.makeFirstResponder(field)
        }
    }

    /// The accessible name of the field the keyboard is in, to put it back.
    private static func fieldLabel(_ view: NSView) -> String? {
        var current: NSView? = view
        while let candidate = current {
            if let field = candidate as? NSTextField, field.isEditable { return field.accessibilityLabel() }
            current = candidate.superview
        }
        return nil
    }

    private static func field(labelled label: String, in view: NSView) -> NSTextField? {
        if let field = view as? NSTextField, field.isEditable, field.accessibilityLabel() == label { return field }
        for child in view.subviews {
            if let found = field(labelled: label, in: child) { return found }
        }
        return nil
    }

    // MARK: The bands across the top

    private func renderBands() {
        for view in bands.arrangedSubviews {
            bands.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        guard let snapshot = session.snapshot else { return }
        let dark = style.tokens.palette.base == .dark
        if let notice = session.notice {
            var buttons: [NSView] = []
            if session.refusal.alert != nil {
                buttons.append(kit.button("Dismiss") { [weak self] in
                    self?.session.dismissRefusal()
                    self?.renderBands()
                })
            }
            buttons.append(kit.button("Reload") { [weak self] in self?.reload() })
            addBand(notice, ground: dark ? NSColor(srgbRed: 0x3A / 255, green: 0x2A / 255, blue: 0x12 / 255, alpha: 1)
                : NSColor(srgbRed: 1, green: 0xF4 / 255, blue: 0xE5 / 255, alpha: 1), ink: style.tokens.primary.nsColor, buttons: buttons)
        }
        for retired in snapshot.notices {
            addBand(SettingsEdits.retiredNote(retired), ground: dark ? NSColor(srgbRed: 0x23 / 255, green: 0x27 / 255, blue: 0x2E / 255, alpha: 1)
                : NSColor(srgbRed: 0xEE / 255, green: 0xF2 / 255, blue: 0xF7 / 255, alpha: 1), ink: style.tokens.secondary.nsColor, buttons: [])
        }
    }

    private func addBand(_ text: String, ground: NSColor, ink: NSColor, buttons: [NSView]) {
        let band = BandView()
        band.fill = ground
        band.translatesAutoresizingMaskIntoConstraints = false
        let label = kit.label(text, size: 12, color: ink, selectable: true)
        let line = kit.horizontal([label] + buttons, spacing: Space.s4)
        band.addSubview(line)
        let rule = BandView()
        rule.fill = style.tokens.line.nsColor
        rule.translatesAutoresizingMaskIntoConstraints = false
        band.addSubview(rule)
        NSLayoutConstraint.activate([
            line.leadingAnchor.constraint(equalTo: band.leadingAnchor, constant: Space.s4),
            line.trailingAnchor.constraint(equalTo: band.trailingAnchor, constant: -Space.s4),
            line.topAnchor.constraint(equalTo: band.topAnchor, constant: Space.s2),
            line.bottomAnchor.constraint(equalTo: rule.topAnchor, constant: -Space.s2),
            rule.leadingAnchor.constraint(equalTo: band.leadingAnchor),
            rule.trailingAnchor.constraint(equalTo: band.trailingAnchor),
            rule.bottomAnchor.constraint(equalTo: band.bottomAnchor),
            rule.heightAnchor.constraint(equalToConstant: 1),
        ])
        bands.addArrangedSubview(band)
        band.widthAnchor.constraint(equalTo: bands.widthAnchor).isActive = true
    }

    // MARK: SettingsContext

    var draft: Config { session.draft ?? Config.defaults }
    var snapshot: SettingsSnapshot { session.snapshot! }
    var socketDraft: String { session.socketDraft ?? draft.runtimes.tmuxSocketName }

    func selected(_ section: SettingsSection) -> Int { selections[section] ?? 0 }

    func select(_ section: SettingsSection, _ index: Int) {
        guard selections[section] != index || self.section != section else { return }
        selections[section] = index
        DispatchQueue.main.async { [weak self] in self?.rebuild() }
    }

    /// `update`: the draft moves now; the save follows 400ms after the last change.
    func update(_ next: Config, rebuild redraw: Bool) {
        guard let snapshot = session.snapshot else { return }
        let count = session.edit(next)
        acted()
        // After the control that changed has finished telling us: a field
        // ending its editing must not be taken away from under itself.
        if redraw { DispatchQueue.main.async { [weak self] in self?.rebuild() } } else { shownConfig = next }
        let revision = snapshot.revision
        let timer = Timer(timeInterval: 0.4, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.save(next, revision: revision, count: count) }
        }
        RunLoop.main.add(timer, forMode: .common)
        saveTimer = timer
    }

    /// The person did something: the timer of the last change goes, and a refusal with it.
    private func acted() {
        saveTimer?.invalidate()
        saveTimer = nil
        session.acted()
    }

    private func flushSave() {
        guard let timer = saveTimer else { return }
        timer.fire()
        saveTimer = nil
    }

    private func save(_ config: Config, revision: ContentRevision, count: Int) {
        saveTimer = nil
        run({ try await $0.save(revision: revision, config: config) }) { [weak self] snapshot in
            self?.session.settle(count)
            self?.adopt(snapshot)
        }
    }

    /// One call to the service with the window busy, its refusal in the band.
    private func run(_ work: @escaping @Sendable (SettingsService) async throws -> SettingsSnapshot, then: @escaping (SettingsSnapshot) -> Void) {
        busy = true
        let service = self.service
        Task { @MainActor [weak self] in
            do {
                let snapshot = try await work(service)
                self?.busy = false
                then(snapshot)
            } catch {
                guard let self else { return }
                self.busy = false
                self.session.refuse(SettingsRules.Refusal.of(error))
                self.renderBands()
            }
        }
    }

    func reset(_ section: SettingsSection) {
        Task { @MainActor [weak self] in
            guard let self, await self.ask(SettingsEdits.resetPrompt(section.resetName)) == SettingsEdits.resetSettingsRow,
                  let snapshot = self.session.snapshot else { return }
            self.acted()
            self.run({ try await $0.resetScope(revision: snapshot.revision, keys: section.scope) }) { [weak self] next in
                self?.session.discardEdits()
                self?.adopt(next)
                self?.rebuild()
            }
        }
    }

    private func reload() {
        acted()
        run({ try await $0.reload() }) { [weak self] next in
            self?.session.discardEdits()
            self?.adopt(next)
            self?.rebuild()
        }
    }

    func editSocket(_ text: String) {
        session.editSocket(text)
        DispatchQueue.main.async { [weak self] in self?.rebuild() }
    }

    func changeSocket() {
        let requested = socketDraft.trimmingCharacters(in: .whitespaces)
        guard !requested.isEmpty else { return }
        acted()
        busy = true
        let service = self.service
        Task { @MainActor [weak self] in
            let preflight: TerminalPreflight?
            do {
                preflight = try await service.socketPreflight(requested)
            } catch {
                preflight = nil
            }
            guard let self else { return }
            self.busy = false
            guard await self.ask(SettingsEdits.socketPrompt(preflight, requested: requested)) == SettingsEdits.changeSocketRow else { return }
            self.run({ try await $0.socketApply(requested) }) { [weak self] next in
                self?.session.discardEdits()
                self?.adopt(next)
                self?.rebuild()
            }
        }
    }

    func recheck() {
        acted()
        run({ try await $0.recheck() }) { [weak self] next in self?.adopt(next) }
    }

    func openLogs() {
        guard let directory = session.snapshot?.logDirectory else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: directory)])
    }

    func copySummary() {
        let service = self.service
        Task { @MainActor [weak self] in
            do {
                let summary = try await service.summary()
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(summary, forType: .string)
                self?.status = "Copied."
            } catch {
                self?.status = SpokenFailure.said(error)
            }
            self?.rebuild()
        }
    }

    // MARK: The questions (the reset link, the socket)

    /// One picker over this window; the id of the row taken, or nil.
    private func ask(_ prompt: PickerPrompt) async -> String? {
        let picker = PickerView(prompt: prompt, style: style)
        let card = SheetCard(content: picker, width: 560, style: style) { [weak picker] width in picker?.preferredHeight(width: width) ?? 200 }
        card.keyView = picker.field
        card.onCancel = { [weak picker] in picker?.cancel() }
        sheets.frame = root.bounds
        sheets.autoresizingMask = [.width, .height]
        sheets.isHidden = false
        sheets.push(card)
        let answer = Answer<PickerOutcome>()
        picker.onOutcome = { outcome in answer.give(.success(outcome)) }
        let outcome = (try? await answer.wait()) ?? .cancel
        sheets.remove(card)
        sheets.isHidden = sheets.cards.isEmpty
        if case let .choose(choice) = outcome { return choice.id }
        return nil
    }

    // MARK: The toolbar

    private static func item(_ section: SettingsSection) -> NSToolbarItem.Identifier {
        NSToolbarItem.Identifier("devhub.settings.\(section.rawValue)")
    }

    private static func symbol(_ section: SettingsSection) -> String {
        switch section {
        case .general: return "gearshape"
        case .workspaces: return "folder"
        case .agents: return "cpu"
        case .actions: return "bolt"
        case .keyboard: return "keyboard"
        case .terminal: return "terminal"
        case .advanced: return "slider.horizontal.3"
        }
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        SettingsSection.allCases.map(Self.item)
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        SettingsSection.allCases.map(Self.item)
    }

    func toolbarSelectableItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        SettingsSection.allCases.map(Self.item)
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard let section = SettingsSection.allCases.first(where: { Self.item($0) == identifier }) else { return nil }
        let item = NSToolbarItem(itemIdentifier: identifier)
        item.label = section.rawValue
        item.image = NSImage(systemSymbolName: Self.symbol(section), accessibilityDescription: section.rawValue)
        item.target = self
        item.action = #selector(choose(_:))
        return item
    }

    @objc private func choose(_ sender: NSToolbarItem) {
        guard let section = SettingsSection.allCases.first(where: { Self.item($0) == sender.itemIdentifier }) else { return }
        show(section)
    }

    /// Switch screens (the self-test, and the toolbar).
    func show(_ next: SettingsSection) {
        window?.makeFirstResponder(nil)
        section = next
        window?.toolbar?.selectedItemIdentifier = Self.item(next)
        rebuild()
    }

    /// The screen on show (the self-test reads it).
    var currentSection: SettingsSection { section }
    var isLoaded: Bool { session.snapshot != nil }
}
