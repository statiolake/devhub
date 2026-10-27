// Port of main/shell/keyboard.ts (`handleInput`, `installKeyboard`), with
// historyKeys.ts, terminalZoom.ts, editingCommands.ts and shell/surfaces/keys.ts
// as Core decides them (`KeyRouter`, `ShellKeys`): one NSEvent local monitor
// in front of every surface, so a chord is the app's before any view sees it.
//
//   Cmd+Q             armed (the input source made ASCII-capable meanwhile)
//   Cmd+Q <key>       the command, or nothing (abandoned)
//   Cmd+Q Cmd+Q       quits (`forward_prefix` lets the second one through)
//   anything else     the surface's, unless it is Back/Forward, the terminal
//                     zoom or one of the Mac's editing keys on DevHub's chrome
//
// The mouse's side buttons and the trackpad's swipe are history too.

import AppKit
import DevHubCore

/// What the keyboard needs from the window.
@MainActor
protocol ChordHost: AnyObject {
    /// Which surface the keyboard is on, for a key in `window`.
    func keySurface(for window: NSWindow?) -> KeySurface
    /// The command a chord completed (`runCommand`). False: it did nothing.
    @discardableResult
    func runCommand(_ id: CommandId) -> Bool
    /// `Cmd+[` / `Cmd+]`, a side button, a swipe. False: declined.
    func navigateHistory(_ direction: NavigationDirection) -> Bool
    /// `Cmd+-` and friends over a terminal. False: declined.
    func terminalZoom(_ direction: TerminalZoom.Direction) -> Bool
    /// The prefix was armed or let go of (the Sidebar's digits).
    func chordArmedChanged(_ armed: Bool)
    /// The terminal pane the keyboard is in, if it is in one.
    func focusedTerminalPane() -> TerminalPaneView?
    /// A failure to say (the input source could not be switched).
    func report(_ error: Error)
}

@MainActor
final class ChordDispatcher: ArmingListener {
    private weak var host: ChordHost?
    private var router: KeyRouter!
    private var inputSource: ChordInputSource?
    private var monitors: [Any] = []
    private var resignObserver: NSObjectProtocol?

    init(host: ChordHost, layout: ChordLayout, inputSources: InputSourcePort?) {
        self.host = host
        router = KeyRouter(layout: layout, listener: self)
        if let inputSources {
            inputSource = ChordInputSource(port: inputSources) { [weak self] error in
                MainActor.assumeIsolated { self?.host?.report(error) }
            }
        }
    }

    var isArmed: Bool { router.isArmed }

    func setLayout(_ layout: ChordLayout) {
        if layout != router.currentLayout { router.setLayout(layout) }
    }

    nonisolated func armed() {
        MainActor.assumeIsolated {
            inputSource?.armed()
            host?.chordArmedChanged(true)
        }
    }

    nonisolated func disarmed() {
        MainActor.assumeIsolated {
            inputSource?.disarmed()
            host?.chordArmedChanged(false)
        }
    }

    func install() {
        guard monitors.isEmpty else { return }
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown], handler: { [weak self] event in
            Self.hop(event) { [weak self] event in
                // Not `self?.handleKey(event) ?? event`: that turns the nil
                // that swallows a key back into the key.
                guard let self else { return event }
                return self.handleKey(event)
            }
        }) {
            monitors.append(monitor)
        }
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: [.otherMouseDown], handler: { [weak self] event in
            Self.hop(event) { [weak self] event in
                // Not `self?.handleButton(event) ?? event`: that turns the nil
                // that swallows a key back into the key.
                guard let self else { return event }
                return self.handleButton(event)
            }
        }) {
            monitors.append(monitor)
        }
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: [.swipe], handler: { [weak self] event in
            Self.hop(event) { [weak self] event in
                // Not `self?.handleSwipe(event) ?? event`: that turns the nil
                // that swallows a key back into the key.
                guard let self else { return event }
                return self.handleSwipe(event)
            }
        }) {
            monitors.append(monitor)
        }
        // `did-resign-active`: a key pressed in another app is not DevHub's
        // to complete a chord with.
        resignObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.router.leave() }
        }
    }

    func uninstall() {
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        monitors = []
        if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }
        resignObserver = nil
        router.leave()
    }

    /// Run `handle` on the main actor, where AppKit calls a monitor anyway.
    nonisolated private static func hop(_ event: NSEvent, _ handle: @escaping @MainActor @Sendable (NSEvent) -> NSEvent?) -> NSEvent? {
        nonisolated(unsafe) let incoming = event
        nonisolated(unsafe) var outgoing: NSEvent? = event
        MainActor.assumeIsolated { outgoing = handle(incoming) }
        return outgoing
    }

    /// One key event as the router sees it (`strokeOf`).
    static func stroke(_ event: NSEvent) -> KeyStroke {
        let flags = event.modifierFlags
        return MacKeys.stroke(
            characters: event.charactersIgnoringModifiers, keyCode: event.keyCode, command: flags.contains(.command),
            control: flags.contains(.control), option: flags.contains(.option), shift: flags.contains(.shift),
            isAutoRepeat: event.isARepeat)
    }

    /// Where the self-test hears what became of each key.
    nonisolated(unsafe) static var trace: ((String) -> Void)?

    /// `handleInput`: nil swallows the key.
    func handleKey(_ event: NSEvent) -> NSEvent? {
        guard let host else { return event }
        let surface = host.keySurface(for: event.window)
        // Somebody else's window (an alert, an open panel): theirs entirely.
        if surface == .other { return event }
        let stroke = Self.stroke(event)
        let decision = router.route(stroke)
        Self.trace?("chord: \(stroke.key ?? "?") on \(surface.rawValue): \(decision)")
        switch decision {
        case .forward:
            // `forward_prefix`: the real Command-Q, which is the Mac's Quit.
            NSApp.terminate(nil)
            return nil
        case .pass:
            if let meaning = ShellKeys.passMeaning(surface, stroke) {
                switch meaning {
                case let .history(direction):
                    if host.navigateHistory(direction) { return nil }
                case let .zoom(direction):
                    if host.terminalZoom(direction) { return nil }
                case let .editing(role):
                    if perform(role, in: event.window) { return nil }
                }
            }
            // The Mac's editing chords inside a terminal, as Ghostty sends them.
            if let pane = host.focusedTerminalPane() {
                let flags = event.modifierFlags
                if let bytes = ShellKeys.terminalEditingSequence(
                    key: stroke.key?.lowercased(), command: flags.contains(.command), option: flags.contains(.option),
                    control: flags.contains(.control), shift: flags.contains(.shift))
                {
                    pane.sendEditingSequence(bytes)
                    return nil
                }
            }
            return event
        case .consume, .armed, .cancelled:
            return nil
        case let .run(commandId):
            host.runCommand(commandId)
            return nil
        }
    }

    /// `contents[role]()`: the editing command, down the responder chain.
    private func perform(_ role: EditingRole, in window: NSWindow?) -> Bool {
        let selector: Selector
        switch role {
        case .undo: selector = Selector(("undo:"))
        case .redo: selector = Selector(("redo:"))
        case .cut: selector = #selector(NSText.cut(_:))
        case .copy: selector = #selector(NSText.copy(_:))
        case .paste: selector = #selector(NSText.paste(_:))
        case .pasteAndMatchStyle: selector = #selector(NSTextView.pasteAsPlainText(_:))
        case .delete: selector = #selector(NSText.delete(_:))
        case .selectAll: selector = #selector(NSText.selectAll(_:))
        }
        return NSApp.sendAction(selector, to: nil, from: window)
    }

    private func handleButton(_ event: NSEvent) -> NSEvent? {
        guard let host, let direction = ShellKeys.mouseButtonDirection(event.buttonNumber) else { return event }
        guard ShellKeys.isAppHistorySurface(host.keySurface(for: event.window)) else { return event }
        return host.navigateHistory(direction) ? nil : event
    }

    private func handleSwipe(_ event: NSEvent) -> NSEvent? {
        guard let host, let direction = ShellKeys.swipeDirection(deltaX: Double(event.deltaX)) else { return event }
        guard ShellKeys.isAppHistorySurface(host.keySurface(for: event.window)) else { return event }
        return host.navigateHistory(direction) ? nil : event
    }
}
