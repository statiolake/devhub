// The find bar (FindBar.tsx) and the subagents' panes (SubagentPanes.tsx).
//
// Cmd+F in a GUI Agent: a small bar at the top right of the conversation,
// like VS Code's find widget. It searches what is shown — the conversation,
// or the subagent filling the pane — and says which. Return and Shift+Return
// go to the next and the previous match; Esc closes it and gives the keyboard
// back to where it was.
//
// A subagent's own transcript, in a pane of its own: the column's beside the
// conversation when the pane is wide, or the whole view's when maximized.
// Every pane has one header: ← back when it fills the pane; a fold and
// Maximize when it is in the column. Its message box is under its transcript.

import AppKit
import DevHubCore

// MARK: - Find

@MainActor
final class FindBarView: NSView, NSTextFieldDelegate {
    var style: ConversationStyle { didSet { restyle() } }
    let field = NSTextField()
    private let countLabel = NSTextField(labelWithString: "")
    private let scopeLabel = NSTextField(labelWithString: "")
    private var caseButton: ConversationButton!
    private var previous: ConversationButton!
    private var next: ConversationButton!
    private var close: ConversationButton!
    var onQuery: ((String, Bool) -> Void)?
    var onStep: ((Int) -> Void)?
    var onClose: (() -> Void)?
    private(set) var caseSensitive = false
    var query: String { field.stringValue }
    var count = "" { didSet { countLabel.stringValue = count; superview?.needsLayout = true } }
    var none = false { didSet { countLabel.textColor = none ? style.ink(.danger) : style.ink(.secondary) } }
    var scope = "" { didSet { scopeLabel.stringValue = scope } }

    init(style: ConversationStyle) {
        self.style = style
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = CGFloat(DevHubTheme.Radius.control)
        layer?.borderWidth = 1
        shadow = {
            let shadow = NSShadow()
            shadow.shadowBlurRadius = 12
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.2)
            shadow.shadowOffset = NSSize(width: 0, height: -4)
            return shadow
        }()
        field.placeholderString = "Find"
        field.delegate = self
        field.focusRingType = .exterior
        field.setAccessibilityLabel("Find")
        addSubview(field)
        countLabel.alignment = .left
        addSubview(countLabel)
        scopeLabel.isSelectable = false
        addSubview(scopeLabel)
        caseButton = ConversationButton(label: "Aa", look: .bordered, size: 12, style: style) { [weak self] in
            guard let self else { return }
            self.caseSensitive.toggle()
            self.caseButton.isOn = self.caseSensitive
            self.caseButton.ink = self.caseSensitive ? self.style.ink(.primary) : nil
            self.onQuery?(self.query, self.caseSensitive)
        }
        caseButton.toolTip = "Match Case"
        previous = ConversationButton(label: "", icon: .arrowUp, look: .icon, size: 13, style: style) { [weak self] in self?.onStep?(-1) }
        previous.toolTip = "Previous Match (Shift+F3)"
        next = ConversationButton(label: "", icon: .arrowDown, look: .icon, size: 13, style: style) { [weak self] in self?.onStep?(1) }
        next.toolTip = "Next Match (F3)"
        close = ConversationButton(label: "", icon: .close, look: .icon, size: 13, style: style) { [weak self] in self?.onClose?() }
        close.toolTip = "Close (Esc)"
        for button in [caseButton!, previous!, next!, close!] { addSubview(button) }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Find in the conversation")
        restyle()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    private func restyle() {
        layer?.backgroundColor = style.raised.cgColor
        layer?.borderColor = style.lineStrong.cgColor
        let size = style.em(0.85)
        field.font = style.sans(size)
        countLabel.font = NSFont.monospacedDigitSystemFont(ofSize: size, weight: .regular)
        countLabel.textColor = none ? style.ink(.danger) : style.ink(.secondary)
        scopeLabel.font = style.sans(size * 0.9)
        scopeLabel.textColor = style.ink(.tertiary)
        for button in [caseButton, previous, next, close].compactMap({ $0 }) { button.style = style }
    }

    func focusField() {
        window?.makeFirstResponder(field)
        field.currentEditor()?.selectAll(nil)
    }

    func controlTextDidChange(_ notification: Notification) {
        let words = field.stringValue.replacingOccurrences(of: "\n", with: " ")
        onQuery?(words, caseSensitive)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if textView.hasMarkedText() { return false }
        switch selector {
        case #selector(NSResponder.insertNewline(_:)):
            onStep?(NSApp.currentEvent?.modifierFlags.contains(.shift) == true ? -1 : 1)
            return true
        case #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)), #selector(NSResponder.insertLineBreak(_:)):
            onStep?(-1)
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            onClose?()
            return true
        default:
            return false
        }
    }

    private var countWidth: CGFloat { max(style.em(0.85) * 5.5, ceil(countLabel.intrinsicContentSize.width) + 4) }

    override var fittingSize: NSSize { NSSize(width: style.em(0.85) * 16 + countWidth + 150, height: 52) }

    override func layout() {
        super.layout()
        let size = style.em(0.85)
        let rowHeight = ceil(size * 1.6) + 6
        var x: CGFloat = style.px(8)
        let fieldWidth = size * 16
        field.frame = NSRect(x: x, y: 4, width: fieldWidth, height: rowHeight)
        x += fieldWidth + 4
        countLabel.frame = NSRect(x: x, y: 4 + (rowHeight - countLabel.intrinsicContentSize.height) / 2, width: countWidth, height: countLabel.intrinsicContentSize.height)
        x += countWidth + 2
        for button in [caseButton!, previous!, next!, close!] {
            let side = rowHeight
            let width = button === caseButton ? max(side, button.intrinsicContentSize.width) : side
            button.frame = NSRect(x: x, y: 4, width: width, height: side)
            x += width + 2
        }
        scopeLabel.frame = NSRect(x: style.px(8), y: 4 + rowHeight + 1, width: bounds.width - 2 * style.px(8), height: scopeLabel.intrinsicContentSize.height)
    }
}

// MARK: - Subagents

/// A subagent's own transcript in a pane: the column's, or the whole view's.
@MainActor
final class SubagentPaneView: NSView {
    enum Place { case beside, maximized }

    private(set) var entryId: EntryId
    private var entry: ToolEntry
    let place: Place
    private var style: ConversationStyle
    private weak var pane: ConversationPaneView?
    let scroller: TranscriptScroller
    private let header = SubagentHeader()
    private var message: SubagentMessageView?
    var folded = false { didSet { scroller.isHidden = folded; message?.isHidden = folded; needsLayout = true } }
    var onFold: ((Bool) -> Void)?

    init(entry: ToolEntry, place: Place, style: ConversationStyle, pane: ConversationPaneView) {
        entryId = entry.id
        self.entry = entry
        self.place = place
        self.style = style
        self.pane = pane
        scroller = TranscriptScroller(style: style)
        super.init(frame: .zero)
        wantsLayer = true
        scroller.measured = place == .maximized
        scroller.text.owner = pane
        scroller.text.embeds.host = pane
        scroller.shown = true
        addSubview(header)
        addSubview(scroller)
        header.onBack = { [weak pane] in pane?.subagentHeaderAction(.maximize(nil)) }
        header.onMaximize = { [weak pane, id = entry.id] in pane?.subagentHeaderAction(.maximize(id)) }
        header.onFold = { [weak self] in
            guard let self else { return }
            self.onFold?(!self.folded)
        }
        header.place = place
        if entry.spawns?.takesMessages == true {
            let box = SubagentMessageView(style: style, host: pane)
            addSubview(box)
            message = box
        }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Subagent: \(entry.spawns?.label ?? "")")
        applyStyle(style)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func applyStyle(_ style: ConversationStyle) {
        self.style = style
        layer?.backgroundColor = style.surface.cgColor
        scroller.applyStyle(style)
        header.style = style
        if let spawns = entry.spawns { message?.update(.subagentMessage(entry: entry.id, label: spawns.label), style: style) }
    }

    func update(_ entry: ToolEntry, builder: EntryDocumentBuilder) {
        self.entry = entry
        header.update(entry, folded: folded)
        if let spawns = entry.spawns { message?.update(.subagentMessage(entry: entry.id, label: spawns.label), style: style) }
        if !folded { scroller.show(builder.paneSections(entry)) }
    }

    override func layout() {
        super.layout()
        let headerHeight = ceil(style.fontSize * 1.6) + style.px(8) * 2
        header.frame = NSRect(x: 0, y: 0, width: bounds.width, height: headerHeight)
        var bottom = bounds.height
        if let message, !folded {
            let gutter = place == .maximized ? max(CGFloat(SurfaceMetrics.gutterPx), (bounds.width - style.measure) / 2) : style.px(8)
            let height = message.height(forWidth: bounds.width - 2 * gutter)
            message.frame = NSRect(x: gutter, y: bounds.height - height - style.px(8), width: bounds.width - 2 * gutter, height: height)
            bottom = message.frame.minY - style.px(8)
        }
        scroller.frame = NSRect(x: 0, y: headerHeight, width: bounds.width, height: max(0, bottom - headerHeight))
    }

    override func draw(_ dirtyRect: NSRect) {
        style.lineSoft.setFill()
        let headerHeight = ceil(style.fontSize * 1.6) + style.px(8) * 2
        NSRect(x: 0, y: headerHeight - 1, width: bounds.width, height: 1).fill()
        if let message, !folded {
            NSRect(x: 0, y: message.frame.minY - style.px(8), width: bounds.width, height: 1).fill()
        }
    }
}

/// A pane's header: ← or the fold, the state, the name and model, the note, Maximize.
@MainActor
final class SubagentHeader: NSView {
    var style: ConversationStyle! { didSet { rebuild() } }
    var place: SubagentPaneView.Place = .beside { didSet { rebuild() } }
    var onBack: (() -> Void)?
    var onMaximize: (() -> Void)?
    var onFold: (() -> Void)?
    private var entry: ToolEntry?
    private var folded = false
    private var leading: ConversationButton?
    private var maximize: ConversationButton?

    override var isFlipped: Bool { true }

    func update(_ entry: ToolEntry, folded: Bool) {
        self.entry = entry
        self.folded = folded
        rebuild()
    }

    private func rebuild() {
        guard let style else { return }
        leading?.removeFromSuperview()
        maximize?.removeFromSuperview()
        let label = entry?.spawns?.label ?? ""
        if place == .maximized {
            let back = ConversationButton(label: "", icon: .arrowLeft, look: .icon, size: style.fontSize * 1.1, style: style) { [weak self] in self?.onBack?() }
            back.setAccessibilityLabel("Back to the conversation")
            back.toolTip = "Back to the conversation"
            leading = back
        } else {
            let fold = ConversationButton(label: "", icon: folded ? .chevronRight : .chevronDown, look: .icon, size: style.fontSize * 1.1, style: style) { [weak self] in self?.onFold?() }
            fold.setAccessibilityLabel("\(folded ? "Unfold" : "Fold") \(label)")
            fold.toolTip = folded ? "Unfold" : "Fold"
            leading = fold
            let max = ConversationButton(label: "", icon: .maximize, look: .icon, size: style.fontSize * 1.1, style: style) { [weak self] in self?.onMaximize?() }
            max.setAccessibilityLabel("Maximize \(label)")
            max.toolTip = "Fill the pane with this subagent"
            maximize = max
        }
        if let leading { addSubview(leading) }
        if let maximize { addSubview(maximize) }
        needsLayout = true
        needsDisplay = true
    }

    override func layout() {
        super.layout()
        let side = (style?.fontSize ?? 15) * 1.1 + 6
        leading?.frame = NSRect(x: (style?.px(8) ?? 8), y: (bounds.height - side) / 2, width: side, height: side)
        maximize?.frame = NSRect(x: bounds.width - side - (style?.px(8) ?? 8), y: (bounds.height - side) / 2, width: side, height: side)
    }

    override func mouseDown(with event: NSEvent) {
        if place == .beside { onFold?() }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let style, let entry, let spawns = entry.spawns else { return }
        let size = style.fontSize
        var x = style.px(8) + size * 1.1 + 6 + style.px(8)
        let mid = bounds.midY
        let state = workState(entry)
        let mark = InlineMarks.image(.status(state == .running ? .unknown : state), size: size * 0.9, color: style.ink(.tertiary), style: style).image
        if state == .running {
            let ring = NSRect(x: x + size * 0.1, y: mid - size * 0.35, width: size * 0.7, height: size * 0.7)
            let path = NSBezierPath(ovalIn: ring)
            path.lineWidth = 1.5
            style.tokens.statusWorking.faded(0.3).setStroke()
            path.stroke()
        } else {
            mark.draw(in: NSRect(x: x, y: mid - size * 0.45, width: size * 0.9, height: size * 0.9))
        }
        x += size + style.px(8)
        let name = NSAttributedString(string: spawns.label, attributes: [.font: style.sans(size, bold: true), .foregroundColor: style.ink(.primary)])
        name.draw(at: NSPoint(x: x, y: mid - name.size().height / 2))
        x += name.size().width + style.px(8)
        if let model = spawns.model, !model.isEmpty {
            let text = NSAttributedString(string: model, attributes: [.font: style.mono(size * 0.78), .foregroundColor: style.ink(.secondary)])
            let chip = NSRect(x: x, y: mid - text.size().height / 2 - 1, width: text.size().width + size, height: text.size().height + 2)
            style.wash.setFill()
            NSBezierPath(roundedRect: chip, xRadius: chip.height / 2, yRadius: chip.height / 2).fill()
            text.draw(at: NSPoint(x: x + size / 2, y: mid - text.size().height / 2))
            x = chip.maxX + style.px(8)
        }
        if let note = WorkStateWords.note(entry) {
            let ink: NSColor = spawns.state == .running ? style.ink(.statusWorking) : spawns.state == .failed ? style.ink(.danger) : style.ink(.tertiary)
            let text = NSAttributedString(string: note, attributes: [.font: style.sans(size * 0.85), .foregroundColor: ink])
            text.draw(at: NSPoint(x: x, y: mid - text.size().height / 2))
        }
    }
}

/// The column beside the conversation: one pane per listed subagent, stacked, with sashes.
@MainActor
final class SubagentColumnView: NSView {
    weak var pane: ConversationPaneView?
    private var style: ConversationStyle?
    private var panes: [SubagentPaneView] = []
    private var layoutState = SubagentLayout()
    private var edge = SashView(vertical: true)
    private var sashes: [SashView] = []
    private var heldWidth: CGFloat = 0
    private var heldHeights: [SubagentColumn.MeasuredPane] = []

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        isHidden = true
        addSubview(edge)
        edge.onBegin = { [weak self] in
            guard let self else { return }
            self.heldWidth = self.bounds.width
        }
        edge.onMove = { [weak self] delta in
            guard let self, let across = self.superview?.bounds.width else { return }
            // The sash is on the column's left: moving left widens it.
            self.pane?.columnChanged(self.layoutState.column.withWidth(Double(self.heldWidth - delta), across: Double(across)))
        }
        edge.onReset = { [weak self] in
            guard let self else { return }
            self.pane?.columnChanged(self.layoutState.column.withDefaultWidth())
        }
        edge.setAccessibilityLabel("Resize the subagent column")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    func applyStyle(_ style: ConversationStyle) {
        self.style = style
        for pane in panes { pane.applyStyle(style) }
        wantsLayer = true
        layer?.backgroundColor = style.surface.cgColor
        needsDisplay = true
    }

    func update(_ builder: EntryDocumentBuilder, _ layout: SubagentLayout, wide: Bool) {
        layoutState = layout
        let beside = layout.beside
        isHidden = beside.isEmpty
        guard let style, let owner = pane else { return }
        var kept: [EntryId: SubagentPaneView] = [:]
        for pane in panes { kept[pane.entryId] = pane }
        var next: [SubagentPaneView] = []
        for entry in beside {
            let view = kept.removeValue(forKey: entry.id) ?? SubagentPaneView(entry: entry, place: .beside, style: style, pane: owner)
            if view.superview !== self { addSubview(view) }
            view.folded = layout.column.folded.contains(entry.id)
            view.onFold = { [weak self] folded in
                guard let self else { return }
                self.pane?.columnChanged(self.layoutState.column.withFold(entry.id, folded))
            }
            view.update(entry, builder: builder)
            next.append(view)
        }
        for gone in kept.values { gone.removeFromSuperview() }
        panes = next
        let open = panes.map { !$0.folded }
        let wanted = SubagentColumn.sashes(open)
        for sash in sashes { sash.removeFromSuperview() }
        sashes = wanted.map { spec in
            let sash = SashView(vertical: false)
            sash.onBegin = { [weak self] in self?.holdHeights() }
            sash.onMove = { [weak self] delta in
                guard let self, let moved = try? self.layoutState.column.withSashMoved(self.heldHeights, above: spec.above, below: spec.below, delta: Double(delta)) else { return }
                self.pane?.columnChanged(moved)
            }
            sash.onReset = { [weak self] in
                guard let self else { return }
                self.pane?.columnChanged(self.layoutState.column.withEqualHeights())
            }
            sash.before = spec.before
            addSubview(sash)
            return sash
        }
        needsLayout = true
    }

    private func holdHeights() {
        heldHeights = panes.filter { !$0.folded }.map { SubagentColumn.MeasuredPane(id: $0.entryId, height: Double($0.frame.height)) }
    }

    func relayout(embed key: String) {
        for pane in panes { pane.scroller.text.relayout(embed: key) }
    }

    override func layout() {
        super.layout()
        guard let style else { return }
        layoutState.column = pane?.subagentLayout.column ?? layoutState.column
        edge.frame = NSRect(x: 0, y: 0, width: 5, height: bounds.height)
        let headerHeight = ceil(style.fontSize * 1.6) + style.px(8) * 2
        let foldedCount = panes.filter(\.folded).count
        let openPanes = panes.filter { !$0.folded }
        let spare = max(0, bounds.height - CGFloat(foldedCount) * headerHeight)
        let weights = openPanes.map { CGFloat(layoutState.column.weight(of: $0.entryId)) }
        let total = max(weights.reduce(0, +), 0.0001)
        var y: CGFloat = 0
        var openIndex = 0
        for (index, view) in panes.enumerated() {
            if let sash = sashes.first(where: { $0.before == index }) {
                sash.frame = NSRect(x: 1, y: y - 2, width: bounds.width - 1, height: 5)
            }
            let height: CGFloat
            if view.folded {
                height = headerHeight
            } else {
                height = max(CGFloat(SubagentColumn.minPane), spare * weights[openIndex] / total)
                openIndex += 1
            }
            view.frame = NSRect(x: 1, y: y, width: bounds.width - 1, height: height)
            y += height
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let style else { return }
        style.lineSoft.setFill()
        NSRect(x: 0, y: 0, width: 1, height: bounds.height).fill()
    }
}

/// A line the pointer drags, the arrow keys step and a double-click puts back.
@MainActor
final class SashView: NSView {
    let vertical: Bool
    var before = 0
    var onBegin: (() -> Void)?
    var onMove: ((CGFloat) -> Void)?
    var onReset: (() -> Void)?
    private var origin: CGFloat?

    init(vertical: Bool) {
        self.vertical = vertical
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.splitter)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var acceptsFirstResponder: Bool { true }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: vertical ? .resizeLeftRight : .resizeUpDown)
    }

    private func at(_ event: NSEvent) -> CGFloat {
        let point = superview?.convert(event.locationInWindow, from: nil) ?? event.locationInWindow
        return vertical ? point.x : point.y
    }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            onReset?()
            return
        }
        origin = at(event)
        onBegin?()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let origin else { return }
        onMove?(at(event) - origin)
    }

    override func mouseUp(with event: NSEvent) { origin = nil }

    override func keyDown(with event: NSEvent) {
        let step = CGFloat(SubagentColumn.sashStep)
        let back: UInt16 = vertical ? 123 : 126, forth: UInt16 = vertical ? 124 : 125
        if event.keyCode == back || event.keyCode == forth {
            onBegin?()
            onMove?(event.keyCode == back ? -step : step)
        } else {
            super.keyDown(with: event)
        }
    }
}
