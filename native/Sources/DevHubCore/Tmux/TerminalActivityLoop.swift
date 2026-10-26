// Port of apps/desktop/src/main/shell/terminalActivityLoop.ts.
//
// The loop that tells the Sidebar what each Workspace's terminals are doing.
//
// **Why a poll.** tmux pushes nothing when a pane's foreground process changes,
// and "this pane has been quiet for five seconds" is not an event tmux has at
// all. Control mode would stream every byte every pane prints, and shell
// integration would need DevHub to edit the person's shell config. What tmux
// *does* keep, for every pane, is what is needed — the foreground command and
// enough about its output to date it (`PaneActivity`) — and one `list-panes
// -a` reads all of it at once.
//
// **What it costs.** One tmux invocation per machine per round, at most once a
// second. The loop is `AgentReconciler`'s, one per machine with a Workspace on
// it, so it never overlaps itself and stops with its machine.
//
// **When a machine cannot answer** the reading is skipped and the rows keep
// what they last showed, and the failure is logged once per distinct reason
// rather than once a second.

import Foundation

public enum TerminalActivityLoop {
    /// The fastest the loop runs on any machine.
    public static let intervalMs = 1_000.0

    /// A machine as the terminal loop sees it: the same id, and its own
    /// cadence clamped to at most one round a second — read every time,
    /// because a remote runtime's cadence moves with its round trips.
    public static func host(_ runtime: any ReconcileHost) -> any ReconcileHost {
        ReconcileHostValue(id: runtime.id) {
            var cadence = runtime.cadence
            cadence.reconcileIntervalMs = max(intervalMs, cadence.reconcileIntervalMs)
            return cadence
        }
    }

    /// One pane of a Workspace's terminal, for the model
    /// (`WorkspaceTerminalObservation` in `model/terminalActivity.ts`).
    public struct PaneObservation: Sendable, Equatable {
        public var pane: String
        public var running: Bool
        public var inView: Bool
    }

    public struct Observation: Sendable, Equatable {
        public var workspaceId: String
        public var panes: [PaneObservation]
    }

    /// One machine's panes, grouped by Workspace, with every Workspace on the
    /// machine present — an empty list is how a closed session's state is
    /// cleared. A pane whose Workspace DevHub does not have is dropped.
    public static func observations(_ panes: [PaneVerdict], workspacesOnMachine: [String]) -> [Observation] {
        var grouped: [String: [PaneObservation]] = [:]
        var order: [String] = []
        for id in workspacesOnMachine where grouped[id] == nil {
            grouped[id] = []
            order.append(id)
        }
        for reading in panes where grouped[reading.workspaceId] != nil {
            grouped[reading.workspaceId]!.append(PaneObservation(pane: reading.pane, running: reading.running, inView: reading.inView))
        }
        return order.map { Observation(workspaceId: $0, panes: grouped[$0] ?? []) }
    }
}

/// Say a machine's failure once per reason, not once per round.
public struct FailureOnce: Sendable {
    private var last: [String: String] = [:]

    public init() {}

    /// Whether this reason is new for this machine (and so worth logging).
    public mutating func failed(_ machine: String, _ reason: String) -> Bool {
        if last[machine] == reason { return false }
        last[machine] = reason
        return true
    }

    public mutating func succeeded(_ machine: String) {
        last[machine] = nil
    }
}
