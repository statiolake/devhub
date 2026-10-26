// Port of the window-facing half of apps/desktop/src/main/shell/appController.ts
// that is about the model rather than about views: `requestCloseAgent`,
// `requestRestartAgent`, `closeWorkspaceOrWorktree`, `requestCloseWorkspace`,
// `answerWorktreeClose`, `raiseCloseConfirmation`, `continueAgentIn`,
// `paneFocused`, `chordHelpRows`, `openCommandPalette`'s rows, the
// `terminal_zoom` chord host and `appearance()`'s zoomed size.
//
// Every one of these answers with the question it has to ask, if any — a
// confirmation or the worktree's three-way sheet — and the window puts it on
// the questions layer: a chord and a row's button are two ways to press the
// same button, and the question is the same question.

import Foundation

extension AppController {
    /// The person did something in the window that has no answer to wait for:
    /// its refusal is drawn, nothing is thrown (`dispatchOwn`).
    @discardableResult
    public func dispatchFromWindow(_ intent: UserIntent) -> IntentOutcome? {
        dispatchOwn(intent)
    }

    /// A wire intent from a view, decoded first; a refusal is drawn.
    @discardableResult
    public func dispatchFromWindow(_ wire: AppIntentWire) -> IntentOutcome? {
        do {
            return dispatchOwn(try UserIntent.fromWire(wire))
        } catch {
            publishError(errorWire(error))
            return nil
        }
    }

    /// `raiseCloseConfirmation`: the question an outcome asks, if it asks one.
    public nonisolated func confirmation(_ outcome: IntentOutcome) -> ModalRequest? {
        guard case let .confirmationRequired(id, _, purpose) = outcome else { return nil }
        return .closeConfirmation(confirmationId: id.rawValue, purpose: purpose)
    }

    /// A view's intent that may come back with a question (`dispatchFromPage`
    /// and the page model's `onConfirmationRequired`): the question, if any.
    /// Its refusal is drawn where the controller draws refusals.
    public func dispatchAsking(_ wire: AppIntentWire) async -> ModalRequest? {
        do {
            return confirmation(try await dispatchWire(wire))
        } catch {
            return nil
        }
    }

    /// `requestCloseAgent`: stop it, asking first exactly as its row does.
    public func requestStopAgent(_ agentId: String) async -> ModalRequest? {
        await dispatchAsking(.stopAgent(agentId: agentId))
    }

    /// `requestRestartAgent`.
    public func requestRestartAgent(_ agentId: String) async -> ModalRequest? {
        await dispatchAsking(.restartAgent(agentId: agentId))
    }

    /// `closeWorkspaceOrWorktree`: the one close, whatever kind of Workspace it
    /// is. A worktree with nothing to lose is removed without a question; one
    /// that is dirty, or that DevHub could not read, asks the three-way
    /// question first; anything else is the ordinary close.
    public func requestCloseWorkspace(_ workspaceId: String) async -> ModalRequest? {
        guard let workspace = coordinator.model.workspaces.first(where: { $0.id.rawValue == workspaceId }) else { return nil }
        let repository = repositoryFacts.status(workspaceId)
        let deletes = repository?.closingDeletesWorktree(root: workspace.root) ?? false
        if !deletes { return await closeWorkspace(workspaceId, worktree: .keep) }
        if repository?.dirty == false { return await closeWorkspace(workspaceId, worktree: .remove) }
        let label = (try? snapshotWire())?.workspace(workspaceId)?.label ?? workspace.root
        return .worktreeClose(
            workspaceId: workspaceId, label: label, root: workspace.root, branch: repository?.branch, dirty: repository?.dirty)
    }

    /// `answerWorktreeClose`: the three-way sheet's answer. Neither removes
    /// anything now: the answer travels with the close as its `worktree` step.
    public func answerWorktreeClose(_ workspaceId: String, deleteFolder: Bool) async -> ModalRequest? {
        await closeWorkspace(workspaceId, worktree: deleteFolder ? .removeAnyway : .keep)
    }

    /// `requestCloseWorkspace`: one intent, whatever state the Workspace is in.
    func closeWorkspace(_ workspaceId: String, worktree: WorktreeDisposition) async -> ModalRequest? {
        guard let id = try? WorkspaceId(workspaceId) else { return nil }
        do {
            return confirmation(try await dispatchAwaiting(.requestCloseWorkspace(id, worktree: worktree)))
        } catch {
            return nil
        }
    }

    /// `continueAgentIn`: carry an Agent on in its other presentation,
    /// resuming `session`; a continue of an Agent that is not idle asks first.
    public func continueAgent(_ agentId: String, session: String?) async -> ModalRequest? {
        guard let id = try? AgentId(agentId), let agent = coordinator.model.agent(id) else { return nil }
        let presentation: AgentPresentation = agent.presentation == .gui ? .tui : .gui
        do {
            return confirmation(try await dispatchAwaiting(.continueAgent(id, presentation: presentation, session: session)))
        } catch {
            return nil
        }
    }

    /// `paneFocused`: a click into one of the content area's views.
    public func paneFocused(_ pane: ContentFocus) {
        guard let snapshot = try? snapshotWire() else { return }
        for intent in ShellLayout.paneFocused(pane, snapshot) { dispatchOwn(intent) }
    }

    /// The table in force (`resolveBindings`).
    public var chordLayout: ChordLayout { ChordLayout.of(config?.keybindings) }

    /// `chordHelpRows`: every chord, from the table actually in effect.
    public func chordHelpRows() -> [ChordHelpRow] {
        let layout = chordLayout
        return ChordHelpRow.rows(prefix: layout.prefix, bindings: layout.table)
    }

    /// `openCommandPalette`'s rows: only the commands `resolveChord` would act
    /// on against the snapshot the palette opens on, recent ones first.
    public func commandPaletteRows(recent: [CommandId]) -> [CommandPaletteRow] {
        guard let snapshot = try? snapshotWire() else { return [] }
        let layout = chordLayout
        return CommandPalette.rows(prefix: layout.prefix, bindings: layout.table, recent: recent) { id in
            (try? Chords.resolve(id, snapshot)) != nil
        }
    }

    /// The `terminal_zoom` chord host: one step, or forget the zoom. Declines
    /// when there are no settings to step from.
    public func terminalZoom(_ direction: TerminalZoom.Direction) -> Bool {
        guard let config else { return false }
        dispatchOwn(.terminalZoom(direction, base: config.appearance.terminalFontSize))
        return true
    }

    /// The terminal size the panes are told: the setting plus the zoom, as one
    /// number (`appearance()`).
    public func terminalFontSize() -> Double {
        let base = config?.appearance.terminalFontSize ?? 13
        return Double(TerminalZoom.zoomedFontSize(base: base, offset: coordinator.model.terminalZoomOffset))
    }

}
