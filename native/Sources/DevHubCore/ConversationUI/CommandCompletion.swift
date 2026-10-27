// Port of apps/desktop/src/shell/conversation/commandCompletion.ts and the
// tokenizer of skillTokens.tsx.
//
// What the composer offers after a `/` or a `$`, and what it walks with ↑ and ↓.
//
// Both are readings of what the view already has. The commands are the
// Agent's own (`SessionFacts.commands`), each with the character it is typed
// after (`trigger`), ranked by the scorer every picker in DevHub uses; the
// history is the person's own messages in this Agent's transcript. Neither is
// stored anywhere else, so neither can disagree with the conversation it
// belongs to.
//
// Offsets are UTF-16 code units, as the composer's text view counts them.

import Foundation

/// A name being typed after a trigger, and where its trigger starts in the text.
public struct CompletionQuery: Equatable, Sendable {
    public var trigger: SlashTrigger
    public var name: String
    public var start: Int
    /// Where the typed name ends: the caret.
    public var end: Int
    /// Whether the trigger is the message's first word.
    public var leading: Bool
}

public enum CommandCompletion {
    /// Built-in CLI commands, which act only as a message's first word.
    static let builtIn: Set<String> = [
        "add-dir", "agents", "bug", "clear", "compact", "config", "context", "cost", "doctor", "effort", "exit", "help",
        "hooks", "ide", "login", "logout", "mcp", "memory", "model", "output-style", "permissions", "plugin", "quit",
        "restart", "resume", "rewind", "status", "terminal-setup", "usage", "vim",
    ]

    /// Whether `/name` may be written (and so offered or tinted) away from the message's start.
    public static func midSentenceCommand(_ name: String) -> Bool { !builtIn.contains(name) }

    static func isJapanese(_ c: Unicode.Scalar) -> Bool {
        let value = c.value
        if (0x3000...0x303F).contains(value) || (0xFF00...0xFFEF).contains(value) { return true }
        // Han, Hiragana, Katakana.
        if (0x3040...0x309F).contains(value) || (0x30A0...0x30FF).contains(value) || (0x31F0...0x31FF).contains(value) { return true }
        if (0x3400...0x4DBF).contains(value) || (0x4E00...0x9FFF).contains(value) || (0xF900...0xFAFF).contains(value)
            || (0x20000...0x3134F).contains(value) || (0x2E80...0x2FDF).contains(value) || value == 0x3005 || value == 0x3007
            || (0x3021...0x3029).contains(value) || (0x3038...0x303B).contains(value) || (0x1B000...0x1B16F).contains(value)
            || (0xFF66...0xFF9F).contains(value)
        {
            return true
        }
        return false
    }

    /// Whether a `/` after `before` begins a command: at the start, after
    /// whitespace, an opening bracket, or Japanese text (written without
    /// spaces), and not after what makes a path or URL.
    public static func opensCommand(_ before: String) -> Bool {
        guard let last = before.unicodeScalars.last else { return true }
        return last == " " || last == "\t" || last == "\n" || last == "\r" || MarkdownCharacters.isUnicodeWhitespace(last)
            || last == "(" || last == "[" || last == "{" || isJapanese(last)
    }

    static func endsName(_ c: Unicode.Scalar) -> Bool {
        MarkdownCharacters.isUnicodeWhitespace(c) || c == "/" || c == "$" || isJapanese(c)
    }

    /// How much of `rest` is a name typed after a trigger (in UTF-16 units).
    public static func nameLength(_ rest: String) -> Int {
        var length = 0
        for scalar in rest.unicodeScalars {
            if endsName(scalar) { return length }
            length += scalar.utf16.count
        }
        return length
    }

    /// The name being typed at the caret (default: the end), or nil when the composer is not typing one.
    public static func query(_ text: String, caret: Int? = nil) -> CompletionQuery? {
        let ns = text as NSString
        let caret = min(caret ?? ns.length, ns.length)
        let before = ns.substring(to: caret)
        // `/[/$][^\s/$]*$/`
        var start = -1
        var index = (before as NSString).length
        let units = Array(before.utf16)
        while index > 0 {
            let unit = units[index - 1]
            if unit == 0x2F || unit == 0x24 {
                start = index - 1
                break
            }
            if let scalar = Unicode.Scalar(unit), MarkdownCharacters.isUnicodeWhitespace(scalar) { return nil }
            index -= 1
        }
        guard start >= 0 else { return nil }
        let trigger: SlashTrigger = units[start] == 0x2F ? .slash : .dollar
        let head = ns.substring(to: start)
        let opens = trigger == .slash
            ? opensCommand(head)
            : head.isEmpty || head.unicodeScalars.last.map(MarkdownCharacters.isUnicodeWhitespace) == true
        guard opens else { return nil }
        let name = ns.substring(with: NSRange(location: start + 1, length: caret - start - 1))
        guard nameLength(name) == (name as NSString).length else { return nil }
        return CompletionQuery(trigger: trigger, name: name, start: start, end: caret, leading: start == 0)
    }

    /// The text with the name being typed replaced by the chosen one and a
    /// space after it (unless one follows), and where the caret goes.
    public static func completed(_ text: String, _ query: CompletionQuery, _ command: SlashCommand) -> (text: String, caret: Int) {
        let ns = text as NSString
        let rest = ns.substring(from: query.end)
        let word = "\(command.trigger.rawValue)\(command.name)"
        let space = rest.unicodeScalars.first.map(MarkdownCharacters.isUnicodeWhitespace) == true ? "" : " "
        let head = ns.substring(to: query.start) + word + space
        return (head + rest, (head as NSString).length + (space.isEmpty ? 1 : 0))
    }

    /// The commands typed after `query`'s trigger that match its name, best first; ties keep the Agent's order.
    public static func completions(_ commands: [SlashCommand], _ query: CompletionQuery) -> [SlashCommand] {
        struct Candidate {
            let index: Int
            let command: SlashCommand
            let score: Double
        }
        var candidates: [Candidate] = []
        for (index, command) in commands.enumerated() where command.trigger == query.trigger {
            let offered = query.leading || query.trigger == .dollar
                || (command.route == .message && midSentenceCommand(command.name))
            guard offered else { continue }
            let score = Fuzzy.score(command.name, query.name)
            if score > 0 { candidates.append(Candidate(index: index, command: command, score: score)) }
        }
        candidates.sort { $0.score != $1.score ? $0.score > $1.score : $0.index < $1.index }
        return candidates.map(\.command)
    }

    /// What the person has said to this Agent, newest first, each message once
    /// however often it was repeated in a row.
    public static func inputHistory(_ transcript: Transcript) -> [String] {
        var history: [String] = []
        for entry in transcript.entries.reversed() {
            guard case .user(let user) = entry, user.parent == nil, user.origin == .person else { continue }
            if user.text == history.last { continue }
            history.append(user.text)
        }
        return history
    }
}

// MARK: - Skill tokens (skillTokens.tsx)

/// A run of the person's words: a recognised command or skill name, or not.
public struct TextSegment: Equatable, Sendable {
    public var text: String
    public var skill: Bool
}

public enum SkillTokens {
    /// `trigger + name` for every command, to look a typed word up.
    public static func words(_ commands: [SlashCommand]) -> Set<String> {
        Set(commands.map { "\($0.trigger.rawValue)\($0.name)" })
    }

    static let trailing = CharacterSet(charactersIn: ".,;:!?)]}\"'`")

    /// `text` cut into plain and recognised runs that together read as `text` exactly.
    public static func tokenize(_ text: String, _ words: Set<String>) -> [TextSegment] {
        if words.isEmpty || text.isEmpty { return [TextSegment(text: text, skill: false)] }
        let ns = text as NSString
        var segments: [TextSegment] = []
        var plain = 0
        func flush(_ end: Int) {
            if end > plain { segments.append(TextSegment(text: ns.substring(with: NSRange(location: plain, length: end - plain)), skill: false)) }
        }
        let regex = try! NSRegularExpression(pattern: "[/$][^\\s/$]*")
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let start = match.range.location
            if start < plain { continue }
            let head = ns.substring(to: start)
            let raw = ns.substring(with: match.range)
            if raw.hasPrefix("/") {
                if !CommandCompletion.opensCommand(head) { continue }
            } else if !head.isEmpty, head.unicodeScalars.last.map(MarkdownCharacters.isUnicodeWhitespace) != true {
                continue
            }
            let rest = String(raw.dropFirst())
            var word = (raw as NSString).substring(to: CommandCompletion.nameLength(rest) + 1)
            if !words.contains(word) {
                while let last = word.unicodeScalars.last, trailing.contains(last) { word.unicodeScalars.removeLast() }
                if !words.contains(word) { continue }
            }
            if word.hasPrefix("/"), start != 0, !CommandCompletion.midSentenceCommand(String(word.dropFirst())) { continue }
            flush(start)
            segments.append(TextSegment(text: word, skill: true))
            plain = start + (word as NSString).length
        }
        flush(ns.length)
        return segments
    }
}
