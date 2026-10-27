// What the self-test's end-to-end phase does with its hands: keys and clicks
// posted into the application's own event queue (`NSApp.postEvent`), so
// they arrive the way a person's do — through the local monitors (the chord
// dispatcher, dictation's ⌘⇧M, a pane's ⌘F), the main menu's key
// equivalents, the key window and its first responder — and checks that wait
// for what should follow, each with a deadline.

import AppKit
import DevHubCore

@MainActor
final class SelfTestDriver {
    private(set) var failures: [String] = []
    private let prefix: String

    init(prefix: String) { self.prefix = prefix }

    func check(_ ok: Bool, _ what: @autoclosure () -> String) {
        if !ok {
            let line = "\(prefix): \(what())"
            failures.append(line)
            print("self-test FAILED \(line)")
        }
    }

    func note(_ line: String) { print("self-test \(prefix): \(line)") }

    func pause(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    /// Wait for `condition`, up to `seconds`.
    func until(_ seconds: Double, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            await pause(0.05)
        }
        return condition()
    }

    /// `until`, and a failure saying `what` when it never came.
    @discardableResult
    func expect(_ seconds: Double, _ what: @autoclosure () -> String, _ condition: () -> Bool) async -> Bool {
        let ok = await until(seconds, condition)
        check(ok, what())
        return ok
    }

    // MARK: The keyboard

    /// A US keyboard's key codes, for the characters the self-test types.
    static let codes: [Character: UInt16] = {
        var table: [Character: UInt16] = [:]
        let rows: [(String, [UInt16])] = [
            ("asdfhgzxcv", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
            ("bqweryt", [11, 12, 13, 14, 15, 16, 17]),
            ("123465=97-80]ou[ip", [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]),
            ("lj'k;\\,/nm.", [37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47]),
        ]
        for (characters, codes) in rows {
            for (character, code) in zip(characters, codes) { table[character] = code }
        }
        table[" "] = 49
        table["`"] = 50
        return table
    }()

    /// The shifted characters, by the key they are on.
    static let shifted: [Character: Character] = [
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
        "_": "-", "+": "=", "{": "[", "}": "]", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "|": "\\", "~": "`",
    ]

    enum Key {
        case character(Character)
        case returnKey, escape, tab, delete, up, down, left, right, f3

        var code: UInt16 {
            switch self {
            case let .character(character):
                let base = SelfTestDriver.shifted[character] ?? Character(character.lowercased())
                return SelfTestDriver.codes[base] ?? 0
            case .returnKey: return 36
            case .escape: return 53
            case .tab: return 48
            case .delete: return 51
            case .up: return 126
            case .down: return 125
            case .left: return 123
            case .right: return 124
            case .f3: return 99
            }
        }

        var characters: String {
            switch self {
            case let .character(character): return String(character)
            case .returnKey: return "\r"
            case .escape: return "\u{1b}"
            case .tab: return "\t"
            case .delete: return "\u{7f}"
            case .up: return String(Character(UnicodeScalar(UInt32(NSUpArrowFunctionKey))!))
            case .down: return String(Character(UnicodeScalar(UInt32(NSDownArrowFunctionKey))!))
            case .left: return String(Character(UnicodeScalar(UInt32(NSLeftArrowFunctionKey))!))
            case .right: return String(Character(UnicodeScalar(UInt32(NSRightArrowFunctionKey))!))
            case .f3: return String(Character(UnicodeScalar(UInt32(NSF3FunctionKey))!))
            }
        }

        var shift: Bool {
            guard case let .character(character) = self else { return false }
            return SelfTestDriver.shifted[character] != nil || (character.isLetter && character.isUppercase)
        }

        var function: Bool {
            switch self {
            case .up, .down, .left, .right, .f3: return true
            default: return false
            }
        }
    }

    /// The window keys go to: DevHub's key window, made so when it is not.
    func keyWindow(_ window: NSWindow?) -> NSWindow? {
        guard let window else { return nil }
        if !window.isKeyWindow {
            NSApp.activate()
            window.makeKeyAndOrderFront(nil)
        }
        return window
    }

    /// One key pressed and let go in `window`, as the keyboard sends it.
    func press(_ key: Key, _ flags: NSEvent.ModifierFlags = [], in window: NSWindow?) async {
        guard let window = keyWindow(window) else { return check(false, "there is no window to type into") }
        var modifiers = flags
        if key.shift { modifiers.insert(.shift) }
        if key.function { modifiers.insert([.function, .numericPad]) }
        let characters = key.characters
        // What the keyboard reports without the modifiers but Shift.
        let ignoring = modifiers.contains(.shift) ? characters : characters.lowercased()
        let plain = flags.intersection([.command, .control, .option]).isEmpty ? characters : ignoring
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let event = NSEvent.keyEvent(
                with: type, location: .zero, modifierFlags: modifiers, timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, characters: plain, charactersIgnoringModifiers: ignoring,
                isARepeat: false, keyCode: key.code)
            else { return check(false, "the key event for \(characters) could not be made") }
            NSApp.postEvent(event, atStart: false)
        }
        await pause(0.03)
    }

    /// Type `text`, one key at a time.
    func type(_ text: String, in window: NSWindow?) async {
        for character in text {
            if character == "\n" || character == "\r" {
                await press(.returnKey, in: window)
            } else {
                await press(.character(character), in: window)
            }
        }
        await pause(0.1)
    }

    /// `Cmd+Q` then `second`: one of DevHub's chords.
    func chord(_ second: Character, in window: NSWindow?) async {
        await press(.character("q"), [.command], in: window)
        await press(.character(second), in: window)
        await pause(0.15)
    }

    /// ⌘ and a key: through the menu's key equivalents when one is there.
    func command(_ character: Character, _ more: NSEvent.ModifierFlags = [], in window: NSWindow?) async {
        await press(.character(character), [.command].union(more), in: window)
        await pause(0.1)
    }

    // MARK: The pointer

    /// A click in the middle of `view` (or at `point` in its coordinates).
    func click(_ view: NSView, at point: NSPoint? = nil, count: Int = 1) async {
        guard let window = keyWindow(view.window) else { return check(false, "\(Swift.type(of: view)) is not in a window") }
        let local = point ?? NSPoint(x: view.bounds.midX, y: view.bounds.midY)
        let location = view.convert(local, to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            guard let event = NSEvent.mouseEvent(
                with: type, location: location, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: count, pressure: type == .leftMouseDown ? 1 : 0)
            else { return check(false, "the click could not be made") }
            NSApp.postEvent(event, atStart: false)
        }
        await pause(0.15)
    }

    // MARK: Finding views

    /// Every view under `root` of type `T`, depth first.
    static func views<T: NSView>(_ type: T.Type, in root: NSView?) -> [T] {
        guard let root else { return [] }
        var found: [T] = []
        var stack = [root]
        while let view = stack.popLast() {
            if let match = view as? T { found.append(match) }
            stack.append(contentsOf: view.subviews.reversed())
        }
        return found
    }

    /// The first control under `root` whose accessible name is `label`.
    static func control<T: NSView>(_ type: T.Type, labelled label: String, in root: NSView?) -> T? {
        views(type, in: root).first { $0.accessibilityLabel() == label }
    }

    /// The first button under `root` titled `title`.
    static func button(_ title: String, in root: NSView?) -> NSButton? {
        views(NSButton.self, in: root).first { $0.title == title || $0.accessibilityLabel() == title }
    }

    // MARK: Processes

    /// Run a program to its end; what it printed.
    @discardableResult
    static func run(_ executable: String, _ arguments: [String], environment: [String: String]? = nil) -> (code: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let environment { process.environment = environment }
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do { try process.run() } catch { return (-1, "\(error)") }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}
