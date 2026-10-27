// The sheets that are not a picker, and the picker's aside:
//
//   SessionPreviewView   sessionRows.tsx's `SessionPreview`: how the session
//                        the person is on ended.
//   WorkingView          Wizard.tsx's working band: a step doing, not asking.
//   ChordHelpView        picker/ChordHelpSheet.tsx: every chord, to read.
//   InjectionReviewView  picker/InjectionReviewSheet.tsx: the wording DevHub
//                        is about to type, before it types it.

import AppKit
import DevHubCore

/// A view that takes the keyboard only to hear Escape and Return.
@MainActor
final class KeyCatcherView: BandView {
    var onEscape: (() -> Void)?
    var onReturn: (() -> Void)?
    override var acceptsFirstResponder: Bool { true }
    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 0x35: onEscape?()
        case 0x24, 0x4C: if let onReturn { onReturn() } else { super.keyDown(with: event) }
        default: super.keyDown(with: event)
        }
    }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
}

// MARK: - The preview beside the sessions

@MainActor
final class SessionPreviewView: NSView, RestylableSheetContent {
    private var style: ShellStyle
    private(set) var preview: SheetRows.Preview?
    private let scroll = NSScrollView()
    private let document = BandView()
    private var labels: [WrappingLabel] = []
    private let spinner = SpinnerView(frame: NSRect(x: 0, y: 0, width: 16, height: 16))

    init(style: ShellStyle) {
        self.style = style
        super.init(frame: .zero)
        scroll.documentView = document
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        addSubview(scroll)
        document.addSubview(spinner)
        show(nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func restyle(_ style: ShellStyle) {
        self.style = style
        show(preview)
    }

    func show(_ preview: SheetRows.Preview?) {
        self.preview = preview
        for label in labels { label.removeFromSuperview() }
        labels = []
        spinner.isHidden = true
        let tokens = style.tokens
        func add(_ text: NSAttributedString, lines: Int = 0) {
            let label = WrappingLabel(selectable: true)
            label.attributedStringValue = text
            label.maximumNumberOfLines = lines
            label.lineBreakMode = lines > 0 ? .byTruncatingTail : .byWordWrapping
            document.addSubview(label)
            labels.append(label)
        }
        switch preview {
        case nil:
            add(Ink.text(SheetRows.previewInvite, size: 11, color: tokens.secondary.nsColor, lineHeight: 1.3))
        case .reading?:
            spinner.color = tokens.tertiary.nsColor
            spinner.isHidden = false
        case let .failed(reason)?:
            add(Ink.text(reason, size: 12, color: tokens.danger.nsColor))
        case let .read(lines)?:
            if lines.isEmpty {
                add(Ink.text(SheetRows.previewEmpty, size: 11, color: tokens.secondary.nsColor, lineHeight: 1.3))
            }
            for line in lines {
                let person = line.role == .person
                add(Ink.text(person ? "You" : "Agent", size: 11, color: tokens.secondary.nsColor))
                add(Ink.text(
                    line.text, size: 12, weight: person ? ShellStyle.medium : .regular,
                    color: person ? tokens.primary.nsColor : tokens.secondary.nsColor), lines: 6)
            }
        }
        needsLayout = true
    }

    override func layout() {
        super.layout()
        scroll.frame = bounds
        let width = max(0, bounds.width - 2 * Space.s4)
        var y = Space.s3
        var index = 0
        spinner.frame = CGRect(x: Space.s4, y: y, width: 16, height: 16)
        for label in labels {
            let height = label.maximumNumberOfLines > 0
                ? min(label.fittingHeight(width: width), CGFloat(label.maximumNumberOfLines) * 15 + 2)
                : label.fittingHeight(width: width)
            label.frame = CGRect(x: Space.s4, y: y, width: width, height: height)
            // A speaker and what they said are one item; items are 8pt apart.
            let isWho = preview.map { if case .read = $0 { return index % 2 == 0 } else { return false } } ?? false
            y += height + (isWho ? 2 : Space.s2)
            index += 1
        }
        document.frame = CGRect(x: 0, y: 0, width: bounds.width, height: max(bounds.height, y + Space.s3))
    }
}

// MARK: - A step doing rather than asking

@MainActor
final class WorkingView: NSView, RestylableSheetContent {
    let catcher = KeyCatcherView()
    private let spinner = SpinnerView(frame: NSRect(x: 0, y: 0, width: 16, height: 16))
    private let label = WrappingLabel()
    private let message: String
    private var style: ShellStyle

    init(message: String, style: ShellStyle) {
        self.message = message
        self.style = style
        super.init(frame: .zero)
        addSubview(catcher)
        catcher.addSubview(spinner)
        catcher.addSubview(label)
        setAccessibilityRole(.group)
        setAccessibilityLabel(message)
        restyle(style)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func restyle(_ style: ShellStyle) {
        self.style = style
        spinner.color = style.tokens.tertiary.nsColor
        label.attributedStringValue = Ink.text(message, size: 13, color: style.tokens.primary.nsColor)
    }

    static let height: CGFloat = 2 * Space.s4 + 20

    override func layout() {
        super.layout()
        catcher.frame = bounds
        spinner.frame = CGRect(x: Space.s4, y: (bounds.height - 16) / 2, width: 16, height: 16)
        let x = Space.s4 + 16 + Space.s3
        label.frame = CGRect(x: x, y: (bounds.height - 18) / 2, width: max(0, bounds.width - x - Space.s4), height: 18)
    }
}

// MARK: - Keyboard shortcuts

@MainActor
final class ChordHelpView: NSView, RestylableSheetContent {
    private let rows: [ChordHelpRow]
    private var style: ShellStyle
    let catcher = KeyCatcherView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let noteLabel = WrappingLabel()
    private let scroll = NSScrollView()
    private let list = ChordRowsView()
    private let footer = BandView()
    private var done: DevHubButton!
    var onDone: (() -> Void)?

    static let note = "Every DevHub command is two strokes: the prefix, then one key. A key that completes nothing cancels the chord and reaches nothing."

    init(rows: [ChordHelpRow], style: ShellStyle) {
        self.rows = rows
        self.style = style
        super.init(frame: .zero)
        done = DevHubButton(title: "Done", isDefault: false, style: style) { [weak self] in self?.onDone?() }
        done.refusesFirstResponder = true
        addSubview(catcher)
        catcher.addSubview(titleLabel)
        catcher.addSubview(noteLabel)
        list.rows = rows
        scroll.documentView = list
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        catcher.addSubview(scroll)
        catcher.addSubview(footer)
        footer.addSubview(done)
        catcher.onEscape = { [weak self] in self?.onDone?() }
        catcher.onReturn = { [weak self] in self?.onDone?() }
        setAccessibilityLabel("Keyboard shortcuts")
        restyle(style)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func restyle(_ style: ShellStyle) {
        self.style = style
        done.style = style
        list.style = style
        let tokens = style.tokens
        titleLabel.attributedStringValue = Ink.text("Keyboard shortcuts", size: 15, weight: .semibold, color: tokens.primary.nsColor)
        noteLabel.attributedStringValue = Ink.text(Self.note, size: 11, color: tokens.secondary.nsColor, lineHeight: 1.3)
        footer.fill = tokens.chrome.nsColor
        needsDisplay = true
        list.needsDisplay = true
    }

    private func top(_ width: CGFloat) -> CGFloat {
        Space.s4 + 20 + 2 + noteLabel.fittingHeight(width: width - 2 * Space.s4) + Space.s3
    }

    private let footerHeight = Space.s3 + 22 + Space.s3

    func preferredHeight(width: CGFloat) -> CGFloat {
        top(width) + 1 + list.height(width: width) + 1 + footerHeight
    }

    override func layout() {
        super.layout()
        catcher.frame = bounds
        let width = bounds.width
        titleLabel.frame = CGRect(x: Space.s4, y: Space.s4, width: width - 2 * Space.s4, height: 20)
        noteLabel.frame = CGRect(x: Space.s4, y: Space.s4 + 22, width: width - 2 * Space.s4, height: noteLabel.fittingHeight(width: width - 2 * Space.s4))
        let listTop = top(width) + 1
        let listHeight = max(0, bounds.height - listTop - 1 - footerHeight)
        scroll.frame = CGRect(x: 0, y: listTop, width: width, height: listHeight)
        list.frame = CGRect(x: 0, y: 0, width: width, height: max(listHeight, list.height(width: width)))
        footer.frame = CGRect(x: 0, y: bounds.height - footerHeight, width: width, height: footerHeight)
        let size = done.intrinsicContentSize
        done.frame = CGRect(x: width - Space.s4 - size.width, y: Space.s3, width: size.width, height: 22)
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        style.tokens.lineSoft.nsColor.setFill()
        let listTop = top(bounds.width)
        CGRect(x: 0, y: listTop, width: bounds.width, height: 1).fill()
        CGRect(x: 0, y: bounds.height - footerHeight - 1, width: bounds.width, height: 1).fill()
    }
}

/// The chords, keys leading.
@MainActor
final class ChordRowsView: NSView {
    var rows: [ChordHelpRow] = [] { didSet { needsDisplay = true } }
    var style: ShellStyle?
    override var isFlipped: Bool { true }

    private static let keysColumn: CGFloat = 148

    private func lines(_ row: ChordHelpRow, width: CGFloat) -> (keys: [[String]], height: CGFloat) {
        // The keys wrap within their column, 4pt apart.
        var lines: [[String]] = [[]]
        var x: CGFloat = 0
        for chord in row.chords {
            let w = Keycap.width(chord)
            if x > 0, x + w > Self.keysColumn { lines.append([]); x = 0 }
            lines[lines.count - 1].append(chord)
            x += w + 4
        }
        let keysHeight = CGFloat(lines.count) * 17 + CGFloat(lines.count - 1) * 4
        return (lines, max(keysHeight, 17) + 6)
    }

    func height(width: CGFloat) -> CGFloat {
        Space.s2 * 2 + rows.reduce(0) { $0 + lines($1, width: width).height }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let style else { return }
        let tokens = style.tokens
        var y = Space.s2
        for row in rows {
            let (keys, height) = lines(row, width: bounds.width)
            var ky = y + 3
            for line in keys {
                var kx = Space.s4
                for key in line { kx += Keycap.draw(key, at: CGPoint(x: kx, y: ky), tokens: tokens, ink: tokens.primary.nsColor) + 4 }
                ky += 21
            }
            let label = NSMutableAttributedString(attributedString: Ink.text(row.label, size: 13, color: tokens.primary.nsColor))
            if let needs = row.needs {
                label.append(Ink.text(" \(needs)", size: 13, color: tokens.secondary.nsColor))
            }
            let x = Space.s4 + Self.keysColumn + Space.s3
            Ink.drawLine(label, in: CGRect(x: x, y: y + 3, width: max(0, bounds.width - x - Space.s4), height: 18))
            y += height
        }
    }
}

// MARK: - Review the prompt

/// The field: monospaced, the template's own line breaks kept; Command-Return sends.
@MainActor
final class ReviewTextView: NSTextView {
    var onSend: (() -> Void)?
    var onCancel: (() -> Void)?
    override func keyDown(with event: NSEvent) {
        if (event.keyCode == 0x24 || event.keyCode == 0x4C), !event.modifierFlags.intersection([.command, .control]).isEmpty {
            if hasMarkedText() { return super.keyDown(with: event) }
            onSend?()
            return
        }
        super.keyDown(with: event)
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if window?.firstResponder === self, event.keyCode == 0x24 || event.keyCode == 0x4C, event.modifierFlags.contains(.command) {
            if !hasMarkedText() { onSend?() }
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
    override func cancelOperation(_ sender: Any?) {
        if hasMarkedText() { return super.cancelOperation(sender) }
        onCancel?()
    }
}

@MainActor
final class InjectionReviewView: NSView, RestylableSheetContent {
    private var style: ShellStyle
    private let header = BandView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let agentLabel = NSTextField(labelWithString: "")
    private let questionLabel = NSTextField(labelWithString: "")
    private let fieldScroll = NSScrollView()
    let field = ReviewTextView()
    private let footer = BandView()
    private let noteLabel = WrappingLabel(selectable: true)
    private var cancelButton: DevHubButton!
    private var sendButton: DevHubButton!
    private let actionName: String
    private(set) var agentName: String?
    /// Why it cannot go (the agent left), or why it did not (the send failed).
    private(set) var gone: String?
    private(set) var failure: String?
    private(set) var busy = false
    private var status = ""
    var onSend: ((String) -> Void)?
    var onCancel: (() -> Void)?

    init(actionName: String, text: String, style: ShellStyle) {
        self.actionName = actionName
        self.style = style
        super.init(frame: .zero)
        cancelButton = DevHubButton(title: "Cancel", isDefault: false, style: style) { [weak self] in self?.cancel() }
        sendButton = DevHubButton(title: "Send", isDefault: true, style: style) { [weak self] in self?.send() }
        cancelButton.refusesFirstResponder = true
        sendButton.refusesFirstResponder = true
        addSubview(header)
        header.addSubview(titleLabel)
        header.addSubview(agentLabel)
        header.addSubview(questionLabel)
        fieldScroll.documentView = field
        fieldScroll.hasVerticalScroller = true
        fieldScroll.autohidesScrollers = true
        fieldScroll.borderType = .noBorder
        fieldScroll.drawsBackground = false
        fieldScroll.wantsLayer = true
        fieldScroll.layer?.cornerRadius = 5
        fieldScroll.layer?.borderWidth = 1
        addSubview(fieldScroll)
        field.isRichText = false
        field.allowsUndo = true
        field.isAutomaticQuoteSubstitutionEnabled = false
        field.isAutomaticDashSubstitutionEnabled = false
        field.isAutomaticTextReplacementEnabled = false
        field.isAutomaticSpellingCorrectionEnabled = false
        field.isContinuousSpellCheckingEnabled = false
        field.isVerticallyResizable = true
        field.isHorizontallyResizable = false
        field.autoresizingMask = [.width]
        field.textContainer?.widthTracksTextView = true
        field.textContainerInset = NSSize(width: 4, height: 6)
        field.string = text
        field.onSend = { [weak self] in self?.send() }
        field.onCancel = { [weak self] in self?.cancel() }
        field.setAccessibilityLabel("Message to send")
        addSubview(footer)
        footer.addSubview(noteLabel)
        footer.addSubview(cancelButton)
        footer.addSubview(sendButton)
        NotificationCenter.default.addObserver(self, selector: #selector(textChanged), name: NSText.didChangeNotification, object: field)
        restyle(style)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    @objc private func textChanged(_ note: Notification) { refresh() }

    /// What the agent is doing now, as the projection says.
    func observe(agent: AgentWire?, known: Bool) {
        agentName = agent?.displayName
        gone = SheetRows.injectionGone(agent, known: known)
        status = SheetRows.injectionStatus(agent)
        refresh()
    }

    func failed(_ reason: String) {
        busy = false
        failure = reason
        refresh()
    }

    func restyle(_ style: ShellStyle) {
        self.style = style
        cancelButton.style = style
        sendButton.style = style
        let tokens = style.tokens
        header.fill = tokens.chrome.nsColor
        footer.fill = tokens.chrome.nsColor
        field.backgroundColor = tokens.surface.nsColor
        field.textColor = tokens.primary.nsColor
        field.insertionPointColor = tokens.primary.nsColor
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 18
        paragraph.maximumLineHeight = 18
        field.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        field.defaultParagraphStyle = paragraph
        field.typingAttributes = [.font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), .foregroundColor: tokens.primary.nsColor, .paragraphStyle: paragraph]
        fieldScroll.layer?.backgroundColor = tokens.surface.cgColor
        refresh()
    }

    private func refresh() {
        let tokens = style.tokens
        titleLabel.attributedStringValue = Ink.text(actionName, size: 13, weight: .semibold, color: tokens.primary.nsColor, breaking: .byTruncatingTail)
        agentLabel.attributedStringValue = Ink.text(agentName ?? "", size: 11, color: tokens.tertiary.nsColor)
        questionLabel.attributedStringValue = Ink.text("Review the prompt before it is sent", size: 11, color: tokens.secondary.nsColor)
        let alert = gone ?? failure
        noteLabel.attributedStringValue = Ink.text(alert ?? status, size: 11, color: alert == nil ? tokens.secondary.nsColor : tokens.danger.nsColor, lineHeight: 1.3)
        cancelButton.title = gone == nil ? "Cancel" : "Close"
        sendButton.title = busy ? "Sending…" : "Send"
        let blank = field.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let sendable = !busy && gone == nil && !blank
        sendButton.alphaValue = sendable ? 1 : 0.4
        cancelButton.alphaValue = busy ? 0.4 : 1
        field.isEditable = !busy && gone == nil
        fieldScroll.layer?.borderColor = (window?.firstResponder === field ? tokens.accent : tokens.lineSoft).cgColor
        fieldScroll.layer?.borderWidth = window?.firstResponder === field ? 2 : 1
        needsLayout = true
    }

    private func send() {
        let blank = field.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        guard !busy, gone == nil, !blank else { return }
        busy = true
        failure = nil
        refresh()
        onSend?(field.string)
    }

    private func cancel() {
        guard !busy else { return }
        onCancel?()
    }

    private func headerHeight(_ width: CGFloat) -> CGFloat { Space.s3 + 17 + 2 + 15 + Space.s3 }
    private func footerHeight(_ width: CGFloat) -> CGFloat {
        Space.s3 + noteLabel.fittingHeight(width: width - 2 * Space.s4) + Space.s2 + 22 + Space.s3
    }

    func preferredHeight(width: CGFloat) -> CGFloat {
        headerHeight(width) + 1 + Space.s3 + 240 + Space.s3 + 1 + footerHeight(width)
    }

    override func layout() {
        super.layout()
        let width = bounds.width
        let inset = Space.s4
        let headerH = headerHeight(width)
        header.frame = CGRect(x: 0, y: 0, width: width, height: headerH)
        let agentWidth = ceil(agentLabel.attributedStringValue.size().width) + 2
        titleLabel.frame = CGRect(x: inset, y: Space.s3, width: max(0, width - 2 * inset - agentWidth - Space.s3), height: 17)
        agentLabel.frame = CGRect(x: width - inset - agentWidth, y: Space.s3 + 2, width: agentWidth, height: 14)
        questionLabel.frame = CGRect(x: inset, y: Space.s3 + 19, width: width - 2 * inset, height: 15)
        let footerH = footerHeight(width)
        let fieldTop = headerH + 1 + Space.s3
        let fieldHeight = max(180, bounds.height - fieldTop - Space.s3 - 1 - footerH)
        fieldScroll.frame = CGRect(x: inset, y: fieldTop, width: width - 2 * inset, height: fieldHeight)
        field.minSize = NSSize(width: 0, height: fieldHeight)
        field.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        field.frame.size.width = fieldScroll.contentSize.width
        footer.frame = CGRect(x: 0, y: bounds.height - footerH, width: width, height: footerH)
        let noteH = noteLabel.fittingHeight(width: width - 2 * inset)
        noteLabel.frame = CGRect(x: inset, y: Space.s3, width: width - 2 * inset, height: noteH)
        let send = sendButton.intrinsicContentSize
        let cancel = cancelButton.intrinsicContentSize
        let buttonsY = Space.s3 + noteH + Space.s2
        sendButton.frame = CGRect(x: width - inset - send.width, y: buttonsY, width: send.width, height: 22)
        cancelButton.frame = CGRect(x: sendButton.frame.minX - Space.s2 - cancel.width, y: buttonsY, width: cancel.width, height: 22)
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        style.tokens.lineSoft.nsColor.setFill()
        let headerH = headerHeight(bounds.width)
        CGRect(x: 0, y: headerH, width: bounds.width, height: 1).fill()
        CGRect(x: 0, y: bounds.height - footerHeight(bounds.width) - 1, width: bounds.width, height: 1).fill()
    }
}
