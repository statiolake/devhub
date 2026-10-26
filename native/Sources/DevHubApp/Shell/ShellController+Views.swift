// What the window's own views ask of it: the Sidebar's rows and controls
// (`useSidebar`'s dispatch, `closeWorkspace`, `openExternalUrl`, the row menus,
// the resize), the title bar's and the surface's buttons, the seams' drags
// (`previewLayout` and the commits), and the tooltip.

import AppKit
import DevHubCore

extension ShellController: SidebarHost {
    func sidebarSelect(_ context: ContextWire, split: Bool, byPointer: Bool) {
        guard let controller else { return }
        // A pointer selection means "take me there": the keys follow it once
        // it has been applied. A keyboard one stays in the Sidebar.
        if byPointer { keyboardInSidebarCleared() }
        Task { @MainActor [weak self] in
            await controller.dispatchFromWindow(AppIntentWire.selectContext(context, split: split))
            if byPointer { self?.placeKeyboardOnSurface() }
        }
    }

    func sidebarDispatch(_ intent: AppIntentWire) {
        if case let .stopAgent(agentId) = intent {
            // The row's stop asks exactly as the chord does.
            requestStopAgent(agentId)
            return
        }
        dispatch(intent)
    }

    func sidebarCreateAgent(_ workspaceId: String) {
        openModal(.agentPicker(workspaceId: workspaceId))
    }

    func sidebarCloseWorkspace(_ workspaceId: String) {
        requestCloseWorkspace(workspaceId)
    }

    func sidebarMenu(_ action: Sidebar.MenuAction) {
        switch action {
        case let .rename(agentId): openModal(.agentRename(agentId: agentId))
        case let .intent(intent):
            switch intent {
            case let .stopAgent(agentId): requestStopAgent(agentId)
            case let .restartAgent(agentId): requestRestartAgent(agentId)
            default: dispatch(intent)
            }
        case let .continueAgent(agentId): continueAgent(agentId)
        case let .closeWorkspace(workspaceId): requestCloseWorkspace(workspaceId)
        }
    }

    func sidebarOpenURL(_ url: String) { openExternal(url) }

    func sidebarOpenWorkspacePicker() { openModal(.workspacePicker) }

    func sidebarOpenIssueAssignment() { openModal(.issueAssignment) }

    func sidebarPreviewWidth(_ width: Double?) {
        var next = preview
        next.sidebarWidth = width
        setPreview(next)
    }

    func sidebarCommitWidth(_ width: Double) {
        guard let controller else { return sidebarPreviewWidth(nil) }
        Task { @MainActor [weak self] in
            await controller.dispatchFromWindow(AppIntentWire.resizeSidebar(width: width))
            self?.sidebarPreviewWidth(nil)
        }
    }

    func sidebarLeave() {
        placeKeyboardOnSurface()
    }

    func sidebarShowTooltip(_ lines: [TooltipLine], anchor: CGRect) {
        if modals.isPresenting { return }
        window.tooltip.show(lines, anchor: anchor)
    }

    func sidebarReleaseTooltip() { window.tooltip.release() }

    func sidebarHideTooltip() { window.tooltip.hideNow() }
}

extension ShellController: BackdropHost {
    func backdropDispatch(_ intent: AppIntentWire) {
        if case let .navigateHistory(direction) = intent {
            _ = navigateHistory(direction)
            return
        }
        dispatch(intent)
    }

    func backdropPreview(_ next: LayoutPreview) {
        var merged = preview
        if let ratio = next.splitRatio { merged.splitRatio = ratio }
        if let share = next.terminalShare { merged.terminalShare = share }
        setPreview(merged)
    }

    func backdropCommitSplit(_ ratio: Double) {
        guard let controller else { return }
        Task { @MainActor [weak self] in
            await controller.dispatchFromWindow(AppIntentWire.resizeSplit(ratio: ratio))
            guard let self else { return }
            var next = self.preview
            next.splitRatio = nil
            self.setPreview(next)
        }
    }

    func backdropCommitTerminal(terminalId: String, share: Double, stacked: Bool) {
        guard let controller,
              let agent = snapshot?.workspaces.lazy.flatMap(\.agents).first(where: { $0.terminal?.id == terminalId }) else { return }
        let agentId = agent.id
        Task { @MainActor [weak self] in
            await controller.dispatchFromWindow(AppIntentWire.resizeAgentTerminal(agentId: agentId, share: share, stacked: stacked))
            guard let self else { return }
            var next = self.preview
            next.terminalShare = nil
            self.setPreview(next)
        }
    }

    func backdropRetryWorkspace(_ workspaceId: String) {
        dispatch(.retryWorkspace(workspaceId: workspaceId))
    }

    func backdropLocateWorkspace(_ workspaceId: String) {
        guard let nsWindow = window.window else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Locate"
        Task { @MainActor [weak self] in
            let response = await panel.beginSheetModal(for: nsWindow)
            guard response == .OK, let path = panel.url?.path else { return }
            self?.dispatch(.locateWorkspace(workspaceId: workspaceId, path: path))
        }
    }

    func backdropCloseWorkspace(_ workspaceId: String) {
        requestCloseWorkspace(workspaceId)
    }
}
