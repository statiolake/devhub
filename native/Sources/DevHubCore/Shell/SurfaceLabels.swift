// Port of apps/desktop/src/shell/components/shell/diagnosticLabel.ts and of
// the window-title rule of apps/desktop/src/ipc/windowTitles.ts and
// apps/desktop/src/main/shell/shellTitle.ts.
//
// The words a row, a pane and the window's name are drawn in, for the states
// the model names with codes.

import Foundation

public enum SurfaceLabels {
    /// `closeDiagnosticLabel`.
    public static func closeDiagnostic(_ diagnostic: DiagnosticCode) -> String {
        switch diagnostic {
        case .rootMissing: return "The workspace folder is missing."
        case .rootInaccessible: return "The workspace folder cannot be read."
        case .closeAgentsUnknown: return "DevHub could not confirm the agents had stopped."
        case .closeTerminalUnknown: return "DevHub could not confirm the terminal had closed."
        case .closeEditorUnknown: return "DevHub could not check the editor for unsaved changes."
        case .closeEditorStarting:
            return "The editor had not finished starting, so DevHub could not check it for unsaved changes."
        case .closeEditorUnresponsive: return "The editor did not answer the request to close."
        case .closeEditorVetoed:
            return "The editor has unsaved changes. Save or discard them, then close the workspace again."
        case .cleanupFailed: return "A cleanup step did not finish."
        case .runtimeUnavailable: return "A runtime DevHub needs is unavailable."
        case .editorRestartExhausted:
            return "The editor for this workspace kept stopping, so DevHub stopped restarting it."
        case .editorUnavailable: return "The editor for this workspace could not be started."
        }
    }

    /// `closeStepLabel`.
    static func closeStep(_ step: CloseStep) -> String {
        switch step {
        case .editor: return "asking the editor to close"
        case .agents: return "stopping the agents"
        case .terminal: return "closing the terminal"
        case .view: return "closing the editor window"
        case .worktree: return "removing the worktree folder"
        case .state: return "saving DevHub's state"
        }
    }

    /// `closeFailureLabel`.
    public static func closeFailure(_ step: CloseStep, _ diagnostic: DiagnosticCode, _ detail: String?) -> String {
        let said = detail?.jsTrimmed ?? ""
        return "Closing stopped while \(closeStep(step)). \(closeDiagnostic(diagnostic))\(said.isEmpty ? "" : " \(said)")"
    }

    /// The close failure of a row, in words, when its last close stopped.
    public static func closeFailure(_ close: WorkspaceClose) -> String? {
        guard case let .failed(step, diagnostic, detail) = close else { return nil }
        return closeFailure(step, diagnostic, detail)
    }

    /// `agentFailureTitle`.
    public static func agentFailureTitle(_ code: AgentFailureCode) -> String {
        switch code {
        case .agentRuntimeUnavailable: return "Agent runtime unreachable"
        case .tmuxCommandFailed: return "Agent runtime refused"
        case .tmuxCommandTimedOut: return "Agent runtime not answering"
        case .tmuxSessionConflict: return "Session conflict"
        case .agentProfileUnavailable: return "Profile unavailable"
        case .workspaceUnavailable: return "Workspace unavailable"
        case .conversationHostLost: return "Conversation unreachable"
        case .conversationProtocolMismatch: return "Protocol mismatch"
        case .conversationNotSignedIn: return "Authentication failed"
        case .conversationRefused: return "CLI refused to start"
        case .conversationFailed: return "Conversation stopped"
        }
    }

    /// `agentFailureSummary`.
    public static func agentFailureSummary(_ code: AgentFailureCode) -> String {
        switch code {
        case .agentRuntimeUnavailable: return "The Agent runtime could not be reached."
        case .tmuxCommandFailed: return "The Agent runtime refused the request."
        case .tmuxCommandTimedOut: return "The Agent runtime did not answer in time."
        case .tmuxSessionConflict: return "The session this Agent needs is not the one that is there."
        case .agentProfileUnavailable: return "This Agent's profile cannot be used."
        case .workspaceUnavailable: return "The workspace this Agent belongs to is unavailable."
        case .conversationHostLost: return "DevHub cannot read this Agent's conversation right now."
        case .conversationProtocolMismatch:
            return "This Agent said something DevHub cannot read, so the conversation has stopped taking input."
        case .conversationNotSignedIn: return "This Agent's CLI is signed out, or its sign-in was refused."
        case .conversationRefused: return "This Agent's CLI refused to start."
        case .conversationFailed: return "DevHub stopped following this Agent's conversation."
        }
    }

    /// `agentFailureLabel`.
    public static func agentFailureLabel(_ failure: AgentFailure) -> String {
        let said = failure.detail?.jsTrimmed ?? ""
        if said.isEmpty { return agentFailureSummary(failure.code) }
        return failure.code == .tmuxCommandFailed || failure.code == .tmuxCommandTimedOut
            ? said
            : "\(agentFailureSummary(failure.code)) \(said)"
    }

    /// `agentNote`: why this Agent may not be doing what its status says.
    public static func agentNote(_ agent: AgentWire) -> String? {
        let stopFailed: String?
        if case let .stopFailed(diagnostic) = agent.controlState {
            stopFailed = closeDiagnostic(diagnostic)
        } else {
            stopFailed = nil
        }
        return RowDescription.agentNote(
            stopping: agent.controlState == .stopping, stopFailed: stopFailed,
            failure: agent.failure.map(agentFailureLabel), runtimeHealth: agent.runtimeHealth
        )
    }

    // MARK: - The window's name

    /// `TITLE_SEPARATOR`.
    public static let titleSeparator = " — "
    /// `WINDOW_TITLES.shell`.
    public static let shellTitle = "DevHub"

    /// `shellWindowTitle`: what is in front, the Workspace it is in, DevHub.
    public static func windowTitle(element: String?, workspace: String) -> String {
        let element = element?.jsTrimmed
        let workspace = workspace.jsTrimmed
        return [element.flatMap { $0.isEmpty ? nil : $0 }, workspace.isEmpty ? nil : workspace, shellTitle]
            .compactMap { $0 }
            .joined(separator: titleSeparator)
    }

    /// `shellTitleFor`, in terminal mode: there is no workbench to report an
    /// editor's title, so a Workspace is named by itself; an Agent by what it
    /// says it is doing, or its name.
    public static func windowTitle(_ snapshot: AppSnapshotWire) -> String {
        switch snapshot.selection.context {
        case let .workspace(id):
            guard let workspace = snapshot.workspace(id) else { return shellTitle }
            return windowTitle(element: nil, workspace: workspace.label)
        case let .agent(id):
            for workspace in snapshot.workspaces {
                if let agent = workspace.agents.first(where: { $0.id == id }) {
                    return windowTitle(element: agent.activity ?? agent.displayName, workspace: workspace.label)
                }
            }
            return shellTitle
        }
    }
}
