// Port of apps/desktop/src/shell/components/shell/Picker.tsx's view and the
// `.picker*` / `.mac-list*` rules of shell/styles/macos.css: Open Quickly, for
// anything. A stack of bands — what is being asked, the search field, the list
// (or what stands in for it), the footer — with a hairline between every two,
// drawn by the stack and by no band.
//
// The rules are Core's (`PickerState`); this draws them and turns keys and
// clicks into its edits: typing filters, the arrows and Ctrl-N / Ctrl-P move,
// PageUp / PageDown jump eight, Return takes the row (Option: beside, Command:
// the other presentation), Escape cancels. Once a row is taken the sheet stops
// listening, and the spinner sits on the row that was taken.

import AppKit
import DevHubCore

/// The field: borderless, 17pt, the sheet's top band being the field.
@MainActor
final class PickerField: NSTextField {
    override var acceptsFirstResponder: Bool { true }
    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        // A starting value is a prefix to be typed on: the caret goes after it.
        if became, let editor = currentEditor() {
            editor.selectedRange = NSRange(location: (stringValue as NSString).length, length: 0)
        }
        return became
    }
}

/// The ranked rows, drawn.
@MainActor
final class PickerListView: NSView {
    weak var picker: PickerView?
    private var tracking: NSTrackingArea?
    private var lastPointer: NSPoint?
    private(set) var hover: Int?
    private(set) var rowFrames: [CGRect] = []
    let spinner = SpinnerView(frame: NSRect(x: 0, y: 0, width: 16, height: 16))

    override init(frame: NSRect) {
        super.init(frame: frame)
        spinner.isHidden = true
        addSubview(spinner)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    static let padding: CGFloat = Space.s2

    static func rowHeight(_ item: PickerItem) -> CGFloat {
        var height: CGFloat = 2 * Space.s1 + 16
        if item.detail != nil { height += 15 }
        if item.unavailable != nil { height += 15 }
        return max(30, height)
    }

    /// Lays the rows out from `top`; answers the bottom.
    func layoutRows(_ rows: [PickerItem], top: CGFloat, width: CGFloat) -> CGFloat {
        var y = top + Self.padding
        rowFrames = rows.map { item in
            let height = Self.rowHeight(item)
            defer { y += height + 1 }
            return CGRect(x: Self.padding, y: y, width: max(0, width - 2 * Self.padding), height: height)
        }
        if hover.map({ $0 >= rowFrames.count }) ?? false { hover = nil }
        return rows.isEmpty ? top : y - 1 + Self.padding
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(
            rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    private func row(at point: NSPoint) -> Int? {
        rowFrames.firstIndex { $0.contains(point) }
    }

    /// Whether the pointer really moved: rows re-filtering under a resting
    /// pointer put a new row under it without anyone pointing at anything.
    private func pointerMoved(_ event: NSEvent) -> Bool {
        let at = NSEvent.mouseLocation
        defer { lastPointer = at }
        guard let last = lastPointer else { return false }
        return last != at
    }

    override func mouseMoved(with event: NSEvent) {
        guard let picker, picker.state.taken == nil else { return }
        let moved = pointerMoved(event)
        let index = row(at: convert(event.locationInWindow, from: nil))
        if index != hover {
            hover = index
            needsDisplay = true
        }
        if moved, let index { picker.point(at: index) }
    }

    override func mouseExited(with event: NSEvent) {
        hover = nil
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) {
        guard let picker, let index = row(at: convert(event.locationInWindow, from: nil)) else {
            picker?.focusField()
            return
        }
        let flags = event.modifierFlags
        picker.click(index, split: flags.contains(.option), alternate: flags.contains(.command))
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let picker else { return }
        let tokens = picker.style.tokens
        let rows = picker.state.rows
        let active = picker.state.active
        let taken = picker.state.taken
        var spinnerFrame: CGRect?
        for (index, frame) in rowFrames.enumerated() where index < rows.count && frame.intersects(dirtyRect) {
            let item = rows[index]
            let selected = index == active
            let shape = NSBezierPath(roundedRect: frame, xRadius: 6, yRadius: 6)
            if selected {
                tokens.accent.nsColor.setFill()
                shape.fill()
            } else if hover == index, taken == nil {
                tokens.wash.nsColor.setFill()
                shape.fill()
            }
            let disabled = item.unavailable != nil
            let titleInk = selected ? tokens.accentInk.nsColor : (disabled ? tokens.secondary.nsColor : tokens.primary.nsColor)
            let captionInk = selected ? tokens.accentInk.faded(0.78) : tokens.secondary.nsColor
            var x = frame.minX + Space.s3
            if let glyph = item.glyph {
                PickerGlyphs.draw(glyph, in: CGRect(x: x, y: frame.midY - 7, width: 16, height: 14), color: selected ? tokens.accentInk.nsColor : tokens.accent.nsColor)
                x += 16 + Space.s2
            }
            var trailing = frame.maxX - Space.s3
            if taken == item.id {
                spinnerFrame = CGRect(x: trailing - 16, y: frame.midY - 8, width: 16, height: 16)
                trailing -= 16 + Space.s2
            }
            switch item.accessory {
            case let .text(normal, alternate)?:
                let label = Ink.text(picker.alternate ? alternate : normal, size: 11, color: captionInk)
                let width = Ink.width(label)
                label.draw(at: CGPoint(x: trailing - width, y: frame.midY - 7))
                trailing -= width + Space.s2
            case let .keys(keys)?:
                let widths = keys.map(Keycap.width)
                var kx = trailing - widths.reduce(0, +) - CGFloat(max(0, keys.count - 1)) * 4
                let left = kx
                for key in keys {
                    kx += Keycap.draw(key, at: CGPoint(x: kx, y: frame.midY - 8.5), tokens: tokens, ink: selected ? tokens.primary.nsColor : tokens.secondary.nsColor) + 4
                }
                trailing = left - Space.s2
            case nil:
                break
            }
            let textWidth = max(0, trailing - x)
            let lines = 1 + (item.detail == nil ? 0 : 1) + (item.unavailable == nil ? 0 : 1)
            var y = frame.midY - (16 + CGFloat(lines - 1) * 15) / 2
            Ink.drawLine(Ink.text(item.label, size: 13, color: titleInk), in: CGRect(x: x, y: y, width: textWidth, height: 17))
            y += 16
            switch item.detail {
            case let .text(text)?:
                Ink.drawLine(Ink.text(text, size: 11, color: captionInk), in: CGRect(x: x, y: y, width: textWidth, height: 15))
                y += 15
            case let .path(path, suffix)?:
                Ink.drawPath(path, suffix: suffix, font: ShellStyle.font(11), color: captionInk, in: CGRect(x: x, y: y, width: textWidth, height: 15))
                y += 15
            case nil:
                break
            }
            if let unavailable = item.unavailable {
                Ink.drawLine(Ink.text(unavailable, size: 11, color: captionInk), in: CGRect(x: x, y: y, width: textWidth, height: 15))
            }
        }
        if let spinnerFrame {
            spinner.color = tokens.accentInk.nsColor
            if spinner.frame != spinnerFrame { spinner.frame = spinnerFrame }
            spinner.isHidden = false
        } else {
            spinner.isHidden = true
        }
    }
}

/// One picker sheet.
@MainActor
final class PickerView: NSView, NSTextFieldDelegate, DisposableSheetContent, RestylableSheetContent {
    private(set) var state: PickerState
    private(set) var style: ShellStyle
    /// Whether Command is down, for the rows' accessories.
    private(set) var alternate = false
    /// Which question of several, drawn as "Step N".
    var step: Int? { didSet { relayout() } }

    /// A row was taken, or the sheet was cancelled.
    var onOutcome: ((PickerOutcome) -> Void)?
    /// What was typed, after a pause (the first at once).
    var onQueryChange: ((String) -> Void)?
    /// The row the person is on (a preview follows it).
    var onActiveChange: ((PickerItem?) -> Void)?
    /// How long a burst of keys waits before the source is asked.
    var queryDelay: TimeInterval = 0.15

    private let header = BandView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let stepLabel = NSTextField(labelWithString: "")
    private let questionLabel = WrappingLabel()
    private let search = BandView()
    private let magnifier = MagnifierView()
    let field = PickerField()
    private let searchSpinner = SpinnerView(frame: NSRect(x: 0, y: 0, width: 16, height: 16))
    private let toolbar: NSView?
    private let toolbarBand = BandView()
    private let body = BandView()
    private let scroll = NSScrollView()
    private let list = PickerListView()
    private let emptyLabel = WrappingLabel()
    private let aside: NSView?
    private let footer = BandView()
    private let noteLabel = WrappingLabel(selectable: true)
    private let detailsLabel = WrappingLabel(selectable: true)
    private var cancelButton: DevHubButton!
    private var seams: [CGRect] = []
    private var queryTimer: Timer?
    private var askedFirst = false
    private var lastActiveId: String?
    private var flagsMonitor: Any?

    init(prompt: PickerPrompt, style: ShellStyle, toolbar: NSView? = nil, aside: NSView? = nil) {
        state = PickerState(prompt)
        self.style = style
        self.toolbar = toolbar
        self.aside = aside
        step = prompt.step
        super.init(frame: NSRect(x: 0, y: 0, width: 560, height: 300))
        cancelButton = DevHubButton(title: "Cancel", isDefault: false, style: style) { [weak self] in self?.cancel() }
        cancelButton.refusesFirstResponder = true
        for label in [titleLabel, stepLabel] {
            label.lineBreakMode = .byTruncatingTail
            label.isSelectable = false
        }
        addSubview(header)
        header.addSubview(titleLabel)
        header.addSubview(stepLabel)
        header.addSubview(questionLabel)
        addSubview(search)
        search.addSubview(magnifier)
        search.addSubview(field)
        search.addSubview(searchSpinner)
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.isBezeled = false
        field.font = ShellStyle.font(17)
        field.delegate = self
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        field.stringValue = prompt.initialQuery
        field.setAccessibilityLabel(prompt.title)
        if let toolbar {
            addSubview(toolbarBand)
            toolbarBand.addSubview(toolbar)
        }
        addSubview(body)
        list.picker = self
        scroll.documentView = list
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.borderType = .noBorder
        body.addSubview(emptyLabel)
        body.addSubview(scroll)
        if let aside { body.addSubview(aside) }
        addSubview(footer)
        footer.addSubview(noteLabel)
        footer.addSubview(detailsLabel)
        footer.addSubview(cancelButton)
        setAccessibilityRole(.group)
        setAccessibilityLabel(prompt.title)
        restyle(style)
        flagsMonitor = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown, .keyUp]) { [weak self] event in
            nonisolated(unsafe) let incoming = event
            MainActor.assumeIsolated { self?.noteModifiers(incoming) }
            return event
        }
        NotificationCenter.default.addObserver(
            self, selector: #selector(windowResigned), name: NSWindow.didResignKeyNotification, object: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    /// Before the view goes: the monitor and the timer with it.
    func dispose() {
        if let flagsMonitor { NSEvent.removeMonitor(flagsMonitor) }
        flagsMonitor = nil
        queryTimer?.invalidate()
        queryTimer = nil
        NotificationCenter.default.removeObserver(self)
    }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    private func noteModifiers(_ event: NSEvent) {
        guard event.window === window else { return }
        let command = event.modifierFlags.contains(.command)
        if command != alternate {
            alternate = command
            list.needsDisplay = true
        }
    }

    @objc private func windowResigned(_ note: Notification) {
        guard (note.object as? NSWindow) === window, alternate else { return }
        alternate = false
        list.needsDisplay = true
    }

    func restyle(_ style: ShellStyle) {
        self.style = style
        cancelButton.style = style
        let tokens = style.tokens
        header.fill = tokens.chrome.nsColor
        footer.fill = tokens.chrome.nsColor
        search.fill = nil
        magnifier.ink = tokens.tertiary.nsColor
        searchSpinner.color = tokens.tertiary.nsColor
        field.textColor = tokens.primary.nsColor
        if let editor = field.currentEditor() as? NSTextView { editor.insertionPointColor = tokens.primary.nsColor }
        applyTexts()
        needsDisplay = true
        list.needsDisplay = true
    }

    private func applyTexts() {
        let tokens = style.tokens
        let prompt = state.prompt
        titleLabel.attributedStringValue = Ink.text(prompt.title, size: 13, weight: .semibold, color: tokens.primary.nsColor, breaking: .byTruncatingTail)
        stepLabel.attributedStringValue = Ink.text(step.map { "Step \($0)" } ?? "", size: 11, color: tokens.tertiary.nsColor)
        stepLabel.isHidden = step == nil
        questionLabel.attributedStringValue = Ink.text(prompt.question, size: 11, color: tokens.secondary.nsColor, lineHeight: 1.3)
        if let placeholder = prompt.placeholder {
            field.placeholderAttributedString = Ink.text(placeholder, size: 17, color: tokens.tertiary.nsColor)
        } else {
            field.placeholderAttributedString = nil
        }
        searchSpinner.isHidden = !prompt.busy
        let empty = state.emptyMessage ?? ""
        emptyLabel.attributedStringValue = Ink.text(
            empty, size: 11, color: tokens.secondary.nsColor, lineHeight: 1.3, alignment: state.rows.isEmpty ? .center : .natural)
        emptyLabel.isHidden = !state.showsEmpty
        let note = NSMutableAttributedString()
        if let text = prompt.note {
            if prompt.noteIsFailure {
                let parts = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
                note.append(Ink.text(parts[0], size: 11, color: tokens.danger.nsColor, lineHeight: 1.3))
                if parts.count > 1 { note.append(Ink.text("\n" + parts[1], size: 11, color: tokens.secondary.nsColor, lineHeight: 1.3)) }
            } else {
                note.append(Ink.text(text, size: 11, color: tokens.secondary.nsColor, lineHeight: 1.3))
            }
        }
        noteLabel.attributedStringValue = note
        noteLabel.isHidden = note.length == 0
        let facts = NSMutableAttributedString()
        for (index, fact) in prompt.details.enumerated() {
            let paragraph = NSMutableParagraphStyle()
            paragraph.tabStops = [NSTextTab(textAlignment: .right, location: 10_000)]
            let line = NSMutableAttributedString(string: (index == 0 ? "" : "\n") + fact.label, attributes: [
                .font: ShellStyle.font(11), .foregroundColor: tokens.secondary.nsColor,
            ])
            line.append(NSAttributedString(string: "  —  " + fact.value, attributes: [
                .font: ShellStyle.font(11), .foregroundColor: tokens.secondary.nsColor,
            ]))
            facts.append(line)
        }
        detailsLabel.attributedStringValue = facts
        detailsLabel.isHidden = facts.length == 0
        cancelButton.isHidden = !state.footerHasCancel
    }

    private var footerShown: Bool { state.prompt.note != nil || state.footerHasCancel || !state.prompt.details.isEmpty }

    // MARK: Layout

    private func headerHeight(_ width: CGFloat) -> CGFloat {
        Space.s3 + 17 + 2 + questionLabel.fittingHeight(width: width - 2 * Space.s4) + Space.s3
    }

    private let searchHeight: CGFloat = Space.s3 + 22 + Space.s3

    private func footerHeight(_ width: CGFloat) -> CGFloat {
        guard footerShown else { return 0 }
        var height = Space.s3
        var parts: [CGFloat] = []
        if !noteLabel.isHidden { parts.append(noteLabel.fittingHeight(width: width - 2 * Space.s4)) }
        if !detailsLabel.isHidden { parts.append(detailsLabel.fittingHeight(width: width - 2 * Space.s4)) }
        if state.footerHasCancel { parts.append(22) }
        height += parts.reduce(0, +) + CGFloat(max(0, parts.count - 1)) * Space.s2
        return height + Space.s3
    }

    private func emptyHeight(_ width: CGFloat) -> CGFloat {
        guard state.showsEmpty else { return 0 }
        let vertical = state.rows.isEmpty ? Space.s6 : Space.s3
        return 2 * vertical + emptyLabel.fittingHeight(width: width - 2 * Space.s4)
    }

    /// Whether the aside is drawn (a preview only once there is something to preview).
    var asideShown = true {
        didSet {
            aside?.isHidden = !asideShown
            relayoutCard()
        }
    }

    private var hasAside: Bool { aside != nil && asideShown }

    private var listWidthShare: CGFloat { hasAside ? 560.0 / 840.0 : 1 }

    /// The height this sheet wants at `width`, every row shown.
    func preferredHeight(width: CGFloat) -> CGFloat {
        let listWidth = floor(width * listWidthShare)
        let rows = state.rows
        let rowsHeight = rows.isEmpty ? 0 : 2 * PickerListView.padding + rows.map(PickerListView.rowHeight).reduce(0, +) + CGFloat(rows.count - 1)
        var bodyHeight = emptyHeight(listWidth) + rowsHeight
        if hasAside { bodyHeight = max(bodyHeight, 320) }
        let bands: [CGFloat] = [headerHeight(width), searchHeight, toolbar == nil ? 0 : toolbarHeight, bodyHeight, footerHeight(width)]
        let shown = bands.filter { $0 > 0 }
        return shown.reduce(0, +) + CGFloat(max(0, shown.count - 1))
    }

    private var toolbarHeight: CGFloat { Space.s2 + 24 + Space.s2 }

    override func layout() {
        super.layout()
        relayout()
    }

    private func relayout() {
        applyTexts()
        let width = bounds.width
        let inset = Space.s4
        var y: CGFloat = 0
        seams = []
        func seam() {
            seams.append(CGRect(x: 0, y: y, width: width, height: 1))
            y += 1
        }
        let headerH = headerHeight(width)
        header.frame = CGRect(x: 0, y: y, width: width, height: headerH)
        let stepWidth = step == nil ? 0 : ceil(stepLabel.attributedStringValue.size().width) + 2
        titleLabel.frame = CGRect(x: inset, y: Space.s3, width: max(0, width - 2 * inset - stepWidth - Space.s3), height: 17)
        stepLabel.frame = CGRect(x: width - inset - stepWidth, y: Space.s3 + 2, width: stepWidth, height: 14)
        questionLabel.frame = CGRect(x: inset, y: Space.s3 + 19, width: width - 2 * inset, height: questionLabel.fittingHeight(width: width - 2 * inset))
        y += headerH
        seam()
        search.frame = CGRect(x: 0, y: y, width: width, height: searchHeight)
        magnifier.frame = CGRect(x: inset, y: (searchHeight - 15) / 2, width: 15, height: 15)
        let spinnerRoom: CGFloat = searchSpinner.isHidden ? 0 : 16 + Space.s2
        field.frame = CGRect(x: inset + 15 + Space.s2, y: (searchHeight - 22) / 2, width: max(0, width - 2 * inset - 15 - Space.s2 - spinnerRoom), height: 22)
        searchSpinner.frame = CGRect(x: width - inset - 16, y: (searchHeight - 16) / 2, width: 16, height: 16)
        y += searchHeight
        if let toolbar {
            seam()
            toolbarBand.frame = CGRect(x: 0, y: y, width: width, height: toolbarHeight)
            toolbar.frame = CGRect(x: inset, y: Space.s2, width: width - 2 * inset, height: 24)
            y += toolbarHeight
        }
        seam()
        let footerH = footerHeight(width)
        let bodyHeight = max(0, bounds.height - y - (footerH > 0 ? footerH + 1 : 0))
        body.frame = CGRect(x: 0, y: y, width: width, height: bodyHeight)
        let listWidth = floor(width * listWidthShare)
        let emptyH = emptyHeight(listWidth)
        if state.showsEmpty {
            let vertical = state.rows.isEmpty ? Space.s6 : Space.s3
            emptyLabel.frame = CGRect(x: inset, y: vertical, width: listWidth - 2 * inset, height: emptyH - 2 * vertical)
        }
        scroll.frame = CGRect(x: 0, y: emptyH, width: listWidth, height: max(0, bodyHeight - emptyH))
        let contentBottom = list.layoutRows(state.rows, top: 0, width: listWidth)
        list.frame = CGRect(x: 0, y: 0, width: listWidth, height: max(contentBottom, scroll.contentSize.height))
        list.needsDisplay = true
        if let aside, asideShown {
            aside.frame = CGRect(x: listWidth + 1, y: 0, width: width - listWidth - 1, height: bodyHeight)
            seams.append(CGRect(x: listWidth, y: y, width: 1, height: bodyHeight))
        }
        y += bodyHeight
        footer.isHidden = footerH == 0
        if footerH > 0 {
            seam()
            footer.frame = CGRect(x: 0, y: y, width: width, height: footerH)
            var fy = Space.s3
            if !noteLabel.isHidden {
                let h = noteLabel.fittingHeight(width: width - 2 * inset)
                noteLabel.frame = CGRect(x: inset, y: fy, width: width - 2 * inset, height: h)
                fy += h + Space.s2
            }
            if !detailsLabel.isHidden {
                let h = detailsLabel.fittingHeight(width: width - 2 * inset)
                detailsLabel.frame = CGRect(x: inset, y: fy, width: width - 2 * inset, height: h)
                fy += h + Space.s2
            }
            let size = cancelButton.intrinsicContentSize
            cancelButton.frame = CGRect(x: width - inset - size.width, y: fy, width: size.width, height: 22)
        }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        style.tokens.lineSoft.nsColor.setFill()
        for seam in seams { seam.fill() }
    }

    // MARK: Edits

    /// The items changed under the person (a source answered).
    func update(_ prompt: PickerPrompt) {
        state.setPrompt(prompt)
        if step == nil { step = prompt.step }
        reportActive()
        relayoutCard()
    }

    /// The answer failed: listening resumes, the reason under the field.
    func release(failure: String?) {
        state.release()
        if let failure { state.setPrompt(state.prompt.failing(failure)) }
        relayoutCard()
        focusField()
    }

    /// The sheet's height follows its rows.
    func relayoutCard() {
        var ancestor = superview
        while let view = ancestor, !(view is SheetLayerView) { ancestor = view.superview }
        (ancestor as? SheetLayerView)?.layoutCards()
        needsLayout = true
        relayout()
    }

    func focusField() {
        guard let window, window.firstResponder !== field.currentEditor() else { return }
        window.makeFirstResponder(field)
    }

    private func reportActive() {
        let row = state.activeRow
        if row?.id != lastActiveId {
            lastActiveId = row?.id
            onActiveChange?(row)
        }
    }

    func point(at index: Int) {
        guard index != state.active else { return }
        state.point(at: index)
        list.needsDisplay = true
        reportActive()
    }

    func click(_ index: Int, split: Bool, alternate: Bool) {
        focusField()
        guard index < state.rows.count else { return }
        state.point(at: index)
        let id = state.rows[index].id
        choose(state.choose(id, split: split, alternate: alternate))
    }

    private func choose(_ outcome: PickerOutcome?) {
        list.needsDisplay = true
        reportActive()
        guard let outcome else { return }
        onOutcome?(outcome)
    }

    func cancel() {
        guard let outcome = state.escape() else { return }
        onOutcome?(outcome)
    }

    private func scrollToActive() {
        let frames = list.rowFrames
        guard state.active < frames.count else { return }
        list.scrollToVisible(frames[state.active].insetBy(dx: 0, dy: -PickerListView.padding))
    }

    private func moved(_ edit: (inout PickerState) -> Void) {
        edit(&state)
        list.needsDisplay = true
        scrollToActive()
        reportActive()
    }

    // MARK: The field

    func controlTextDidChange(_ notification: Notification) {
        guard state.taken == nil else {
            field.stringValue = state.query
            return
        }
        state.setQuery(field.stringValue)
        relayoutCard()
        list.scroll(.zero)
        reportActive()
        scheduleQuery()
    }

    /// The source is told what was typed after a pause; the first at once.
    func scheduleQuery() {
        guard let onQueryChange else { return }
        queryTimer?.invalidate()
        if !askedFirst {
            askedFirst = true
            onQueryChange(state.query)
            return
        }
        let query = state.query
        let timer = Timer(timeInterval: queryDelay, repeats: false) { _ in
            MainActor.assumeIsolated { onQueryChange(query) }
        }
        RunLoop.main.add(timer, forMode: .common)
        queryTimer = timer
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        // Answered: the keyboard is no longer this sheet's to act on —
        // Escape included, which would cancel a clone already running.
        if state.taken != nil {
            return [#selector(NSResponder.cancelOperation(_:)), #selector(NSResponder.insertNewline(_:)),
                    #selector(NSResponder.moveUp(_:)), #selector(NSResponder.moveDown(_:)),
                    #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:))].contains(selector)
        }
        let flags = NSApp.currentEvent?.modifierFlags ?? []
        switch selector {
        case #selector(NSResponder.moveDown(_:)):
            moved { $0.move(1) }
            return true
        case #selector(NSResponder.moveUp(_:)):
            moved { $0.move(-1) }
            return true
        case #selector(NSResponder.scrollPageDown(_:)), #selector(NSResponder.pageDown(_:)):
            moved { $0.page(1) }
            return true
        case #selector(NSResponder.scrollPageUp(_:)), #selector(NSResponder.pageUp(_:)):
            moved { $0.page(-1) }
            return true
        case #selector(NSResponder.insertNewline(_:)):
            choose(state.chooseActive(split: flags.contains(.option), alternate: flags.contains(.command)))
            return true
        case #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
            choose(state.chooseActive(split: true, alternate: flags.contains(.command)))
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            cancel()
            return true
        default:
            return false
        }
    }

    /// Command-Return is a key equivalent before it is a key.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.type == .keyDown, event.keyCode == 0x24 || event.keyCode == 0x4C, event.modifierFlags.contains(.command),
              let window, let responder = window.firstResponder as? NSView, responder === self || responder.isDescendant(of: self)
        else { return super.performKeyEquivalent(with: event) }
        if let editor = field.currentEditor() as? NSTextView, editor.hasMarkedText() { return true }
        if state.taken != nil { return true }
        choose(state.chooseActive(split: event.modifierFlags.contains(.option), alternate: true))
        return true
    }

    override func mouseDown(with event: NSEvent) {
        // A click inside the sheet acts; it does not move the keyboard.
        focusField()
    }
}

/// The search field's glyph.
@MainActor
final class MagnifierView: NSView {
    var ink: NSColor = .tertiaryLabelColor { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        let scale = bounds.width / 16
        let circle = NSBezierPath(ovalIn: CGRect(x: (7 - 4.2) * scale, y: (7 - 4.2) * scale, width: 8.4 * scale, height: 8.4 * scale))
        let handle = NSBezierPath()
        handle.move(to: CGPoint(x: 10.2 * scale, y: 10.2 * scale))
        handle.line(to: CGPoint(x: 13.4 * scale, y: 13.4 * scale))
        for path in [circle, handle] {
            path.lineWidth = 1.5
            path.lineCapStyle = .round
            ink.setStroke()
            path.stroke()
        }
    }
}
