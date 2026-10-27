// WP10's two slots in the Agents' view (`Hosting.swift`): a GUI Agent's
// conversation (`ConversationViewProviding`), and what is drawn over the
// active Agent's pane (`AgentOverlayProviding`) — port of
// shell/agents/AgentPane.tsx's `OverThePane`, AgentFailure.tsx and
// components/shell/InjectionStatus.tsx, with the Smart Buttons over them.

import AppKit
import DevHubCore

@MainActor
final class ConversationViews: ConversationViewProviding, AgentOverlayProviding {
    let link = ConversationLink()
    /// Ask the model (the window's dispatch).
    var dispatch: ((AppIntentWire) -> Void)?
    /// A Workspace's repository as the last round read it.
    var repository: ((String) -> WorkspaceRepositoryWire?)? {
        didSet { link.repository = repository }
    }
    /// The Agent actions the settings define (for the Smart Buttons).
    var agentActions: (() -> [ConfiguredAgentAction])?
    /// Run one of them for an Agent.
    var runAgentAction: ((String, String) -> Void)?
    private var overlays: [String: AgentOverlayView] = [:]

    func makeConversation(agentId: String, workspaceId: String, label: String, style: ShellStyle) -> HostedConversation {
        ConversationPaneView(agentId: agentId, workspaceId: workspaceId, label: label, style: style, link: link)
    }

    func overlay(for agent: AgentWire, snapshot: AppSnapshotWire, style: ShellStyle, in container: NSView) -> NSView? {
        let view = overlays[agent.id] ?? AgentOverlayView(agentId: agent.id)
        overlays[agent.id] = view
        // One overlay a running Agent: the others go when their Agent does.
        let running = Set(snapshot.workspaces.flatMap(\.agents).map(\.id))
        for key in overlays.keys where !running.contains(key) { overlays[key] = nil }
        view.views = self
        view.update(agent, snapshot: snapshot, style: style)
        return view.isEmpty ? nil : view
    }

    /// What an Agent's Smart Buttons stand on, in `view`'s coordinates: a GUI
    /// Agent's composer box, a terminal's queued-message status; nil for nothing yet.
    func anchor(for agentId: String, in view: NSView) -> NSRect? {
        if let pane = link.pane(agentId), pane.window != nil, !pane.isHidden { return pane.composerBox(in: view) }
        if let overlay = overlays[agentId] { return overlay.injectionRect(in: view) }
        return nil
    }

    func continueInTerminal(_ agentId: String) {
        guard let transport = link.transport else { return }
        Task { [weak self] in
            do { try await transport.continueInTerminal(agentId) } catch { self?.link.report?(errorWire(error)) }
        }
    }
}

/// What floats over the pane, all of it the Agent on screen's: its failure,
/// what became of a message DevHub was asked to type into it, its Smart Buttons.
@MainActor
final class AgentOverlayView: NSView {
    let agentId: String
    weak var views: ConversationViews?
    private var agent: AgentWire?
    private var style: ShellStyle?
    private var failureKey: String?
    private var dismissed = false
    private var trying = false
    private var failure: FailureView?
    private let injection = InjectionStatusView()
    private(set) var smart: SmartButtonsView?

    init(agentId: String) {
        self.agentId = agentId
        super.init(frame: .zero)
        addSubview(injection)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    /// Nothing to draw: the overlay is not put up.
    var isEmpty: Bool { failure == nil && injection.isHidden && (smart?.isHidden ?? true) }

    /// Only what is drawn takes the pointer; the pane under it keeps the rest.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        return hit === self ? nil : hit
    }

    func update(_ agent: AgentWire, snapshot: AppSnapshotWire, style: ShellStyle) {
        self.agent = agent
        self.style = style
        // A different failure is a new one, asked about with the sheet again.
        let key = agent.failure.map { "\($0.code.rawValue)\n\($0.detail ?? "")" }
        if key != failureKey {
            failureKey = key
            dismissed = false
        }
        renderFailure()
        injection.update(agent, style: style)
        if agent.failure == nil {
            let made = smart ?? SmartButtonsView(agentId: agentId)
            if smart == nil {
                addSubview(made)
                smart = made
            }
            made.views = views
            made.update(agent, snapshot: snapshot, style: style)
        } else {
            smart?.removeFromSuperview()
            smart = nil
        }
        needsLayout = true
    }

    private func renderFailure() {
        guard let agent, let style, let found = agent.failure else {
            failure?.removeFromSuperview()
            failure = nil
            return
        }
        let view = failure ?? FailureView()
        if failure == nil {
            addSubview(view, positioned: .below, relativeTo: injection)
            failure = view
        }
        var actions: [(String, Bool, () -> Void)] = []
        switch found.code {
        case .conversationNotSignedIn:
            actions.append(("Open a terminal to sign in", false, { [weak self] in
                guard let agent = self?.agent else { return }
                self?.views?.dispatch?(.requestCreateAgent(workspaceId: agent.workspaceId, profileId: agent.profileId, presentation: "tui"))
            }))
        case .conversationHostLost, .conversationProtocolMismatch, .conversationRefused, .conversationFailed:
            actions.append(("Continue in terminal", false, { [weak self] in
                guard let self else { return }
                self.views?.continueInTerminal(self.agentId)
            }))
        default:
            break
        }
        if !dismissed {
            actions.append(("Dismiss", false, { [weak self] in
                self?.dismissed = true
                self?.renderFailure()
                self?.needsLayout = true
            }))
        }
        // Try again: Restart Session, for a GUI Agent where it can be taken.
        if agent.presentation == .gui, agent.controlState == .running,
           AgentRules.restart(displayName: agent.displayName, presentation: agent.presentation, profileKind: agent.profileKind, failure: agent.failure) == .available
        {
            actions.append(("Try again", true, { [weak self] in
                guard let self, !self.trying else { return }
                self.trying = true
                self.views?.dispatch?(.restartAgent(agentId: self.agentId))
                self.trying = false
            }))
        }
        view.update(
            title: SurfaceLabels.agentFailureTitle(found.code), summary: SurfaceLabels.agentFailureSummary(found.code), detail: found.detail,
            banner: dismissed, actions: actions, style: style)
        view.onDismiss = { [weak self] in
            self?.dismissed = true
            self?.renderFailure()
            self?.needsLayout = true
        }
    }

    /// The queued-message status's rect, when it is up.
    func injectionRect(in view: NSView) -> NSRect? {
        injection.isHidden ? nil : view.convert(injection.frame, from: self)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas where area.owner === self { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { smart?.paneHovered = true }
    override func mouseExited(with event: NSEvent) { smart?.paneHovered = false }

    override func layout() {
        super.layout()
        failure?.frame = bounds
        let size = injection.fittingSize
        injection.frame = NSRect(x: bounds.width - size.width - 12, y: bounds.height - size.height - 12, width: size.width, height: size.height)
        smart?.frame = bounds
    }
}

/// A failure over the Agent's pane: a sheet over the pane dimmed, then a banner once dismissed.
@MainActor
final class FailureView: NSView {
    private let card = NSView()
    private let title = NSTextField(labelWithString: "")
    private let summary = NSTextField(wrappingLabelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private var buttons: [NSButton] = []
    private var handlers: [() -> Void] = []
    private var banner = false
    private var style: ShellStyle?
    var onDismiss: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        card.wantsLayer = true
        card.layer?.cornerRadius = 12
        card.layer?.borderWidth = 1
        addSubview(card)
        for label in [title, summary, detail] {
            label.isSelectable = true
            card.addSubview(label)
        }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        // The banner leaves the pane under it usable; the sheet covers it.
        if banner, hit === self { return nil }
        return hit
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53, !banner { onDismiss?() } else { super.keyDown(with: event) }
    }

    func update(title words: String, summary: String, detail: String?, banner: Bool, actions: [(String, Bool, () -> Void)], style: ShellStyle) {
        self.banner = banner
        self.style = style
        let tokens = style.tokens
        layer?.backgroundColor = banner ? NSColor.clear.cgColor : NSColor.black.withAlphaComponent(style.dark ? 0.45 : 0.25).cgColor
        card.layer?.backgroundColor = tokens.raised.nsColor.cgColor
        card.layer?.borderColor = (banner ? tokens.danger.faded(0.5) : tokens.line.nsColor).cgColor
        title.stringValue = words
        title.font = ShellStyle.font(banner ? 12 : 15, ShellStyle.semibold)
        title.textColor = tokens.primary.nsColor
        self.summary.stringValue = summary
        self.summary.font = ShellStyle.font(12)
        self.summary.textColor = tokens.secondary.nsColor
        let text = NSMutableAttributedString()
        // A detail's `code` spans — the commands it names — drawn as code.
        for (index, part) in (detail ?? "").components(separatedBy: "`").enumerated() {
            text.append(NSAttributedString(string: part, attributes: [
                .font: index % 2 == 1 ? NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular) : ShellStyle.font(12),
                .foregroundColor: tokens.primary.nsColor,
            ]))
        }
        self.detail.attributedStringValue = text
        self.detail.isHidden = banner || (detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        for button in buttons { button.removeFromSuperview() }
        handlers = actions.map { $0.2 }
        buttons = actions.enumerated().map { index, action in
            let button = NSButton(title: action.0, target: self, action: #selector(pressed(_:)))
            button.bezelStyle = .rounded
            button.controlSize = banner ? .small : .regular
            button.tag = index
            if action.1 { button.keyEquivalent = "\r" }
            card.addSubview(button)
            return button
        }
        setAccessibilityLabel(words)
        needsLayout = true
    }

    @objc private func pressed(_ sender: NSButton) {
        guard sender.tag < handlers.count else { return }
        handlers[sender.tag]()
    }

    override func layout() {
        super.layout()
        for button in buttons { button.sizeToFit() }
        let buttonsWidth = buttons.reduce(0) { $0 + $1.frame.width + 8 }
        if banner {
            let width = bounds.width - 24
            card.frame = NSRect(x: 12, y: 12, width: width, height: 40)
            title.sizeToFit()
            title.frame.origin = NSPoint(x: 12, y: 12)
            summary.frame = NSRect(x: title.frame.maxX + 6, y: 12, width: max(0, width - title.frame.maxX - 18 - buttonsWidth), height: 18)
            summary.maximumNumberOfLines = 1
            var x = width - 8
            for button in buttons.reversed() {
                x -= button.frame.width
                button.frame.origin = NSPoint(x: x, y: (40 - button.frame.height) / 2)
                x -= 8
            }
            return
        }
        let width = min(480, bounds.width - 40)
        let inner = width - 40
        let summaryHeight = ceil(summary.attributedStringValue.boundingRect(with: NSSize(width: inner, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).height)
        let detailHeight = detail.isHidden ? 0 : ceil(detail.attributedStringValue.boundingRect(with: NSSize(width: inner, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).height) + 12
        let height = 20 + 22 + 6 + summaryHeight + detailHeight + 20 + 32 + 16
        card.frame = NSRect(x: (bounds.width - width) / 2, y: max(20, (bounds.height - height) / 2.6), width: width, height: height)
        title.frame = NSRect(x: 20, y: 20, width: inner, height: 22)
        summary.frame = NSRect(x: 20, y: 48, width: inner, height: summaryHeight + 2)
        detail.frame = NSRect(x: 20, y: 48 + summaryHeight + 12, width: inner, height: detailHeight)
        var x = width - 20
        for button in buttons.reversed() {
            x -= button.frame.width
            button.frame.origin = NSPoint(x: x, y: height - 16 - button.frame.height)
            x -= 8
        }
    }
}

/// What became of a message DevHub was asked to type into an Agent: in the
/// corner, only while there is something to say.
@MainActor
final class InjectionStatusView: NSView {
    private let waiting = NSTextField(labelWithString: "")
    private let result = NSTextField(wrappingLabelWithString: "")

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 8
        addSubview(waiting)
        addSubview(result)
        isHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    static func waitingNote(_ injection: AgentInjection) -> String {
        let many = injection.queued == 1 ? "" : " (\(injection.queued) waiting)"
        switch injection.waitingFor {
        case .awaitingReview: return "Waiting for you to confirm the wording\(many)"
        case .agentBusy: return "Waiting for the agent to finish its turn\(many)"
        case .agentAsking: return "The agent is asking a question; nothing is typed into that\(many)"
        case .agentUnreadable: return "DevHub cannot read this agent's screen\(many)"
        default: return "Waiting for a prompt to send it\(many)"
        }
    }

    static func resultNote(_ result: AgentInjectionResult) -> String {
        switch result {
        case .sent: return "Sent to the agent."
        case .cancelled: return "Cancelled — nothing was sent."
        case .failed(let reason): return reason
        }
    }

    func update(_ agent: AgentWire, style: ShellStyle) {
        let injection = agent.injection
        // A GUI Agent's transcript draws a message DevHub delivered, so "sent" is not said again.
        let last: AgentInjectionResult? = agent.presentation == .gui && injection.lastResult == .sent ? nil : injection.lastResult
        isHidden = injection.queued == 0 && last == nil
        layer?.backgroundColor = style.tokens.raised.nsColor.withAlphaComponent(0.92).cgColor
        waiting.isHidden = injection.queued == 0
        waiting.stringValue = Self.waitingNote(injection)
        waiting.font = ShellStyle.font(11)
        waiting.textColor = style.tokens.secondary.nsColor
        result.isHidden = last == nil
        if let last {
            result.stringValue = Self.resultNote(last)
            result.font = ShellStyle.font(11)
            if case .failed = last { result.textColor = style.tokens.danger.nsColor } else { result.textColor = style.tokens.secondary.nsColor }
        }
        needsLayout = true
    }

    override var fittingSize: NSSize {
        let width = max(waiting.isHidden ? 0 : waiting.intrinsicContentSize.width, result.isHidden ? 0 : min(320, result.intrinsicContentSize.width))
        let height = (waiting.isHidden ? 0 : 16) + (result.isHidden ? 0 : 16)
        return NSSize(width: width + 16, height: CGFloat(height) + 10)
    }

    override func layout() {
        super.layout()
        var y: CGFloat = 5
        if !waiting.isHidden {
            waiting.frame = NSRect(x: 8, y: y, width: bounds.width - 16, height: 16)
            y += 16
        }
        if !result.isHidden { result.frame = NSRect(x: 8, y: y, width: bounds.width - 16, height: 16) }
    }
}
