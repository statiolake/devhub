// Port of apps/desktop/src/model/dateTemplate.ts
//
// A path that names a date: `~/workspace/daily/YYYY/MMDD`.
//
// DevHub used to get today's workspace by running a program that printed it.
// That works exactly on the machine where the program is installed, which is
// not a thing a default configuration can assume. The path is a sentence about
// where the folders are, and expanding it needs nothing but the clock.
//
// The tokens are moment/dayjs's, and they are those rather than `strftime`'s on
// purpose: they are the ones the sibling extension `vscode-project-picker`
// takes in its `formatDate` entries, so one person's daily folder is written
// the same way in both places. `[...]` passes text through verbatim, which is
// the only way to have a literal `DD` in a path.
//
// Nothing here touches the filesystem, and nothing here asks what time it is:
// the clock is a parameter, so a test can say what day it is and the answer is
// a pure function of the template and that day.
//
// The day is the *local* day, and this is the one place that says so. A daily
// folder is named after the day the person having it is living in — at 23:59 on
// the first of the month they want the first's folder, whatever date UTC has
// already moved on to. `LocalMoment` is that local reading of an instant.

import Foundation

/// An instant as the local calendar reads it: what JS's `Date` local-time
/// getters return.
public struct LocalMoment: Equatable, Hashable, Sendable {
    public var year: Int
    /// 1–12.
    public var month: Int
    public var day: Int
    public var hour: Int
    public var minute: Int
    public var second: Int

    public init(year: Int, month: Int, day: Int, hour: Int = 0, minute: Int = 0, second: Int = 0) {
        self.year = year
        self.month = month
        self.day = day
        self.hour = hour
        self.minute = minute
        self.second = second
    }

    /// `date` in `timeZone` (the machine's own by default).
    public init(_ date: Date, timeZone: TimeZone = .current) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        self.init(
            year: parts.year ?? 1970, month: parts.month ?? 1, day: parts.day ?? 1,
            hour: parts.hour ?? 0, minute: parts.minute ?? 0, second: parts.second ?? 0
        )
    }
}

/// A path segment that reads as a word but expands as a date.
public struct DateTemplateAmbiguity: Equatable, Sendable {
    /// The segment as it is written, e.g. `summaries`.
    public let segment: String
    /// The token hiding in it, e.g. `mm`.
    public let token: String
    /// The segment written so it means itself, e.g. `[summaries]`.
    public let escaped: String
}

public enum DateTemplate {
    /// Every token, longest first — `MMDD` before `MM`, so the two-part day
    /// stamp a daily folder is usually named with is one token rather than two
    /// that happen to sit together. The order is the matching order, and it is
    /// stated once.
    public static let tokenNames: [String] = ["YYYY", "YY", "MMDD", "MM", "DD", "HH", "mm", "ss"]

    static func pad(_ value: Int, _ width: Int) -> String {
        let text = String(value)
        return text.count >= width ? text : String(repeating: "0", count: width - text.count) + text
    }

    /// What each token stands for, in matching order.
    static func tokens(_ now: LocalMoment) -> [(token: [Unicode.Scalar], value: String)] {
        let standsFor: [String: String] = [
            "YYYY": pad(now.year, 4),
            "YY": pad(now.year % 100, 2),
            "MMDD": pad(now.month, 2) + pad(now.day, 2),
            "MM": pad(now.month, 2),
            "DD": pad(now.day, 2),
            "HH": pad(now.hour, 2),
            "mm": pad(now.minute, 2),
            "ss": pad(now.second, 2),
        ]
        return tokenNames.map { (Array($0.unicodeScalars), standsFor[$0]!) }
    }

    static func starts(_ text: [Unicode.Scalar], _ token: [Unicode.Scalar], at index: Int) -> Bool {
        index + token.count <= text.count && Array(text[index..<(index + token.count)]) == token
    }

    static func string(_ scalars: ArraySlice<Unicode.Scalar>) -> String {
        var view = String.UnicodeScalarView()
        view.append(contentsOf: scalars)
        return String(view)
    }

    /// The template with its tokens replaced, as of `now`.
    ///
    /// An unclosed `[` is not possible here: a template that has one is refused
    /// when the config is read, so by the time this runs the brackets balance.
    /// If one arrives anyway the rest of the template is taken literally, which
    /// is the reading that loses the least.
    public static func expand(_ template: String, now: LocalMoment) -> String {
        let tokens = tokens(now)
        let text = Array(template.unicodeScalars)
        var out = ""
        var index = 0
        while index < text.count {
            if text[index] == "[" {
                guard let end = text[(index + 1)...].firstIndex(of: "]") else {
                    out += string(text[(index + 1)...])
                    break
                }
                out += string(text[(index + 1)..<end])
                index = end + 1
                continue
            }
            if let matched = tokens.first(where: { starts(text, $0.token, at: index) }) {
                out += matched.value
                index += matched.token.count
                continue
            }
            out.unicodeScalars.append(text[index])
            index += 1
        }
        return out
    }

    public static func expand(_ template: String, now: Date) -> String {
        expand(template, now: LocalMoment(now))
    }

    /// Does every `[` in this template have a `]` after it?
    ///
    /// The one thing about a template that can be wrong without the clock: a
    /// person who opened a bracket and did not close it meant something, and
    /// quietly taking the rest of the path as a literal is not it.
    public static func bracketsBalance(_ template: String) -> Bool {
        let text = Array(template.unicodeScalars)
        var index = 0
        while index < text.count {
            if text[index] == "]" { return false }
            if text[index] != "[" {
                index += 1
                continue
            }
            guard let end = text[(index + 1)...].firstIndex(of: "]") else { return false }
            index = end + 1
        }
        return true
    }

    /// Is this a character a person would have meant as part of a word?
    static func isWordCharacter(_ scalar: Unicode.Scalar) -> Bool {
        ("A"..."Z").contains(scalar) || ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
    }

    /// The first segment of this template that mixes a word with a token, if any.
    ///
    /// `expand` replaces tokens *everywhere*, which is what makes
    /// `~/Documents/summaries/YYYY` expand to `~/Documents/su09aries/2026`.
    /// Nobody sees that happen: the picker offers a folder that does not exist,
    /// which looks exactly like a folder that has not been made yet. So the rule
    /// is about one path segment at a time: a segment that is only tokens and
    /// punctuation (`YYYY`, `MMDD`, `YYYY-MM-DD`) is a date, and a segment where
    /// a token sits among letters or digits (`summaries`, `logsYYYY`) is a word
    /// that is about to stop being one. Text inside `[...]` is left alone.
    public static func ambiguity(_ template: String) -> DateTemplateAmbiguity? {
        let names = tokenNames.map { (name: $0, scalars: Array($0.unicodeScalars)) }
        for segmentText in template.split(separator: "/", omittingEmptySubsequences: false) {
            let segment = Array(segmentText.unicodeScalars)
            var token: String?
            var word = false
            var index = 0
            while index < segment.count {
                if segment[index] == "[" {
                    // An unclosed bracket is a different mistake, reported on
                    // its own by `bracketsBalance`. Nothing past it is a token.
                    guard let end = segment[(index + 1)...].firstIndex(of: "]") else { break }
                    index = end + 1
                    continue
                }
                if let matched = names.first(where: { starts(segment, $0.scalars, at: index) }) {
                    if token == nil { token = matched.name }
                    index += matched.scalars.count
                    continue
                }
                if isWordCharacter(segment[index]) { word = true }
                index += 1
            }
            if let token, word {
                let text = String(segmentText)
                return DateTemplateAmbiguity(segment: text, token: token, escaped: "[\(text)]")
            }
        }
        return nil
    }
}
