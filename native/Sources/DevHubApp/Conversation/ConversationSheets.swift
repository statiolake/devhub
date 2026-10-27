// The sheets a GUI Agent's pane puts over itself: `/mcp` (McpPanel.tsx) and
// `/resume` (components/shell/SessionPicker.tsx, sessionRows.tsx). Each is a
// sheet over the pane dimmed, as DevHub's pickers are — the scrim, a heading
// and its question, a list and its aside, the footer's buttons — and covers
// this pane only: the Sidebar and every other Agent stay usable.

import AppKit
import DevHubCore

/// The scrim and the sheet on it.
@MainActor
class PaneSheet: NSView {
    var style: ConversationStyle
    let sheet = NSView()
    let titleLabel = NSTextField(labelWithString: "")
    let questionLabel = NSTextField(wrappingLabelWithString: "")
    var onCancel: (() -> Void)?
    var sheetSize = NSSize(width: 720, height: 460)

    init(title: String, question: String, style: ConversationStyle) {
        self.style = style
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.withAlphaComponent(style.dark ? 0.45 : 0.25).cgColor
        sheet.wantsLayer = true
        sheet.layer?.cornerRadius = 12
        sheet.layer?.borderWidth = 1
        sheet.layer?.backgroundColor = style.raised.cgColor
        sheet.layer?.borderColor = style.line.cgColor
        sheet.shadow = {
            let shadow = NSShadow()
            shadow.shadowBlurRadius = 24
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
            shadow.shadowOffset = NSSize(width: 0, height: -8)
            return shadow
        }()
        addSubview(sheet)
        titleLabel.stringValue = title
        titleLabel.font = ShellStyle.font(15, ShellStyle.semibold)
        titleLabel.textColor = style.ink(.primary)
        questionLabel.stringValue = question
        questionLabel.font = ShellStyle.font(12)
        questionLabel.textColor = style.ink(.secondary)
        sheet.addSubview(titleLabel)
        sheet.addSubview(questionLabel)
        setAccessibilityElement(true)
        setAccessibilityRole(.sheet)
        setAccessibilityLabel(title)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if !sheet.frame.contains(point) { onCancel?() }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onCancel?() } else { super.keyDown(with: event) }
    }

    override func cancelOperation(_ sender: Any?) { onCancel?() }

    /// The sheet's content rect, under its heading.
    var body: NSRect {
        NSRect(x: 20, y: 70, width: sheet.bounds.width - 40, height: sheet.bounds.height - 70 - 56)
    }

    var footer: NSRect { NSRect(x: 20, y: sheet.bounds.height - 48, width: sheet.bounds.width - 40, height: 32) }

    override func layout() {
        super.layout()
        let width = min(sheetSize.width, bounds.width - 40)
        let height = min(sheetSize.height, bounds.height - 40)
        sheet.frame = NSRect(x: (bounds.width - width) / 2, y: max(20, (bounds.height - height) / 3), width: width, height: height)
        titleLabel.frame = NSRect(x: 20, y: 18, width: width - 40, height: 20)
        questionLabel.frame = NSRect(x: 20, y: 40, width: width - 40, height: 28)
    }
}

/// A button as DevHub's sheets draw one.
@MainActor
func sheetButton(_ title: String, primary: Bool = false, target: AnyObject?, action: Selector) -> NSButton {
    let button = NSButton(title: title, target: target, action: action)
    button.bezelStyle = .rounded
    button.controlSize = .regular
    if primary { button.keyEquivalent = "\r" }
    return button
}

// MARK: - /mcp

@MainActor
final class McpPanelView: PaneSheet, NSTableViewDataSource, NSTableViewDelegate {
    private let agentId: String
    private let transport: ConversationTransport
    var onClose: (() -> Void)?
    var report: ((String) -> Void)?
    private var mcp = McpState(servers: nil, pluginErrors: [], working: [], failure: nil)
    private var signIn: McpSignIn?
    private var selected: String?
    private let table = NSTableView()
    private let tableScroll = NSScrollView()
    private let empty = NSTextField(labelWithString: "")
    private let detail = NSView()
    private let note = NSTextField(wrappingLabelWithString: "")
    private var close: NSButton!
    private let signInOutput = NSTextView()
    private let signInScroll = NSScrollView()
    private let signInField = NSTextField()

    init(label: String, style: ConversationStyle, agentId: String, transport: ConversationTransport) {
        self.agentId = agentId
        self.transport = transport
        super.init(title: "MCP Servers", question: McpWords.question(label), style: style)
        onCancel = { [weak self] in self?.onClose?() }
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("server"))
        table.addTableColumn(column)
        table.headerView = nil
        table.rowHeight = 36
        table.dataSource = self
        table.delegate = self
        table.style = .sourceList
        table.backgroundColor = .clear
        tableScroll.documentView = table
        tableScroll.hasVerticalScroller = true
        tableScroll.drawsBackground = false
        sheet.addSubview(tableScroll)
        empty.textColor = style.ink(.secondary)
        sheet.addSubview(empty)
        sheet.addSubview(detail)
        note.textColor = style.ink(.danger)
        note.font = ShellStyle.font(11)
        sheet.addSubview(note)
        close = sheetButton("Close", primary: true, target: self, action: #selector(closePressed))
        sheet.addSubview(close)
        signInOutput.isEditable = false
        signInOutput.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        signInOutput.drawsBackground = false
        signInOutput.isAutomaticLinkDetectionEnabled = true
        signInScroll.documentView = signInOutput
        signInScroll.hasVerticalScroller = true
        signInScroll.borderType = .bezelBorder
        signInField.placeholderString = "Paste the redirect URL here if the command asks for it"
        signInField.target = self
        signInField.action = #selector(sendSignIn)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func closePressed() { onClose?() }

    /// Asked as it opens: what the CLI said last may be a turn old.
    func start() {
        window?.makeFirstResponder(self)
        run { try await $0.command($1, .mcp(.refresh)) }
    }

    private func run(_ work: @escaping @MainActor (ConversationTransport, String) async throws -> Void) {
        let transport = self.transport, agentId = self.agentId
        Task { [weak self] in
            do { try await work(transport, agentId) } catch { self?.report?(failureText(error)) }
        }
    }

    func update(_ mcp: McpState, signIn: McpSignIn?) {
        self.mcp = mcp
        self.signIn = signIn
        if selected == nil { selected = signIn?.server }
        table.reloadData()
        if let servers = mcp.servers, let index = servers.firstIndex(where: { $0.name == current?.name }) {
            table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        }
        empty.stringValue = mcp.servers == nil ? "Asking the CLI…" : (mcp.servers!.isEmpty ? "No MCP servers are configured for this Agent." : "")
        empty.isHidden = empty.stringValue.isEmpty
        var notes: [String] = []
        if let failure = mcp.failure { notes.append(failure) }
        notes += mcp.pluginErrors.map { "Plugin \($0.plugin) did not load: \($0.message)" }
        note.stringValue = notes.joined(separator: "\n")
        renderDetail()
        needsLayout = true
    }

    private var current: McpServer? {
        mcp.servers?.first { $0.name == selected } ?? mcp.servers?.first
    }

    func numberOfRows(in tableView: NSTableView) -> Int { mcp.servers?.count ?? 0 }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard let server = mcp.servers?[row] else { return nil }
        let cell = NSTableCellView()
        let dot = StatusDot(status: server.status, style: style)
        let title = NSTextField(labelWithString: server.name)
        title.font = ShellStyle.font(13, ShellStyle.medium)
        let subtitle = NSTextField(labelWithString: McpWords.statusText(server) + (server.source.map { " · \($0)" } ?? ""))
        subtitle.font = ShellStyle.font(11)
        subtitle.textColor = .secondaryLabelColor
        for view in [dot, title, subtitle] {
            view.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(view)
        }
        NSLayoutConstraint.activate([
            dot.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
            dot.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 8), dot.heightAnchor.constraint(equalToConstant: 8),
            title.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 8),
            title.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -4),
            title.topAnchor.constraint(equalTo: cell.topAnchor, constant: 2),
            subtitle.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            subtitle.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -4),
            subtitle.topAnchor.constraint(equalTo: title.bottomAnchor),
        ])
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        let row = table.selectedRow
        guard row >= 0, let server = mcp.servers?[row] else { return }
        selected = server.name
        renderDetail()
    }

    private func renderDetail() {
        for view in detail.subviews { view.removeFromSuperview() }
        guard let server = current else { return }
        let working = mcp.working.contains { $0.server == server.name }
        let running = signIn?.phase == .running
        let elsewhere = running && signIn?.server != server.name ? signIn?.server : nil
        var y: CGFloat = 0
        func line(_ text: String, font: NSFont = ShellStyle.font(12), color: NSColor = .labelColor) {
            let label = NSTextField(wrappingLabelWithString: text)
            label.font = font
            label.textColor = color
            label.isSelectable = true
            let height = ceil(label.attributedStringValue.boundingRect(with: NSSize(width: detailWidth, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).height) + 2
            label.frame = NSRect(x: 0, y: y, width: detailWidth, height: height)
            detail.addSubview(label)
            y += height + 4
        }
        line(server.name, font: ShellStyle.font(14, ShellStyle.semibold))
        line("Status: \(McpWords.statusText(server))\(working ? " — working…" : "")", color: .secondaryLabelColor)
        line("Source: \(server.source ?? "Not reported")", color: .secondaryLabelColor)
        if let error = server.error { line("Reason: \(error)", color: style.ink(.danger)) }
        var x: CGFloat = 0
        for action in server.actions {
            let button = NSButton(title: McpWords.action(action), target: self, action: #selector(act(_:)))
            button.bezelStyle = .rounded
            button.identifier = NSUserInterfaceItemIdentifier(action.rawValue)
            button.isEnabled = !working && !(action == .signIn && (running || elsewhere != nil))
            button.sizeToFit()
            button.frame.origin = NSPoint(x: x, y: y)
            detail.addSubview(button)
            x += button.frame.width + 6
        }
        if !server.actions.isEmpty { y += 32 }
        if let elsewhere { line("Signing in to \(elsewhere): one sign-in runs at a time.", color: .secondaryLabelColor) }
        if let signIn, signIn.server == server.name {
            line(McpWords.signInTitle(signIn), font: ShellStyle.font(12, ShellStyle.semibold))
            signInOutput.string = signIn.output
            signInOutput.checkTextInDocument(nil)
            signInScroll.frame = NSRect(x: 0, y: y, width: detailWidth, height: 120)
            detail.addSubview(signInScroll)
            signInOutput.frame = NSRect(x: 0, y: 0, width: signInScroll.contentSize.width, height: max(120, signInOutput.frame.height))
            signInOutput.scrollToEndOfDocument(nil)
            y += 126
            if let callback = signIn.callback {
                if case .unforwarded = callback { line(McpWords.callback(callback), color: style.ink(.danger)) } else { line(McpWords.callback(callback), color: .secondaryLabelColor) }
            }
            if let failure = signIn.failure { line(failure, color: style.ink(.danger)) }
            if signIn.phase == .running {
                signInField.frame = NSRect(x: 0, y: y, width: detailWidth - 200, height: 22)
                detail.addSubview(signInField)
                let send = NSButton(title: "Send", target: self, action: #selector(sendSignIn))
                send.bezelStyle = .rounded
                send.frame = NSRect(x: detailWidth - 194, y: y - 2, width: 64, height: 26)
                detail.addSubview(send)
                let cancel = NSButton(title: "Cancel Sign-In", target: self, action: #selector(cancelSignIn))
                cancel.bezelStyle = .rounded
                cancel.frame = NSRect(x: detailWidth - 126, y: y - 2, width: 126, height: 26)
                detail.addSubview(cancel)
            } else {
                let dismiss = NSButton(title: "Dismiss", target: self, action: #selector(dismissSignIn))
                dismiss.bezelStyle = .rounded
                dismiss.sizeToFit()
                dismiss.frame.origin = NSPoint(x: 0, y: y)
                detail.addSubview(dismiss)
            }
        }
    }

    private var detailWidth: CGFloat { max(200, body.width * 0.58) }

    @objc private func act(_ sender: NSButton) {
        guard let server = current?.name, let raw = sender.identifier?.rawValue, let action = McpAction(rawValue: raw) else { return }
        if action == .signIn {
            run { try await $0.mcpSignIn($1, server: server) }
        } else {
            run { try await $0.command($1, .mcp(.act(action: action, server: server))) }
        }
    }

    @objc private func sendSignIn() {
        let typed = signInField.stringValue
        run { [weak self] transport, agent in
            try await transport.mcpSignInInput(agent, text: typed)
            if self?.signInField.stringValue == typed { self?.signInField.stringValue = "" }
        }
    }

    @objc private func cancelSignIn() { run { try await $0.mcpSignInCancel($1) } }
    @objc private func dismissSignIn() { run { try await $0.mcpSignInDismiss($1) } }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 125 || event.keyCode == 126, let servers = mcp.servers, !servers.isEmpty {
            let at = servers.firstIndex { $0.name == current?.name } ?? 0
            let next = (at + (event.keyCode == 125 ? 1 : -1) + servers.count) % servers.count
            selected = servers[next].name
            table.selectRowIndexes(IndexSet(integer: next), byExtendingSelection: false)
            renderDetail()
            return
        }
        super.keyDown(with: event)
    }

    override func layout() {
        super.layout()
        let body = self.body
        let listWidth = body.width - detailWidth - 16
        tableScroll.frame = NSRect(x: body.minX, y: body.minY, width: listWidth, height: body.height)
        empty.frame = NSRect(x: body.minX, y: body.minY + 8, width: listWidth, height: 20)
        detail.frame = NSRect(x: body.maxX - detailWidth, y: body.minY, width: detailWidth, height: body.height)
        detail.subviews.forEach { _ in }
        let footer = self.footer
        close.sizeToFit()
        close.frame.origin = NSPoint(x: footer.maxX - close.frame.width, y: footer.minY)
        note.frame = NSRect(x: footer.minX, y: footer.minY, width: footer.width - close.frame.width - 12, height: footer.height)
        renderDetail()
    }
}

/// An MCP server's status as a dot in the Sidebar's inks.
@MainActor
final class StatusDot: NSView {
    private let status: McpServerStatus
    private let style: ConversationStyle

    init(status: McpServerStatus, style: ConversationStyle) {
        self.status = status
        self.style = style
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func draw(_ dirtyRect: NSRect) {
        let ink: NSColor
        switch status {
        case .connected: ink = style.ink(.statusIdle)
        case .needsSignIn: ink = style.ink(.statusWaiting)
        case .failed: ink = style.ink(.statusError)
        case .connecting: ink = style.ink(.statusWorking)
        case .disabled, .unknown: ink = style.ink(.tertiary)
        }
        ink.setFill()
        NSBezierPath(ovalIn: bounds).fill()
    }
}

// MARK: - /resume

@MainActor
final class SessionPickerPanel: PaneSheet, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    private let cli: String
    private let list: (SessionScope) async throws -> [PastSession]
    private let previewRead: (String, String) async throws -> [PreviewLine]
    var onChoose: ((String) -> Void)?
    private var scope = SessionScope.here
    private var sessions: [PastSession]?
    private var refusal: String?
    private var filter = ""
    private var shownSessions: [PastSession] {
        let all = sessions ?? []
        guard !filter.isEmpty else { return all }
        let words = filter.lowercased()
        return all.filter { "\($0.title) \($0.branch ?? "") \($0.cwd ?? "")".lowercased().contains(words) }
    }
    private var previews: [String: Result<[PreviewLine], ImageRefusal>] = [:]
    private var previewTimer: Timer?
    private let search = NSSearchField()
    private let scopeControl = NSSegmentedControl(labels: ["This project", "All projects"], trackingMode: .selectOne, target: nil, action: nil)
    private let table = NSTableView()
    private let tableScroll = NSScrollView()
    private let preview = NSTextView()
    private let previewScroll = NSScrollView()
    private let empty = NSTextField(wrappingLabelWithString: "")
    private var choose: NSButton!
    private var cancel: NSButton!

    init(
        title: String, question: String, cli: String, style: ConversationStyle,
        list: @escaping (SessionScope) async throws -> [PastSession],
        preview: @escaping (String, String) async throws -> [PreviewLine]
    ) {
        self.cli = cli
        self.list = list
        previewRead = preview
        super.init(title: title, question: question, style: style)
        search.placeholderString = "Filter"
        search.delegate = self
        sheet.addSubview(search)
        scopeControl.selectedSegment = 0
        scopeControl.target = self
        scopeControl.action = #selector(scopeChanged)
        sheet.addSubview(scopeControl)
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("session"))
        table.addTableColumn(column)
        table.headerView = nil
        table.rowHeight = 38
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.doubleAction = #selector(choosePressed)
        tableScroll.documentView = table
        tableScroll.hasVerticalScroller = true
        sheet.addSubview(tableScroll)
        self.preview.isEditable = false
        self.preview.drawsBackground = false
        self.preview.textContainerInset = NSSize(width: 8, height: 8)
        previewScroll.documentView = self.preview
        previewScroll.hasVerticalScroller = true
        previewScroll.borderType = .bezelBorder
        sheet.addSubview(previewScroll)
        empty.textColor = .secondaryLabelColor
        sheet.addSubview(empty)
        choose = sheetButton("Resume", primary: true, target: self, action: #selector(choosePressed))
        cancel = sheetButton("Cancel", target: self, action: #selector(cancelPressed))
        cancel.keyEquivalent = "\u{1b}"
        sheet.addSubview(choose)
        sheet.addSubview(cancel)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    func start() {
        window?.makeFirstResponder(search)
        read()
    }

    @objc private func scopeChanged() {
        scope = scopeControl.selectedSegment == 1 ? .everywhere : .here
        read()
    }

    private func read() {
        sessions = nil
        refusal = nil
        render()
        let scope = self.scope
        Task { [weak self] in
            guard let self else { return }
            do {
                let listed = try await self.list(scope)
                guard self.scope == scope else { return }
                self.sessions = listed
            } catch {
                guard self.scope == scope else { return }
                self.sessions = []
                self.refusal = failureText(error)
            }
            self.render()
        }
    }

    private func render() {
        table.reloadData()
        let rows = shownSessions
        if !rows.isEmpty, table.selectedRow < 0 { table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false) }
        if sessions == nil {
            empty.stringValue = "Reading…"
        } else if rows.isEmpty {
            empty.stringValue = refusal.map { "The sessions could not be listed. \($0)" }
                ?? (!filter.isEmpty ? "No earlier session matches."
                    : scope == .here ? "This workspace has no earlier \(cli) sessions." : "There are no earlier \(cli) sessions on this machine.")
        } else {
            empty.stringValue = ""
        }
        empty.isHidden = empty.stringValue.isEmpty
        showPreview()
    }

    func controlTextDidChange(_ notification: Notification) {
        filter = search.stringValue.trimmingCharacters(in: .whitespaces)
        render()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.moveDown(_:)), #selector(NSResponder.moveUp(_:)):
            let count = shownSessions.count
            guard count > 0 else { return true }
            let step = selector == #selector(NSResponder.moveDown(_:)) ? 1 : -1
            let next = min(count - 1, max(0, table.selectedRow + step))
            table.selectRowIndexes(IndexSet(integer: next), byExtendingSelection: false)
            table.scrollRowToVisible(next)
            return true
        case #selector(NSResponder.insertNewline(_:)):
            choosePressed()
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            onCancel?()
            return true
        default:
            return false
        }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { shownSessions.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let rows = shownSessions
        guard row < rows.count else { return nil }
        let session = rows[row]
        let cell = NSTableCellView()
        let title = NSTextField(labelWithString: session.title)
        title.font = ShellStyle.font(13, ShellStyle.medium)
        title.lineBreakMode = .byTruncatingTail
        title.textColor = session.resumableHere ? .labelColor : .tertiaryLabelColor
        let detail = NSTextField(labelWithString: SheetRows.sessionDetail(session, now: Date().timeIntervalSince1970 * 1000, where: scope == .everywhere) ?? "")
        detail.font = ShellStyle.font(11)
        detail.textColor = .secondaryLabelColor
        detail.lineBreakMode = .byTruncatingTail
        if !session.resumableHere {
            cell.toolTip = "\(cli) goes on with it only in \(session.cwd ?? "the directory it ran in")."
        }
        for view in [title, detail] {
            view.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(view)
        }
        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
            title.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -6),
            title.topAnchor.constraint(equalTo: cell.topAnchor, constant: 3),
            detail.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            detail.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -6),
            detail.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 1),
        ])
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) { showPreview() }

    private var activeSession: PastSession? {
        let rows = shownSessions
        let row = table.selectedRow
        return row >= 0 && row < rows.count ? rows[row] : nil
    }

    /// The preview of the session the person is on: read after they rest on it, once per session.
    private func showPreview() {
        previewTimer?.invalidate()
        guard let session = activeSession else {
            preview.string = ""
            return
        }
        choose.isEnabled = session.resumableHere
        if let known = previews[session.id] {
            draw(known)
            return
        }
        guard let cwd = session.cwd else {
            draw(.failure(ImageRefusal(message: "\(cli) does not say where this session ran, so it cannot be previewed.")))
            return
        }
        preview.string = "Reading…"
        let id = session.id
        previewTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                Task {
                    do {
                        let lines = try await self.previewRead(id, cwd)
                        self.previews[id] = .success(lines)
                    } catch {
                        self.previews[id] = nil
                        if self.activeSession?.id == id { self.draw(.failure(ImageRefusal(message: failureText(error)))) }
                        return
                    }
                    if self.activeSession?.id == id, let known = self.previews[id] { self.draw(known) }
                }
            }
        }
    }

    private func draw(_ preview: Result<[PreviewLine], ImageRefusal>) {
        let out = NSMutableAttributedString()
        switch preview {
        case .success(let lines):
            for line in lines {
                out.append(NSAttributedString(string: line.role == .person ? "You\n" : "\(cli)\n", attributes: [
                    .font: ShellStyle.font(11, ShellStyle.semibold), .foregroundColor: NSColor.secondaryLabelColor,
                ]))
                out.append(NSAttributedString(string: line.text + "\n\n", attributes: [.font: ShellStyle.font(12), .foregroundColor: NSColor.labelColor]))
            }
            if lines.isEmpty { out.append(NSAttributedString(string: "Nothing to preview.", attributes: [.font: ShellStyle.font(12), .foregroundColor: NSColor.secondaryLabelColor])) }
        case .failure(let refusal):
            out.append(NSAttributedString(string: refusal.message, attributes: [.font: ShellStyle.font(12), .foregroundColor: style.ink(.danger)]))
        }
        self.preview.textStorage?.setAttributedString(out)
        self.preview.scrollToEndOfDocument(nil)
    }

    @objc private func choosePressed() {
        guard let session = activeSession, session.resumableHere else { return }
        onChoose?(session.id)
    }

    @objc private func cancelPressed() { onCancel?() }

    override func layout() {
        super.layout()
        let body = self.body
        search.frame = NSRect(x: body.minX, y: body.minY, width: body.width * 0.45, height: 24)
        scopeControl.sizeToFit()
        scopeControl.frame.origin = NSPoint(x: body.maxX - scopeControl.frame.width, y: body.minY)
        let listTop = body.minY + 32
        let listWidth = floor(body.width * 0.45)
        tableScroll.frame = NSRect(x: body.minX, y: listTop, width: listWidth, height: body.maxY - listTop)
        empty.frame = NSRect(x: body.minX + 8, y: listTop + 8, width: listWidth - 16, height: 40)
        previewScroll.frame = NSRect(x: body.minX + listWidth + 12, y: listTop, width: body.width - listWidth - 12, height: body.maxY - listTop)
        preview.frame.size.width = previewScroll.contentSize.width
        let footer = self.footer
        choose.sizeToFit()
        cancel.sizeToFit()
        choose.frame.origin = NSPoint(x: footer.maxX - choose.frame.width, y: footer.minY)
        cancel.frame.origin = NSPoint(x: choose.frame.minX - 8 - cancel.frame.width, y: footer.minY)
    }
}
