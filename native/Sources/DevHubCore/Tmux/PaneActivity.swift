// Port of apps/desktop/src/main/terminal/paneActivity.ts.
//
// Whether a Workspace terminal's pane is working, from what tmux says about it.
//
// Every round reads, for every pane on the server, in one batched
// `list-panes -a` (`TmuxTerminalRuntime.terminalPanes`):
//
// - `#{pane_current_command}` — the name of the pane's *foreground* process.
//   At a prompt that is the shell; while a command runs it is the command.
// - when the pane last wrote output — see "Output" below.
//
// **The rule, whole:** a pane is *working* while a live process other than the
// shell is in its foreground **and** the pane has written output within the
// last N seconds (`general.terminal_idle_seconds`, default 5). Everything else
// is idle: the command exited and the shell is back, or it is still there but
// has been quiet for N seconds — a `less` left open, a REPL waiting for input.
// Going quiet is treated exactly as finishing; output resuming is working
// again. N = 0 turns the quiet rule off.
//
// - *Not a shell*: the configured shell's name, or any of the common shells.
// - *Live*: a pane kept after its process exited (`remain-on-exit`) runs
//   nothing.
//
// **Output.** tmux has no per-pane "last output" time; it keeps
// `#{window_activity}`, per *window*, to the second. So output is read from two
// signals and attributed carefully:
//
// 1. The pane's own screen moved since the last round — its history grew or
//    its cursor moved (`#{history_size}`, `#{cursor_x}`, `#{cursor_y}`).
// 2. The window's `#{window_activity}` advanced. Exact for the pane that is the
//    only working candidate in its window. With several candidates in one
//    window it is credited to the ones whose own screen moved, and to all of
//    them when none did.
//
// A command starting counts as output, so a silent `sleep 60` is working for N
// seconds and then quiet. A pane first seen by this run is dated by its
// window's activity, not by "now": a `less` that has sat there since yesterday
// is quiet on DevHub's first round.

import Foundation

public enum PaneActivity {
    /// Shells whose prompt is "nothing running", besides the configured one.
    public static let knownShells: Set<String> = [
        "sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "xonsh", "elvish", "pwsh", "login",
    ]

    /// A process name as tmux reports it, without a login shell's `-` or a path.
    public static func commandName(_ command: String) -> String {
        var trimmed = Substring(command.trimmingCharacters(in: .whitespacesAndNewlines))
        while trimmed.hasPrefix("-") { trimmed = trimmed.dropFirst() }
        if let slash = trimmed.lastIndex(of: "/") { return String(trimmed[trimmed.index(after: slash)...]) }
        return String(trimmed)
    }

    /// Whether a foreground process name is a shell sitting at its prompt.
    public static func isShellCommand(_ command: String, configuredShell: String?) -> Bool {
        let name = commandName(command)
        // An empty name is tmux not knowing (a pane being created or torn
        // down); not knowing is not a command running.
        if name.isEmpty { return true }
        return name == configuredShell || knownShells.contains(name)
    }
}

/// One pane, as one `list-panes` expanded it.
public struct PaneSample: Sendable, Equatable {
    /// The Workspace whose terminal session the pane is in.
    public var workspaceId: String
    /// tmux's pane id, `%12`: unique on its server for the pane's life.
    public var pane: String
    /// tmux's window id, `@3`.
    public var window: String
    /// Its window is the session's current one, and a client is attached.
    public var inView: Bool
    public var command: String
    public var dead: Bool
    /// `#{window_activity}`, unix seconds; nil when tmux said nothing.
    public var windowActivity: Int?
    /// `history_size:cursor_x:cursor_y` — moves when the pane writes.
    public var screen: String

    public init(
        workspaceId: String, pane: String, window: String, inView: Bool,
        command: String, dead: Bool, windowActivity: Int?, screen: String
    ) {
        self.workspaceId = workspaceId
        self.pane = pane
        self.window = window
        self.inView = inView
        self.command = command
        self.dead = dead
        self.windowActivity = windowActivity
        self.screen = screen
    }
}

/// One pane's verdict for the model (`model/terminalActivity.ts`).
public struct PaneVerdict: Sendable, Equatable {
    public var workspaceId: String
    public var pane: String
    public var running: Bool
    public var inView: Bool
    public init(workspaceId: String, pane: String, running: Bool, inView: Bool) {
        self.workspaceId = workspaceId
        self.pane = pane
        self.running = running
        self.inView = inView
    }
}

/// The output clock for one tmux server's panes, round to round.
///
/// One per machine, because pane and window ids are a server's. It forgets a
/// pane the round it stops being listed.
public struct PaneActivityTracker: Sendable {
    private struct Remembered: Sendable {
        var command: String
        var screen: String
        var lastOutputMs: Double
    }

    private var panes: [String: Remembered] = [:]
    private var windows: [String: Int?] = [:]

    public init() {}

    public mutating func observe(
        _ samples: [PaneSample],
        nowMs: Double,
        idleSeconds: Double,
        configuredShell: String?
    ) -> [PaneVerdict] {
        let idleMs = max(0, idleSeconds) * 1000
        func busy(_ sample: PaneSample) -> Bool {
            !sample.dead && !PaneActivity.isShellCommand(sample.command, configuredShell: configuredShell)
        }

        // Which panes' own screens moved (or whose command changed) this round.
        var moved = Set<String>()
        for sample in samples {
            if let before = panes[sample.pane], before.screen != sample.screen || before.command != sample.command {
                moved.insert(sample.pane)
            }
        }

        // Which windows wrote since the last round, and which of their working
        // candidates that output is credited to.
        var credited = Set<String>()
        var byWindow: [String: [PaneSample]] = [:]
        var windowOrder: [String] = []
        for sample in samples {
            if byWindow[sample.window] == nil { windowOrder.append(sample.window) }
            byWindow[sample.window, default: []].append(sample)
        }
        for window in windowOrder {
            let list = byWindow[window] ?? []
            let activity = list.first?.windowActivity
            let previous = windows[window] ?? nil
            guard let activity, let previous, activity > previous else { continue }
            let candidates = list.filter(busy)
            let movedCandidates = candidates.filter { moved.contains($0.pane) }
            for one in movedCandidates.isEmpty ? candidates : movedCandidates {
                credited.insert(one.pane)
            }
        }

        var nextPanes: [String: Remembered] = [:]
        var nextWindows: [String: Int?] = [:]
        var verdicts: [PaneVerdict] = []
        for sample in samples {
            nextWindows[sample.window] = .some(sample.windowActivity)
            let lastOutputMs: Double
            if let before = panes[sample.pane] {
                lastOutputMs = moved.contains(sample.pane) || credited.contains(sample.pane) ? nowMs : before.lastOutputMs
            } else {
                // First sight: dated by the window, never by "now".
                lastOutputMs = sample.windowActivity.map { min(nowMs, Double($0) * 1000) } ?? -Double.infinity
            }
            nextPanes[sample.pane] = Remembered(command: sample.command, screen: sample.screen, lastOutputMs: lastOutputMs)
            verdicts.append(PaneVerdict(
                workspaceId: sample.workspaceId,
                pane: sample.pane,
                running: busy(sample) && (idleMs == 0 || nowMs - lastOutputMs < idleMs),
                inView: sample.inView
            ))
        }
        panes = nextPanes
        windows = nextWindows
        return verdicts
    }
}
