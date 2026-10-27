// Port of apps/desktop/src/shell/conversation/Composer.tsx, SettingPickers.tsx,
// BackgroundTasks.tsx and ContextUsage.tsx: where the person talks to a GUI
// Agent.
//
// Return is a new line and ⌘Return sends (`ComposerTextView`). Esc and Ctrl+C
// stop a running turn; the pane handles them, and the composer keeps Esc for
// itself only while its command list is open. A line that starts with `/`
// offers the Agent's own commands: while the list is open Return or Tab takes
// the highlighted one; one the Agent takes as a message is completed into the
// text, one DevHub answers itself opens what it names. On an empty field ↑
// and ↓ walk what the person already said to this Agent, read off its
// transcript. What was typed is not cleared until the Agent has it.
//
// A message sent while the Agent is busy is held and listed over the box,
// oldest first, each with Send now, Edit and Remove; ⌘Return on an empty
// field sends the oldest one not open to be changed. What is typed and not
// sent is the Agent's draft, reported a moment after typing pauses and at once
// when the field loses the keyboard. Images are attached by pasting or
// dropping them; each is a thumbnail with its own Remove.

import AppKit
import DevHubCore

/// What the composer asks of its surface.
@MainActor
protocol ComposerHost: AnyObject {
    func composerSend(_ text: String, images: [ImageRef]) async -> Bool
    func composerCommand(_ wire: ConversationCommandWire) async -> Bool
    func composerOpenResume()
    func composerOpenMcp()
    func composerRestart()
    func composerCliDefaults(model: String?) async -> CliDefaults?
    func composerSetCliDefault(_ which: ClaudeDefaultName, value: String, model: String?) async -> Bool
    func composerSaveDraft(_ text: String)
    func composerOpenTask(_ call: EntryId)
    func composerReport(_ message: String)
    /// Its height or its command list changed.
    func composerResized()
}

@MainActor
final class ComposerView: NSView {
    private var style: ConversationStyle
    weak var host: ComposerHost?
    private(set) var transcript: Transcript = EMPTY_TRANSCRIPT

    // The box.
    private let box = ComposerBox()
    let field = ComposerTextView.make()
    private let fieldScroll = NSScrollView()
    private let attachmentsRow = FlowRow()
    private var attachments: [ImageRef] = []
    private let pickers = SettingPickersView()
    private var stop: ConversationButton!
    private var send: ConversationButton!
    private let pending = PendingListView()
    private let footer = ComposerFooterView()
    /// The `/` command list, laid over the transcript above the box by the pane.
    let completions = CompletionListView()

    // What the field is doing.
    private var recalled: Int?
    private var selected = 0
    private var dismissed: String?
    private var edits: [PendingId: String] = [:]
    private var told: String?
    private var draftTimer: Timer?
    private var flushNext = false

    init(style: ConversationStyle) {
        self.style = style
        super.init(frame: .zero)
        addSubview(pending)
        addSubview(box)
        addSubview(footer)
        box.addSubview(attachmentsRow)
        fieldScroll.documentView = field
        fieldScroll.hasVerticalScroller = true
        fieldScroll.autohidesScrollers = true
        fieldScroll.drawsBackground = false
        fieldScroll.borderType = .noBorder
        box.addSubview(fieldScroll)
        box.addSubview(pickers)
        stop = ConversationButton(label: "", icon: .stop, look: .round(danger: true), size: style.fontSize * 0.9, style: style) { [weak self] in
            self?.run(.interrupt)
        }
        stop.setAccessibilityLabel("Stop")
        stop.toolTip = "Stop the turn (Esc or Ctrl+C)"
        send = ConversationButton(label: "", icon: .send, look: .round(danger: false), size: style.fontSize * 0.9, style: style) { [weak self] in
            self?.submit()
        }
        send.setAccessibilityLabel("Send")
        send.toolTip = "Send (\(ComposerWords.sendKey))"
        box.addSubview(stop)
        box.addSubview(send)
        box.onClick = { [weak self] in
            guard let self else { return }
            self.window?.makeFirstResponder(self.field)
        }
        field.setAccessibilityLabel("Message to the Agent")
        field.onSubmit = { [weak self] in self?.submit() }
        field.onChange = { [weak self] in self?.edited() }
        field.onCommand = { [weak self] selector in self?.command(selector) ?? false }
        field.onImages = { [weak self] options, board in self?.attach(from: board, options: options) ?? false }
        field.onBlur = { [weak self] in
            self?.flushDraft()
            self?.box.focused = false
        }
        field.onFocus = { [weak self] in self?.box.focused = true }
        completions.onChoose = { [weak self] command in self?.choose(command) }
        pending.host = self
        pickers.composer = self
        footer.composer = self
        applyStyle(style)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func applyStyle(_ style: ConversationStyle) {
        self.style = style
        box.style = style
        field.apply(style)
        stop.style = style
        stop.size = style.fontSize * 0.9
        send.style = style
        send.size = style.fontSize * 0.9
        pending.style = style
        pickers.style = style
        footer.style = style
        completions.style = style
        refreshTints()
        renderAttachments()
        needsLayout = true
    }

    // MARK: The transcript

    func update(_ transcript: Transcript) {
        let before = self.transcript
        self.transcript = transcript
        let refusal = ComposerWords.inputRefusal(transcript.state)
        field.isEditable = refusal == nil
        field.placeholder = ComposerWords.placeholder(transcript.state)
        box.disabled = refusal != nil
        let running = transcript.state.turn == .running
        stop.isHidden = !running
        updateSend()
        if before.pending != transcript.pending || before.state != transcript.state { pending.update(transcript.pending, canSendNow: ComposerWords.canSendNow(transcript.state), style: style) }
        if before.session != transcript.session || before.state != transcript.state {
            pickers.update(transcript.session, disabled: !ComposerWords.canSendNow(transcript.state))
            refreshTints()
        }
        if before.backgroundTasks != transcript.backgroundTasks || before.usage != transcript.usage {
            footer.update(tasks: transcript.backgroundTasks, usage: transcript.usage)
        }
        refreshCompletions()
        reportDraftSoon()
        needsLayout = true
        host?.composerResized()
    }

    private func updateSend() {
        let refusal = ComposerWords.inputRefusal(transcript.state)
        send.isEnabled = refusal == nil && !(field.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty)
    }

    // MARK: Typing

    private var text: String { field.string }

    private func edited() {
        recalled = nil
        selected = 0
        updateSend()
        refreshTints()
        refreshCompletions()
        reportDraftSoon()
        relayout()
    }

    private func relayout() {
        needsLayout = true
        host?.composerResized()
    }

    private func refreshTints() {
        let words = SkillTokens.words(transcript.session.commands)
        var at = 0
        var tints: [(NSRange, NSColor, NSColor)] = []
        for segment in SkillTokens.tokenize(text, words) {
            let length = (segment.text as NSString).length
            if segment.skill {
                tints.append((NSRange(location: at, length: length), style.faded(style.tokens.accent, 0.16), style.tokens.accentInk.nsColor))
            }
            at += length
        }
        field.tints = tints
    }

    /// The commands offered now, or none.
    private var offered: [SlashCommand] {
        guard !field.hasMarkedText(), dismissed != text,
              let query = CommandCompletion.query(text, caret: field.caret)
        else { return [] }
        return CommandCompletion.completions(transcript.session.commands, query)
    }

    private func refreshCompletions() {
        let list = offered
        if list.isEmpty {
            if !completions.isHidden {
                completions.isHidden = true
                host?.composerResized()
            }
            return
        }
        selected = min(selected, list.count - 1)
        completions.show(list, selected: selected)
        if completions.isHidden {
            completions.isHidden = false
        }
        host?.composerResized()
    }

    private func command(_ selector: Selector) -> Bool {
        let list = offered
        if !list.isEmpty {
            switch selector {
            case #selector(moveDown(_:)), #selector(moveUp(_:)):
                let step = selector == #selector(moveDown(_:)) ? 1 : -1
                selected = (min(selected, list.count - 1) + step + list.count) % list.count
                completions.show(list, selected: selected)
                return true
            case #selector(insertTab(_:)), #selector(insertNewline(_:)):
                choose(list[min(selected, list.count - 1)])
                return true
            case #selector(cancelOperation(_:)):
                // The list closes; the turn is not interrupted by the same key.
                dismissed = text
                refreshCompletions()
                return true
            default:
                break
            }
        }
        switch selector {
        case #selector(moveUp(_:)): return recall(1)
        case #selector(moveDown(_:)): return recall(-1)
        default: return false
        }
    }

    /// ↑ and ↓ on an empty field (or one showing the history): what was said before.
    private func recall(_ step: Int) -> Bool {
        let history = CommandCompletion.inputHistory(transcript)
        let browsing = text.isEmpty || (recalled.map { $0 < history.count && text == history[$0] } ?? false)
        guard browsing else { return false }
        let next = (recalled ?? -1) + step
        if next < 0 {
            let was = recalled != nil
            field.setText("")
            recalled = nil
            edited()
            return was
        }
        guard next < history.count else { return false }
        field.setText(history[next])
        recalled = next
        updateSend()
        refreshTints()
        reportDraftSoon()
        relayout()
        return true
    }

    private func choose(_ command: SlashCommand) {
        if command.route == .message {
            guard let query = CommandCompletion.query(text, caret: field.caret) else { return }
            let next = CommandCompletion.completed(text, query, command)
            field.setText(next.text, caret: next.caret)
            edited()
            window?.makeFirstResponder(field)
            return
        }
        field.setText("")
        edited()
        switch command.route {
        case .resume: host?.composerOpenResume()
        case .mcp: host?.composerOpenMcp()
        case .restart: host?.composerRestart()
        case .model: pickers.open(.model)
        case .effort: pickers.open(.effort)
        case .mode: pickers.open(.mode)
        case .message: break
        }
    }

    // MARK: Sending

    func submit() {
        let line = text
        let images = attachments
        switch ComposerWords.submission(text: line, images: images.count, transcript: transcript, editing: Set(edits.keys)) {
        case .command(let command): choose(command)
        case .sendPendingNow(let id): run(.sendPendingNow(id))
        case .nothing: break
        case .send:
            Task { [weak self] in
                guard let self, await self.host?.composerSend(line, images: images) == true else { return }
                // Only what was sent is cleared: anything typed or attached since stays.
                self.flushNext = true
                if self.text == line { self.field.setText("") }
                self.attachments.removeAll { sent in images.contains(sent) }
                self.renderAttachments()
                self.recalled = nil
                self.edited()
            }
        }
    }

    func run(_ wire: ConversationCommandWire) {
        Task { [weak self] in _ = await self?.host?.composerCommand(wire) }
    }

    // MARK: Words coming back

    /// A rewound message's words, or the draft kept for the Agent: ahead of what is typed, the caret at their end.
    func bringBack(_ words: String, images: [ImageRef]) {
        let current = text
        let next = current.isEmpty ? words : "\(words)\n\n\(current)"
        field.setText(next, caret: (words as NSString).length)
        attachments = images + attachments
        renderAttachments()
        recalled = nil
        edited()
        window?.makeFirstResponder(field)
    }

    /// The draft the Agent's attachment carried: brought back once, and what the Agent already has.
    func adoptDraft(_ draft: String) {
        if told == nil { told = draft }
        if !draft.isEmpty { bringBack(draft, images: []) }
    }

    // MARK: Drafts

    private var draftWords: String {
        ComposerWords.draftWords(transcript.pending, edits, text)
    }

    private func reportDraftSoon() {
        guard let told else { return }
        if flushNext {
            flushNext = false
            flushDraft()
            return
        }
        draftTimer?.invalidate()
        guard draftWords != told else { return }
        draftTimer = Timer.scheduledTimer(withTimeInterval: ComposerWords.draftPauseMs / 1000, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.flushDraft() }
        }
    }

    func flushDraft() {
        draftTimer?.invalidate()
        draftTimer = nil
        guard let told else { return }
        let words = draftWords
        if words == told { return }
        self.told = words
        host?.composerSaveDraft(words)
    }

    fileprivate func reportEdit(_ id: PendingId, _ words: String?) {
        if edits[id] == words { return }
        edits[id] = words
        reportDraftSoon()
    }

    // MARK: Images

    private func attach(from board: NSPasteboard, options: [NSPasteboard.ReadingOptionKey: Any]) -> Bool {
        guard let read = PastedImages.read(board, options: options) else { return false }
        guard ComposerWords.inputRefusal(transcript.state) == nil else { return true }
        switch read {
        case .success(let images):
            attachments += images
            renderAttachments()
            updateSend()
            relayout()
        case .failure(let refusal):
            host?.composerReport(refusal.message)
        }
        return true
    }

    private func renderAttachments() {
        attachmentsRow.spacing = style.px(8)
        attachmentsRow.items = attachments.enumerated().map { index, image in
            AttachmentThumb(image: image, style: style) { [weak self] in
                guard let self, index < self.attachments.count else { return }
                self.attachments.remove(at: index)
                self.renderAttachments()
                self.updateSend()
                self.relayout()
            }
        }
    }

    func dropImages(_ board: NSPasteboard) -> Bool { attach(from: board, options: [.urlReadingFileURLsOnly: true]) }

    // MARK: Settings

    func openSetting(_ name: SettingName) -> Bool { pickers.open(name) }

    func setSetting(_ name: SettingName, _ id: String) { run(.setSetting(name, id: id)) }

    func cliDefaults(_ model: String?) async -> CliDefaults? { await host?.composerCliDefaults(model: model) }

    func setCliDefault(_ which: ClaudeDefaultName, _ value: String, model: String?) async -> Bool {
        await host?.composerSetCliDefault(which, value: value, model: model) ?? false
    }

    func openTask(_ call: EntryId) { host?.composerOpenTask(call) }

    // MARK: Layout

    private var gutter: CGFloat { CGFloat(SurfaceMetrics.gutterPx) }

    private func fieldHeight(_ width: CGFloat, paneHeight: CGFloat) -> CGFloat {
        field.frame.size.width = width
        return min(max(field.contentHeight, ceil(style.fontSize * 1.55) + 4), max(60, paneHeight * 0.4))
    }

    private var boxPad: (top: CGFloat, right: CGFloat, bottom: CGFloat, left: CGFloat) { (style.px(8), style.px(8), style.px(4), style.px(12)) }

    /// The composer's height at a width (the column's), the pane being `paneHeight` tall.
    func height(forWidth width: CGFloat, paneHeight: CGFloat) -> CGFloat {
        arrange(width, paneHeight: paneHeight, apply: false)
    }

    var paneHeight: CGFloat = 600

    @discardableResult
    private func arrange(_ width: CGFloat, paneHeight: CGFloat, apply: Bool) -> CGFloat {
        let inner = width - 2 * gutter
        var y: CGFloat = 0
        let pendingHeight = pending.height(forWidth: inner)
        if apply { pending.frame = NSRect(x: gutter, y: y, width: inner, height: pendingHeight) }
        y += pendingHeight
        let pad = boxPad
        var boxY = pad.top
        let boxInner = inner - pad.left - pad.right
        let attachmentsHeight = attachments.isEmpty ? 0 : attachmentsRow.height(forWidth: boxInner) + style.px(8)
        if apply { attachmentsRow.frame = NSRect(x: pad.left, y: boxY, width: boxInner, height: max(0, attachmentsHeight - style.px(8))) }
        boxY += attachmentsHeight
        let fieldH = fieldHeight(boxInner, paneHeight: paneHeight)
        if apply { fieldScroll.frame = NSRect(x: pad.left, y: boxY, width: boxInner, height: fieldH) }
        boxY += fieldH + style.px(4)
        let button = style.fontSize * 2
        let actionsWidth = button * 2 + style.px(4)
        let pickersHeight = pickers.height(forWidth: boxInner - actionsWidth - style.px(8))
        let toolbar = max(button, pickersHeight)
        if apply {
            pickers.frame = NSRect(x: pad.left - style.px(8), y: boxY + (toolbar - pickersHeight) / 2, width: boxInner - actionsWidth, height: pickersHeight)
            send.frame = NSRect(x: pad.left + boxInner - button, y: boxY + (toolbar - button) / 2, width: button, height: button)
            stop.frame = NSRect(x: send.frame.minX - style.px(4) - button, y: send.frame.minY, width: button, height: button)
        }
        boxY += toolbar + pad.bottom
        if apply { box.frame = NSRect(x: gutter, y: y, width: inner, height: boxY) }
        y += boxY
        let footerHeight = footer.height(forWidth: inner - 2 * style.px(12))
        if apply { footer.frame = NSRect(x: gutter + style.px(12), y: y + style.px(4), width: inner - 2 * style.px(12), height: footerHeight) }
        y += (footerHeight > 0 ? footerHeight + style.px(4) : 0) + style.px(16)
        return y
    }

    override func layout() {
        super.layout()
        arrange(bounds.width, paneHeight: paneHeight, apply: true)
        field.frame.size.width = fieldScroll.contentSize.width
        field.frame.size.height = max(field.contentHeight, fieldScroll.contentSize.height)
    }

    /// Where the command list goes: over the box, in the composer's coordinates.
    var completionsAnchor: NSRect { box.frame }

    override func registerForDraggedTypes(_ newTypes: [NSPasteboard.PasteboardType]) { super.registerForDraggedTypes(newTypes) }
}

// MARK: - The box

@MainActor
final class ComposerBox: NSView {
    var style: ConversationStyle! { didSet { needsDisplay = true } }
    var focused = false { didSet { needsDisplay = true } }
    var disabled = false { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard let style else { return }
        let radius = style.em(1.1)
        let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
        if !disabled {
            NSGraphicsContext.saveGraphicsState()
            let shadow = NSShadow()
            let raised = style.tokens.shadowRaised
            shadow.shadowColor = raised.color.nsColor
            shadow.shadowBlurRadius = CGFloat(raised.blur)
            shadow.shadowOffset = NSSize(width: 0, height: -CGFloat(raised.offsetY))
            shadow.set()
            style.raised.setFill()
            path.fill()
            NSGraphicsContext.restoreGraphicsState()
        } else {
            style.wash.setFill()
            path.fill()
        }
        (focused ? style.mix(style.tokens.focusRing, 0.7, style.tokens.line) : style.line).setStroke()
        path.lineWidth = 1
        path.stroke()
    }

    override func mouseDown(with event: NSEvent) { onClick?() }
}

/// An attached image, small, with its Remove in its corner.
@MainActor
final class AttachmentThumb: NSView {
    private let tile: ImageTile
    private let remove: ConversationButton

    init(image: ImageRef, style: ConversationStyle, onRemove: @escaping () -> Void) {
        tile = ImageTile(image: image, style: style, thumbnail: 0.5) {}
        remove = ConversationButton(label: "", icon: .close, look: .icon, size: style.em(0.7), style: style, onPress: onRemove)
        super.init(frame: .zero)
        remove.setAccessibilityLabel("Remove \(image.label)")
        remove.toolTip = "Remove"
        remove.wantsLayer = true
        remove.layer?.backgroundColor = style.raised.cgColor
        remove.layer?.cornerRadius = style.em(0.7)
        remove.layer?.borderWidth = 1
        remove.layer?.borderColor = style.line.cgColor
        addSubview(tile)
        addSubview(remove)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    override var intrinsicContentSize: NSSize {
        let size = tile.size(forWidth: 400)
        return NSSize(width: size.width + 8, height: size.height + 8)
    }

    override func layout() {
        super.layout()
        let size = tile.size(forWidth: 400)
        tile.frame = NSRect(x: 0, y: 8, width: size.width, height: size.height)
        let side = remove.size * 2
        remove.frame = NSRect(x: size.width + 8 - side, y: 0, width: side, height: side)
        remove.layer?.cornerRadius = side / 2
    }
}

// MARK: - The command list

@MainActor
final class CompletionListView: NSView {
    var style: ConversationStyle! { didSet { needsDisplay = true } }
    var onChoose: ((SlashCommand) -> Void)?
    private var commands: [SlashCommand] = []
    private var selected = 0
    private var scrollTop: CGFloat = 0

    override var isFlipped: Bool { true }

    private var rowHeight: CGFloat { ceil(style.fontSize * 1.6) + 4 }
    private var pad: CGFloat { style.px(4) }

    func show(_ commands: [SlashCommand], selected: Int) {
        self.commands = commands
        self.selected = selected
        setAccessibilityElement(true)
        setAccessibilityRole(.list)
        setAccessibilityLabel(commands.first?.trigger == .dollar ? "Skills" : "Commands")
        needsDisplay = true
    }

    private var detail: NSAttributedString? {
        guard selected < commands.count, !commands[selected].description.isEmpty else { return nil }
        return NSAttributedString(string: commands[selected].description, attributes: [
            .font: style.sans(style.em(0.85)), .foregroundColor: style.ink(.secondary),
        ])
    }

    /// Its height for a width, at most `most`.
    func height(forWidth width: CGFloat, most: CGFloat) -> CGFloat {
        let detailHeight = detail.map { ceil($0.boundingRect(with: NSSize(width: width - 2 * style.px(12), height: 6 * style.fontSize * 1.6), options: [.usesLineFragmentOrigin]).height) + 2 * style.px(8) + 1 } ?? 0
        return min(most, CGFloat(commands.count) * rowHeight + 2 * pad + detailHeight)
    }

    private var listHeight: CGFloat {
        let detailHeight = detail.map { ceil($0.boundingRect(with: NSSize(width: bounds.width - 2 * style.px(12), height: 6 * style.fontSize * 1.6), options: [.usesLineFragmentOrigin]).height) + 2 * style.px(8) + 1 } ?? 0
        return bounds.height - detailHeight
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let style else { return }
        let radius = CGFloat(DevHubTheme.Radius.panel)
        let outline = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
        style.raised.setFill()
        outline.fill()
        style.line.setStroke()
        outline.stroke()
        let list = listHeight
        // Keep the highlighted row in view.
        let top = CGFloat(selected) * rowHeight
        if top < scrollTop { scrollTop = top }
        if top + rowHeight > scrollTop + list - 2 * pad { scrollTop = top + rowHeight - (list - 2 * pad) }
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: NSRect(x: 0, y: pad, width: bounds.width, height: list - 2 * pad)).addClip()
        for (index, command) in commands.enumerated() {
            let y = pad + CGFloat(index) * rowHeight - scrollTop
            guard y + rowHeight > 0, y < list else { continue }
            let row = NSRect(x: pad, y: y, width: bounds.width - 2 * pad, height: rowHeight)
            let chosen = index == selected
            if chosen {
                style.tokens.accent.nsColor.setFill()
                NSBezierPath(roundedRect: row, xRadius: CGFloat(DevHubTheme.Radius.row), yRadius: CGFloat(DevHubTheme.Radius.row)).fill()
            }
            let ink = chosen ? NSColor.white : style.ink(.primary)
            let quiet = chosen ? NSColor.white.withAlphaComponent(0.8) : style.ink(.secondary)
            var x = row.minX + style.px(8)
            let name = NSAttributedString(string: "\(command.trigger.rawValue)\(command.name)", attributes: [.font: style.mono(style.fontSize * 0.95, bold: true), .foregroundColor: ink])
            let nameSize = name.size()
            name.draw(at: NSPoint(x: x, y: row.midY - nameSize.height / 2))
            x += nameSize.width + style.px(8)
            let available = row.maxX - style.px(8) - x
            if let hint = command.argumentHint, !hint.isEmpty {
                let hintText = NSAttributedString(string: hint, attributes: [.font: style.mono(style.em(0.85)), .foregroundColor: quiet])
                let width = min(hintText.size().width, available * 0.4)
                hintText.draw(with: NSRect(x: x, y: row.midY - hintText.size().height / 2, width: width, height: hintText.size().height), options: [.truncatesLastVisibleLine, .usesLineFragmentOrigin])
                x += width + style.px(8)
            }
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byTruncatingTail
            let description = NSAttributedString(string: command.description, attributes: [.font: style.sans(style.em(0.85)), .foregroundColor: quiet, .paragraphStyle: paragraph])
            let height = description.size().height
            description.draw(with: NSRect(x: x, y: row.midY - height / 2, width: max(0, row.maxX - style.px(8) - x), height: height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        }
        NSGraphicsContext.restoreGraphicsState()
        if let detail {
            style.lineSoft.setFill()
            NSRect(x: 0, y: list, width: bounds.width, height: 1).fill()
            detail.draw(with: NSRect(x: style.px(12), y: list + style.px(8), width: bounds.width - 2 * style.px(12), height: bounds.height - list - 2 * style.px(8)), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let index = Int((point.y - pad + scrollTop) / rowHeight)
        if point.y < listHeight, index >= 0, index < commands.count { onChoose?(commands[index]) }
    }

    override func scrollWheel(with event: NSEvent) {
        let most = max(0, CGFloat(commands.count) * rowHeight - (listHeight - 2 * pad))
        scrollTop = min(most, max(0, scrollTop - event.scrollingDeltaY))
        needsDisplay = true
    }
}

// MARK: - Waiting messages

@MainActor
final class PendingListView: NSView {
    var style: ConversationStyle!
    weak var host: ComposerView?
    private var items: [PendingItemView] = []

    override var isFlipped: Bool { true }

    func update(_ messages: [PendingMessage], canSendNow: Bool, style: ConversationStyle) {
        self.style = style
        var kept: [PendingId: PendingItemView] = [:]
        for item in items { kept[item.message.id] = item }
        var next: [PendingItemView] = []
        for (index, message) in messages.enumerated() {
            let item = kept.removeValue(forKey: message.id) ?? PendingItemView(message: message, style: style, list: self)
            item.update(message, position: index + 1, total: messages.count, canSendNow: canSendNow, style: style)
            if item.superview !== self { addSubview(item) }
            next.append(item)
        }
        for gone in kept.values {
            gone.letGo()
            gone.removeFromSuperview()
        }
        items = next
        needsLayout = true
    }

    func height(forWidth width: CGFloat) -> CGFloat {
        guard !items.isEmpty else { return 0 }
        return items.reduce(0) { $0 + $1.height(forWidth: width) } + CGFloat(items.count) * style.px(8)
    }

    override func layout() {
        super.layout()
        var y: CGFloat = 0
        for item in items {
            let height = item.height(forWidth: bounds.width)
            item.frame = NSRect(x: 0, y: y, width: bounds.width, height: height)
            y += height + style.px(8)
        }
    }

    func resized() {
        needsLayout = true
        host?.relayoutFromChild()
    }

    func reportEdit(_ id: PendingId, _ words: String?) { host?.reportEditFromChild(id, words) }
    func run(_ wire: ConversationCommandWire) async -> Bool { await host?.host?.composerCommand(wire) ?? false }
}

extension ComposerView {
    fileprivate func relayoutFromChild() {
        needsLayout = true
        host?.composerResized()
    }

    fileprivate func reportEditFromChild(_ id: PendingId, _ words: String?) { reportEdit(id, words) }
}

/// One message DevHub holds: its label, its bubble (or its words open to change), and what can be done to it.
@MainActor
final class PendingItemView: NSView {
    private(set) var message: PendingMessage
    private var style: ConversationStyle
    private weak var list: PendingListView?
    private let label = NSTextField(labelWithString: "")
    private let bubble = NSTextField(wrappingLabelWithString: "")
    private let status = NSTextField(wrappingLabelWithString: "")
    private let editor = ComposerTextView.make()
    private let editorScroll = NSScrollView()
    private let buttons = FlowRow()
    private var draft: String?
    private var canSendNow = false
    private var position = 1
    private var total = 1

    init(message: PendingMessage, style: ConversationStyle, list: PendingListView) {
        self.message = message
        self.style = style
        self.list = list
        super.init(frame: .zero)
        bubble.isSelectable = true
        for view in [label, bubble, status] { addSubview(view) }
        editorScroll.documentView = editor
        editorScroll.hasVerticalScroller = true
        editorScroll.autohidesScrollers = true
        editorScroll.drawsBackground = false
        editorScroll.wantsLayer = true
        editorScroll.layer?.borderWidth = 1
        editorScroll.layer?.cornerRadius = CGFloat(DevHubTheme.Radius.control)
        editorScroll.isHidden = true
        addSubview(editorScroll)
        addSubview(buttons)
        buttons.align = .trailing
        buttons.spacing = style.px(8)
        editor.setAccessibilityLabel("Waiting message")
        editor.onSubmit = { [weak self] in self?.save() }
        editor.onCommand = { [weak self] selector in
            guard selector == #selector(NSResponder.cancelOperation(_:)) else { return false }
            // Gives the edit up; the turn is not interrupted by the same key.
            self?.cancel()
            return true
        }
        editor.onChange = { [weak self] in
            guard let self, self.draft != nil else { return }
            self.draft = self.editor.string
            self.list?.reportEdit(self.message.id, self.draft)
            self.list?.resized()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func update(_ message: PendingMessage, position: Int, total: Int, canSendNow: Bool, style: ConversationStyle) {
        self.message = message
        self.style = style
        self.position = position
        self.total = total
        self.canSendNow = canSendNow
        label.font = style.sans(style.em(0.8))
        label.textColor = style.ink(.tertiary)
        label.stringValue = ComposerWords.pendingLabel(message, position: position, total: total)
        bubble.font = style.body
        bubble.textColor = style.ink(.primary)
        bubble.stringValue = message.text
        bubble.alphaValue = 0.75
        status.font = style.sans(style.em(0.85))
        status.textColor = message.failure != nil ? style.ink(.statusError) : style.ink(.secondary)
        status.alignment = .right
        status.stringValue = ComposerWords.pendingStatus(message)
        editor.apply(style)
        editorScroll.layer?.borderColor = style.line.cgColor
        editorScroll.layer?.backgroundColor = style.raised.cgColor
        renderButtons()
        needsLayout = true
        needsDisplay = true
    }

    private func renderButtons() {
        let size = style.em(0.85)
        func button(_ label: String, icon: DocIcon? = nil, action: @escaping () -> Void) -> ConversationButton {
            ConversationButton(label: label, icon: icon, look: .bordered, size: size, style: style, onPress: action)
        }
        if draft == nil {
            let now = button("Send now", icon: .send) { [weak self] in self?.run(.sendPendingNow(self!.message.id)) }
            now.toolTip = "Send it now: a running turn takes it in as it goes"
            now.isEnabled = canSendNow
            buttons.items = [
                now,
                button("Edit", icon: .edit) { [weak self] in self?.open() },
                button("Remove") { [weak self] in self?.run(.removePending(self!.message.id)) },
            ]
        } else {
            let save = button("Save") { [weak self] in self?.save() }
            save.toolTip = "Save (\(ComposerWords.sendKey))"
            buttons.items = [save, button("Cancel") { [weak self] in self?.cancel() }]
        }
    }

    private func run(_ wire: ConversationCommandWire) {
        Task { [weak self] in _ = await self?.list?.run(wire) }
    }

    private func open() {
        Task { [weak self] in
            guard let self, await self.list?.run(.startEditingPending(self.message.id)) == true else { return }
            self.draft = self.message.text
            self.editor.setText(self.message.text)
            self.editorScroll.isHidden = false
            self.bubble.isHidden = true
            self.renderButtons()
            self.list?.reportEdit(self.message.id, self.draft)
            self.list?.resized()
            self.window?.makeFirstResponder(self.editor)
        }
    }

    private func close() {
        draft = nil
        editorScroll.isHidden = true
        bubble.isHidden = false
        renderButtons()
        list?.reportEdit(message.id, nil)
        list?.resized()
    }

    private func cancel() {
        close()
        run(.stopEditingPending(message.id))
    }

    private func save() {
        guard let draft else { return }
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && message.images.isEmpty {
            run(.removePending(message.id))
            return
        }
        Task { [weak self] in
            guard let self, await self.list?.run(.editPending(self.message.id, text: draft)) == true else { return }
            self.close()
        }
    }

    /// The composer going away, or the message gone, with it open: it is let go.
    func letGo() {
        if draft != nil { run(.stopEditingPending(message.id)) }
    }

    private var bubbleMax: CGFloat { 0 }

    func height(forWidth width: CGFloat) -> CGFloat { arrange(width, apply: false) }

    @discardableResult
    private func arrange(_ width: CGFloat, apply: Bool) -> CGFloat {
        var y: CGFloat = 0
        let labelHeight = ceil(style.em(0.8) * 1.4)
        if apply { label.frame = NSRect(x: 0, y: 0, width: width, height: labelHeight); label.alignment = .right }
        y += labelHeight + style.px(4)
        if draft == nil {
            let most = min(width * 0.85, style.em(60 * 0.55))
            let text = bubble.attributedStringValue
            let size = text.boundingRect(with: NSSize(width: most - 2 * style.px(12), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).size
            let w = ceil(size.width) + 2 * style.px(12) + 2, h = ceil(size.height) + 2 * style.px(8)
            if apply { bubble.frame = NSRect(x: width - w + style.px(12), y: y + style.px(8), width: w - 2 * style.px(12), height: ceil(size.height) + 2) }
            bubbleFrame = NSRect(x: width - w, y: y, width: w, height: h)
            y += h
        } else {
            let lines = max(3 * style.fontSize * 1.55, editor.contentHeight) + 2 * style.px(8)
            let h = min(lines, 300)
            if apply {
                editorScroll.frame = NSRect(x: 0, y: y, width: width, height: h)
                editor.textContainerInset = NSSize(width: style.px(8), height: style.px(8))
                editor.frame.size.width = editorScroll.contentSize.width
            }
            y += h
        }
        y += style.px(4)
        let buttonsWidth = buttons.items.reduce(0) { $0 + $1.intrinsicContentSize.width + style.px(8) }
        let statusWidth = max(80, width - buttonsWidth - style.px(8))
        let statusHeight = ceil(status.attributedStringValue.boundingRect(with: NSSize(width: statusWidth, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).height)
        let rowHeight = max(statusHeight, buttons.items.first?.intrinsicContentSize.height ?? 0)
        if apply {
            status.frame = NSRect(x: 0, y: y + 2, width: statusWidth, height: statusHeight)
            buttons.frame = NSRect(x: statusWidth + style.px(8), y: y, width: max(0, width - statusWidth - style.px(8)), height: rowHeight)
        }
        y += rowHeight
        return y
    }

    private var bubbleFrame: NSRect = .zero

    override func layout() {
        super.layout()
        arrange(bounds.width, apply: true)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard draft == nil else { return }
        let big = style.em(1.1), small = style.em(0.35)
        let path = TranscriptTextView.roundedPath(bubbleFrame.insetBy(dx: 0.5, dy: 0.5), tl: big, tr: big, br: small, bl: big)
        path.setLineDash([4, 3], count: 2, phase: 0)
        (message.failure != nil ? style.ink(.statusError) : style.line).setStroke()
        path.lineWidth = 1
        path.stroke()
    }
}

// MARK: - The settings

@MainActor
final class SettingPickersView: NSView {
    var style: ConversationStyle! { didSet { for face in faces.values { face.style = style } } }
    weak var composer: ComposerView?
    private var session = EMPTY_SESSION
    private var disabled = false
    private var faces: [SettingName: SettingFace] = [:]
    private let row = FlowRow()
    private var defaults: CliDefaults?
    private var askedFor: String??
    private var changes = 0

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        addSubview(row)
        row.spacing = 2
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    func update(_ session: SessionFacts, disabled: Bool) {
        self.session = session
        self.disabled = disabled
        readDefaults()
        render()
    }

    /// The model an effort is saved for: the session's, else the default's.
    private var model: String? {
        SettingPickerModel.modelName(session) ?? SettingPickerModel.defaultModelName(session.model, defaults?.model)
    }

    private func readDefaults() {
        let wanted = model
        if askedFor == .some(wanted) { return }
        askedFor = .some(wanted)
        Task { [weak self] in
            let read = await self?.composer?.cliDefaults(wanted)
            guard let self, self.askedFor == .some(wanted) else { return }
            self.defaults = read
            self.render()
        }
    }

    private func render() {
        var items: [NSView] = []
        for name in SettingPickerModel.names where SettingPickerModel.shown(name, session) {
            let face = faces[name] ?? SettingFace(name: name, style: style)
            face.picker = self
            faces[name] = face
            face.update(SettingPickerModel.setting(name, session), known: SettingPickerModel.known(name, defaults), disabled: disabled)
            items.append(face)
        }
        row.items = items
        needsLayout = true
    }

    func height(forWidth width: CGFloat) -> CGFloat { row.items.isEmpty ? 0 : row.height(forWidth: width) }

    override func layout() {
        super.layout()
        row.frame = bounds
    }

    @discardableResult
    func open(_ name: SettingName) -> Bool {
        guard let face = faces[name], face.superview != nil else {
            composer?.host?.composerReport("A command opens the \(SettingPickerModel.label(name)) picker, but the session offers no \(name.rawValue) choices")
            return false
        }
        if disabled {
            composer?.host?.composerReport(SettingPickerModel.refusedOpen(name))
            return false
        }
        face.openMenu()
        return true
    }

    fileprivate func choose(_ name: SettingName, _ id: String) {
        if SettingPickerModel.setting(name, session).current == id { return }
        composer?.setSetting(name, id)
    }

    fileprivate func makeDefault(_ name: SettingName, _ id: String) {
        guard let which = SettingPickerModel.defaultName(name) else { return }
        let model = name == .effort ? self.model : nil
        Task { [weak self] in
            guard let self, await self.composer?.setCliDefault(which, id, model: model) == true else { return }
            self.askedFor = nil
            self.readDefaults()
        }
    }
}

/// One setting: its label and value, a chevron when it can be changed; its menu of the session's choices.
@MainActor
final class SettingFace: NSView, NSMenuDelegate {
    let name: SettingName
    var style: ConversationStyle { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    weak var picker: SettingPickersView?
    private var setting = Setting.none
    private var known: CliDefault?
    private var disabled = false
    private var hovering = false { didSet { needsDisplay = true } }
    private var opened = false { didSet { needsDisplay = true } }
    private var tracking: NSTrackingArea?

    init(name: SettingName, style: ConversationStyle) {
        self.name = name
        self.style = style
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.popUpButton)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    private var choosable: Bool { !setting.choices.isEmpty }

    func update(_ setting: Setting, known: CliDefault?, disabled: Bool) {
        self.setting = setting
        self.known = known
        self.disabled = disabled
        let value = SettingPickerModel.value(name, setting, known)
        setAccessibilityLabel("\(SettingPickerModel.label(name)): \(value)")
        if setting.current == nil {
            toolTip = SettingPickerModel.unknownHint(name, known, setting)
        } else {
            toolTip = SettingPickerModel.rows(setting).first { $0.id == setting.current }?.detail
        }
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }

    private var parts: (label: NSAttributedString, value: NSAttributedString, note: NSAttributedString?) {
        let size = style.fontSize
        let label = NSAttributedString(string: SettingPickerModel.label(name), attributes: [.font: style.sans(size), .foregroundColor: style.ink(.tertiary)])
        let unknown = setting.current == nil
        let value = NSAttributedString(string: SettingPickerModel.value(name, setting, known), attributes: [
            .font: style.sans(size, italic: unknown), .foregroundColor: unknown ? style.ink(.tertiary) : style.ink(.secondary),
        ])
        let note = setting.unchangeable.map {
            NSAttributedString(string: $0, attributes: [.font: style.sans(size * 0.85), .foregroundColor: style.ink(.tertiary)])
        }
        return (label, value, note)
    }

    override var intrinsicContentSize: NSSize {
        let (label, value, note) = parts
        let gap = style.fontSize * 0.3
        var width = style.px(8) * 2 + ceil(label.size().width) + gap + min(ceil(value.size().width), style.em(14))
        if let note { width += gap + ceil(note.size().width) }
        if choosable { width += gap + style.fontSize * 0.75 }
        return NSSize(width: width, height: ceil(style.fontSize * 1.55) + 4)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    override func draw(_ dirtyRect: NSRect) {
        if choosable, !disabled, hovering || opened {
            style.wash.setFill()
            NSBezierPath(roundedRect: bounds, xRadius: CGFloat(DevHubTheme.Radius.control), yRadius: CGFloat(DevHubTheme.Radius.control)).fill()
        }
        let alpha: CGFloat = choosable && disabled ? 0.6 : 1
        let (label, value, note) = parts
        let gap = style.fontSize * 0.3
        var x = style.px(8)
        let mid = bounds.midY
        func put(_ text: NSAttributedString, width: CGFloat? = nil) {
            let size = text.size()
            let w = width ?? size.width
            let faded = NSMutableAttributedString(attributedString: text)
            if alpha < 1 {
                faded.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: faded.length)) { colour, range, _ in
                    if let colour = colour as? NSColor { faded.addAttribute(.foregroundColor, value: colour.withAlphaComponent(alpha), range: range) }
                }
            }
            faded.draw(with: NSRect(x: x, y: mid - size.height / 2, width: w, height: size.height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
            x += w + gap
        }
        put(label)
        put(value, width: min(value.size().width, style.em(14)))
        if let note { put(note) }
        if choosable {
            let side = style.fontSize * 0.75
            GlyphPainter.draw(ConversationIcons.drawing(.chevronDown), in: CGRect(x: x, y: mid - side / 2, width: side, height: side), color: style.ink(.tertiary).withAlphaComponent(alpha), stroke: ConversationIcons.stroke)
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard choosable, !disabled else { return }
        openMenu()
    }

    override var acceptsFirstResponder: Bool { choosable && !disabled }

    override func keyDown(with event: NSEvent) {
        if [" ", "\r"].contains(event.charactersIgnoringModifiers ?? "") || event.keyCode == 125 || event.keyCode == 126 {
            openMenu()
        } else {
            super.keyDown(with: event)
        }
    }

    func openMenu() {
        guard choosable else { return }
        let menu = NSMenu(title: SettingPickerModel.label(name))
        menu.autoenablesItems = false
        menu.delegate = self
        let rows = SettingPickerModel.rows(setting)
        let byDefault = known.flatMap { SettingPickerModel.defaultRow(rows, $0) }
        let font = style.sans(style.fontSize)
        var current: NSMenuItem?
        for row in rows {
            let item = NSMenuItem(title: row.label, action: #selector(chose(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = row.id
            item.state = row.id == setting.current ? .on : .off
            item.toolTip = row.detail
            if let known, row == byDefault {
                let title = NSMutableAttributedString(string: row.label, attributes: [.font: font])
                title.append(NSAttributedString(string: "    Default", attributes: [.font: style.sans(style.em(0.85)), .foregroundColor: NSColor.secondaryLabelColor]))
                item.attributedTitle = title
                item.toolTip = SettingPickerModel.defaultTip(known)
            }
            menu.addItem(item)
            if item.state == .on { current = item }
            if let known, SettingPickerModel.hasDefault(name), row != byDefault {
                // Option shows each row's Make default (⌥↩).
                let alternate = NSMenuItem(title: "Make \(row.label) the Default", action: #selector(madeDefault(_:)), keyEquivalent: "")
                alternate.target = self
                alternate.representedObject = row.id
                alternate.isAlternate = true
                alternate.keyEquivalentModifierMask = [.option]
                let refusal = SettingPickerModel.notSavable(name, row)
                alternate.isEnabled = refusal == nil
                alternate.toolTip = SettingPickerModel.makeDefaultTip(name, row, known)
                menu.addItem(alternate)
            }
        }
        opened = true
        let anchor = NSPoint(x: 0, y: 0)
        menu.popUp(positioning: current, at: anchor, in: self)
        opened = false
    }

    func menuDidClose(_ menu: NSMenu) { opened = false }

    @objc private func chose(_ item: NSMenuItem) {
        guard let id = item.representedObject as? String else { return }
        picker?.choose(name, id)
    }

    @objc private func madeDefault(_ item: NSMenuItem) {
        guard let id = item.representedObject as? String else { return }
        picker?.makeDefault(name, id)
    }
}

// MARK: - Under the box

/// What the Agent has working in the background, and how full the context is.
@MainActor
final class ComposerFooterView: NSView {
    var style: ConversationStyle! { didSet { needsLayout = true; needsDisplay = true } }
    weak var composer: ComposerView?
    private var tasks: [RunningTask] = []
    private var usage: Usage?
    private var open = false
    private var confirming: String?
    private var timer: Timer?
    private var rows: [NSView] = []
    private let toggle = BackgroundToggle()

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        addSubview(toggle)
        toggle.onPress = { [weak self] in
            guard let self else { return }
            self.open.toggle()
            self.render()
            self.composer?.relayoutFromChild()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    func update(tasks: [RunningTask], usage: Usage?) {
        self.tasks = tasks
        self.usage = usage
        if tasks.isEmpty { open = false }
        if let confirming, !tasks.contains(where: { $0.id == confirming }) { self.confirming = nil }
        render()
    }

    private var shown: Bool { open && !tasks.isEmpty }

    private func render() {
        toggle.style = style
        toggle.isHidden = tasks.isEmpty
        toggle.update(tasks: tasks, open: shown)
        for row in rows { row.removeFromSuperview() }
        rows = []
        if shown {
            for task in tasks {
                let line = BackgroundTaskLine(task: task, style: style)
                line.onOpen = { [weak self] in if let call = task.call { self?.composer?.openTask(call) } }
                line.onStop = { [weak self] in
                    self?.confirming = task.id
                    self?.render()
                    self?.composer?.relayoutFromChild()
                }
                addSubview(line)
                rows.append(line)
                if confirming == task.id, task.stoppable.isStoppable {
                    let confirm = ConfirmEmbedView(style: style, host: nil) {}
                    confirm.update(.confirm(
                        note: BackgroundWords.stopQuestion(task.kind),
                        go: DocActionButton(label: "Stop", icon: nil, action: .cancelLimitResume),
                        cancel: DocActionButton(label: "Cancel", icon: nil, action: .cancelLimitResume)), style: style)
                    confirm.onGo = { [weak self] in
                        self?.confirming = nil
                        self?.composer?.run(.stopTask(task.id))
                        self?.render()
                    }
                    confirm.onCancel = { [weak self] in
                        self?.confirming = nil
                        self?.render()
                        self?.composer?.relayoutFromChild()
                    }
                    addSubview(confirm)
                    rows.append(confirm)
                }
            }
        }
        timer?.invalidate()
        timer = nil
        if shown, tasks.contains(where: { $0.startedAt != nil }) {
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.rows.forEach { $0.needsDisplay = true } }
            }
        }
        needsLayout = true
        needsDisplay = true
    }

    private var rowHeight: CGFloat { ceil(style.em(0.75) * 1.6) + 4 }

    func height(forWidth width: CGFloat) -> CGFloat {
        let readout = ContextWords.words(usage) != nil
        guard !tasks.isEmpty || readout else { return 0 }
        var height = rowHeight
        if shown {
            height += style.px(4)
            for row in rows { height += (row as? ConfirmEmbedView)?.height(forWidth: width) ?? rowHeight }
            height = min(height, rowHeight + style.em(0.75 * 10) + style.px(4))
        }
        return height
    }

    override func layout() {
        super.layout()
        let readoutWidth = readoutSize.width
        toggle.frame = NSRect(x: 0, y: 0, width: max(0, bounds.width - readoutWidth - style.px(12)), height: rowHeight)
        var y = rowHeight + style.px(4)
        for row in rows {
            let height = (row as? ConfirmEmbedView)?.height(forWidth: bounds.width) ?? rowHeight
            row.frame = NSRect(x: 0, y: y, width: bounds.width, height: height)
            y += height
        }
    }

    private var readout: NSAttributedString? {
        guard let words = ContextWords.words(usage) else { return nil }
        let ink: NSColor
        switch ContextWords.level(usage) {
        case .near: ink = style.tokens.waiting.nsColor
        case .at: ink = style.ink(.danger)
        default: ink = style.ink(.tertiary)
        }
        return NSAttributedString(string: words, attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: style.em(0.75), weight: .regular), .foregroundColor: ink])
    }

    private var readoutSize: NSSize {
        guard let readout else { return .zero }
        let meter = usage.flatMap { ContextWords.percent($0) } != nil ? style.em(0.75 * 3) + style.em(0.75 * 0.5) : 0
        return NSSize(width: ceil(readout.size().width) + meter, height: readout.size().height)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let readout, let style else { return }
        let size = readout.size()
        let mid = rowHeight / 2
        let x = bounds.width - size.width
        readout.draw(at: NSPoint(x: x, y: mid - size.height / 2))
        if let usage, let percent = ContextWords.percent(usage) {
            let width = style.em(0.75 * 3)
            let meter = NSRect(x: x - style.em(0.75 * 0.5) - width, y: mid - 1.5, width: width, height: 3)
            style.washStrong.setFill()
            NSBezierPath(roundedRect: meter, xRadius: 1.5, yRadius: 1.5).fill()
            let level = ContextWords.level(usage)
            let fill: NSColor = level == .calm ? style.ink(.secondary) : (readout.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor ?? style.ink(.secondary))
            fill.setFill()
            NSBezierPath(roundedRect: NSRect(x: meter.minX, y: meter.minY, width: width * CGFloat(min(percent, 100)) / 100, height: 3), xRadius: 1.5, yRadius: 1.5).fill()
        }
    }
}

/// "▸ • 2 background tasks · npm run dev, …": the CLI footer's quiet line.
@MainActor
final class BackgroundToggle: NSView {
    var style: ConversationStyle!
    var onPress: (() -> Void)?
    private var tasks: [RunningTask] = []
    private var open = false
    private var hovering = false { didSet { needsDisplay = true } }
    private var tracking: NSTrackingArea?

    override var isFlipped: Bool { true }

    func update(tasks: [RunningTask], open: Bool) {
        self.tasks = tasks
        self.open = open
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(BackgroundWords.sentence(tasks.count))
        needsDisplay = true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseDown(with event: NSEvent) { onPress?() }

    override func draw(_ dirtyRect: NSRect) {
        guard let style, !tasks.isEmpty else { return }
        let size = style.em(0.75)
        let ink = hovering || open ? style.ink(.secondary) : style.ink(.tertiary)
        let mid = bounds.midY
        var x: CGFloat = 0
        GlyphPainter.draw(ConversationIcons.drawing(open ? .chevronDown : .chevronRight), in: CGRect(x: x, y: mid - size / 2, width: size, height: size), color: ink, stroke: ConversationIcons.stroke)
        x += size + size * 0.4
        style.ink(.statusBackground).setFill()
        NSBezierPath(ovalIn: NSRect(x: x, y: mid - size / 4, width: size / 2, height: size / 2)).fill()
        x += size / 2 + size * 0.4
        var words = BackgroundWords.sentence(tasks.count)
        if !open { words += " · " + tasks.map(\.title).joined(separator: ", ") }
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let text = NSAttributedString(string: words, attributes: [.font: style.sans(size), .foregroundColor: ink, .paragraphStyle: paragraph])
        let height = text.size().height
        text.draw(with: NSRect(x: x, y: mid - height / 2, width: max(0, bounds.width - x), height: height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }
}

/// One background task: its mark, title, kind and how long it has run; at its end, Stop.
@MainActor
final class BackgroundTaskLine: NSView {
    let task: RunningTask
    private let style: ConversationStyle
    var onOpen: (() -> Void)?
    var onStop: (() -> Void)?
    private let stop: ConversationButton
    private var hovering = false { didSet { needsDisplay = true } }
    private var tracking: NSTrackingArea?
    private let spinner: SpinnerMark

    init(task: RunningTask, style: ConversationStyle) {
        self.task = task
        self.style = style
        stop = ConversationButton(label: "", icon: .stop, look: .icon, size: style.em(0.75), style: style)
        spinner = SpinnerMark(style: style, side: style.em(0.75))
        super.init(frame: .zero)
        stop.setAccessibilityLabel("Stop")
        stop.toolTip = BackgroundWords.stopTitle(task.stoppable)
        stop.isEnabled = task.stoppable.isStoppable
        stop.onPress = { [weak self] in self?.onStop?() }
        addSubview(spinner)
        addSubview(stop)
        toolTip = task.call == nil ? nil : "Open what started it"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = task.call != nil }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseDown(with event: NSEvent) { if task.call != nil { onOpen?() } }

    override func layout() {
        super.layout()
        let side = style.em(0.75) + 6
        stop.frame = NSRect(x: bounds.width - side, y: (bounds.height - side) / 2, width: side, height: side)
        let mark = style.em(0.75)
        spinner.frame = NSRect(x: style.px(4), y: (bounds.height - mark) / 2, width: mark, height: mark)
    }

    override func draw(_ dirtyRect: NSRect) {
        let row = NSRect(x: 0, y: 0, width: bounds.width - style.em(0.75) - 10, height: bounds.height)
        if hovering {
            style.wash.setFill()
            NSBezierPath(roundedRect: row, xRadius: CGFloat(DevHubTheme.Radius.row), yRadius: CGFloat(DevHubTheme.Radius.row)).fill()
        }
        let size = style.em(0.75)
        let mid = bounds.midY
        var right = row.maxX - style.px(4)
        if let started = task.startedAt {
            let elapsed = NSAttributedString(string: BackgroundWords.elapsed(Date().timeIntervalSince1970 * 1000 - started), attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: size, weight: .regular), .foregroundColor: style.ink(.tertiary),
            ])
            let width = max(elapsed.size().width, size * 4.5)
            elapsed.draw(at: NSPoint(x: right - elapsed.size().width, y: mid - elapsed.size().height / 2))
            right -= width + style.px(8)
        }
        let kind = NSAttributedString(string: task.kind, attributes: [.font: style.sans(size), .foregroundColor: style.ink(.tertiary)])
        kind.draw(at: NSPoint(x: right - kind.size().width, y: mid - kind.size().height / 2))
        right -= kind.size().width + style.px(8)
        let x = style.px(4) + size + style.px(8)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let title = NSAttributedString(string: task.title, attributes: [.font: style.sans(size), .foregroundColor: hovering ? style.ink(.primary) : style.ink(.secondary), .paragraphStyle: paragraph])
        title.draw(with: NSRect(x: x, y: mid - title.size().height / 2, width: max(0, right - x), height: title.size().height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }
}
