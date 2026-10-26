// Port of apps/desktop/src/model/navigationHistory.ts
//
// Back and Forward, as a browser has them, over the places DevHub has shown.
//
// DevHub's shell shows one thing at a time in its content area: a Workspace's
// editor area, an Agent on its own, or the two side by side. That *selection*
// is the shell's whole notion of "where you are", so it is also the whole of
// what an entry here is. This type is generic over the entry so that it stays
// a list and a cursor and nothing else.
//
// The rules are the ones every browser has taught everyone:
//
// - **A visit after going back cuts off what was ahead.**
// - **Going back or forward is not a visit.** The cursor moves first, so the
//   move arrives at the entry it already points to and `visit` sees nothing new.
// - **The same place twice in a row is one entry.**
// - **A place that has gone is skipped, not refused.**
// - **It is bounded.** The oldest entries fall off the front.
//
// It is not persisted.

import Foundation

public enum NavigationDirection: String, Sendable, Hashable, Codable {
    case back
    case forward
}

public struct NavigationHistory<Entry: Sendable>: Sendable {
    /// How many entries are kept. The oldest goes first.
    public static var defaultLimit: Int { 100 }

    public private(set) var list: [Entry]
    public private(set) var position: Int
    private let same: @Sendable (Entry, Entry) -> Bool
    private let limit: Int

    public init(_ initial: Entry, limit: Int = 100, same: @escaping @Sendable (Entry, Entry) -> Bool) {
        self.same = same
        self.limit = max(1, limit)
        list = [initial]
        position = 0
    }

    /// Where the cursor is: the place on screen, as far as history knows.
    public var current: Entry { list[position] }

    /// Note that the selection is now `entry`. `replace` is for a move that is
    /// not a new place. Answers whether anything changed.
    @discardableResult
    public mutating func visit(_ entry: Entry, replace: Bool = false) -> Bool {
        if same(current, entry) { return false }
        if replace {
            list[position] = entry
            return true
        }
        list.removeSubrange((position + 1)...)
        list.append(entry)
        if list.count > limit { list.removeFirst(list.count - limit) }
        position = list.count - 1
        return true
    }

    /// Start again from `entry`, with nothing behind or ahead.
    public mutating func reset(_ entry: Entry) {
        list = [entry]
        position = 0
    }

    private func target(_ direction: NavigationDirection, exists: (Entry) -> Bool) -> Int? {
        let step = direction == .back ? -1 : 1
        var at = position + step
        while at >= 0 && at < list.count {
            let entry = list[at]
            // A neighbour that is the place on screen is no move.
            if exists(entry) && !same(entry, current) { return at }
            at += step
        }
        return nil
    }

    /// Whether `go(direction)` would go anywhere.
    public func can(_ direction: NavigationDirection, exists: (Entry) -> Bool) -> Bool {
        target(direction, exists: exists) != nil
    }

    /// Move the cursor, and say where to: the caller then selects it.
    public mutating func go(_ direction: NavigationDirection, exists: (Entry) -> Bool) -> Entry? {
        guard let at = target(direction, exists: exists) else { return nil }
        position = at
        return list[at]
    }
}
