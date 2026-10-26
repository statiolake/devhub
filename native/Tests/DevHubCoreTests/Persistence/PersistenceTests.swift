// Port of apps/desktop/src/model/persistence.test.ts
//
// The TypeScript tests mutate a parsed document with arbitrary keys and
// values, which is how a file on disk can be wrong. Here the records are
// typed, so those cases go the road a real file takes: the document is
// edited as JSON, written, and read back through the store — the one gate,
// whose decoder is the validator.

import Foundation
import XCTest
@testable import DevHubCore

private let S_WS_A = WorkspaceId(unchecked: "550e8400-e29b-41d4-a716-446655440000")
private let S_WS_B = WorkspaceId(unchecked: "550e8400-e29b-41d4-a716-446655440001")
private let S_AG_A = AgentId(unchecked: "550e8400-e29b-41d4-a716-4466554400a0")
private let S_AG_B = AgentId(unchecked: "550e8400-e29b-41d4-a716-4466554400a1")
private let stateCodex = profile()
private let TODAY_PATH = "/dev/a"

private func today(_ path: String = TODAY_PATH) -> Workspace { localWorkspace(path) }

private func populatedModel() throws -> AppModel {
    var model = AppModel(scratch: Workspace(id: S_WS_A, location: .local(path: "/dev/a"), selectedPath: "/dev/a"))
    try model.addWorkspace(Workspace(id: S_WS_B, location: .local(path: "/dev/b"), selectedPath: "/dev/b"))
    try model.addAgent(owner: S_WS_A, id: S_AG_A, profile: stateCodex, agentPresentation: .tui)
    return model
}

private func stateOf(_ model: AppModel) throws -> PersistedAppState { try StatePersistence.state(from: model.snapshot()) }

private func hydrate(_ state: PersistedAppState, _ profiles: [AgentProfile] = [stateCodex], _ day: Workspace = today()) throws -> AppModel {
    try StatePersistence.hydrate(state, profiles: profiles, today: day)
}

/// The same state with nothing left in it, which is still a valid state.
private func emptied(_ state: PersistedAppState) -> PersistedAppState {
    var copy = state
    copy.workspaces = []
    copy.navigation = nil
    return copy
}

// MARK: - Editing a document the way a file can be wrong

extension WireJSON {
    /// The document with the value at a dotted path (`workspaces.0.agents.0.status`)
    /// replaced, or removed when `value` is nil.
    func editing(_ path: String, _ value: WireJSON?) -> WireJSON {
        editing(path.split(separator: ".").map(String.init)[...], value)
    }

    private func editing(_ steps: ArraySlice<String>, _ value: WireJSON?) -> WireJSON {
        guard let step = steps.first else { return value ?? .null }
        let rest = steps.dropFirst()
        switch self {
        case var .object(pairs):
            if let index = pairs.firstIndex(where: { $0.key == step }) {
                if rest.isEmpty && value == nil {
                    pairs.remove(at: index)
                } else {
                    pairs[index].value = rest.isEmpty ? value! : pairs[index].value.editing(rest, value)
                }
            } else if let value {
                pairs.append((step, rest.isEmpty ? value : WireJSON.object([]).editing(rest, value)))
            }
            return .object(pairs)
        case var .array(items):
            guard let index = Int(step), items.indices.contains(index) else { return self }
            if rest.isEmpty && value == nil {
                items.remove(at: index)
            } else {
                items[index] = rest.isEmpty ? value! : items[index].editing(rest, value)
            }
            return .array(items)
        default:
            return self
        }
    }

    func at(_ path: String) -> WireJSON? {
        var node: WireJSON? = self
        for step in path.split(separator: ".") {
            if let index = Int(step), let items = node?.arrayValue {
                node = items.indices.contains(index) ? items[index] : nil
            } else {
                node = node?[String(step)]
            }
        }
        return node
    }
}

/// A scratch directory of the person's own, `0700`, like the user data one.
final class StateScratch {
    let directory: String
    var path: String { directory + "/state.json" }

    init() {
        directory = NSTemporaryDirectory() + "devhub-state-\(UUID().uuidString)"
        try! FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    deinit { try? FileManager.default.removeItem(atPath: directory) }

    func write(_ document: WireJSON, mode: Int = 0o600) { write(document.compact, mode: mode) }

    func write(_ text: String, mode: Int = 0o600) {
        try? FileManager.default.removeItem(atPath: path)
        FileManager.default.createFile(atPath: path, contents: Data(text.utf8), attributes: [.posixPermissions: mode])
    }

    func read() -> WireJSON? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return try? WireJSON.parse([UInt8](data))
    }

    func store(_ prepare: StatePreparation? = nil) -> JsonStateStore { JsonStateStore(path: path, prepare: prepare) }
}

/// A good file with one thing changed, loaded, and what the load said.
private func loadWith(_ mutate: (WireJSON) -> WireJSON) async throws -> StateLoad {
    let scratch = StateScratch()
    scratch.write(mutate(try stateOf(try populatedModel()).json))
    return try await scratch.store().loadState()
}

// MARK: - Tests

final class StateProjectionTests: XCTestCase {
    func testRoundTripsAPopulatedModelThroughRecords() throws {
        let model = try populatedModel()
        let restored = try hydrate(try stateOf(model))
        XCTAssertEqual(restored.snapshot().workspaces.map(\.root), ["/dev/a", "/dev/b"])
        XCTAssertEqual(restored.snapshot().workspaces[0].agents.map(\.id), [S_AG_A])
        XCTAssertEqual(restored.snapshot().selection, model.snapshot().selection)
    }

    func testRoundTripsWhereAWorkspacesEditorIsAttached() throws {
        var model = try populatedModel()
        _ = try model.attachEditor(S_WS_B, .devContainer(configPath: "/dev/b/.devcontainer/devcontainer.json"))
        let state = try stateOf(model)
        XCTAssertEqual(state.workspaces[1].editor?.configPath, "/dev/b/.devcontainer/devcontainer.json")
        XCTAssertEqual(state.json.at("workspaces.1.editor"), [
            "kind": "dev_container", "config_path": "/dev/b/.devcontainer/devcontainer.json",
        ])
        // The Workspace's own machine is written as nothing at all.
        XCTAssertNil(state.json.at("workspaces.0.editor"))
        let restored = try hydrate(state).snapshot()
        XCTAssertEqual(restored.workspaces[1].editor, model.snapshot().workspaces[1].editor)
        XCTAssertEqual(restored.workspaces[0].editor, .host)
    }

    func testKeepsAnAgentWhoseProfileIsGoneMarkedUnavailable() throws {
        let restored = try hydrate(try stateOf(try populatedModel()), [])
        let agent = restored.snapshot().workspaces[0].agents[0]
        XCTAssertEqual(agent.status, .waiting)
        XCTAssertEqual(agent.runtimeHealth, .unavailable)
        XCTAssertEqual(agent.displayName, "Codex")
    }

    func testRoundTripsWhyAnAgentIsUnread() throws {
        var model = try populatedModel()
        try model.selectContext(.workspace(S_WS_B))
        try model.setAgentStatus(S_AG_A, .working)
        try model.setAgentStatus(S_AG_A, .idle)
        let state = try stateOf(model)
        XCTAssertEqual(state.workspaces[0].agents[0].unread, .reason(.idle))
        XCTAssertEqual(try hydrate(state).snapshot().workspaces[0].agents[0].unread, .idle)
    }

    func testReadsAnOlderDevHubsUnreadTrueAsTheQuestionItMeant() throws {
        var model = try populatedModel()
        try model.selectContext(.workspace(S_WS_B))
        var state = try stateOf(model)
        state.workspaces[0].agents[0].unread = .flag(true)
        XCTAssertEqual(try hydrate(state).snapshot().workspaces[0].agents[0].unread, .waiting)
    }

    func testReadsAnOlderDevHubsUnreadFalseAsRead() throws {
        var model = try populatedModel()
        try model.selectContext(.workspace(S_WS_B))
        var state = try stateOf(model)
        state.workspaces[0].agents[0].unread = .flag(false)
        XCTAssertNil(try hydrate(state).snapshot().workspaces[0].agents[0].unread)
    }

    func testRoundTripsTheAgentAWorkspaceWasLastIn() throws {
        var model = try populatedModel()
        try model.selectContext(.agent(S_AG_A))
        try model.selectContext(.workspace(S_WS_B))
        let state = try stateOf(model)
        XCTAssertEqual(state.workspaces[0].lastAgentId, S_AG_A.rawValue)
        XCTAssertEqual(try hydrate(state).lastAgentIn(S_WS_A), S_AG_A)
    }

    func testHasNothingRememberedForAWorkspaceNobodyOpenedAnAgentIn() throws {
        var model = try populatedModel()
        try model.selectContext(.workspace(S_WS_B))
        var state = try stateOf(model)
        state.workspaces[0].lastAgentId = nil
        XCTAssertNil(try hydrate(state).lastAgentIn(S_WS_A))
    }

    func testForgetsAnAgentThatDidNotComeBack() throws {
        var model = try populatedModel()
        try model.selectContext(.agent(S_AG_A))
        try model.selectContext(.workspace(S_WS_B))
        var state = try stateOf(model)
        state.workspaces[0].lastAgentId = S_AG_B.rawValue
        XCTAssertNil(try hydrate(state).lastAgentIn(S_WS_A))
    }

    func testKeepsTheProviderMappingTheModelDoesNotOwn() throws {
        var model = try populatedModel()
        var state = try stateOf(model)
        state.workspaces[0].agents[0].providerMapping = "session-42"
        try model.addAgent(owner: S_WS_A, id: S_AG_B, profile: stateCodex, agentPresentation: .tui)
        let next = try StatePersistence.apply(model.snapshot(), to: state)
        XCTAssertEqual(next.workspaces[0].agents[0].providerMapping, "session-42")
        XCTAssertNil(next.workspaces[0].agents[1].providerMapping)
    }

    func testWritesNothingDownAboutWhichIssueAWorkspaceIsFor() throws {
        XCTAssertFalse(try stateOf(try populatedModel()).fileText.contains("issue_url"))
    }

    func testIgnoresTheIssueAnOlderDevHubWroteDown() async throws {
        let load = try await loadWith { $0.editing("workspaces.0.issue_url", "https://example.com/not-an-issue") }
        XCTAssertNil(load.metadata.recoveryReason)
        let rewritten = try stateOf(try hydrate(load.state))
        XCTAssertFalse(rewritten.fileText.contains("issue_url"))
    }

    // MARK: Scratch across a restart

    func testBringsYesterdaysScratchBackAsAnOrdinaryRowWithItsAgentsAndMakesTodays() throws {
        var yesterday = try populatedModel()
        try yesterday.selectContext(.workspace(S_WS_A))
        let state = try stateOf(yesterday)
        XCTAssertNil(state.navigation)
        XCTAssertEqual(state.json["navigation"], [:])
        let snapshot = try hydrate(state, [stateCodex], today("/dev/daily/20260924")).snapshot()
        XCTAssertEqual(snapshot.workspaces.map(\.root), ["/dev/daily/20260924", "/dev/a", "/dev/b"])
        XCTAssertEqual(snapshot.workspaces.map(\.label), ["Scratch", "a", "b"])
        XCTAssertEqual(snapshot.workspaces[1].id, S_WS_A)
        XCTAssertEqual(snapshot.workspaces[1].agents.map(\.id), [S_AG_A])
        XCTAssertEqual(snapshot.selection.context, .workspace(snapshot.scratchWorkspaceId))
    }

    func testMakesScratchTheFolderTheSettingItLaunchesOnGives() throws {
        let before = AppModel(scratch: today("/dev/junk/20260925"))
        let snapshot = try hydrate(try stateOf(before), [], today("/dev/workspace/daily/2026/0925")).snapshot()
        XCTAssertEqual(snapshot.workspaces.map(\.root), ["/dev/workspace/daily/2026/0925", "/dev/junk/20260925"])
        XCTAssertEqual(snapshot.workspaces.map(\.label), ["Scratch", "20260925"])
    }

    func testKeepsScratchsIdAgentsAndAllOnTheSameDay() throws {
        let model = try hydrate(try stateOf(try populatedModel()))
        XCTAssertEqual(model.scratchWorkspaceId, S_WS_A)
        XCTAssertEqual(model.snapshot().workspaces.count, 2)
    }

    // MARK: navigation restore

    func testFallsToTheNextAgentThenTheWorkspaceThenScratch() throws {
        var model = try populatedModel()
        try model.addAgent(owner: S_WS_A, id: S_AG_B, profile: stateCodex, agentPresentation: .tui)
        try model.selectContext(.agent(S_AG_A))
        let state = try stateOf(model)
        XCTAssertEqual(
            try StatePersistence.restoreNavigation(state, liveWorkspaceIds: [S_WS_A.rawValue, S_WS_B.rawValue], liveAgentIds: [S_AG_B.rawValue]),
            StatePersistence.NavigationRestore(context: .agent(S_AG_B.rawValue), changed: true))
        XCTAssertEqual(
            try StatePersistence.restoreNavigation(state, liveWorkspaceIds: [S_WS_A.rawValue, S_WS_B.rawValue], liveAgentIds: []),
            StatePersistence.NavigationRestore(context: .workspace(S_WS_A.rawValue), changed: true))
        XCTAssertEqual(
            try StatePersistence.restoreNavigation(state, liveWorkspaceIds: [], liveAgentIds: []),
            StatePersistence.NavigationRestore(context: nil, changed: true))
    }

    // MARK: validation

    func testRejectsTwoWorkspacesOnTheSameCanonicalPath() {
        var state = PersistedAppState.fresh()
        let record = WorkspaceStateRecord(
            workspaceId: S_WS_A.rawValue, selectedPath: "/dev/a", canonicalPath: "/dev/a", location: nil, editor: nil,
            repositoryId: nil, lastAgentId: nil, lifecycle: .available, agents: [], paneLayout: nil, paneTerminals: nil)
        var second = record
        second.workspaceId = S_WS_B.rawValue
        state.workspaces = [record, second]
        XCTAssertThrowsError(try StateValidation.validate(state)) { XCTAssertTrue($0 is StateError) }
    }

    // MARK: shutdown metadata

    func testMarksALaunchUncleanAndAShutdownCleanAgain() {
        var state = PersistedAppState.fresh()
        XCTAssertTrue(state.markStarting())
        XCTAssertEqual(state.shutdown, ShutdownMetadata(clean: false, launchGeneration: 1))
        XCTAssertTrue(state.markCleanShutdown())
        XCTAssertFalse(state.markCleanShutdown())
    }

    // MARK: presentations

    func testKeepsAnAgentsPresentationApartFromItsProfilesDefault() throws {
        let claude = try AgentProfile.create(id: "claude", displayName: "Claude", kind: .claude, command: "claude", presentation: .gui)
        var model = try populatedModel()
        try model.addAgent(owner: S_WS_B, id: S_AG_B, profile: claude, agentPresentation: .tui)
        let state = try stateOf(model)
        let record = state.workspaces[1].agents[0]
        XCTAssertEqual(record.presentation, .tui)
        XCTAssertEqual(record.profilePresentation, .gui)
        let agent = try hydrate(state, [stateCodex, claude]).snapshot().workspaces[1].agents[0]
        XCTAssertEqual(agent.presentation, .tui)
        XCTAssertEqual(agent.profile.presentation, .gui)
    }

    func testRefusesAGuiAgentWhoseProfilesKindHasNoGui() throws {
        var state = try stateOf(try populatedModel())
        state.workspaces[0].agents[0].profileKind = .cursor
        state.workspaces[0].agents[0].presentation = .gui
        XCTAssertThrowsError(try hydrate(state, [])) { XCTAssertTrue($0 is StateError) }
    }

    func testCarriesEveryFieldTheModelOwnsNotOnlyTheOnesItUsedTo() throws {
        var model = try populatedModel()
        _ = try model.setSidebarWidth(321)
        _ = try model.setSplitRatio(0.7)
        let merged = try StatePersistence.apply(model.snapshot(), to: .fresh())
        XCTAssertEqual(merged.sidebar.width, 321)
        XCTAssertEqual(merged.splitRatio, 0.7)
    }

    // MARK: projecting a state file that will not project

    func testNamesTheRecordAndTheReasonWhenTheDocumentIsAtFault() throws {
        var state = try stateOf(try populatedModel())
        state.workspaces[0].selectedPath = "/dev/../.."
        XCTAssertThrowsError(try hydrate(state, [])) { error in
            guard let refusal = error as? StateError else { return XCTFail("\(error)") }
            let described = refusal.describe("state.json")
            XCTAssertTrue(described.contains(state.workspaces[0].workspaceId), described)
            XCTAssertTrue(described.contains("INVALID_PATH"), described)
        }
    }

    // MARK: a Workspace's place across a restart

    private let WS_C = WorkspaceId(unchecked: "33333333-3333-4333-8333-333333333333")

    private func remoteModel() throws -> AppModel {
        var model = AppModel(scratch: today())
        try model.addWorkspace(Workspace(id: S_WS_B, location: .ssh(host: "build.example.com", path: "/srv/api"), selectedPath: "/srv/api"))
        try model.addWorkspace(Workspace(id: WS_C, location: .ssh(host: "staging.example.com", path: "/srv/api"), selectedPath: "/srv/api"))
        return model
    }

    func testRoundTripsTheMachineNotJustThePath() throws {
        let state = try stateOf(try remoteModel())
        XCTAssertEqual(state.workspaces.map(\.location), [.local, .ssh(host: "build.example.com"), .ssh(host: "staging.example.com")])
        try StateValidation.validate(state)
        XCTAssertEqual(
            try hydrate(state, []).snapshot().workspaces.map(\.key),
            ["/dev/a", "ssh://build.example.com/srv/api", "ssh://staging.example.com/srv/api"])
    }

    func testRefusesAHostThatCouldNotSurviveBeingAUriAuthority() {
        var state = PersistedAppState.fresh()
        state.workspaces = [WorkspaceStateRecord(
            workspaceId: S_WS_A.rawValue, selectedPath: "/srv/api", canonicalPath: "/srv/api", location: .ssh(host: "build/etc"),
            editor: nil, repositoryId: nil, lastAgentId: nil, lifecycle: .available, agents: [], paneLayout: nil, paneTerminals: nil)]
        XCTAssertThrowsError(try StateValidation.validate(state))
    }

    func testKeepsTwoMachinesIdenticalPathsAsTwoRecords() throws {
        XCTAssertNoThrow(try StateValidation.validate(try stateOf(try remoteModel())))
    }

    // MARK: the order a person put the rows in

    private func orderedModel() throws -> AppModel {
        var model = AppModel(scratch: today())
        try model.addWorkspace(Workspace(id: S_WS_A, location: .local(path: "/srv/api"), selectedPath: "/srv/api"))
        try model.addWorkspace(Workspace(id: S_WS_B, location: .local(path: "/srv/web"), selectedPath: "/srv/web"))
        return model
    }

    func testCarriesAnArrangementFromTheModelToTheFileAndBack() throws {
        var model = try orderedModel()
        _ = model.setWorkspaceOrder([S_WS_B, S_WS_A])
        let state = try stateOf(model)
        XCTAssertEqual(state.sidebar.order, [S_WS_B.rawValue, S_WS_A.rawValue])
        XCTAssertEqual(try hydrate(state, []).snapshot().workspaceOrder, [S_WS_B, S_WS_A])
    }

    func testKeepsAnIdWhoseWorkspaceHasClosed() throws {
        var model = AppModel(scratch: today())
        try model.addWorkspace(Workspace(id: S_WS_A, location: .local(path: "/srv/api"), selectedPath: "/srv/api"))
        _ = model.setWorkspaceOrder([S_WS_B, S_WS_A])
        let state = try stateOf(model)
        XCTAssertEqual(state.sidebar.order, [S_WS_B.rawValue, S_WS_A.rawValue])
        XCTAssertEqual(try hydrate(state, []).snapshot().workspaceOrder, [S_WS_B, S_WS_A])
    }

    func testRefusesAnOrderEntryThatIsNotAnIdentity() {
        var state = PersistedAppState.fresh()
        state.sidebar.order = ["not-a-uuid"]
        XCTAssertThrowsError(try StateValidation.validate(state))
    }

    func testWritesAnAgentsPlaceOutAsThePlaceItIsInTheList() throws {
        var model = AppModel(scratch: today())
        try model.addWorkspace(Workspace(id: S_WS_A, location: .local(path: "/srv/api"), selectedPath: "/srv/api"))
        try model.addAgent(owner: S_WS_A, id: S_AG_A, profile: stateCodex, agentPresentation: .tui)
        try model.addAgent(owner: S_WS_A, id: S_AG_B, profile: stateCodex, agentPresentation: .tui)
        _ = try model.setAgentOrder(S_WS_A, [S_AG_B, S_AG_A])
        let state = try stateOf(model)
        XCTAssertEqual(state.workspaces[1].agents.map(\.agentId), [S_AG_B.rawValue, S_AG_A.rawValue])
        XCTAssertEqual(try hydrate(state).snapshot().workspaces[1].agents.map(\.id), [S_AG_B, S_AG_A])
    }
}

final class StateStoreTests: XCTestCase {
    func testReturnsAFreshStateWhenThereIsNoFile() async throws {
        let scratch = StateScratch()
        let load = try await scratch.store().loadState()
        XCTAssertEqual(load.metadata.origin, .fresh)
        XCTAssertEqual(load.metadata.recoveryReason, .missing)
        XCTAssertEqual(load.state, .fresh())
    }

    func testRoundTripsASaveAndALoad() async throws {
        let scratch = StateScratch()
        let store = scratch.store()
        let state = try stateOf(try populatedModel())
        try await store.saveState(state)
        let load = try await store.loadState()
        XCTAssertEqual(load.metadata.origin, .primary)
        XCTAssertEqual(load.state, state)
    }

    /// The bytes are the TypeScript store's: `JSON.stringify(state, null, 2)`
    /// and a newline, so a file one app wrote the other reads and rewrites
    /// unchanged.
    func testWritesTheFileByteForByteAsItWouldBeReadBack() async throws {
        let scratch = StateScratch()
        let store = scratch.store()
        let state = try stateOf(try populatedModel())
        try await store.saveState(state)
        let first = FileManager.default.contents(atPath: scratch.path)
        let load = try await store.loadState()
        try await store.saveState(load.state)
        XCTAssertEqual(FileManager.default.contents(atPath: scratch.path), first)
        XCTAssertEqual(String(data: first ?? Data(), encoding: .utf8), state.fileText)
        let attributes = try FileManager.default.attributesOfItem(atPath: scratch.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testKeepsABackupOfTheLastFileThatParsed() async throws {
        let scratch = StateScratch()
        let store = scratch.store()
        let first = try stateOf(try populatedModel())
        try await store.saveState(first)
        try await store.saveState(emptied(first))
        let backup = FileManager.default.contents(atPath: store.backupPath).flatMap { try? WireJSON.parse([UInt8]($0)) }
        XCTAssertEqual(backup, first.json)
    }

    func testQuarantinesACorruptPrimaryAndRecoversFromTheBackup() async throws {
        let scratch = StateScratch()
        let store = scratch.store()
        let good = try stateOf(try populatedModel())
        try await store.saveState(good)
        try await store.saveState(emptied(good))
        scratch.write("{ not json")
        let load = try await store.loadState()
        XCTAssertEqual(load.metadata.origin, .backup)
        XCTAssertEqual(load.metadata.recoveryReason, .corruptPrimary)
        XCTAssertTrue(load.metadata.primaryQuarantined)
        XCTAssertEqual(load.state, good)
    }

    func testNamesTheFileAndTheReasonWhenASaveCannotBeWritten() async throws {
        if getuid() == 0 { throw XCTSkip("root writes through a read-only directory") }
        let scratch = StateScratch()
        let store = JsonStateStore(path: scratch.directory + "/locked/state.json")
        chmod(scratch.directory, 0o500)
        defer { chmod(scratch.directory, 0o700) }
        do {
            try await store.saveState(.fresh())
            XCTFail("the save should not have succeeded")
        } catch let error as StateError {
            let described = error.describe()
            XCTAssertTrue(described.contains("state.json"), described)
            XCTAssertTrue(described.contains("permission") || described.contains("could not be written"), described)
            XCTAssertTrue(described.contains("EACCES"), described)
        }
    }

    func testRefusesAStateFileFromANewerSchema() async {
        let scratch = StateScratch()
        scratch.write(["schema_version": 99])
        do {
            _ = try await scratch.store().loadState()
            XCTFail("a newer file was read")
        } catch {
            XCTAssertTrue(error is StateError)
        }
    }

    func testRefusesAWorldReadableStateFileRatherThanTrustingIt() async {
        let scratch = StateScratch()
        scratch.write(PersistedAppState.fresh().json, mode: 0o644)
        do {
            _ = try await scratch.store().loadState()
            XCTFail("a world-readable file was trusted")
        } catch {
            XCTAssertTrue(error is StateError)
        }
    }

    func testMigratesALegacyFileThatStillSpellsTheSchemaAsVersion() async throws {
        let scratch = StateScratch()
        scratch.write(PersistedAppState.fresh().json.editing("schema_version", 1).editing("version", 1))
        let load = try await scratch.store().loadState()
        XCTAssertTrue(load.metadata.migrated)
        let written = scratch.read()
        XCTAssertNil(written?["version"])
        XCTAssertEqual(written?["schema_version"], .int(StateSchema.version))
    }

    func testTakesAVersion1FileActivityAndAllAndDropsWhatItRetired() async throws {
        let scratch = StateScratch()
        scratch.write(PersistedAppState.fresh().json
            .editing("schema_version", 1)
            .editing("navigation", ["context": ["kind": "global"], "activity": "terminal"])
            .editing("split", nil))
        let load = try await scratch.store().loadState()
        XCTAssertTrue(load.metadata.migrated)
        XCTAssertNil(load.state.navigation)
        XCTAssertEqual(load.state.splitRatio, AppModel.splitDefaultRatio)
    }

    func testReadsTheRetiredExpandedAsNothingAndWritesTheFieldThereIs() async throws {
        let scratch = StateScratch()
        scratch.write(PersistedAppState.fresh().json.editing("sidebar", ["width": 321, "expanded": false]))
        let store = scratch.store()
        let load = try await store.loadState()
        XCTAssertEqual(load.state.sidebar.width, 321)
        let model = try hydrate(load.state, [])
        XCTAssertEqual(model.snapshot().sidebar.width, 321)
        XCTAssertEqual(model.snapshot().sidebar.collapsed, false)
        try await store.saveState(try stateOf(model))
        XCTAssertEqual(scratch.read()?["sidebar"], ["width": 321, "collapsed": false, "order": []])
    }

    func testBringsTheRailBackExactlyAsItWasLeft() async throws {
        let scratch = StateScratch()
        let store = scratch.store()
        var state = PersistedAppState.fresh()
        state.sidebar = SidebarState(width: 321, collapsed: true, order: [])
        try await store.saveState(state)
        let model = try hydrate(try await store.loadState().state, [])
        XCTAssertEqual(model.snapshot().sidebar, SidebarSnapshot(width: 321, collapsed: true))
    }

    func testRoundTripsAnInterruptedSocketTransition() async throws {
        let scratch = StateScratch()
        var state = try stateOf(try populatedModel())
        let a = OwnedSessionRecordState(workspaceId: S_WS_A.rawValue, sessionName: "ws-0123456789abcdef0123")
        let b = OwnedSessionRecordState(workspaceId: S_WS_B.rawValue, sessionName: "ws-fedcba9876543210fedc")
        state.tmux = TmuxState(effectiveSocketName: "devhub", transition: .cleaningOld(
            oldSocketName: "devhub", requestedSocketName: "devhub-next", required: [a, b], targetPreflight: .targetAbsent,
            sessions: [(a, .completed)]))
        let store = scratch.store()
        try await store.saveState(state)
        let read1 = try await store.loadState().state.tmux
        XCTAssertEqual(read1, state.tmux)
    }

    func testMigratesAVersion9FilesScratchGlobalBecomesAbsentTheScratchSessionGoes() async throws {
        let scratch = StateScratch()
        let a: WireJSON = ["kind": "workspace", "workspace_id": .string(S_WS_A.rawValue), "session_name": "ws-0123456789abcdef0123"]
        let b: WireJSON = ["kind": "workspace", "workspace_id": .string(S_WS_B.rawValue), "session_name": "ws-fedcba9876543210fedc"]
        let anchor: WireJSON = ["kind": "scratch", "session_name": "scratch"]
        scratch.write(try stateOf(try populatedModel()).json
            .editing("schema_version", 9)
            .editing("navigation", ["context": ["kind": "global"]])
            .editing("tmux", [
                "effective_socket_name": "devhub",
                "transition": [
                    "kind": "cleaning_old", "old_socket_name": "devhub", "requested_socket_name": "devhub-next",
                    "target_preflight": "target_absent", "required": [anchor, a, b],
                    "sessions": [["session": anchor, "status": "completed"]],
                ],
            ]))
        let load = try await scratch.store().loadState()
        XCTAssertTrue(load.metadata.migrated)
        XCTAssertEqual(load.state.schemaVersion, StateSchema.version)
        XCTAssertNil(load.state.navigation)
        guard case let .cleaningOld(_, _, required, _, sessions) = load.state.tmux.transition else { return XCTFail() }
        XCTAssertEqual(required.map(\.workspaceId), [S_WS_A.rawValue, S_WS_B.rawValue])
        XCTAssertTrue(sessions.isEmpty)
        let snapshot = try hydrate(load.state, [stateCodex], today("/srv/daily/20260923")).snapshot()
        XCTAssertEqual(snapshot.workspaces.map(\.root), ["/srv/daily/20260923", "/dev/a", "/dev/b"])
        XCTAssertEqual(snapshot.workspaces[1].agents.map(\.id), [S_AG_A])
        XCTAssertEqual(snapshot.selection.context, .workspace(snapshot.scratchWorkspaceId))
    }

    /// A version-11 document with a container Workspace in it: `WS_B` becomes
    /// a container record for `folder`, and keeps the Agent the populated
    /// model gave `WS_A` as its own.
    private func version11WithContainer(folder: String, configPath: String? = nil) throws -> WireJSON {
        var document = try stateOf(try populatedModel()).json.editing("schema_version", 11)
        document = document
            .editing("workspaces.1.canonical_path", "/workspaces/inside")
            .editing("workspaces.1.selected_path", "/workspaces/inside")
            .editing("workspaces.1.location", .object(dropping: [
                ("kind", "container"), ("workspace_folder", .string(folder)), ("config_path", configPath.map(WireJSON.string)),
            ]))
        let moved = (document.at("workspaces.0.agents")?.arrayValue ?? []).map { $0.setting("workspace_id", .string(S_WS_B.rawValue)) }
        return document
            .editing("workspaces.0.agents", [])
            .editing("workspaces.1.agents", .array(moved))
            .editing("session_machines", ["local", .string("container:\(folder)")])
            .editing("navigation", ["context": ["kind": "agent", "agent_id": .string(S_AG_A.rawValue)]])
    }

    func testTurnsAVersion11ContainerWorkspaceIntoItsFolderWithItsEditorAttached() async throws {
        let scratch = StateScratch()
        scratch.write(try version11WithContainer(folder: "/dev/c", configPath: "/dev/c/.devcontainer/python/devcontainer.json"))
        let load = try await scratch.store().loadState()
        XCTAssertEqual(load.metadata.origin, .primary)
        let record = load.state.workspaces[1]
        XCTAssertEqual(record.canonicalPath, "/dev/c")
        XCTAssertEqual(record.location, .local)
        XCTAssertEqual(record.editor?.configPath, "/dev/c/.devcontainer/python/devcontainer.json")
        XCTAssertEqual(record.agents, [])
        XCTAssertTrue(load.metadata.migrationNotes.joined(separator: " ").contains("1 Agent ran inside the dev container for /dev/c"))
        XCTAssertEqual(load.state.navigation, .workspace(S_WS_B.rawValue))
        XCTAssertEqual(load.state.sessionMachines, ["local"])
        let workspace = try hydrate(load.state).snapshot().workspaces.first { $0.id == S_WS_B }
        XCTAssertEqual(workspace?.location, .local(path: "/dev/c"))
        XCTAssertEqual(workspace?.editor, .devContainer(configPath: "/dev/c/.devcontainer/python/devcontainer.json"))
    }

    func testMakesOneWorkspaceOfAFolderThatWasOpenBothItselfAndInItsContainer() async throws {
        let scratch = StateScratch()
        scratch.write(try version11WithContainer(folder: "/dev/a", configPath: "/dev/a/.devcontainer/devcontainer.json")
            .editing("navigation", ["context": ["kind": "workspace", "workspace_id": .string(S_WS_B.rawValue)]])
            .editing("sidebar.order", [.string(S_WS_B.rawValue), .string(S_WS_A.rawValue)]))
        let load = try await scratch.store().loadState()
        XCTAssertEqual(load.state.workspaces.map(\.workspaceId), [S_WS_A.rawValue])
        XCTAssertNil(load.state.workspaces[0].editor)
        XCTAssertEqual(load.state.navigation, .workspace(S_WS_A.rawValue))
        XCTAssertEqual(load.state.sidebar.order, [S_WS_A.rawValue])
        XCTAssertTrue(load.metadata.migrationNotes.joined(separator: " ").contains("/dev/a was open both on this Mac and in its dev container"))
    }

    func testAsksMainForADefinitionTheVersion11FileNeverWroteDown() async throws {
        let scratch = StateScratch()
        scratch.write(try version11WithContainer(folder: "/dev/c"))
        let asked = Recorder<String>()
        let load = try await scratch.store { document, version in
            XCTAssertEqual(version, 11)
            var items = document["workspaces"]?.arrayValue ?? []
            for (index, record) in items.enumerated() where record["location"]?["kind"] == "container" {
                asked.add(record["location"]?["workspace_folder"]?.stringValue ?? "")
                items[index] = record.editing("location.config_path", "/dev/c/.devcontainer.json")
            }
            return (document.setting("workspaces", .array(items)), ["Docker did not answer."])
        }.loadState()
        XCTAssertEqual(asked.all, ["/dev/c"])
        XCTAssertEqual(load.state.workspaces[1].editor?.configPath, "/dev/c/.devcontainer.json")
        XCTAssertEqual(load.metadata.migrationNotes.first, "Docker did not answer.")
    }

    func testOpensTheEditorOnThisMacWhenNoDefinitionCouldBeFoundAndSaysSo() async throws {
        let scratch = StateScratch()
        scratch.write(try version11WithContainer(folder: "/dev/c"))
        let load = try await scratch.store { document, _ in (document, []) }.loadState()
        XCTAssertNil(load.state.workspaces[1].editor)
        XCTAssertEqual(load.state.workspaces[1].canonicalPath, "/dev/c")
        XCTAssertTrue(load.metadata.migrationNotes.joined(separator: " ").contains("No dev container definition was found for /dev/c"))
    }

    func testRefusesAVersion10FileThatStillNamesGlobal() async throws {
        let scratch = StateScratch()
        scratch.write(PersistedAppState.fresh().json.editing("navigation", ["context": ["kind": "global"]]))
        let load = try await scratch.store().loadState()
        XCTAssertTrue(load.metadata.corruptionDetail?.contains("navigation.context.kind") == true)
    }

    func testMigratesAVersion10FilesAgentsToTerminals() async throws {
        let scratch = StateScratch()
        scratch.write(try stateOf(try populatedModel()).json
            .editing("schema_version", 10)
            .editing("workspaces.0.agents.0.presentation", nil)
            .editing("workspaces.0.agents.0.profile_presentation", nil))
        let load = try await scratch.store().loadState()
        XCTAssertTrue(load.metadata.migrated)
        XCTAssertEqual(load.state.schemaVersion, StateSchema.version)
        let agent = load.state.workspaces[0].agents[0]
        XCTAssertEqual(agent.presentation, .tui)
        XCTAssertEqual(agent.profilePresentation, .tui)
        let nowGui = try AgentProfile.create(id: "codex", displayName: "Codex", kind: .codex, command: "codex", presentation: .gui)
        let restored = try hydrate(load.state, [nowGui]).snapshot().workspaces[0].agents[0]
        XCTAssertEqual(restored.presentation, .tui)
        XCTAssertEqual(restored.profile.presentation, .tui)
    }

    func testRefusesAVersion11AgentWithNoPresentationRatherThanGuessingOne() async throws {
        let load = try await loadWith { $0.editing("workspaces.0.agents.0.presentation", nil) }
        XCTAssertTrue(load.metadata.primaryQuarantined)
        XCTAssertTrue(load.metadata.corruptionDetail?.contains("workspaces[0].agents[0].presentation") == true)
    }

    // MARK: versions that are one absent key

    private func bare(_ version: Int, path: String = "/srv/api", location: WireJSON? = nil) -> WireJSON {
        PersistedAppState.fresh().json
            .editing("schema_version", .int(version))
            .editing("workspaces", [.object(dropping: [
                ("workspace_id", .string(S_WS_A.rawValue)), ("selected_path", .string(path)), ("canonical_path", .string(path)),
                ("location", location), ("lifecycle", ["kind": "available"]), ("agents", []),
            ])])
    }

    func testLoadsAVersion4RecordAsAFolderOnThisMachine() async throws {
        let scratch = StateScratch()
        scratch.write(bare(4, path: "/dev/a"))
        let loaded = try await scratch.store().loadState().state
        XCTAssertEqual(loaded.schemaVersion, StateSchema.version)
        XCTAssertEqual(loaded.workspaces[0].location, .local)
        XCTAssertEqual(try hydrate(loaded, []).snapshot().workspaces[0].location, .local(path: "/dev/a"))
    }

    func testLoadsAVersion5FileWithNoMachinesRememberedAndWritesThemBack() async throws {
        let scratch = StateScratch()
        scratch.write(bare(5, location: ["kind": "ssh", "host": "build.example.com"]).editing("session_machines", nil))
        let store = scratch.store()
        var load = try await store.loadState()
        XCTAssertEqual(load.state.schemaVersion, StateSchema.version)
        XCTAssertEqual(load.state.sessionMachines, [])
        load.state.sessionMachines = ["ssh:build.example.com"]
        try await store.saveState(load.state)
        let read2 = try await scratch.store().loadState().state.sessionMachines
        XCTAssertEqual(read2, ["ssh:build.example.com"])
    }

    func testLoadsAVersion6FileAsTheAutomaticOrderAndWritesOneBack() async throws {
        let scratch = StateScratch()
        scratch.write(bare(6).editing("sidebar", ["width": 260, "collapsed": false]))
        let store = scratch.store()
        var load = try await store.loadState()
        XCTAssertEqual(load.state.schemaVersion, StateSchema.version)
        XCTAssertEqual(load.state.sidebar.order, [])
        XCTAssertEqual(try hydrate(load.state, []).snapshot().workspaceOrder, [])
        load.state.sidebar.order = [S_WS_A.rawValue]
        try await store.saveState(load.state)
        let read3 = try await scratch.store().loadState().state.sidebar.order
        XCTAssertEqual(read3, [S_WS_A.rawValue])
    }

    func testLoadsAVersion8FileWithNoZoomAndWritesTheZoomBack() async throws {
        let scratch = StateScratch()
        scratch.write(PersistedAppState.fresh().json.editing("schema_version", 8).editing("terminal", nil))
        let store = scratch.store()
        let load = try await store.loadState()
        XCTAssertEqual(load.state.schemaVersion, StateSchema.version)
        XCTAssertEqual(load.state.zoomOffset, 0)
        var model = try hydrate(load.state, [])
        XCTAssertEqual(model.snapshot().terminalZoomOffset, 0)
        _ = try model.zoomTerminal(base: 13, direction: .zoomIn)
        _ = try model.zoomTerminal(base: 13, direction: .zoomIn)
        try await store.saveState(try StatePersistence.apply(model.snapshot(), to: load.state))
        let again = try await scratch.store().loadState()
        XCTAssertEqual(again.state.zoomOffset, 2)
        XCTAssertEqual(try hydrate(again.state, []).snapshot().terminalZoomOffset, 2)
    }

    func testRefusesAZoomNoSizeCouldBeNamedBy() async throws {
        let scratch = StateScratch()
        scratch.write(PersistedAppState.fresh().json.editing("terminal", ["zoom_offset": 400]))
        let load = try await scratch.store().loadState()
        XCTAssertEqual(load.state.zoomOffset, 0)
        XCTAssertNotEqual(load.metadata.origin, .primary)
    }

    func testLoadsAFileWithNoSmartButtonsPlacementAndWritesOneBack() async throws {
        let scratch = StateScratch()
        scratch.write(PersistedAppState.fresh().json.editing("smart_buttons", nil))
        let store = scratch.store()
        let load = try await store.loadState()
        XCTAssertEqual(load.metadata.origin, .primary)
        XCTAssertEqual(load.state.smartButtons, SmartButtonsPlacement())
        var model = try hydrate(load.state, [])
        let free = SmartButtonsSpot.free(SmartButtonsOffset(right: 40, bottom: 120))
        _ = try model.placeSmartButtons(.gui, free)
        try await store.saveState(try StatePersistence.apply(model.snapshot(), to: load.state))
        let again = try await scratch.store().loadState()
        XCTAssertEqual(again.state.smartButtons, SmartButtonsPlacement(gui: free))
        var restored = try hydrate(again.state, [])
        XCTAssertEqual(restored.snapshot().smartButtons, SmartButtonsPlacement(gui: free))
        _ = try restored.placeSmartButtons(.tui, .anchored(edge: .side, along: 8))
        try await store.saveState(try StatePersistence.apply(restored.snapshot(), to: again.state))
        let placed = try await scratch.store().loadState().state.smartButtons
        XCTAssertEqual(placed, SmartButtonsPlacement(tui: .anchored(edge: .side, along: 8), gui: free))
        XCTAssertEqual(scratch.read()?["smart_buttons"], [
            "tui": ["anchored": "side", "along": 8], "gui": ["right": 40, "bottom": 120],
        ])
        _ = try restored.placeSmartButtons(.tui, nil)
        _ = try restored.placeSmartButtons(.gui, nil)
        try await store.saveState(try StatePersistence.apply(restored.snapshot(), to: again.state))
        let read4 = try await scratch.store().loadState().state.smartButtons
        XCTAssertEqual(read4, SmartButtonsPlacement())
    }

    func testRefusesASmartButtonsPlacementThatIsNotAPlace() async throws {
        let cases: [WireJSON] = [
            ["tui": ["right": -1, "bottom": 0]],
            ["tui": ["right": 1.5, "bottom": 0]],
            ["tui": ["anchored": "below", "along": 0]],
            ["gui": ["anchored": "top", "along": 2.5]],
            ["sideways": ["right": 0, "bottom": 0]],
        ]
        for smartButtons in cases {
            let scratch = StateScratch()
            scratch.write(PersistedAppState.fresh().json.editing("smart_buttons", smartButtons))
            let load = try await scratch.store().loadState()
            XCTAssertNotEqual(load.metadata.origin, .primary, smartButtons.compact)
            XCTAssertEqual(load.state.smartButtons, SmartButtonsPlacement())
        }
    }

    // MARK: a version-3 file with a close in it

    private let closing: WireJSON = [
        "kind": "closing",
        "progress": ["agents_step": ["kind": "done", "closed": 2], "terminal_closed": true, "editor_closed": false],
    ]
    private let closingFailed: WireJSON = [
        "kind": "closing_failed", "diagnostic": "cleanup_failed",
        "progress": ["agents_step": ["kind": "pending"], "terminal_closed": false, "editor_closed": false],
    ]

    private func loadedFrom(_ lifecycle: WireJSON) async throws -> PersistedAppState {
        let scratch = StateScratch()
        scratch.write(bare(3, path: "/dev/a").editing("workspaces.0.lifecycle", lifecycle))
        return try await scratch.store().loadState().state
    }

    func testDecodesBothVersion3ClosesRatherThanRefusingTheFile() async throws {
        for lifecycle in [closing, closingFailed] {
            let state = try await loadedFrom(lifecycle)
            XCTAssertEqual(state.schemaVersion, StateSchema.version)
            XCTAssertEqual(state.workspaces[0].lifecycle, .available)
        }
    }

    func testLoadsTheWorkspaceAsOpenBecauseItWasNeverClosed() async throws {
        for lifecycle in [closing, closingFailed] {
            let workspace = try hydrate(try await loadedFrom(lifecycle), []).snapshot().workspaces[0]
            XCTAssertEqual(workspace.state, .available)
            XCTAssertEqual(workspace.close, .idle)
        }
    }

    func testWritesTheFileBackWithNoCloseInItAtAll() async throws {
        let written = try stateOf(try hydrate(try await loadedFrom(closing), []))
        XCTAssertEqual(written.workspaces[0].lifecycle, .available)
        XCTAssertFalse(written.fileText.contains("agents_step"))
        XCTAssertFalse(written.fileText.contains("progress"))
    }
}

final class StateDecodingTests: XCTestCase {
    func testRefusesAValueThatIsNotAMemberOfItsEnumAndSaysWhich() async throws {
        let load = try await loadWith { $0.editing("workspaces.0.agents.0.status", "banana") }
        XCTAssertEqual(load.metadata.recoveryReason, .corruptPrimary)
        let detail = load.metadata.corruptionDetail ?? ""
        XCTAssertTrue(detail.contains("workspaces[0].agents[0].status"), detail)
        XCTAssertTrue(detail.contains("\"banana\""), detail)
        XCTAssertTrue(detail.contains("working"), detail)
    }

    func testRefusesANumberWrittenAsAStringBeforeAnythingComparesIt() async throws {
        let load = try await loadWith { $0.editing("sidebar", ["width": "300"]) }
        XCTAssertEqual(load.metadata.recoveryReason, .corruptPrimary)
        let detail = load.metadata.corruptionDetail ?? ""
        XCTAssertTrue(detail.contains("sidebar.width"), detail)
        XCTAssertTrue(detail.contains("a number"), detail)
        XCTAssertTrue(detail.contains("\"300\""), detail)
    }

    func testTakesALifecycleThatNamesACloseAndGivesBackAnOpenOne() async throws {
        let lifecycles: [WireJSON] = [
            ["kind": "closing", "progress": ["agents_step": ["kind": "done", "closed": 3], "terminal_closed": true, "editor_closed": false]],
            ["kind": "closing_failed", "diagnostic": "cleanup_failed", "progress": [:]],
            ["kind": "closing", "progress": ["agents_step": "banana"]],
        ]
        for lifecycle in lifecycles {
            let load = try await loadWith { $0.editing("workspaces.0.lifecycle", lifecycle) }
            XCTAssertNil(load.metadata.recoveryReason)
            XCTAssertEqual(load.state.workspaces[0].lifecycle, .available)
        }
    }

    func testRefusesARequiredFieldThatIsNotThere() async throws {
        let load = try await loadWith { $0.editing("workspaces.0.lifecycle", nil) }
        XCTAssertEqual(load.metadata.recoveryReason, .corruptPrimary)
        let detail = load.metadata.corruptionDetail ?? ""
        XCTAssertTrue(detail.contains("workspaces[0].lifecycle"), detail)
        XCTAssertTrue(detail.contains("nothing"), detail)
    }

    func testRefusesAnUnknownTagOnAUnionTheModelOwns() async throws {
        let load = try await loadWith { $0.editing("workspaces.0.agents.0.control_state", ["kind": "exploded"]) }
        let detail = load.metadata.corruptionDetail ?? ""
        XCTAssertTrue(detail.contains("workspaces[0].agents[0].control_state.kind"), detail)
        XCTAssertTrue(detail.contains("stop_failed"), detail)
    }

    func testDecodesAnOptionalFieldOnceIntoTheTypeTheModelUses() async throws {
        let load = try await loadWith {
            $0.editing("workspaces.0.agents.0.unread", true)
                .editing("navigation", ["context": ["kind": "workspace", "workspace_id": .string(S_WS_B.rawValue)]])
        }
        XCTAssertNil(load.metadata.recoveryReason)
        XCTAssertEqual(try hydrate(load.state, []).snapshot().workspaces[0].agents[0].unread, .waiting)
        let bad = try await loadWith { $0.editing("workspaces.0.agents.0.unread", "banana") }
        XCTAssertTrue(bad.metadata.corruptionDetail?.contains("workspaces[0].agents[0].unread") == true)
    }

    func testIgnoresKeysThisBuildHasNoUseForAndDropsThem() async throws {
        let load = try await loadWith {
            $0.editing("nonsense", 1)
                .editing("sidebar", ["width": 321, "expanded": false])
                .editing("workspaces.0.issue_url", "https://example.invalid/1")
        }
        XCTAssertNil(load.metadata.recoveryReason)
        XCTAssertEqual(load.state.sidebar, SidebarState(width: 321, collapsed: false, order: []))
        XCTAssertFalse(load.state.fileText.contains("issue_url"))
        XCTAssertFalse(load.state.fileText.contains("nonsense"))
    }

    // MARK: what validation checks and hydration may then assume

    /// Every field hydration reads, broken in the file: the decoder — the one
    /// gate — refuses it and names the field.
    func testRefusesEachGapAndNamesTheField() async throws {
        let gaps: [(String, String, WireJSON?)] = [
            ("workspaces.0.agents.0.control_state", "workspaces[0].agents[0].control_state", nil),
            ("workspaces.0.agents.0.control_state", "workspaces[0].agents[0].control_state.kind", [:]),
            ("workspaces.0.agents.0.control_state", "workspaces[0].agents[0].control_state.diagnostic", ["kind": "stop_failed"]),
            ("workspaces.0.agents.0.status", "workspaces[0].agents[0].status", nil),
            ("workspaces.0.agents.0.status", "workspaces[0].agents[0].status", "banana"),
            ("workspaces.0.agents.0.runtime_health", "workspaces[0].agents[0].runtime_health", nil),
            ("workspaces.0.agents.0.profile_kind", "workspaces[0].agents[0].profile_kind", "banana"),
            ("workspaces.0.agents.0.unread", "workspaces[0].agents[0].unread", "banana"),
            ("workspaces.0.lifecycle", "workspaces[0].lifecycle", nil),
            ("workspaces.0.lifecycle", "workspaces[0].lifecycle.reason", ["kind": "unavailable", "reason": "banana"]),
            ("workspaces.0.location", "workspaces[0].location.kind", ["kind": "banana"]),
            ("sidebar.width", "sidebar.width", "300"),
            ("split.ratio", "split.ratio", "0.5"),
            ("navigation.context", "navigation.context.kind", ["kind": "banana"]),
        ]
        for (path, named, value) in gaps {
            let load = try await loadWith { $0.editing(path, value) }
            XCTAssertEqual(load.metadata.recoveryReason, .corruptPrimary, path)
            XCTAssertTrue(load.metadata.corruptionDetail?.contains(named) == true, "\(named): \(load.metadata.corruptionDetail ?? "nil")")
        }
    }

    /// `sidebar.collapsed` is the one field the file road does not refuse: it
    /// is read as `=== true`, so anything else is the rail expanded, exactly
    /// as the TypeScript decoder reads it. (The TypeScript gap test for it
    /// mutates a state already in memory, which a typed record cannot be.)
    func testReadsACollapseThatIsNotTrueAsExpanded() async throws {
        let load = try await loadWith { $0.editing("sidebar.collapsed", "yes") }
        XCTAssertNil(load.metadata.recoveryReason)
        XCTAssertFalse(load.state.sidebar.collapsed)
    }

    /// The property: every key dropped, one at a time, from a good file —
    /// whatever the gate accepts, hydration projects.
    func testHydratesEveryRecordItAcceptsWhicheverKeyIsAbsent() throws {
        let good = try stateOf(try populatedModel()).json
        var paths: [String] = []
        for (key, _) in good.at("workspaces.0.agents.0")?.objectValue ?? [] { paths.append("workspaces.0.agents.0.\(key)") }
        for (key, _) in good.at("workspaces.0")?.objectValue ?? [] where key != "agents" { paths.append("workspaces.0.\(key)") }
        for (key, _) in good.at("sidebar")?.objectValue ?? [] { paths.append("sidebar.\(key)") }
        paths += ["split.ratio", "navigation.context"]
        var accepted = 0
        for path in paths {
            let document = good.editing(path, nil)
            guard case let .state(state, _, _) = StateDecoding.decode(Array(document.compact.utf8)) else { continue }
            accepted += 1
            XCTAssertNoThrow(try hydrate(state), path)
        }
        XCTAssertGreaterThan(accepted, 0)
    }

    func testQuarantinesAFileWhoseAgentHasNoControlState() async throws {
        let scratch = StateScratch()
        let store = scratch.store()
        let good = try stateOf(try populatedModel())
        try await store.saveState(good)
        try await store.saveState(emptied(good))
        scratch.write(good.json.editing("workspaces.0.agents.0.control_state", nil))
        let load = try await store.loadState()
        XCTAssertEqual(load.metadata.recoveryReason, .corruptPrimary)
        XCTAssertTrue(load.metadata.primaryQuarantined)
        XCTAssertTrue(load.metadata.corruptionDetail?.contains("workspaces[0].agents[0].control_state") == true)
        XCTAssertEqual(load.state, good)
    }
}
