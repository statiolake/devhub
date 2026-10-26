// usageLimits.test.ts's capture case, Codex half (apps/desktop/src/main/shell/
// usageLimits.test.ts, "takes each CLI's limit from what its GUI Agents
// report"): the scrubbed real capture goes through the Codex adapter, and the
// events it emits feed the readout beside the Claude capture's.

import XCTest
@testable import DevHubCore

final class UsageLimitsCodexCaptureTests: XCTestCase {
    func events(_ adapter: ProtocolAdapter, _ area: String, _ name: String) throws -> [ConversationEvent] {
        var events: [ConversationEvent] = []
        for text in Fixtures.text(area, name).components(separatedBy: "\n") {
            if text.hasPrefix("> ") { events += try adapter.sent(String(text.dropFirst(2))).events }
            if text.hasPrefix("< ") { events += try adapter.received(String(text.dropFirst(2))).events }
        }
        return events
    }

    func testTakesEachCLIsLimitFromWhatItsGUIAgentsReport() throws {
        let limits = UsageLimits()
        var published: [UsageLimitsWire] = []
        func feed(_ kind: AgentProfileKind, _ events: [ConversationEvent]) throws {
            for event in events {
                guard case .usage(let usage) = event else { continue }
                try UsageLimitsFeed.agentReported(limits, kind: kind, rateLimits: usage.rateLimits) { published.append($0) }
            }
        }
        try feed(.claude, try events(ClaudeAdapter(bootId: "replay"), "conversation", "claude-session.capture.ndjson"))
        try feed(
            .codex,
            try events(
                CodexAdapter(CodexAdapterOptions(clientVersion: "0.1.0", cwd: "/home/testuser/project", resumeThreadId: nil)),
                "codex", "codex-greeting.capture.ndjson"))
        let wire = limits.wire()
        let claude = wire.clis.first { $0.cli == .claude }
        let codex = wire.clis.first { $0.cli == .codex }
        // The capture's last `rate_limit_event`: 98% of the five-hour window
        // and 80% of the seven-day one, resets in epoch seconds on the wire.
        XCTAssertEqual(claude?.windows, [
            .init(window: "5-hour", durationMinutes: 300, usedPercent: 98, resetsAt: 1_790_280_600_000),
            .init(window: "7-day", durationMinutes: 10_080, usedPercent: 80, resetsAt: 1_790_517_600_000),
        ])
        XCTAssertEqual(codex?.windows, [
            .init(window: "5-hour", durationMinutes: 300, usedPercent: 0, resetsAt: 1_790_313_079_000),
            .init(window: "7-day", durationMinutes: 10_080, usedPercent: 17, resetsAt: 1_790_593_906_000),
        ])
        // Published when it changed, and only then.
        XCTAssertEqual(published.last, wire)
    }
}
