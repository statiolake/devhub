// Port of apps/desktop/src/main/cli/waitReturn.ts
//
// Where a `--wait` open came from, so that closing it can go back there.
//
// `devhub --wait <file>` is a modal editing session. Something — usually `git
// commit` from a DevHub terminal — hands the person a file, they deal with it,
// they close it, and the thing that was interrupted carries on. The open moved
// the selection to the Workspace holding the file; closing the editor must put
// it back, or a commit written from Workspace A's terminal ends with the person
// looking at Workspace B.
//
// So the open pushes and the close pops, and this is the stack, keyed by the
// wait marker because the marker *is* the session: made before the open, named
// in the open, deleted when the editor closes, and watched by the CLI.
//
// Two selections are pushed: the selection *before* the open (where the pop
// wants to go) and the selection the open *produced* (what makes the pop
// safe). The pop happens when the CLI says the wait ended (`wait-ended`), and
// restores the earlier selection **only if the selection right now is still
// exactly the one the open produced** — a person who has moved on chose where
// they are. Whether the thing returned to still exists is asked of the model
// by the caller.
//
// A restore must never undo an arrangement a *later* wait set: a record whose
// wait began before one still in flight restores nothing. Ending nested waits
// innermost-first restores each in turn.
//
// Nothing is persisted: a wait cannot survive a restart (the CLI ends it when
// DevHub stops answering).
//
// Generic over the selection type, which is WP2's `NavigationSelection`
// (context + presentation, compared with `sameSelection`).

public struct WaitSelectionReturns<Selection: Equatable & Sendable>: Sendable {
    private struct Record: Sendable {
        /// Where the person was when the `--wait` open arrived.
        let before: Selection
        /// Where the open put them, and what the pop is checked against.
        let produced: Selection
    }

    /// In the order the waits began (a `Map` keeps insertion order in the
    /// TypeScript original; re-pushing a marker keeps its place, as `set` on
    /// an existing key does).
    private var order: [String] = []
    private var records: [String: Record] = [:]

    public init() {}

    /// Remember where a `--wait` open came from, and where it went. Every
    /// `--wait` is recorded, including one that arranged nothing: it is a wait
    /// in flight while it lasts, and the nesting rule counts it.
    public mutating func push(_ markerPath: String, before: Selection, produced: Selection) {
        if records[markerPath] == nil { order.append(markerPath) }
        records[markerPath] = Record(before: before, produced: produced)
    }

    /// The selection to go back to now that this wait has ended, or nothing.
    /// The record is dropped whichever answer it gives.
    public mutating func take(_ markerPath: String, current: Selection) -> Selection? {
        guard let record = records[markerPath], let position = order.firstIndex(of: markerPath) else { return nil }
        let laterWaitStands = position < order.count - 1
        records[markerPath] = nil
        order.remove(at: position)
        // A wait that arranged nothing has nothing to put back.
        if record.before == record.produced { return nil }
        if laterWaitStands { return nil }
        return record.produced == current ? record.before : nil
    }

    /// How many waits are being remembered. For tests, and for nothing else.
    public var count: Int { records.count }
}
