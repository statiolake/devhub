// vscode-textmate's `_tokenizeString`, `_checkWhileConditions` and
// `handleCaptures`, on the compiled rules of `TextMateGrammar`.

import Foundation

/// The rule stack between lines (vscode-textmate's `StateStack`).
public final class TextMateState: @unchecked Sendable {
    let parent: TextMateState?
    let ruleId: Int
    let enterPos: Int
    let anchorPos: Int
    let beginRuleCapturedEOL: Bool
    /// An end or while pattern with its back-references resolved.
    let endRule: String?
    let nameScopes: [String]
    let contentNameScopes: [String]

    init(
        parent: TextMateState?, ruleId: Int, enterPos: Int, anchorPos: Int, beginRuleCapturedEOL: Bool, endRule: String?,
        nameScopes: [String], contentNameScopes: [String]
    ) {
        self.parent = parent
        self.ruleId = ruleId
        self.enterPos = enterPos
        self.anchorPos = anchorPos
        self.beginRuleCapturedEOL = beginRuleCapturedEOL
        self.endRule = endRule
        self.nameScopes = nameScopes
        self.contentNameScopes = contentNameScopes
    }

    func push(_ ruleId: Int, _ enterPos: Int, _ anchorPos: Int, _ capturedEOL: Bool, _ endRule: String?, _ names: [String], _ content: [String]) -> TextMateState {
        TextMateState(
            parent: self, ruleId: ruleId, enterPos: enterPos, anchorPos: anchorPos, beginRuleCapturedEOL: capturedEOL,
            endRule: endRule, nameScopes: names, contentNameScopes: content)
    }

    func withContentNameScopes(_ scopes: [String]) -> TextMateState {
        TextMateState(
            parent: parent, ruleId: ruleId, enterPos: enterPos, anchorPos: anchorPos, beginRuleCapturedEOL: beginRuleCapturedEOL,
            endRule: endRule, nameScopes: nameScopes, contentNameScopes: scopes)
    }

    func withEndRule(_ rule: String) -> TextMateState {
        TextMateState(
            parent: parent, ruleId: ruleId, enterPos: enterPos, anchorPos: anchorPos, beginRuleCapturedEOL: beginRuleCapturedEOL,
            endRule: rule, nameScopes: nameScopes, contentNameScopes: contentNameScopes)
    }

    /// A new line begins: positions in the last one mean nothing now.
    func reset() -> TextMateState {
        TextMateState(
            parent: parent?.reset(), ruleId: ruleId, enterPos: -1, anchorPos: -1, beginRuleCapturedEOL: beginRuleCapturedEOL,
            endRule: endRule, nameScopes: nameScopes, contentNameScopes: contentNameScopes)
    }

    func pop() -> TextMateState { parent ?? self }

    func safePop() -> TextMateState { parent ?? self }

    func hasSameRule(as other: TextMateState) -> Bool {
        var node: TextMateState? = self
        while let current = node, current.enterPos == other.enterPos {
            if current.ruleId == other.ruleId { return true }
            node = current.parent
        }
        return false
    }
}

/// Scopes pushed: a name with spaces is several scopes.
func pushScopes(_ scopes: [String], _ name: String?) -> [String] {
    guard let name, !name.isEmpty else { return scopes }
    return scopes + name.split(separator: " ").map(String.init)
}

struct LineTokens {
    var tokens: [TextMateToken] = []
    var lastEnd = 0

    mutating func produce(_ state: TextMateState, _ end: Int) { produce(scopes: state.contentNameScopes, end) }

    mutating func produce(scopes: [String], _ end: Int) {
        if lastEnd >= end { return }
        tokens.append(TextMateToken(start: lastEnd, end: end, scopes: scopes))
        lastEnd = end
    }
}

extension TextMateGrammar {
    /// The first state of a document.
    func initialState() -> TextMateState {
        let root = self.root()
        var name: String?
        if case .includeOnly(let rootName, _, _) = rule(root) { name = rootName }
        let scopes = pushScopes([], name)
        return TextMateState(
            parent: nil, ruleId: root, enterPos: -1, anchorPos: -1, beginRuleCapturedEOL: false, endRule: nil,
            nameScopes: scopes, contentNameScopes: scopes)
    }

    /// One line, from `state`: its tokens (the text without the line's end), and the state after it.
    func tokenizeLine(_ text: String, _ state: TextMateState?, firstLine: Bool) -> ([TextMateToken], TextMateState) {
        withLock {
            let start = state ?? initialState()
            let line = (text + "\n") as NSString
            var tokens = LineTokens()
            var cache = MatchCache()
            let end = tokenizeString(line, firstLine: firstLine, linePos: 0, start.reset(), &tokens, checkWhile: true, &cache)
            let length = line.length - 1
            var out = tokens.tokens.compactMap { token -> TextMateToken? in
                guard token.start < length else { return nil }
                var trimmed = token
                trimmed.end = min(token.end, length)
                return trimmed
            }
            if out.isEmpty || out.last!.end < length {
                out.append(TextMateToken(start: out.last?.end ?? 0, end: length, scopes: end.contentNameScopes))
            }
            return (out, end)
        }
    }

    /// How many characters (code points) come before UTF-16 offset `at`.
    func codePoints(_ line: NSString, _ at: Int) -> Int {
        var count = 0
        var index = 0
        while index < at {
            let unit = line.character(at: index)
            index += (unit >= 0xD800 && unit <= 0xDBFF) ? 2 : 1
            count += 1
        }
        return count
    }

    struct Match {
        var ranges: [NSRange]
        var ruleId: Int
    }

    /// vscode-oniguruma's per-string search cache: a pattern's last result for
    /// this line stands for any later search that starts no further on.
    struct MatchCache {
        var results: [ObjectIdentifier: (from: Int, result: NSTextCheckingResult?)] = [:]
        var line: NSString?

        mutating func search(_ regex: TextMateRegex, _ line: NSString, _ from: Int) -> NSTextCheckingResult? {
            if self.line !== line {
                results = [:]
                self.line = line
            }
            let key = ObjectIdentifier(regex)
            if !regex.anchoredAtSearchStart, let kept = results[key], kept.from <= from {
                guard let result = kept.result else { return nil }
                if result.range.location >= from { return result }
            }
            let result = regex.match(line, from: from)
            results[key] = (from, result)
            return result
        }
    }

    private func findNext(_ scanner: Scanner, _ line: NSString, _ from: Int, _ cache: inout MatchCache) -> Match? {
        var best: NSTextCheckingResult?
        var bestIndex = -1
        for (index, regex) in scanner.regexes.enumerated() {
            guard let result = cache.search(regex, line, from) else { continue }
            if best == nil || result.range.location < best!.range.location {
                best = result
                bestIndex = index
                if result.range.location == from { break }
            }
        }
        guard let best else { return nil }
        let ranges = (0..<best.numberOfRanges).map { best.range(at: $0) }
        return Match(ranges: ranges, ruleId: scanner.ruleIds[bestIndex])
    }

    private func matchRule(_ line: NSString, _ firstLine: Bool, _ linePos: Int, _ state: TextMateState, _ anchor: Int, _ cache: inout MatchCache) -> Match? {
        let scanner = self.scanner(state.ruleId, endRule: state.endRule, allowA: firstLine, gAt: linePos == anchor ? codePoints(line, linePos) : nil)
        return findNext(scanner, line, linePos, &cache)
    }

    private func matchRuleOrInjections(_ line: NSString, _ firstLine: Bool, _ linePos: Int, _ state: TextMateState, _ anchor: Int, _ cache: inout MatchCache) -> Match? {
        let match = matchRule(line, firstLine, linePos, state, anchor, &cache)
        let injections = self.injections()
        if injections.isEmpty { return match }
        var best: (match: Match, priority: Bool)?
        for injection in injections where injection.matcher.matches(state.contentNameScopes) {
            let scanner = self.scanner(injection.ruleId, endRule: nil, allowA: firstLine, gAt: linePos == anchor ? codePoints(line, linePos) : nil)
            guard let found = findNext(scanner, line, linePos, &cache) else { continue }
            if let current = best, current.match.ranges[0].location <= found.ranges[0].location { continue }
            best = (found, injection.matcher.priority == -1)
            if found.ranges[0].location == linePos { break }
        }
        guard let injected = best else { return match }
        guard let match else { return injected.match }
        let injectedStart = injected.match.ranges[0].location
        let matchStart = match.ranges[0].location
        if matchStart < injectedStart || (!injected.priority && matchStart == injectedStart) { return match }
        return injected.match
    }

    private func checkWhileConditions(_ line: NSString, _ firstLine: inout Bool, _ linePos: inout Int, _ state: TextMateState, _ tokens: inout LineTokens, _ anchor: inout Int, _ cache: inout MatchCache) -> TextMateState {
        var stack = state
        anchor = state.beginRuleCapturedEOL ? 0 : -1
        var whileRules: [TextMateState] = []
        var node: TextMateState? = state
        while let current = node {
            if case .beginWhile = rule(current.ruleId) { whileRules.append(current) }
            node = current.parent
        }
        while let whileState = whileRules.popLast() {
            let scanner = whileScanner(whileState.ruleId, whileRule: whileState.endRule, allowA: firstLine, gAt: anchor == linePos ? codePoints(line, linePos) : nil)
            guard let found = findNext(scanner, line, linePos, &cache) else {
                stack = whileState.pop()
                break
            }
            guard case .beginWhile(let rule) = self.rule(whileState.ruleId) else { break }
            tokens.produce(whileState, found.ranges[0].location)
            handleCaptures(line, firstLine, whileState, &tokens, rule.whileCaptures, found.ranges, &cache)
            let end = NSMaxRange(found.ranges[0])
            tokens.produce(whileState, end)
            anchor = end
            if end > linePos {
                linePos = end
                firstLine = false
            }
        }
        return stack
    }

    private func name(_ name: String?, _ line: NSString, _ ranges: [NSRange]) -> String? {
        guard let name else { return nil }
        return replaceCaptures(name, line, ranges)
    }

    @discardableResult
    func tokenizeString(_ line: NSString, firstLine: Bool, linePos: Int, _ state: TextMateState, _ tokens: inout LineTokens, checkWhile: Bool, _ cache: inout MatchCache) -> TextMateState {
        let lineLength = line.length
        var stack = state
        var linePos = linePos
        var firstLine = firstLine
        var anchor = -1
        if checkWhile {
            stack = checkWhileConditions(line, &firstLine, &linePos, stack, &tokens, &anchor, &cache)
        }
        var guardCount = 0
        while true {
            guardCount += 1
            if guardCount > 20000 {
                tokens.produce(stack, lineLength)
                return stack
            }
            guard let found = matchRuleOrInjections(line, firstLine, linePos, stack, anchor, &cache) else {
                tokens.produce(stack, lineLength)
                return stack
            }
            let whole = found.ranges[0]
            if TextMateDebug.on {
                print("  at \(linePos) rule \(found.ruleId) matched \(whole) \(line.substring(with: whole).debugDescription) \(TextMateDebug.describe(self, found.ruleId, stack))")
            }
            let hasAdvanced = NSMaxRange(whole) > linePos
            if found.ruleId == END_RULE_ID {
                guard case .beginEnd(let popped) = rule(stack.ruleId) else {
                    tokens.produce(stack, lineLength)
                    return stack
                }
                tokens.produce(stack, whole.location)
                stack = stack.withContentNameScopes(stack.nameScopes)
                handleCaptures(line, firstLine, stack, &tokens, popped.endCaptures, found.ranges, &cache)
                tokens.produce(stack, NSMaxRange(whole))
                let poppedState = stack
                stack = stack.pop()
                anchor = poppedState.anchorPos
                if !hasAdvanced, poppedState.enterPos == linePos {
                    // Pushed and popped without advancing: stay, and stop.
                    stack = poppedState
                    tokens.produce(stack, lineLength)
                    return stack
                }
            } else {
                let matched = rule(found.ruleId)
                tokens.produce(stack, whole.location)
                let before = stack
                var ruleName: String?
                switch matched {
                case .match(let n, _, _): ruleName = n
                case .beginEnd(let r): ruleName = r.name
                case .beginWhile(let r): ruleName = r.name
                case .includeOnly(let n, _, _): ruleName = n
                case .capture(let r): ruleName = r.name
                }
                let names = pushScopes(stack.contentNameScopes, name(ruleName, line, found.ranges))
                stack = stack.push(found.ruleId, linePos, anchor, NSMaxRange(whole) == lineLength, nil, names, names)
                switch matched {
                case .beginEnd(let pushed):
                    handleCaptures(line, firstLine, stack, &tokens, pushed.beginCaptures, found.ranges, &cache)
                    tokens.produce(stack, NSMaxRange(whole))
                    anchor = NSMaxRange(whole)
                    stack = stack.withContentNameScopes(pushScopes(names, name(pushed.contentName, line, found.ranges)))
                    if pushed.endHasBackReferences {
                        stack = stack.withEndRule(resolveBackReferences(pushed.end, line, found.ranges))
                    }
                    if !hasAdvanced, before.hasSameRule(as: stack) {
                        stack = stack.pop()
                        tokens.produce(stack, lineLength)
                        return stack
                    }
                case .beginWhile(let pushed):
                    handleCaptures(line, firstLine, stack, &tokens, pushed.beginCaptures, found.ranges, &cache)
                    tokens.produce(stack, NSMaxRange(whole))
                    anchor = NSMaxRange(whole)
                    stack = stack.withContentNameScopes(pushScopes(names, name(pushed.contentName, line, found.ranges)))
                    if pushed.whileHasBackReferences {
                        stack = stack.withEndRule(resolveBackReferences(pushed.whilePattern, line, found.ranges))
                    }
                    if !hasAdvanced, before.hasSameRule(as: stack) {
                        stack = stack.pop()
                        tokens.produce(stack, lineLength)
                        return stack
                    }
                case .match(_, _, let captures):
                    handleCaptures(line, firstLine, stack, &tokens, captures, found.ranges, &cache)
                    tokens.produce(stack, NSMaxRange(whole))
                    stack = stack.pop()
                    if !hasAdvanced {
                        stack = stack.safePop()
                        tokens.produce(stack, lineLength)
                        return stack
                    }
                default:
                    stack = stack.pop()
                    tokens.produce(stack, lineLength)
                    return stack
                }
            }
            if NSMaxRange(whole) > linePos {
                linePos = NSMaxRange(whole)
                firstLine = false
            }
        }
    }

    private func handleCaptures(_ line: NSString, _ firstLine: Bool, _ stack: TextMateState, _ tokens: inout LineTokens, _ captures: [CaptureRule?], _ ranges: [NSRange], _ cache: inout MatchCache) {
        if captures.isEmpty { return }
        let count = min(captures.count, ranges.count)
        var local: [(scopes: [String], end: Int)] = []
        let maxEnd = NSMaxRange(ranges[0])
        for index in 0..<count {
            guard let capture = captures[index] else { continue }
            let range = ranges[index]
            if range.location == NSNotFound || range.length == 0 { continue }
            if range.location > maxEnd { break }
            while let top = local.last, top.end <= range.location {
                tokens.produce(scopes: top.scopes, top.end)
                local.removeLast()
            }
            if let top = local.last {
                tokens.produce(scopes: top.scopes, range.location)
            } else {
                tokens.produce(stack, range.location)
            }
            if let retokenize = capture.retokenizeWith {
                let names = pushScopes(stack.contentNameScopes, name(capture.name, line, ranges))
                let content = pushScopes(names, name(capture.contentName, line, ranges))
                let clone = stack.push(retokenize, range.location, -1, false, nil, names, content)
                let sub = line.substring(to: NSMaxRange(range)) as NSString
                var subCache = MatchCache()
                tokenizeString(sub, firstLine: firstLine && range.location == 0, linePos: range.location, clone, &tokens, checkWhile: false, &subCache)
                continue
            }
            if let scope = name(capture.name, line, ranges) {
                let base = local.last?.scopes ?? stack.contentNameScopes
                local.append((pushScopes(base, scope), NSMaxRange(range)))
            }
        }
        while let top = local.popLast() {
            tokens.produce(scopes: top.scopes, top.end)
        }
    }
}

// MARK: - Scope selectors (vscode-textmate's matcher.ts)

/// One alternative of a selector, with the priority its `L:` / `R:` prefix gives it.
public struct ScopeSelectorMatcher: Sendable {
    let expression: ScopeSelector.Expression
    /// -1 for `L:`, 1 for `R:`, 0 otherwise.
    let priority: Int

    func matches(_ scopes: [String]) -> Bool { expression.matches(scopes) }
}

public enum ScopeSelector {
    indirect enum Expression: Sendable {
        case path([String])
        case not(Expression)
        case and([Expression])
        case or([Expression])
        case always

        func matches(_ scopes: [String]) -> Bool {
            switch self {
            case .always: return true
            case .path(let identifiers): return ScopeSelector.nameMatcher(identifiers, scopes)
            case .not(let inner): return !inner.matches(scopes)
            case .and(let all): return all.allSatisfy { $0.matches(scopes) }
            case .or(let any): return any.contains { $0.matches(scopes) }
            }
        }
    }

    static func nameMatcher(_ identifiers: [String], _ scopes: [String]) -> Bool {
        if scopes.count < identifiers.count { return false }
        var lastIndex = 0
        return identifiers.allSatisfy { identifier in
            var index = lastIndex
            while index < scopes.count {
                if scopesMatch(scopes[index], identifier) {
                    lastIndex = index + 1
                    return true
                }
                index += 1
            }
            return false
        }
    }

    static func scopesMatch(_ scope: String, _ identifier: String) -> Bool {
        if scope == identifier { return true }
        return scope.hasPrefix(identifier) && scope.count > identifier.count
            && scope[scope.index(scope.startIndex, offsetBy: identifier.count)] == "."
    }

    /// `/([LR]:|[\w\.:][\w\.:\-]*|[\,\|\-\(\)])/g`
    static func tokens(_ selector: String) -> [String] {
        var out: [String] = []
        let chars = Array(selector)
        var index = 0
        func isWord(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" || c == "." || c == ":" }
        while index < chars.count {
            let c = chars[index]
            if (c == "L" || c == "R"), index + 1 < chars.count, chars[index + 1] == ":" {
                out.append(String([c, ":"]))
                index += 2
            } else if isWord(c) {
                var end = index + 1
                while end < chars.count, isWord(chars[end]) || chars[end] == "-" { end += 1 }
                out.append(String(chars[index..<end]))
                index = end
            } else if c == "," || c == "|" || c == "-" || c == "(" || c == ")" {
                out.append(String(c))
                index += 1
            } else {
                index += 1
            }
        }
        return out
    }

    /// `createMatchers`: each comma-separated alternative, with its priority.
    static func matchers(_ selector: String) -> [ScopeSelectorMatcher] {
        var tokens = Self.tokens(selector)[...]
        var results: [ScopeSelectorMatcher] = []
        func isIdentifier(_ token: String?) -> Bool {
            guard let token, let first = token.first else { return false }
            return first.isLetter || first.isNumber || first == "_" || first == "." || first == ":"
        }
        func parseOperand() -> Expression? {
            guard let token = tokens.first else { return nil }
            if token == "-" {
                tokens.removeFirst()
                guard let inner = parseOperand() else { return nil }
                return .not(inner)
            }
            if token == "(" {
                tokens.removeFirst()
                let inner = parseInnerExpression()
                if tokens.first == ")" { tokens.removeFirst() }
                return inner
            }
            if isIdentifier(token) {
                var identifiers: [String] = []
                while let next = tokens.first, isIdentifier(next) {
                    identifiers.append(next)
                    tokens.removeFirst()
                }
                return .path(identifiers)
            }
            return nil
        }
        func parseConjunction() -> Expression {
            var all: [Expression] = []
            while let operand = parseOperand() { all.append(operand) }
            return .and(all)
        }
        func parseInnerExpression() -> Expression {
            var any = [parseConjunction()]
            while tokens.first == "|" || tokens.first == "," {
                tokens.removeFirst()
                any.append(parseConjunction())
            }
            return .or(any)
        }
        while !tokens.isEmpty {
            var priority = 0
            if let first = tokens.first, first.count == 2, first.hasSuffix(":") {
                priority = first == "R:" ? 1 : -1
                tokens.removeFirst()
            }
            let expression = parseConjunction()
            results.append(ScopeSelectorMatcher(expression: expression, priority: priority))
            if tokens.first != "," { break }
            tokens.removeFirst()
        }
        return results
    }
}

enum TextMateDebug {
    nonisolated(unsafe) static var on = false

    static func describe(_ grammar: TextMateGrammar, _ id: Int, _ stack: TextMateState) -> String {
        if id < 0 {
            if case .beginEnd(let r) = grammar.rule(stack.ruleId) { return "END of \(r.name ?? "") \(stack.endRule ?? r.end)" }
            return "END?"
        }
        switch grammar.rule(id) {
        case .match(let n, let r, _): return "match \(n ?? "") \(r)"
        case .beginEnd(let r): return "begin \(r.name ?? "") \(r.begin) end \(r.end)"
        case .beginWhile(let r): return "beginWhile \(r.name ?? "") \(r.begin)"
        default: return "other"
        }
    }
}
