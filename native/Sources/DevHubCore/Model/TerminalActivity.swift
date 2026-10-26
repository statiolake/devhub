// Port of apps/desktop/src/model/terminalActivity.ts, terminalMode.ts and
// terminalZoom.ts
//
// What a Workspace's own terminals are doing, in the Agents' vocabulary.
//
// A Workspace's terminals are panes in its tmux session. The person types a
// command into one, goes to another Workspace, and wants the row to say two
// things an Agent's row already says: *something is still going there*, and
// *it finished while you were away*. So the reading is an `AgentStatus` and
// the mark is an `UnreadReason`, and the Sidebar draws them with the Agents'
// own status mark — one vocabulary, not a second one that could drift from it.
//
// Only two of the statuses are ever used: `working` while any pane is
// working, `idle` otherwise. A pane is working while a command (not the shell)
// is in its foreground *and* it has printed within the last few seconds.
//
// **Per pane, then rolled up.** Unread belongs to the pane whose command
// finished, because "seen" is a fact about a pane. The row is the roll-up —
// working if any pane is, unread if any pane is.
//
// **Seen** mirrors an Agent's rule (`AppModel.isAgentVisible`): DevHub is the
// window in front, the Workspace's editor area is what the content area is
// drawing, and the pane is on screen in its tmux session.
//
// Not persisted. It is a reading of live tmux state and is rebuilt by the
// first round after a launch.

import Foundation

/// One pane, as one round saw it.
public struct TerminalPaneObservation: Hashable, Sendable {
    /// tmux's pane id (`%12`), stable for the pane's life on its server.
    public var pane: String
    /// Working: a command other than the shell is in the foreground and has
    /// printed recently. False once it exits or goes quiet.
    public var running: Bool
    /// The pane is on screen in its session: its window is the current one and
    /// a client is attached.
    public var inView: Bool

    public init(pane: String, running: Bool, inView: Bool) {
        self.pane = pane
        self.running = running
        self.inView = inView
    }
}

/// Every pane of one Workspace's terminal session, from one round.
public struct WorkspaceTerminalObservation: Hashable, Sendable {
    public var workspaceId: String
    /// Empty when the Workspace has no terminal session (closed, or never opened).
    public var panes: [TerminalPaneObservation]

    public init(workspaceId: String, panes: [TerminalPaneObservation]) {
        self.workspaceId = workspaceId
        self.panes = panes
    }
}

/// A Workspace's terminals, rolled up, in the Agents' types.
public struct TerminalActivity: Hashable, Sendable {
    /// `working` or `idle`, never anything else.
    public var status: AgentStatus
    public var unread: UnreadReason?

    public init(status: AgentStatus, unread: UnreadReason?) {
        self.status = status
        self.unread = unread
    }

    public static let idle = TerminalActivity(status: .idle, unread: nil)
}

/// One Workspace's panes and the rule that moves them.
///
/// working → finished (exited or quiet) unseen → unread → seen → read;
/// finished while seen is never unread; output again while unread is working;
/// a pane that closes takes its state with it.
public struct TerminalPanes: Hashable, Sendable {
    private struct PaneState: Hashable, Sendable {
        var running: Bool
        var inView: Bool
        var unread: Bool
    }

    /// In the order the round named them, as a `Map` keeps them.
    private var order: [String] = []
    private var panes: [String: PaneState] = [:]

    public init() {}

    /// Take one round's reading. `workspaceVisible` is the model's half of
    /// "seen". Returns whether the roll-up changed.
    @discardableResult
    public mutating func observe(_ observations: [TerminalPaneObservation], workspaceVisible: Bool) -> Bool {
        let before = activity
        var nextOrder: [String] = []
        var next: [String: PaneState] = [:]
        for pane in observations {
            let previous = panes[pane.pane]
            let seen = workspaceVisible && pane.inView
            let finished = previous?.running == true && !pane.running
            if next[pane.pane] == nil { nextOrder.append(pane.pane) }
            next[pane.pane] = PaneState(
                running: pane.running, inView: pane.inView,
                unread: seen ? false : (previous?.unread ?? false) || finished
            )
        }
        // A pane that is not in the reading has closed: there is nothing left
        // to look at, so there is nothing left unread.
        order = nextOrder
        panes = next
        return before != activity
    }

    /// The Workspace became visible: every pane on screen in its session is
    /// read. Returns whether the roll-up changed.
    @discardableResult
    public mutating func read() -> Bool {
        let before = activity
        for id in order where panes[id]!.unread && panes[id]!.inView {
            panes[id]!.unread = false
        }
        return before != activity
    }

    /// Forget every pane: the session is gone, or the Workspace is.
    @discardableResult
    public mutating func clear() -> Bool {
        let before = activity
        order = []
        panes = [:]
        return before != activity
    }

    public var activity: TerminalActivity {
        var running = false
        var unread = false
        for pane in panes.values {
            running = running || pane.running
            unread = unread || pane.unread
        }
        if !running && !unread { return .idle }
        return TerminalActivity(status: running ? .working : .idle, unread: unread ? .idle : nil)
    }
}

// MARK: - terminalMode.ts

/// Which Workspaces terminal mode can serve, said once
/// (`docs/terminal-mode.md`).
public enum TerminalMode {
    /// `terminalModeSupports`: a folder on this Mac whose editor is not
    /// attached to a dev container.
    public static func supports(location: WorkspaceLocation, editor: EditorAttachment) -> Bool {
        location.isLocal && editor == .host
    }

    /// `terminalModeUnsupported`: the editor area's state and a refused file
    /// jump use the same sentence.
    public static func unsupported(location: WorkspaceLocation) -> String {
        location.isLocal
            ? "Terminal mode does not support Workspaces whose editor is in a dev container yet."
            : "Terminal mode does not support Workspaces on SSH hosts yet."
    }
}

// MARK: - terminalZoom.ts

/// How big the Agent panes' text is, as one number the person can change.
///
/// The size itself is a setting (`[appearance] terminal_font_size`), and the
/// zoom is an **offset** in whole pixels from whatever the setting says, kept
/// in DevHub's own state file: `effective = clamp(setting + offset)`. Editing
/// the setting moves the zoomed size with it, and reset is `offset = 0`.
public enum TerminalZoom {
    /// The smallest the Agent panes' text may be drawn.
    public static let minFontSize = 9
    /// The largest.
    public static let maxFontSize = 24
    /// The furthest an offset can be from the base and still name a size.
    public static let maxOffset = maxFontSize - minFontSize

    public enum Direction: String, Sendable, Hashable {
        case zoomIn = "in"
        case zoomOut = "out"
        case reset
    }

    /// `isTerminalZoomOffset`: whole, finite, and in range.
    public static func isOffset(_ value: Double) -> Bool {
        value.isFinite && value.rounded() == value && abs(value) <= Double(maxOffset)
    }

    public static func isOffset(_ value: Int) -> Bool { abs(value) <= maxOffset }

    /// `zoomedTerminalFontSize`: clamped rather than refused.
    public static func zoomedFontSize(base: Double, offset: Int) -> Int {
        clampFontSize(jsRound(base) + offset)
    }

    private static func clampFontSize(_ size: Int) -> Int { min(maxFontSize, max(minFontSize, size)) }

    /// `nextTerminalZoomOffset`: worked out from the *size* rather than from
    /// the offset, so that a zoom that has run into an end of the range comes
    /// straight back on the first step in the other direction.
    public static func nextOffset(base: Double, offset: Int, direction: Direction) -> Int {
        if direction == .reset { return 0 }
        let step = direction == .zoomIn ? 1 : -1
        let from = zoomedFontSize(base: base, offset: offset)
        return clampFontSize(from + step) - jsRound(base)
    }

    /// `Math.round`: halves go up, towards +∞.
    static func jsRound(_ value: Double) -> Int { Int((value + 0.5).rounded(.down)) }
}
