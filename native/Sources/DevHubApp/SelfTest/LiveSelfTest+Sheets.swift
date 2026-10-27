// The live phase's first steps: Scratch's terminal on tmux, and the sheets a
// person opens from the keyboard (the palette, the shortcuts, Go to, Open
// Workspace, New Agent), each completed or cancelled with keys.

import AppKit
import DevHubCore

extension LiveSelfTest {
    func scratch(_ d: SelfTestDriver) async {
        let ready = await d.until(30) {
            guard let snapshot = self.snapshot, snapshot.readiness == .ready else { return false }
            return self.editorPane(snapshot.scratchWorkspaceId) != nil
        }
        d.check(ready, "Scratch's editor area has no terminal view")
        let accepted = await d.until(5) { self.shell.config?.general.workbench == "terminal" }
        d.check(accepted, "the self-test's settings were not accepted")
        guard let snapshot, let pane = editorPane(snapshot.scratchWorkspaceId) else { return }
        let attached = await d.until(20) { pane.isAttached }
        d.check(attached, "Scratch's editor terminal did not attach to tmux (\(pane.connection))")
        if !attached, let scratch = snapshot.workspace(snapshot.scratchWorkspaceId) {
            d.note("Scratch is \(scratch.root) (state \(scratch.state)); tmux has \(sessions())")
        }
        d.check(sessions().contains { $0.hasPrefix("ws-") }, "there is no ws- session (\(sessions()))")
        func clientSize() -> String {
            tmuxSays(["list-clients", "-F", "#{client_width}x#{client_height}"]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let before = clientSize()
        window?.setContentSize(NSSize(width: 1100, height: 760))
        let resized = await d.until(10) {
            let now = clientSize()
            let grid = pane.terminal.getTerminal()
            return !now.isEmpty && now != before && now.split(separator: "\n").contains("\(grid.cols)x\(grid.rows)")
        }
        d.check(resized, "tmux's client is \(clientSize()) after a resize (was \(before))")
        // Typed with the keyboard, into the terminal the click put the keys in.
        await d.click(pane.terminal)
        d.check(window?.firstResponder === pane.terminal, "a click did not put the keys in Scratch's terminal (\(String(describing: window?.firstResponder)))")
        await d.type("echo devhub-live\r", in: window)
        await d.expect(10, "what was typed in Scratch's terminal did not come back") { pane.screenText().contains("devhub-live") }
    }

    func sheetsPhase(_ d: SelfTestDriver) async {
        guard let sheets else { return d.check(false, "the questions layer is not the sheet layer") }
        // The palette (Cmd+Q :): a command by its words, run with Return.
        let collapsed = snapshot?.sidebar.collapsed ?? false
        await d.chord(":", in: window)
        await d.expect(5, "Cmd+Q : did not open the palette (\(sheets.topTitle ?? "nothing"))") { sheets.topTitle == "Commands" }
        await d.type("collapse the sidebar", in: window)
        await d.expect(3, "the palette does not offer the sidebar's collapse (\(pickerRowLabels.prefix(3)))") {
            self.picker?.state.activeRow?.label.lowercased().contains("collapse the sidebar") == true
        }
        await d.press(.returnKey, in: window)
        await d.expect(5, "the palette's Return did not collapse the sidebar") { self.snapshot?.sidebar.collapsed == !collapsed }
        d.check(!shell.modals.isPresenting, "the palette stayed up after its command ran")
        await d.chord("b", in: window)
        await d.expect(5, "Cmd+Q B did not bring the sidebar back") { self.snapshot?.sidebar.collapsed == collapsed }

        // The keyboard shortcuts (Cmd+Q ?), put away with Escape.
        await d.chord("?", in: window)
        await d.expect(5, "Cmd+Q ? did not open the keyboard shortcuts") { sheets.isPresenting && self.picker == nil }
        await d.press(.escape, in: window)
        await d.expect(3, "Escape did not close the keyboard shortcuts") { !sheets.isPresenting }

        // Open Workspace (Cmd+Q F): cancelled, then a folder found by its name.
        await d.chord("f", in: window)
        await d.expect(5, "Cmd+Q F did not open the workspace picker") { self.picker != nil }
        await d.press(.escape, in: window)
        await d.expect(3, "Escape did not cancel the workspace picker") { !sheets.isPresenting }
        let count = snapshot?.workspaces.count ?? 0
        d.check(count == 1, "cancelling the picker opened something (\(snapshot?.workspaces.map(\.root) ?? []))")
        for folder in [world.beta, world.alpha] {
            let name = (folder as NSString).lastPathComponent
            await d.chord("f", in: window)
            await d.expect(5, "Cmd+Q F did not open the workspace picker for \(name)") { self.picker != nil }
            await d.type(name, in: window)
            let found = await d.until(10) {
                self.picker?.state.activeRow.map { $0.id.hasSuffix("/\(name)") } == true
            }
            d.check(found, "the workspace picker did not find \(name) (rows \(pickerRowIds.prefix(4)))")
            await d.press(.returnKey, in: window)
            await d.expect(15, "Return in the workspace picker did not open \(name)") { self.workspace(root: folder) != nil }
            await d.expect(5, "\(name) is not the selection after it opened") {
                guard let opened = self.workspace(root: folder), let snapshot = self.snapshot else { return false }
                return snapshot.selection.context == .workspace(opened.id)
            }
            d.check(!sheets.isPresenting, "the workspace picker stayed up after \(name) opened")
        }

        // Go to (Cmd+Q G): back to beta by its name, then to alpha.
        guard let beta = workspace(root: world.beta), let alpha = workspace(root: world.alpha) else { return }
        for (target, words) in [(beta, "beta"), (alpha, "alpha")] {
            await d.chord("g", in: window)
            await d.expect(5, "Cmd+Q G did not open Go to") { self.picker != nil }
            await d.type(words, in: window)
            await d.press(.returnKey, in: window)
            await d.expect(5, "Go to did not select \(words)") { self.snapshot?.selection.context == .workspace(target.id) }
        }

        // New Agent (Cmd+Q C) in alpha: the profiles and alpha's earlier
        // Claude session; Return starts the first, the stand-in Claude, as a GUI Agent.
        await d.chord("c", in: window)
        await d.expect(5, "Cmd+Q C did not open New Agent") { self.picker != nil }
        await d.expect(10, "New Agent does not list the profiles and the earlier session (\(pickerRowLabels))") {
            let labels = self.pickerRowLabels
            return labels.contains("New Fake Claude Session") && labels.contains("New Fake Codex Session")
                && labels.contains { $0.contains("The earlier widget session") }
        }
        d.check(picker?.state.activeRow?.id == "new:\(SelfTestWorld.claudeProfile)", "New Agent's first row is \(picker?.state.activeRow?.id ?? "nothing")")
        await d.press(.returnKey, in: window)
        await d.expect(20, "Return in New Agent started no Agent in alpha") { self.workspace(root: self.world.alpha)?.agents.isEmpty == false }
        d.check(!sheets.isPresenting, "New Agent stayed up")
        if let made = workspace(root: world.alpha)?.agents.first {
            d.check(made.profileId == SelfTestWorld.claudeProfile && made.presentation == .gui, "New Agent started \(made.profileId) as \(made.presentation)")
            await d.expect(10, "the new Agent is not the selection") { self.snapshot?.selection.context == .agent(made.id) }
        }
    }
}
