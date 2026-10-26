// Port of apps/desktop/src/model/fuzzy.ts
//
// How well a candidate matches what was typed.
//
// One scorer, used by every picker there is and by the source that feeds them.
// That is the whole point of it living here: the workspace search runs over
// sources only Core can read, while the sheet in the window ranks and filters
// what has arrived so far — and a person typing must not see two different
// answers to "does this match" depending on which side happened to decide.
//
// Subsequence matching, with a bonus for a hit in the last path component: a
// person filtering "hub" means the folder, not a parent directory that happens
// to contain the letters. A candidate that does not match at all scores zero,
// which is what "not in the list" means everywhere it is used.

public enum Fuzzy {
    /// The last path component of a candidate, or the whole of it when it has none.
    static func lastComponent(_ text: [Unicode.Scalar]) -> [Unicode.Scalar] {
        guard let cut = text.lastIndex(of: "/") else { return text }
        return Array(text[(cut + 1)...])
    }

    public static func score(_ searchText: String, _ query: String) -> Double {
        if query.isEmpty { return 1 }
        let haystack = Array(searchText.lowercased().unicodeScalars)
        let needle = Array(query.lowercased().unicodeScalars)
        var index = 0
        for character in needle {
            guard let found = haystack[min(index, haystack.count)...].firstIndex(of: character) else { return 0 }
            index = found + 1
        }
        return contains(lastComponent(haystack), needle) ? 100 : 10
    }

    static func contains(_ haystack: [Unicode.Scalar], _ needle: [Unicode.Scalar]) -> Bool {
        if needle.isEmpty { return true }
        if needle.count > haystack.count { return false }
        for start in 0...(haystack.count - needle.count) where Array(haystack[start..<(start + needle.count)]) == needle {
            return true
        }
        return false
    }
}
