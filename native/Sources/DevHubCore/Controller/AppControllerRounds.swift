// Port of the observation half of apps/desktop/src/main/shell/appController.ts
// (`windowFocusChanged`, `reconcileAgentsOn`, `observeTerminalsOn`,
// `releaseIdleMachines`, `agentHosts`, `terminalHosts`, `noteFolderUnreadable`):
// what the cadence loops and the window report, turned into the model's own
// intents. The loops themselves (`Cadence`, WP3) call these on their clocks.

import Foundation

extension AppController {
    /// The window came to the front or went behind another.
    public func windowFocusChanged(_ focused: Bool) {
        dispatchOwn(.windowFocusChanged(focused))
    }

    /// `reconcileAgentsOn`: one round of the reconciler, about one machine.
    public func reconcileAgents(on machine: String) async {
        do {
            _ = try await dispatchAwaiting(.reconcileAgents(machine: machine))
        } catch {
            // The round's refusal was drawn where it belongs (the machine's
            // condition); the loop only needs to go on.
        }
    }

    /// `agentHosts`: the machines with at least one Agent on them now, one
    /// reconcile loop each.
    public func agentMachines() -> [String] {
        var machines: [String] = []
        for workspace in coordinator.model.workspaces where !workspace.agents.isEmpty {
            if !machines.contains(workspace.location.runtimeId) { machines.append(workspace.location.runtimeId) }
        }
        return machines
    }

    /// `terminalHosts`: every machine with a Workspace on it, whose terminals
    /// the Sidebar reports on.
    public func terminalMachines() -> [String] {
        var machines: [String] = []
        for workspace in coordinator.model.workspaces where !machines.contains(workspace.location.runtimeId) {
            machines.append(workspace.location.runtimeId)
        }
        paneTrackers = paneTrackers.filter { machines.contains($0.key) }
        return machines
    }

    /// `observeTerminalsOn`: one round of the terminal-activity loop about one
    /// machine — one `list-panes -a`, made into a reading for every Workspace
    /// on it, and the Agent terminals whose shells have ended taken down.
    public func observeTerminals(on machine: String) async {
        guard let terminals, let id = try? RuntimeId.parse(machine) else { return }
        // When the reading began: a pane terminal learned of after this cannot
        // have been seen by it.
        let since = now()
        let reading: (panes: [PaneSample], terminals: [TerminalSessionSample])
        let shell: String?
        do {
            if try await terminals.unavailableReason(id) != nil { return }
            reading = try await terminals.terminalPanes(id)
            shell = try await terminals.configuredShell(id)
        } catch {
            if terminalActivityFailures.failed(machine, failureText(error)) {
                log("[devhub] terminal activity on \(machine): \(failureText(error))")
            }
            return
        }
        terminalActivityFailures.succeeded(machine)
        var tracker = paneTrackers[machine] ?? PaneActivityTracker()
        let verdicts = tracker.observe(
            reading.panes, nowMs: now(),
            idleSeconds: config?.general.terminalIdleSeconds ?? ConfigConstants.defaultTerminalIdleSeconds,
            configuredShell: shell)
        paneTrackers[machine] = tracker
        // Read the model after the round: a Workspace that closed while tmux
        // was being asked is not one to report on.
        let workspaces = coordinator.model.workspaces.filter { $0.location.runtimeId == machine }.map(\.id)
        let observations = TerminalActivityLoop.observations(verdicts, workspacesOnMachine: workspaces.map(\.rawValue)).map { one in
            WorkspaceTerminalObservation(
                workspaceId: one.workspaceId,
                panes: one.panes.map { TerminalPaneObservation(pane: $0.pane, running: $0.running, inView: $0.inView) })
        }
        dispatchOwn(.terminalActivityObserved(observations))
        let model = coordinator.model
        let here = Set(workspaces)
        if model.agentTerminals().contains(where: { model.workspaceForAgent($0.agentId).map { here.contains($0.id) } ?? false }) {
            dispatchOwn(.paneTerminalsObserved(workspaces: workspaces, alive: reading.terminals.map(\.terminalId), since: since))
        }
        // And which ones nothing owns any more: an Agent that was stopped or
        // ended takes its terminal with it — never one being opened.
        let owned = Set(coordinator.model.agentTerminals().map(\.terminalId))
        for stray in reading.terminals {
            if owned.contains(stray.terminalId) || launchingTerminals.contains(stray.terminalId) { continue }
            guard here.contains(WorkspaceId(unchecked: stray.workspaceId)),
                  let workspace = coordinator.model.workspace(WorkspaceId(unchecked: stray.workspaceId))
            else { continue }
            do {
                try await terminals.closePaneTerminal(PaneTerminalTarget(
                    machine: id, terminalId: stray.terminalId, workspaceId: workspace.id.rawValue, root: workspace.root))
            } catch {
                log("[devhub] closing the terminal of a gone Agent on \(machine): \(failureText(error))")
            }
        }
    }

    /// `releaseIdleMachines`: let go of every machine no Workspace is on any
    /// more. The sessions over there are untouched.
    public func releaseIdleMachines() {
        let live = Set(workspaceMachines())
        for machine in machineConditions.raised where !live.contains(machine) {
            machineConditions.forget(machine)
        }
        for machine in knownMachines where !live.contains(machine) {
            if let id = try? RuntimeId.parse(machine), !id.isLocal { terminals?.forget(id) }
        }
        knownMachines = live
    }

    /// `noteFolderUnreadable`: a Workspace's folder is gone or unreadable.
    public func noteFolderUnreadable(_ root: String, reason: DiagnosticCode) {
        guard let workspace = coordinator.model.workspaces.first(where: { $0.root == root }) else { return }
        dispatchOwn(.workspaceRootUnreadable(workspace.id, reason: reason))
    }
}
