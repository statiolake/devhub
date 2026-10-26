// Port of the rule halves of apps/desktop/src/main/shell/windowAttention.ts and
// apps/desktop/src/main/shell/agentNotifications.ts, and of `ModalRequest`
// (with `ChordHelpRowWire` / `CommandPaletteRowWire`) from
// apps/desktop/src/ipc/contract.ts.

import Foundation

// MARK: - windowAttention.ts

/// "Over here" — said by the window, not by a view inside it: a Dock badge
/// while anything is waiting, and a critical Dock bounce while anything is
/// waiting *and* the window is not focused.
public enum WindowAttentionRule {
    /// The mark on the Dock icon: a bullet rather than a count.
    public static let badge = "●"

    /// `wantsAttention`: whether anything is waiting for the person, and is not
    /// what they are looking at.
    public static func wantsAttention(_ snapshot: AppSnapshotWire) -> Bool {
        let selected = snapshot.selection.context.agentId
        return snapshot.workspaces.contains { workspace in
            workspace.agents.contains { $0.unread != nil && $0.id != selected }
        }
    }
}

/// As much of macOS's Dock as this needs, so a test can be the other half.
public protocol AttentionDock: AnyObject {
    func setBadge(_ text: String)
    func bounceCritical() -> Int
    func cancelBounce(_ id: Int)
}

/// The signal, as a state rather than as a pair of events. Told everything
/// that can change the answer, and idempotent.
public final class WindowAttention {
    private let dock: AttentionDock
    private var wanted = false
    private var focused = false
    private var bouncing: Int?
    private var badged = false

    public init(dock: AttentionDock) { self.dock = dock }

    /// The projection moved: something may now be waiting, or may not be.
    public func observe(_ snapshot: AppSnapshotWire) {
        wanted = WindowAttentionRule.wantsAttention(snapshot)
        apply()
    }

    /// The window came forward or went away.
    public func windowFocusChanged(_ focused: Bool) {
        self.focused = focused
        apply()
    }

    private func apply() {
        if wanted != badged {
            dock.setBadge(wanted ? WindowAttentionRule.badge : "")
            badged = wanted
        }
        // Bouncing at somebody who is already looking at the window is noise.
        let shouldBounce = wanted && !focused
        if shouldBounce && bouncing == nil {
            bouncing = dock.bounceCritical()
            return
        }
        if !shouldBounce, let id = bouncing {
            dock.cancelBounce(id)
            bouncing = nil
        }
    }
}

// MARK: - agentNotifications.ts

/// "Your turn" — tell the person when an Agent has finished or needs them.
///
/// - Only working → idle/waiting fires; an Agent must have been observed
///   working by this run first.
/// - Debounced: the new status must hold for `debounceMs`.
/// - Not when the person is already looking: window focused and that Agent is
///   the selection.
public enum AgentNotificationKind: String, Hashable, Sendable {
    case finished
    case waiting
}

public struct AgentNotification: Hashable, Sendable {
    public var agentId: String
    public var kind: AgentNotificationKind
    public var title: String
    public var body: String
    public var sound: Bool
}

public struct NotifierSettings: Hashable, Sendable {
    public var enabled: Bool
    public var sound: Bool

    public init(enabled: Bool, sound: Bool) {
        self.enabled = enabled
        self.sound = sound
    }
}

public protocol NotifierHost: AnyObject {
    func notifierSettings() -> NotifierSettings
    func windowFocused() -> Bool
    func snapshot() -> AppSnapshotWire
    func notify(_ notification: AgentNotification)
    func setTimer(_ ms: Double, _ fire: @escaping () -> Void) -> Int
    func clearTimer(_ handle: Int)
}

public final class AgentNotifier {
    public static let debounceMs: Double = 1500

    private struct Tracked {
        var armed = false
        var timer: Int?
        var pending: AgentNotificationKind?
    }

    private unowned let host: NotifierHost
    private var agents: [String: Tracked] = [:]
    private var order: [String] = []

    public init(host: NotifierHost) { self.host = host }

    /// `agentIsOnScreen`.
    public static func agentIsOnScreen(_ snapshot: AppSnapshotWire, agentId: String, windowFocused: Bool) -> Bool {
        windowFocused && snapshot.selection.context.agentId == agentId
    }

    /// `snippet`: a short single-line excerpt, or nothing.
    public static func snippet(_ text: String?, max: Int = 100) -> String {
        let line = TextPattern("\\s+").replacing(in: text ?? "", with: " ").jsTrimmed
        let units = Array(line.utf16)
        if units.count <= max { return line }
        return String(decoding: units.prefix(max - 1), as: UTF16.self) + "…"
    }

    public func observe(_ snapshot: AppSnapshotWire) {
        var seen = Set<String>()
        for workspace in snapshot.workspaces {
            for agent in workspace.agents {
                seen.insert(agent.id)
                if agents[agent.id] == nil {
                    agents[agent.id] = Tracked()
                    order.append(agent.id)
                }
                step(agent.id, agent.status)
            }
        }
        for id in order where !seen.contains(id) {
            cancel(id)
            agents[id] = nil
        }
        order.removeAll { !seen.contains($0) }
    }

    private func step(_ id: String, _ status: AgentStatus) {
        switch status {
        case .working:
            agents[id]!.armed = true
            cancel(id)
        case .idle, .waiting:
            let kind: AgentNotificationKind = status == .idle ? .finished : .waiting
            guard agents[id]!.armed, agents[id]!.pending != kind else { return }
            cancel(id)
            agents[id]!.pending = kind
            agents[id]!.timer = host.setTimer(Self.debounceMs) { [weak self] in
                guard let self, self.agents[id] != nil else { return }
                self.agents[id]!.timer = nil
                self.agents[id]!.pending = nil
                self.fire(id, kind)
            }
        default:
            // background / unknown: neither a finish nor a new start.
            cancel(id)
            if status == .error { agents[id]!.armed = false }
        }
    }

    private func cancel(_ id: String) {
        if let timer = agents[id]?.timer { host.clearTimer(timer) }
        agents[id]?.timer = nil
        agents[id]?.pending = nil
    }

    private func fire(_ id: String, _ kind: AgentNotificationKind) {
        agents[id]?.armed = false
        let settings = host.notifierSettings()
        guard settings.enabled else { return }
        let snapshot = host.snapshot()
        if Self.agentIsOnScreen(snapshot, agentId: id, windowFocused: host.windowFocused()) { return }
        for workspace in snapshot.workspaces {
            guard let agent = workspace.agents.first(where: { $0.id == id }) else { continue }
            let what = kind == .finished ? "Finished" : "Waiting for permission"
            let extra = Self.snippet(agent.activity)
            host.notify(AgentNotification(
                agentId: id, kind: kind, title: "\(agent.displayName) — \(workspace.label)",
                body: extra.isEmpty ? what : "\(what): \(extra)", sound: settings.sound
            ))
            return
        }
    }

    public func dispose() {
        for id in order { cancel(id) }
        agents = [:]
        order = []
    }
}

// MARK: - The questions layer (ipc/contract.ts `ModalRequest`)

/// One row of the chord help overlay.
public struct ChordHelpRow: Hashable, Sendable {
    public var commandId: CommandId
    public var label: String
    /// Every chord that reaches it, written out in full: `Cmd+Q Shift+N`.
    public var chords: [String]
    /// What must be selected for it to do anything, in words, or nothing.
    public var needs: String?

    /// `NEEDS_PHRASE` (appController.ts).
    public static func needsPhrase(_ needs: CommandNeeds) -> String? {
        switch needs {
        case .nothing: return nil
        case .workspace: return "with a workspace selected"
        case .agent: return "with an Agent selected"
        case .split: return "with the editor and an Agent side by side"
        }
    }

    /// `chordHelpRows`: the overlay, rendered from the registry — so it
    /// reflects rebinding. A command with no key at all is left out.
    public static func rows(prefix: ChordKey, bindings: [KeyBinding]) -> [ChordHelpRow] {
        let armed = ChordKeys.describe(prefix)
        return Commands.all.map { command in
            ChordHelpRow(
                commandId: command.id, label: command.label,
                chords: Commands.keys(for: command.id, in: bindings).map { "\(armed) \(ChordKeys.describe($0))" },
                needs: needsPhrase(command.needs)
            )
        }.filter { !$0.chords.isEmpty }
    }
}

/// What a sheet is asked to draw: every question DevHub can put in front of
/// the window, in terminal mode.
public enum ModalRequest: Equatable, Sendable {
    case workspacePicker
    case agentPicker(workspaceId: String)
    case issueAssignment
    case agentRename(agentId: String)
    /// Which of an Agent's configured actions to send it.
    case agentActions(agentId: String)
    /// Every workspace and Agent, as a list to choose from (`Cmd+Q G`).
    case tabPicker
    /// Closing a worktree that has something in it to lose: keep the folder,
    /// delete it anyway, or do nothing (Cancel the default).
    case worktreeClose(workspaceId: String, label: String, root: String, branch: String?, dirty: Bool?)
    case chordHelp(rows: [ChordHelpRow])
    /// Every command, by name — `Cmd+Q :`.
    case commandPalette(rows: [CommandPaletteRow])
    /// The wording DevHub is about to say, before it says it.
    case injectionReview(agentId: String, injectionId: String, actionName: String, text: String)
    case closeConfirmation(confirmationId: String, purpose: ConfirmationOutcomePurpose)
}

public struct OpenModal: Equatable, Sendable {
    public var id: String
    public var request: ModalRequest

    public init(id: String, request: ModalRequest) {
        self.id = id
        self.request = request
    }
}
