// Port of apps/desktop/src/main/agent/detect/rules.ts.
//
// The screen-rule engine that reads an Agent's status off its own pane.
//
// Ported (through the TS port) from the herdr project
// (https://github.com/herdrdev/herdr), files `src/detect/mod.rs` and
// `src/detect/manifest.rs`, which are licensed under the Apache License,
// Version 2.0. The rule model — screen regions, prioritised rules, nested
// all/any/not gates, and the `visible_*` / `skip_state_update` metadata — is
// herdr's design, carried over unchanged in shape. See
// `distribution/THIRD-PARTY-NOTICES.txt` in the repository. herdr ships no
// NOTICE file, so there is none to reproduce.
//
// The engine is deliberately pure: screen text in, a reading out. Nothing here
// captures a pane, times anything, or remembers a previous answer — that is
// `AgentStatusDetector`.

import Foundation

/// What a rule can say about the screen: herdr's four states.
public enum ScreenState: String, Sendable, Equatable {
    case idle, working, blocked, unknown
}

/// What the detector reads: the pane, plus the two OSC strings it carries.
public protocol DetectionInput {
    var screen: String { get }
    var oscTitle: String { get }
    var oscProgress: String { get }
}

public struct DetectionScreen: DetectionInput, Sendable, Equatable {
    public var screen: String
    public var oscTitle: String
    public var oscProgress: String
    public init(screen: String, oscTitle: String = "", oscProgress: String = "") {
        self.screen = screen
        self.oscTitle = oscTitle
        self.oscProgress = oscProgress
    }
}

/// A regular expression used as a predicate, compiled once.
///
/// The TS patterns are JavaScript `u` regexes; they are written here in ICU's
/// dialect with JavaScript's ASCII meaning of `\d` and `\w` spelled out
/// (`[0-9]`, `[A-Za-z0-9_]`), so a rule matches what it matched there.
public struct ScreenPattern: @unchecked Sendable {
    public let source: String
    let regex: NSRegularExpression

    public init(_ source: String, caseInsensitive: Bool = false, dotAll: Bool = false) {
        self.source = source
        var options: NSRegularExpression.Options = []
        if caseInsensitive { options.insert(.caseInsensitive) }
        if dotAll { options.insert(.dotMatchesLineSeparators) }
        // A manifest pattern that does not compile is a bug in this file, and
        // the tests compile every one of them.
        regex = try! NSRegularExpression(pattern: source, options: options)
    }

    public func matches(_ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
}

/// A test over one region's text.
///
/// `contains` is case-insensitive and every needle must be present; `regex`
/// must match somewhere in the region; `lineRegex` must match some single
/// line. Nested `all`/`any`/`not` are herdr's, with herdr's emptiness rule: an
/// empty `all` or `not` passes, an empty `any` is not a constraint at all.
public struct Gate: Sendable {
    public var contains: [String]?
    public var regex: [ScreenPattern]?
    public var lineRegex: [ScreenPattern]?
    public var all: [Gate]?
    public var any: [Gate]?
    public var not: [Gate]?

    public init(
        contains: [String]? = nil, regex: [ScreenPattern]? = nil, lineRegex: [ScreenPattern]? = nil,
        all: [Gate]? = nil, any: [Gate]? = nil, not: [Gate]? = nil
    ) {
        self.contains = contains
        self.regex = regex
        self.lineRegex = lineRegex
        self.all = all
        self.any = any
        self.not = not
    }
}

/// Which part of the screen a rule reads. Only the regions the shipped
/// manifests use are here.
public enum RegionSpec: Sendable, Equatable {
    case wholeRecent
    case oscTitle
    case oscProgress
    case promptBoxBody
    case afterLastHorizontalRule
    case afterLastPromptMarker
    case bottomNonEmptyLines(Int)
    case topNonEmptyLines(Int)
}

public struct Rule: Sendable {
    public var id: String
    public var state: ScreenState
    public var priority: Int
    public var region: RegionSpec
    public var gate: Gate
    /// This screen visibly shows live idle chrome.
    public var visibleIdle: Bool
    /// This screen visibly shows chrome that is waiting on a person.
    public var visibleBlocker: Bool
    /// This screen visibly shows live working chrome.
    public var visibleWorking: Bool
    /// The screen is an Agent-owned viewer showing history rather than the
    /// live prompt; the caller keeps the status it already had.
    public var skipStateUpdate: Bool

    public init(
        id: String, state: ScreenState, priority: Int, region: RegionSpec,
        visibleIdle: Bool = false, visibleBlocker: Bool = false, visibleWorking: Bool = false,
        skipStateUpdate: Bool = false,
        contains: [String]? = nil, regex: [ScreenPattern]? = nil, lineRegex: [ScreenPattern]? = nil,
        all: [Gate]? = nil, any: [Gate]? = nil, not: [Gate]? = nil
    ) {
        self.id = id
        self.state = state
        self.priority = priority
        self.region = region
        self.visibleIdle = visibleIdle
        self.visibleBlocker = visibleBlocker
        self.visibleWorking = visibleWorking
        self.skipStateUpdate = skipStateUpdate
        gate = Gate(contains: contains, regex: regex, lineRegex: lineRegex, all: all, any: any, not: not)
    }
}

public struct Manifest: Sendable {
    public var id: String
    public var version: String
    public var rules: [Rule]
}

public struct Reading: Sendable, Equatable {
    public var state: ScreenState
    public var skipStateUpdate: Bool
    public var visibleIdle: Bool
    public var visibleBlocker: Bool
    public var visibleWorking: Bool
    /// Which rule decided, for a test to name and a log line to carry.
    public var matchedRuleId: String?

    public static let unread = Reading(
        state: .unknown, skipStateUpdate: false, visibleIdle: false,
        visibleBlocker: false, visibleWorking: false, matchedRuleId: nil
    )
}

public enum DetectRules {
    public static func region(_ input: any DetectionInput, _ spec: RegionSpec) -> String {
        // The OSC regions come from their own fields. A terminal's title is not
        // part of its screen.
        switch spec {
        case .oscTitle: return input.oscTitle
        case .oscProgress: return input.oscProgress
        case .wholeRecent: return input.screen
        case .promptBoxBody: return promptBoxBody(input.screen)
        case .afterLastHorizontalRule: return afterLastHorizontalRule(input.screen)
        case .afterLastPromptMarker: return afterLastPromptMarker(input.screen)
        case .bottomNonEmptyLines(let count):
            let lines = splitLines(input.screen)
            return sliceLines(lines, lastNonEmptyStart(lines, count), lines.count)
        case .topNonEmptyLines(let count):
            let lines = splitLines(input.screen)
            return sliceLines(lines, 0, firstNonEmptyEnd(lines, count))
        }
    }

    static func splitLines(_ text: String) -> [String] { text.scalarSplit("\n") }

    static func sliceLines(_ lines: [String], _ start: Int, _ end: Int) -> String {
        if start >= end { return "" }
        return lines[start..<end].joined(separator: "\n")
    }

    static func isBlank(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func lastNonEmptyStart(_ lines: [String], _ count: Int) -> Int {
        var seen = 0
        var index = lines.count - 1
        while index >= 0 {
            if !isBlank(lines[index]) {
                seen += 1
                if seen == count { return index }
            }
            index -= 1
        }
        return seen == 0 ? lines.count : 0
    }

    static func firstNonEmptyEnd(_ lines: [String], _ count: Int) -> Int {
        var seen = 0
        for (index, line) in lines.enumerated() where !isBlank(line) {
            seen += 1
            if seen == count { return index + 1 }
        }
        return seen == 0 ? 0 : lines.count
    }

    /// A run of box-drawing horizontals, which is how both CLIs draw a border:
    /// a line that is nothing but the rule character, or one that starts with
    /// at least three of them.
    static func isHorizontalRule(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return false }
        let count = trimmed.prefix { $0 == "─" }.count
        if count == 0 { return false }
        let rest = trimmed.dropFirst(count).drop { $0.isWhitespace }
        return rest.isEmpty || count >= 3
    }

    static func afterLastHorizontalRule(_ content: String) -> String {
        let lines = splitLines(content)
        var after = 0
        for (index, line) in lines.enumerated() where isHorizontalRule(line) { after = index + 1 }
        return sliceLines(lines, after, lines.count)
    }

    /// The inside of the prompt box: between the last two horizontal rules.
    /// Claude Code draws its input box as two borders with the prompt between
    /// them, so the *second* rule counting back from the bottom is its top edge.
    static func promptBoxBody(_ content: String) -> String {
        let lines = splitLines(content)
        var borders = 0
        var top = -1
        var index = lines.count - 1
        while index >= 0 {
            if isHorizontalRule(lines[index]) {
                borders += 1
                if borders == 2 {
                    top = index
                    break
                }
            }
            index -= 1
        }
        if top < 0 { return "" }
        var end = lines.count
        for index in (top + 1)..<max(top + 1, lines.count) where isHorizontalRule(lines[index]) {
            end = index
            break
        }
        return sliceLines(lines, top + 1, end)
    }

    /// Codex's prompt line, and everything printed after it.
    static func afterLastPromptMarker(_ content: String) -> String {
        let lines = splitLines(content)
        var index = lines.count - 1
        while index >= 0 {
            let line = lines[index]
            if line == "›" || line.hasPrefix("› ") { return sliceLines(lines, index + 1, lines.count) }
            index -= 1
        }
        return content
    }

    public static func gateMatches(_ gate: Gate, _ text: String, _ lower: String) -> Bool {
        if let contains = gate.contains, contains.contains(where: { !lower.contains($0) }) { return false }
        if let regex = gate.regex, regex.contains(where: { !$0.matches(text) }) { return false }
        if let lineRegex = gate.lineRegex {
            let lines = splitLines(text)
            if lineRegex.contains(where: { pattern in !lines.contains { pattern.matches($0) } }) { return false }
        }
        if let all = gate.all, all.contains(where: { !gateMatches($0, text, lower) }) { return false }
        if let any = gate.any, !any.isEmpty, !any.contains(where: { gateMatches($0, text, lower) }) { return false }
        if let not = gate.not, not.contains(where: { gateMatches($0, text, lower) }) { return false }
        return true
    }

    /// Read one screen. Every rule is evaluated and the highest priority that
    /// matched wins; ties go to the earlier rule. No rule matching is
    /// `unknown`, the honest answer for a screen the manifest does not describe.
    public static func read(_ manifest: Manifest, _ input: any DetectionInput) -> Reading {
        var winner: Rule?
        for rule in manifest.rules {
            let text = region(input, rule.region)
            if !gateMatches(rule.gate, text, text.lowercased()) { continue }
            if let current = winner, current.priority >= rule.priority { continue }
            winner = rule
        }
        guard let winner else { return .unread }
        return Reading(
            state: winner.state,
            skipStateUpdate: winner.skipStateUpdate,
            // The `visible_*` flags only mean anything when the rule's own
            // state agrees with them.
            visibleIdle: winner.visibleIdle && winner.state == .idle,
            visibleBlocker: winner.visibleBlocker && winner.state == .blocked,
            visibleWorking: winner.visibleWorking && winner.state == .working,
            matchedRuleId: winner.id
        )
    }
}
