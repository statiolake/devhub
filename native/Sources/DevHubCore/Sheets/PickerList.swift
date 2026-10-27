// Port of the rules of apps/desktop/src/shell/components/shell/Picker.tsx and
// of components/shell/PathLabel.tsx's `splitPath`.
//
// Open Quickly, for anything. One control answers every "which one?" DevHub
// asks: a heading that says what is being asked, a search field, a ranked
// list, and a footer. Typing filters, the arrows move, Return chooses, Escape
// cancels or goes back a question — and Option-Return and Command-Return
// choose the same row the other way, which are the only things a caller may
// vary.
//
// **Filtering is local, always.** The caller hands over everything it knows
// about; this ranks it with the shared scorer (`Fuzzy`) and draws what
// matches. A caller whose candidates come from somewhere slow (the workspace
// sources) is also told what was typed, so it can go and ask for more; what
// comes back is simply added to the items it passes. That is what makes the
// list survive typing: the rows on screen are re-ranked in the same frame as
// the keystroke, and a search still running can only add to them.
//
// **Every question that takes a choice among options, or one line of typing,
// is this control.** A line of text is a list with the pinned row that means
// "what I typed"; a confirmation is a list with as many rows as there are
// answers, with the safe one first, because Return takes the first row.
//
// **Cancel is drawn once.** A confirmation names its safe row (`cancelRow`),
// the picker draws it first, choosing it is cancelling, and the footer holds
// no button. A picker without one keeps its footer Cancel.
//
// The view (App) draws a `PickerState`; everything here is the state and its
// rules, so they are tested without a window.

import Foundation

/// What a row draws at its leading edge.
public enum PickerGlyph: String, Hashable, Sendable {
    case plus, clone, ellipsis, folder, host, agent, session, command, workspace, action, issue, branch
}

/// The second line of a row.
public enum PickerDetail: Hashable, Sendable {
    case text(String)
    /// A filesystem path, truncated in the middle (`PathLabel`), and words after it.
    case path(String, suffix: String? = nil)

    /// What the line says, as one string (for search, accessibility and tests).
    public var plain: String {
        switch self {
        case let .text(text): return text
        case let .path(path, suffix): return suffix.map { "\(path)\($0)" } ?? path
        }
    }
}

/// What a row says at its right end, given whether Command is held.
public enum PickerAccessory: Hashable, Sendable {
    /// `TUI` / `GUI`: what Return launches, and what Command-Return would.
    case text(normal: String, alternate: String)
    /// A command's chords, drawn as keycaps.
    case keys([String])

    public func text(alternate: Bool) -> String? {
        switch self {
        case let .text(normal, other): return alternate ? other : normal
        case .keys: return nil
        }
    }
}

/// One row: what is drawn, and what the query is matched against.
public struct PickerItem: Hashable, Sendable {
    public var id: String
    public var label: String
    public var detail: PickerDetail?
    /// What the query matches. The label, when a row is only its name.
    public var searchText: String?
    public var glyph: PickerGlyph?
    /// A pinned row that means *what was typed*, and so is not offered until
    /// something has been.
    public var needsQuery: Bool
    public var accessory: PickerAccessory?
    /// Why this row cannot be taken, when it cannot: it is listed with the
    /// reason under its name, and Return or a click on it does nothing.
    public var unavailable: String?
    /// The row is a git worktree; it only breaks ties (a repository before a
    /// worktree of it the query scores the same).
    public var worktree: Bool

    public init(
        id: String, label: String, detail: PickerDetail? = nil, searchText: String? = nil, glyph: PickerGlyph? = nil,
        needsQuery: Bool = false, accessory: PickerAccessory? = nil, unavailable: String? = nil, worktree: Bool = false
    ) {
        self.id = id
        self.label = label
        self.detail = detail
        self.searchText = searchText
        self.glyph = glyph
        self.needsQuery = needsQuery
        self.accessory = accessory
        self.unavailable = unavailable
        self.worktree = worktree
    }

    public init(id: String, label: String, detail: String?, searchText: String? = nil, glyph: PickerGlyph? = nil,
                needsQuery: Bool = false, unavailable: String? = nil)
    {
        self.init(
            id: id, label: label, detail: detail.map(PickerDetail.text), searchText: searchText, glyph: glyph,
            needsQuery: needsQuery, unavailable: unavailable)
    }
}

/// A row, and how the person asked for it.
public struct PickerChoice: Hashable, Sendable {
    public var id: String
    /// Option: open to the side.
    public var split: Bool
    /// Command: the other presentation.
    public var alternate: Bool
    /// What was in the field when the row was taken.
    public var query: String

    public init(id: String, split: Bool = false, alternate: Bool = false, query: String = "") {
        self.id = id
        self.split = split
        self.alternate = alternate
        self.query = query
    }
}

/// What a confirmation's safe row says.
public struct PickerCancelRow: Hashable, Sendable {
    /// "Cancel", unless the question has a sharper name for doing nothing.
    public var label: String
    /// What staying put leaves as it is.
    public var detail: String

    public init(label: String = "Cancel", detail: String) {
        self.label = label
        self.detail = detail
    }
}

/// Everything a picker is asked with.
public struct PickerPrompt: Hashable, Sendable {
    /// What is being chosen, drawn across the top.
    public var title: String
    /// The sentence under the title: what this list is for, and why now.
    public var question: String
    /// Which question this is, for a picker that is one of several.
    public var step: Int?
    /// An example of what the field takes — and only ever an example.
    public var placeholder: String?
    /// What the field starts with; the caret goes after it.
    public var initialQuery: String
    public var items: [PickerItem]
    /// Rows that do something rather than name something: never filtered,
    /// first while nothing is typed and last once something is.
    public var pinned: [PickerItem]
    /// A source is still answering: a spinner, never an empty list.
    public var busy: Bool
    public var emptyNoMatch: String?
    public var emptyNoItems: String?
    /// A caveat about the question, in the footer.
    public var note: String?
    /// The note is why the last answer did not work (drawn in the danger ink).
    public var noteIsFailure: Bool
    /// Facts under the note, label and value (what a close takes with it).
    public var details: [PickerFact]
    public var cancelRow: PickerCancelRow?

    public init(
        title: String, question: String, step: Int? = nil, placeholder: String? = nil, initialQuery: String = "",
        items: [PickerItem] = [], pinned: [PickerItem] = [], busy: Bool = false, emptyNoMatch: String? = nil,
        emptyNoItems: String? = nil, note: String? = nil, noteIsFailure: Bool = false, details: [PickerFact] = [],
        cancelRow: PickerCancelRow? = nil
    ) {
        self.title = title
        self.question = question
        self.step = step
        self.placeholder = placeholder
        self.initialQuery = initialQuery
        self.items = items
        self.pinned = pinned
        self.busy = busy
        self.emptyNoMatch = emptyNoMatch
        self.emptyNoItems = emptyNoItems
        self.note = note
        self.noteIsFailure = noteIsFailure
        self.details = details
        self.cancelRow = cancelRow
    }

    /// The note, as the reason the last attempt failed.
    public func failing(_ failure: String?) -> PickerPrompt {
        guard let failure else { return self }
        var copy = self
        copy.note = failure
        copy.noteIsFailure = true
        return copy
    }
}

/// One label and value under a question (`mac-detail-list`).
public struct PickerFact: Hashable, Sendable {
    public var label: String
    public var value: String

    public init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }
}

/// What a key or a click did to the picker.
public enum PickerOutcome: Equatable, Sendable {
    case choose(PickerChoice)
    case cancel
}

/// One picker on screen: the prompt, what was typed, the row the arrows are on,
/// and the row that was taken.
public struct PickerState: Equatable, Sendable {
    /// The id the picker gives the row it draws for `cancelRow`.
    public static let cancelRowId = "devhub:picker-cancel"
    /// How far PageUp / PageDown move.
    public static let pageStep = 8

    public var prompt: PickerPrompt
    public private(set) var query: String
    public private(set) var active = 0
    /// Once a row is taken the sheet stops listening: no second choice, no
    /// moving underneath the answer.
    public private(set) var taken: String?

    public init(_ prompt: PickerPrompt) {
        self.prompt = prompt
        query = prompt.initialQuery
    }

    /// The answers: the safe row first when there is one, then the items.
    public var answers: [PickerItem] {
        guard let cancel = prompt.cancelRow else { return prompt.items }
        return [PickerItem(id: Self.cancelRowId, label: cancel.label, detail: .text(cancel.detail))] + prompt.items
    }

    /// The answers the query matches, best first; a repository before a
    /// worktree it scores the same; otherwise the caller's order.
    public var ranked: [PickerItem] {
        Self.rank(answers, query: query)
    }

    public static func rank(_ items: [PickerItem], query: String) -> [PickerItem] {
        var scored: [(item: PickerItem, value: Double, index: Int)] = []
        for (index, item) in items.enumerated() {
            let value = Fuzzy.score(item.searchText ?? item.label, query)
            if value != 0 { scored.append((item, value, index)) }
        }
        scored.sort { left, right in
            if left.value != right.value { return left.value > right.value }
            let l = left.item.worktree ? 1 : 0, r = right.item.worktree ? 1 : 0
            if l != r { return l < r }
            return left.index < right.index
        }
        return scored.map(\.item)
    }

    /// Every row there is, in the order it is drawn: the pinned rows lead
    /// while nothing is typed (without those that mean what was typed) and
    /// trail once something is.
    public var rows: [PickerItem] {
        if !query.isEmpty { return ranked + prompt.pinned }
        return prompt.pinned.filter { !$0.needsQuery } + ranked
    }

    public var activeRow: PickerItem? {
        let rows = self.rows
        return active < rows.count ? rows[active] : nil
    }

    /// The line where the rows would be: "Searching…" while a source answers
    /// and there is nothing yet, else why there is nothing; nil when there is
    /// nothing to say (the band is then empty).
    public var emptyMessage: String? {
        if answers.isEmpty && prompt.busy { return "Searching…" }
        return query.isEmpty ? prompt.emptyNoItems : prompt.emptyNoMatch
    }

    /// Whether the message is drawn: no ranked rows, and something to say.
    public var showsEmpty: Bool { ranked.isEmpty && emptyMessage != nil }

    /// The footer draws Cancel only for a choice among things.
    public var footerHasCancel: Bool { prompt.cancelRow == nil }

    // MARK: Edits

    /// The field changed: the selection goes back to the top.
    public mutating func setQuery(_ next: String) {
        guard taken == nil else { return }
        query = next
        active = 0
    }

    /// The items changed under the person (a source answered).
    public mutating func setPrompt(_ next: PickerPrompt) {
        let activeId = activeRow?.id
        prompt = next
        let rows = self.rows
        if let activeId, let index = rows.firstIndex(where: { $0.id == activeId }) {
            active = index
        } else if active >= rows.count {
            active = 0
        }
    }

    /// The arrows, and Ctrl-N / Ctrl-P: around the list.
    public mutating func move(_ delta: Int) {
        guard taken == nil else { return }
        let count = rows.count
        guard count > 0 else { return }
        active = ((active + delta) % count + count) % count
    }

    /// PageUp / PageDown: clamped, not wrapped.
    public mutating func page(_ direction: Int) {
        guard taken == nil else { return }
        let count = rows.count
        guard count > 0 else { return }
        active = min(count - 1, max(0, active + direction * Self.pageStep))
    }

    /// The pointer moved onto a row.
    public mutating func point(at index: Int) {
        guard taken == nil, index >= 0, index < rows.count else { return }
        active = index
    }

    /// Return on the active row.
    public mutating func chooseActive(split: Bool = false, alternate: Bool = false) -> PickerOutcome? {
        guard let row = activeRow else { return nil }
        return choose(row.id, split: split, alternate: alternate)
    }

    /// A row taken by id (a click, or Return). Nil when nothing happens: the
    /// sheet has already answered, or the row is unavailable.
    public mutating func choose(_ id: String, split: Bool = false, alternate: Bool = false) -> PickerOutcome? {
        guard taken == nil else { return nil }
        if id == Self.cancelRowId { return .cancel }
        let rows = self.rows
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return nil }
        if rows[index].unavailable != nil { return nil }
        active = index
        taken = id
        return .choose(PickerChoice(id: id, split: split, alternate: alternate, query: query))
    }

    /// Escape. Nothing once a row is taken: that would cancel what is running.
    public func escape() -> PickerOutcome? {
        taken == nil ? .cancel : nil
    }

    /// The answer failed and the same sheet asks again: listening resumes.
    public mutating func release() {
        taken = nil
    }
}

/// `splitPath`: a path's head (which gives way) and its last segment (which
/// must survive), separator with the tail.
public enum PathLabel {
    public static func split(_ path: String) -> (head: String, tail: String) {
        guard let cut = path.lastIndex(of: "/"), cut != path.startIndex else { return ("", path) }
        return (String(path[..<cut]), String(path[cut...]))
    }
}
