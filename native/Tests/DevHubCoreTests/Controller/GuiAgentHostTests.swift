// A GUI Agent end to end on this machine: the wiring's launch hands its
// session command to a stand-in for tmux that runs it as a process group
// (as `HostLinkTests` runs the host), so what runs is the real host script
// with the fake agent (Fixtures/conversation/fake-agent.sh) playing a Claude
// under it; the wiring's conversation follows the real journal through the
// real `HostLink`, the round reads it, `devhub --tell`'s view answers in it,
// and the ending is read from the host's own files once the session is gone.

import Foundation
import XCTest
@testable import DevHubCore

/// Sessions as processes: what tmux would run for the session, with the
/// session's own variables.
final class ProcessSessions: GuiAgentSessions, @unchecked Sendable {
    let hosts = Recorder<TestHost>()
    func launchGuiSession(_ spec: AgentLaunchSpec) async throws {
        let env = spec.command.env.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
        hosts.add(try TestHost(["/usr/bin/env"] + env + [spec.command.file] + spec.command.args))
    }
}

final class GuiAgentHostTests: HostTestCase {
    private var debug: [String] = []

    private func until(_ what: String, _ condition: () async -> Bool) async throws {
        for _ in 0..<400 {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        XCTFail("never: \(what)")
        for directory in debug {
            for name in ["out", "err", "in.log", "exit"] {
                print("== \(name)\n" + ((try? String(contentsOfFile: directory + "/" + name, encoding: .utf8)) ?? "-"))
            }
        }
        throw CancellationError()
    }

    func testLaunchesAGuiClaudeFollowsItsJournalAnswersInItAndSaysHowItEnded() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("devhub-gui-host-\(UUID().uuidString)").path
        scratch.append(home)
        try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
        let profile = TerminalAgentProfile(
            kind: .claude, command: "/bin/sh", args: [FAKE_AGENT],
            env: ["FAKE_AGENT_SCRIPT": Fixtures.url("agent-conversation", "claude-rewind.first.ndjson").path])
        let model = WiringModel([TerminalAgentWorkspace(id: GUI_WORKSPACE, root: home, agents: [
            TerminalAgentRecord(id: GUI_AGENT, displayName: "Claude", profile: profile, presentation: .gui),
        ])])
        let sessions = ProcessSessions()
        let reports = Recorder<String>()
        let wiring = GuiAgentWiring(GuiAgentWiringOptions(
            sessions: sessions, model: model, machineRuntime: { _ in LocalRuntime(home: { home }) },
            report: { reports.add($0) }, clientVersion: "0.0.0-test", profileTag: "0123456789ab",
            resumeAfterLimit: { RESUME_OFF }, limitResumes: MemoryRecords(), log: { _ in }))
        let agentProfile = try AgentProfile.create(
            id: "claude", displayName: "Claude", kind: .claude, command: profile.command, args: profile.args,
            env: profile.env.map { ($0.key, $0.value) }, presentation: .gui)

        let launched = await wiring.launch(
            workspaceId: WorkspaceId(unchecked: GUI_WORKSPACE), agentId: AgentId(unchecked: GUI_AGENT), profile: agentProfile, root: home)
        XCTAssertEqual(launched, .started)
        let host = try XCTUnwrap(sessions.hosts.all.first)
        hosts.append(host)
        let agent = model.workspaces()[0].agents[0]

        // The round is the clock: it makes the conversation, and reads it.
        try await until("the CLI is idle") {
            await wiring.reading(machine: .local, agent: agent, root: home).status == .idle
        }
        let found = try await wiring.conversation(AgentId(unchecked: GUI_AGENT))
        let tell = try XCTUnwrap(found)
        try await tell.submit("Say one")
        debug = ["\(home)/.devhub/agents-0123456789ab/\(GUI_AGENT)"]
        defer { debug = [] }
        try await until("the CLI answered") {
            await tell.entries().contains { if case .assistant(_, ["One."]) = $0 { return true }; return false }
        }
        try await until("the turn ended") { await tell.turn() == "none" }
        let session = try await wiring.session(GUI_AGENT)
        XCTAssertEqual(session, "00000000-0000-4000-8000-0000000000e5")

        // Killed from outside, as a `tmux kill-session` would: the ending is
        // news, said once the row has gone, and the host's files go with it.
        host.hangUp()
        try await until("the host is gone") { host.hasExited }
        await wiring.ended(machine: .local, agent: agent)
        XCTAssertEqual(reports.all.count, 1)
        XCTAssertTrue(reports.all.first?.hasPrefix("The ") == true, "\(reports.all)")
        let directory = "\(home)/.devhub/agents-0123456789ab/\(GUI_AGENT)"
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory))
    }
}
