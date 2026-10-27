// Port of apps/desktop/src/main/shell/editorTerminalExits.ts
//
// Terminal mode: the editor area's shell exiting is the Workspace's close
// button.
//
// In terminal mode the editor area is the Workspace's own tmux session
// (`docs/terminal-mode.md`). When that session ends under the person — they
// typed `exit` in its last shell, or it was killed — the editor area has
// nothing left to show, and what they meant is the same as pressing the
// Workspace's close button. So that is what happens, through the one close
// path there is (`closeWorkspaceOrWorktree`, `AppController.requestCloseWorkspace`):
// a Workspace with nothing to lose closes, and one with something to ask
// about asks it, on the same sheet the close button raises.
//
// When the answer is that the Workspace stays — the question was cancelled,
// the close failed — or it cannot be closed at all (Scratch never is), the
// editor area gets a terminal again: its view is started over, which makes a
// fresh `ws-` session, in place. A client that ended while its session is
// still running (the person detached with tmux's own keys) is simply
// attached again: nothing exited.
//
// # What is not an exit
//
// Only a client that ended on its own is told here
// (`AttachmentManager.onEndedByItself`). Everything DevHub ends itself stops
// the client first — closing a Workspace, quitting, moving the socket, a view
// going or started over — and is never one. Once DevHub is shutting down
// (`dispose`), nothing is acted on at all. And a terminal that keeps ending
// as soon as it starts — a shell that cannot start — is started over a few
// times and then left, with the surface's own Retry, rather than looping.

import Foundation

/// Where a Workspace stands, as far as a close is concerned.
public enum WorkspaceCloseStanding: Equatable, Sendable {
    /// Not in the model: it closed, or never was.
    case gone
    /// A close of it is being inspected or run.
    case closing
    case open
}

/// What `EditorTerminalExits` asks and does. `log`, `now` and `setTimer`
/// are nil for the real ones (no default arguments: a main-actor closure as
/// one is refused where the caller is isolated).
public struct EditorTerminalExitsOptions {
    public var standing: @MainActor (String) async -> WorkspaceCloseStanding
    /// Whether a close can be asked for at all (Scratch: never).
    public var closable: @MainActor (String) async -> Bool
    /// Whether a close's question is on screen, waiting for its answer.
    public var asking: @MainActor () -> Bool
    /// Whether the Workspace's session is there now, without making it.
    public var sessionAlive: @MainActor (String) async throws -> Bool
    /// The Workspace's close button: the one close path.
    public var close: @MainActor (String) -> Void
    /// Start the editor area's terminal over, on a fresh session.
    public var restart: @MainActor (String) -> Void
    public var log: @MainActor (String) -> Void
    public var now: @MainActor () -> Double
    /// Run `work` after `ms`; the handle cancels it.
    public var setTimer: @MainActor (_ ms: Double, _ work: @escaping @MainActor () async -> Void) -> (@MainActor () -> Void)

    public init(
        standing: @escaping @MainActor (String) async -> WorkspaceCloseStanding,
        closable: @escaping @MainActor (String) async -> Bool,
        asking: @escaping @MainActor () -> Bool,
        sessionAlive: @escaping @MainActor (String) async throws -> Bool,
        close: @escaping @MainActor (String) -> Void,
        restart: @escaping @MainActor (String) -> Void,
        log: (@MainActor (String) -> Void)?,
        now: (@MainActor () -> Double)?,
        setTimer: (@MainActor (_ ms: Double, _ work: @escaping @MainActor () async -> Void) -> (@MainActor () -> Void))?
    ) {
        self.standing = standing
        self.closable = closable
        self.asking = asking
        self.sessionAlive = sessionAlive
        self.close = close
        self.restart = restart
        self.log = log ?? { _ in }
        self.now = now ?? { Date().timeIntervalSince1970 * 1000 }
        self.setTimer = setTimer ?? { ms, work in
            let task = Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(ms * 1_000_000))
                if !Task.isCancelled { await work() }
            }
            return { task.cancel() }
        }
    }
}

@MainActor
public final class EditorTerminalExits {
    /// How often a close that is still deciding is looked at again.
    public static let settlePollMs: Double = 250
    /// How many looks in a row must find the close decided — no question, no
    /// close underway — before the terminal is started over: an answer to
    /// one question can be the next close's start, a moment later.
    public static let settledLooks = 2
    /// At most this many restarts of one Workspace's terminal in `restartWindowMs`.
    public static let maxRestarts = 3
    public static let restartWindowMs: Double = 30_000

    private let options: EditorTerminalExitsOptions
    /// Workspaces whose exit is being handled, and how many settled looks so far.
    private var pending: [String: Int] = [:]
    private var pendingOrder: [String] = []
    private var restarts: [String: [Double]] = [:]
    private var timer: (@MainActor () -> Void)?
    private var looking = false
    private var disposed = false

    public init(_ options: EditorTerminalExitsOptions) {
        self.options = options
    }

    /// Whether an exit of `workspaceId` is still being decided.
    public func deciding(_ workspaceId: String) -> Bool { pending[workspaceId] != nil }

    private func setPending(_ workspaceId: String, _ settled: Int?) {
        if let settled {
            if pending.updateValue(settled, forKey: workspaceId) == nil { pendingOrder.append(workspaceId) }
        } else if pending.removeValue(forKey: workspaceId) != nil {
            pendingOrder.removeAll { $0 == workspaceId }
        }
    }

    /// The editor area's client of `workspaceId`'s session ended on its own.
    public func ended(_ workspaceId: String) async {
        if disposed || pending[workspaceId] != nil { return }
        setPending(workspaceId, 0)
        if await options.standing(workspaceId) != .open {
            setPending(workspaceId, nil)
            return
        }
        var alive: Bool
        do {
            alive = try await options.sessionAlive(workspaceId)
        } catch {
            // Not knowing is not an exit: closing a Workspace on a guess is
            // the one answer that must not be given. Its terminal is tried again.
            options.log(
                "[devhub] editor terminal of \(workspaceId): could not read its session (\(error)); attaching again")
            alive = true
        }
        let after = await options.standing(workspaceId)
        if disposed || after != .open {
            setPending(workspaceId, nil)
            return
        }
        if alive {
            setPending(workspaceId, nil)
            restart(workspaceId)
            return
        }
        if !(await options.closable(workspaceId)) {
            setPending(workspaceId, nil)
            restart(workspaceId)
            return
        }
        options.close(workspaceId)
        await look()
    }

    /// Look at every exit still being decided; start the terminal over once one is.
    private func look() async {
        if disposed || looking { return }
        looking = true
        defer { looking = false }
        for workspaceId in pendingOrder {
            guard let settled = pending[workspaceId] else { continue }
            let standing = await options.standing(workspaceId)
            if disposed { return }
            if standing == .gone {
                setPending(workspaceId, nil)
                restarts[workspaceId] = nil
                continue
            }
            if standing == .closing || options.asking() {
                setPending(workspaceId, 0)
                continue
            }
            if settled + 1 < Self.settledLooks {
                setPending(workspaceId, settled + 1)
                continue
            }
            setPending(workspaceId, nil)
            restart(workspaceId)
        }
        schedule()
    }

    private func schedule() {
        if timer != nil || pending.isEmpty || disposed { return }
        timer = options.setTimer(Self.settlePollMs) { [weak self] in
            guard let self else { return }
            self.timer = nil
            await self.look()
        }
    }

    private func restart(_ workspaceId: String) {
        let now = options.now()
        var recent = (restarts[workspaceId] ?? []).filter { now - $0 < Self.restartWindowMs }
        if recent.count >= Self.maxRestarts {
            restarts[workspaceId] = recent
            options.log(
                "[devhub] editor terminal of \(workspaceId) ended \(recent.count + 1) times in \(Int(Self.restartWindowMs / 1000))s; leaving it for Retry"
            )
            return
        }
        recent.append(now)
        restarts[workspaceId] = recent
        options.restart(workspaceId)
    }

    /// DevHub is going: nothing more is acted on.
    public func dispose() {
        disposed = true
        pending = [:]
        pendingOrder = []
        timer?()
        timer = nil
    }
}
