// Port of apps/desktop/src/shell/conversation/highlight.ts.
//
// Syntax colouring for a closed code block.
//
// The grammars and the two default themes of VS Code itself, as Shiki 4.4.3
// packages them (vendored under Markdown/Grammars, MIT, with their NOTICE),
// so a block in a transcript is coloured the way the editor beside it
// colours the same file. The set is closed — a language outside it is drawn
// as plain monospace, which is what a fence with no language is drawn as too.
//
// Every token carries both themes' colours, Light+ and Dark+, and the view
// picks one by the appearance it is in: a change of appearance is a restyle,
// not a second pass over every block in the transcript.

import Foundation

public enum CodeGrammar: String, CaseIterable, Sendable {
    case c, csharp, css, diff, docker, go, html, java, javascript, json, jsonc, jsx, kotlin, lua, python, rust
    case shellscript, sql, swift, tsx, typescript, xml

    var scopeName: String {
        switch self {
        case .c: return "source.c"
        case .csharp: return "source.cs"
        case .css: return "source.css"
        case .diff: return "source.diff"
        case .docker: return "source.dockerfile"
        case .go: return "source.go"
        case .html: return "text.html.basic"
        case .java: return "source.java"
        case .javascript: return "source.js"
        case .json: return "source.json"
        case .jsonc: return "source.json.comments"
        case .jsx: return "source.js.jsx"
        case .kotlin: return "source.kotlin"
        case .lua: return "source.lua"
        case .python: return "source.python"
        case .rust: return "source.rust"
        case .shellscript: return "source.shell"
        case .sql: return "source.sql"
        case .swift: return "source.swift"
        case .tsx: return "source.tsx"
        case .typescript: return "source.ts"
        case .xml: return "text.xml"
        }
    }

    /// What people write after the fence, for the grammars above.
    static let aliases: [String: CodeGrammar] = [
        "bash": .shellscript, "cjs": .javascript, "cs": .csharp, "dockerfile": .docker, "golang": .go, "h": .c,
        "htm": .html, "js": .javascript, "kt": .kotlin, "kts": .kotlin, "mjs": .javascript, "patch": .diff,
        "py": .python, "rs": .rust, "sh": .shellscript, "shell": .shellscript, "svg": .xml, "ts": .typescript,
        "zsh": .shellscript,
    ]

    /// The grammar for a fence's info string (`ts`, `Python`, `rust ignore`),
    /// or nil for a language this build does not colour.
    public static func of(info: String?) -> CodeGrammar? {
        guard let info else { return nil }
        let word = info.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" }).first.map { $0.lowercased() }
        guard let word, !word.isEmpty else { return nil }
        if let own = CodeGrammar(rawValue: word) { return own }
        return aliases[word]
    }
}

/// One run of text in one colour. A colour is nil where the theme draws the
/// text's own foreground, so that run takes the transcript's ink.
public struct CodeToken: Equatable, Sendable {
    public var text: String
    public var light: String?
    public var dark: String?

    public init(text: String, light: String?, dark: String?) {
        self.text = text
        self.light = light
        self.dark = dark
    }
}

/// One array of tokens per line.
public typealias CodeColouring = [[CodeToken]]

public final class CodeHighlighter: TextMateGrammarSource, @unchecked Sendable {
    /// The vendored grammars and themes (`Markdown/Grammars`), beside the app or where SwiftPM put them.
    public static let resourceRoot: String? = {
        let bundleNames = ["DevHub_DevHubCore.bundle", "DevHub_DevHubCore.resources"]
        let manager = FileManager.default
        for base in [Bundle.main.resourceURL, Bundle.main.bundleURL, Bundle.main.executableURL?.deletingLastPathComponent()] {
            guard let base else { continue }
            for name in bundleNames {
                let candidate = base.appendingPathComponent(name).appendingPathComponent("Grammars")
                if manager.fileExists(atPath: candidate.appendingPathComponent("typescript.json").path) { return candidate.path }
            }
        }
        return Bundle.module.url(forResource: "Grammars", withExtension: nil)?.path
    }()

    public static let shared = CodeHighlighter(root: resourceRoot)

    private let root: String?
    private let lock = NSLock()
    private var raws: [String: RawGrammar] = [:]
    private var grammars: [CodeGrammar: TextMateGrammar] = [:]
    private var colourings: [String: CodeColouring] = [:]
    private var order: [String] = []
    private lazy var light: TextMateTheme? = theme("theme-light-plus.json")
    private lazy var dark: TextMateTheme? = theme("theme-dark-plus.json")

    /// Colourings already made, by grammar and code: a block drawn again
    /// comes back coloured in its first frame. Bounded, oldest out first.
    static let kept = 2000

    public init(root: String?) {
        self.root = root
    }

    private static let files: [String: String] = Dictionary(
        uniqueKeysWithValues: CodeGrammar.allCases.map { ($0.scopeName, $0.rawValue) })

    private func theme(_ file: String) -> TextMateTheme? {
        guard let root, let data = FileManager.default.contents(atPath: root + "/" + file),
              let json = try? JsonValue.parse(data) else { return nil }
        return TextMateTheme(json: json)
    }

    public func rawGrammar(scope: String) -> RawGrammar? {
        lock.lock()
        defer { lock.unlock() }
        return loadRaw(scope)
    }

    private func loadRaw(_ scope: String) -> RawGrammar? {
        if let hit = raws[scope] { return hit }
        guard let root, let file = Self.files[scope],
              let data = FileManager.default.contents(atPath: root + "/" + file + ".json"),
              let json = try? JsonValue.parse(data), let raw = try? RawGrammar(json: json)
        else { return nil }
        raws[scope] = raw
        return raw
    }

    func grammar(_ id: CodeGrammar) -> TextMateGrammar? {
        lock.lock()
        defer { lock.unlock() }
        if let hit = grammars[id] { return hit }
        guard let raw = loadRaw(id.scopeName) else { return nil }
        let made = TextMateGrammar(raw, source: self)
        grammars[id] = made
        return made
    }

    private static func key(_ code: String, _ grammar: CodeGrammar) -> String { "\(grammar.rawValue)\u{0}\(code)" }

    /// The colouring `highlight` already made for this code, if it has.
    public func colouringOf(_ code: String, _ grammar: CodeGrammar) -> CodeColouring? {
        lock.lock()
        defer { lock.unlock() }
        return colourings[Self.key(code, grammar)]
    }

    /// The scopes of each line's tokens.
    public func tokenize(_ code: String, _ grammar: CodeGrammar) -> [[(text: String, scopes: [String])]] {
        guard let compiled = self.grammar(grammar) else {
            return code.components(separatedBy: "\n").map { [($0, [])] }
        }
        var state: TextMateState?
        var out: [[(text: String, scopes: [String])]] = []
        for (index, line) in code.components(separatedBy: "\n").enumerated() {
            let (tokens, next) = compiled.tokenizeLine(line, state, firstLine: index == 0)
            state = next
            let text = line as NSString
            out.append(tokens.map { (text.substring(with: NSRange(location: $0.start, length: $0.end - $0.start)), $0.scopes) })
        }
        return out
    }

    /// `code`, coloured by `grammar`: one array of tokens per line.
    public func highlight(_ code: String, _ grammar: CodeGrammar) -> CodeColouring {
        let key = Self.key(code, grammar)
        if let kept = colouringOf(code, grammar) { return kept }
        let lightTheme = light, darkTheme = dark
        let colouring: CodeColouring = tokenize(code, grammar).map { line in
            var tokens: [CodeToken] = []
            for (text, scopes) in line where !text.isEmpty {
                let l = Self.own(lightTheme?.foreground(scopes), lightTheme?.foreground)
                let d = Self.own(darkTheme?.foreground(scopes), darkTheme?.foreground)
                if let last = tokens.last, last.light == l, last.dark == d {
                    tokens[tokens.count - 1].text += text
                } else {
                    tokens.append(CodeToken(text: text, light: l, dark: d))
                }
            }
            return tokens
        }
        lock.lock()
        if colourings[key] == nil {
            colourings[key] = colouring
            order.append(key)
            if order.count > Self.kept { colourings[order.removeFirst()] = nil }
        }
        lock.unlock()
        return colouring
    }

    static func own(_ colour: String?, _ foreground: String?) -> String? {
        guard let colour else { return nil }
        return colour.lowercased() == foreground?.lowercased() ? nil : colour
    }
}
