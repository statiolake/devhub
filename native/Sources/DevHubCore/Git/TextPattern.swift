// A small door onto NSRegularExpression for the string rules WP4 ports.
//
// The TS sources use JavaScript regular expressions with the `u` flag; ICU's
// syntax (what NSRegularExpression speaks, on macOS and on Linux) agrees with
// them for every pattern used here, including `\p{L}` classes.

import Foundation

struct TextPattern: @unchecked Sendable {
    private let expression: NSRegularExpression

    init(_ pattern: String, options: NSRegularExpression.Options = []) {
        // The patterns are literals in this package; one that does not compile
        // is a bug to be found by the first test that runs it.
        expression = try! NSRegularExpression(pattern: pattern, options: options)
    }

    /// The first match's capture groups (index 0 is the whole match); `nil`
    /// for a group that did not participate.
    func firstMatch(in text: String) -> [String?]? {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = expression.firstMatch(in: text, options: [], range: range) else { return nil }
        return (0..<match.numberOfRanges).map { index in
            let group = match.range(at: index)
            guard group.location != NSNotFound, let bounds = Range(group, in: text) else { return nil }
            return String(text[bounds])
        }
    }

    func matches(_ text: String) -> Bool { firstMatch(in: text) != nil }

    /// `text` with every match replaced by `template` (NSRegularExpression's
    /// `$1` template syntax).
    func replacing(in text: String, with template: String) -> String {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return expression.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: template)
    }

    /// `text` split at every match, as JavaScript's `String.split(regex)` does.
    func split(_ text: String) -> [String] {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        var parts: [String] = []
        var cursor = text.startIndex
        for match in expression.matches(in: text, options: [], range: range) {
            guard let bounds = Range(match.range, in: text) else { continue }
            if bounds.isEmpty { continue }
            parts.append(String(text[cursor..<bounds.lowerBound]))
            cursor = bounds.upperBound
        }
        parts.append(String(text[cursor...]))
        return parts
    }
}

extension String {
    /// JavaScript's `trim()`: whitespace and line terminators off both ends.
    var jsTrimmed: String { JSString.trim(self) }
}
