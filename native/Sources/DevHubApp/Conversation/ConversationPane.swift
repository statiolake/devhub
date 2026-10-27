// Port of apps/desktop/src/shell/agents/ConversationPane.tsx and
// apps/desktop/src/shell/conversation/ConversationSurface.tsx: a GUI Agent's
// pane, its conversation attached and drawn.
//
// It asks the transport for the conversation once, folds every update after
// it with the same `applyEvent` Core folded them with (`ConversationFollower`),
// and draws the result: the transcript, the requests waiting over the
// composer, the composer, and beside them the subagents' column when the pane
// is wide — or, in its place, the subagent the person maximized. What is
// drawn is published at most once a frame: a streaming answer sends a delta
// per token.
//
// Esc and Ctrl+C stop a running turn from anywhere in the pane, as they do in
// a terminal Agent; being shown puts the keyboard in the composer. Cmd+F
// opens the find bar, and F3 / Shift+F3 step through its matches.

import AppKit
import DevHubCore

/// The calls a pane makes, bound to the app's transport once it is up.
@MainActor
final class ConversationLink {
    private(set) var transport: ConversationTransport?
    private var panes: [String: ConversationPaneView] = [:]
    private var waiting: [String] = []
    private var listening: Task<Void, Never>?
    /// A failure to tell the person (the notices layer).
    var report: ((AppError) -> Void)?
    /// The Agent's Workspace's repository, for its issue links.
    var repository: ((String) -> WorkspaceRepositoryWire?)?

    func adopt(_ transport: ConversationTransport) {
        self.transport = transport
        let stream = transport.updates()
        listening?.cancel()
        listening = Task { @MainActor [weak self] in
            for await update in stream {
                self?.panes[update.agentId]?.take(update)
            }
        }
        for agent in waiting { panes[agent]?.attach() }
        waiting = []
    }

    func register(_ pane: ConversationPaneView) {
        panes[pane.agentId] = pane
        if transport != nil { pane.attach() } else { waiting.append(pane.agentId) }
    }

    func pane(_ agentId: String) -> ConversationPaneView? { panes[agentId] }

    func unregister(_ pane: ConversationPaneView) {
        guard panes[pane.agentId] === pane else { return }
        panes[pane.agentId] = nil
        waiting.removeAll { $0 == pane.agentId }
        if let transport {
            let id = pane.agentId
            Task { await transport.detach(id) }
        }
    }
}

@MainActor
final class ConversationPaneView: NSView, HostedConversation {
    let agentId: String
    let workspaceId: String
    private(set) var label: String
    private let link: ConversationLink
    private var shell: ShellStyle
    private var style: ConversationStyle
    private var follower: ConversationFollower
    private var transcript: Transcript = EMPTY_TRANSCRIPT
    private var agent: AgentWire?
    private var disposed = false
    private var publishScheduled = false

    // The view's state: what the person's hand changed.
    private var state = EntryDocumentState()
    private var rewindTargets: Set<EntryId> = []
    private var turnsEnded = 0
    private var pathLinks: PathLinks!
    /// Counts what the path links learnt, so the sections drawn with the old knowledge are drawn again.
    private var pathRevision = 0
    /// When the running turn began, for the activity line's clock.
    private var activityStarted: Date?
    private var unsubscribePaths: (() -> Void)?
    private var restored: EntryId?

    // The views.
    private let main = TranscriptScroller(style: ConversationStyle(ShellStyle.initial(dark: false, titleBar: .shown)))
    private let composer: ComposerView
    private let waiting: ConversationButton
    private let empty = EmptyStateView()
    private var findBar: FindBarView?
    private var search: TranscriptSearch?
    private var searchDocuments: [DocSection] = []
    private var focusBeforeFind: NSResponder?
    private var column = SubagentColumnView()
    private var maximized: SubagentPaneView?
    private var resume: SessionPickerPanel?
    private var mcp: McpPanelView?
    private var shown = false
    private var keyMonitor: Any?

    init(agentId: String, workspaceId: String, label: String, style shell: ShellStyle, link: ConversationLink) {
        self.agentId = agentId
        self.workspaceId = workspaceId
        self.label = label
        self.link = link
        self.shell = shell
        style = ConversationStyle(shell)
        follower = ConversationFollower(agentId: agentId)
        composer = ComposerView(style: style)
        waiting = ConversationButton(label: "", look: .bordered, size: style.em(0.85), style: style)
        super.init(frame: .zero)
        wantsLayer = true
        main.text.owner = self
        main.text.embeds.host = self
        addSubview(main)
        addSubview(empty)
        addSubview(waiting)
        addSubview(composer)
        addSubview(composer.completions)
        composer.completions.isHidden = true
        addSubview(column)
        column.pane = self
        composer.host = self
        waiting.isHidden = true
        waiting.onPress = { [weak self] in self?.showFirstRequest() }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(label)
        registerForDraggedTypes([.fileURL, .png, .tiff])
        pathLinks = PathLinks(resolve: { [weak self] cwd, paths in
            guard let self, let transport = self.link.transport else { return paths.map { _ in nil } }
            return try await transport.resolvePaths(self.agentId, cwd: cwd, paths)
        }, reportFailure: { [weak self] error in self?.reportError(error) })
        unsubscribePaths = pathLinks.subscribe { [weak self] in
            self?.pathRevision += 1
            self?.redraw()
        }
        applyStyle(shell)
        link.register(self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    // MARK: HostedConversation

    var view: NSView { self }

    func setShown(_ shown: Bool) {
        let was = self.shown
        self.shown = shown
        isHidden = !shown
        main.shown = shown && maximized == nil
        if shown && !was {
            // What arrived while nobody was looking is not news.
            main.settle()
            installKeys()
            if ComposerWords.inputRefusal(transcript.state) == nil { focus() }
        } else if !shown && was {
            removeKeys()
            composer.flushDraft()
        }
    }

    func applyStyle(_ shell: ShellStyle) {
        self.shell = shell
        style = ConversationStyle(shell)
        layer?.backgroundColor = style.surface.cgColor
        main.applyStyle(style)
        composer.applyStyle(style)
        waiting.style = style
        waiting.size = style.em(0.85)
        empty.style = style
        findBar?.style = style
        column.applyStyle(style)
        maximized?.applyStyle(style)
        redraw()
    }

    func update(_ agent: AgentWire, snapshot: AppSnapshotWire) {
        self.agent = agent
        if agent.displayName != label {
            label = agent.displayName
            setAccessibilityLabel(label)
        }
    }

    func focus() {
        if let findBar, findBar.window != nil, window?.firstResponder === findBar.field.currentEditor() { return }
        window?.makeFirstResponder(composer.field)
    }

    func owns(_ responder: NSResponder?) -> Bool {
        guard let view = responder as? NSView else { return false }
        return view === self || view.isDescendant(of: self)
    }

    func dispose() {
        guard !disposed else { return }
        disposed = true
        composer.flushDraft()
        removeKeys()
        unsubscribePaths?()
        search?.dispose()
        link.unregister(self)
        follower.stop()
    }

    // MARK: The conversation

    func attach() {
        guard let transport = link.transport else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                let attachment = try await transport.attach(self.agentId)
                guard !self.disposed else { return }
                try self.follower.attached(attachment)
                self.composer.adoptDraft(attachment.draft)
                self.publish()
            } catch {
                if !self.disposed { self.reportError(error) }
            }
        }
    }

    func take(_ update: ConversationUpdate) {
        guard !disposed else { return }
        do {
            if try follower.take(update) { schedulePublish() }
        } catch {
            reportError(error)
        }
    }

    private func schedulePublish() {
        guard !publishScheduled else { return }
        publishScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 60) { [weak self] in
            MainActor.assumeIsolated {
                self?.publishScheduled = false
                self?.publish()
            }
        }
    }

    private func publish() {
        let next = follower.transcript
        let ended = next.entries.filter { $0.kind == "turn-end" }.count
        if ended != turnsEnded {
            turnsEnded = ended
            // A word that named no file is asked about again once a turn has ended: it may have made it.
            pathLinks.forgetAbsent()
        }
        transcript = next
        if ConversationActivity.of(next) == nil { activityStarted = nil }
        rewindTargets = DevHubCore.rewindTargets(next)
        redraw()
    }

    /// A refusal of the view's own, in words.
    private func report(_ message: String) {
        link.report?(errorWire(ConversationViewRefusal(description: message)))
    }

    /// A call that failed, as the app names failures.
    private func reportError(_ error: Error) {
        link.report?(errorWire(error))
    }

    // MARK: Drawing

    private var wide: Bool { bounds.width >= CGFloat(Subagents.widePanePx) }

    private func documentState() -> EntryDocumentState {
        var state = self.state
        state.rewindTargets = rewindTargets
        state.skillWords = SkillTokens.words(transcript.session.commands)
        state.layout.update(transcript, wide: wide)
        self.state.layout = state.layout
        let cwd = transcript.session.cwd
        let paths: PathLinks = pathLinks
        state.links = LinkContext(cwd: cwd, issues: IssueRepository(link.repository?(workspaceId)), file: { cwd, path in
            MainActor.assumeIsolated { paths.file(cwd, path) }
        })
        state.now = Date().timeIntervalSince1970 * 1000
        return state
    }

    private func redraw() {
        guard !disposed else { return }
        let state = documentState()
        let tree = EntryTree(transcript)
        let builder = EntryDocumentBuilder(transcript: transcript, tree: tree, state: state)
        let sections = cachedSections(builder)
        for section in sections { for path in section.candidates { pathLinks.want(transcript.session.cwd, path) } }
        main.show(sections)
        empty.isHidden = !(tree.topLevel.isEmpty && transcript.sending.isEmpty && tree.unattached.isEmpty)
        composer.update(transcript)
        waiting.isHidden = transcript.requests.isEmpty
        waiting.label = SurfaceWords.waitingSentence(transcript.requests.count) + " ↑"
        // The subagents beside the conversation, or the one filling the pane.
        column.update(builder, state.layout, wide: wide)
        if let maximizedEntry = state.layout.maximized {
            if maximized?.entryId != maximizedEntry.id {
                maximized?.removeFromSuperview()
                let pane = SubagentPaneView(entry: maximizedEntry, place: .maximized, style: style, pane: self)
                addSubview(pane, positioned: .below, relativeTo: composer)
                maximized = pane
            }
            maximized?.update(maximizedEntry, builder: builder)
        } else if let pane = maximized {
            pane.removeFromSuperview()
            maximized = nil
        }
        main.isHidden = maximized != nil
        main.shown = shown && maximized == nil
        mcp?.update(transcript.mcp, signIn: transcript.mcpSignIn)
        refreshSearch()
        needsLayout = true
    }

    // Sections kept by their entry's fingerprint, so a delta builds only what it grew.
    private var sectionCache: [String: (fingerprint: Int, section: DocSection)] = [:]
    private var cacheState: Int = 0

    private func stateFingerprint(_ state: EntryDocumentState) -> Int {
        var hasher = Hasher()
        hasher.combine(state.chosenFolds)
        hasher.combine(state.openClips)
        hasher.combine(state.unfoldedOther)
        hasher.combine(state.confirming)
        hasher.combine(state.rewindTargets)
        hasher.combine(state.skillWords)
        hasher.combine(pathRevision)
        hasher.combine(transcript.session.cwd)
        return hasher.finalize()
    }

    private func cachedSections(_ builder: EntryDocumentBuilder) -> [DocSection] {
        let stateKey = stateFingerprint(builder.state)
        if stateKey != cacheState {
            sectionCache = [:]
            cacheState = stateKey
        }
        var out: [DocSection] = []
        var used: Set<String> = []
        for entry in builder.tree.topLevel {
            let print = builder.fingerprint(entry)
            used.insert(entry.id.raw)
            if let kept = sectionCache[entry.id.raw], kept.fingerprint == print {
                out.append(kept.section)
                continue
            }
            guard let section = builder.section(entry, depth: 0) else {
                sectionCache[entry.id.raw] = nil
                continue
            }
            sectionCache[entry.id.raw] = (print, section)
            out.append(section)
        }
        for key in sectionCache.keys where !used.contains(key) { sectionCache[key] = nil }
        // The rest is the transcript's own end: few, and drawn afresh.
        return out + builder.trailingSections()
    }

    // MARK: Layout

    override func layout() {
        super.layout()
        let width = bounds.width
        let columnWidth = column.isHidden ? 0 : CGFloat(state.layout.column.drawnWidth(across: Double(width)))
        let mainWidth = width - columnWidth
        composer.paneHeight = bounds.height
        let composerHeight = composer.height(forWidth: min(mainWidth, style.measure + 2 * CGFloat(SurfaceMetrics.gutterPx)), paneHeight: bounds.height)
        let composerWidth = min(mainWidth, style.measure + 2 * CGFloat(SurfaceMetrics.gutterPx))
        composer.frame = NSRect(x: (mainWidth - composerWidth) / 2, y: bounds.height - composerHeight, width: composerWidth, height: composerHeight)
        var bottom = composer.frame.minY
        if !waiting.isHidden {
            let height = waiting.intrinsicContentSize.height + 4
            let w = min(mainWidth - 2 * CGFloat(SurfaceMetrics.gutterPx), style.measure)
            waiting.frame = NSRect(x: (mainWidth - w) / 2, y: bottom - height - style.px(8), width: w, height: height)
            waiting.layer?.cornerRadius = height / 2
            bottom = waiting.frame.minY
        }
        let transcriptFrame = NSRect(x: 0, y: 0, width: mainWidth, height: max(0, bottom))
        main.frame = transcriptFrame
        maximized?.frame = transcriptFrame
        empty.frame = transcriptFrame
        column.frame = NSRect(x: mainWidth, y: 0, width: columnWidth, height: bounds.height)
        if let findBar {
            let size = findBar.fittingSize
            findBar.frame = NSRect(x: mainWidth - size.width - style.px(12), y: style.px(12), width: size.width, height: size.height)
        }
        // The command list, over the box.
        if !composer.completions.isHidden {
            let anchor = convert(composer.completionsAnchor, from: composer)
            let gutter = CGFloat(SurfaceMetrics.gutterPx)
            let listWidth = composer.frame.width - 2 * gutter
            let height = composer.completions.height(forWidth: listWidth, most: bounds.height * 0.4)
            composer.completions.frame = NSRect(x: composer.frame.minX + gutter, y: anchor.minY + style.px(4) - height, width: listWidth, height: height)
        }
        resume?.frame = bounds
        mcp?.frame = bounds
    }

    override func setFrameSize(_ newSize: NSSize) {
        let wasWide = wide
        super.setFrameSize(newSize)
        if wide != wasWide { redraw() }
    }

    // MARK: Keys

    private func installKeys() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            nonisolated(unsafe) let pressed = event
            let handled = MainActor.assumeIsolated { self?.handleKey(pressed) ?? false }
            return handled ? nil : event
        }
    }

    private func removeKeys() {
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
    }

    /// The pane's keys, wherever the keyboard is in it (or nowhere).
    private func handleKey(_ event: NSEvent) -> Bool {
        guard shown, let window, event.window === window, !isHidden else { return false }
        let responder = window.firstResponder
        let inPane = owns(responder) || responder === window || responder == nil
        guard inPane else { return false }
        if let text = responder as? NSTextView, text.hasMarkedText() { return false }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let chars = event.charactersIgnoringModifiers?.lowercased() ?? ""
        if flags == .command, chars == "f" {
            openFind()
            return true
        }
        if findBar != nil, event.keyCode == 99, flags.isDisjoint(with: [.command, .control, .option]) {
            search?.step(flags.contains(.shift) ? -1 : 1)
            return true
        }
        guard transcript.state.turn == .running else { return false }
        let escape = event.keyCode == 53 && flags.isDisjoint(with: [.command, .control, .option])
        let ctrlC = chars == "c" && flags.contains(.control) && !flags.contains(.command) && !flags.contains(.option)
        guard escape || ctrlC else { return false }
        // Esc a field keeps for itself (the command list, an edit, the find bar) is its own.
        if escape {
            if !composer.completions.isHidden, responder === composer.field { return false }
            if let field = responder as? ComposerTextView, field !== composer.field { return false }
            if findBar != nil, responder === findBar?.field.currentEditor() { return false }
            if responder is RequestCardView { return false }
        }
        composer.run(.interrupt)
        return true
    }

    // MARK: Find

    private func openFind() {
        if let findBar {
            findBar.focusField()
            return
        }
        focusBeforeFind = window?.firstResponder
        let bar = FindBarView(style: style)
        bar.onQuery = { [weak self] query, caseSensitive in self?.search?.setQuery(query, caseSensitive: caseSensitive) }
        bar.onStep = { [weak self] delta in self?.search?.step(delta) }
        bar.onClose = { [weak self] in self?.closeFind() }
        addSubview(bar)
        findBar = bar
        let scope = state.layout.maximized.map { FindWords.subagentScope($0.spawns?.label ?? "") } ?? FindWords.conversationScope
        bar.scope = scope
        let made = TranscriptSearch(sections: searchSections(), onChange: { [weak self] in self?.searchChanged() })
        search = made
        needsLayout = true
        bar.focusField()
    }

    private func closeFind() {
        search?.dispose()
        search = nil
        findBar?.removeFromSuperview()
        findBar = nil
        main.text.findMatches = []
        main.text.findCurrent = nil
        maximized?.scroller.text.findMatches = []
        maximized?.scroller.text.findCurrent = nil
        if let before = focusBeforeFind as? NSView, before.window != nil { window?.makeFirstResponder(before) } else { focus() }
        focusBeforeFind = nil
    }

    private func searchSections() -> [SearchSection] {
        let state = documentState()
        let made = EntryDocumentBuilder.searchSections(transcript, state: state, pane: state.layout.maximized)
        searchDocuments = made.documents
        return made.sections
    }

    private func refreshSearch() {
        guard let search else { return }
        search.refresh(searchSections())
        paintMatches()
    }

    private var lastMoves = 0

    private func searchChanged() {
        guard let search, let findBar else { return }
        let status = search.status
        findBar.count = FindWords.countText(findBar.query, total: status.total, current: status.current, complete: status.complete)
        findBar.none = !findBar.query.isEmpty && status.total == 0
        if status.moves != lastMoves {
            lastMoves = status.moves
            if let current = search.currentMatch { revealMatch(current) }
        }
        paintMatches()
    }

    private var scroller: TranscriptScroller { maximized?.scroller ?? main }

    /// The drawn range of a match, if what it is in is drawn (not folded away).
    private func drawnRange(_ match: SearchMatch) -> NSRange? {
        guard let document = searchDocuments.first(where: { $0.id == match.section }) else { return nil }
        let parts = document.search.parts
        guard let part = parts.last(where: { $0.offset <= match.offset }) else { return nil }
        return scroller.text.drawnRange(section: match.section, key: part.key, offset: match.offset - part.offset, length: match.length)
    }

    private func paintMatches() {
        guard let search else { return }
        let text = scroller.text
        let visible = text.visibleCharacters
        var ranges: [NSRange] = []
        for section in searchDocuments {
            guard let drawn = text.range(ofSection: section.id), NSIntersectionRange(drawn, visible).length > 0 || NSLocationInRange(drawn.location, visible) else { continue }
            for offset in search.matches(in: section.id) {
                if let range = drawnRange(SearchMatch(section: section.id, offset: offset, length: search.matchLength)) { ranges.append(range) }
            }
        }
        text.findMatches = ranges
        text.findCurrent = search.currentMatch.flatMap(drawnRange)
    }

    /// The current match brought into view, every fold around it opened.
    private func revealMatch(_ match: SearchMatch) {
        guard let document = searchDocuments.first(where: { $0.id == match.section }),
              let part = document.search.parts.last(where: { $0.offset <= match.offset })
        else { return }
        var opened = false
        for fold in document.folds(containing: part.key) {
            if fold.hasPrefix("clip:") {
                let id = String(fold.dropFirst(5))
                if !state.openClips.contains(id) { state.openClips.insert(id); opened = true }
            } else if fold.hasPrefix("other:") {
                let id = EntryId(String(fold.dropFirst(6)))
                if !state.unfoldedOther.contains(id) { state.unfoldedOther.insert(id); opened = true }
            } else if state.chosenFolds[fold] != true {
                state.chosenFolds[fold] = true
                opened = true
            }
        }
        if opened { redraw() }
        if let range = drawnRange(match) { scroller.reveal(range) }
        paintMatches()
    }

    // MARK: Requests, tasks

    private func showFirstRequest() {
        guard let request = transcript.requests.first else { return }
        if maximized != nil { performAction(.maximize(nil)) }
        let key = request.entry.map { "\($0.raw)/request:\(request.id.raw)" } ?? "request:\(request.id.raw)"
        let section = request.entry.flatMap(topLevelSection(of:)) ?? "request:\(request.id.raw)"
        // Inside a subagent the person folded, every fold around it opens.
        if let entry = request.entry { openAround(entry) }
        if let range = main.text.range(ofKey: key, inSection: section) {
            main.reveal(range)
            if let card = main.text.embeds.view(for: key) as? RequestCardView { window?.makeFirstResponder(card) }
        }
    }

    /// The top-level entry an entry is drawn under.
    private func topLevelSection(of id: EntryId) -> String? {
        var current = transcript.entries.first { $0.id == id }
        while let entry = current, let parent = entry.parent {
            current = transcript.entries.first { $0.id == parent }
        }
        return current?.id.raw
    }

    private func openAround(_ id: EntryId) {
        var current = transcript.entries.first { $0.id == id }?.parent
        var changed = false
        while let parent = current {
            let fold = EntryFold.subagent(parent)
            if state.chosenFolds[fold] != true { state.chosenFolds[fold] = true; changed = true }
            current = transcript.entries.first { $0.id == parent }?.parent
        }
        if changed { redraw() }
    }

    /// A background task's call, opened: a subagent fills the pane; any other call is opened where it is drawn.
    private func openTask(_ call: EntryId) {
        if Subagents.all(transcript).contains(where: { $0.id == call }) {
            performAction(.maximize(call))
            return
        }
        if maximized != nil { performAction(.maximize(nil)) }
        state.chosenFolds[EntryFold.tool(call)] = true
        openAround(call)
        redraw()
        if let section = topLevelSection(of: call), let range = main.text.range(ofKey: "\(call.raw)/summary", inSection: section) {
            main.reveal(range)
        }
    }

    // MARK: Actions

    func performAction(_ action: DocAction) {
        switch action {
        case .toggle(let fold):
            let open: Bool
            if fold.hasPrefix("subagent:") {
                let id = EntryId(String(fold.dropFirst("subagent:".count)))
                let running = Subagents.all(transcript).first { $0.id == id }?.spawns?.state == .running
                open = state.chosenFolds[fold] ?? running
            } else {
                open = state.chosenFolds[fold] ?? false
            }
            main.holding(nil) {
                state.chosenFolds[fold] = !open
                redraw()
            }
        case .copy(_, let text):
            _ = copyToPasteboard(text)
        case .askRewind(let id):
            state.confirming.insert(id)
            redraw()
        case .cancelRewind(let id):
            state.confirming.remove(id)
            redraw()
        case .rewind(let id):
            state.confirming.remove(id)
            redraw()
            rewind(id)
        case .cancelLimitResume:
            composer.run(.cancelLimitResume)
        case .unfoldOther(let id):
            main.holding(nil) {
                if state.unfoldedOther.contains(id) { state.unfoldedOther.remove(id) } else { state.unfoldedOther.insert(id) }
                redraw()
            }
        case .maximize(let id):
            state.layout.maximize(id)
            redraw()
            if id == nil { main.settle() }
            if search != nil, let findBar {
                findBar.scope = state.layout.maximized.map { FindWords.subagentScope($0.spawns?.label ?? "") } ?? FindWords.conversationScope
                search?.dispose()
                search = TranscriptSearch(sections: searchSections(), onChange: { [weak self] in self?.searchChanged() })
                search?.setQuery(findBar.query, caseSensitive: findBar.caseSensitive)
            }
        case .setBeside(let id, let on):
            state.layout.setBeside(id, on)
            redraw()
        case .clip(let id):
            main.holding(nil) {
                if state.openClips.contains(id) { state.openClips.remove(id) } else { state.openClips.insert(id) }
                redraw()
            }
        }
    }

    private func rewind(_ id: EntryId) {
        guard let transport = link.transport else { return }
        let message = transcript.entries.first { $0.id == id }?.userEntry
        Task { [weak self] in
            guard let self else { return }
            do {
                if try await transport.rewind(self.agentId, to: id) == .rewound, let message {
                    // Its words come back to the composer, each rewind once.
                    if self.restored != id {
                        self.restored = id
                        self.composer.bringBack(message.text, images: message.images.filter { if case .data = $0.source { return true }; return false })
                    }
                }
            } catch {
                self.reportError(error)
            }
        }
    }

    func follow(_ link: DocLink) {
        switch link {
        case .url(let url), .issue(let url, _):
            if let address = URL(string: url) { NSWorkspace.shared.open(address) }
        case let .file(path, range):
            openFile(path, range)
        case .href(let candidate):
            Task { [weak self] in
                guard let self, let transport = self.link.transport else { return }
                do {
                    let resolved = try await transport.resolvePaths(self.agentId, cwd: self.transcript.session.cwd, [candidate.path])
                    if let path = resolved.first ?? nil { self.openFile(path, candidate.range) } else {
                        self.report("\(candidate.path) is not a file on the Agent's machine")
                    }
                } catch {
                    self.reportError(error)
                }
            }
        case .footnote(let target):
            if let section = main.text.rendered.first(where: { $0.source.blocks.contains { Self.holds($0, key: target) } })?.id,
               let range = main.text.range(ofKey: target, inSection: section)
            {
                main.reveal(range)
            }
        }
    }

    private static func holds(_ block: DocBlock, key: String) -> Bool {
        if block.key == key { return true }
        if case .box(let box) = block { return box.children.contains { holds($0, key: key) } }
        return false
    }

    private func openFile(_ path: String, _ range: FileRange?) {
        guard let transport = link.transport else { return }
        Task { [weak self] in
            guard let self else { return }
            do { try await transport.openFile(self.agentId, path: path, range: range) } catch { self.reportError(error) }
        }
    }

    func copyToPasteboard(_ text: String) -> Bool {
        let board = NSPasteboard.general
        board.clearContents()
        return board.setString(text, forType: .string)
    }

    // MARK: Dropping images on the pane

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) ? .copy : []
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        composer.dropImages(sender.draggingPasteboard)
    }

    // MARK: Panels

    func openResume() {
        guard let transport = link.transport else { return }
        let cli = agent.map { $0.profileKind == .codex ? "Codex" : "Claude" } ?? "Claude"
        let panel = SessionPickerPanel(
            title: "Resume a Session",
            question: "Which earlier session should \(label) go on with? The one it is in now is left as it is.",
            cli: cli, style: style,
            list: { [agentId] scope in try await transport.listSessions(agentId, scope: scope) },
            preview: { [agentId] session, cwd in try await transport.previewSession(agentId, session: session, cwd: cwd) })
        panel.onChoose = { [weak self] session in
            guard let self else { return }
            Task {
                do { try await transport.resumeSession(self.agentId, session: session) } catch { self.reportError(error) }
                self.closeResume()
            }
        }
        panel.onCancel = { [weak self] in self?.closeResume() }
        addSubview(panel)
        resume = panel
        needsLayout = true
        panel.start()
    }

    private func closeResume() {
        resume?.removeFromSuperview()
        resume = nil
        focus()
    }

    func openMcp() {
        guard let transport = link.transport else { return }
        let panel = McpPanelView(label: label, style: style, agentId: agentId, transport: transport)
        panel.onClose = { [weak self] in
            self?.mcp?.removeFromSuperview()
            self?.mcp = nil
            self?.focus()
        }
        panel.report = { [weak self] message in self?.report(message) }
        addSubview(panel)
        mcp = panel
        panel.update(transcript.mcp, signIn: transcript.mcpSignIn)
        needsLayout = true
        panel.start()
    }

    /// The composer's box, in `view`'s coordinates (what the Smart Buttons stand on).
    func composerBox(in view: NSView) -> NSRect {
        view.convert(composer.completionsAnchor, from: composer)
    }

    // MARK: The self-test's hold

    /// Instead of the transport, for a pane drawn from a fixture: what it would have sent.
    var commandSink: ((ConversationCommandWire) -> Bool)?

    /// Draw `transcript` as if the Agent's conversation said it.
    func showFixture(_ transcript: Transcript) {
        self.transcript = transcript
        rewindTargets = DevHubCore.rewindTargets(transcript)
        redraw()
    }

    var transcriptView: TranscriptScroller { main }
    var composerView: ComposerView { composer }
    var findStatus: SearchStatus? { search?.status }

    func findForTest(_ query: String) {
        openFind()
        findBar?.field.stringValue = query
        search?.setQuery(query, caseSensitive: false)
    }

    func stepFindForTest(_ delta: Int) { search?.step(delta) }
    var findCurrentRange: NSRange? { scroller.text.findCurrent }

    // MARK: Subagent panes

    func subagentHeaderAction(_ action: DocAction) { performAction(action) }

    func columnChanged(_ column: SubagentColumn) {
        state.layout.column = column
        redraw()
        self.column.needsLayout = true
    }

    var subagentLayout: SubagentLayout { state.layout }
}

// MARK: - The transcript's owner

extension ConversationPaneView: TranscriptViewOwner {
    func transcript(_ view: TranscriptTextView, perform action: DocAction) { performAction(action) }
    func transcript(_ view: TranscriptTextView, follow link: DocLink) { follow(link) }
    func transcript(_ view: TranscriptTextView, pointingAt section: String?) {
        for rendered in view.rendered {
            (view.embeds.view(for: rendered.id + "/actions") as? ActionsEmbedView)?.setEmphasised(rendered.id == section)
        }
    }
}

extension ConversationPaneView: EmbedHost {
    func answer(_ request: PendingRequest, _ answer: RequestAnswer) async -> Bool {
        await command(.answer(request: request.id, answer: answer))
    }

    func instruct(_ subagent: EntryId, _ text: String) async -> Bool {
        await command(.instruct(subagent: subagent, text: text))
    }

    func focusComposer() { window?.makeFirstResponder(composer.field) }

    func activityText() -> (label: String, meta: String, phase: String)? {
        guard let activity = ConversationActivity.of(transcript) else { return nil }
        if activityStarted == nil { activityStarted = Date() }
        let elapsed = Date().timeIntervalSince(activityStarted ?? Date()) * 1000
        return (activity.label, ConversationActivity.meta(elapsedMs: elapsed, tokens: ConversationActivity.estimateTokens(transcript)), activity.phase)
    }

    func embedResized(_ key: String) {
        main.holding(nil) { main.text.relayout(embed: key) }
        maximized?.scroller.text.relayout(embed: key)
        column.relayout(embed: key)
    }

    fileprivate func command(_ wire: ConversationCommandWire) async -> Bool {
        if let sink = commandSink { return sink(wire) }
        guard let transport = link.transport else { return false }
        do {
            try await transport.command(agentId, wire)
            return true
        } catch {
            reportError(error)
            return false
        }
    }
}

extension ConversationPaneView: ComposerHost {
    func composerSend(_ text: String, images: [ImageRef]) async -> Bool { await command(.send(text: text, images: images)) }
    func composerCommand(_ wire: ConversationCommandWire) async -> Bool { await command(wire) }
    func composerOpenResume() { openResume() }
    func composerOpenMcp() { openMcp() }
    func composerRestart() {
        guard let transport = link.transport else { return }
        Task { [weak self] in
            guard let self else { return }
            do { try await transport.restartSession(self.agentId) } catch { self.reportError(error) }
        }
    }

    func composerCliDefaults(model: String?) async -> CliDefaults? {
        guard let transport = link.transport else { return nil }
        return try? await transport.cliDefaults(agentId, model: model)
    }

    func composerSetCliDefault(_ which: ClaudeDefaultName, value: String, model: String?) async -> Bool {
        guard let transport = link.transport else { return false }
        do {
            try await transport.setCliDefault(agentId, which, value: value, model: model)
            return true
        } catch {
            reportError(error)
            return false
        }
    }

    func composerSaveDraft(_ text: String) { link.transport?.saveDraft(agentId, text) }
    func composerOpenTask(_ call: EntryId) { openTask(call) }
    func composerReport(_ message: String) { report(message) }
    func composerResized() { needsLayout = true }
}

// MARK: - The empty state

@MainActor
final class EmptyStateView: NSView {
    var style: ConversationStyle! { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        guard let style else { return }
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let title = NSAttributedString(string: SurfaceWords.emptyTitle, attributes: [
            .font: style.sans(style.em(1.35), bold: true), .foregroundColor: style.ink(.primary), .paragraphStyle: paragraph, .kern: -0.01 * style.em(1.35),
        ])
        let hint = NSAttributedString(string: SurfaceWords.emptyHint, attributes: [
            .font: style.sans(style.em(0.9)), .foregroundColor: style.ink(.secondary), .paragraphStyle: paragraph,
        ])
        let width = bounds.width - 2 * style.px(20)
        let titleHeight = ceil(title.boundingRect(with: NSSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).height)
        let hintHeight = ceil(hint.boundingRect(with: NSSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).height)
        let total = titleHeight + style.px(4) + hintHeight
        let top = bounds.height * 0.38 - total / 2
        title.draw(with: NSRect(x: style.px(20), y: top, width: width, height: titleHeight), options: [.usesLineFragmentOrigin])
        hint.draw(with: NSRect(x: style.px(20), y: top + titleHeight + style.px(4), width: width, height: hintHeight), options: [.usesLineFragmentOrigin])
    }
}

/// Something the view itself refuses (a picker that cannot open now), said like any other failure.
struct ConversationViewRefusal: Error, CustomStringConvertible {
    let description: String
}
