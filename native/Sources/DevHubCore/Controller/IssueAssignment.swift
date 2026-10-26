// Port of the git half of apps/desktop/src/main/shell/appController.ts's
// Issue flow (`assignIssueFromCli` up to the folder, `gitCommand`,
// `prepareIssueFolder`, `assignmentBranch`), on WP4's pieces: the clone
// search (`IssueClones.find`, `findClones`), the branch question
// (`IssueAssignmentFlow.branch`) and the folder (`IssueAssignmentFlow.prepareFolder`).
//
// What comes after the folder — the Workspace opened, the Agent started and
// told about the Issue — is the controller's (`assignIssue` in
// AppControllerControl.swift), so a command line and the sheet open the same
// way.

import Foundation

/// `gitCommand`: the git of a machine, as the settings name it, looked up on
/// the login PATH.
public enum ControllerGit {
    /// The environment goes with the resolution. A path was looked up *here*,
    /// so this Mac's login environment is the one that found it and the one
    /// it should run in; a bare name will be looked up on the far end, and a
    /// PATH composed from this Mac names no directory over there.
    public static func command(
        runtime: any RepositoryRuntime, resolution: ProgramResolution, launchEnvironment: [String: String],
        loginFailure: String?
    ) throws -> GitCommand {
        switch resolution {
        case let .absolutePath(path):
            return GitCommand(runtime: runtime, git: path, environment: launchEnvironment)
        case let .commandName(name):
            return GitCommand(runtime: runtime, git: name, environment: [:])
        case .unavailable:
            var wire = AppError.at(.workspaceUnavailable)
            wire.summary = Runtimes.executableMissingMessage(resolution, loginFailure: loginFailure) ?? "DevHub could not find git."
            throw NamedFailure(wire)
        }
    }

    /// This Mac's git: `runtimes.git`, on the login PATH.
    public static func local(
        configured: String = ConfigConstants.defaultGit, launchEnvironment: [String: String], loginFailure: String? = nil,
        machine: any MachineRuntime = MachineRuntimes.local
    ) async throws -> GitCommand {
        let resolution = await machine.resolveProgram(configured, searchPath: launchEnvironment["PATH"] ?? "")
        return try command(
            runtime: LocalRepositoryRuntime(), resolution: resolution, launchEnvironment: launchEnvironment,
            loginFailure: loginFailure)
    }
}

/// `devhub --tell issue assign`'s folder (`IssueAssigner`): the clone found
/// (or the one given), the branch chosen, the folder made — where the
/// Workspace opens.
public struct GitIssueAssigner: IssueAssigner {
    /// The git of the machine a place is on.
    public var gitFor: @Sendable (WorkspacePlace) async throws -> GitCommand
    /// The Workspace picker's search of this machine's sources for a name.
    public var searchSources: @Sendable (String) async -> [String]
    /// The Workspaces already open, which the sources need not know about.
    public var openPlaces: @Sendable () -> [WorkspacePlace]
    /// The login environment, which `gh` is asked for the token in.
    public var environment: @Sendable () -> [String: String]
    /// The branch question (`assignmentBranch`); GitHub and git by default.
    public var branch: @Sendable (_ url: String, _ place: WorkspacePlace, _ git: GitCommand) async throws -> AssignmentBranch

    public init(
        gitFor: @escaping @Sendable (WorkspacePlace) async throws -> GitCommand,
        searchSources: @escaping @Sendable (String) async -> [String],
        openPlaces: @escaping @Sendable () -> [WorkspacePlace],
        environment: @escaping @Sendable () -> [String: String] = { ProcessInfo.processInfo.environment },
        branch: (@Sendable (String, WorkspacePlace, GitCommand) async throws -> AssignmentBranch)? = nil
    ) {
        self.gitFor = gitFor
        self.searchSources = searchSources
        self.openPlaces = openPlaces
        self.environment = environment
        self.branch = branch ?? { url, place, git in
            try await IssueAssignmentFlow.branch(url: url, place: place, environment: environment(), git: git)
        }
    }

    public func prepare(_ request: IssueAssignRequest) async throws -> RequestedWorkspaceLocation {
        guard let item = GitHubItem.parse(url: request.url) else {
            throw ControlRefusal("That is not a GitHub Issue or pull request URL.")
        }
        let clone: WorkspacePlace
        if let repo = request.repo {
            clone = .local(path: repo)
        } else {
            let found = try await IssueClones.find(
                issue: item.reference, openPlaces: openPlaces(), searchSources: searchSources, gitFor: gitFor)
            guard let first = found.first else {
                throw ControlRefusal(
                    "DevHub found no clone of \(item.owner)/\(item.repository). Clone it, or pass --repo <path>.")
            }
            clone = first.place
        }
        var branch = request.branch
        if branch == nil {
            let existing = try await self.branch(request.url, clone, try await gitFor(clone))
            branch = IssueAssignmentFlow.defaultBranch(for: item, existing: existing)
            if branch == nil {
                throw ControlRefusal("the branch of \(request.url) cannot be reached from \(clone.path).")
            }
        }
        let folder = try await IssueAssignmentFlow.prepareFolder(
            IssueFolderRequest(issueUrl: request.url, place: clone, branch: branch, inRoot: request.place == .root),
            git: try await gitFor(clone))
        return try Self.requested(folder)
    }

    /// `requestedLocation`: a place as a Workspace is asked for.
    static func requested(_ place: WorkspacePlace) throws -> RequestedWorkspaceLocation {
        switch place {
        case let .local(path): return try RequestedWorkspaceLocation.make(.local(path: path))
        case let .ssh(host, path): return try RequestedWorkspaceLocation.make(.ssh(host: host, path: path))
        }
    }
}

extension ControllerModelMirror {
    /// The open Workspaces' folders, each on its machine, for the clone search.
    public func workspacePlaces() -> [WorkspacePlace] {
        snapshotNow()?.workspaces.map { workspace in
            switch workspace.location {
            case let .ssh(host, path): return WorkspacePlace.ssh(host: host, path: path)
            case let .local(path): return WorkspacePlace.local(path: path)
            }
        } ?? []
    }
}
