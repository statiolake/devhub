// Port of apps/desktop/src/model/domain.test.ts

import XCTest
@testable import DevHubCore

private let UUID_A = "550e8400-e29b-41d4-a716-446655440000"
private let UUID_B = "550e8400-e29b-41d4-a716-446655440001"
private let UUID_C = "550e8400-e29b-41d4-a716-446655440002"

final class DomainTests: XCTestCase {
    // MARK: identities

    func testAcceptsOnlyCanonicalLowercaseUuids() throws {
        XCTAssertEqual(try WorkspaceId(UUID_A).rawValue, UUID_A)
        XCTAssertEqual(codeOf { _ = try WorkspaceId("workspace-a") }, .invalidId)
        XCTAssertEqual(codeOf { _ = try WorkspaceId(UUID_A.uppercased()) }, .invalidId)
        XCTAssertEqual(codeOf { _ = try WorkspaceId(UUID_A.replacingOccurrences(of: "-", with: "")) }, .invalidId)
    }

    func testAcceptsOnlyLowercaseSlugsForProfileIdentities() throws {
        XCTAssertEqual(try DomainIds.agentProfileId("codex"), "codex")
        XCTAssertEqual(codeOf { _ = try DomainIds.agentProfileId("Codex") }, .invalidId)
    }

    func testSessionIdRefusesWhatCouldReadAsAnOption() throws {
        XCTAssertEqual(try DomainIds.sessionId("abc-1.2_3"), "abc-1.2_3")
        XCTAssertEqual(codeOf { _ = try DomainIds.sessionId("-rf") }, .invalidId)
        XCTAssertEqual(codeOf { _ = try DomainIds.sessionId("") }, .invalidId)
        XCTAssertEqual(codeOf { _ = try DomainIds.sessionId("a\u{0}b") }, .invalidId)
    }

    // MARK: paths

    func testNormalisesLexicallyAndRejectsEscapesAboveTheRoot() throws {
        XCTAssertEqual(try DomainPaths.workspaceRoot("/dev/./worktree/../repo"), try DomainPaths.workspaceRoot("/dev/repo"))
        XCTAssertEqual(try DomainPaths.displayPath("/dev/./repo"), "/dev/repo")
        XCTAssertEqual(codeOf { _ = try DomainPaths.workspaceRoot("relative/repo") }, .invalidPath)
        XCTAssertEqual(codeOf { _ = try DomainPaths.workspaceRoot("/../repo") }, .invalidPath)
        XCTAssertEqual(codeOf { _ = try DomainPaths.workspaceRoot("/..") }, .invalidPath)
    }

    func testNamesTheRootByItsLastComponent() throws {
        XCTAssertEqual(DomainPaths.rootBasename(try DomainPaths.workspaceRoot("/dev/repo")), "repo")
        XCTAssertEqual(DomainPaths.rootBasename(try DomainPaths.workspaceRoot("/")), "/")
    }

    // MARK: remote identity

    func testNormalisesHttpsAndSshAliasesWithoutCredentials() throws {
        let https = try RemoteIdentity.parse("https://USER:secret@GitHub.com/Owner/Repo.git")
        let ssh = try RemoteIdentity.parse("git@github.com:owner/repo.git")
        let scp = try RemoteIdentity.parse("alice@github.com:OWNER/Repo.git")
        XCTAssertEqual(https.rawValue, "github.com/owner/repo")
        XCTAssertEqual(ssh, https)
        XCTAssertEqual(scp, ssh)
    }

    func testCollapsesDuplicateAliasesAndMatchesAnyOfThem() throws {
        let https = try RemoteIdentity.parse("https://github.com/owner/repo")
        let repository = Repository(id: RepositoryId(unchecked: UUID_A), primaryRemote: https, aliases: [
            try RemoteIdentity.parse("ssh://git@github.com/owner/repo"),
        ])
        XCTAssertEqual(repository.aliases.count, 1)
        XCTAssertTrue(repository.matchesRemote(try RemoteIdentity.parse("git@github.com:owner/repo")))
    }

    // MARK: agent naming

    func testDerivesANameFromTheProfileAndOrdinalAndTakesAnOverride() throws {
        var agent = try Agent.create(id: aid(UUID_A), owner: wid(UUID_B), profile: profile(args: ["--full-auto"]), ordinal: 2, presentation: .tui)
        XCTAssertEqual(agent.displayName, "Codex 2")
        try agent.rename("Investigator")
        XCTAssertEqual(agent.displayName, "Investigator")
        agent.resetName()
        XCTAssertEqual(agent.displayName, "Codex 2")
    }

    func testRefusesABlankRename() throws {
        var agent = try Agent.create(id: aid(UUID_A), owner: wid(UUID_B), profile: profile(), ordinal: 1, presentation: .tui)
        XCTAssertEqual(codeOf { try agent.rename("   ") }, .invalidDisplayName)
    }

    // MARK: how an Agent is shown

    private func kindProfile(_ kind: AgentProfileKind, _ presentation: AgentPresentation = .tui) throws -> AgentProfile {
        try AgentProfile.create(id: kind.rawValue, displayName: kind.rawValue, kind: kind, command: kind.rawValue, presentation: presentation)
    }

    func testHasAGuiOnlyForTheKindsWithAStructuredProtocol() {
        XCTAssertEqual(AgentProfileKind.claude.presentations, [.tui, .gui])
        XCTAssertEqual(AgentProfileKind.codex.presentations, [.tui, .gui])
        XCTAssertEqual(AgentProfileKind.cursor.presentations, [.tui])
        XCTAssertEqual(AgentProfileKind.custom.presentations, [.tui])
    }

    func testIsATerminalWhenAProfileDoesNotSay() throws {
        XCTAssertEqual(try kindProfile(.claude).presentation, .tui)
    }

    func testRefusesACursorOrCustomProfileThatDefaultsToGui() {
        for kind in [AgentProfileKind.cursor, .custom] {
            XCTAssertEqual(codeOf { _ = try self.kindProfile(kind, .gui) }, .invalidProfile)
        }
    }

    func testRefusesAGuiAgentOnAProfileWhoseKindHasNone() throws {
        let cursor = try kindProfile(.cursor)
        XCTAssertEqual(codeOf { _ = try Agent.create(id: aid(UUID_A), owner: wid(UUID_B), profile: cursor, ordinal: 1, presentation: .gui) }, .invalidProfile)
    }

    func testKeepsTheAgentsOwnPresentationApartFromTheProfilesDefault() throws {
        let agent = try Agent.create(id: aid(UUID_A), owner: wid(UUID_B), profile: try kindProfile(.codex, .tui), ordinal: 1, presentation: .gui)
        XCTAssertEqual(agent.presentation, .gui)
        XCTAssertEqual(agent.profile.presentation, .tui)
        let copy = agent
        XCTAssertEqual(copy.presentation, .gui)
    }

    func testTellsTwoProfilesThatDifferOnlyInTheirDefaultApart() throws {
        XCTAssertNotEqual(try kindProfile(.codex, .gui), try kindProfile(.codex, .tui))
    }

    func testReadsAPresentationNamedFromOutsideAndNothingElse() throws {
        XCTAssertEqual(try AgentPresentation.parse("gui"), .gui)
        XCTAssertEqual(codeOf { _ = try AgentPresentation.parse("sideways") }, .invalidProfile)
    }

    // MARK: workspace lifecycle

    func testCanBeClosedWhileItsFolderIsMissing() throws {
        var workspace = Workspace(id: wid(UUID_A), location: .local(path: "/dev/project"), selectedPath: "/dev/project")
        workspace.markUnavailable(.rootMissing)
        XCTAssertTrue(try workspace.beginClose())
        XCTAssertEqual(workspace.close, .running)
        XCTAssertEqual(workspace.state, .unavailable(reason: .rootMissing))
    }

    func testKeepsAgentsWhenUnavailableButRefusesNewOnes() throws {
        let owner = wid(UUID_A)
        var workspace = Workspace(id: owner, location: .local(path: "/dev/project"), selectedPath: "/dev/project")
        try workspace.addAgent(try Agent.create(id: aid(UUID_B), owner: owner, profile: profile(), ordinal: 1, presentation: .tui))
        workspace.markUnavailable(.rootMissing)
        XCTAssertEqual(workspace.agents.count, 1)
        XCTAssertFalse(workspace.canCreateAgent)
        let next = try Agent.create(id: aid(UUID_C), owner: owner, profile: profile(), ordinal: 2, presentation: .tui)
        XCTAssertEqual(codeOf { try workspace.addAgent(next) }, .workspaceUnavailable)
    }

    // MARK: editor attachment

    private let inContainer = EditorAttachment.devContainer(configPath: "/dev/project/.devcontainer/devcontainer.json")

    func testMakesAWorkspaceWhoseWorkbenchDevHubGaveUpOnAvailableAgain() {
        var moved = Workspace(id: wid(UUID_A), location: .local(path: "/dev/project"), selectedPath: "/dev/project")
        moved.attachEditor(inContainer)
        moved.markUnavailable(.editorRestartExhausted)
        XCTAssertTrue(moved.attachEditor(.host))
        XCTAssertEqual(moved.state, .available)

        var same = Workspace(id: wid(UUID_A), location: .local(path: "/dev/project"), selectedPath: "/dev/project")
        same.attachEditor(inContainer)
        same.markUnavailable(.editorRestartExhausted)
        XCTAssertTrue(same.attachEditor(inContainer))
        XCTAssertEqual(same.state, .available)
        XCTAssertFalse(same.attachEditor(inContainer))
    }

    func testLeavesAFolderThatIsGoneUnavailable() {
        var gone = Workspace(id: wid(UUID_A), location: .local(path: "/dev/project"), selectedPath: "/dev/project")
        gone.markUnavailable(.rootMissing)
        gone.attachEditor(inContainer)
        XCTAssertEqual(gone.state, .unavailable(reason: .rootMissing))
    }

    func testDevContainerLabelsAndAuthorityRoundTrip() throws {
        XCTAssertNil(DevContainerConfig.label(folder: "/p", configPath: "/p/.devcontainer/devcontainer.json"))
        XCTAssertNil(DevContainerConfig.label(folder: "/p", configPath: "/p/.devcontainer.json"))
        XCTAssertEqual(DevContainerConfig.label(folder: "/p", configPath: "/p/.devcontainer/py/devcontainer.json"), "py")
        XCTAssertEqual(DevContainerConfig.label(folder: "/p", configPath: "/p/tools/dc.json"), "tools/dc.json")
        XCTAssertEqual(DevContainerConfig.label(folder: "/p", configPath: "/elsewhere/dc.json"), "/elsewhere/dc.json")
        let target = ContainerTarget(location: .ssh(host: "build", path: "/srv/api"), configPath: "/srv/api/.devcontainer.json")
        XCTAssertEqual(ContainerTarget.fromHostId(target.hostId), target)
        XCTAssertNil(ContainerTarget.decodeAuthority("zz"))
        XCTAssertTrue(editorAuthority(target.location, .devContainer(configPath: target.configPath))!.hasPrefix("dev-container+7b22"))
    }

    // MARK: close inspection

    func testIsCleanWhenEveryResourceIsClean() {
        XCTAssertEqual(CloseInspection.consolidate(.clean), .clean)
    }

    func testPreservesEveryBusyCount() throws {
        let inspection = CloseInspection.consolidate(CloseInspectionInputs(
            agents: try .busyCount(2), terminalProcesses: try .busyCount(3), unsavedEditors: .of(["main.ts"])
        ))
        XCTAssertEqual(inspection, .requiresConfirmation(
            reasons: BusyReasons(agents: 2, terminalProcesses: 3, unsavedEditors: 1), unknownDiagnostics: []
        ))
    }

    func testKeepsEachDistinctUnknownDiagnosticOnceInOrder() throws {
        let inspection = CloseInspection.consolidate(CloseInspectionInputs(
            agents: try .busyCount(1), terminalProcesses: .unknownResource(.closeTerminalUnknown),
            terminalPanes: .unknownResource(.closeTerminalUnknown), terminalWindows: .unknownResource(.closeEditorUnknown),
            unsavedEditors: .of([])
        ))
        guard case let .requiresConfirmation(reasons, unknown) = inspection else { return XCTFail() }
        XCTAssertEqual(reasons.agents, 1)
        XCTAssertEqual(unknown, [.closeTerminalUnknown, .closeEditorUnknown])
    }

    func testRejectsABusyCountOfZero() {
        XCTAssertEqual(codeOf { _ = try ResourceInspection.busyCount(0) }, .invalidBusyCount)
    }

    func testRetainsWorkspaceIdentityAndEveryResourceStateInTheProjection() throws {
        let projection = CloseInspectionProjection(workspaceId: wid(UUID_A), workspaceLabel: "DevHub", inputs: CloseInspectionInputs(
            agents: try .busyCount(2), terminalProcesses: .unknownResource(.closeTerminalUnknown), unsavedEditors: .of(["main.ts"])
        ))
        XCTAssertEqual(projection.workspaceId.rawValue, UUID_A)
        XCTAssertEqual(projection.workspaceLabel, "DevHub")
        XCTAssertEqual(projection.agents, .busy(count: 2))
        XCTAssertEqual(projection.terminalPanes, .clean)
        XCTAssertEqual(projection.unsavedEditors, .unsaved(tabs: ["main.ts"]))
    }

    func testCallsAWorkbenchWithNothingModifiedClean() {
        XCTAssertEqual(UnsavedEditorsInspection.of([]), .clean)
        XCTAssertEqual(CloseInspection.consolidate(CloseInspectionInputs(unsavedEditors: .of([]))), .clean)
    }

    func testAsksAboutUnsavedEditorsItCouldNotRead() {
        let inspection = CloseInspection.consolidate(CloseInspectionInputs(
            unsavedEditors: .unknown(diagnostic: .closeEditorUnresponsive, reason: "The editor did not answer within 5 seconds.")
        ))
        XCTAssertEqual(inspection, .requiresConfirmation(reasons: BusyReasons(), unknownDiagnostics: [.closeEditorUnresponsive]))
    }

    func testUnknownResourceDropsAnEmptyReason() {
        XCTAssertEqual(ResourceInspection.unknownResource(.cleanupFailed, reason: ""), .unknown(diagnostic: .cleanupFailed, reason: nil))
    }

    // MARK: whether stopping an Agent would interrupt anything

    func testCountsOnlyAReadThatSaysTheAgentIsAtItsPrompt() {
        XCTAssertTrue(AgentStatus.idle.isIdle)
        for status in [AgentStatus.working, .background, .waiting, .error, .unknown] { XCTAssertFalse(status.isIdle) }
    }

    func testAtPromptIsIdleOrBackgroundAndNothingElse() {
        XCTAssertTrue(AgentStatus.idle.atPrompt)
        XCTAssertTrue(AgentStatus.background.atPrompt)
        for status in [AgentStatus.working, .waiting, .error, .unknown] { XCTAssertFalse(status.atPrompt) }
    }

    private func read(_ statuses: AgentStatus...) -> [(status: AgentStatus, failure: AgentFailure?)] {
        statuses.map { ($0, nil) }
    }

    func testCountsOnlyTheOnesStoppingWouldInterrupt() {
        XCTAssertEqual(ResourceInspection.agents(read(.idle, .working, .idle, .waiting)), .busy(count: 2))
    }

    func testIsCleanWhenEveryAgentIsSittingAtItsPrompt() {
        XCTAssertEqual(ResourceInspection.agents(read(.idle, .idle)), .clean)
        XCTAssertEqual(ResourceInspection.agents([]), .clean)
    }

    func testCountsAnAgentWhoseBackgroundTasksACloseWouldStop() {
        XCTAssertEqual(ResourceInspection.agents(read(.idle, .background)), .busy(count: 1))
    }

    func testCountsAnAgentNobodyHasReadAndOneThatFailed() {
        XCTAssertEqual(ResourceInspection.agents(read(.unknown)), .busy(count: 1))
        XCTAssertEqual(ResourceInspection.agents(read(.error)), .busy(count: 1))
    }

    func testDoesNotCountAGuiAgentWhoseCliStoppedItself() {
        for code in [AgentFailureCode.conversationNotSignedIn, .conversationRefused] {
            XCTAssertEqual(ResourceInspection.agents([(.error, AgentFailure(code: code))]), .clean)
            XCTAssertTrue(AgentRules.interruptsNothing(status: .error, failure: AgentFailure(code: code)))
        }
        XCTAssertFalse(AgentRules.interruptsNothing(status: .error, failure: AgentFailure(code: .conversationProtocolMismatch)))
    }

    // MARK: what Restart Session is for an Agent

    private func guiRestart(_ code: AgentFailureCode? = nil) -> AgentRestart {
        AgentRules.restart(displayName: "Claude 1", presentation: .gui, profileKind: .claude, failure: code.map { AgentFailure(code: $0) })
    }

    func testRestartIsAvailableForAGuiAgentAndMostOfAllForOneItsCliStopped() {
        XCTAssertEqual(guiRestart(), .available)
        XCTAssertEqual(guiRestart(.conversationNotSignedIn), .available)
        XCTAssertEqual(guiRestart(.conversationRefused), .available)
    }

    func testRestartIsRefusedSayingWhyWhereDevHubCouldNotFollow() {
        for (code, why) in [
            (AgentFailureCode.conversationHostLost, "cannot reach the host"),
            (.conversationProtocolMismatch, "would stop there again"),
            (.conversationFailed, "failure of its own"),
        ] {
            guard case let .refused(text) = guiRestart(code) else { return XCTFail() }
            XCTAssertTrue(text.contains(why), text)
        }
    }

    func testRestartIsAvailableForATerminalClaudeOrCodexAgent() {
        for kind in [AgentProfileKind.claude, .codex] {
            XCTAssertEqual(AgentRules.restart(displayName: "Codex 2", presentation: .tui, profileKind: kind, failure: nil), .available)
        }
    }

    func testRestartIsRefusedForATerminalAgentWhoseCliHasNoSession() {
        for kind in [AgentProfileKind.cursor, .custom] {
            guard case let .refused(why) = AgentRules.restart(displayName: "Shell 1", presentation: .tui, profileKind: kind, failure: nil) else {
                return XCTFail()
            }
            XCTAssertTrue(why.contains("no session DevHub can resume"))
        }
    }

    func testContinuationGoesTheOtherWayForARunningClaudeOrCodex() {
        XCTAssertEqual(AgentRules.continuation(presentation: .gui, profileKind: .claude, controlState: .running, failure: nil), .tui)
        XCTAssertEqual(AgentRules.continuation(presentation: .tui, profileKind: .codex, controlState: .running, failure: nil), .gui)
        XCTAssertNil(AgentRules.continuation(presentation: .tui, profileKind: .cursor, controlState: .running, failure: nil))
        XCTAssertNil(AgentRules.continuation(presentation: .tui, profileKind: .codex, controlState: .stopping, failure: nil))
        XCTAssertNil(AgentRules.continuation(
            presentation: .gui, profileKind: .claude, controlState: .running, failure: AgentFailure(code: .conversationFailed)
        ))
    }

    // MARK: where a Workspace's folder is

    func testNamesAMachineOrSaysTheFolderIsOnThisOne() throws {
        XCTAssertEqual(try WorkspaceLocation.make(.local(path: "/dev/api")), .local(path: "/dev/api"))
        XCTAssertEqual(try WorkspaceLocation.make(.ssh(host: "build.example.com", path: "/srv/./api")), .ssh(host: "build.example.com", path: "/srv/api"))
    }

    func testTakesAnAliasAUserAtHostAndAPortAndNothingThatWouldReparse() throws {
        XCTAssertEqual(try DomainHosts.sshHost("build"), "build")
        XCTAssertEqual(try DomainHosts.sshHost("  deploy@build.example.com  "), "deploy@build.example.com")
        XCTAssertEqual(try DomainHosts.sshHost("build.example.com:2222"), "build.example.com:2222")
        for bad in ["", "a b", "build/etc", "build\nx", "ssh://build"] {
            XCTAssertEqual(codeOf { _ = try DomainHosts.sshHost(bad) }, .invalidHost, bad)
        }
    }

    func testMakesALocalFoldersIdentityItsPath() {
        XCTAssertEqual(WorkspaceLocation.local(path: "/dev/api").key, "/dev/api")
    }

    func testTellsTwoMachinesIdenticalPathsApart() {
        let one = WorkspaceLocation.ssh(host: "a.example.com", path: "/srv/api")
        let two = WorkspaceLocation.ssh(host: "b.example.com", path: "/srv/api")
        XCTAssertNotEqual(one.key, two.key)
        XCTAssertEqual(one.label, "a.example.com:/srv/api")
        XCTAssertEqual(two.label, "b.example.com:/srv/api")
    }

    func testComposesTheAuthorityOpenRemoteSshAnswersFor() {
        XCTAssertEqual(WorkspaceLocation.ssh(host: "build", path: "/srv/api").remoteAuthority, "ssh-remote+build")
        XCTAssertNil(WorkspaceLocation.local(path: "/dev/api").remoteAuthority)
    }

    func testOffersAnAgentInAWorkspaceOnAnotherMachine() throws {
        let owner = wid(UUID_A)
        var workspace = Workspace(id: owner, location: .ssh(host: "build", path: "/srv/api"), selectedPath: "/srv/api")
        XCTAssertTrue(workspace.canCreateAgent)
        try workspace.addAgent(try Agent.create(id: aid(UUID_B), owner: owner, profile: profile(), ordinal: 1, presentation: .tui))
        XCTAssertEqual(workspace.agents.count, 1)
    }

    // MARK: writing a path the way its owner writes it

    func testAbbreviatesTheHomeDirectoryAndWhatIsUnderIt() {
        XCTAssertEqual(DomainPaths.abbreviateHome("/Users/example/projects/x", home: "/Users/example"), "~/projects/x")
        XCTAssertEqual(DomainPaths.abbreviateHome("/Users/example", home: "/Users/example"), "~")
        XCTAssertEqual(DomainPaths.abbreviateHome("/Users/example/x", home: "/Users/example/"), "~/x")
    }

    func testLeavesEverythingElseExactlyAsItWas() {
        XCTAssertEqual(DomainPaths.abbreviateHome("/srv/api", home: "/Users/example"), "/srv/api")
        XCTAssertEqual(DomainPaths.abbreviateHome("/Users/example2/x", home: "/Users/example"), "/Users/example2/x")
        XCTAssertEqual(DomainPaths.abbreviateHome("/srv/api", home: nil), "/srv/api")
    }

    func testRefusesAHomeThatWouldSwallowEveryPathOnTheMachine() {
        XCTAssertEqual(DomainPaths.abbreviateHome("/srv/api", home: "/"), "/srv/api")
        XCTAssertEqual(DomainPaths.abbreviateHome("/srv/api", home: ""), "/srv/api")
        XCTAssertEqual(DomainPaths.abbreviateHome("/srv/api", home: "relative/home"), "/srv/api")
    }
}
