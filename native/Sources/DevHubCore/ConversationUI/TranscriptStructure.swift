// The transcript as the view walks it, and where its subagents are drawn.
//
//   entryTree.ts       EntryTree: each entry's children, the requests about each call
//   freshEntries.ts    FreshEntries: which entries just arrived, so only those animate in
//   subagentColumn.ts  SubagentColumn: the column's sizes and folds
//   SubagentPanes.tsx  the placement rule: inline, beside, maximized

import Foundation

// MARK: - The tree (entryTree.ts)

public struct EntryTree: Equatable, Sendable {
    /// The entries directly under a parent, nil being the top level.
    public var children: [EntryId?: [TranscriptEntry]]
    /// The open requests about each tool call, in the order they opened.
    public var requests: [EntryId: [PendingRequest]]
    /// The open requests about no tool call, drawn after the last entry.
    public var unattached: [PendingRequest]
    /// The entry the Agent's plan last stood on, whose checklist is drawn unfolded.
    public var latestPlan: EntryId?

    public init(_ transcript: Transcript) {
        var children: [EntryId?: [TranscriptEntry]] = [:]
        for entry in transcript.entries {
            let parent: EntryId? = entry.kind == "turn-end" ? nil : entry.parent
            children[parent, default: []].append(entry)
        }
        var requests: [EntryId: [PendingRequest]] = [:]
        var unattached: [PendingRequest] = []
        for request in transcript.requests {
            if let entry = request.entry { requests[entry, default: []].append(request) } else { unattached.append(request) }
        }
        self.children = children
        self.requests = requests
        self.unattached = unattached
        latestPlan = DevHubCore.latestPlan(transcript)?.entry
    }

    public var topLevel: [TranscriptEntry] { children[nil] ?? [] }

    public func children(of id: EntryId) -> [TranscriptEntry] { children[id] ?? [] }
}

// MARK: - Fresh entries (freshEntries.ts)

/// Which transcript entries just arrived, so only those animate in.
///
/// An entry is fresh when it appears after the transcript was first drawn and
/// it is one of a few that arrived together. The transcript as it loads — or
/// reloads, after being emptied, or a history arriving in one go — is drawn as
/// it is, with nothing rising into place. A sent message whose echo replaces
/// its "sending" bubble is the same message, so it does not animate twice.
///
/// It is told only what was drawn while the pane was shown: an entry that
/// arrived while nobody was looking is not news when the pane is shown again
/// (`useNoReplayOnShow`).
public struct FreshEntries: Sendable {
    /// More new entries than this at once is a load, not output arriving.
    public static let limit = 4

    private var known: Set<String>?

    public init() {}

    /// The drawn sections now (entry ids, `sending:<id>` for a message on its
    /// way), with the kind each is (`user`, …): which of them are fresh.
    public mutating func drawn(_ present: [(id: String, kind: String)]) -> Set<String> {
        let before = known
        known = present.isEmpty ? nil : Set(present.map(\.id))
        guard let before else { return [] }
        let arrived = present.filter { !before.contains($0.id) }
        if arrived.isEmpty || arrived.count > Self.limit { return [] }
        let ids = Set(present.map(\.id))
        let echoed = before.contains { $0.hasPrefix("sending:") && !ids.contains($0) }
        return Set(arrived.filter { !(echoed && $0.kind == "user") }.map(\.id))
    }

    /// Everything there is now is known, and nothing of it is fresh: the pane
    /// was hidden while it arrived.
    public mutating func settle(_ present: [String]) {
        known = present.isEmpty ? nil : Set(present)
    }

    /// Whether the first draw is in (`data-settled`): what appears inside an
    /// entry from now on eases in.
    public var settled: Bool { known != nil }
}

// MARK: - Subagents (SubagentPanes.tsx)

public enum SubagentPlace: String, Sendable { case inline, beside, maximized }

public enum Subagents {
    /// How wide the pane must be for a column beside the conversation.
    public static let widePanePx: Double = 1040

    /// Whether a subagent has ended: it will not run again, so the column lets it go.
    public static func ended(_ state: SubagentState) -> Bool {
        switch state {
        case .running, .idle: return false
        case .completed, .failed, .unknown: return true
        }
    }

    /// Every call that started a subagent, at any depth, in transcript order.
    public static func all(_ transcript: Transcript) -> [ToolEntry] {
        transcript.entries.compactMap { entry in
            guard case .tool(let tool) = entry, tool.spawns != nil else { return nil }
            return tool
        }
    }

    /// The subagents the column lists, in transcript order: each one that has
    /// not ended, unless the person took it out.
    public static func listed(_ subagents: [ToolEntry], chosen: [EntryId: Bool]) -> [ToolEntry] {
        subagents.filter { !ended($0.spawns!.state) && (chosen[$0.id] ?? true) }
    }

    public static func elsewhere(_ place: SubagentPlace) -> String {
        place == .beside ? "Shown in the column beside the conversation." : "Shown filling the pane."
    }
}

/// The placement rule, as one value the surface keeps (`useSubagentLayout`).
public struct SubagentLayout: Sendable {
    public var wide = false
    public private(set) var all: [ToolEntry] = []
    public private(set) var listed: [ToolEntry] = []
    public private(set) var maximizedId: EntryId?
    public private(set) var chosen: [EntryId: Bool] = [:]
    public var column = SubagentColumn()

    public init() {}

    public mutating func update(_ transcript: Transcript, wide: Bool) {
        self.wide = wide
        all = Subagents.all(transcript)
        listed = Subagents.listed(all, chosen: chosen)
        column = column.withPanes(of: Set(listed.map(\.id)))
    }

    /// The subagent filling the pane; one that is gone (its turn was taken back) fills nothing.
    public var maximized: ToolEntry? { all.first { $0.id == maximizedId } }

    /// The subagents in the column: the listed ones, while it is shown.
    public var beside: [ToolEntry] { wide && maximized == nil ? listed : [] }

    public func place(of id: EntryId) -> SubagentPlace {
        if maximized?.id == id { return .maximized }
        if beside.contains(where: { $0.id == id }) { return .beside }
        return .inline
    }

    public mutating func maximize(_ id: EntryId?) { maximizedId = id }

    public mutating func setBeside(_ id: EntryId, _ value: Bool) {
        chosen[id] = value
        listed = Subagents.listed(all, chosen: chosen)
        column = column.withPanes(of: Set(listed.map(\.id)))
    }
}

// MARK: - The column (subagentColumn.ts)

/// The column of subagents beside the conversation, as sizes and folds: how
/// wide the column is, how the open panes share its height, and which panes
/// are folded to their header. Every change to it is one of the functions
/// here, so a sash dragged, a key pressed on it and a double-click all move
/// the same numbers by the same rule.
public struct SubagentColumn: Equatable, Sendable {
    /// The narrowest the column is dragged to.
    public static let minColumn: Double = 280
    /// The narrowest the conversation beside the column is left.
    public static let minConversation: Double = 400
    /// The lowest an open pane in the column is dragged to.
    public static let minPane: Double = 96
    /// How far one arrow key moves a sash.
    public static let sashStep: Double = 16

    /// The column's width, or nil for its default share (`clamp(320px, 36%, 560px)`).
    public var width: Double?
    /// The share of the column's height each open pane takes. Empty until a
    /// sash is moved: every pane then takes an equal share.
    public var weights: [EntryId: Double] = [:]
    /// The panes folded to their header, keeping their place in the column.
    public var folded: Set<EntryId> = []

    public init(width: Double? = nil, weights: [EntryId: Double] = [:], folded: Set<EntryId> = []) {
        self.width = width
        self.weights = weights
        self.folded = folded
    }

    /// A width kept between its own least and the most that leaves the conversation its least.
    public static func clampWidth(_ width: Double, across: Double) -> Double {
        max(minColumn, min(width, across - minConversation))
    }

    /// The width the column is drawn at in a row `across` wide.
    public func drawnWidth(across: Double) -> Double {
        let preferred = width ?? min(max(320, across * 0.36), 560)
        return max(Self.minColumn, min(preferred, across - Self.minConversation))
    }

    public func withWidth(_ width: Double, across: Double) -> SubagentColumn {
        var next = self
        next.width = Self.clampWidth(width, across: across)
        return next
    }

    public func withDefaultWidth() -> SubagentColumn {
        var next = self
        next.width = nil
        return next
    }

    /// A pane's share of the column's height. One that has none yet takes the mean of the others'.
    public func weight(of id: EntryId) -> Double {
        if let own = weights[id] { return own }
        if weights.isEmpty { return 1 }
        return weights.values.reduce(0, +) / Double(weights.count)
    }

    public struct MeasuredPane: Equatable, Sendable {
        public var id: EntryId
        public var height: Double

        public init(id: EntryId, height: Double) {
            self.id = id
            self.height = height
        }
    }

    public struct NoSash: Error, CustomStringConvertible {
        public let description: String
    }

    /// The sash between open panes `above` and `below` moved by `delta` (down positive).
    public func withSashMoved(_ open: [MeasuredPane], above: Int, below: Int, delta: Double) throws -> SubagentColumn {
        guard above < below, above >= 0, below < open.count else {
            throw NoSash(description: "no sash lies between open panes \(above) and \(below)")
        }
        let upper = open[above], lower = open[below]
        let together = upper.height + lower.height
        if together < 2 * Self.minPane { return self }
        let upperHeight = max(Self.minPane, min(upper.height + delta, together - Self.minPane))
        var next = self
        for pane in open { next.weights[pane.id] = pane.height }
        next.weights[upper.id] = upperHeight
        next.weights[lower.id] = together - upperHeight
        return next
    }

    public func withEqualHeights() -> SubagentColumn {
        var next = self
        next.weights = [:]
        return next
    }

    public func withFold(_ id: EntryId, _ folded: Bool) -> SubagentColumn {
        var next = self
        if folded { next.folded.insert(id) } else { next.folded.remove(id) }
        return next
    }

    /// The column holding only the panes listed: one that has left takes its share and fold with it.
    public func withPanes(of listed: Set<EntryId>) -> SubagentColumn {
        let weightsGone = weights.keys.contains { !listed.contains($0) }
        let foldsGone = folded.contains { !listed.contains($0) }
        if !weightsGone && !foldsGone { return self }
        var next = self
        next.weights = weights.filter { listed.contains($0.key) }
        next.folded = folded.filter { listed.contains($0) }
        return next
    }

    public struct Sash: Equatable, Sendable {
        /// The pane (its index in the column) the sash is drawn above.
        public var before: Int
        /// The open panes it moves, as indices among the open panes.
        public var above: Int
        public var below: Int
    }

    /// The sashes of a column: one between each two open panes that follow one another.
    public static func sashes(_ open: [Bool]) -> [Sash] {
        let openAt = open.enumerated().filter(\.element).map(\.offset)
        return openAt.dropFirst().enumerated().map { lower, before in Sash(before: before, above: lower, below: lower + 1) }
    }
}
