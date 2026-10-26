// Port of apps/desktop/src/main/shell/keyRouter.ts, the pure half of
// keyboard.ts (`handleInput`'s decision), historyKeys.ts, terminalZoom.ts,
// editingCommands.ts, chordInputSource.ts and shell/surfaces/keys.ts.
//
// Command-Q is a prefix, not a shortcut.
//
// DevHub's surfaces are whole applications in their own right — a terminal, a
// conversation — and they want their own keys. Quitting on a single
// Command-Q, next to a surface where Command-W closes a tab, is a keypress away
// from losing everything unsaved. So the first Command-Q only arms; the second
// stroke is looked up in the chord table (`Commands` holds the commands and the
// reasoning, `Chords` resolves one against the model), and `forward_prefix` is
// the command that passes a real Command-Q through, which is what actually
// quits.
//
// Outside an armed prefix this router has no power at all: it never invents a
// key event, and composition, marked text and every shortcut a surface defines
// travel as they always did.
//
// It says when the prefix is armed and when it stops being (`ArmingListener`),
// every time and for every reason, because one thing outside it has to follow
// the arming exactly: the input source, which is ASCII-capable for as long as
// a chord is armed (`ChordInputSource`).

import Foundation

/// What the router decided about one key.
public enum RouteDecision: Equatable, Sendable {
    /// Swallow it: it must never reach a surface.
    case consume
    /// Swallow it, and arm the prefix until the next key.
    case armed
    /// Let it through as an ordinary prefix keystroke.
    case forward
    /// Swallow it, and run this command.
    case run(CommandId)
    /// Swallow it: it completed no chord, so the chord is abandoned.
    case cancelled
    /// Leave it entirely alone.
    case pass
}

/// The whole of what the configuration decides about the keyboard.
public struct ChordLayout: Equatable, Sendable {
    public var prefix: ChordKey
    public var table: [KeyBinding]

    public init(prefix: ChordKey, table: [KeyBinding]) {
        self.prefix = prefix
        self.table = table
    }

    /// `defaultChordLayout`.
    public static func defaults() -> ChordLayout {
        // swiftlint:disable:next force_try
        ChordLayout(prefix: try! ChordKeys.parse(Commands.defaultChordPrefix), table: Chords.defaultTable())
    }

    /// The table `[keybindings]` resolves to (`resolveBindings`).
    public static func of(_ spec: KeybindingsSpec?) -> ChordLayout {
        let resolved = Commands.resolve(spec ?? KeybindingsSpec())
        return ChordLayout(prefix: resolved.prefix, table: resolved.bindings)
    }
}

/// Told when the prefix is armed and when it stops being, for any reason.
public protocol ArmingListener: AnyObject {
    func armed()
    func disarmed()
}

public final class KeyRouter {
    public private(set) var isArmed = false
    private var layout: ChordLayout
    private weak var listener: ArmingListener?
    /// A listener the router keeps alive itself (tests, and a closure-built one).
    private var retained: ArmingListener?

    public init(layout: ChordLayout, listener: ArmingListener?, retain: Bool = false) {
        self.layout = layout
        self.listener = listener
        if retain { retained = listener }
    }

    /// Adopt a new table, because the configuration file changed. An armed
    /// prefix is dropped with it: the person armed against the table that was
    /// in effect a moment ago.
    public func setLayout(_ layout: ChordLayout) {
        self.layout = layout
        disarm()
    }

    public var currentLayout: ChordLayout { layout }

    /// Forget an armed prefix, because DevHub stopped being the application in
    /// front. A key pressed in another app is not DevHub's to complete it with.
    public func leave() { disarm() }

    /// The table changing and the application being left are the only things
    /// besides a key that do this. An armed prefix deliberately survives the
    /// keyboard moving between DevHub's own children: there is one queue for
    /// the application, and no timeout.
    private func disarm() {
        if !isArmed { return }
        isArmed = false
        listener?.disarmed()
    }

    private func arm() {
        isArmed = true
        listener?.armed()
    }

    private func isPrefix(_ stroke: KeyStroke) -> Bool {
        guard let spelled = Chords.strokeAs(stroke) else { return false }
        return ChordKeys.same(layout.prefix, spelled)
    }

    public func route(_ stroke: KeyStroke) -> RouteDecision {
        // A bare modifier is not a stroke. Shift arrives as its own key-down
        // before the shifted key; treating it as a stroke abandoned every
        // shifted chord. It neither completes nor cancels, and is not swallowed.
        if ChordKeys.isModifierKey(stroke.code) { return .pass }

        // A held-down prefix is one intention, not many.
        if stroke.isAutoRepeat && isPrefix(stroke) {
            disarm()
            return .consume
        }

        let wasArmed = isArmed
        disarm()
        if wasArmed {
            // Once the prefix is armed the keyboard belongs to the chord layer:
            // a key that completes nothing abandons the chord and goes nowhere.
            guard let binding = Chords.match(layout.table, stroke) else { return .cancelled }
            if binding.commandId == .forwardPrefix { return .forward }
            return .run(binding.commandId)
        }
        if isPrefix(stroke) {
            arm()
            return .armed
        }
        return .pass
    }
}

// MARK: - Which surface a key landed on

/// Which of DevHub's children holds the keyboard when a key arrives — the
/// native counterpart of the URL `keyboard.ts` asked each web contents for.
public enum KeySurface: String, Sendable, Hashable, CaseIterable {
    /// The window's own view: the title bar, the surface states, the seams.
    case shell
    case sidebar
    /// The Agents' view: a terminal Agent's surface or a GUI Agent's.
    case agents
    /// A terminal pane: an Agent's own terminal, or a Workspace's editor area.
    case pane
    /// The questions layer.
    case picker
    /// The notices layer.
    case toasts
    /// The Settings window.
    case settings
    /// Somebody else's window (an open panel, an alert).
    case other

    /// DevHub's own chrome, which answers the Mac's editing keys itself.
    var isShellChrome: Bool { self != .other }
}

/// What a key that is not a chord may still mean (`handleInput`'s pass branch).
public enum PassMeaning: Equatable, Sendable {
    case history(NavigationDirection)
    case zoom(TerminalZoom.Direction)
    case editing(EditingRole)
}

/// One of the Mac's editing commands (`EditingRole`).
public enum EditingRole: String, Sendable, Hashable, CaseIterable {
    case undo, redo, cut, copy, paste, pasteAndMatchStyle, delete, selectAll
}

public struct EditingCommand: Equatable, Sendable {
    public var role: EditingRole
    /// The key it is reached by, if any. Absent: menu only.
    public var key: String?
    public var shift: Bool

    public init(_ role: EditingRole, key: String? = nil, shift: Bool = false) {
        self.role = role
        self.key = key
        self.shift = shift
    }
}

public enum ShellKeys {
    /// `EDITING_COMMAND_GROUPS`: the Edit menu's items, in its groups.
    public static let editingGroups: [[EditingCommand]] = [
        [EditingCommand(.undo, key: "z"), EditingCommand(.redo, key: "z", shift: true)],
        [
            EditingCommand(.cut, key: "x"), EditingCommand(.copy, key: "c"), EditingCommand(.paste, key: "v"),
            EditingCommand(.pasteAndMatchStyle), EditingCommand(.delete), EditingCommand(.selectAll, key: "a"),
        ],
    ]

    /// `editingCommandFor`: one of the Mac's editing keys landing on DevHub's
    /// own chrome. Modifiers are matched exactly.
    public static func editingCommand(_ surface: KeySurface, _ stroke: KeyStroke) -> EditingCommand? {
        guard surface.isShellChrome else { return nil }
        if !stroke.command || stroke.option || stroke.control { return nil }
        return editingGroups.flatMap { $0 }.first { command in
            guard let key = command.key, let pressed = stroke.key else { return false }
            return key.lowercased() == pressed.lowercased() && command.shift == stroke.shift
        }
    }

    /// The surfaces where the app's history is the only one there is: the
    /// window's own view, the Sidebar, the Agents and every terminal pane.
    public static func isAppHistorySurface(_ surface: KeySurface) -> Bool {
        surface == .shell || surface == .sidebar || surface == .agents || surface == .pane
    }

    /// `historyDirectionFor`: `Cmd+[` / `Cmd+]`, matched by the character.
    public static func historyDirection(_ surface: KeySurface, _ stroke: KeyStroke) -> NavigationDirection? {
        guard isAppHistorySurface(surface) else { return nil }
        if !stroke.command || stroke.option || stroke.control || stroke.shift { return nil }
        if stroke.key == "[" { return .back }
        if stroke.key == "]" { return .forward }
        return nil
    }

    /// `swipeDirection`: swiping left goes Back, as in Safari.
    public static func swipeDirection(deltaX: Double) -> NavigationDirection? {
        // AppKit reports a swipe to the left as a positive deltaX.
        if deltaX > 0 { return .back }
        if deltaX < 0 { return .forward }
        return nil
    }

    /// The mouse's side buttons: button 3 is Back, button 4 is Forward
    /// (`shell/historyButtons.ts`).
    public static func mouseButtonDirection(_ buttonNumber: Int) -> NavigationDirection? {
        switch buttonNumber {
        case 3: return .back
        case 4: return .forward
        default: return nil
        }
    }

    /// `terminalZoomFor`: Cmd+-, Cmd+Shift+- and Cmd+Shift+0, matched by the
    /// physical key, and only over the panes whose text is a terminal's.
    public static func terminalZoom(_ surface: KeySurface, _ stroke: KeyStroke) -> TerminalZoom.Direction? {
        guard surface == .agents || surface == .pane else { return nil }
        if !stroke.command || stroke.option || stroke.control { return nil }
        if stroke.code == "Minus" { return stroke.shift ? .zoomIn : .zoomOut }
        if stroke.code == "Digit0" && stroke.shift { return .reset }
        return nil
    }

    /// The order `handleInput` asks in: history first, the zoom second, the
    /// editing keys last — each a narrower claim than the next.
    public static func passMeaning(_ surface: KeySurface, _ stroke: KeyStroke) -> PassMeaning? {
        if let direction = historyDirection(surface, stroke) { return .history(direction) }
        if let zoom = terminalZoom(surface, stroke) { return .zoom(zoom) }
        if let editing = editingCommand(surface, stroke) { return .editing(editing.role) }
        return nil
    }

    /// `editingSequence` (shell/surfaces/keys.ts): the Mac editing chords sent
    /// to a terminal as the bytes Ghostty's default keybinds send.
    public static func terminalEditingSequence(key: String?, command: Bool, option: Bool, control: Bool, shift: Bool) -> [UInt8]? {
        if shift || control { return nil }
        if command && !option {
            switch key {
            case "arrowleft": return [0x01]
            case "arrowright": return [0x05]
            case "backspace": return [0x15]
            default: return nil
            }
        }
        if option && !command {
            switch key {
            case "arrowleft": return [0x1b, 0x62]
            case "arrowright": return [0x1b, 0x66]
            default: return nil
            }
        }
        return nil
    }
}

// MARK: - The input source, while a chord is armed

/// What a switch of the input source did, so it can be undone.
public struct InputSourceSwitch: Equatable, Sendable {
    /// The source that was selected before DevHub's.
    public var previous: String
    /// The ASCII-capable source DevHub selected.
    public var selected: String

    public init(previous: String, selected: String) {
        self.previous = previous
        self.selected = selected
    }
}

/// The machine's input sources, as far as a chord needs them.
public protocol InputSourcePort: AnyObject {
    /// Select an ASCII-capable source. Nil when the current one already is.
    func selectAscii() throws -> InputSourceSwitch?
    /// Put the previous source back, unless the person chose another since.
    @discardableResult
    func restore(_ change: InputSourceSwitch) throws -> Bool
}

/// `ChordInputSource`: ASCII-capable for exactly as long as a chord is armed.
/// A port that fails is said once, and chords go on working for anyone whose
/// input source is already ASCII-capable.
public final class ChordInputSource: ArmingListener {
    private let port: InputSourcePort
    private let report: (Error) -> Void
    /// Whether a chord's switch is held, and what it was.
    private var holding = false
    private var held: InputSourceSwitch?
    private var failed = false

    public init(port: InputSourcePort, report: @escaping (Error) -> Void) {
        self.port = port
        self.report = report
    }

    public func armed() {
        if failed || holding { return }
        holding = true
        held = attempt { try port.selectAscii() } ?? nil
    }

    public func disarmed() {
        guard holding else { return }
        holding = false
        let change = held
        held = nil
        guard let change else { return }
        _ = attempt { try port.restore(change) }
    }

    private func attempt<T>(_ request: () throws -> T) -> T? {
        if failed { return nil }
        do {
            return try request()
        } catch {
            failed = true
            report(error)
            return nil
        }
    }
}

// MARK: - A key event, as the router reads it

/// macOS virtual key codes to the DOM `code` names `ChordKeys` and the zoom
/// keys are written against, and the named keys a stroke may be.
public enum MacKeys {
    /// The `code` of a physical key (the DOM's names, which are the US
    /// layout's positions).
    public static func code(_ keyCode: UInt16) -> String {
        codes[keyCode] ?? "Unidentified"
    }

    static let codes: [UInt16: String] = [
        0x00: "KeyA", 0x01: "KeyS", 0x02: "KeyD", 0x03: "KeyF", 0x04: "KeyH", 0x05: "KeyG", 0x06: "KeyZ", 0x07: "KeyX",
        0x08: "KeyC", 0x09: "KeyV", 0x0A: "IntlBackslash", 0x0B: "KeyB", 0x0C: "KeyQ", 0x0D: "KeyW", 0x0E: "KeyE",
        0x0F: "KeyR", 0x10: "KeyY", 0x11: "KeyT", 0x12: "Digit1", 0x13: "Digit2", 0x14: "Digit3", 0x15: "Digit4",
        0x16: "Digit6", 0x17: "Digit5", 0x18: "Equal", 0x19: "Digit9", 0x1A: "Digit7", 0x1B: "Minus", 0x1C: "Digit8",
        0x1D: "Digit0", 0x1E: "BracketRight", 0x1F: "KeyO", 0x20: "KeyU", 0x21: "BracketLeft", 0x22: "KeyI",
        0x23: "KeyP", 0x24: "Enter", 0x25: "KeyL", 0x26: "KeyJ", 0x27: "Quote", 0x28: "KeyK", 0x29: "Semicolon",
        0x2A: "Backslash", 0x2B: "Comma", 0x2C: "Slash", 0x2D: "KeyN", 0x2E: "KeyM", 0x2F: "Period", 0x30: "Tab",
        0x31: "Space", 0x32: "Backquote", 0x33: "Backspace", 0x35: "Escape", 0x36: "MetaRight", 0x37: "MetaLeft",
        0x38: "ShiftLeft", 0x39: "CapsLock", 0x3A: "AltLeft", 0x3B: "ControlLeft", 0x3C: "ShiftRight",
        0x3D: "AltRight", 0x3E: "ControlRight", 0x3F: "Fn", 0x41: "NumpadDecimal", 0x43: "NumpadMultiply",
        0x45: "NumpadAdd", 0x47: "NumLock", 0x4B: "NumpadDivide", 0x4C: "NumpadEnter", 0x4E: "NumpadSubtract",
        0x51: "NumpadEqual", 0x52: "Numpad0", 0x53: "Numpad1", 0x54: "Numpad2", 0x55: "Numpad3", 0x56: "Numpad4",
        0x57: "Numpad5", 0x58: "Numpad6", 0x59: "Numpad7", 0x5B: "Numpad8", 0x5C: "Numpad9", 0x5D: "IntlYen",
        0x5E: "IntlRo", 0x60: "F5", 0x61: "F6", 0x62: "F7", 0x63: "F3", 0x64: "F8", 0x65: "F9", 0x66: "Lang2",
        0x67: "F11", 0x68: "Lang1", 0x6D: "F10", 0x6F: "F12", 0x72: "Help", 0x73: "Home", 0x74: "PageUp",
        0x75: "Delete", 0x76: "F4", 0x77: "End", 0x78: "F2", 0x79: "PageDown", 0x7A: "F1", 0x7B: "ArrowLeft",
        0x7C: "ArrowRight", 0x7D: "ArrowDown", 0x7E: "ArrowUp",
    ]

    /// The DOM `key` of an event: the character it produced with Shift (and
    /// the layout) applied — AppKit's `charactersIgnoringModifiers` — or the
    /// name of a key that produces none.
    public static func key(characters: String?, keyCode: UInt16) -> String {
        if let named = namedKeys[keyCode] { return named }
        guard let characters, let scalar = characters.unicodeScalars.first else { return "Unidentified" }
        switch scalar.value {
        case 0xF700: return "ArrowUp"
        case 0xF701: return "ArrowDown"
        case 0xF702: return "ArrowLeft"
        case 0xF703: return "ArrowRight"
        case 0xF704...0xF726: return "F\(scalar.value - 0xF703)"
        case 0xF728: return "Delete"
        case 0xF729: return "Home"
        case 0xF72B: return "End"
        case 0xF72C: return "PageUp"
        case 0xF72D: return "PageDown"
        case 0x1B: return "Escape"
        case 0x09, 0x19: return "Tab"
        case 0x0D, 0x03: return "Enter"
        case 0x7F, 0x08: return "Backspace"
        default:
            if scalar.value < 0x20 { return "Unidentified" }
            return characters
        }
    }

    /// Keys whose name does not depend on the layout.
    static let namedKeys: [UInt16: String] = [
        0x24: "Enter", 0x30: "Tab", 0x33: "Backspace", 0x35: "Escape", 0x4C: "Enter", 0x73: "Home", 0x74: "PageUp",
        0x75: "Delete", 0x77: "End", 0x79: "PageDown", 0x7B: "ArrowLeft", 0x7C: "ArrowRight", 0x7D: "ArrowDown",
        0x7E: "ArrowUp", 0x38: "Shift", 0x3C: "Shift", 0x3B: "Control", 0x3E: "Control", 0x3A: "Alt", 0x3D: "Alt",
        0x37: "Meta", 0x36: "Meta", 0x39: "CapsLock",
    ]

    /// One key event as the router sees it (`strokeOf`).
    public static func stroke(
        characters: String?, keyCode: UInt16, command: Bool, control: Bool, option: Bool, shift: Bool, isAutoRepeat: Bool
    ) -> KeyStroke {
        KeyStroke(
            key: ChordKeys.strokeKey(key(characters: characters, keyCode: keyCode)),
            code: code(keyCode), command: command, control: control, option: option, shift: shift,
            isAutoRepeat: isAutoRepeat
        )
    }
}
