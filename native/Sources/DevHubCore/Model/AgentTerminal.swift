// Port of apps/desktop/src/model/agentTerminal.ts
//
// An Agent's own terminal: one tmux session per Agent, drawn as one pane
// beside its Agent — to the right of it, or under it when the Agent is the
// right half of a split with its editor.
//
// A person who wants more than one shell splits *inside* it — it is a whole
// tmux session — so DevHub draws exactly one terminal pane and never tiles
// them. What belongs to whom is the point of the design:
//
// - **The terminal is the Agent's.** Each Agent has at most one; its session
//   is `tm-<id>` on the Workspace's machine, started in the Workspace's folder.
//   Switching to another Agent shows *that* Agent's terminal, if it has one
//   open; the one left behind keeps running, detached and hidden.
// - **The terminal and its Agent are a set: one is on screen only with the
//   other.** The selected Agent's, full (the terminal on its right) or beside
//   its editor (the editor on the left, the Agent over the terminal on the
//   right); with the Workspace's row selected beside an Agent, the Agent that
//   Workspace pairs with. The editor alone shows no Agent, so it shows no
//   terminal either.
// - **Open and size are per Agent**, and persisted with it.
//
// Everything here is pure: what the model keeps, the rectangles the window
// lays it into, and the reading of the layout files written before this.

import Foundation

public enum AgentTerminals {
    /// The terminal's share of the area it divides with its Agent, as far as
    /// the divider may take it, and where it starts. One range for both the
    /// width beside a full Agent and the height under a split's.
    public static let minShare = 0.15
    public static let maxShare = 0.85
    public static let defaultShare = 0.4

    /// `agentTerminalSessionName`: `tm-<id>`, the way an Agent's own is `ag-<id>`.
    public static func sessionName(_ terminalId: String) -> String { "tm-\(terminalId)" }

    /// `clampTerminalShare`.
    public static func clampShare(_ share: Double) -> Double {
        guard share.isFinite else { return defaultShare }
        return min(maxShare, max(minShare, share))
    }

    /// `isTerminalShare`.
    public static func isShare(_ value: Double) -> Bool {
        value.isFinite && value >= minShare && value <= maxShare
    }

    /// `placeTerminal`: the terminal taking `share` of the width on the right.
    /// Whole pixels, tiling `area` exactly.
    public static func place(_ area: LayoutRect, share: Double, gap: Double) -> TerminalPlacement {
        let available = max(0, area.width - gap)
        let terminalWidth = max(0, jsRoundDouble(available * clampShare(share)))
        let contentWidth = max(0, area.width - gap - terminalWidth)
        return TerminalPlacement(
            content: LayoutRect(x: area.x, y: area.y, width: contentWidth, height: area.height),
            terminal: LayoutRect(
                x: area.x + contentWidth + gap, y: area.y,
                width: max(0, area.width - contentWidth - gap), height: area.height
            ),
            seam: LayoutRect(x: area.x + contentWidth, y: area.y, width: min(gap, area.width), height: area.height)
        )
    }

    /// `placeTerminalBelow`: the terminal taking `share` of the height at the
    /// bottom. What a split's right half — its Agent — is divided into.
    public static func placeBelow(_ area: LayoutRect, share: Double, gap: Double) -> TerminalPlacement {
        let available = max(0, area.height - gap)
        let terminalHeight = max(0, jsRoundDouble(available * clampShare(share)))
        let contentHeight = max(0, area.height - gap - terminalHeight)
        return TerminalPlacement(
            content: LayoutRect(x: area.x, y: area.y, width: area.width, height: contentHeight),
            terminal: LayoutRect(
                x: area.x, y: area.y + contentHeight + gap,
                width: area.width, height: max(0, area.height - contentHeight - gap)
            ),
            seam: LayoutRect(x: area.x, y: area.y + contentHeight, width: area.width, height: min(gap, area.height))
        )
    }

    /// `legacyAgentTerminal`: what a Workspace's terminal turns into when a
    /// file written while terminals were the Workspace's — a tree of panes
    /// (`pane_layout`) and its terminals (`pane_terminals`) — is read now. At
    /// most one survives. Nothing here throws.
    public static func legacy(layout: WireJSON?, terminals: WireJSON?) -> (terminalId: String, share: Double)? {
        guard let list = terminals?.arrayValue, let first = list.first, first.isObject else { return nil }
        guard let terminalId = first["terminal_id"]?.stringValue, isLegacyUuid(terminalId) else { return nil }
        return (terminalId, legacyShare(layout, terminalId: terminalId))
    }

    /// `^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
    private static func isLegacyUuid(_ value: String) -> Bool {
        TextPattern("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").matches(value)
    }

    private static func legacyShare(_ layout: WireJSON?, terminalId: String) -> Double {
        guard let root = layout, root.isObject else { return defaultShare }
        if root["kind"]?.stringValue == "split", root["axis"]?.stringValue == "row",
           case let .number(ratio)? = root["ratio"],
           let second = root["second"], second.isObject,
           second["kind"]?.stringValue == "terminal", second["terminal_id"]?.stringValue == terminalId {
            return clampShare(1 - ratio)
        }
        return defaultShare
    }
}

/// What the model keeps about one Agent's terminal while its session is up.
public struct AgentTerminal: Hashable, Sendable {
    public var agentId: AgentId
    /// The id its session is named by (`tm-<terminalId>`).
    public var terminalId: String
    /// Drawn when its Agent is the view's — `false` is hidden, still running.
    public var open: Bool
    /// When the model learned of it, in main's clock (ms). A tmux reading that
    /// began before this cannot have seen its session. `0` for one restored.
    public var openedAt: Double

    public init(agentId: AgentId, terminalId: String, open: Bool, openedAt: Double) {
        self.agentId = agentId
        self.terminalId = terminalId
        self.open = open
        self.openedAt = openedAt
    }
}

/// Where the content and the terminal go inside an area.
public struct TerminalPlacement: Hashable, Sendable {
    /// What the Agent draws into: the area less the terminal and the seam.
    public var content: LayoutRect
    public var terminal: LayoutRect
    /// The strip between them, `gap` across — what the divider is drawn in.
    public var seam: LayoutRect
}

/// `Math.round` on a double: halves go up.
func jsRoundDouble(_ value: Double) -> Double { (value + 0.5).rounded(.down) }
