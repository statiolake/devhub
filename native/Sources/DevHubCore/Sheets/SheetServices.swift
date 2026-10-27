// Port of the questions page's half of apps/desktop/src/main/shell/appController.ts
// (`registerIpc`'s picker handlers: `startWorkspacePicker`,
// `selectWorkspacePicker`, `createProject`, `cloneProject`,
// `projectDefaultDirectory`, `cloneParentDirectories`, `githubLogin`,
// `findIssueRepositories`, `cloneRepository`, `assignmentBranch`,
// `listBranches`, `prepareIssueFolder`, `assignIssue`, `listAgentSessions`,
// `previewAgentSession`, `agentActions`, `runAgentAction`,
// `confirmInjection`, `cancelInjection`), and of `PickerContext.tsx`'s
// `PickerValue`: what the sheets ask DevHub for.
//
// Every way of starting a Workspace ends the same way — `openFolder` — so a
// picker row, a new project, a clone and an assigned Issue all open the same
// way the command line does.

import Foundation

/// An Agent to start with the Workspace being opened (`AgentLaunchWire`).
public struct AgentLaunch: Equatable, Sendable {
    public var profileId: String
    public var presentation: AgentPresentation

    public init(profileId: String, presentation: AgentPresentation) {
        self.profileId = profileId
        self.presentation = presentation
    }
}

/// One profile as a sheet offers it (`AgentProfileWire`).
public struct SheetProfile: Equatable, Sendable {
    public var id: String
    public var displayName: String
    public var kind: AgentProfileKind
    /// How Return launches it.
    public var presentation: AgentPresentation
    /// Every presentation it has.
    public var presentations: [AgentPresentation]

    public init(id: String, displayName: String, kind: AgentProfileKind, presentation: AgentPresentation, presentations: [AgentPresentation]) {
        self.id = id
        self.displayName = displayName
        self.kind = kind
        self.presentation = presentation
        self.presentations = presentations
    }

    /// What a launch of this profile is: its default, or with Command held,
    /// the other presentation it has — and still its default when it has none.
    public func launchPresentation(alternate: Bool) -> AgentPresentation {
        guard alternate else { return presentation }
        return presentations.first { $0 != presentation } ?? presentation
    }
}

/// The agent profiles, and how far they can be trusted (`AgentProfiles`).
public struct SheetProfiles: Equatable, Sendable {
    public enum Availability: String, Sendable { case ready, degraded, unavailable }
    public var profiles: [SheetProfile]
    public var availability: Availability

    public init(profiles: [SheetProfile], availability: Availability) {
        self.profiles = profiles
        self.availability = availability
    }

    public static func of(_ config: Config?, degraded: Bool = false) -> SheetProfiles {
        guard let config else { return SheetProfiles(profiles: [], availability: .unavailable) }
        return SheetProfiles(
            profiles: config.agentProfiles.map { profile in
                SheetProfile(
                    id: profile.id, displayName: profile.displayName, kind: profile.kind,
                    presentation: profilePresentation(profile, agents: config.agents), presentations: profile.kind.presentations)
            },
            availability: degraded ? .degraded : .ready)
    }
}

/// The Issue sheet's last answer (`IssueAssignment`): the folder, and the
/// Agent chosen for it — or no Agent at all.
public struct SheetIssueAssignment: Equatable, Sendable {
    public var issueUrl: String
    public var place: WorkspacePlace
    public var editorOnly: Bool
    public var profileId: String?
    public var actionId: String?
    public var split: Bool
    public var presentation: AgentPresentation?
    public var resume: String?

    public init(
        issueUrl: String, place: WorkspacePlace, editorOnly: Bool = false, profileId: String? = nil, actionId: String? = nil,
        split: Bool = false, presentation: AgentPresentation? = nil, resume: String? = nil
    ) {
        self.issueUrl = issueUrl
        self.place = place
        self.editorOnly = editorOnly
        self.profileId = profileId
        self.actionId = actionId
        self.split = split
        self.presentation = presentation
        self.resume = resume
    }
}

/// What every sheet asks DevHub for. The window's questions layer is handed
/// one; a test hands it its own.
public protocol SheetServices: AnyObject, Sendable {
    func profiles() async -> SheetProfiles
    func config() async -> Config?
    func snapshot() async -> AppSnapshotWire?

    // The workspace picker.
    func searchWorkspaces(_ query: String, emit: @escaping @Sendable (WorkspacePickerEvent) -> Void) async
    func openPicked(_ path: String, create: Bool, withAgent: AgentLaunch?) async throws
    func createProject(_ path: String, withAgent: AgentLaunch?) async throws
    func cloneProject(url: String, parentDirectory: String, withAgent: AgentLaunch?) async throws
    func projectDefaultDirectory() async -> String
    func cloneParentDirectories() async throws -> [String]
    func githubLogin() async -> GitHubLogin

    // The Issue flow.
    func findIssueRepositories(_ url: String) async throws -> [RepositoryCandidate]
    func cloneRepository(url: String, parentDirectory: String) async throws -> String
    func assignmentBranch(url: String, place: WorkspacePlace) async throws -> AssignmentBranch
    func prepareIssueFolder(_ request: IssueFolderRequest) async throws -> WorkspacePlace
    func assignIssue(_ request: SheetIssueAssignment) async throws

    // The agent picker.
    func listAgentSessions(place: WorkspacePlace, profileId: String) async throws -> [PastSession]
    func previewAgentSession(place: WorkspacePlace, profileId: String, session: String, cwd: String) async throws -> [PreviewLine]
    func createAgent(workspaceId: String, profileId: String, split: Bool, presentation: AgentPresentation?, resume: String?) async

    // Agent actions and the review sheet.
    func agentActions() async -> [ConfiguredAgentAction]
    func runAgentAction(agentId: String, actionId: String) async throws
    func confirmInjection(agentId: String, injectionId: String, text: String) async throws
    func cancelInjection(agentId: String, injectionId: String) async

    // Plain intents (rename, select).
    func dispatch(_ intent: AppIntentWire) async -> Bool
}

/// The services, on the running controller.
public final class ControllerSheetServices: SheetServices, @unchecked Sendable {
    public let controller: AppController
    private let home: String
    private let environment: @Sendable () -> [String: String]
    private let gitFor: @Sendable (WorkspacePlace) async throws -> GitCommand
    /// The one lookup that is running (an abandoned one is cancelled).
    private let lookup = Guarded<Task<Void, Never>?>(nil)

    public init(
        controller: AppController, home: String = NSHomeDirectory(), environment: @escaping @Sendable () -> [String: String],
        gitFor: @escaping @Sendable (WorkspacePlace) async throws -> GitCommand
    ) {
        self.controller = controller
        self.home = home
        self.environment = environment
        self.gitFor = gitFor
    }

    public func profiles() async -> SheetProfiles { SheetProfiles.of(await controller.config) }

    public func config() async -> Config? { await controller.config }

    public func snapshot() async -> AppSnapshotWire? { try? await controller.snapshotWire() }

    private func requiredConfig() async throws -> Config {
        guard let config = await controller.config else { throw NamedFailure.at(.settingsRefused) }
        return config
    }

    public func searchWorkspaces(_ query: String, emit: @escaping @Sendable (WorkspacePickerEvent) -> Void) async {
        guard let config = await controller.config else {
            emit(.started(sourceCount: 0))
            emit(.completed(candidateCount: 0, errorCount: 0, truncated: false))
            return
        }
        await WorkspacePickerSearch.run(config, query: query, home: home, environment: environment(), emit: emit)
    }

    public func openPicked(_ path: String, create: Bool, withAgent: AgentLaunch?) async throws {
        do {
            let target = create ? try Projects.ensureWorkspaceFolder(path, home: home) : path
            try await controller.openPlace(.local(path: target), withAgent: withAgent)
        } catch {
            throw namedFailure(error)
        }
    }

    public func createProject(_ path: String, withAgent: AgentLaunch?) async throws {
        let target = try Projects.createProject(path, home: home)
        try await controller.openPlace(.local(path: target), withAgent: withAgent)
    }

    public func cloneProject(url: String, parentDirectory: String, withAgent: AgentLaunch?) async throws {
        let target = try await cloneRepository(url: url, parentDirectory: parentDirectory)
        try await controller.openPlace(.local(path: target), withAgent: withAgent)
    }

    public func projectDefaultDirectory() async -> String {
        Projects.defaultProjectDirectory(await controller.config, home: home)
    }

    public func cloneParentDirectories() async throws -> [String] {
        let config = await controller.config
        let derived = config == nil
            ? [] : try await WorkspacePickerSearch.parentDirectories(config!, home: home, environment: environment())
        return Projects.cloneParentChoices(config, derived: derived, home: home)
    }

    public func githubLogin() async -> GitHubLogin {
        switch await GitHubCLI.readLogin(environment: environment()) {
        case let .login(login): return .known(login)
        case let .unknown(reason): return .unknown(reason: reason)
        }
    }

    public func findIssueRepositories(_ url: String) async throws -> [RepositoryCandidate] {
        guard await controller.config != nil, let item = GitHubItem.parse(url: url) else {
            throw CodedFailure.workspace("That is not a GitHub Issue or pull request URL.")
        }
        let config = try await requiredConfig()
        let home = self.home
        let environment = self.environment()
        let places = controller.mirror.workspacePlaces()
        return try await IssueClones.find(
            issue: item.reference, openPlaces: places,
            searchSources: { query in
                let collected = Guarded<[String]>([])
                await WorkspacePickerSearch.run(config, query: query, home: home, environment: environment) { event in
                    if case let .candidate(candidate) = event { collected.with { $0.append(candidate.path) } }
                }
                return collected.with { $0 }
            },
            gitFor: gitFor)
    }

    public func cloneRepository(url: String, parentDirectory: String) async throws -> String {
        try await Projects.cloneProject(
            url: url, parentDirectory: parentDirectory, command: try await gitFor(.local(path: parentDirectory)), home: home)
    }

    public func assignmentBranch(url: String, place: WorkspacePlace) async throws -> AssignmentBranch {
        try await IssueAssignmentFlow.branch(url: url, place: place, environment: environment(), git: try await gitFor(place))
    }

    public func prepareIssueFolder(_ request: IssueFolderRequest) async throws -> WorkspacePlace {
        try await IssueAssignmentFlow.prepareFolder(request, git: try await gitFor(request.place))
    }

    public func assignIssue(_ request: SheetIssueAssignment) async throws {
        try await controller.assignIssueFromSheet(request)
    }

    public func listAgentSessions(place: WorkspacePlace, profileId: String) async throws -> [PastSession] {
        let (runtime, profile) = try await controller.sessionsProfile(place, profileId)
        return try await listPastSessions(runtime, profile, root: place.path)
    }

    public func previewAgentSession(place: WorkspacePlace, profileId: String, session: String, cwd: String) async throws
        -> [PreviewLine]
    {
        let (runtime, profile) = try await controller.sessionsProfile(place, profileId)
        return try await previewPastSession(runtime, profile, id: session, cwd: cwd)
    }

    public func createAgent(workspaceId: String, profileId: String, split: Bool, presentation: AgentPresentation?, resume: String?) async {
        await controller.dispatchFromWindow(AppIntentWire.requestCreateAgent(
            workspaceId: workspaceId, profileId: profileId, split: split, presentation: presentation?.rawValue, resume: resume))
    }

    public func agentActions() async -> [ConfiguredAgentAction] {
        guard let config = await controller.config else { return [] }
        return config.agentActions.filter(\.enabled)
    }

    public func runAgentAction(agentId: String, actionId: String) async throws {
        try await controller.runAgentAction(agentId: agentId, actionId: actionId)
    }

    public func confirmInjection(agentId: String, injectionId: String, text: String) async throws {
        _ = try await controller.confirmInjection(agentId: agentId, injectionId: injectionId, text: text)
    }

    public func cancelInjection(agentId: String, injectionId: String) async {
        _ = await controller.cancelInjection(agentId: agentId, injectionId: injectionId)
    }

    public func dispatch(_ intent: AppIntentWire) async -> Bool {
        await controller.dispatchFromWindow(intent) != nil
    }
}

extension AppController {
    /// `openFolder(requestedLocation(place), withAgent)`.
    func openPlace(_ place: WorkspacePlace, withAgent: AgentLaunch?) async throws {
        _ = try await openFolder(try GitIssueAssigner.requested(place), withAgent: withAgent.map { ($0.profileId, $0.presentation) })
    }

    /// `sessionsProfile`: the profile as a launch in `place` would run it, and
    /// the machine its sessions are read on.
    func sessionsProfile(_ place: WorkspacePlace, _ profileId: String) async throws -> (any MachineRuntime, SessionProfile) {
        let location: WorkspaceLocation
        switch place {
        case let .local(path): location = try WorkspaceLocation.make(.local(path: path))
        case let .ssh(host, path): location = try WorkspaceLocation.make(.ssh(host: host, path: path))
        }
        switch await profileOn(location, profileId, [], nil) {
        case let .failed(code, detail):
            throw NamedFailure(AppError.at(AppErrorCode(rawValue: code.rawValue) ?? .agentProfileUnavailable).withDetail(detail))
        case let .resolved(profile):
            guard profile.kind == .claude || profile.kind == .codex else { throw NoSessionsForKind(kind: profile.kind, what: "list") }
            let runtime = try MachineRuntimes.runtime(for: try RuntimeId.parse(location.runtimeId))
            let kind: SessionCLIKind = profile.kind == .claude ? .claude : .codex
            return (runtime, SessionProfile(
                kind: kind, command: profile.command, args: profile.args,
                env: Dictionary(profile.env.map { ($0.key, $0.value) }, uniquingKeysWith: { _, last in last })))
        }
    }

    /// `assignIssue`: open the Issue's folder, start the Agent chosen for it
    /// there, and tell it about the Issue — one act, because it is what
    /// choosing the Agent means.
    func assignIssueFromSheet(_ request: SheetIssueAssignment) async throws {
        guard let item = GitHubItem.parse(url: request.issueUrl) else {
            throw CodedFailure.workspace("That is not a GitHub Issue or pull request URL.")
        }
        let opening = try GitIssueAssigner.requested(request.place)
        if request.editorOnly {
            _ = try await openFolder(opening)
            return
        }
        guard let profileId = request.profileId else { throw InvariantViolation("an Issue's Agent was chosen with no profile") }
        _ = try await openFolder(opening)
        let workspaceId = try openedWorkspaceId(opening.path)
        let before = modelAgentIds()
        _ = try await dispatchAwaiting(.createAgent(
            workspaceId: workspaceId, profileId: profileId, presentation: request.split ? .beside : .full,
            agentPresentation: request.presentation, resume: request.resume))
        queueIssuePrompt(before: before, issueUrl: request.issueUrl, number: item.number, actionId: request.actionId)
        placeKeyboardOnSurface()
    }
}
