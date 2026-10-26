// Port of shell/agents/AgentsApp.tsx, AgentPane.tsx and
// components/shell/surfacePool.ts: the Agents' view (`agents` in the layout).
// Every running Agent of an available Workspace keeps its pane here — a
// terminal Agent's terminal on `agent:<id>`, a GUI Agent's conversation from
// the WP10 slot — and the one the layout names is shown; the rest stay
// attached, hidden, so switching is instant and nothing is attached twice.

import AppKit
import DevHubCore

@MainActor
final class AgentsView: NSView {
    /// One pooled pane.
    @MainActor
    enum Pane {
        case terminal(TerminalPaneView)
        case conversation(HostedConversation)

        var view: NSView {
            switch self {
            case let .terminal(pane): return pane
            case let .conversation(hosted): return hosted.view
            }
        }
    }

    private struct Pooled {
        var key: String
        var agentId: String
        var workspaceId: String
        var label: String
        var presentation: AgentPresentation
        var pane: Pane
    }

    private var style: ShellStyle
    private let transport: TerminalAttachTransport
    private let conversations: ConversationViewProviding
    weak var overlays: AgentOverlayProviding?
    private var pool: [String: Pooled] = [:]
    private var order: [String] = []
    private(set) var activeKey: String?
    private var overlay: NSView?
    /// A terminal pane was made (the window wires its links and focus).
    var onTerminalPane: ((TerminalPaneView) -> Void)?

    init(style: ShellStyle, transport: TerminalAttachTransport, conversations: ConversationViewProviding) {
        self.style = style
        self.transport = transport
        self.conversations = conversations
        super.init(frame: .zero)
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    func restyle(_ style: ShellStyle) {
        self.style = style
        for entry in pool.values {
            switch entry.pane {
            case let .terminal(pane): pane.applyStyle(style)
            case let .conversation(hosted): hosted.applyStyle(style)
            }
        }
        layer?.backgroundColor = TerminalPalette.ns(style.terminalPalette().background)?.cgColor ?? style.tokens.surface.cgColor
    }

    /// `runningAgentSurfaces`: every running Agent of an available Workspace.
    static func runningSurfaces(_ snapshot: AppSnapshotWire) -> [(key: String, agent: AgentWire, workspace: WorkspaceWire)] {
        var surfaces: [(String, AgentWire, WorkspaceWire)] = []
        for workspace in snapshot.workspaces where workspace.state.isAvailable {
            for agent in workspace.agents where agent.controlState == .running {
                surfaces.append((TerminalSurfaceKeys.agent(agent.id), agent, workspace))
            }
        }
        return surfaces
    }

    /// The pane the layout names, and the pool around it.
    func render(_ snapshot: AppSnapshotWire, visible: Bool) {
        let active: String? = {
            switch snapshot.layout {
            case let .agent(key), let .split(_, key): return key
            default: return nil
            }
        }()
        let running = Self.runningSurfaces(snapshot)
        let keys = Set(running.map(\.key))
        // Gone: let go of exactly what each held.
        for key in order where !keys.contains(key) {
            switch pool[key]?.pane {
            case let .terminal(pane)?: pane.dispose()
            case let .conversation(hosted)?: hosted.dispose()
            case nil: break
            }
            pool[key]?.pane.view.removeFromSuperview()
            pool[key] = nil
        }
        order = order.filter { keys.contains($0) }
        for (key, agent, workspace) in running {
            if let existing = pool[key], existing.presentation == agent.presentation {
                if case let .conversation(hosted) = existing.pane { hosted.update(agent, snapshot: snapshot) }
                continue
            }
            if let existing = pool[key] {
                // The presentation changed under the same key: a new pane.
                switch existing.pane {
                case let .terminal(pane): pane.dispose()
                case let .conversation(hosted): hosted.dispose()
                }
                existing.pane.view.removeFromSuperview()
            }
            let pane: Pane
            switch agent.presentation {
            case .gui:
                let hosted = conversations.makeConversation(
                    agentId: agent.id, workspaceId: workspace.id, label: agent.displayName, style: style)
                hosted.update(agent, snapshot: snapshot)
                pane = .conversation(hosted)
            default:
                let terminal = TerminalPaneView(
                    role: .agent(agentId: agent.id), surfaceKey: key, label: agent.displayName, viewLabel: "agents",
                    transport: transport, style: style)
                onTerminalPane?(terminal)
                pane = .terminal(terminal)
            }
            pane.view.isHidden = true
            addSubview(pane.view)
            pane.view.frame = bounds
            if case let .terminal(terminal) = pane { terminal.start() }
            pool[key] = Pooled(
                key: key, agentId: agent.id, workspaceId: workspace.id, label: agent.displayName,
                presentation: agent.presentation, pane: pane)
            if !order.contains(key) { order.append(key) }
        }
        activeKey = active
        for (key, entry) in pool {
            let shown = visible && key == active
            switch entry.pane {
            case let .terminal(pane): pane.setShown(shown)
            case let .conversation(hosted): hosted.setShown(shown)
            }
        }
        // Over the active pane: what WP10 draws (failure, injection, buttons).
        overlay?.removeFromSuperview()
        overlay = nil
        if let active, let entry = pool[active], let overlays,
           let agent = snapshot.workspaces.lazy.flatMap(\.agents).first(where: { $0.id == entry.agentId }),
           let view = overlays.overlay(for: agent, snapshot: snapshot, style: style, in: self)
        {
            addSubview(view)
            view.frame = bounds
            overlay = view
        }
        needsLayout = true
    }

    override func layout() {
        super.layout()
        for entry in pool.values { entry.pane.view.frame = bounds }
        overlay?.frame = bounds
    }

    /// The active Agent's pane, for the keyboard.
    var activePane: Pane? { activeKey.flatMap { pool[$0]?.pane } }

    func focusActive() {
        switch activePane {
        case let .terminal(pane)?: pane.focus()
        case let .conversation(hosted)?: hosted.focus()
        case nil: window?.makeFirstResponder(self)
        }
    }

    /// Whether `responder` is in one of the Agents' panes.
    func owns(_ responder: NSResponder?) -> Bool {
        guard let view = responder as? NSView else { return false }
        return view === self || view.isDescendant(of: self)
    }

    /// The terminal pane `responder` is in, if it is in one.
    func terminalPane(containing responder: NSResponder?) -> TerminalPaneView? {
        for entry in pool.values {
            if case let .terminal(pane) = entry.pane, pane.owns(responder) { return pane }
        }
        return nil
    }

    var terminalPanes: [TerminalPaneView] {
        order.compactMap { key in
            if case let .terminal(pane)? = pool[key]?.pane { return pane }
            return nil
        }
    }

    func disposeAll() {
        for entry in pool.values {
            switch entry.pane {
            case let .terminal(pane): pane.dispose()
            case let .conversation(hosted): hosted.dispose()
            }
        }
    }
}
