// The self-test's transport, and the fixtures the window is drawn from:
// a surface session attaches over it, draws its banner, types and resizes —
// the frame contract the App's terminal views rely on.

import XCTest
@testable import DevHubCore

final class LoopbackTransportTests: XCTestCase {
    private final class Drawn: @unchecked Sendable {
        let lock = NSLock()
        var bytes = Data()
        var states: [TerminalConnection] = []
    }

    private func waitFor(_ seconds: Double = 3, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return condition()
    }

    func testASessionAttachesDrawsTypesAndResizesOverIt() async {
        let transport = LoopbackTransport()
        let drawn = Drawn()
        let queue = DispatchQueue(label: "surface")
        let session = TerminalSurfaceSession(
            surfaceKey: "workspace-terminal:w", viewLabel: "editor", transport: transport, clock: DispatchSurfaceClock(queue: queue),
            deliver: { work in queue.async(execute: work) })
        session.onOutput = { bytes in drawn.lock.withLock { drawn.bytes.append(bytes) } }
        session.onConnection = { state in drawn.lock.withLock { drawn.states.append(state) } }
        queue.sync { session.attach(size: TerminalSize(cols: 80, rows: 24)) }
        let connected = await waitFor { queue.sync { session.connection == .connected } }
        XCTAssertTrue(connected)
        let banner = await waitFor { drawn.lock.withLock { String(decoding: drawn.bytes, as: UTF8.self).contains("DevHub loopback") } }
        XCTAssertTrue(banner)
        guard let attachment = transport.live("workspace-terminal:w") else { return XCTFail("not attached") }
        XCTAssertEqual(attachment.viewLabel, "editor")
        let acked = await waitFor { transport.acknowledgedUpTo(attachment.attachmentId) >= 1 }
        XCTAssertTrue(acked)
        queue.sync { session.input(Data("ls\r".utf8)) }
        let echoed = await waitFor { drawn.lock.withLock { String(decoding: drawn.bytes, as: UTF8.self).contains("ls\r") } }
        XCTAssertTrue(echoed)
        XCTAssertEqual(transport.typed(attachment.attachmentId), Data("ls\r".utf8))
        queue.sync { session.resize(TerminalSize(cols: 100, rows: 30)) }
        XCTAssertEqual(transport.resizes.last?.size, TerminalSize(cols: 100, rows: 30))
        queue.sync { session.dispose() }
        XCTAssertEqual(transport.detached, [attachment.attachmentId])
        XCTAssertNil(transport.live("workspace-terminal:w"))
    }

    func testTheSelfTestsWindowIsScratchAWorkspaceAndItsAgent() throws {
        let snapshot = WindowFixtures.selfTest(root: "/tmp/t", presentation: .beside, terminal: true)
        let model = try Sidebar.model(snapshot, repositories: RepositoryStatusWire(), profiles: SidebarProfiles.of(nil), armed: false)
        XCTAssertEqual(Sidebar.treeItems(model).map(\.id), [
            "workspace:\(WindowFixtures.scratchId)", "workspace:\(WindowFixtures.workspaceId)", "agent:\(WindowFixtures.agentId)",
        ])
        var shown = EditorTerminalsShown()
        let arrangement = ShellLayout.arrangement(
            snapshot, chrome: ShellChrome(), keyboardInSidebar: false, preview: LayoutPreview(), shown: &shown)
        XCTAssertEqual(arrangement.state.surface, .split(editorKey: "/tmp/t/widget", ratio: 0.55))
        XCTAssertEqual(arrangement.state.terminal?.terminalId, WindowFixtures.terminalId)
        XCTAssertEqual(arrangement.terminals, [WindowFixtures.terminalId])
        XCTAssertEqual(arrangement.editorTerminals.map(\.workspaceId), [WindowFixtures.workspaceId])
        XCTAssertEqual(try Chords.resolve(.toggleTerminal, snapshot), .toggleTerminal(agentId: WindowFixtures.agentId))
        XCTAssertEqual(WindowFixtures.emptySnapshot().readiness, .starting)
        let editor = WindowFixtures.selfTestWorkspace(root: "/tmp/t")
        XCTAssertEqual(editor.selection.context, .workspace(WindowFixtures.workspaceId))
    }
}
