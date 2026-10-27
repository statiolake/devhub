// The live phase's last: terminal mode's `exit` (`EditorTerminalExits`)
// typed into the editor area's terminal, and what DevHub ending a client
// itself does not set off.

import AppKit
import DevHubCore

extension LiveSelfTest {
    /// Go to `words` (Cmd+Q G), and wait for `id` to be the selection.
    func goTo(_ d: SelfTestDriver, _ words: String, _ id: String) async {
        await d.chord("g", in: window)
        await d.expect(5, "Cmd+Q G did not open Go to") { self.picker != nil }
        await d.type(words, in: window)
        await d.press(.returnKey, in: window)
        await d.expect(5, "Go to did not select \(words)") { self.snapshot?.selection.context == .workspace(id) }
    }

    /// `workspaceId`'s editor terminal, shown and attached, the keys in it.
    func editorTerminal(_ d: SelfTestDriver, _ workspaceId: String, _ what: String) async -> TerminalPaneView? {
        let ready = await d.until(20) { self.editorPane(workspaceId).map { $0.isAttached && !$0.isHidden } == true }
        d.check(ready, "\(what)'s editor terminal is not shown and attached (\(editorPane(workspaceId).map { "\($0.connection)" } ?? "no view"))")
        guard ready, let pane = editorPane(workspaceId) else { return nil }
        await d.click(pane.terminal)
        await d.expect(3, "a click did not put the keys in \(what)'s terminal") { self.window?.firstResponder === pane.terminal }
        return pane
    }

    /// When tmux made `session` (nil: there is none).
    func created(_ session: String) -> String? {
        let line = tmuxSays(["display-message", "-p", "-t", "=\(session):", "#{session_created}"]).trimmingCharacters(in: .whitespacesAndNewlines)
        return line.isEmpty ? nil : line
    }

    func exits(_ d: SelfTestDriver) async {
        guard let snapshot, let beta = workspace(root: world.beta), let alpha = workspace(root: world.alpha) else {
            return d.check(false, "beta and alpha are not both open")
        }
        let scratchId = snapshot.scratchWorkspaceId
        let alphaSession = TmuxNames.workspaceSession(root: alpha.root)

        // beta has nothing to lose: `exit` closes it, without a question.
        await goTo(d, "beta", beta.id)
        if let pane = await editorTerminal(d, beta.id, "beta") {
            await d.type("exit\r", in: window)
            await d.expect(15, "exit in beta's terminal did not close beta (it ended by itself: \(endedByItself.contains(beta.id)); \(pane.connection))") {
                self.workspace(root: self.world.beta) == nil
            }
            d.check(endedByItself.contains(beta.id), "beta's terminal ending was not seen as an exit")
            d.check(!shell.modals.isPresenting, "closing beta asked \(sheets?.topTitle ?? "something")")
        }

        // alpha's Agent is something to lose: `exit` asks, and kept, a fresh ws- session.
        await goTo(d, "alpha", alpha.id)
        if let pane = await editorTerminal(d, alpha.id, "alpha") {
            let born = created(alphaSession)
            d.check(born != nil, "alpha has no session \(alphaSession) (\(sessions()))")
            await d.pause(1.1) // `session_created` is in seconds.
            await d.type("exit\r", in: window)
            await d.expect(15, "exit in alpha's terminal asked nothing (ended by itself: \(endedByItself.contains(alpha.id)))") {
                self.picker.map { $0.state.rows.contains { $0.id == SheetRows.confirmRow } } == true
            }
            d.check(picker?.state.activeRow?.id == PickerState.cancelRowId, "the question's first row is \(picker?.state.activeRow?.id ?? "nothing"), not Keep")
            d.check(workspace(root: world.alpha) != nil, "alpha closed before its question was answered")
            await d.press(.returnKey, in: window) // Keep.
            await d.expect(5, "Keep did not close the question") { !self.shell.modals.isPresenting }
            await d.expect(20, "kept, alpha's terminal did not start over on a fresh session (\(pane.connection); \(sessions()))") {
                pane.isAttached && self.created(alphaSession).map { $0 != born } == true
            }
            d.check(workspace(root: world.alpha) != nil, "alpha closed though it was kept")
            await d.click(pane.terminal)
            await d.type("echo kept-alive\r", in: window)
            await d.expect(10, "the fresh session does not answer") { pane.screenText().contains("kept-alive") }

            // A tmux detach is not an exit: the session runs on, and the view attaches again.
            let ended = endedByItself.count
            tmuxSays(["detach-client", "-s", alphaSession])
            await d.expect(10, "the detach was not seen") { self.endedByItself.count > ended }
            await d.expect(20, "after a detach alpha's terminal did not attach again (\(pane.connection))") {
                pane.isAttached && self.tmuxSays(["list-clients", "-F", "#{session_name}"]).contains(alphaSession)
            }
            d.check(created(alphaSession) != nil && workspace(root: world.alpha) != nil && !shell.modals.isPresenting, "a detach closed alpha or asked about it")
        }

        // Scratch never closes: `exit` starts it over.
        await d.chord("0", in: window)
        await d.expect(5, "Cmd+Q 0 did not select Scratch") { self.snapshot?.selection.context == .workspace(scratchId) }
        if let pane = await editorTerminal(d, scratchId, "Scratch") {
            let ended = endedByItself.count
            await d.type("exit\r", in: window)
            await d.expect(10, "Scratch's exit was not seen") { self.endedByItself.count > ended }
            await d.pause(0.5)
            await d.expect(20, "Scratch's terminal did not start over (\(pane.connection))") { pane.isAttached }
            d.check(!shell.modals.isPresenting, "Scratch's exit asked \(sheets?.topTitle ?? "something")")
            await d.click(pane.terminal)
            await d.type("echo scratch-again\r", in: window)
            await d.expect(10, "Scratch's fresh session does not answer") { pane.screenText().contains("scratch-again") }
        }

        // DevHub's own close lets go of the client first: not an exit.
        await goTo(d, "alpha", alpha.id)
        let beforeClose = endedByItself.count
        await d.chord("W", in: window)
        await d.expect(10, "Cmd+Q W on alpha asked nothing") { self.picker != nil }
        d.check(await pointAt(d, SheetRows.confirmRow), "the close question could not be moved to its confirm row")
        await d.press(.returnKey, in: window)
        await d.expect(20, "confirmed, alpha did not close") { self.workspace(root: self.world.alpha) == nil }
        await d.pause(1)
        d.check(endedByItself.count == beforeClose, "DevHub's own close was taken for an exit (\(endedByItself.suffix(3)))")
        d.check(!sessions().contains(alphaSession), "alpha's session outlived its close (\(sessions()))")
        d.check(!shell.modals.isPresenting, "closing alpha left a question up")

        // And the quit: every client let go, every session left running.
        let beforeQuit = endedByItself.count
        let running = sessions()
        live.letGo()
        await runtime.shutdown()
        await d.pause(1.5)
        d.check(endedByItself.count == beforeQuit, "the quit was taken for an exit (\(endedByItself.suffix(3)))")
        let after = sessions()
        d.check(running.allSatisfy { after.contains($0) }, "the quit ended sessions: \(running) → \(after)")
        window?.orderOut(nil)
    }
}
