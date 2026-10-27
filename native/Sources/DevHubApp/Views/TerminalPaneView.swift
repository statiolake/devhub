// Port of shell/terminal/TerminalSurface.tsx and shell/surfaces/xtermSession.ts:
// one terminal view — SwiftTerm's emulator — bound to one surface key over
// the attach transport (`TerminalSurfaceSession`, WP3's frame contract with
// its ack window), wearing the appearance's font, line height, margin, scroll
// sensitivity and ANSI palette, and covered by "Connecting…" or the failure
// with Retry while it has no live attachment.
//
// Three kinds of surface use it: a Workspace's editor area in terminal mode
// (`workspace-terminal:<id>`, the `ws-` session), a terminal Agent
// (`agent:<id>`), and an Agent's own terminal (`terminal:<id>`, `tm-`).
//
// It does not decide where it goes or whether it is shown: the window's
// layout owner sets its frame and `isHidden` (`setShown`). A pane that comes
// back on screen while disconnected reconnects once (`cameOnScreen`).

import AppKit
import DevHubCore
import SwiftTerm

/// What a pane is, for the keyboard and the window's pane focus.
enum TerminalPaneRole: Equatable {
    /// Terminal mode's editor area.
    case editor(workspaceId: String)
    /// A terminal Agent's own surface, in the Agents' view.
    case agent(agentId: String)
    /// An Agent's terminal, beside or under it.
    case agentTerminal(terminalId: String)

    var focus: ContentFocus {
        switch self {
        case .editor: return .editor
        case .agent: return .agents
        case let .agentTerminal(id): return .terminal(id)
        }
    }

    /// Which surface a key landing in it has landed on.
    var keySurface: KeySurface {
        switch self {
        case .agent: return .agents
        case .editor, .agentTerminal: return .pane
        }
    }
}

/// SwiftTerm's view, named so the window knows a terminal has the keyboard.
final class DevHubTerminalView: TerminalView {
    weak var pane: TerminalPaneView?
    override var mouseDownCanMoveWindow: Bool { false }
}

@MainActor
final class TerminalPaneView: NSView, TerminalViewDelegate {
    /// `scrollback: 10_000`.
    static let scrollback = 10_000
    /// `MAX_AXIS`: a grid larger than this is a measurement gone wrong.
    static let maxAxis = 500

    let role: TerminalPaneRole
    let surfaceKey: String
    let label: String
    let terminal: DevHubTerminalView
    private let session: TerminalSurfaceSession
    private var style: ShellStyle
    private let cover: SurfaceStateView
    private var shown = false
    private var pendingSize: DevHubCore.TerminalSize?
    private var lastError: String?
    /// Links the person activates (`openExternalUrl`).
    var onOpenLink: ((String) -> Void)?
    /// The view was clicked into (`paneFocused`).
    var onFocused: ((TerminalPaneRole) -> Void)?
    /// Bytes for the log.
    var onLog: ((String) -> Void)?

    init(
        role: TerminalPaneRole, surfaceKey: String, label: String, viewLabel: String, transport: TerminalAttachTransport,
        style: ShellStyle
    ) {
        self.role = role
        self.surfaceKey = surfaceKey
        self.label = label
        self.style = style
        terminal = DevHubTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 400))
        cover = SurfaceStateView(style: style)
        session = TerminalSurfaceSession(
            surfaceKey: surfaceKey, viewLabel: viewLabel, transport: transport, clock: DispatchSurfaceClock(),
            deliver: { work in DispatchQueue.main.async(execute: work) })
        super.init(frame: .zero)
        wantsLayer = true
        terminal.pane = self
        terminal.terminalDelegate = self
        terminal.changeScrollback(Self.scrollback)
        terminal.optionAsMetaKey = false
        terminal.getTerminal().setCursorStyle(.blinkBlock)
        terminal.setAccessibilityLabel("\(label) terminal")
        addSubview(terminal)
        addSubview(cover)
        cover.show(.waiting("Connecting…"))
        session.onConnection = { [weak self] connection in
            MainActor.assumeIsolated { self?.connectionChanged(connection) }
        }
        session.onOutput = { [weak self] bytes in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.terminal.feed(byteArray: ArraySlice([UInt8](bytes)))
            }
        }
        session.onLog = { [weak self] line in
            MainActor.assumeIsolated { self?.onLog?(line) }
        }
        applyStyle(style)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    var connection: TerminalConnection { session.connection }
    var isAttached: Bool { session.isAttached }

    /// Start the attachment. Called once the pane is in the window.
    func start() {
        session.attach(size: currentSize() ?? DevHubCore.TerminalSize(cols: 80, rows: 24))
    }

    /// Start over on a fresh attach: the screen cleared, as a new view's
    /// would be (`reloadPage`), and attaching makes the session again when
    /// it has gone.
    func startOver() {
        terminal.feed(text: "\u{1b}c")
        session.retry()
    }

    /// The view is going away: let go of exactly the handle it holds.
    func dispose() {
        session.dispose()
        terminal.terminalDelegate = nil
    }

    /// Shown or hidden by the layout owner.
    func setShown(_ visible: Bool) {
        isHidden = !visible
        if visible == shown { return }
        shown = visible
        if visible {
            if let pendingSize {
                self.pendingSize = nil
                session.resize(pendingSize)
            } else if let size = currentSize() {
                session.resize(size)
            }
            session.cameOnScreen()
        }
    }

    var isShown: Bool { shown }

    /// Put the keyboard in the terminal (or on Retry when there is no terminal).
    func focus() {
        guard let window else { return }
        if case .disconnected = session.connection, let button = cover.primaryButton {
            window.makeFirstResponder(button)
            return
        }
        window.makeFirstResponder(terminal)
    }

    /// Whether `responder` is this pane's (the terminal or its cover).
    func owns(_ responder: NSResponder?) -> Bool {
        guard let view = responder as? NSView else { return false }
        return view === terminal || view.isDescendant(of: self)
    }

    // MARK: Appearance

    func applyStyle(_ style: ShellStyle) {
        self.style = style
        let palette = style.terminalPalette()
        let background = TerminalPalette.ns(palette.background) ?? style.tokens.surface.nsColor
        layer?.backgroundColor = background.cgColor
        terminal.nativeBackgroundColor = background
        terminal.nativeForegroundColor = TerminalPalette.ns(palette.foreground) ?? style.tokens.primary.nsColor
        if let caret = TerminalPalette.ns(palette.cursor) { terminal.caretColor = caret }
        terminal.caretTextColor = TerminalPalette.ns(palette.cursorText)
        if let selection = TerminalPalette.ns(palette.selectionBackground) { terminal.selectedTextBackgroundColor = selection }
        let ansi = palette.ansi.compactMap { css -> SwiftTerm.Color? in
            guard let color = DevHubColor(css: css) else { return nil }
            func channel(_ value: Double) -> UInt16 { UInt16(max(0, min(1, value)) * 65535) }
            return SwiftTerm.Color(red: channel(color.red), green: channel(color.green), blue: channel(color.blue))
        }
        if ansi.count == 16 { terminal.installColors(ansi) }
        let font = style.terminalFont()
        if terminal.font != font { terminal.font = font }
        let spacing = CGFloat(style.terminal.lineHeight)
        if terminal.lineSpacing != spacing { terminal.lineSpacing = spacing }
        terminal.scrollSensitivity = CGFloat(style.terminal.scrollSensitivity)
        cover.restyle(style)
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let margin = CGFloat(TerminalAppearance.paintedMargin(style.terminal.margin))
        terminal.frame = bounds.insetBy(dx: margin, dy: margin).integral
        cover.frame = bounds
    }

    private func currentSize() -> DevHubCore.TerminalSize? {
        let grid = terminal.getTerminal()
        let cols = min(Self.maxAxis, max(1, grid.cols))
        let rows = min(Self.maxAxis, max(1, grid.rows))
        let size = DevHubCore.TerminalSize(cols: cols, rows: rows)
        return size.isValid ? size : nil
    }

    // MARK: Connection

    private func connectionChanged(_ connection: TerminalConnection) {
        switch connection {
        case .connected:
            cover.isHidden = true
            lastError = nil
        case .connecting:
            cover.isHidden = false
            cover.show(.waiting("Connecting…"))
        case let .disconnected(reason):
            lastError = reason
            cover.isHidden = false
            cover.show(.failure(
                title: TerminalConnection.notConnected, detail: reason,
                actions: [SurfaceAction(label: "Retry", primary: true) { [weak self] in self?.session.retry() }]))
        }
    }

    // MARK: TerminalViewDelegate

    nonisolated func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        MainActor.assumeIsolated {
            let size = DevHubCore.TerminalSize(cols: min(Self.maxAxis, max(1, newCols)), rows: min(Self.maxAxis, max(1, newRows)))
            guard size.isValid else { return }
            // A hidden pane is not measured: what it is told is its size on
            // screen, once it is back there.
            if !shown {
                pendingSize = size
                return
            }
            session.resize(size)
        }
    }

    nonisolated func setTerminalTitle(source: TerminalView, title: String) {}

    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    nonisolated func send(source: TerminalView, data: ArraySlice<UInt8>) {
        let bytes = Data(data)
        MainActor.assumeIsolated { session.input(bytes) }
    }

    nonisolated func scrolled(source: TerminalView, position: Double) {}

    nonisolated func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}

    nonisolated func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        MainActor.assumeIsolated { onOpenLink?(link) }
    }

    nonisolated func bell(source: TerminalView) {}

    /// OSC 52 (`@xterm/addon-clipboard`): the system clipboard, never the
    /// primary selection; a read is refused (the delegate's default).
    nonisolated func clipboardCopy(source: TerminalView, content: Data) {
        guard let text = String(data: content, encoding: .utf8) else { return }
        MainActor.assumeIsolated {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
    }

    /// What the emulator holds, as text (the self-test reads it).
    func screenText() -> String {
        String(decoding: terminal.getTerminal().getBufferAsData(), as: UTF8.self)
    }

    /// Type `text` as the keyboard would (the self-test types with it).
    func type(_ text: String) {
        terminal.send(txt: text)
    }

    /// The Mac's editing chords, as the bytes Ghostty's keybinds send
    /// (`editingSequence`), straight to the session.
    func sendEditingSequence(_ bytes: [UInt8]) {
        session.input(Data(bytes))
    }
}
