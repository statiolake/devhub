// The sheet a GUI Agent's pane puts over itself: `/mcp` (McpPanel.tsx), a
// sheet over the pane dimmed, as DevHub's pickers are (`PaneSheetFrame`),
// covering this pane only: the Sidebar and every other Agent stay usable.
// `/resume` is not here: it is the questions layer's one session picker
// (`SheetFlows.sessionPicker`), asked through
// `ModalPresenting.presentSessionPicker`.

import AppKit
import DevHubCore

// MARK: - /mcp

/// `/mcp` (McpPanel.tsx): every MCP server the Agent's CLI reports, how it
/// stands and where it is configured, and what can be done about it, as a
/// picker's sheet over the pane — the servers as list rows, the one the person
/// is on in the aside with its actions and a sign-in's output. Not a picker:
/// it stays up while its actions run, and its aside takes typing. ↑ ↓ move
/// between servers (not while typing in the sign-in's field); Escape, a click
/// on the scrim or Close put it away.
@MainActor
final class McpPanelView: PaneSheetFrame {
    private let agentId: String
    private let transport: ConversationTransport
    private let conversation: ConversationStyle
    var onClose: (() -> Void)?
    var report: ((String) -> Void)?
    private var mcp = McpState(servers: nil, pluginErrors: [], working: [], failure: nil)
    private var signIn: McpSignIn?
    private var selected: String?
    private let list = McpServerList()
    private let empty = WrappingLabel()
    private let aside = BandView()
    private let signInOutput = NSTextView()
    private let signInScroll = NSScrollView()
    private let signInField = NSTextField()
    private var asideHeight: CGFloat = 0
    /// The aside's width its contents were laid out for.
    private var renderedAsideWidth: CGFloat = 0

    init(label: String, style: ConversationStyle, agentId: String, transport: ConversationTransport) {
        self.agentId = agentId
        self.transport = transport
        conversation = style
        super.init(style: style.shell, placement: .top, width: 840)
        setHeading(title: "MCP Servers", question: McpWords.question(label))
        setButtons([(title: "Close", isDefault: false, enabled: true, run: { [weak self] in self?.onClose?() })])
        onCancel = { [weak self] in self?.onClose?() }
        list.panel = self
        body.addSubview(empty)
        body.addSubview(list)
        body.addSubview(aside)
        list.setAccessibilityLabel("MCP servers")
        signInOutput.isEditable = false
        signInOutput.isSelectable = true
        signInOutput.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        signInOutput.drawsBackground = false
        signInOutput.isAutomaticLinkDetectionEnabled = true
        signInOutput.textContainerInset = .zero
        signInScroll.documentView = signInOutput
        signInScroll.hasVerticalScroller = true
        signInScroll.autohidesScrollers = true
        signInScroll.drawsBackground = false
        signInScroll.borderType = .noBorder
        signInField.placeholderString = "Paste the redirect URL here if the command asks for it"
        signInField.setAccessibilityLabel("Type at the sign-in's prompt")
        signInField.bezelStyle = .roundedBezel
        signInField.font = ShellStyle.font(12)
        signInField.target = self
        signInField.action = #selector(sendSignIn)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

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
        let tokens = style.tokens
        let words = mcp.servers == nil ? "Asking the CLI…" : (mcp.servers!.isEmpty ? "No MCP servers are configured for this Agent." : "")
        empty.attributedStringValue = Ink.text(words, size: 11, color: tokens.secondary.nsColor, lineHeight: 1.3, alignment: .center)
        empty.isHidden = words.isEmpty
        var notes: [(text: String, failure: Bool)] = []
        if let failure = mcp.failure { notes.append((failure, true)) }
        notes += mcp.pluginErrors.map { ("Plugin \($0.plugin) did not load: \($0.message)", true) }
        setNote(notes)
        list.update(servers: mcp.servers ?? [], current: current?.name, style: style)
        renderAside()
        needsLayout = true
    }

    fileprivate var current: McpServer? {
        mcp.servers?.first { $0.name == selected } ?? mcp.servers?.first
    }

    fileprivate func select(_ name: String) {
        selected = name
        list.update(servers: mcp.servers ?? [], current: current?.name, style: style)
        renderAside()
        needsLayout = true
    }

    // MARK: The aside (`ServerDetail`, `SignInView`)

    private var asideWidth: CGFloat { max(200, body.bounds.width - floor(body.bounds.width * 560 / 840) - 1) }

    private func renderAside() {
        for view in aside.subviews { view.removeFromSuperview() }
        asideHeight = 0
        guard let server = current else { return }
        let tokens = style.tokens
        let width = asideWidth - 2 * Space.s4
        let working = mcp.working.contains { $0.server == server.name }
        let running = signIn?.phase == .running
        let elsewhere = running && signIn?.server != server.name ? signIn?.server : nil
        var y = Space.s3
        @discardableResult
        func text(_ words: NSAttributedString, at x: CGFloat = Space.s4, width w: CGFloat? = nil) -> CGFloat {
            let label = WrappingLabel(selectable: true)
            label.attributedStringValue = words
            let lineWidth = w ?? width
            let height = label.fittingHeight(width: lineWidth)
            label.frame = NSRect(x: x, y: y, width: lineWidth, height: height)
            aside.addSubview(label)
            return height
        }
        func line(_ words: NSAttributedString) { y += text(words) + Space.s2 }
        line(Ink.text(server.name, size: 13, weight: ShellStyle.semibold, color: tokens.primary.nsColor))
        // The facts: a column of names, a column of values (`.mcp-detail-facts`).
        let facts: [(String, String, NSColor)] = [
            ("Status", McpWords.statusText(server) + (working ? " — working…" : ""), tokens.primary.nsColor),
            ("Source", server.source ?? "Not reported", tokens.primary.nsColor),
        ] + (server.error.map { [("Reason", $0, tokens.danger.nsColor)] } ?? [])
        let nameWidth = facts.map { Ink.width(Ink.text($0.0, size: 12, color: tokens.secondary.nsColor)) }.max() ?? 0
        for (name, value, ink) in facts {
            text(Ink.text(name, size: 12, color: tokens.secondary.nsColor), width: nameWidth)
            let height = text(Ink.text(value, size: 12, color: ink), at: Space.s4 + nameWidth + Space.s2, width: max(40, width - nameWidth - Space.s2))
            y += max(15, height) + 2
        }
        y += Space.s2 - 2
        if !server.actions.isEmpty {
            var x = Space.s4
            for action in server.actions {
                let enabled = !working && !(action == .signIn && (running || elsewhere != nil))
                let button = DevHubButton(title: McpWords.action(action), isDefault: false, style: style) { [weak self] in self?.act(action) }
                button.isEnabled = enabled
                let size = button.intrinsicContentSize
                if x > Space.s4, x + size.width > Space.s4 + width {
                    x = Space.s4
                    y += 22 + Space.s1
                }
                button.frame = NSRect(x: x, y: y, width: size.width, height: 22)
                aside.addSubview(button)
                x += size.width + Space.s1
            }
            y += 22 + Space.s2
        }
        if let elsewhere {
            line(Ink.text("Signing in to \(elsewhere): one sign-in runs at a time.", size: 11, color: tokens.secondary.nsColor, lineHeight: 1.3))
        }
        if let signIn, signIn.server == server.name {
            // `.mcp-sign-in`: under a hairline.
            let rule = BandView()
            rule.fill = tokens.lineSoft.nsColor
            rule.frame = NSRect(x: Space.s4, y: y, width: width, height: 1)
            aside.addSubview(rule)
            y += 1 + Space.s2
            line(Ink.text(McpWords.signInTitle(signIn), size: 13, weight: ShellStyle.semibold, color: tokens.primary.nsColor))
            if signInOutput.string != signIn.output {
                signInOutput.string = signIn.output
                signInOutput.textColor = tokens.primary.nsColor
                signInOutput.checkTextInDocument(nil)
                signInOutput.scrollToEndOfDocument(nil)
            }
            let outputHeight = min(14 * 15, max(30, (signInOutput.layoutManager?.usedRect(for: signInOutput.textContainer!).height ?? 0) + 4))
            signInScroll.frame = NSRect(x: Space.s4, y: y, width: width, height: outputHeight)
            signInOutput.frame = NSRect(x: 0, y: 0, width: signInScroll.contentSize.width, height: max(outputHeight, signInOutput.frame.height))
            signInOutput.textContainer?.containerSize = NSSize(width: signInScroll.contentSize.width, height: .greatestFiniteMagnitude)
            aside.addSubview(signInScroll)
            y += outputHeight + Space.s2
            if let callback = signIn.callback {
                if case .unforwarded = callback {
                    line(Ink.text(McpWords.callback(callback), size: 11, color: tokens.danger.nsColor, lineHeight: 1.3))
                } else {
                    line(Ink.text(McpWords.callback(callback), size: 11, color: tokens.secondary.nsColor, lineHeight: 1.3))
                }
            }
            if let failure = signIn.failure { line(Ink.text(failure, size: 11, color: tokens.danger.nsColor, lineHeight: 1.3)) }
            if signIn.phase == .running {
                let send = DevHubButton(title: "Send", isDefault: false, style: style) { [weak self] in self?.sendSignIn() }
                let cancel = DevHubButton(title: "Cancel Sign-In", isDefault: false, style: style) { [weak self] in self?.cancelSignIn() }
                let buttons = send.intrinsicContentSize.width + Space.s1 + cancel.intrinsicContentSize.width
                let fieldWidth = max(120, width - buttons - Space.s1)
                signInField.frame = NSRect(x: Space.s4, y: y, width: fieldWidth, height: 22)
                aside.addSubview(signInField)
                var x = Space.s4 + fieldWidth + Space.s1
                if x + buttons > Space.s4 + width {
                    x = Space.s4
                    y += 22 + Space.s1
                }
                send.frame = NSRect(x: x, y: y, width: send.intrinsicContentSize.width, height: 22)
                cancel.frame = NSRect(x: send.frame.maxX + Space.s1, y: y, width: cancel.intrinsicContentSize.width, height: 22)
                aside.addSubview(send)
                aside.addSubview(cancel)
                y += 22 + Space.s2
            } else {
                let dismiss = DevHubButton(title: "Dismiss", isDefault: false, style: style) { [weak self] in self?.dismissSignIn() }
                dismiss.frame = NSRect(x: Space.s4, y: y, width: dismiss.intrinsicContentSize.width, height: 22)
                aside.addSubview(dismiss)
                y += 22 + Space.s2
            }
        }
        renderedAsideWidth = asideWidth
        asideHeight = y + Space.s3 - Space.s2
    }

    private func act(_ action: McpAction) {
        guard let server = current?.name else { return }
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

    private func cancelSignIn() { run { try await $0.mcpSignInCancel($1) } }
    private func dismissSignIn() { run { try await $0.mcpSignInDismiss($1) } }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 125 || event.keyCode == 126, let servers = mcp.servers, !servers.isEmpty {
            let at = servers.firstIndex { $0.name == current?.name } ?? 0
            let next = (at + (event.keyCode == 125 ? 1 : -1) + servers.count) % servers.count
            select(servers[next].name)
            return
        }
        super.keyDown(with: event)
    }

    // MARK: Layout

    override func bodyHeight(forWidth width: CGFloat) -> CGFloat {
        let rows = list.contentHeight
        let emptyHeight = empty.isHidden ? 0 : 2 * Space.s6 + 15
        return max(320, rows + emptyHeight, asideHeight)
    }

    override func layoutBody() {
        let bounds = body.bounds
        let listWidth = floor(bounds.width * 560 / 840)
        var top: CGFloat = 0
        if !empty.isHidden {
            empty.frame = NSRect(x: Space.s4, y: Space.s6, width: listWidth - 2 * Space.s4, height: empty.fittingHeight(width: listWidth - 2 * Space.s4))
            top = 2 * Space.s6 + 15
        }
        list.frame = NSRect(x: 0, y: top, width: listWidth, height: max(0, bounds.height - top))
        // The aside's own edge (`border-left: 1px solid var(--line-soft)`).
        aside.fill = nil
        aside.frame = NSRect(x: listWidth, y: 0, width: bounds.width - listWidth, height: bounds.height)
        if abs(asideWidth - renderedAsideWidth) > 0.5 {
            let before = asideHeight
            renderAside()
            // Laid out at its real width, the aside may want another height.
            if abs(before - asideHeight) > 0.5 { needsLayout = true }
        }
        aside.needsDisplay = true
        divider.frame = NSRect(x: listWidth, y: 0, width: 1, height: bounds.height)
        divider.fill = style.tokens.lineSoft.nsColor
        if divider.superview !== body { body.addSubview(divider) }
    }

    private let divider = BandView()
}

/// The MCP panel's servers, as list rows (`mac-list-row`): the status dot,
/// the name, the status and where it is configured under it.
@MainActor
final class McpServerList: NSView {
    weak var panel: McpPanelView?
    private var servers: [McpServer] = []
    private var current: String?
    private var style: ShellStyle?
    private var hovered: Int?
    private var tracking: NSTrackingArea?

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.list)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func update(servers: [McpServer], current: String?, style: ShellStyle) {
        self.servers = servers
        self.current = current
        self.style = style
        needsDisplay = true
    }

    private let rowHeight: CGFloat = 2 * Space.s1 + 16 + 15

    var contentHeight: CGFloat { servers.isEmpty ? 0 : 2 * Space.s2 + CGFloat(servers.count) * (rowHeight + 1) - 1 }

    private func rowRect(_ index: Int) -> NSRect {
        NSRect(x: Space.s2, y: Space.s2 + CGFloat(index) * (rowHeight + 1), width: bounds.width - 2 * Space.s2, height: rowHeight)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let index = servers.indices.first { rowRect($0).contains(point) }
        if index != hovered {
            hovered = index
            needsDisplay = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        hovered = nil
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard let index = servers.indices.first(where: { rowRect($0).contains(point) }) else { return }
        panel?.select(servers[index].name)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let style else { return }
        let tokens = style.tokens
        for (index, server) in servers.enumerated() {
            let rect = rowRect(index)
            let selected = server.name == current
            let shape = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
            if selected {
                tokens.accent.nsColor.setFill()
                shape.fill()
            } else if hovered == index {
                tokens.wash.nsColor.setFill()
                shape.fill()
            }
            // `.mcp-status-dot`: the Sidebar's inks.
            let dot: NSColor
            switch server.status {
            case .connected: dot = tokens.statusIdle.nsColor
            case .needsSignIn, .connecting: dot = tokens.statusWorking.nsColor
            case .failed: dot = tokens.statusError.nsColor
            case .disabled, .unknown: dot = tokens.secondary.nsColor
            }
            dot.setFill()
            NSBezierPath(ovalIn: NSRect(x: rect.minX + Space.s3, y: rect.midY - 4, width: 8, height: 8)).fill()
            let x = rect.minX + Space.s3 + 8 + Space.s2
            let width = max(0, rect.maxX - Space.s3 - x)
            let titleInk = selected ? tokens.accentInk.nsColor : tokens.primary.nsColor
            let captionInk = selected ? tokens.accentInk.faded(0.78) : tokens.secondary.nsColor
            let top = rect.midY - (16 + 15) / 2
            Ink.drawLine(Ink.text(server.name, size: 13, color: titleInk), in: NSRect(x: x, y: top, width: width, height: 17))
            let subtitle = McpWords.statusText(server) + (server.source.map { " · \($0)" } ?? "")
            Ink.drawLine(Ink.text(subtitle, size: 11, color: captionInk), in: NSRect(x: x, y: top + 16, width: width, height: 15))
        }
    }
}
