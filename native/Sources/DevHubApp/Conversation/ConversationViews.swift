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

/// A failure over the Agent's pane (AgentFailure.tsx): a sheet over the pane
/// dimmed — DevHub's sheet, its title, the summary under it, the detail with
/// its `code` spans, the ways out at the footer's end — then, once dismissed,
/// one line along the pane's top with the same actions for as long as the
/// failure holds (`.agent-failure-banner`).
@MainActor
final class FailureView: NSView {
    private var sheet: FailureSheet?
    private var bannerView: FailureBanner?
    private var banner = false
    var onDismiss: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        // The banner leaves the pane under it usable; the sheet covers it.
        if banner {
            guard let bannerView, bannerView.frame.contains(point) else { return nil }
        }
        return super.hitTest(point)
    }

    func update(title words: String, summary: String, detail: String?, banner: Bool, actions: [(String, Bool, () -> Void)], style: ShellStyle) {
        self.banner = banner
        setAccessibilityLabel(words)
        if banner {
            sheet?.removeFromSuperview()
            sheet = nil
            let view = bannerView ?? FailureBanner()
            if bannerView == nil {
                addSubview(view)
                bannerView = view
            }
            view.update(title: words, summary: summary, actions: actions, style: style)
        } else {
            bannerView?.removeFromSuperview()
            bannerView = nil
            let made = sheet == nil
            let view = sheet ?? FailureSheet(style: style)
            if made {
                addSubview(view)
                sheet = view
            }
            view.onCancel = { [weak self] in self?.onDismiss?() }
            view.update(title: words, summary: summary, detail: detail, actions: actions, style: style)
            if made {
                // The sheet takes the keyboard as it appears, so Escape is its own.
                DispatchQueue.main.async { [weak view] in
                    guard let view, let window = view.window else { return }
                    window.makeFirstResponder(view)
                }
            }
        }
        needsLayout = true
    }

    override func layout() {
        super.layout()
        sheet?.frame = bounds
        if let bannerView {
            bannerView.frame = NSRect(x: 0, y: 0, width: bounds.width, height: bannerView.height)
        }
    }
}

/// The failure as a sheet (`.agent-failure-sheet`): 520pt at most, centred, every corner rounded.
@MainActor
final class FailureSheet: PaneSheetFrame {
    private let detail = WrappingLabel(selectable: true)

    init(style: ShellStyle) {
        super.init(style: style, placement: .centred, width: 520)
        titleWraps = true
        body.addSubview(detail)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    func update(title: String, summary: String, detail words: String?, actions: [(String, Bool, () -> Void)], style: ShellStyle) {
        restyleFrame(style)
        setHeading(title: title, question: summary)
        let tokens = style.tokens
        let text = NSMutableAttributedString()
        // A detail's `code` spans — the commands it names — drawn as code.
        for (index, part) in (words ?? "").components(separatedBy: "`").enumerated() {
            text.append(NSAttributedString(string: part, attributes: [
                .font: index % 2 == 1 ? NSFont.monospacedSystemFont(ofSize: 12, weight: .regular) : ShellStyle.font(13),
                .foregroundColor: tokens.primary.nsColor,
            ]))
        }
        detail.attributedStringValue = text
        detail.isHidden = (words ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        setButtons(actions.map { (title: $0.0, isDefault: $0.1, enabled: true, run: $0.2) })
    }

    override func bodyHeight(forWidth width: CGFloat) -> CGFloat {
        detail.isHidden ? 0 : Space.s3 + detail.fittingHeight(width: width - 2 * Space.s4) + Space.s3
    }

    override func layoutBody() {
        guard !detail.isHidden else { return }
        let width = body.bounds.width - 2 * Space.s4
        detail.frame = NSRect(x: Space.s4, y: Space.s3, width: width, height: detail.fittingHeight(width: width))
    }
}

/// The failure once its sheet is dismissed: one line along the pane's top,
/// the title in the danger ink, the summary after it, the same actions.
@MainActor
final class FailureBanner: BandView {
    private let words = NSTextField(labelWithString: "")
    private var buttons: [DevHubButton] = []
    private var style: ShellStyle?

    override init(frame: NSRect) {
        super.init(frame: frame)
        words.lineBreakMode = .byTruncatingTail
        words.isSelectable = true
        addSubview(words)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    var height: CGFloat { Space.s2 + 22 + Space.s2 + 1 }

    func update(title: String, summary: String, actions: [(String, Bool, () -> Void)], style: ShellStyle) {
        self.style = style
        let tokens = style.tokens
        fill = tokens.chrome.nsColor
        let text = NSMutableAttributedString(string: title, attributes: [.font: ShellStyle.font(13, ShellStyle.semibold), .foregroundColor: tokens.danger.nsColor])
        text.append(NSAttributedString(string: " " + summary, attributes: [.font: ShellStyle.font(13), .foregroundColor: tokens.secondary.nsColor]))
        words.attributedStringValue = text
        setAccessibilityLabel("\(title) \(summary)")
        for button in buttons { button.removeFromSuperview() }
        buttons = actions.map { action in
            let button = DevHubButton(title: action.0, isDefault: action.1, style: style, onPress: action.2)
            addSubview(button)
            return button
        }
        needsLayout = true
        needsDisplay = true
    }

    override func layout() {
        super.layout()
        var x = bounds.width - Space.s3
        for button in buttons.reversed() {
            let size = button.intrinsicContentSize
            x -= size.width
            button.frame = NSRect(x: x, y: Space.s2, width: size.width, height: 22)
            x -= Space.s2
        }
        let height = ceil(words.attributedStringValue.size().height)
        words.frame = NSRect(x: Space.s3, y: (bounds.height - 1 - height) / 2, width: max(0, x - Space.s3 - Space.s3 + Space.s2), height: height)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        style?.tokens.lineSoft.nsColor.setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
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
