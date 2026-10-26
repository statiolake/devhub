// Port of apps/desktop/src/model/chordKeys.ts
//
// How a chord's second stroke is written down, in one grammar.
//
// DevHub's commands are two-stroke chords (see `Commands`), and the second
// stroke has to be spelled three times over: in the defaults DevHub ships, in
// the `[keybindings.chords]` table a person writes, and in the Settings window
// that shows both. One parser, so those three cannot disagree.
//
// # A stroke is the character it produces
//
// `{`, not `Shift+[` and not `Shift+bracketleft`. `N`, not `Shift+n`. `<`, not
// `Shift+,`. Matching the *physical key* breaks on a JIS keyboard, which does
// not put punctuation where a US one does; the character has neither problem:
// the layout and the modifiers have already been applied by the time it
// arrives, so `{` is `{` on every keyboard that can produce one.
//
// # Shift is part of the character, where there is a character
//
// `Shift+n` and `N` are the same stroke, and the canonical spelling is `N`. A
// stroke with no character to fold Shift into (`Escape`, `Tab`, `ArrowLeft`)
// keeps Shift as a flag. The `Shift+<base>` spelling is interpreted with the US
// layout: `Shift+[` is `{`, `Shift+,` is `<` — safe because it is only ever a
// spelling of something the canonical form already says outright.
//
// Command, Control and Option stay as flags on all of them.
//
// Lengths are UTF-16 code units, as `string.length` counts them, so a key
// string is a "character" or a "name" by the same rule in both apps.

import Foundation

/// One stroke: the character it produces, and the modifiers that are not in it.
public struct ChordKey: Equatable, Hashable, Sendable {
    /// The character produced, or the lower-cased name of a key that produces
    /// none (`escape`, `tab`, `arrowleft`).
    public var key: String
    public var command: Bool
    public var control: Bool
    public var option: Bool
    /// Only meaningful for a named key: elsewhere it is in `key`.
    public var shift: Bool

    public init(key: String, command: Bool = false, control: Bool = false, option: Bool = false, shift: Bool = false) {
        self.key = key
        self.command = command
        self.control = control
        self.option = option
        self.shift = shift
    }
}

/// Why a key string is not one. Carried, so the config can say which.
public enum ChordKeyProblem: String, Sendable {
    case empty
    case unknownModifier = "unknown_modifier"
    case duplicateModifier = "duplicate_modifier"
    case missingKey = "missing_key"
    case invalidKey = "invalid_key"
}

public struct ChordKeyError: Error, Equatable, CustomStringConvertible, Sendable {
    public let problem: ChordKeyProblem
    public let text: String
    public var description: String { "\(problem.rawValue): \(text)" }
}

public enum ChordKeys {
    static let modifiers = ["Cmd", "Ctrl", "Alt", "Shift"]

    /// What Shift makes of a character, on a US keyboard. Only for reading the
    /// `Shift+<base>` spelling a person may write in the config.
    static let usShifted: [String: String] = [
        "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*",
        "9": "(", "0": ")", "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"",
        ",": "<", ".": ">", "/": "?",
    ]

    /// Whether this stroke is a modifier and nothing else (a physical key code).
    ///
    /// A bare modifier is not a stroke that can complete or cancel anything —
    /// Shift arrives as its own key-down before the shifted key, and treating it
    /// as a stroke abandoned every shifted chord. It is not a key a person can
    /// bind either.
    public static func isModifierKey(_ code: String) -> Bool {
        let names = ["Shift", "Control", "Alt", "Meta", "OS"]
        for name in names {
            if code == name || code == name + "Left" || code == name + "Right" { return true }
        }
        return code == "CapsLock" || code == "Fn"
    }

    /// The names a key event carries when it produced no character.
    static let noCharacter: Set<String> = ["Process", "Dead", "Unidentified", ""]

    /// What a key event is, as a chord identity — or nothing, for a key that
    /// produced no character and has no name of its own. One character is a
    /// character; anything longer is a key with a name, compared without
    /// regard to case.
    public static func strokeKey(_ key: String) -> String? {
        if noCharacter.contains(key) { return nil }
        return JSString.length(key) == 1 ? key : key.lowercased()
    }

    /// Whether this identity is a key with a name rather than a character.
    static func isNamedKey(_ key: String) -> Bool { JSString.length(key) > 1 }

    static func isKeyToken(_ token: String) -> Bool {
        let length = JSString.length(token)
        if length == 0 { return false }
        if length == 1 { return !token.unicodeScalars.allSatisfy(JSString.isWhitespace) }
        let scalars = Array(token.unicodeScalars)
        guard let first = scalars.first, ("A"..."Z").contains(first) || ("a"..."z").contains(first) else { return false }
        return scalars.allSatisfy { ("A"..."Z").contains($0) || ("a"..."z").contains($0) || ("0"..."9").contains($0) }
    }

    /// `"{"` — or `"Shift+["`, which is the same stroke — as the stroke it names.
    ///
    /// Throwing rather than returning nil because both callers want the reason:
    /// the config turns it into a diagnostic that names the offending key, and
    /// the registry's own test wants the failure to say which default is wrong.
    public static func parse(_ text: String) throws -> ChordKey {
        let trimmed = JSString.trim(text)
        if trimmed.isEmpty { throw ChordKeyError(problem: .empty, text: text) }
        var segments = trimmed.components(separatedBy: "+")
        var keyToken = segments.popLast() ?? ""
        if keyToken.isEmpty {
            // The key *is* the plus sign: `+` splits to two empty segments and
            // `Shift++` to three, so the empty tail and the empty segment
            // before it are together one `+` key.
            if segments.popLast() != "" { throw ChordKeyError(problem: .missingKey, text: text) }
            keyToken = "+"
        }
        var command = false, control = false, option = false, shift = false
        for segment in segments {
            let lowered = JSString.trim(segment).lowercased()
            guard let name = modifiers.first(where: { $0.lowercased() == lowered }) else {
                throw ChordKeyError(problem: .unknownModifier, text: text)
            }
            switch name {
            case "Cmd":
                if command { throw ChordKeyError(problem: .duplicateModifier, text: text) }
                command = true
            case "Ctrl":
                if control { throw ChordKeyError(problem: .duplicateModifier, text: text) }
                control = true
            case "Alt":
                if option { throw ChordKeyError(problem: .duplicateModifier, text: text) }
                option = true
            default:
                if shift { throw ChordKeyError(problem: .duplicateModifier, text: text) }
                shift = true
            }
        }
        let written = JSString.trim(keyToken)
        if !isKeyToken(written) { throw ChordKeyError(problem: .invalidKey, text: text) }
        if isNamedKey(written) {
            // No character to fold Shift into, so it stays a flag.
            return ChordKey(key: written.lowercased(), command: command, control: control, option: option, shift: shift)
        }
        if !shift { return ChordKey(key: written, command: command, control: control, option: option, shift: false) }
        // `Shift+n` is `N`, `Shift+[` is `{`, and `Shift+{` is already `{`: a
        // character with no shifted form of its own is one that has been
        // written shifted already, so it is taken as it stands.
        let isLowerLetter = written.unicodeScalars.count == 1 && ("a"..."z").contains(written.unicodeScalars.first!)
        let shifted = isLowerLetter ? written.uppercased() : usShifted[written]
        return ChordKey(key: shifted ?? written, command: command, control: control, option: option, shift: false)
    }

    static func writtenModifiers(_ chord: ChordKey) -> [String] {
        modifiers.filter { name in
            switch name {
            case "Cmd": return chord.command
            case "Ctrl": return chord.control
            case "Alt": return chord.option
            // Shift is only ever written for a named key. Anywhere else it is
            // in the character, and writing it as well would be saying it twice.
            default: return chord.shift && isNamedKey(chord.key)
            }
        }
    }

    /// The stroke, written back out canonically. `parse(format(k))` equals `k`.
    public static func format(_ chord: ChordKey) -> String {
        (writtenModifiers(chord) + [chord.key]).joined(separator: "+")
    }

    /// The identity two bindings are the same key under. Case matters: `N` and
    /// `n` are different characters produced by the same key with and without
    /// Shift, and folding them would make `Shift+N` and `n` one binding.
    public static func id(_ chord: ChordKey) -> String { format(chord) }

    /// Whether a stroke that arrived is the one a binding names.
    public static func same(_ binding: ChordKey, _ stroke: ChordKey) -> Bool { id(binding) == id(stroke) }

    /// How a chord reads on screen: the character, which is what is printed on
    /// the key the person presses. The arrows are drawn, not spelled.
    static let shown: [String: String] = [
        " ": "Space",
        "arrowup": "↑",
        "arrowdown": "↓",
        "arrowleft": "←",
        "arrowright": "→",
    ]

    public static func describe(_ chord: ChordKey) -> String {
        let display: String
        if let named = shown[chord.key] {
            display = named
        } else if isNamedKey(chord.key) {
            display = chord.key.prefix(1).uppercased() + chord.key.dropFirst()
        } else {
            display = chord.key
        }
        return (writtenModifiers(chord) + [display]).joined(separator: "+")
    }
}
