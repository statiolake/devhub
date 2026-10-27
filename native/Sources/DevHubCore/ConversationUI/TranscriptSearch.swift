// Port of apps/desktop/src/shell/conversation/transcriptSearch.ts and the
// text half of findInTranscript.ts.
//
// The find bar's search over one drawn transcript.
//
// A one-letter query over a long session has millions of matches, and every
// one of them counts: the count is exact. So the search never holds up the
// view for them:
//
// - It runs in slices of a few milliseconds (`sliceMs`), one task each, so
//   typing, scrolling and the conversation's own drawing go on between them.
//   The count grows as it goes (`status.complete` says when it is exact), and
//   a new query drops what is left of the old one.
// - A match is kept as where it starts in its section's text (`[Int32]`).
//   The view makes ranges for just the matches on view, when it paints them.
// - The transcript is searched by section: each top-level entry has its own
//   text and matches. When the conversation grows or an entry is drawn again,
//   only those sections are read and searched again (`refresh`); the rest
//   keep theirs, and the current match stays put.
//
// A section's text is every word the entry says, folded or not — a closed
// tool call's input and output, a cut readable view's end, a long message's
// lines past its fold — with its blocks apart by `blockBreak`, so a match
// never runs from one block into the next. The page's controls and what is
// drawn for the eye only (a diff's line numbers) are not in it. The view
// opens whatever a current match is folded inside.
//
// Sections are searched from the bottom up, and a new query's current match
// is its last: the conversation's latest words are where a search usually
// starts, going up from there. Within a section the text is searched top
// down. Matches are numbered in document order, and stepping goes through the
// ones found so far, so it works while the count is still growing.

import Foundation

/// What stands between two blocks' text in a section. A query never holds
/// one — the find field is one line — so no match runs across it.
public let BLOCK_BREAK = "\n"

/// The text in lower case, character for character: one whose lower case is
/// longer (`İ`) is kept as it is, so an offset in the folded text is the same
/// offset in the text (UTF-16 units).
public func foldCase(_ text: String) -> String {
    let lower = text.lowercased()
    if lower.utf16.count == text.utf16.count { return lower }
    var folded = ""
    for character in text {
        let each = String(character).lowercased()
        folded += each.utf16.count == String(character).utf16.count ? each : String(character)
    }
    return folded
}

public struct SearchStatus: Equatable, Sendable {
    /// How many matches are found: all of them once `complete`.
    public var total: Int
    /// Which of them is current, in document order.
    public var current: Int?
    public var complete: Bool
    /// Counts the moves of the current match made on purpose, which bring it into view.
    public var moves: Int

    public static let nothing = SearchStatus(total: 0, current: nil, complete: true, moves: 0)
}

/// One searchable part of the transcript: an entry's id and every word it draws.
public struct SearchSection: Equatable, Sendable {
    public var id: String
    public var text: String

    public init(id: String, text: String) {
        self.id = id
        self.text = text
    }
}

/// Where a match is: its section, its offset in the section's text, and how long.
public struct SearchMatch: Equatable, Sendable {
    public var section: String
    public var offset: Int
    public var length: Int
}

@MainActor
public final class TranscriptSearch {
    /// The longest a slice of searching runs before it lets the view go on.
    public static let sliceMs: Double = 4

    /// Runs `run` as a task of its own, soon; the returned function cancels it.
    public typealias Schedule = @MainActor (@escaping @MainActor () -> Void) -> () -> Void

    final class Section {
        let id: String
        var text: NSString
        var folded: NSString?
        var matches: [Int32] = []
        var from = 0
        var complete = false

        init(_ source: SearchSection) {
            id = source.id
            text = source.text as NSString
        }

        func foldedText() -> NSString {
            if let folded { return folded }
            let made = foldCase(text as String) as NSString
            folded = made
            return made
        }
    }

    private var sections: [Section]
    private var query: NSString = ""
    private var caseSensitive = false
    /// The last section not searched to its end; -1 when all are.
    private var next = -1
    private var current: (section: Section, offset: Int)?
    /// Its place when last counted: kept by it when its section goes away.
    private var currentIndex = 0
    private var resettle = false
    private var awaitingLast = false
    private var moves = 0
    private var cancel: (() -> Void)?
    private let onChange: @MainActor () -> Void
    private let schedule: Schedule
    private let now: () -> Double

    public init(
        sections: [SearchSection], onChange: @escaping @MainActor () -> Void,
        schedule: @escaping Schedule = TranscriptSearch.mainQueue,
        now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.sections = sections.map(Section.init)
        self.onChange = onChange
        self.schedule = schedule
        self.now = now
    }

    /// A task of its own on the main queue.
    public static func mainQueue(_ run: @escaping @MainActor () -> Void) -> () -> Void {
        let token = CancelToken()
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                if !token.cancelled { run() }
            }
        }
        return { token.cancelled = true }
    }

    final class CancelToken: @unchecked Sendable {
        var cancelled = false
    }

    /// Stop searching.
    public func dispose() {
        cancel?()
        cancel = nil
    }

    /// Search for `query` anew: the last match becomes current. Case is
    /// ignored unless `caseSensitive`. An empty query finds nothing.
    public func setQuery(_ query: String, caseSensitive: Bool) {
        precondition(!query.contains("\n"), "a find query holds a line break, which the find field cannot give")
        self.query = (caseSensitive ? query : foldCase(query)) as NSString
        self.caseSensitive = caseSensitive
        for section in sections { restart(section) }
        next = sections.count - 1
        current = nil
        currentIndex = 0
        resettle = false
        awaitingLast = true
        run()
    }

    /// Take in the transcript as it is drawn now: sections whose text changed
    /// are searched again, the others keep what they found.
    public func refresh(_ drawn: [SearchSection]) {
        if current != nil { _ = indexOfCurrent() }
        let kept = Dictionary(sections.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var changed = false
        var next: [Section] = []
        for source in drawn {
            if let section = kept[source.id] {
                if section.text as String != source.text {
                    section.text = source.text as NSString
                    section.folded = nil
                    restart(section)
                    if current?.section === section { resettle = true }
                    changed = true
                }
                next.append(section)
            } else {
                next.append(Section(source))
                changed = true
            }
        }
        if next.count != sections.count || zip(next, sections).contains(where: { $0 !== $1 }) { changed = true }
        guard changed else { return }
        sections = next
        if let current, !sections.contains(where: { $0 === current.section }) {
            self.current = nil
            resettle = true
        }
        self.next = sections.count - 1
        while self.next >= 0, sections[self.next].complete { self.next -= 1 }
        run()
    }

    public var status: SearchStatus {
        SearchStatus(total: total(), current: current == nil ? nil : indexOfCurrent(), complete: next < 0, moves: moves)
    }

    /// Make the next match (1) or the previous (-1) current, around the ends of what is found.
    public func step(_ delta: Int) {
        let total = total()
        if total == 0 { return }
        let index = current == nil ? (delta == 1 ? -1 : 0) : indexOfCurrent()
        currentIndex = ((index + delta) % total + total) % total
        current = locate(currentIndex)
        moves += 1
        onChange()
    }

    /// The current match.
    public var currentMatch: SearchMatch? {
        guard let current else { return nil }
        return SearchMatch(section: current.section.id, offset: current.offset, length: query.length)
    }

    /// Every match found in one section, as offsets into its text.
    public func matches(in section: String) -> [Int] {
        sections.first { $0.id == section }.map { $0.matches.map(Int.init) } ?? []
    }

    /// The query's length in UTF-16 units: how long every match is.
    public var matchLength: Int { query.length }

    private func total() -> Int { sections.reduce(0) { $0 + $1.matches.count } }

    private static func lowerBound(_ values: [Int32], _ value: Int) -> Int {
        var low = 0, high = values.count
        while low < high {
            let middle = (low + high) >> 1
            if Int(values[middle]) < value { low = middle + 1 } else { high = middle }
        }
        return low
    }

    private func indexOfCurrent() -> Int {
        guard let current else { return 0 }
        var index = 0
        for section in sections {
            if section === current.section { break }
            index += section.matches.count
        }
        index += Self.lowerBound(current.section.matches, current.offset)
        currentIndex = index
        return index
    }

    private func locate(_ index: Int) -> (section: Section, offset: Int) {
        var left = index
        for section in sections {
            if left < section.matches.count { return (section, Int(section.matches[left])) }
            left -= section.matches.count
        }
        preconditionFailure("match \(index) is past the \(total()) found")
    }

    private func restart(_ section: Section) {
        section.matches = []
        section.from = 0
        section.complete = false
    }

    /// Search on for one slice, from the bottom up, then again in a task of its own until done.
    private func run() {
        cancel?()
        cancel = nil
        let deadline = now() + Self.sliceMs
        let over = { [now] in now() >= deadline }
        while next >= 0 {
            let section = sections[next]
            if section.complete || searchOn(section, over) { next -= 1 }
            if next >= 0, over() {
                cancel = schedule { [weak self] in self?.run() }
                onChange()
                return
            }
        }
        settle()
        onChange()
    }

    /// Search on in `section` until its end or the slice is spent; whether it is searched.
    private func searchOn(_ section: Section, _ over: () -> Bool) -> Bool {
        if query.length == 0 {
            section.complete = true
            return true
        }
        let haystack = caseSensitive ? section.text : section.foldedText()
        var since = 0
        var at = section.from
        while at <= haystack.length - query.length {
            let found = haystack.range(of: query as String, options: .literal, range: NSRange(location: at, length: haystack.length - at))
            if found.location == NSNotFound { break }
            section.matches.append(Int32(found.location))
            at = found.location + query.length
            section.from = at
            since += 1
            if since >= 1024 {
                since = 0
                if over() { return false }
            }
        }
        section.from = haystack.length
        section.complete = true
        if !section.matches.isEmpty { settle() }
        return true
    }

    /// Make a match current once there is one to be: a new query's last, or,
    /// after the current one's section was drawn again, the match at its
    /// place or the first after it.
    private func settle() {
        if awaitingLast {
            let total = total()
            if total == 0 { return }
            awaitingLast = false
            current = locate(total - 1)
            moves += 1
            return
        }
        if !resettle { return }
        guard let current else {
            let total = total()
            if total == 0 { return }
            resettle = false
            self.current = locate(min(currentIndex, total - 1))
            return
        }
        if !current.section.complete { return }
        resettle = false
        let section = current.section
        let at = Self.lowerBound(section.matches, current.offset)
        if at < section.matches.count {
            self.current = (section, Int(section.matches[at]))
            return
        }
        let after = sections.firstIndex { $0 === section } ?? -1
        if let later = sections.enumerated().first(where: { $0.offset > after && !$0.element.matches.isEmpty })?.element {
            self.current = (later, Int(later.matches[0]))
        } else if total() > 0 {
            self.current = locate(0)
        } else {
            self.current = nil
        }
    }
}
