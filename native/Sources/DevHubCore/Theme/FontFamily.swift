// Port of apps/desktop/src/model/fontFamily.ts and the font-stack half of
// apps/desktop/src/shell/terminal/theme.ts (`terminalFontStack`).
//
// The one rule for a terminal font family.
//
// Three places have an opinion about this value — the config loader that reads
// `settings.toml`, the appearance projection the window renders from, and the
// field in the Settings window someone types into. When each states the rule in
// its own words they drift, and the first symptom is a value one of them
// accepts and another refuses, with a message that names neither.
//
// The value is a CSS `font-family` value — the file is shared with the TS app —
// and a bare name (`Menlo`), a name with spaces (`SF Mono`), a quoted name
// (`"Fira Code"`), or a fallback list (`JetBrains Mono, Menlo, monospace`) are
// all ordinary. DevHub is not the judge of whether a font is installed — an
// unresolvable name simply falls back (`TerminalFontStack.resolve`) — so it
// refuses only the two things that are not a font family at all: nothing, and
// text carrying control characters, which no font name contains and which
// would be re-read as something else on the way through TOML.

import Foundation

public enum FontFamily {
    /// As many characters as DevHub will carry.
    ///
    /// A fallback list of any reasonable length fits well inside this; the
    /// bound is here so a pasted document cannot become the value that every
    /// appearance projection from then on has to carry.
    public static let maxLength = 128

    /// `isValidFontFamily`. Length is counted in code points, as JS's
    /// `[...value].length` counts.
    public static func isValid(_ value: String) -> Bool {
        return !ThemeJS.trim(value).isEmpty
            && value.unicodeScalars.count <= maxLength
            && !value.unicodeScalars.contains { $0.value <= 0x1F || $0.value == 0x7F }
    }

    /// The rule, in the words shown to whoever broke it.
    public static let rule =
        "A font family is a CSS font-family value: a name such as Menlo, a name with spaces such as SF Mono, a quoted name such as \"Fira Code\", or a comma-separated list of them. It cannot be empty, cannot contain control characters, and is at most \(maxLength) characters."
}

/// A terminal font family list, as the panes and every monospace text in the
/// window read it.
public enum TerminalFontStack {
    /// The families appended behind whatever the viewer chose.
    ///
    /// A family name that resolves to nothing must not fall back to the
    /// default font, which on a Japanese system is a proportional CJK face
    /// whose advance widths make a terminal's columns visibly uneven. Ending
    /// the stack in the monospace generic makes that impossible.
    public static let fallbackFamilies = ["ui-monospace", "SFMono-Regular", "SF Mono", "Menlo", "monospace"]

    /// CSS generics must not be quoted, or they are read as family names.
    public static let genericFamilies: Set<String> = [
        "monospace", "ui-monospace", "serif", "sans-serif", "system-ui", "cursive", "fantasy",
    ]

    /// The configured families first, then the fallbacks they do not already
    /// name (case-insensitively), as bare names. Accepts a comma-separated
    /// list, quoted or not.
    public static func families(_ family: String?) -> [String] {
        let chosen = (family ?? "").split(separator: ",", omittingEmptySubsequences: false)
            .map { bareFamily(String($0)) }
            .filter { !$0.isEmpty }
        let seen = Set(chosen.map { $0.lowercased() })
        return chosen + fallbackFamilies.filter { !seen.contains($0.lowercased()) }
    }

    /// `terminalFontStack`: the list written back as a CSS value (an
    /// identifier unquoted, everything else quoted, a generic never quoted).
    public static func css(_ family: String?) -> String {
        families(family).map(quoted).joined(separator: ", ")
    }

    /// The monospace family every DevHub view uses (`--font-mono`) at the
    /// default setting.
    public static let defaultFamily = "ui-monospace"

    /// One entry of a configured list, as a bare family name: the quotes are
    /// CSS syntax, not part of the name. A family called `'Cascadia Code NF'`,
    /// apostrophes included, matches no installed font.
    static func bareFamily(_ part: String) -> String {
        let trimmed = ThemeJS.trim(part)
        let scalars = Array(trimmed.unicodeScalars)
        if scalars.count >= 2, let quote = scalars.first, quote == "\"" || quote == "'", scalars.last == quote {
            let inner = scalars[1..<(scalars.count - 1)]
            var out = String.UnicodeScalarView()
            var index = inner.startIndex
            while index < inner.endIndex {
                // `\\(.)` → `$1`: a backslash and the character after it (not a
                // line terminator, which `.` does not match) is that character.
                if inner[index] == "\\", index + 1 < inner.endIndex, !isLineTerminator(inner[index + 1]) {
                    out.append(inner[index + 1])
                    index += 2
                } else {
                    out.append(inner[index])
                    index += 1
                }
            }
            return ThemeJS.trim(String(out))
        }
        return trimmed
    }

    static func quoted(_ name: String) -> String {
        if genericFamilies.contains(name) { return name }
        if isIdentifier(name) { return name }
        let cleaned = name.replacingOccurrences(of: "\\", with: "").replacingOccurrences(of: "\"", with: "")
        return "\"\(cleaned)\""
    }

    /// `/^[A-Za-z_-][\w-]*$/u`.
    private static func isIdentifier(_ name: String) -> Bool {
        let scalars = Array(name.unicodeScalars)
        guard let first = scalars.first else { return false }
        func letter(_ s: Unicode.Scalar) -> Bool { ("A"..."Z").contains(s) || ("a"..."z").contains(s) }
        guard letter(first) || first == "_" || first == "-" else { return false }
        return scalars.dropFirst().allSatisfy { letter($0) || ("0"..."9").contains($0) || $0 == "_" || $0 == "-" }
    }

    private static func isLineTerminator(_ scalar: Unicode.Scalar) -> Bool {
        scalar == "\n" || scalar == "\r" || scalar.value == 0x2028 || scalar.value == 0x2029
    }

    /// How a stack lands on a font, as CSS lands on one: the first family
    /// that is installed. `ui-monospace` and `monospace` are the system's
    /// monospaced font (SF Mono on a Mac); another generic is that generic.
    ///
    /// The stack always ends in `monospace`, so it always resolves.
    public static func resolve(_ family: String?, isInstalled: (String) -> Bool) -> TerminalFontChoice {
        for name in families(family) {
            if name == "ui-monospace" || name == "monospace" { return .systemMonospace }
            if genericFamilies.contains(name) { return .generic(name) }
            if isInstalled(name) { return .family(name) }
        }
        return .systemMonospace
    }

}

/// What a font stack resolved to.
public enum TerminalFontChoice: Sendable, Equatable {
    /// An installed family, by name.
    case family(String)
    /// The system's monospaced font (SF Mono): what `ui-monospace` and
    /// `monospace` are on a Mac.
    case systemMonospace
    /// A non-monospace CSS generic (`system-ui`, `serif`, …).
    case generic(String)
}

/// The bits of JavaScript's string semantics the theme code is held to.
enum ThemeJS {
    /// JavaScript's `\s`: the ECMAScript WhiteSpace and LineTerminator sets.
    static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        case 0x2000...0x200A:
            return true
        default:
            return false
        }
    }

    /// `String.prototype.trim`.
    static func trim(_ text: String) -> String {
        let scalars = Array(text.unicodeScalars)
        var start = 0
        var end = scalars.count
        while start < end, isWhitespace(scalars[start]) { start += 1 }
        while end > start, isWhitespace(scalars[end - 1]) { end -= 1 }
        var view = String.UnicodeScalarView()
        view.append(contentsOf: scalars[start..<end])
        return String(view)
    }
}
