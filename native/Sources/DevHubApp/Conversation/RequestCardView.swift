// Port of apps/desktop/src/shell/conversation/RequestCard.tsx: a question the
// Agent is waiting on, drawn as a card in the transcript.
//
// The card lays out what the request carries and nothing else. Which answers
// exist, what they are called and whether one takes a sentence are all in
// `choices`, decided by the adapter. A request answered by filling something
// in — questions, an elicitation's fields — has a form, whose submit is the
// first answer in the row. An answer that fails to reach the Agent is said at
// the pane's root and the card stays: the request is still open.
//
// From the keyboard, as in the CLIs' own dialogs: with the card focused, 1–9
// press its answers in order, and Esc goes back to the composer. What is
// typed into it is written under the composer's keys: Return is a new line
// and ⌘Return answers.

import AppKit
import DevHubCore

/// A small document drawn in a view of its own (a card's subject, a preview).
@MainActor
final class DocumentView: NSView {
    let text: TranscriptTextView
    private var blocks: [DocBlock] = []

    init(style: ConversationStyle, host: EmbedHost?) {
        text = TranscriptTextView.make(style: style)
        super.init(frame: .zero)
        text.textContainerInset = .zero
        text.embeds.host = host
        text.drawsBackground = false
        addSubview(text)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func show(_ blocks: [DocBlock], key: String, style: ConversationStyle) {
        if blocks != self.blocks || text.style.fontSize != style.fontSize {
            self.blocks = blocks
            text.applyStyle(style)
            text.drawsBackground = false
            text.show(blocks.isEmpty ? [] : [DocSection(id: key, kind: "doc", blocks: blocks)])
        }
    }

    func height(forWidth width: CGFloat) -> CGFloat {
        guard !blocks.isEmpty else { return 0 }
        if abs(text.frame.width - width) > 0.5 {
            text.frame = NSRect(x: 0, y: 0, width: width, height: max(1, text.frame.height))
            text.rerender()
        }
        return text.documentHeight()
    }

    override func layout() {
        super.layout()
        text.frame = bounds
    }
}

@MainActor
final class RequestCardView: NSView, EmbedContent {
    private(set) var request: PendingRequest
    private var style: ConversationStyle
    private weak var host: EmbedHost?
    private let resized: () -> Void
    private let eyebrow = NSTextField(labelWithString: "Needs your answer")
    private let subject: DocumentView
    private var questions: QuestionFormView?
    private var elicitation: ElicitationFormView?
    private let choices = FlowRow()
    private var writing: RequestChoice?
    private let writingField = ComposerTextView.make()
    private let writingScroll = NSScrollView()
    private var busy = false { didSet { renderChoices() } }

    init(request: PendingRequest, style: ConversationStyle, host: EmbedHost?, resized: @escaping () -> Void) {
        self.request = request
        self.style = style
        self.host = host
        self.resized = resized
        subject = DocumentView(style: style, host: host)
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = CGFloat(DevHubTheme.Radius.panel)
        layer?.borderWidth = 1
        eyebrow.isSelectable = false
        addSubview(eyebrow)
        addSubview(subject)
        addSubview(choices)
        choices.align = .trailing
        writingScroll.documentView = writingField
        writingScroll.drawsBackground = false
        writingScroll.hasVerticalScroller = true
        writingScroll.autohidesScrollers = true
        writingScroll.wantsLayer = true
        writingScroll.layer?.borderWidth = 1
        writingScroll.layer?.cornerRadius = CGFloat(DevHubTheme.Radius.control)
        writingScroll.isHidden = true
        addSubview(writingScroll)
        writingField.onSubmit = { [weak self] in self?.answerWriting() }
        writingField.onCommand = { [weak self] selector in
            guard selector == #selector(NSResponder.cancelOperation(_:)) else { return false }
            self?.host?.focusComposer()
            return true
        }
        writingField.onChange = { [weak self] in self?.resized() }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("The Agent is waiting for an answer")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    func update(_ kind: DocEmbedKind, style: ConversationStyle) {
        self.style = style
        if case .request(let request) = kind { self.request = request }
        layer?.backgroundColor = style.raised.cgColor
        layer?.borderColor = style.line.cgColor
        eyebrow.font = style.sans(style.em(0.85), bold: true)
        eyebrow.textColor = style.ink(.statusWaiting)
        let builder = EntryDocumentBuilder(transcript: EMPTY_TRANSCRIPT, state: EntryDocumentState())
        subject.show(builder.requestSubject(request), key: "request:\(request.id.raw)", style: style)
        switch request.subject {
        case .question(let list):
            let form = questions ?? QuestionFormView(style: style, card: self)
            if questions == nil { addSubview(form); questions = form }
            form.update(list, style: style)
        case let .elicitation(_, _, _, fields):
            let form = elicitation ?? ElicitationFormView(style: style, card: self)
            if elicitation == nil { addSubview(form); elicitation = form }
            form.update(fields, style: style)
        default: break
        }
        writingField.apply(style, size: style.em(0.92))
        writingScroll.layer?.borderColor = style.line.cgColor
        writingScroll.layer?.backgroundColor = style.surface.cgColor
        renderChoices()
        needsLayout = true
    }

    /// The word on the form's submit, when the request has one.
    private var submitLabel: String? {
        switch request.subject {
        case .question: return "Submit"
        case .elicitation: return "Accept"
        default: return nil
        }
    }

    private func renderChoices() {
        let size = style.em(0.85)
        if let writing {
            let back = ConversationButton(label: "Back", look: .choice(.neutral), size: size, style: style) { [weak self] in
                self?.writing = nil
                self?.writingScroll.isHidden = true
                self?.renderChoices()
                self?.resized()
            }
            let go = ConversationButton(label: writing.label, look: .choice(writing.tone), size: size, style: style) { [weak self] in self?.answerWriting() }
            go.toolTip = "\(writing.label) (\(ComposerWords.sendKey))"
            back.isEnabled = !busy
            go.isEnabled = !busy
            choices.items = [back, go]
            return
        }
        var items: [ConversationButton] = []
        var index = 0
        func digit() -> String? { index < 9 ? String(index + 1) : nil }
        if let label = submitLabel {
            let button = ConversationButton(label: label, look: .choice(.allow), size: size, style: style) { [weak self] in self?.submitForm() }
            button.keyDigit = digit()
            button.toolTip = "\(label) (\(ComposerWords.sendKey))"
            items.append(button)
            index += 1
        }
        for choice in request.choices {
            let button = ConversationButton(label: choice.label + (choice.takesText ? "…" : ""), look: .choice(choice.tone), size: size, style: style) { [weak self] in
                self?.press(choice)
            }
            button.keyDigit = digit()
            items.append(button)
            index += 1
        }
        for item in items { item.isEnabled = !busy }
        choices.items = items
    }

    private func press(_ choice: RequestChoice) {
        guard !busy else { return }
        if choice.takesText {
            writing = choice
            writingField.setText("")
            writingField.setAccessibilityLabel(choice.label)
            writingScroll.isHidden = false
            renderChoices()
            resized()
            window?.makeFirstResponder(writingField)
            return
        }
        send(.choice(choiceId: choice.id, text: nil))
    }

    private func answerWriting() {
        guard let writing, !busy else { return }
        send(.choice(choiceId: writing.id, text: writingField.string))
    }

    func submitForm() {
        guard !busy else { return }
        if let questions { send(questions.answer()) }
        if let elicitation, let answer = elicitation.answer() { send(answer) }
        resized()
    }

    func send(_ answer: RequestAnswer) {
        busy = true
        Task { [weak self] in
            guard let self else { return }
            _ = await self.host?.answer(self.request, answer)
            self.busy = false
        }
    }

    func focusComposer() { host?.focusComposer() }
    func formResized() { resized() }

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.keyCode == 53 {
            // Back to the composer, and not an interrupt.
            host?.focusComposer()
            return
        }
        if flags.isDisjoint(with: [.command, .control, .option]), let key = event.charactersIgnoringModifiers, let digit = Int(key), (1...9).contains(digit) {
            let buttons = choices.items.compactMap { $0 as? ConversationButton }
            if digit - 1 < buttons.count, buttons[digit - 1].isEnabled {
                buttons[digit - 1].press()
                return
            }
        }
        super.keyDown(with: event)
    }

    override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self) }

    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() {
        NSBezierPath(roundedRect: bounds, xRadius: CGFloat(DevHubTheme.Radius.panel), yRadius: CGFloat(DevHubTheme.Radius.panel)).fill()
    }

    // MARK: Layout

    private var pad: (top: CGFloat, side: CGFloat, bottom: CGFloat) { (style.px(8), style.px(12), style.px(12)) }

    func height(forWidth width: CGFloat) -> CGFloat { arrange(width, apply: false) }

    @discardableResult
    private func arrange(_ width: CGFloat, apply: Bool) -> CGFloat {
        let inner = max(40, width - 2 * pad.side)
        var y = pad.top
        let eyebrowHeight = ceil(style.em(0.85) * 1.5)
        if apply { eyebrow.frame = NSRect(x: pad.side, y: y, width: inner, height: eyebrowHeight) }
        y += eyebrowHeight + style.px(4)
        let subjectHeight = subject.height(forWidth: inner)
        if apply { subject.frame = NSRect(x: pad.side, y: y, width: inner, height: subjectHeight) }
        y += subjectHeight
        if let questions {
            let height = questions.height(forWidth: inner)
            if apply { questions.frame = NSRect(x: pad.side, y: y, width: inner, height: height) }
            y += height
        }
        if let elicitation {
            let height = elicitation.height(forWidth: min(inner, style.em(36)))
            if apply { elicitation.frame = NSRect(x: pad.side, y: y, width: min(inner, style.em(36)), height: height) }
            y += height
        }
        if writing != nil {
            let height = max(style.em(0.92) * 1.55 * 2, writingField.contentHeight) + 8
            if apply {
                writingScroll.frame = NSRect(x: pad.side, y: y + style.px(4), width: inner, height: height)
                writingField.textContainerInset = NSSize(width: style.px(8), height: 2)
                writingField.frame.size.width = writingScroll.contentSize.width
            }
            y += height + style.px(4)
        }
        if !choices.items.isEmpty {
            y += style.px(8)
            let height = choices.height(forWidth: inner)
            if apply { choices.frame = NSRect(x: pad.side, y: y, width: inner, height: height) }
            y += height
        }
        return y + pad.bottom
    }

    override func layout() {
        super.layout()
        arrange(bounds.width, apply: true)
    }
}

// MARK: - Questions

/// An option as a row of a list: its mark, its label, its description on one quiet line under it.
@MainActor
final class OptionRowView: NSView {
    var label: String
    var detail: String
    var multiple: Bool
    var picked = false { didSet { needsDisplay = true } }
    var shown = false { didSet { needsDisplay = true } }
    var style: ConversationStyle { didSet { needsDisplay = true } }
    var onToggle: (() -> Void)?
    var onPoint: ((Bool) -> Void)?
    private var hovering = false { didSet { needsDisplay = true } }
    private var tracking: NSTrackingArea?

    init(label: String, detail: String, multiple: Bool, style: ConversationStyle) {
        self.label = label
        self.detail = detail
        self.multiple = multiple
        self.style = style
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(multiple ? .checkBox : .radioButton)
        setAccessibilityLabel(label)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { onToggle != nil }

    private var markSide: CGFloat { 14 }
    private var textLeft: CGFloat { style.px(8) + markSide + style.px(8) }

    private var labelText: NSAttributedString {
        NSAttributedString(string: label, attributes: [.font: style.body, .foregroundColor: style.ink(.primary)])
    }

    private var detailText: NSAttributedString? {
        guard !detail.isEmpty else { return nil }
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        return NSAttributedString(string: detail, attributes: [.font: style.sans(style.em(0.85)), .foregroundColor: style.ink(.secondary), .paragraphStyle: paragraph])
    }

    func height(forWidth width: CGFloat) -> CGFloat {
        let inner = max(20, width - textLeft - style.px(8))
        var height = ceil(labelText.boundingRect(with: NSSize(width: inner, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).height)
        if let detailText { height += 1 + ceil(detailText.size().height) }
        return height + 2 * style.px(4) + 2
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        hovering = onToggle != nil
        onPoint?(true)
    }

    override func mouseExited(with event: NSEvent) {
        hovering = false
        onPoint?(false)
    }

    override func mouseDown(with event: NSEvent) {
        guard let onToggle else { return }
        window?.makeFirstResponder(self)
        onToggle()
    }

    override func keyDown(with event: NSEvent) {
        if event.charactersIgnoringModifiers == " ", let onToggle { onToggle() } else { super.keyDown(with: event) }
    }

    override func becomeFirstResponder() -> Bool {
        onPoint?(true)
        return super.becomeFirstResponder()
    }

    override func resignFirstResponder() -> Bool {
        onPoint?(false)
        return super.resignFirstResponder()
    }

    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() {
        NSBezierPath(roundedRect: bounds, xRadius: CGFloat(DevHubTheme.Radius.control), yRadius: CGFloat(DevHubTheme.Radius.control)).fill()
    }

    override func draw(_ dirtyRect: NSRect) {
        let t = style.tokens
        let radius = CGFloat(DevHubTheme.Radius.control)
        let box = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
        var fill = style.surface, border = style.lineSoft
        if hovering || shown { fill = style.wash; border = style.line }
        if picked { fill = t.accent.mix(0.1, with: t.surface).nsColor; border = t.accent.nsColor }
        fill.setFill()
        box.fill()
        border.setStroke()
        box.lineWidth = 1
        box.stroke()
        let markRect = NSRect(x: style.px(8), y: style.px(4) + style.em(0.2), width: markSide, height: markSide).insetBy(dx: 0.75, dy: 0.75)
        let mark = multiple ? NSBezierPath(roundedRect: markRect, xRadius: 3, yRadius: 3) : NSBezierPath(ovalIn: markRect)
        mark.lineWidth = 1.5
        if picked {
            t.accent.nsColor.setFill()
            mark.fill()
            t.accent.nsColor.setStroke()
            mark.stroke()
            GlyphPainter.draw(ConversationIcons.drawing(.check), in: markRect.insetBy(dx: 2, dy: 2), color: t.accentInk.nsColor == t.accent.nsColor ? .white : t.accentInk.nsColor, stroke: 2.2)
        } else {
            style.ink(.tertiary).setStroke()
            mark.stroke()
        }
        let inner = max(20, bounds.width - textLeft - style.px(8))
        let labelRect = labelText.boundingRect(with: NSSize(width: inner, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin])
        labelText.draw(with: NSRect(x: textLeft, y: style.px(4), width: inner, height: ceil(labelRect.height)), options: [.usesLineFragmentOrigin])
        if let detailText {
            detailText.draw(with: NSRect(x: textLeft, y: style.px(4) + ceil(labelRect.height) + 1, width: inner, height: ceil(detailText.size().height)), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        }
    }
}

/// The questions of a request, to answer: each with its options, a field for words of the person's own, and its preview.
@MainActor
final class QuestionFormView: NSView {
    private var style: ConversationStyle
    private weak var card: RequestCardView?
    private var questions: [Question] = []
    private var picked: [String: [String]] = [:]
    private var others: [String: ComposerTextView] = [:]
    private var blocks: [QuestionBlock] = []

    init(style: ConversationStyle, card: RequestCardView) {
        self.style = style
        self.card = card
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func update(_ questions: [Question], style: ConversationStyle) {
        self.style = style
        if questions != self.questions {
            self.questions = questions
            for block in blocks { block.removeFromSuperview() }
            blocks = questions.enumerated().map { index, question in
                let block = QuestionBlock(question: question, position: (index, questions.count), style: style, form: self)
                addSubview(block)
                return block
            }
        }
        for block in blocks { block.restyle(style) }
        needsLayout = true
    }

    fileprivate func pick(_ question: Question, _ label: String) {
        var current = picked[question.id] ?? []
        if question.multiSelect {
            if let at = current.firstIndex(of: label) { current.remove(at: at) } else { current.append(label) }
        } else {
            current = [label]
        }
        picked[question.id] = current
        for block in blocks where block.question.id == question.id { block.setPicked(current) }
    }

    fileprivate func submit() { card?.submitForm() }
    fileprivate func toComposer() { card?.focusComposer() }
    fileprivate func resized() {
        needsLayout = true
        card?.formResized()
    }

    func answer() -> RequestAnswer {
        var values: [(String, AnswerValue)] = []
        for (question, block) in zip(questions, blocks) {
            let typed = block.other?.string.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let chosen = picked[question.id] ?? []
            let all = typed.isEmpty ? chosen : chosen + [typed]
            values.append((question.id, question.multiSelect ? .many(all) : .one(all.first ?? "")))
        }
        return .answers(values: values, notes: nil)
    }

    func height(forWidth width: CGFloat) -> CGFloat {
        var y: CGFloat = 0
        for (index, block) in blocks.enumerated() {
            y += index == 0 ? style.px(8) : style.px(12) * 2 + 1
            y += block.height(forWidth: width)
        }
        return y
    }

    override func layout() {
        super.layout()
        var y: CGFloat = 0
        for (index, block) in blocks.enumerated() {
            y += index == 0 ? style.px(8) : style.px(12) * 2 + 1
            let height = block.height(forWidth: bounds.width)
            block.frame = NSRect(x: 0, y: y, width: bounds.width, height: height)
            block.ruleAbove = index > 0
            y += height
        }
    }
}

/// One question on the card: its header chip and place, its words, its options, Other, and the preview beside or under.
@MainActor
final class QuestionBlock: NSView {
    let question: Question
    private let position: (index: Int, count: Int)
    private var style: ConversationStyle
    private weak var form: QuestionFormView?
    private let words = NSTextField(wrappingLabelWithString: "")
    private var rows: [OptionRowView] = []
    private(set) var other: ComposerTextView?
    private var otherScroll: NSScrollView?
    private let preview: DocumentView?
    private var pointed: String?
    private var picked: [String] = []
    var ruleAbove = false { didSet { needsDisplay = true } }

    init(question: Question, position: (Int, Int), style: ConversationStyle, form: QuestionFormView) {
        self.question = question
        self.position = position
        self.style = style
        self.form = form
        preview = (!question.multiSelect && question.options.contains { $0.preview != nil }) ? DocumentView(style: style, host: nil) : nil
        super.init(frame: .zero)
        words.isSelectable = true
        addSubview(words)
        for option in question.options {
            let row = OptionRowView(label: option.label, detail: option.description, multiple: question.multiSelect, style: style)
            row.onToggle = { [weak self] in
                guard let self else { return }
                self.form?.pick(self.question, option.label)
            }
            row.onPoint = { [weak self] on in self?.point(option.label, on) }
            addSubview(row)
            rows.append(row)
        }
        if question.allowsOther {
            let field = ComposerTextView.make()
            let scroll = NSScrollView()
            scroll.documentView = field
            scroll.drawsBackground = false
            scroll.hasVerticalScroller = false
            scroll.wantsLayer = true
            scroll.layer?.borderWidth = 1
            scroll.layer?.cornerRadius = CGFloat(DevHubTheme.Radius.control)
            field.placeholder = "Other — type your own answer"
            field.setAccessibilityLabel("\(question.header): other")
            field.onSubmit = { [weak self] in self?.form?.submit() }
            field.onCommand = { [weak self] selector in
                guard selector == #selector(NSResponder.cancelOperation(_:)) else { return false }
                self?.form?.toComposer()
                return true
            }
            field.onChange = { [weak self] in
                self?.needsDisplay = true
                self?.restyleOther()
                self?.form?.resized()
            }
            addSubview(scroll)
            other = field
            otherScroll = scroll
        }
        if let preview { addSubview(preview) }
        restyle(style)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func restyle(_ style: ConversationStyle) {
        self.style = style
        words.font = style.sans(style.fontSize, medium: true)
        words.textColor = style.ink(.primary)
        words.stringValue = question.text
        for row in rows { row.style = style }
        other?.apply(style)
        restyleOther()
        showPreview()
        needsDisplay = true
    }

    private func restyleOther() {
        guard let scroll = otherScroll, let other else { return }
        let filled = !other.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        scroll.layer?.borderColor = (filled ? style.tokens.accent.nsColor : style.lineSoft).cgColor
        scroll.layer?.backgroundColor = (filled ? style.tokens.accent.mix(0.1, with: style.tokens.surface).nsColor : style.surface).cgColor
    }

    func setPicked(_ picked: [String]) {
        self.picked = picked
        for (row, option) in zip(rows, question.options) { row.picked = picked.contains(option.label) }
        showPreview()
    }

    private func point(_ label: String, _ on: Bool) {
        pointed = on ? label : (pointed == label ? nil : pointed)
        showPreview()
    }

    private var shownOption: QuestionOption? {
        let label = pointed ?? picked.first ?? question.options.first?.label
        return question.options.first { $0.label == label }
    }

    private func showPreview() {
        guard let preview, let option = shownOption else { return }
        let builder = EntryDocumentBuilder(transcript: EMPTY_TRANSCRIPT, state: EntryDocumentState())
        preview.show([builder.optionPreview("preview:\(question.id)", option)], key: "preview:\(question.id)", style: style)
        for (row, each) in zip(rows, question.options) { row.shown = each.label == option.label }
        needsLayout = true
        form?.resized()
    }

    private var headerText: NSAttributedString? {
        guard !question.header.isEmpty else { return nil }
        return NSAttributedString(string: question.header, attributes: [.font: style.sans(style.em(0.78), bold: true), .foregroundColor: style.tokens.accent.nsColor])
    }

    private var stepText: NSAttributedString? {
        guard position.count > 1 else { return nil }
        return NSAttributedString(string: "\(position.index + 1) of \(position.count)", attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: style.em(0.8), weight: .regular), .foregroundColor: style.ink(.tertiary),
        ])
    }

    private var beside: Bool { preview != nil }

    func height(forWidth width: CGFloat) -> CGFloat { arrange(width, apply: false) }

    @discardableResult
    private func arrange(_ width: CGFloat, apply: Bool) -> CGFloat {
        var y: CGFloat = 0
        if headerText != nil || stepText != nil {
            y += ceil(style.em(0.78) * 1.5) + 2 + style.px(4)
        }
        let wordsHeight = ceil(words.attributedStringValue.boundingRect(with: NSSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).height)
        if apply { words.frame = NSRect(x: 0, y: y, width: width, height: wordsHeight + 2) }
        y += wordsHeight + style.px(8)
        // Options on the left and the preview on the right, or under them when narrow.
        let narrow = width < style.em(34)
        let gap = style.px(12)
        let optionsWidth = beside && !narrow ? floor((width - gap) * 2 / 5) : min(width, style.em(36))
        var rowsY = y
        for row in rows {
            let height = row.height(forWidth: optionsWidth)
            if apply { row.frame = NSRect(x: 0, y: rowsY, width: optionsWidth, height: height) }
            rowsY += height + style.px(4)
        }
        if let other, let scroll = otherScroll {
            other.frame.size.width = optionsWidth - 2 * style.px(8)
            let height = max(ceil(style.fontSize * 1.55), other.contentHeight) + 2 * style.px(4)
            if apply {
                scroll.frame = NSRect(x: 0, y: rowsY, width: optionsWidth, height: height)
                other.textContainerInset = NSSize(width: style.px(8), height: style.px(4))
                other.frame.size.width = scroll.contentSize.width
            }
            rowsY += height + style.px(4)
        }
        var bottom = rowsY
        if let preview {
            let previewWidth = narrow ? width : width - optionsWidth - gap
            let height = min(preview.height(forWidth: previewWidth), style.em(22))
            let top = narrow ? rowsY + style.px(8) : y
            if apply { preview.frame = NSRect(x: narrow ? 0 : optionsWidth + gap, y: top, width: previewWidth, height: height) }
            bottom = max(bottom, top + height)
        }
        return bottom
    }

    override func layout() {
        super.layout()
        arrange(bounds.width, apply: true)
    }

    override func draw(_ dirtyRect: NSRect) {
        if ruleAbove {
            style.lineSoft.setFill()
            NSRect(x: 0, y: -style.px(12) - 1, width: bounds.width, height: 1).fill()
        }
        var x: CGFloat = 0
        if let header = headerText {
            let size = header.size()
            let chip = NSRect(x: 0, y: 0, width: ceil(size.width) + 2 * style.px(8), height: ceil(size.height) + 2)
            style.faded(style.tokens.accent, 0.14).setFill()
            NSBezierPath(roundedRect: chip, xRadius: chip.height / 2, yRadius: chip.height / 2).fill()
            header.draw(at: NSPoint(x: style.px(8), y: 1))
            x = chip.maxX
        }
        if let step = stepText {
            let size = step.size()
            step.draw(at: NSPoint(x: max(x + style.px(8), bounds.width - size.width), y: 1))
        }
    }
}

// MARK: - Elicitation

/// An elicitation's form: a control for each field, and under a field what is wrong with it once the person tried to accept.
@MainActor
final class ElicitationFormView: NSView {
    private var style: ConversationStyle
    private weak var card: RequestCardView?
    private var fields: [FormField] = []
    private var values: FormValues = [:]
    private var problems: [String: String] = [:]
    private var controls: [String: NSView] = [:]
    private var captions: [String: NSTextField] = [:]
    private var notes: [String: NSTextField] = [:]

    init(style: ConversationStyle, card: RequestCardView) {
        self.style = style
        self.card = card
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func update(_ fields: [FormField], style: ConversationStyle) {
        self.style = style
        guard fields != self.fields else { return }
        self.fields = fields
        values = initialValues(fields)
        for view in subviews { view.removeFromSuperview() }
        controls = [:]
        captions = [:]
        notes = [:]
        for field in fields {
            let label = field.required ? "\(field.label) *" : field.label
            switch field.input {
            case let .choice(multiple, options, _, _, _):
                let caption = NSTextField(labelWithString: label)
                caption.font = style.sans(style.em(0.78), bold: true)
                caption.textColor = style.ink(.secondary)
                addSubview(caption)
                captions[field.key] = caption
                let group = NSView()
                for option in options {
                    let row = OptionRowView(label: option.label, detail: "", multiple: multiple, style: style)
                    row.identifier = NSUserInterfaceItemIdentifier(option.value)
                    row.onToggle = { [weak self] in self?.toggle(field, option.value, multiple: multiple) }
                    group.addSubview(row)
                }
                addSubview(group)
                controls[field.key] = group
                refreshChoice(field)
            case .boolean:
                let check = NSButton(checkboxWithTitle: label, target: nil, action: nil)
                check.font = style.body
                check.state = values[field.key] == .one("true") ? .on : .off
                check.target = self
                check.action = #selector(checked(_:))
                check.identifier = NSUserInterfaceItemIdentifier(field.key)
                addSubview(check)
                controls[field.key] = check
            case .text, .number:
                let caption = NSTextField(labelWithString: label)
                caption.font = style.sans(style.em(0.78), bold: true)
                caption.textColor = style.ink(.secondary)
                addSubview(caption)
                captions[field.key] = caption
                let input = NSTextField(string: { if case .one(let text)? = values[field.key] { return text }; return "" }())
                input.font = style.sans(style.em(0.92))
                input.identifier = NSUserInterfaceItemIdentifier(field.key)
                input.target = self
                input.action = #selector(typed(_:))
                input.delegate = self
                addSubview(input)
                controls[field.key] = input
            }
            let note = NSTextField(wrappingLabelWithString: "")
            note.font = style.sans(style.em(0.85))
            addSubview(note)
            notes[field.key] = note
        }
        refreshNotes()
        needsLayout = true
    }

    private func toggle(_ field: FormField, _ value: String, multiple: Bool) {
        if multiple {
            var chosen = values[field.key]?.asList ?? []
            if let at = chosen.firstIndex(of: value) { chosen.remove(at: at) } else { chosen.append(value) }
            values[field.key] = .many(chosen)
        } else {
            values[field.key] = .one(value)
        }
        refreshChoice(field)
    }

    private func refreshChoice(_ field: FormField) {
        guard let group = controls[field.key] else { return }
        let chosen = values[field.key]?.asList ?? []
        for case let row as OptionRowView in group.subviews {
            row.picked = chosen.contains(row.identifier?.rawValue ?? "")
        }
    }

    @objc private func checked(_ sender: NSButton) {
        guard let key = sender.identifier?.rawValue else { return }
        values[key] = .one(sender.state == .on ? "true" : "false")
    }

    @objc private func typed(_ sender: NSTextField) {
        guard let key = sender.identifier?.rawValue else { return }
        values[key] = .one(sender.stringValue)
    }

    private func refreshNotes() {
        for field in fields {
            guard let note = notes[field.key] else { continue }
            if let problem = problems[field.key] {
                note.stringValue = problem
                note.textColor = style.ink(.danger)
            } else {
                note.stringValue = field.description ?? ""
                note.textColor = style.ink(.secondary)
            }
            note.isHidden = note.stringValue.isEmpty
            (controls[field.key] as? NSTextField)?.layer?.borderColor = problems[field.key] == nil ? style.line.cgColor : style.ink(.danger).cgColor
        }
    }

    /// The answer when the form can be accepted; else its problems are shown and nil.
    func answer() -> RequestAnswer? {
        for field in fields {
            if let input = controls[field.key] as? NSTextField { values[field.key] = .one(input.stringValue) }
        }
        do {
            let found = try formContent(fields, values).problems
            problems = found
            refreshNotes()
            needsLayout = true
            card?.formResized()
            guard found.isEmpty else { return nil }
            return .answers(values: fields.compactMap { field in values[field.key].map { (field.key, $0) } }, notes: nil)
        } catch {
            problems = ["": "\(error)"]
            return nil
        }
    }

    func height(forWidth width: CGFloat) -> CGFloat { arrange(width, apply: false) }

    @discardableResult
    private func arrange(_ width: CGFloat, apply: Bool) -> CGFloat {
        var y: CGFloat = 0
        for field in fields {
            y += style.px(8)
            if let caption = captions[field.key] {
                let height = ceil(style.em(0.78) * 1.5)
                if apply { caption.frame = NSRect(x: 0, y: y, width: width, height: height) }
                y += height + style.px(4)
            }
            if let group = controls[field.key], !(group is NSTextField), !(group is NSButton) {
                var rowsY: CGFloat = 0
                for row in group.subviews.compactMap({ $0 as? OptionRowView }) {
                    let height = row.height(forWidth: width)
                    if apply { row.frame = NSRect(x: 0, y: rowsY, width: width, height: height) }
                    rowsY += height + style.px(4)
                }
                if apply { group.frame = NSRect(x: 0, y: y, width: width, height: rowsY) }
                y += rowsY
            } else if let control = controls[field.key] {
                let height = max(control.intrinsicContentSize.height, ceil(style.em(0.92) * 1.6))
                if apply { control.frame = NSRect(x: 0, y: y, width: width, height: height) }
                y += height
            }
            if let note = notes[field.key], !note.isHidden {
                let height = ceil(note.attributedStringValue.boundingRect(with: NSSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).height)
                if apply { note.frame = NSRect(x: 0, y: y + 2, width: width, height: height + 2) }
                y += height + 4
            }
        }
        return y
    }

    override func layout() {
        super.layout()
        arrange(bounds.width, apply: true)
    }
}

extension ElicitationFormView: NSTextFieldDelegate {
    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextField, let key = field.identifier?.rawValue else { return }
        values[key] = .one(field.stringValue)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            card?.focusComposer()
            return true
        }
        if selector == #selector(NSResponder.insertNewline(_:)), NSApp.currentEvent.map(ComposerTextView.isSendKey) == true {
            card?.submitForm()
            return true
        }
        return false
    }
}
