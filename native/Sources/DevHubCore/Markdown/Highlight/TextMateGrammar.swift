// A TextMate grammar and its tokenizer: a port of the parts of
// vscode-textmate (`@shikijs/vscode-textmate` 10.0.2: rule.ts, grammar.ts,
// tokenizeString, the scope matchers) that Shiki uses to colour a code block
// in the TS app (apps/desktop/src/shell/conversation/highlight.ts).
//
// Rules are compiled once per grammar: a `match`, a `begin`/`end` pair, a
// `begin`/`while` pair, or a list of patterns, each with its captures and
// names; `include`s resolve to the grammar's repository, `$self`, `$base`,
// or another grammar's scope (`source.css`, `source.js#expression`). A line
// is scanned from where the last match ended for the earliest match among
// the rule's patterns (ties go to the first), and the rule stack carries
// from one line to the next. `\A` and `\G` are honoured as vscode-textmate
// does it: each scanner is compiled in the variants where they may match and
// where they may not.

import Foundation

/// What a line tokenized into: runs of text, each with its scopes, outermost first.
public struct TextMateToken: Equatable, Sendable {
    public var start: Int
    public var end: Int
    public var scopes: [String]
}

// MARK: - Raw rules

final class RawRule: @unchecked Sendable {
    var include: String?
    var name: String?
    var contentName: String?
    var match: String?
    var begin: String?
    var end: String?
    var whilePattern: String?
    var captures: [Int: RawRule] = [:]
    var beginCaptures: [Int: RawRule] = [:]
    var endCaptures: [Int: RawRule] = [:]
    var whileCaptures: [Int: RawRule] = [:]
    var patterns: [RawRule]?
    var repository: [String: RawRule]?
    var applyEndPatternLast = false
    /// The rule id this raw rule compiled to, per grammar.
    var compiledId: [ObjectIdentifier: Int] = [:]

    /// A capture with patterns, as the rule that retokenizes what it captured.
    lazy var retokenizeWrapper: RawRule = {
        let wrapper = RawRule()
        wrapper.patterns = patterns
        wrapper.repository = repository
        return wrapper
    }()

    init(_ json: JsonValue) {
        guard case .object(let object) = json else { return }
        include = object["include"]?.stringValue
        name = object["name"]?.stringValue
        contentName = object["contentName"]?.stringValue
        match = object["match"]?.stringValue
        begin = object["begin"]?.stringValue
        end = object["end"]?.stringValue
        whilePattern = object["while"]?.stringValue
        captures = Self.captures(object["captures"])
        beginCaptures = Self.captures(object["beginCaptures"])
        endCaptures = Self.captures(object["endCaptures"])
        whileCaptures = Self.captures(object["whileCaptures"])
        if case .array(let items)? = object["patterns"] { patterns = items.map(RawRule.init) }
        if case .object(let repo)? = object["repository"] {
            var map: [String: RawRule] = [:]
            for (key, value) in repo { map[key] = RawRule(value) }
            repository = map
        }
        if let last = object["applyEndPatternLast"] {
            applyEndPatternLast = last.boolValue == true || last.numberValue == 1
        }
    }

    init() {}

    static func captures(_ json: JsonValue?) -> [Int: RawRule] {
        guard case .object(let object)? = json else { return [:] }
        var out: [Int: RawRule] = [:]
        for (key, value) in object {
            if let index = Int(key) { out[index] = RawRule(value) }
        }
        return out
    }
}

/// A grammar as its file says it.
public final class RawGrammar: @unchecked Sendable {
    public let scopeName: String
    let patterns: [RawRule]
    let repository: [String: RawRule]
    /// `injections`: selector, then the rule injected where it matches.
    let injections: [(String, RawRule)]
    let selfRuleStorage = Box<RawRule?>(nil)

    public init(json: JsonValue) throws {
        guard case .object(let object) = json, let scope = object["scopeName"]?.stringValue else {
            throw TextMateGrammarError(message: "a grammar has no scopeName")
        }
        scopeName = scope
        if case .array(let items)? = object["patterns"] { patterns = items.map(RawRule.init) } else { patterns = [] }
        var repo: [String: RawRule] = [:]
        if case .object(let map)? = object["repository"] {
            for (key, value) in map { repo[key] = RawRule(value) }
        }
        repository = repo
        var injected: [(String, RawRule)] = []
        if case .object(let map)? = object["injections"] {
            for (selector, value) in map { injected.append((selector, RawRule(value))) }
        }
        injections = injected
    }
}

public struct TextMateGrammarError: Error, CustomStringConvertible {
    public let message: String
    public var description: String { message }
}

// MARK: - Compiled rules

enum CompiledRule {
    case match(name: String?, regex: String, captures: [CaptureRule?])
    case includeOnly(name: String?, contentName: String?, patterns: [Int])
    case beginEnd(BeginEnd)
    case beginWhile(BeginWhile)
    case capture(CaptureRule)
}

struct CaptureRule {
    var name: String?
    var contentName: String?
    /// A capture with patterns of its own: what it captured is tokenized again with this rule.
    var retokenizeWith: Int?
}

struct BeginEnd {
    var name: String?
    var contentName: String?
    var begin: String
    var beginCaptures: [CaptureRule?]
    var end: String
    var endHasBackReferences: Bool
    var endCaptures: [CaptureRule?]
    var applyEndPatternLast: Bool
    var patterns: [Int]
}

struct BeginWhile {
    var name: String?
    var contentName: String?
    var begin: String
    var beginCaptures: [CaptureRule?]
    var whilePattern: String
    var whileHasBackReferences: Bool
    var whileCaptures: [CaptureRule?]
    var patterns: [Int]
}

/// The rule id of the end pattern in a scanner's list.
let END_RULE_ID = -1
let WHILE_RULE_ID = -2

/// Substitutes `$1` and `${1:/downcase}` in a name with what the match captured.
func replaceCaptures(_ name: String, _ line: NSString, _ captures: [NSRange]) -> String {
    guard name.contains("$") else { return name }
    var out = ""
    let chars = Array(name)
    var index = 0
    while index < chars.count {
        if chars[index] == "$", index + 1 < chars.count {
            var number = ""
            var command: String?
            var end = index + 1
            if chars[end] == "{" {
                end += 1
                while end < chars.count, chars[end].isNumber {
                    number.append(chars[end])
                    end += 1
                }
                if end + 1 < chars.count, chars[end] == ":", chars[end + 1] == "/" {
                    var word = ""
                    var at = end + 2
                    while at < chars.count, chars[at] != "}" {
                        word.append(chars[at])
                        at += 1
                    }
                    command = word
                    end = at
                }
                if end < chars.count, chars[end] == "}", !number.isEmpty, command == nil || command == "downcase" || command == "upcase" {
                    end += 1
                } else {
                    out.append(chars[index])
                    index += 1
                    continue
                }
            } else {
                while end < chars.count, chars[end].isNumber {
                    number.append(chars[end])
                    end += 1
                }
                if number.isEmpty {
                    out.append(chars[index])
                    index += 1
                    continue
                }
            }
            let group = Int(number) ?? 0
            if group < captures.count, captures[group].location != NSNotFound {
                var value = line.substring(with: captures[group])
                while value.hasPrefix(".") { value.removeFirst() }
                if command == "downcase" { value = value.lowercased() }
                if command == "upcase" { value = value.uppercased() }
                out += value
            }
            index = end
            continue
        }
        out.append(chars[index])
        index += 1
    }
    return out
}

func hasBackReferences(_ pattern: String) -> Bool {
    var chars = Array(pattern)[...]
    while let slash = chars.firstIndex(of: "\\") {
        let next = chars.index(after: slash)
        if next < chars.endIndex, chars[next].isNumber { return true }
        chars = chars[chars.index(after: min(next, chars.endIndex - 1))...]
        if next >= chars.endIndex { break }
    }
    return false
}

/// An end pattern's `\1` replaced by the text the begin captured, escaped.
func resolveBackReferences(_ pattern: String, _ line: NSString, _ captures: [NSRange]) -> String {
    var out = ""
    let chars = Array(pattern)
    var index = 0
    while index < chars.count {
        if chars[index] == "\\", index + 1 < chars.count {
            if chars[index + 1].isNumber {
                var end = index + 1
                var number = ""
                while end < chars.count, chars[end].isNumber {
                    number.append(chars[end])
                    end += 1
                }
                let group = Int(number) ?? 0
                if group < captures.count, captures[group].location != NSNotFound {
                    out += escapeRegex(line.substring(with: captures[group]))
                }
                index = end
                continue
            }
            out.append(chars[index])
            out.append(chars[index + 1])
            index += 2
            continue
        }
        out.append(chars[index])
        index += 1
    }
    return out
}

func escapeRegex(_ text: String) -> String {
    var out = ""
    for c in text {
        if "\\{}*+?|^$.,[]()#-/ \t".contains(c) || c == "\n" { out.append("\\") }
        out.append(c)
    }
    return out
}

// MARK: - The grammar, compiled

/// Grammars by scope name, for `include`s across grammars.
public protocol TextMateGrammarSource: AnyObject, Sendable {
    func rawGrammar(scope: String) -> RawGrammar?
}

extension RawGrammar {
    /// `$self`: the grammar's top-level patterns, named by its scope.
    var selfRule: RawRule {
        if let made = selfRuleStorage.value { return made }
        let wrapper = RawRule()
        wrapper.patterns = patterns
        wrapper.name = scopeName
        selfRuleStorage.value = wrapper
        return wrapper
    }
}

final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

/// One grammar as the base of a tokenizing: its rules, and those of every
/// grammar it includes, in one table (vscode-textmate's `Grammar`).
public final class TextMateGrammar: @unchecked Sendable {
    public let raw: RawGrammar
    weak var source: TextMateGrammarSource?
    private let lock = NSLock()
    private var rules: [CompiledRule] = []
    private var rootId = -1
    private var injectionRules: [(matcher: ScopeSelectorMatcher, ruleId: Int)]?

    public init(_ raw: RawGrammar, source: TextMateGrammarSource?) {
        self.raw = raw
        self.source = source
    }

    var scopeName: String { raw.scopeName }

    func rule(_ id: Int) -> CompiledRule { rules[id] }

    /// A grammar's repository as its rules see it: with `$self` and `$base`.
    private func repository(of grammar: RawGrammar) -> [String: RawRule] {
        var repo = grammar.repository
        repo["$self"] = grammar.selfRule
        repo["$base"] = raw.selfRule
        return repo
    }

    func compile(_ rawRule: RawRule, repository: [String: RawRule]) -> Int {
        let key = ObjectIdentifier(self)
        if let id = rawRule.compiledId[key] { return id }
        let id = rules.count
        rules.append(.includeOnly(name: nil, contentName: nil, patterns: []))
        rawRule.compiledId[key] = id
        var repo = repository
        if let own = rawRule.repository { repo.merge(own) { $1 } }
        if let match = rawRule.match {
            rules[id] = .match(name: rawRule.name, regex: match, captures: compileCaptures(rawRule.captures, repo))
        } else if let begin = rawRule.begin {
            let beginCaptures = compileCaptures(rawRule.beginCaptures.isEmpty ? rawRule.captures : rawRule.beginCaptures, repo)
            if let whilePattern = rawRule.whilePattern {
                rules[id] = .beginWhile(BeginWhile(
                    name: rawRule.name, contentName: rawRule.contentName, begin: begin, beginCaptures: beginCaptures,
                    whilePattern: whilePattern, whileHasBackReferences: hasBackReferences(whilePattern),
                    whileCaptures: compileCaptures(rawRule.whileCaptures.isEmpty ? rawRule.captures : rawRule.whileCaptures, repo),
                    patterns: compilePatterns(rawRule.patterns ?? [], repo)))
            } else {
                let end = rawRule.end ?? "\u{FFFF}"
                rules[id] = .beginEnd(BeginEnd(
                    name: rawRule.name, contentName: rawRule.contentName, begin: begin, beginCaptures: beginCaptures,
                    end: end, endHasBackReferences: hasBackReferences(end),
                    endCaptures: compileCaptures(rawRule.endCaptures.isEmpty ? rawRule.captures : rawRule.endCaptures, repo),
                    applyEndPatternLast: rawRule.applyEndPatternLast,
                    patterns: compilePatterns(rawRule.patterns ?? [], repo)))
            }
        } else {
            var patterns = rawRule.patterns ?? []
            if patterns.isEmpty, rawRule.include != nil { patterns = [rawRule] }
            rules[id] = .includeOnly(name: rawRule.name, contentName: rawRule.contentName, patterns: compilePatterns(patterns, repo))
        }
        return id
    }

    private func compileCaptures(_ captures: [Int: RawRule], _ repo: [String: RawRule]) -> [CaptureRule?] {
        guard let maximum = captures.keys.max() else { return [] }
        var out: [CaptureRule?] = Array(repeating: nil, count: maximum + 1)
        for (index, capture) in captures {
            var retokenize: Int?
            if capture.patterns != nil {
                let wrapper = capture.retokenizeWrapper
                retokenize = compile(wrapper, repository: repo)
            }
            out[index] = CaptureRule(name: capture.name, contentName: capture.contentName, retokenizeWith: retokenize)
        }
        return out
    }

    private func compilePatterns(_ patterns: [RawRule], _ repo: [String: RawRule]) -> [Int] {
        var ids: [Int] = []
        for pattern in patterns {
            if let include = pattern.include {
                if let id = resolveInclude(include, repo) { ids.append(id) }
            } else {
                ids.append(compile(pattern, repository: repo))
            }
        }
        return ids
    }

    private func resolveInclude(_ include: String, _ repo: [String: RawRule]) -> Int? {
        if include == "$self" || include == "$base" {
            guard let rule = repo[include] else { return nil }
            return compile(rule, repository: repo)
        }
        if include.hasPrefix("#") {
            guard let rule = repo[String(include.dropFirst())] else { return nil }
            return compile(rule, repository: repo)
        }
        let parts = include.split(separator: "#", maxSplits: 1).map(String.init)
        let other: RawGrammar? = parts[0] == raw.scopeName ? raw : source?.rawGrammar(scope: parts[0])
        guard let other else { return nil }
        let otherRepo = repository(of: other)
        if parts.count == 2 {
            guard let rule = otherRepo[parts[1]] else { return nil }
            return compile(rule, repository: otherRepo)
        }
        return compile(other.selfRule, repository: otherRepo)
    }

    /// The root rule (compiling the grammar on first use).
    func root() -> Int {
        if rootId < 0 { rootId = compile(raw.selfRule, repository: repository(of: raw)) }
        return rootId
    }

    func injections() -> [(matcher: ScopeSelectorMatcher, ruleId: Int)] {
        if let injectionRules { return injectionRules }
        var made: [(matcher: ScopeSelectorMatcher, ruleId: Int)] = []
        let repo = repository(of: raw)
        for (selector, rule) in raw.injections {
            let id = compile(rule, repository: repo)
            for matcher in ScopeSelector.matchers(selector) { made.append((matcher, id)) }
        }
        injectionRules = made
        return made
    }

    // MARK: Scanners

    struct Scanner {
        var regexes: [TextMateRegex]
        var ruleIds: [Int]
    }

    private var scanners: [String: Scanner] = [:]

    /// The patterns a rule scans for, `\A` and `\G` allowed or not.
    func scanner(_ ruleId: Int, endRule: String?, allowA: Bool, gAt: Int?) -> Scanner {
        let key = "\(ruleId)\u{0}\(endRule ?? "")\u{0}\(allowA)\(gAt ?? -1)"
        if let hit = scanners[key] { return hit }
        var sources: [(String, Int)] = []
        switch rules[ruleId] {
        case .beginEnd(let rule):
            let end = endRule ?? rule.end
            var children: [(String, Int)] = []
            collect(rule.patterns, into: &children, visited: [])
            if rule.applyEndPatternLast {
                sources = children + [(end, END_RULE_ID)]
            } else {
                sources = [(end, END_RULE_ID)] + children
            }
        case .beginWhile(let rule):
            collect(rule.patterns, into: &sources, visited: [])
        case .includeOnly(_, _, let patterns):
            collect(patterns, into: &sources, visited: [])
        case .match, .capture:
            break
        }
        let made = Scanner(
            regexes: sources.map { TextMateRegex.of(Self.variant($0.0, allowA: allowA, gAt: gAt)) },
            ruleIds: sources.map(\.1))
        scanners[key] = made
        return made
    }

    func whileScanner(_ ruleId: Int, whileRule: String?, allowA: Bool, gAt: Int?) -> Scanner {
        guard case .beginWhile(let rule) = rules[ruleId] else { return Scanner(regexes: [], ruleIds: []) }
        let pattern = whileRule ?? rule.whilePattern
        return Scanner(regexes: [TextMateRegex.of(Self.variant(pattern, allowA: allowA, gAt: gAt))], ruleIds: [WHILE_RULE_ID])
    }

    /// vscode-textmate's `RegExpSource.resolveAnchors`: `\A` and `\G` made
    /// unmatchable where they may not match. Where `\G` may, it is the
    /// search's start, `gAt` characters into the line: ICU's own `\G` is not
    /// the search's start inside a lookaround once the bounds are transparent
    /// (which lookbehinds need), so it is spelled as that position.
    static func variant(_ source: String, allowA: Bool, gAt: Int?) -> String {
        guard source.contains("\\A") || source.contains("\\G") else { return source }
        var out = ""
        var chars = Array(source)[...]
        while let c = chars.popFirst() {
            if c == "\\", let next = chars.first {
                chars.removeFirst()
                if next == "A", !allowA {
                    out += "\\x{FFFF}"
                } else if next == "G" {
                    if let gAt {
                        out += gAt == 0 ? "(?<![\\s\\S])" : "(?<=\\A[\\s\\S]{\(gAt)})"
                    } else {
                        out += "\\x{FFFF}"
                    }
                } else {
                    out.append(c)
                    out.append(next)
                }
                continue
            }
            out.append(c)
        }
        return out
    }

    /// Every pattern a list of rules contributes to a scanner, includes expanded.
    private func collect(_ ids: [Int], into sources: inout [(String, Int)], visited: Set<Int>) {
        for id in ids {
            switch rules[id] {
            case .match(_, let regex, _): sources.append((regex, id))
            case .beginEnd(let rule): sources.append((rule.begin, id))
            case .beginWhile(let rule): sources.append((rule.begin, id))
            case .includeOnly(_, _, let patterns):
                if visited.contains(id) { continue }
                collect(patterns, into: &sources, visited: visited.union([id]))
            case .capture: break
            }
        }
    }

    // MARK: Tokenizing

    func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}
