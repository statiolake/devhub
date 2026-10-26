// Small helpers the model ports share: JavaScript's string ordering, a stable
// sort, and `localeCompare` as the Sidebar's order uses it.

import Foundation

/// JavaScript's `<` on strings: UTF-16 code units, lexicographically.
func jsStringLess(_ left: String, _ right: String) -> Bool {
    left.utf16.lexicographicallyPrecedes(right.utf16)
}

extension Array {
    /// `Array.prototype.sort` with a comparator: stable, as ECMA-262 requires.
    func stableSorted(by order: (Element, Element) -> Int) -> [Element] {
        enumerated().sorted { left, right in
            let compared = order(left.element, right.element)
            return compared != 0 ? compared < 0 : left.offset < right.offset
        }.map(\.element)
    }
}

/// `left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })`:
/// names sort the way the reader's language sorts them, digits included, case
/// and accents ignored.
func localeCompareNumericBase(_ left: String, _ right: String) -> Int {
    switch left.compare(
        right, options: [.caseInsensitive, .diacriticInsensitive, .numeric, .widthInsensitive],
        range: nil, locale: Locale(identifier: "en")
    ) {
    case .orderedAscending: return -1
    case .orderedDescending: return 1
    case .orderedSame: return 0
    }
}
