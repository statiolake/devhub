// The window's hosting points for the work packages that draw inside it:
//
//   ConversationViewProviding  WP10: a GUI Agent's conversation, in the
//                              Agents' view, where a terminal Agent's
//                              terminal goes.
//   AgentOverlayProviding      WP10: what is drawn over the active Agent's
//                              pane (its failure sheet, the injection status,
//                              the Smart Buttons).
//   ModalPresenting            WP11: the questions layer (`picker` in the
//                              layout): sheets, the palette, the chord help.
//   NoticePresenting           WP11: the notices layer (`toasts`).
//
// Each comes with a small stand-in, so the window works and is tested before
// they arrive: a placeholder conversation, `NSAlert` for the confirmations and
// the worktree question, the chord help as a native panel, and notices in the
// log.

import AppKit
import DevHubCore

// MARK: - The conversation slot (WP10)

/// One GUI Agent's pane, as the Agents' view holds it.
@MainActor
protocol HostedConversation: AnyObject {
    var view: NSView { get }
    /// Shown (the active Agent) or kept, hidden, in the pool.
    func setShown(_ shown: Bool)
    func applyStyle(_ style: ShellStyle)
    /// The newest projection, for what the pane draws about its Agent.
    func update(_ agent: AgentWire, snapshot: AppSnapshotWire)
    /// The keyboard to the pane (its composer).
    func focus()
    /// Whether `responder` is inside this pane.
    func owns(_ responder: NSResponder?) -> Bool
    func dispose()
}

/// What makes a GUI Agent's pane. WP10 provides the conversation.
@MainActor
protocol ConversationViewProviding: AnyObject {
    func makeConversation(agentId: String, workspaceId: String, label: String, style: ShellStyle) -> HostedConversation
}

/// What is drawn over the active Agent's pane. WP10 provides the failure
/// sheet, the injection status and the Smart Buttons.
@MainActor
protocol AgentOverlayProviding: AnyObject {
    /// The overlay for `agent`, laid over `bounds` of the Agents' view; nil
    /// for nothing. Called on every projection.
    func overlay(for agent: AgentWire, snapshot: AppSnapshotWire, style: ShellStyle, in container: NSView) -> NSView?
}

/// Until WP10: a GUI Agent's pane says what it is and that its conversation
/// is drawn elsewhere.
@MainActor
final class PlaceholderConversation: HostedConversation {
    let view: NSView
    private let state: SurfaceStateView
    private let label: String

    init(label: String, style: ShellStyle) {
        self.label = label
        state = SurfaceStateView(style: style)
        view = state
        state.show(.empty(title: label, message: "This Agent's conversation is not drawn in this build yet.", actions: []))
    }

    func setShown(_ shown: Bool) { view.isHidden = !shown }
    func applyStyle(_ style: ShellStyle) { state.restyle(style) }
    func update(_ agent: AgentWire, snapshot: AppSnapshotWire) {}
    func focus() { view.window?.makeFirstResponder(view) }
    func owns(_ responder: NSResponder?) -> Bool {
        guard let responder = responder as? NSView else { return false }
        return responder === view || responder.isDescendant(of: view)
    }
    func dispose() {}
}

@MainActor
final class PlaceholderConversations: ConversationViewProviding {
    func makeConversation(agentId: String, workspaceId: String, label: String, style: ShellStyle) -> HostedConversation {
        PlaceholderConversation(label: label, style: style)
    }
}

// MARK: - The questions layer (WP11)

/// How a question was answered, for the window to carry out.
enum ModalAnswer: Equatable {
    case dismissed
    /// A confirmation's confirm (`confirm_*`), and the "move the terminal" choice.
    case confirmed(confirmationId: String, purpose: ConfirmationOutcomePurpose, moveTerminal: Bool)
    case worktreeClose(workspaceId: String, deleteFolder: Bool)
    /// A command palette row or a chord help row was chosen.
    case command(CommandId)
    case renamed(agentId: String, displayName: String)
}

/// A GUI Agent's `/resume`: which earlier session of its CLI to go on with
/// (SessionPicker.tsx), and where its sessions are read.
struct SessionPickerRequest {
    var title: String
    var question: String
    /// "Claude" or "Codex", as the rows and refusals name it.
    var cli: String
    var source: SheetFlows.SessionSource
}

/// The questions layer: puts `ModalRequest`s in front of the window and says
/// how they were answered. WP11 provides the real sheets.
@MainActor
protocol ModalPresenting: AnyObject {
    /// The session picker of a GUI Agent's `/resume`; `chosen` is called
    /// once, with the session picked or nil for none.
    func presentSessionPicker(
        _ request: SessionPickerRequest, in window: NSWindow, style: ShellStyle,
        chosen: @escaping (PastSession?) -> Void)
    /// Whether a question is up now (keys go to it; chords are declined).
    var isPresenting: Bool { get }
    /// Whether the layer covers the window or one editor (`PickerScope`).
    var scope: PickerScope { get }
    /// Put `request` up. `answer` is called once, when it is answered.
    func present(_ request: ModalRequest, in window: NSWindow, style: ShellStyle, answer: @escaping (ModalAnswer) -> Void)
    /// The layer's view, laid out by the window (nil: it draws in panels of its own).
    var layerView: NSView? { get }
    func applyStyle(_ style: ShellStyle)
}

/// A stand-in: the questions DevHub must be able to ask, asked with `NSAlert`
/// (a close or restart confirmation, the worktree's three-way question, a
/// rename), and the chord help and command palette as plain lists.
@MainActor
final class AlertModalPresenter: ModalPresenting {
    private(set) var isPresenting = false
    var scope: PickerScope { .none }
    var layerView: NSView? { nil }
    func applyStyle(_ style: ShellStyle) {}
    /// Requests that need a sheet this stand-in does not draw.
    var onUnsupported: ((ModalRequest) -> Void)?
    /// An Agent's name, for the question about it.
    var nameOfAgent: ((String) -> String?)?

    /// The stand-in draws no session picker.
    func presentSessionPicker(
        _ request: SessionPickerRequest, in window: NSWindow, style: ShellStyle,
        chosen: @escaping (PastSession?) -> Void
    ) {
        chosen(nil)
    }

    func present(_ request: ModalRequest, in window: NSWindow, style: ShellStyle, answer: @escaping (ModalAnswer) -> Void) {
        let alert = NSAlert()
        let handle: (NSApplication.ModalResponse) -> Void
        switch request {
        case let .closeConfirmation(confirmationId, purpose):
            let agentId: String? = {
                switch purpose {
                case let .agentStop(id, _), let .agentContinue(id, _), let .agentRestart(id): return id.rawValue
                case .workspaceClose: return nil
                }
            }()
            let words = ConfirmationWords.of(purpose, agentName: agentId.flatMap { nameOfAgent?($0) })
            alert.messageText = words.title
            alert.informativeText = words.message
            alert.alertStyle = words.destructive ? .critical : .warning
            alert.addButton(withTitle: words.confirm)
            if let alternate = words.alternate { alert.addButton(withTitle: alternate) }
            alert.addButton(withTitle: "Cancel")
            if words.destructive, #available(macOS 11.0, *) { alert.buttons.first?.hasDestructiveAction = true }
            handle = { response in
                switch response {
                case .alertFirstButtonReturn:
                    answer(.confirmed(confirmationId: confirmationId, purpose: purpose, moveTerminal: words.confirmMovesTerminal))
                case .alertSecondButtonReturn where words.alternate != nil:
                    answer(.confirmed(confirmationId: confirmationId, purpose: purpose, moveTerminal: !words.confirmMovesTerminal))
                default:
                    answer(.dismissed)
                }
            }
        case let .worktreeClose(workspaceId, label, root, branch, dirty):
            alert.messageText = "Close the worktree “\(label)”?"
            var lines = [root]
            if let branch { lines.append("Branch \(branch)") }
            lines.append(dirty == true
                ? "It has changes that are not committed. Deleting the folder loses them."
                : "DevHub could not tell whether it has changes that are not committed.")
            alert.informativeText = lines.joined(separator: "\n")
            alert.alertStyle = .warning
            alert.addButton(withTitle: "Cancel")
            alert.addButton(withTitle: "Keep Folder")
            alert.addButton(withTitle: "Delete Folder")
            handle = { response in
                switch response {
                case .alertSecondButtonReturn: answer(.worktreeClose(workspaceId: workspaceId, deleteFolder: false))
                case .alertThirdButtonReturn: answer(.worktreeClose(workspaceId: workspaceId, deleteFolder: true))
                default: answer(.dismissed)
                }
            }
        case let .agentRename(agentId):
            alert.messageText = "Rename Agent"
            alert.addButton(withTitle: "Rename")
            alert.addButton(withTitle: "Cancel")
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
            alert.accessoryView = field
            alert.window.initialFirstResponder = field
            handle = { response in
                let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                if response == .alertFirstButtonReturn, !name.isEmpty {
                    answer(.renamed(agentId: agentId, displayName: name))
                } else {
                    answer(.dismissed)
                }
            }
        case let .chordHelp(rows):
            ChordHelpPanel.show(rows, style: style, over: window)
            answer(.dismissed)
            return
        default:
            onUnsupported?(request)
            answer(.dismissed)
            return
        }
        isPresenting = true
        Task { @MainActor [weak self] in
            let response = await alert.beginSheetModal(for: window)
            self?.isPresenting = false
            handle(response)
        }
    }
}

/// The words of a close / stop / restart / continue question
/// (`questionWords` in picker/CloseConfirmationSheet.tsx).
struct ConfirmationWords {
    var title: String
    var message: String
    var confirm: String
    var alternate: String?
    var destructive: Bool
    /// The first button keeps the Agent's terminal (moves it to the editor).
    var confirmMovesTerminal = false

    static func of(_ purpose: ConfirmationOutcomePurpose, agentName: String? = nil) -> ConfirmationWords {
        func quoted(_ prefix: String, _ fallback: String, _ suffix: String = "?") -> String {
            agentName.map { "\(prefix) “\($0)”\(suffix)" } ?? fallback
        }
        switch purpose {
        case let .workspaceClose(inspection, worktree):
            var message = "The workspace has resources open. Closing it will close them."
            if worktree != .keep { message += " The folder is removed from disk." }
            return ConfirmationWords(
                title: "Close “\(inspection.workspaceLabel)”?", message: message, confirm: "Close the workspace", destructive: true)
        case let .agentStop(_, terminal):
            if terminal {
                return ConfirmationWords(
                    title: quoted("Stop", "Stop this Agent?"),
                    message: "Its terminal is still open. Move it to the editor, or close it with the Agent?",
                    confirm: "Move the terminal to the editor", alternate: "Stop, and close the terminal", destructive: false,
                    confirmMovesTerminal: true)
            }
            return ConfirmationWords(
                title: quoted("Stop", "Stop this Agent?"),
                message: "This stops the Agent runtime. You can retry if cleanup fails.", confirm: "Stop the Agent", destructive: true)
        case let .agentContinue(_, presentation):
            let place = presentation == .tui ? "in a terminal" : "in the GUI"
            return ConfirmationWords(
                title: agentName.map { "Continue “\($0)” \(place)?" } ?? "Continue this Agent \(place)?",
                message: "It is not idle. Its CLI is stopped and the session resumed in a new Agent: the turn it is in, a question it is waiting on, and any subagents or background tasks it started stop with it.",
                confirm: presentation == .tui ? "Continue in terminal" : "Continue in GUI", destructive: false)
        case .agentRestart:
            return ConfirmationWords(
                title: agentName.map { "Restart the session of “\($0)”?" } ?? "Restart this Agent's session?",
                message: "It is not idle. Its CLI is stopped and started again on the same session: the turn it is in, a question it is waiting on, and any subagents or background tasks it started stop with it.",
                confirm: "Restart Session", destructive: true)
        }
    }
}

/// `Cmd+Q ?`: every chord in the table in effect, in a panel over the window.
@MainActor
enum ChordHelpPanel {
    private static var current: NSPanel?

    static func show(_ rows: [ChordHelpRow], style: ShellStyle, over window: NSWindow) {
        current?.close()
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 560), styleMask: [.titled, .closable, .utilityWindow],
            backing: .buffered, defer: false)
        panel.title = "Keyboard Shortcuts"
        panel.isReleasedWhenClosed = false
        let text = NSMutableAttributedString()
        let tokens = style.tokens
        for row in rows {
            text.append(NSAttributedString(string: row.label, attributes: [
                .font: ShellStyle.font(13, ShellStyle.medium), .foregroundColor: tokens.primary.nsColor,
            ]))
            if let needs = row.needs {
                text.append(NSAttributedString(string: "  \(needs)", attributes: [
                    .font: ShellStyle.font(11), .foregroundColor: tokens.tertiary.nsColor,
                ]))
            }
            text.append(NSAttributedString(string: "\n\(row.chords.joined(separator: ", "))\n\n", attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), .foregroundColor: tokens.secondary.nsColor,
            ]))
        }
        let scroll = NSScrollView(frame: panel.contentLayoutRect)
        scroll.hasVerticalScroller = true
        scroll.autoresizingMask = [.width, .height]
        let view = NSTextView(frame: scroll.bounds)
        view.isEditable = false
        view.textContainerInset = NSSize(width: 16, height: 16)
        view.backgroundColor = tokens.surface.nsColor
        view.textStorage?.setAttributedString(text)
        view.autoresizingMask = [.width]
        scroll.documentView = view
        panel.contentView = scroll
        let frame = window.frame
        panel.setFrameOrigin(NSPoint(x: frame.midX - 260, y: frame.midY - 280))
        panel.makeKeyAndOrderFront(nil)
        current = panel
    }
}

// MARK: - The notices layer (WP11)

/// The notices layer: DevHub's own notices and the app's conditions.
@MainActor
protocol NoticePresenting: AnyObject {
    /// An app-wide failure, said once.
    func error(_ error: AppError)
    /// A condition went up (`summary`) or came down (nil).
    func condition(source: String, summary: String?, reason: String)
    /// `devhub --tell notify`, and an Agent's turn.
    func notice(_ text: String)
    /// `Cmd+Q Esc` and `Cmd+Q N`.
    func dismissAlert()
    func showNotifications()
    /// The stack's size, for the layout (`toasts`); nil when nothing is shown.
    var measured: LayoutSize? { get }
    var layerView: NSView? { get }
    func applyStyle(_ style: ShellStyle)
    /// The person started another action: a failure about the last one is over.
    func personStartedAction()
}

extension NoticePresenting {
    func personStartedAction() {}
}

/// A stand-in (the self-test's fixture): notices go to the log, and the last failure is kept for the
/// self-test and the log's reader.
@MainActor
final class LogNoticePresenter: NoticePresenting {
    private(set) var errors: [AppError] = []
    private(set) var conditions: [String: String] = [:]
    var measured: LayoutSize? { nil }
    var layerView: NSView? { nil }
    func applyStyle(_ style: ShellStyle) {}

    func error(_ error: AppError) {
        if error.reported { return }
        errors.append(error)
        MainLog.shared.error("[devhub] \(error.summary)\(error.detail.map { ": \($0)" } ?? "")")
    }

    func condition(source: String, summary: String?, reason: String) {
        conditions[source] = summary
        MainLog.shared.log("[devhub] condition \(source): \(summary ?? "cleared") (\(reason))")
    }

    func notice(_ text: String) {
        MainLog.shared.log("[devhub] notice: \(text)")
    }

    func dismissAlert() {}
    func showNotifications() {}
}
