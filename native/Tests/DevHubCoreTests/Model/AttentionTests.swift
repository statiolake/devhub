// Ports of apps/desktop/src/main/shell/windowAttention.test.ts and
// agentNotifications.test.ts: the rule halves (what asks for attention, and
// when an Agent's turn is news), with a fake Dock and a fake clock.

import XCTest
@testable import DevHubCore

private func attentionAgent(_ id: String, status: AgentStatus = .idle, unread: AgentStatus? = nil, name: String? = nil, activity: String? = nil) -> AgentWire {
    AgentWire(
        controlState: .running, failure: nil, displayName: name ?? id, id: id, ordinal: 0, profileId: "claude", profileKind: .claude,
        presentation: .tui, runtimeHealth: .healthy, status: status, unread: unread, activity: activity, promptCache: nil,
        injection: .none, automaticActions: [], workspaceId: "w", terminal: nil, terminalShare: nil, terminalStackedShare: nil)
}

private func attentionSnapshot(agents: [AgentWire], selectedAgentId: String? = nil, label: String = "repo") -> AppSnapshotWire {
    let workspace = WorkspaceWire(
        agents: agents, canCreateAgent: true, id: "w", label: label, location: .local, editor: .host, root: "/w", displayRoot: "/w",
        key: "/w", groupKey: "/w", selectedPath: "/w", state: .available, close: .idle, lastAgentId: nil, terminals: nil)
    let scratch = WorkspaceWire(
        agents: [], canCreateAgent: true, id: "scratch", label: "Scratch", location: .local, editor: .host, root: "/s",
        displayRoot: "/s", key: "/s", groupKey: "/s", selectedPath: "/s", state: .available, close: .idle, lastAgentId: nil,
        terminals: nil)
    return AppSnapshotWire(
        editorHost: .ready, layout: .unavailable, readiness: .ready, revision: 1,
        selection: SelectionWire(context: selectedAgentId.map(ContextWire.agent) ?? .workspace("scratch"), presentation: .full),
        scratchWorkspaceId: "scratch", sidebar: SidebarSnapshot(width: 248, collapsed: false), splitRatio: 0.55,
        visibleTerminal: nil, paneFocus: nil, smartButtons: SmartButtonsPlacement(), terminalZoomOffset: 0,
        workspaces: [scratch, workspace], history: nil)
}

private func unreadSnapshot(unread: String? = nil, selected: String? = nil) -> AppSnapshotWire {
    attentionSnapshot(
        agents: [attentionAgent("a", unread: unread == "a" ? .idle : nil), attentionAgent("b", unread: unread == "b" ? .idle : nil)],
        selectedAgentId: selected)
}

private final class FakeDock: AttentionDock {
    var calls: [String] = []
    var next = 1
    func setBadge(_ text: String) { calls.append("badge:\(text.isEmpty ? "-" : text)") }
    func bounceCritical() -> Int {
        calls.append("bounce:critical")
        defer { next += 1 }
        return next
    }
    func cancelBounce(_ id: Int) { calls.append("cancel:\(id)") }
}

final class WindowAttentionTests: XCTestCase {
    func testIsAnUnreadAgentThatIsNotTheOneBeingLookedAt() {
        XCTAssertTrue(WindowAttentionRule.wantsAttention(unreadSnapshot(unread: "a")))
    }

    func testIsNotTheUnreadAgentTheSelectionIsAlreadyOn() {
        XCTAssertFalse(WindowAttentionRule.wantsAttention(unreadSnapshot(unread: "a", selected: "a")))
    }

    func testIsNothingAtAllWhenNothingIsUnread() {
        XCTAssertFalse(WindowAttentionRule.wantsAttention(unreadSnapshot()))
    }

    func testBadgesTheDockWhileSomethingIsWaitingAndOnlyWhile() {
        let dock = FakeDock()
        let attention = WindowAttention(dock: dock)
        attention.windowFocusChanged(true)
        attention.observe(unreadSnapshot(unread: "a"))
        XCTAssertEqual(dock.calls, ["badge:●"])
        attention.observe(unreadSnapshot())
        XCTAssertEqual(dock.calls, ["badge:●", "badge:-"])
    }

    func testSaysItOnceHoweverManyTimesItIsToldTheSameThing() {
        let dock = FakeDock()
        let attention = WindowAttention(dock: dock)
        attention.observe(unreadSnapshot(unread: "a"))
        attention.observe(unreadSnapshot(unread: "a"))
        attention.observe(unreadSnapshot(unread: "b"))
        XCTAssertEqual(dock.calls.filter { $0.hasPrefix("badge:") }, ["badge:●"])
    }

    func testDoesNotBounceAtAWindowThatAlreadyHasTheFocus() {
        let dock = FakeDock()
        let attention = WindowAttention(dock: dock)
        attention.windowFocusChanged(true)
        attention.observe(unreadSnapshot(unread: "a"))
        XCTAssertEqual(dock.calls, ["badge:●"])
    }

    func testBouncesOnceTheWindowGoesAwayAndStopsWhenItComesBack() {
        let dock = FakeDock()
        let attention = WindowAttention(dock: dock)
        attention.windowFocusChanged(true)
        attention.observe(unreadSnapshot(unread: "a"))
        attention.windowFocusChanged(false)
        XCTAssertEqual(dock.calls, ["badge:●", "bounce:critical"])
        attention.windowFocusChanged(true)
        XCTAssertEqual(dock.calls, ["badge:●", "bounce:critical", "cancel:1"])
    }

    func testStopsBouncingWhenTheReasonGoesNotOnlyWhenTheWindowReturns() {
        let dock = FakeDock()
        let attention = WindowAttention(dock: dock)
        attention.windowFocusChanged(false)
        attention.observe(unreadSnapshot(unread: "a"))
        attention.observe(unreadSnapshot())
        XCTAssertEqual(dock.calls, ["badge:●", "bounce:critical", "badge:-", "cancel:1"])
    }
}

/// A host with a clock that only moves when the test moves it.
private final class FakeNotifierHost: NotifierHost {
    var status: AgentStatus = .idle
    var selected: String?
    var focused = false
    var enabled = true
    var present = true
    var sent: [AgentNotification] = []
    private var now: Double = 0
    private var timers: [(handle: Int, due: Double, fire: () -> Void)] = []
    private var nextHandle = 1

    func notifierSettings() -> NotifierSettings { NotifierSettings(enabled: enabled, sound: true) }
    func windowFocused() -> Bool { focused }
    func snapshot() -> AppSnapshotWire {
        attentionSnapshot(
            agents: present ? [attentionAgent("a1", status: status, name: "Claude", activity: " did\n it ")] : [],
            selectedAgentId: selected)
    }
    func notify(_ notification: AgentNotification) { sent.append(notification) }
    func setTimer(_ ms: Double, _ fire: @escaping () -> Void) -> Int {
        defer { nextHandle += 1 }
        timers.append((nextHandle, now + ms, fire))
        return nextHandle
    }
    func clearTimer(_ handle: Int) { timers.removeAll { $0.handle == handle } }

    func advance(_ ms: Double) {
        now += ms
        while let index = timers.firstIndex(where: { $0.due <= now }) {
            let timer = timers.remove(at: index)
            timer.fire()
        }
    }
}

final class AgentNotificationsTests: XCTestCase {
    private func go(_ notifier: AgentNotifier, _ host: FakeNotifierHost, _ next: AgentStatus, _ ms: Double = AgentNotifier.debounceMs + 1) {
        host.status = next
        notifier.observe(host.snapshot())
        host.advance(ms)
    }

    func testDoesNotFireForTheInitialState() {
        let host = FakeNotifierHost()
        let notifier = AgentNotifier(host: host)
        go(notifier, host, .idle)
        go(notifier, host, .waiting)
        XCTAssertEqual(host.sent.count, 0)
    }

    func testFiresOnceForWorkingToIdleWithASnippet() {
        let host = FakeNotifierHost()
        let notifier = AgentNotifier(host: host)
        go(notifier, host, .working)
        go(notifier, host, .idle)
        go(notifier, host, .idle)
        XCTAssertEqual(host.sent.count, 1)
        XCTAssertEqual(host.sent.first?.kind, .finished)
        XCTAssertEqual(host.sent.first?.title, "Claude — repo")
        XCTAssertEqual(host.sent.first?.body, "Finished: did it")
    }

    func testLabelsWaitingDifferently() {
        let host = FakeNotifierHost()
        let notifier = AgentNotifier(host: host)
        go(notifier, host, .working)
        go(notifier, host, .waiting)
        XCTAssertEqual(host.sent.first?.body.hasPrefix("Waiting for permission"), true)
    }

    func testDebouncesAFlapBackToWorking() {
        let host = FakeNotifierHost()
        let notifier = AgentNotifier(host: host)
        go(notifier, host, .working)
        go(notifier, host, .idle, 500)
        go(notifier, host, .working)
        host.advance(5000)
        XCTAssertEqual(host.sent.count, 0)
    }

    func testIsQuietWhenFocusedOnThatAgentLoudWhenFocusedElsewhere() {
        let host = FakeNotifierHost()
        let notifier = AgentNotifier(host: host)
        host.focused = true
        host.selected = "a1"
        go(notifier, host, .working)
        go(notifier, host, .idle)
        XCTAssertEqual(host.sent.count, 0)
        host.selected = nil
        go(notifier, host, .working)
        go(notifier, host, .idle)
        XCTAssertEqual(host.sent.count, 1)
    }

    func testRespectsTheSettingAndRemovedAgents() {
        let host = FakeNotifierHost()
        let notifier = AgentNotifier(host: host)
        host.enabled = false
        go(notifier, host, .working)
        go(notifier, host, .idle)
        XCTAssertEqual(host.sent.count, 0)
        host.enabled = true
        go(notifier, host, .working)
        host.status = .idle
        notifier.observe(host.snapshot())
        host.present = false
        notifier.observe(host.snapshot())
        host.advance(5000)
        XCTAssertEqual(host.sent.count, 0)
    }

    func testSnippetCollapsesAndTruncates() {
        XCTAssertEqual(AgentNotifier.snippet("a\n b"), "a b")
        XCTAssertEqual(AgentNotifier.snippet(String(repeating: "x", count: 200)).count, 100)
        XCTAssertEqual(AgentNotifier.snippet(nil), "")
    }
}
