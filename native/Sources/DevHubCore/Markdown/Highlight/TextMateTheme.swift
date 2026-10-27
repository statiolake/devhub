// A theme's token colours as vscode-textmate resolves them (theme.ts:
// `parseTheme`, `resolveParsedThemeRules`, the `ThemeTrie`, `Theme.match`,
// and the colour merge of `AttributedScopeStack.push`). Only the foreground
// is read: a transcript's code block takes its colours and nothing else
// (CodeBlock.tsx).

import Foundation

public final class TextMateTheme: @unchecked Sendable {
    /// The colour of text no rule colours, as the theme says it.
    public let foreground: String?

    final class Rule {
        var scopeDepth: Int
        let parentScopes: [String]?
        var foreground: String?

        init(_ scopeDepth: Int, _ parentScopes: [String]?, _ foreground: String?) {
            self.scopeDepth = scopeDepth
            self.parentScopes = parentScopes
            self.foreground = foreground
        }

        func clone() -> Rule { Rule(scopeDepth, parentScopes, foreground) }

        func overwrite(_ depth: Int, _ color: String?) {
            if scopeDepth <= depth { scopeDepth = depth }
            if let color { foreground = color }
        }
    }

    final class Trie {
        let main: Rule
        var withParents: [Rule]
        var children: [String: Trie] = [:]

        init(_ main: Rule, _ withParents: [Rule]) {
            self.main = main
            self.withParents = withParents
        }

        func insert(_ depth: Int, _ scope: Substring, _ parents: [String]?, _ color: String?) {
            if scope.isEmpty {
                guard let parents else {
                    main.overwrite(depth, color)
                    return
                }
                for rule in withParents where rule.parentScopes == parents {
                    rule.overwrite(depth, color)
                    return
                }
                withParents.append(Rule(depth, parents, color ?? main.foreground))
                return
            }
            let dot = scope.firstIndex(of: ".")
            let head = String(dot.map { scope[..<$0] } ?? scope)
            let tail = dot.map { scope[scope.index(after: $0)...] } ?? ""
            let child: Trie
            if let existing = children[head] {
                child = existing
            } else {
                child = Trie(main.clone(), withParents.map { $0.clone() })
                children[head] = child
            }
            child.insert(depth + 1, tail, parents, color)
        }

        func match(_ scope: Substring) -> [Rule] {
            if !scope.isEmpty {
                let dot = scope.firstIndex(of: ".")
                let head = String(dot.map { scope[..<$0] } ?? scope)
                let tail = dot.map { scope[scope.index(after: $0)...] } ?? ""
                if let child = children[head] { return child.match(tail) }
            }
            return (withParents + [main]).sorted(by: Trie.bySpecificity)
        }

        static func bySpecificity(_ a: Rule, _ b: Rule) -> Bool {
            if a.scopeDepth != b.scopeDepth { return a.scopeDepth > b.scopeDepth }
            let ap = a.parentScopes ?? [], bp = b.parentScopes ?? []
            var ai = 0, bi = 0
            while true {
                if ai < ap.count, ap[ai] == ">" { ai += 1 }
                if bi < bp.count, bp[bi] == ">" { bi += 1 }
                if ai >= ap.count || bi >= bp.count { break }
                let diff = bp[bi].count - ap[ai].count
                if diff != 0 { return diff < 0 }
                ai += 1
                bi += 1
            }
            return ap.count > bp.count
        }
    }

    private let root: Trie
    private let lock = NSLock()
    private var cache: [String: [Rule]] = [:]

    /// A theme from its JSON (`tokenColors` or `settings`, and `colors`).
    public init(json: JsonValue) {
        var settings: [JsonValue] = json["tokenColors"]?.arrayValue ?? json["settings"]?.arrayValue ?? []
        var editorForeground = json["colors"]?["editor.foreground"]?.stringValue
        // Shiki's `normalizeTheme`: a theme with no scopeless rule gets one from its editor colours.
        let hasGlobal = settings.contains { $0["scope"] == nil }
        if !hasGlobal, let fg = editorForeground {
            settings.insert(.object(JsonObject([("settings", .object(JsonObject([("foreground", .string(fg))])))])), at: 0)
        }
        struct Parsed {
            var scope: String
            var parents: [String]?
            var index: Int
            var foreground: String?
        }
        var parsed: [Parsed] = []
        for (index, entry) in settings.enumerated() {
            guard let style = entry["settings"] else { continue }
            var scopes: [String]
            switch entry["scope"] {
            case .string(let text)?:
                var trimmed = text
                while trimmed.hasPrefix(",") { trimmed.removeFirst() }
                while trimmed.hasSuffix(",") { trimmed.removeLast() }
                scopes = trimmed.split(separator: ",", omittingEmptySubsequences: false).map { String($0) }
            case .array(let items)?:
                scopes = items.compactMap(\.stringValue)
            default:
                scopes = [""]
            }
            var foreground = style["foreground"]?.stringValue
            if let color = foreground, !TextMateTheme.isValidHex(color) { foreground = nil }
            for scope in scopes {
                let segments = scope.trimmingCharacters(in: .whitespaces).split(separator: " ").map(String.init)
                let last = segments.last ?? ""
                var parents: [String]?
                if segments.count > 1 { parents = Array(segments.dropLast().reversed()) }
                parsed.append(Parsed(scope: last, parents: parents, index: index, foreground: foreground?.uppercased()))
            }
        }
        parsed.sort {
            if $0.scope != $1.scope { return $0.scope < $1.scope }
            // `strArrCmp`: none first, then the shorter, then word by word.
            switch ($0.parents, $1.parents) {
            case (nil, nil): break
            case (nil, _): return true
            case (_, nil): return false
            case let (a?, b?):
                if a.count != b.count { return a.count < b.count }
                for (x, y) in zip(a, b) where x != y { return x < y }
            }
            return $0.index < $1.index
        }
        // Defaults: the scopeless rules, in order.
        var defaultForeground: String?
        while let first = parsed.first, first.scope.isEmpty {
            parsed.removeFirst()
            if let color = first.foreground { defaultForeground = color }
        }
        if defaultForeground == nil { defaultForeground = editorForeground?.uppercased() }
        editorForeground = defaultForeground
        foreground = defaultForeground
        root = Trie(Rule(0, nil, nil), [])
        for rule in parsed {
            root.insert(0, Substring(rule.scope), rule.parents, rule.foreground)
        }
    }

    static func isValidHex(_ color: String) -> Bool {
        let chars = Array(color)
        guard chars.first == "#", [4, 5, 7, 9].contains(chars.count) else { return false }
        return chars.dropFirst().allSatisfy { $0.isHexDigit }
    }

    private func rules(_ scope: String) -> [Rule] {
        lock.lock()
        defer { lock.unlock() }
        if let hit = cache[scope] { return hit }
        let made = root.match(Substring(scope))
        cache[scope] = made
        return made
    }

    static func pathMatches(_ path: ArraySlice<String>, _ parents: [String]?) -> Bool {
        guard let parents else { return true }
        var index = 0
        var pattern = parents[0]
        var at = path.endIndex
        while at > path.startIndex {
            at -= 1
            let scope = path[at]
            if scope == pattern || (scope.hasPrefix(pattern) && scope.dropFirst(pattern.count).first == ".") {
                index += 1
                if index == parents.count { return true }
                pattern = parents[index]
            }
        }
        return false
    }

    /// The foreground of text with these scopes, outermost first.
    public func foreground(_ scopes: [String]) -> String? {
        var color = foreground
        for depth in scopes.indices {
            let scope = scopes[depth]
            let parents = scopes[..<depth]
            if let rule = rules(scope).first(where: { TextMateTheme.pathMatches(parents, $0.parentScopes) }), let fg = rule.foreground {
                color = fg
            }
        }
        return color
    }
}
