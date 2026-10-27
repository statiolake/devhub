// Port of apps/desktop/src/settings/controls.tsx and Collection.tsx, with the
// `.sf-*` rules of settings.css: a form is one centred column (560pt at most);
// a group is an uppercase heading, a bordered box of rows and a note under it;
// a row is a right-aligned label in a 132pt column, the control, and its help.
// A text field applies on Return or when it is left, says why a value is
// refused under itself, and Escape puts it back; a collection is a list with
// its + and − under it, and the selected entry's form beside it.

import AppKit
import DevHubCore

/// Runs a closure for a control's action.
@MainActor
final class ControlAction: NSObject {
    private let run: (Any?) -> Void
    init(_ run: @escaping (Any?) -> Void) { self.run = run }
    @objc func fire(_ sender: Any?) { run(sender) }
}

/// What every settings view is built with.
@MainActor
final class SettingsKit {
    let style: ShellStyle
    /// Keeps the targets of the controls alive.
    private(set) var actions: [ControlAction] = []

    init(style: ShellStyle) { self.style = style }

    var tokens: DevHubTheme { style.tokens }

    func action(_ run: @escaping (Any?) -> Void) -> ControlAction {
        let action = ControlAction(run)
        actions.append(action)
        return action
    }

    static let labelWidth: CGFloat = 132
    static let columnWidth: CGFloat = 560
    static let listWidth: CGFloat = 224

    func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular, color: NSColor? = nil, selectable: Bool = false) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = ShellStyle.font(size, weight)
        field.textColor = color ?? tokens.primary.nsColor
        field.isSelectable = selectable
        field.translatesAutoresizingMaskIntoConstraints = false
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    func caption(_ text: String, color: NSColor? = nil) -> NSTextField {
        let field = label(text, size: 11, color: color ?? tokens.secondary.nsColor)
        return field
    }

    func vertical(_ views: [NSView], spacing: CGFloat, alignment: NSLayoutConstraint.Attribute = .leading) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = alignment
        stack.spacing = spacing
        stack.translatesAutoresizingMaskIntoConstraints = false
        return stack
    }

    func horizontal(_ views: [NSView], spacing: CGFloat = Space.s2) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = spacing
        stack.translatesAutoresizingMaskIntoConstraints = false
        return stack
    }

    func button(_ title: String, enabled: Bool = true, _ run: @escaping () -> Void) -> NSButton {
        let target = action { _ in run() }
        let button = NSButton(title: title, target: target, action: #selector(ControlAction.fire(_:)))
        button.bezelStyle = .rounded
        button.controlSize = .regular
        button.isEnabled = enabled
        button.translatesAutoresizingMaskIntoConstraints = false
        return button
    }

    func iconButton(_ symbol: String, label: String, enabled: Bool = true, _ run: @escaping () -> Void) -> NSButton {
        let target = action { _ in run() }
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label) ?? NSImage()
        let button = NSButton(image: image, target: target, action: #selector(ControlAction.fire(_:)))
        button.bezelStyle = .texturedRounded
        button.isBordered = false
        button.isEnabled = enabled
        button.setAccessibilityLabel(label)
        button.toolTip = label
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: 22).isActive = true
        return button
    }

    func toggle(_ label: String, checked: Bool, _ onChange: @escaping (Bool) -> Void) -> NSSwitch {
        let target = action { sender in onChange((sender as? NSSwitch)?.state == .on) }
        let control = NSSwitch()
        control.state = checked ? .on : .off
        control.target = target
        control.action = #selector(ControlAction.fire(_:))
        control.setAccessibilityLabel(label)
        control.translatesAutoresizingMaskIntoConstraints = false
        return control
    }

    func check(_ title: String, checked: Bool, _ onChange: @escaping (Bool) -> Void) -> NSButton {
        let target = action { sender in onChange((sender as? NSButton)?.state == .on) }
        let control = NSButton(checkboxWithTitle: title, target: target, action: #selector(ControlAction.fire(_:)))
        control.state = checked ? .on : .off
        control.translatesAutoresizingMaskIntoConstraints = false
        return control
    }

    func popup(_ label: String, value: String, options: [(String, String)], _ onChange: @escaping (String) -> Void) -> NSPopUpButton {
        let control = NSPopUpButton(frame: .zero, pullsDown: false)
        for (id, title) in options {
            control.addItem(withTitle: title)
            control.lastItem?.representedObject = id
        }
        if let index = options.firstIndex(where: { $0.0 == value }) { control.selectItem(at: index) }
        let target = action { sender in
            guard let id = (sender as? NSPopUpButton)?.selectedItem?.representedObject as? String, id != value else { return }
            onChange(id)
        }
        control.target = target
        control.action = #selector(ControlAction.fire(_:))
        control.setAccessibilityLabel(label)
        control.translatesAutoresizingMaskIntoConstraints = false
        return control
    }

    func mono(_ text: String) -> NSTextField {
        let field = label(text, size: 12, selectable: true)
        field.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        return field
    }

    // MARK: Layout pieces

    /// `Group`: heading, box, note.
    func group(_ heading: String?, note: String? = nil, _ rows: [NSView]) -> NSView {
        var parts: [NSView] = []
        if let heading {
            let title = label(heading.uppercased(), size: 11, weight: .semibold, color: tokens.secondary.nsColor)
            let inset = NSStackView(views: [title])
            inset.edgeInsets = NSEdgeInsets(top: 0, left: Space.s2, bottom: 0, right: Space.s2)
            inset.translatesAutoresizingMaskIntoConstraints = false
            parts.append(inset)
        }
        let box = BoxView(tokens: tokens)
        var previous: NSView?
        for (index, row) in rows.enumerated() {
            if index > 0 {
                let rule = BandView()
                rule.fill = tokens.lineSoft.nsColor
                rule.translatesAutoresizingMaskIntoConstraints = false
                box.addSubview(rule)
                NSLayoutConstraint.activate([
                    rule.heightAnchor.constraint(equalToConstant: 1),
                    rule.leadingAnchor.constraint(equalTo: box.leadingAnchor),
                    rule.trailingAnchor.constraint(equalTo: box.trailingAnchor),
                    rule.topAnchor.constraint(equalTo: previous!.bottomAnchor),
                ])
                previous = rule
            }
            row.translatesAutoresizingMaskIntoConstraints = false
            box.addSubview(row)
            NSLayoutConstraint.activate([
                row.leadingAnchor.constraint(equalTo: box.leadingAnchor),
                row.trailingAnchor.constraint(equalTo: box.trailingAnchor),
                row.topAnchor.constraint(equalTo: previous?.bottomAnchor ?? box.topAnchor),
            ])
            previous = row
        }
        if let previous { previous.bottomAnchor.constraint(equalTo: box.bottomAnchor).isActive = true }
        parts.append(box)
        if let note {
            let text = caption(note)
            let inset = NSStackView(views: [text])
            inset.edgeInsets = NSEdgeInsets(top: 0, left: Space.s2, bottom: 0, right: Space.s2)
            inset.translatesAutoresizingMaskIntoConstraints = false
            parts.append(inset)
        }
        let stack = vertical(parts, spacing: Space.s2, alignment: .leading)
        for part in parts { part.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        return stack
    }

    /// `Row`: label, control(s), help.
    func row(_ labelText: String?, help: String? = nil, helpView: NSView? = nil, _ controls: [NSView]) -> NSView {
        let row = NSView()
        row.translatesAutoresizingMaskIntoConstraints = false
        let name = label(labelText ?? "", color: tokens.primary.nsColor)
        name.alignment = .right
        name.maximumNumberOfLines = 1
        name.lineBreakMode = .byTruncatingTail
        row.addSubview(name)
        var lines: [NSView] = [horizontal(controls)]
        if let helpView { lines.append(helpView) }
        if let help { lines.append(caption(help)) }
        let value = vertical(lines, spacing: Space.s1)
        row.addSubview(value)
        NSLayoutConstraint.activate([
            name.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: Space.s3),
            name.widthAnchor.constraint(equalToConstant: Self.labelWidth),
            name.topAnchor.constraint(equalTo: row.topAnchor, constant: Space.s2 + 3),
            value.leadingAnchor.constraint(equalTo: name.trailingAnchor, constant: Space.s3),
            value.trailingAnchor.constraint(lessThanOrEqualTo: row.trailingAnchor, constant: -Space.s3),
            value.topAnchor.constraint(equalTo: row.topAnchor, constant: Space.s2),
            value.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -Space.s2),
            name.bottomAnchor.constraint(lessThanOrEqualTo: row.bottomAnchor, constant: -Space.s2),
        ])
        for line in lines {
            line.trailingAnchor.constraint(lessThanOrEqualTo: row.trailingAnchor, constant: -Space.s3).isActive = true
        }
        if let helpLabel = lines.last as? NSTextField, help != nil {
            helpLabel.preferredMaxLayoutWidth = 52 * 6
            helpLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 52 * 6.2).isActive = true
        }
        return row
    }

    /// `WideRow`: the control across the whole row.
    func wideRow(_ content: NSView) -> NSView {
        let row = NSView()
        row.translatesAutoresizingMaskIntoConstraints = false
        content.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: Space.s3),
            content.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -Space.s3),
            content.topAnchor.constraint(equalTo: row.topAnchor, constant: Space.s2),
            content.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -Space.s2),
        ])
        return row
    }

    func switchRow(_ label: String, help: String?, checked: Bool, _ onChange: @escaping (Bool) -> Void) -> NSView {
        row(label, help: help, [toggle(label, checked: checked, onChange)])
    }

    /// `Form`: the column, the reset link at its head.
    func form(reset: NSView?, _ groups: [NSView]) -> NSView {
        var parts = groups
        if let reset { parts.insert(reset, at: 0) }
        let column = vertical(parts, spacing: Space.s5, alignment: .leading)
        for part in parts where part !== reset { part.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true }
        if let reset { reset.trailingAnchor.constraint(equalTo: column.trailingAnchor).isActive = true }
        return column
    }
}

/// `.sf-box`: the bordered, surface-coloured box of a group.
@MainActor
final class BoxView: NSView {
    init(tokens: DevHubTheme) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.borderWidth = 1
        layer?.borderColor = tokens.line.cgColor
        layer?.backgroundColor = tokens.surface.cgColor
        layer?.masksToBounds = true
        translatesAutoresizingMaskIntoConstraints = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
}

/// A view in a scroll view that lays its document out top-down, centred, at
/// most `maxWidth` wide.
@MainActor
final class FormScrollView: NSScrollView {
    private let document = FlippedView()

    init(content: NSView, maxWidth: CGFloat, insets: NSEdgeInsets) {
        super.init(frame: .zero)
        drawsBackground = false
        hasVerticalScroller = true
        autohidesScrollers = true
        borderType = .noBorder
        translatesAutoresizingMaskIntoConstraints = false
        document.translatesAutoresizingMaskIntoConstraints = false
        documentView = document
        content.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(content)
        let clip = contentView
        let wide = content.widthAnchor.constraint(equalTo: document.widthAnchor, constant: -(insets.left + insets.right))
        wide.priority = .defaultHigh
        NSLayoutConstraint.activate([
            document.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            document.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            document.topAnchor.constraint(equalTo: clip.topAnchor),
            document.heightAnchor.constraint(greaterThanOrEqualTo: clip.heightAnchor),
            content.topAnchor.constraint(equalTo: document.topAnchor, constant: insets.top),
            content.bottomAnchor.constraint(lessThanOrEqualTo: document.bottomAnchor, constant: -insets.bottom),
            content.centerXAnchor.constraint(equalTo: document.centerXAnchor),
            content.widthAnchor.constraint(lessThanOrEqualToConstant: maxWidth),
            wide,
        ])
        let bottom = document.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: insets.bottom)
        bottom.priority = .defaultLow
        bottom.isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    var scrollY: CGFloat {
        get { contentView.bounds.origin.y }
        set {
            contentView.scroll(to: NSPoint(x: 0, y: newValue))
            reflectScrolledClipView(contentView)
        }
    }
}

@MainActor
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

// MARK: - A text field (`TextField`, `NumberField`)

@MainActor
final class SettingsTextField: NSView, NSTextFieldDelegate {
    let field = NSTextField()
    private let note: NSTextField
    private var value: String
    private let validate: ((String) -> String?)?
    private let onCommit: (String) -> Void
    private let onAbandon: (() -> Void)?
    private let tokens: DevHubTheme

    init(
        kit: SettingsKit, label: String, value: String, placeholder: String? = nil, mono: Bool = false, narrow: Bool = false,
        disabled: Bool = false, trailing: [NSView] = [], validate: ((String) -> String?)? = nil,
        onAbandon: (() -> Void)? = nil, onCommit: @escaping (String) -> Void
    ) {
        self.value = value
        self.validate = validate
        self.onCommit = onCommit
        self.onAbandon = onAbandon
        tokens = kit.tokens
        note = kit.caption("")
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        field.stringValue = value
        field.placeholderString = placeholder
        field.isEnabled = !disabled
        field.delegate = self
        field.isBezeled = true
        field.bezelStyle = .roundedBezel
        field.font = mono ? NSFont.monospacedSystemFont(ofSize: 12, weight: .regular) : ShellStyle.font(13)
        field.setAccessibilityLabel(label)
        field.lineBreakMode = .byTruncatingTail
        field.cell?.isScrollable = true
        field.translatesAutoresizingMaskIntoConstraints = false
        if narrow {
            field.widthAnchor.constraint(equalToConstant: 72).isActive = true
        } else {
            field.widthAnchor.constraint(greaterThanOrEqualToConstant: 200).isActive = true
        }
        let line = kit.horizontal([field] + trailing)
        note.isHidden = true
        let stack = kit.vertical([line, note], spacing: 3)
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        if !narrow { line.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    private var pending: String? { field.stringValue == value ? nil : field.stringValue }

    private func refreshNote() {
        if let pending, let problem = validate?(pending) {
            note.stringValue = problem
            note.textColor = tokens.danger.nsColor
            note.isHidden = false
        } else if pending != nil {
            note.stringValue = "Not applied yet — press Return."
            note.textColor = tokens.secondary.nsColor
            note.isHidden = false
        } else {
            note.isHidden = true
        }
    }

    func controlTextDidChange(_ notification: Notification) { refreshNote() }

    func controlTextDidEndEditing(_ notification: Notification) { commit() }

    private func commit() {
        guard let pending else {
            onAbandon?()
            return
        }
        if validate?(pending) != nil { return }
        value = pending
        refreshNote()
        onCommit(pending)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.insertNewline(_:)):
            commit()
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            // Escape puts the value back and lets go of the field; a second
            // Escape is the window's.
            field.stringValue = value
            refreshNote()
            onAbandon?()
            window?.makeFirstResponder(nil)
            return true
        default:
            return false
        }
    }

    func focus() { window?.makeFirstResponder(field) }
}

/// `TextArea`: monospaced, applied when it is left.
@MainActor
final class SettingsTextArea: NSView, NSTextViewDelegate {
    private let scroll = NSScrollView()
    let text = NSTextView()
    private var value: String
    private let onCommit: (String) -> Void
    private let placeholder: String?
    private let tokens: DevHubTheme

    init(kit: SettingsKit, label: String, value: String, placeholder: String?, onCommit: @escaping (String) -> Void) {
        self.value = value
        self.onCommit = onCommit
        self.placeholder = placeholder
        tokens = kit.tokens
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = text
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false
        text.isRichText = false
        text.allowsUndo = true
        text.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        text.isAutomaticQuoteSubstitutionEnabled = false
        text.isAutomaticDashSubstitutionEnabled = false
        text.isAutomaticSpellingCorrectionEnabled = false
        text.isVerticallyResizable = true
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        text.textContainerInset = NSSize(width: 4, height: 6)
        text.string = value
        text.delegate = self
        text.setAccessibilityLabel(label)
        text.backgroundColor = tokens.surface.nsColor
        text.textColor = tokens.primary.nsColor
        text.insertionPointColor = tokens.primary.nsColor
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            // `rows={8}`.
            scroll.heightAnchor.constraint(equalToConstant: 8 * 18 + 14),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
    }

    func textDidEndEditing(_ notification: Notification) {
        let next = text.string
        guard next != value else { return }
        value = next
        onCommit(next)
    }

    func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            text.string = value
            window?.makeFirstResponder(nil)
            return true
        }
        return false
    }
}

// MARK: - A list of values (`TokenList`)

@MainActor
final class TokenListView: NSView {
    private let kit: SettingsKit
    private var values: [String]
    private let label: String
    private let addLabel: String
    private let placeholder: String?
    private let validate: ((String) -> String?)?
    private let onChange: ([String]) -> Void
    private let stack: NSStackView
    private var adding = false

    init(
        kit: SettingsKit, label: String, addLabel: String, values: [String], placeholder: String?,
        validate: ((String) -> String?)?, onChange: @escaping ([String]) -> Void
    ) {
        self.kit = kit
        self.values = values
        self.label = label
        self.addLabel = addLabel
        self.placeholder = placeholder
        self.validate = validate
        self.onChange = onChange
        stack = kit.vertical([], spacing: Space.s1)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityLabel(label)
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        build()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    private func change(_ next: [String]) {
        values = next
        build()
        onChange(next)
    }

    private func build() {
        for view in stack.arrangedSubviews {
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for (index, value) in values.enumerated() {
            let field = SettingsTextField(
                kit: kit, label: "\(label) \(index + 1)", value: value, placeholder: placeholder, mono: true, validate: validate
            ) { [weak self] next in
                guard let self else { return }
                var copy = self.values
                copy[index] = next
                self.values = copy
                self.onChange(copy)
            }
            let up = kit.iconButton("chevron.up", label: "Move \(label) \(index + 1) up", enabled: index > 0) { [weak self] in
                guard let self else { return }
                var copy = self.values
                copy.swapAt(index - 1, index)
                self.change(copy)
            }
            let remove = kit.iconButton("minus", label: "Remove \(label) \(index + 1)") { [weak self] in
                guard let self else { return }
                var copy = self.values
                copy.remove(at: index)
                self.change(copy)
            }
            let line = kit.horizontal([field, up, remove], spacing: Space.s1)
            stack.addArrangedSubview(line)
            line.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        if values.isEmpty && !adding { stack.addArrangedSubview(kit.caption("None.")) }
        if adding {
            let field = SettingsTextField(
                kit: kit, label: "New \(label.lowercased())", value: "", placeholder: placeholder, mono: true, validate: validate,
                onAbandon: { [weak self] in
                    guard let self, self.adding else { return }
                    self.adding = false
                    DispatchQueue.main.async { [weak self] in self?.build() }
                }
            ) { [weak self] next in
                guard let self else { return }
                self.adding = false
                self.change(self.values + [next])
            }
            stack.addArrangedSubview(field)
            field.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48).isActive = true
            DispatchQueue.main.async { field.focus() }
        } else {
            let add = kit.button(addLabel) { [weak self] in
                self?.adding = true
                self?.build()
            }
            add.bezelStyle = .inline
            add.isBordered = false
            add.contentTintColor = kit.tokens.accent.nsColor
            stack.addArrangedSubview(add)
        }
    }
}

// MARK: - A collection (`Collection.tsx`)

/// One entry in a collection's list.
struct CollectionEntry {
    var title: String
    var note: String
    var symbol: String
    /// The heading this entry is listed under (an action's trigger).
    var group: String?
}

@MainActor
final class CollectionView: NSView {
    private let kit: SettingsKit
    private let entries: [CollectionEntry]
    private let selected: Int?
    private let onSelect: (Int) -> Void

    init(
        kit: SettingsKit, label: String, entries: [CollectionEntry], selected: Int?, onSelect: @escaping (Int) -> Void,
        addLabel: String, onAdd: @escaping () -> Void, removeLabel: String, onRemove: @escaping () -> Void,
        onMove: ((Int) -> Void)? = nil, reset: NSView?, empty: (title: String, message: String), detail: NSView?
    ) {
        self.kit = kit
        self.entries = entries
        self.selected = selected
        self.onSelect = onSelect
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let tokens = kit.tokens

        // The list pane.
        let pane = BandView()
        pane.fill = tokens.chrome.nsColor
        pane.translatesAutoresizingMaskIntoConstraints = false
        let rows = kit.vertical([], spacing: 1, alignment: .leading)
        var lastGroup: String?
        for (index, entry) in entries.enumerated() {
            if let group = entry.group, group != lastGroup {
                lastGroup = group
                let heading = kit.label(group.uppercased(), size: 11, weight: .semibold, color: tokens.secondary.nsColor)
                let inset = NSStackView(views: [heading])
                inset.edgeInsets = NSEdgeInsets(top: Space.s2, left: Space.s2, bottom: Space.s1, right: Space.s2)
                rows.addArrangedSubview(inset)
            }
            let row = CollectionRowView(entry: entry, selected: index == selected, tokens: tokens) { [weak self] in self?.onSelect(index) }
            rows.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
        }
        rows.edgeInsets = NSEdgeInsets(top: Space.s2, left: Space.s2, bottom: Space.s2, right: Space.s2)
        let list = FormScrollView(content: rows, maxWidth: SettingsKit.listWidth, insets: NSEdgeInsets())
        list.setAccessibilityLabel(label)
        pane.addSubview(list)
        // `+` and `−` (and the arrows), joined, under the list.
        var buttons: [NSView] = [
            kit.iconButton("plus", label: addLabel, onAdd),
            kit.iconButton("minus", label: removeLabel, enabled: selected != nil, onRemove),
        ]
        if let onMove {
            let canUp = selected.map { $0 > 0 && entries[$0 - 1].group == entries[$0].group } ?? false
            let canDown = selected.map { $0 + 1 < entries.count && entries[$0 + 1].group == entries[$0].group } ?? false
            buttons.append(kit.iconButton("chevron.up", label: "Move Up", enabled: canUp) { onMove(-1) })
            buttons.append(kit.iconButton("chevron.down", label: "Move Down", enabled: canDown) { onMove(1) })
        }
        let bar = kit.horizontal(buttons, spacing: 0)
        let barBand = BandView()
        barBand.translatesAutoresizingMaskIntoConstraints = false
        barBand.addSubview(bar)
        let barRule = BandView()
        barRule.fill = tokens.line.nsColor
        barRule.translatesAutoresizingMaskIntoConstraints = false
        pane.addSubview(barRule)
        pane.addSubview(barBand)
        let paneRule = BandView()
        paneRule.fill = tokens.line.nsColor
        paneRule.translatesAutoresizingMaskIntoConstraints = false
        addSubview(pane)
        addSubview(paneRule)

        // The detail.
        let detailView: NSView
        if let detail {
            detailView = FormScrollView(
                content: kit.form(reset: reset, [detail]), maxWidth: 520,
                insets: NSEdgeInsets(top: Space.s5, left: Space.s6, bottom: Space.s8, right: Space.s6))
        } else {
            let state = SurfaceStateView(style: kit.style)
            state.paintsSurface = false
            state.show(.empty(title: empty.title, message: empty.message, actions: [SurfaceAction(label: addLabel, primary: true, run: onAdd)]))
            state.translatesAutoresizingMaskIntoConstraints = false
            detailView = state
        }
        addSubview(detailView)
        NSLayoutConstraint.activate([
            pane.leadingAnchor.constraint(equalTo: leadingAnchor),
            pane.topAnchor.constraint(equalTo: topAnchor),
            pane.bottomAnchor.constraint(equalTo: bottomAnchor),
            pane.widthAnchor.constraint(equalToConstant: SettingsKit.listWidth),
            paneRule.leadingAnchor.constraint(equalTo: pane.trailingAnchor),
            paneRule.topAnchor.constraint(equalTo: topAnchor),
            paneRule.bottomAnchor.constraint(equalTo: bottomAnchor),
            paneRule.widthAnchor.constraint(equalToConstant: 1),
            list.leadingAnchor.constraint(equalTo: pane.leadingAnchor),
            list.trailingAnchor.constraint(equalTo: pane.trailingAnchor),
            list.topAnchor.constraint(equalTo: pane.topAnchor),
            barRule.topAnchor.constraint(equalTo: list.bottomAnchor),
            barRule.leadingAnchor.constraint(equalTo: pane.leadingAnchor),
            barRule.trailingAnchor.constraint(equalTo: pane.trailingAnchor),
            barRule.heightAnchor.constraint(equalToConstant: 1),
            barBand.topAnchor.constraint(equalTo: barRule.bottomAnchor),
            barBand.leadingAnchor.constraint(equalTo: pane.leadingAnchor),
            barBand.trailingAnchor.constraint(equalTo: pane.trailingAnchor),
            barBand.bottomAnchor.constraint(equalTo: pane.bottomAnchor),
            barBand.heightAnchor.constraint(equalToConstant: 28),
            bar.leadingAnchor.constraint(equalTo: barBand.leadingAnchor, constant: Space.s1),
            bar.centerYAnchor.constraint(equalTo: barBand.centerYAnchor),
            detailView.leadingAnchor.constraint(equalTo: paneRule.trailingAnchor),
            detailView.trailingAnchor.constraint(equalTo: trailingAnchor),
            detailView.topAnchor.constraint(equalTo: topAnchor),
            detailView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        if detail == nil, let reset {
            addSubview(reset)
            reset.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                reset.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Space.s6),
                reset.topAnchor.constraint(equalTo: topAnchor, constant: Space.s5),
            ])
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var acceptsFirstResponder: Bool { true }

    /// The arrows move the selection, as in a source list.
    override func keyDown(with event: NSEvent) {
        guard !entries.isEmpty else { return super.keyDown(with: event) }
        let at = selected ?? 0
        switch event.keyCode {
        case 0x7D: onSelect(min(entries.count - 1, at + 1))
        case 0x7E: onSelect(max(0, at - 1))
        default: super.keyDown(with: event)
        }
    }
}

@MainActor
final class CollectionRowView: NSView {
    private let entry: CollectionEntry
    private let selected: Bool
    private let tokens: DevHubTheme
    private let onClick: () -> Void
    private var hovering = false
    private var tracking: NSTrackingArea?

    init(entry: CollectionEntry, selected: Bool, tokens: DevHubTheme, onClick: @escaping () -> Void) {
        self.entry = entry
        self.selected = selected
        self.tokens = tokens
        self.onClick = onClick
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 38).isActive = true
        setAccessibilityRole(.button)
        setAccessibilityLabel(entry.title)
        setAccessibilitySelected(selected)
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

    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }
    override func mouseDown(with event: NSEvent) {
        var ancestor = superview
        while let view = ancestor, !(view is CollectionView) { ancestor = view.superview }
        if let ancestor { window?.makeFirstResponder(ancestor) }
        onClick()
    }

    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6)
        if selected {
            tokens.accent.nsColor.setFill()
            shape.fill()
        } else if hovering {
            tokens.wash.nsColor.setFill()
            shape.fill()
        }
        let ink = selected ? tokens.accentInk.nsColor : tokens.primary.nsColor
        let caption = selected ? tokens.accentInk.faded(0.78) : tokens.secondary.nsColor
        let configuration = NSImage.SymbolConfiguration(pointSize: 12, weight: .regular)
            .applying(NSImage.SymbolConfiguration(paletteColors: [selected ? tokens.accentInk.nsColor : tokens.accent.nsColor]))
        if let image = NSImage(systemSymbolName: entry.symbol, accessibilityDescription: nil)?.withSymbolConfiguration(configuration) {
            let size = image.size
            image.draw(
                in: CGRect(x: Space.s2 + (16 - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height),
                from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        }
        let x = Space.s2 + 16 + Space.s2
        let width = max(0, bounds.width - x - Space.s2)
        Ink.drawLine(Ink.text(entry.title, size: 13, color: ink), in: CGRect(x: x, y: 3, width: width, height: 17))
        Ink.drawLine(Ink.text(entry.note, size: 11, color: caption), in: CGRect(x: x, y: 20, width: width, height: 15))
    }
}

/// `ResetLink`: "Reset to defaults", which asks first.
@MainActor
func resetLink(_ kit: SettingsKit, what: String, _ onReset: @escaping () -> Void) -> NSView {
    let link = kit.button("Reset to defaults", onReset)
    link.bezelStyle = .inline
    link.isBordered = false
    link.contentTintColor = kit.tokens.accent.nsColor
    link.font = ShellStyle.font(12)
    link.setAccessibilityLabel("Reset \(what) to defaults")
    return link
}
