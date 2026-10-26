// Port of apps/desktop/src/model/domain.ts
//
// Pure DevHub domain values and lifecycle rules.
//
// A port of `crates/devhub-app-core/src/domain.rs` (by way of the TypeScript
// app). It has no AppKit, no filesystem and no process dependency: adapters
// hand validated values across this seam, and identity, ownership and
// lifecycle invariants live here.
//
// The TypeScript app's branded strings become small wrapper structs. The
// brand is what makes a `WorkspaceId` refuse to be an `AgentId` at compile
// time; the runtime value stays a plain string, so it is still a dictionary
// key and still serialises to `state.json` without a conversion step.
//
// TypeScript's mutable classes (`Agent`, `Workspace`) are value types here:
// their mutating methods answer whether anything changed, exactly as the TS
// methods' booleans do, and copying one is the TS `clone()`.

import Foundation

// MARK: - Errors

public enum DomainErrorCode: String, Sendable, Equatable, CaseIterable {
    case invalidId = "INVALID_ID"
    case invalidPath = "INVALID_PATH"
    case invalidHost = "INVALID_HOST"
    case invalidRemote = "INVALID_REMOTE"
    case invalidDisplayName = "INVALID_DISPLAY_NAME"
    case invalidOrdinal = "INVALID_ORDINAL"
    case ordinalExhausted = "ORDINAL_EXHAUSTED"
    case invalidBusyCount = "INVALID_BUSY_COUNT"
    case duplicateWorkspace = "DUPLICATE_WORKSPACE"
    case duplicateWorkspaceRoot = "DUPLICATE_WORKSPACE_ROOT"
    case duplicateAgent = "DUPLICATE_AGENT"
    case unknownRepository = "UNKNOWN_REPOSITORY"
    case repositoryIdentityConflict = "REPOSITORY_IDENTITY_CONFLICT"
    case repositoryRemoteConflict = "REPOSITORY_REMOTE_CONFLICT"
    case unknownWorkspace = "UNKNOWN_WORKSPACE"
    case unknownAgent = "UNKNOWN_AGENT"
    case workspaceUnavailable = "WORKSPACE_UNAVAILABLE"
    case workspaceNotClean = "WORKSPACE_NOT_CLEAN"
    case scratchCannotClose = "SCRATCH_CANNOT_CLOSE"
    case invalidProfile = "INVALID_PROFILE"
    case agentWorkspaceMismatch = "AGENT_WORKSPACE_MISMATCH"
    case workspaceNotUnavailable = "WORKSPACE_NOT_UNAVAILABLE"
    case invalidAgentControlTransition = "INVALID_AGENT_CONTROL_TRANSITION"
    case workspaceHasLiveAgents = "WORKSPACE_HAS_LIVE_AGENTS"
    case workspaceClosing = "WORKSPACE_CLOSING"
    case workspaceClosingFailed = "WORKSPACE_CLOSING_FAILED"
    case invalidSidebarWidth = "INVALID_SIDEBAR_WIDTH"
    case invalidSplitRatio = "INVALID_SPLIT_RATIO"
    case invalidTerminalZoom = "INVALID_TERMINAL_ZOOM"
    case invalidSmartButtonsOffset = "INVALID_SMART_BUTTONS_OFFSET"
    case invalidEditorAttachment = "INVALID_EDITOR_ATTACHMENT"
}

/// A domain operation failure. The code is stable; no provider or user content
/// is ever stored on it.
public struct DomainError: Error, Equatable, Sendable, CustomStringConvertible {
    public let code: DomainErrorCode
    public init(_ code: DomainErrorCode) { self.code = code }
    public var description: String { code.rawValue }
}

@inline(__always)
func domainFail(_ code: DomainErrorCode) -> DomainError { DomainError(code) }

// MARK: - Identities

public enum DomainIds {
    /// `isCanonicalUuid`: 36 characters, lowercase hex, dashes at 8/13/18/23.
    public static func isCanonicalUuid(_ raw: String) -> Bool {
        let scalars = Array(raw.unicodeScalars)
        guard scalars.count == 36 else { return false }
        for (index, scalar) in scalars.enumerated() {
            if index == 8 || index == 13 || index == 18 || index == 23 {
                if scalar != "-" { return false }
            } else {
                switch scalar {
                case "0"..."9", "a"..."f": continue
                default: return false
                }
            }
        }
        return true
    }

    /// `isSlug`: `^[a-z][a-z0-9_-]{0,63}$`.
    public static func isSlug(_ raw: String) -> Bool {
        let scalars = Array(raw.unicodeScalars)
        guard (1...64).contains(scalars.count) else { return false }
        guard ("a"..."z").contains(scalars[0]) else { return false }
        return scalars.dropFirst().allSatisfy { scalar in
            ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) || scalar == "_" || scalar == "-"
        }
    }

    /// `agentProfileId`: a validated configuration identifier, distinct from
    /// a runtime UUID.
    public static func agentProfileId(_ raw: String) throws -> String {
        guard isSlug(raw) else { throw domainFail(.invalidId) }
        return raw
    }

    /// `sessionId`: an earlier session of an Agent's CLI, by the id the CLI
    /// gave it. It goes onto a command line as one argument of its own, so one
    /// that could read as an option or carry a NUL is refused here.
    public static func sessionId(_ raw: String) throws -> String {
        let scalars = Array(raw.unicodeScalars)
        guard (1...128).contains(scalars.count) else { throw domainFail(.invalidId) }
        func alnum(_ s: Unicode.Scalar) -> Bool {
            ("A"..."Z").contains(s) || ("a"..."z").contains(s) || ("0"..."9").contains(s)
        }
        guard alnum(scalars[0]) else { throw domainFail(.invalidId) }
        for scalar in scalars.dropFirst() where !(alnum(scalar) || scalar == "." || scalar == "_" || scalar == "-") {
            throw domainFail(.invalidId)
        }
        return raw
    }
}

/// A canonical-UUID identity, branded by `Kind`.
public protocol UuidIdentity: Hashable, Comparable, Sendable, CustomStringConvertible {
    var rawValue: String { get }
    init(unchecked rawValue: String)
}

extension UuidIdentity {
    public init(_ raw: String) throws {
        guard DomainIds.isCanonicalUuid(raw) else { throw domainFail(.invalidId) }
        self.init(unchecked: raw)
    }

    public var description: String { rawValue }
    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

public struct WorkspaceId: UuidIdentity {
    public let rawValue: String
    public init(unchecked rawValue: String) { self.rawValue = rawValue }
}

public struct AgentId: UuidIdentity {
    public let rawValue: String
    public init(unchecked rawValue: String) { self.rawValue = rawValue }
}

public struct RepositoryId: UuidIdentity {
    public let rawValue: String
    public init(unchecked rawValue: String) { self.rawValue = rawValue }
}

// MARK: - Paths

public enum DomainPaths {
    /// Lexical normalisation, exactly as the Rust did it: `.` drops out, `..`
    /// pops, and a `..` that would escape the root is rejected rather than
    /// clamped.
    public static func normalizeAbsolutePath(_ path: String) throws -> String {
        if path.isEmpty || path.contains("\0") || !path.hasPrefix("/") {
            throw domainFail(.invalidPath)
        }
        var parts: [Substring] = []
        for component in path.split(separator: "/", omittingEmptySubsequences: false) {
            if component.isEmpty || component == "." { continue }
            if component == ".." {
                if parts.popLast() == nil { throw domainFail(.invalidPath) }
                continue
            }
            parts.append(component)
        }
        return "/" + parts.joined(separator: "/")
    }

    /// Canonical Workspace Root: the duplicate-prevention key.
    public static func workspaceRoot(_ path: String) throws -> String { try normalizeAbsolutePath(path) }

    /// A path the user picked, expanded and canonicalised by the adapter first.
    public static func displayPath(_ path: String) throws -> String { try normalizeAbsolutePath(path) }

    public static func rootBasename(_ root: String) -> String {
        let name = root.split(separator: "/").last.map(String.init)
        if let name, !name.isEmpty { return name }
        return "/"
    }

    /// Parent directory names, nearest first — the disambiguation source.
    public static func rootParentComponents(_ root: String) -> [String] {
        Array(root.split(separator: "/").map(String.init).dropLast().reversed())
    }

    /// A path as a person writes it: under their home directory, `~`.
    ///
    /// It is a rendering and never an identity. Which home is the whole reason
    /// this takes one rather than reading it: a Workspace on another machine
    /// has its folder under *that* machine's home. `/` is not a home.
    public static func abbreviateHome(_ path: String, home: String?) -> String {
        guard let home, home != "/", home.hasPrefix("/") else { return path }
        let trimmed = home.hasSuffix("/") ? String(home.dropLast()) : home
        if path == trimmed { return "~" }
        return path.hasPrefix(trimmed + "/") ? "~" + path.dropFirst(trimmed.count) : path
    }
}

// MARK: - Locations

public enum DomainHosts {
    /// `sshHost`: either a `Host` alias out of `~/.ssh/config` or
    /// `user@hostname`, optionally with `:port`. What is rejected is only
    /// what cannot survive being a URI authority.
    public static func sshHost(_ raw: String) throws -> String {
        let trimmed = raw.jsTrimmed
        let pattern = TextPattern("^[A-Za-z0-9._~%-]+(?:@[A-Za-z0-9._~%\\[\\]-]+)?(?::[0-9]+)?$")
        guard pattern.matches(trimmed) else { throw domainFail(.invalidHost) }
        return trimmed
    }
}

/// Where a Workspace's folder is: on this machine or on an SSH host. Identity
/// is `key`, not the path.
public enum WorkspaceLocation: Hashable, Sendable {
    case local(path: String)
    case ssh(host: String, path: String)

    public var path: String {
        switch self {
        case let .local(path): return path
        case let .ssh(_, path): return path
        }
    }

    public var isLocal: Bool { if case .local = self { return true } else { return false } }

    /// `locationKey`: a local folder's key is its canonical path, unchanged.
    public var key: String {
        switch self {
        case let .local(path): return path
        case let .ssh(host, path): return "ssh://\(host)\(path)"
        }
    }

    /// `locationLabel`: `host:path` rather than the key's `ssh://host/path`.
    public var label: String {
        switch self {
        case let .local(path): return path
        case let .ssh(host, path): return "\(host):\(path)"
        }
    }

    /// `remoteAuthorityOf`.
    public var remoteAuthority: String? {
        switch self {
        case .local: return nil
        case let .ssh(host, _): return "ssh-remote+\(host)"
        }
    }

    /// `RuntimeId`: `local`, or `ssh:<host>`.
    public var runtimeId: String {
        switch self {
        case .local: return "local"
        case let .ssh(host, _): return "ssh:\(host)"
        }
    }

    /// `workspaceLocation`: the one way a location is made.
    public static func make(_ requested: RequestedLocation) throws -> WorkspaceLocation {
        switch requested {
        case let .local(path): return .local(path: try DomainPaths.workspaceRoot(path))
        case let .ssh(host, path):
            return .ssh(host: try DomainHosts.sshHost(host), path: try DomainPaths.workspaceRoot(path))
        }
    }

    /// `relocatedOnSameMachine`: the same machine, a different folder on it.
    public func relocated(to path: String) -> RequestedLocation {
        switch self {
        case .local: return .local(path: path)
        case let .ssh(host, _): return .ssh(host: host, path: path)
        }
    }
}

/// What a caller says about a place, before any of it has been validated.
public enum RequestedLocation: Hashable, Sendable {
    case local(path: String)
    case ssh(host: String, path: String)
}

public enum DevContainerConfig {
    /// `devContainerConfigPath`: absolute and normalised like a root.
    public static func path(_ path: String) throws -> String { try DomainPaths.normalizeAbsolutePath(path) }

    /// `devContainerConfigLabel`: what to call a definition beside its
    /// folder's name, or nothing when it is the folder's default one.
    public static func label(folder: String, configPath: String) -> String? {
        guard configPath.hasPrefix(folder + "/") else { return configPath }
        let inside = String(configPath.dropFirst(folder.count + 1))
        if inside == ".devcontainer/devcontainer.json" || inside == ".devcontainer.json" { return nil }
        if let match = TextPattern("^\\.devcontainer/([^/]+)/devcontainer\\.json$").firstMatch(in: inside), let name = match[1] {
            return name
        }
        return inside
    }
}

/// Where a Workspace's editor is attached: the Workspace's own machine, or a
/// Dev Container made from one of its definitions.
public enum EditorAttachment: Hashable, Sendable {
    case host
    case devContainer(configPath: String)

    public static let onHost: EditorAttachment = .host

    public var isHost: Bool { self == .host }
}

/// A dev container, as DevHub addresses one.
public struct ContainerTarget: Hashable, Sendable {
    public var location: WorkspaceLocation
    public var configPath: String

    public init(location: WorkspaceLocation, configPath: String) {
        self.location = location
        self.configPath = configPath
    }

    /// `containerTargetOf`.
    public static func of(_ location: WorkspaceLocation, _ editor: EditorAttachment) -> ContainerTarget? {
        if case let .devContainer(configPath) = editor { return ContainerTarget(location: location, configPath: configPath) }
        return nil
    }

    /// `containerHostId`.
    public var hostId: String { "container:\(encodedAuthority)" }

    /// `containerTargetFromHostId`.
    public static func fromHostId(_ raw: String) -> ContainerTarget? {
        guard raw.hasPrefix("container:") else { return nil }
        return decodeAuthority(String(raw.dropFirst("container:".count)))
    }

    /// `encodeContainerAuthority`: hex of JSON (`hostPath`, `configPath`,
    /// `sshHost` when the folder is on a host).
    public var encodedAuthority: String {
        var pairs: [(key: String, value: WireJSON)] = [
            ("hostPath", .string(location.path)),
            ("configPath", .string(configPath)),
        ]
        if case let .ssh(host, _) = location { pairs.append(("sshHost", .string(host))) }
        let json = WireJSON.object(pairs).compact
        return json.utf8.map { byte in
            let hex = String(byte, radix: 16)
            return hex.count == 1 ? "0" + hex : hex
        }.joined()
    }

    /// `decodeContainerAuthority`: the inverse, or nil for a payload this
    /// DevHub did not write.
    public static func decodeAuthority(_ payload: String) -> ContainerTarget? {
        let scalars = Array(payload.unicodeScalars)
        guard !scalars.isEmpty, scalars.count % 2 == 0 else { return nil }
        var bytes: [UInt8] = []
        bytes.reserveCapacity(scalars.count / 2)
        var index = 0
        while index < scalars.count {
            guard let byte = UInt8(String(scalars[index]) + String(scalars[index + 1]), radix: 16) else { return nil }
            bytes.append(byte)
            index += 2
        }
        guard let text = String(bytes: bytes, encoding: .utf8), let parsed = try? WireJSON.parse(text), parsed.isObject else {
            return nil
        }
        guard let hostPath = parsed["hostPath"]?.stringValue, let config = parsed["configPath"]?.stringValue else { return nil }
        let hostValue = parsed["sshHost"]
        if let hostValue, hostValue.stringValue == nil { return nil }
        let requested: RequestedLocation = hostValue?.stringValue.map { .ssh(host: $0, path: hostPath) } ?? .local(path: hostPath)
        guard let location = try? WorkspaceLocation.make(requested), let configPath = try? DevContainerConfig.path(config) else {
            return nil
        }
        return ContainerTarget(location: location, configPath: configPath)
    }
}

/// `DEV_CONTAINER_PREFIX`.
public let devContainerAuthorityPrefix = "dev-container+"

/// `editorAuthorityOf`.
public func editorAuthority(_ location: WorkspaceLocation, _ editor: EditorAttachment) -> String? {
    guard let target = ContainerTarget.of(location, editor) else { return location.remoteAuthority }
    return devContainerAuthorityPrefix + target.encodedAuthority
}

// MARK: - Repositories

/// A Git remote identity and its normalised aliases.
public struct Repository: Equatable, Sendable {
    public let id: RepositoryId
    public let primaryRemote: RemoteIdentity
    public let aliases: [RemoteIdentity]

    public init(id: RepositoryId, primaryRemote: RemoteIdentity, aliases: [RemoteIdentity] = []) {
        self.id = id
        self.primaryRemote = primaryRemote
        self.aliases = Array(Set([primaryRemote] + aliases)).sorted()
    }

    public func matchesRemote(_ remote: RemoteIdentity) -> Bool { aliases.contains(remote) }
}

// MARK: - Profiles and presentations

extension AgentPresentation {
    /// `agentPresentation`: a presentation named by something outside the model.
    public static func parse(_ raw: String) throws -> AgentPresentation {
        guard let value = AgentPresentation(rawValue: raw) else { throw domainFail(.invalidProfile) }
        return value
    }
}

public enum DomainNames {
    public static func validDisplayName(_ value: String) -> Bool {
        !value.jsTrimmed.isEmpty && !value.contains("\0")
    }

    /// `isEnvironmentName`: `^[A-Za-z_][A-Za-z0-9_]*$`.
    public static func isEnvironmentName(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars)
        guard let first = scalars.first else { return false }
        func letter(_ s: Unicode.Scalar) -> Bool { ("A"..."Z").contains(s) || ("a"..."z").contains(s) || s == "_" }
        guard letter(first) else { return false }
        return scalars.dropFirst().allSatisfy { letter($0) || ("0"..."9").contains($0) }
    }
}

/// A user-configured profile snapshot. An Agent keeps a copy at launch so
/// later profile edits do not mutate an already-running session.
///
/// `args` and `env` can carry credentials, so nothing here has a description
/// that would print them.
public struct AgentProfile: Equatable, Sendable {
    public let id: String
    public let displayName: String
    public let kind: AgentProfileKind
    /// The program to run. `kind` only says whose screen it is.
    public let command: String
    public let args: [String]
    /// Sorted by key.
    public let env: OrderedStringMap
    /// How an Agent from this profile is shown unless its launch says otherwise.
    public let presentation: AgentPresentation

    private init(
        id: String, displayName: String, kind: AgentProfileKind, command: String, args: [String],
        env: OrderedStringMap, presentation: AgentPresentation
    ) {
        self.id = id
        self.displayName = displayName
        self.kind = kind
        self.command = command
        self.args = args
        self.env = env
        self.presentation = presentation
    }

    public static func create(
        id: String, displayName: String, kind: AgentProfileKind, command: String,
        args: [String] = [], env: [(String, String)] = [], presentation: AgentPresentation = .tui
    ) throws -> AgentProfile {
        guard DomainIds.isSlug(id) else { throw domainFail(.invalidId) }
        guard DomainNames.validDisplayName(displayName) else { throw domainFail(.invalidDisplayName) }
        if command.jsTrimmed.isEmpty || command.contains("\0") { throw domainFail(.invalidProfile) }
        guard kind.presentations.contains(presentation) else { throw domainFail(.invalidProfile) }
        if args.contains(where: { $0.contains("\0") })
            || env.contains(where: { $0.0.isEmpty || $0.0.contains("\0") || $0.1.contains("\0") }) {
            throw domainFail(.invalidProfile)
        }
        var seen: [String: String] = [:]
        for (key, value) in env { seen[key] = value }
        let sorted = seen.keys.sorted(by: jsStringLess).map { ($0, seen[$0]!) }
        return AgentProfile(
            id: id, displayName: displayName, kind: kind, command: command, args: args,
            env: OrderedStringMap(sorted), presentation: presentation
        )
    }

    public static func == (lhs: AgentProfile, rhs: AgentProfile) -> Bool {
        lhs.id == rhs.id && lhs.displayName == rhs.displayName && lhs.kind == rhs.kind
            && lhs.command == rhs.command && lhs.presentation == rhs.presentation
            && lhs.args == rhs.args && lhs.env == rhs.env
    }
}

// MARK: - Status

/// What an Agent is doing. `unknown` is the permanent answer for an Agent
/// whose screen DevHub has no detector for, and what every Agent reports until
/// a detector for its kind says otherwise. `background` is an Agent whose turn
/// is over while something it set going still works apart from it.
public enum AgentStatus: String, Sendable, Hashable, CaseIterable, Codable {
    case working, background, waiting, idle, error, unknown

    /// `agentIsIdle`: the part of `interruptsNothing` a screen can tell.
    public var isIdle: Bool { self == .idle }

    /// `agentAtPrompt`: idle, or `background`.
    public var atPrompt: Bool { self == .idle || self == .background }

    public init(_ status: TerminalAgentStatus) { self = AgentStatus(rawValue: status.rawValue)! }
    public init(_ status: ConversationAgentStatus) { self = AgentStatus(rawValue: status.rawValue)! }

    public var conversationStatus: ConversationAgentStatus { ConversationAgentStatus(rawValue: rawValue)! }
}

/// Why an Agent is owed a look, expressed as the status that earned it.
public typealias UnreadReason = AgentStatus

/// Why an operation on one Agent was refused (`AGENT_FAILURE_CODES`).
public enum AgentFailureCode: String, Sendable, Hashable, CaseIterable, Codable {
    /// tmux itself cannot be reached — the binary, or the socket.
    case agentRuntimeUnavailable = "agent_runtime_unavailable"
    /// tmux ran DevHub's command and refused it.
    case tmuxCommandFailed = "tmux_command_failed"
    /// tmux did not answer DevHub's command inside its bound.
    case tmuxCommandTimedOut = "tmux_command_timed_out"
    /// The session this Agent needs is not the session that is there.
    case tmuxSessionConflict = "tmux_session_conflict"
    /// The profile this Agent would start from is not usable.
    case agentProfileUnavailable = "agent_profile_unavailable"
    /// The Workspace this Agent belongs to is not open any more.
    case workspaceUnavailable = "workspace_unavailable"
    /// A GUI Agent's host cannot be read.
    case conversationHostLost = "conversation_host_lost"
    /// A GUI Agent's CLI printed something DevHub knows in a shape it does not.
    case conversationProtocolMismatch = "conversation_protocol_mismatch"
    /// A GUI Agent's CLI is not signed in.
    case conversationNotSignedIn = "conversation_not_signed_in"
    /// A GUI Agent's CLI refused to start.
    case conversationRefused = "conversation_refused"
    /// DevHub could not follow a GUI Agent's conversation for a reason of its own.
    case conversationFailed = "conversation_failed"
}

/// The last refusal this Agent is still showing, and the tool's own words.
public struct AgentFailure: Hashable, Sendable {
    public var code: AgentFailureCode
    public var detail: String?

    public init(code: AgentFailureCode, detail: String? = nil) {
        self.code = code
        self.detail = detail
    }
}

public enum AgentRules {
    /// `cliStoppedItself`: a GUI Agent's failure that is its CLI's own word
    /// that it stopped.
    public static func cliStoppedItself(_ failure: AgentFailure?) -> Bool {
        failure?.code == .conversationNotSignedIn || failure?.code == .conversationRefused
    }

    /// `interruptsNothing`: whether stopping this Agent would interrupt
    /// nothing. **One predicate, and this is it.** Only `idle` counts — and
    /// a GUI Agent's conversation its CLI stopped itself.
    public static func interruptsNothing(status: AgentStatus, failure: AgentFailure?) -> Bool {
        status.isIdle || cliStoppedItself(failure)
    }

    /// `agentContinuation`: which way an Agent can be carried on in its other
    /// presentation, if it can.
    public static func continuation(
        presentation: AgentPresentation, profileKind: AgentProfileKind,
        controlState: AgentControlState, failure: AgentFailure?
    ) -> AgentPresentation? {
        if failure != nil || controlState != .running || (profileKind != .claude && profileKind != .codex) {
            return nil
        }
        return presentation == .gui ? .tui : .gui
    }

    /// `agentRestart`: what Restart Session is for this Agent. **The one
    /// place that decides it.**
    public static func restart(
        displayName: String, presentation: AgentPresentation, profileKind: AgentProfileKind, failure: AgentFailure?
    ) -> AgentRestart {
        if presentation != .gui && profileKind != .claude && profileKind != .codex {
            return .refused(why: "“\(displayName)” runs a \(profileKind.rawValue) CLI, which has no session DevHub can resume, so there is no session to restart.")
        }
        switch failure?.code {
        case .conversationHostLost:
            return .refused(why: "DevHub cannot reach the host of “\(displayName)” now, and the host is what starts its CLI again. DevHub attaches again every round; restart it once it is back.")
        case .conversationProtocolMismatch:
            return .refused(why: "DevHub stopped reading the conversation of “\(displayName)” at a line it could not read, and would stop there again after a restart. Continue it in a terminal instead.")
        case .conversationFailed:
            return .refused(why: "DevHub stopped following the conversation of “\(displayName)” on a failure of its own, so it could not follow a CLI started again. Continue it in a terminal instead.")
        default:
            return .available
        }
    }
}

public enum AgentRestart: Equatable, Sendable {
    case available
    case refused(why: String)
}

extension AgentRuntimeHealth: CaseIterable {
    public static var allCases: [AgentRuntimeHealth] { [.starting, .healthy, .degraded, .unavailable, .failed] }
}

/// Why a Workspace is unavailable, or cannot finish cleanup.
public enum DiagnosticCode: String, Sendable, Hashable, CaseIterable, Codable {
    case rootMissing = "root_missing"
    case rootInaccessible = "root_inaccessible"
    case closeAgentsUnknown = "close_agents_unknown"
    case closeTerminalUnknown = "close_terminal_unknown"
    case closeEditorUnknown = "close_editor_unknown"
    case closeEditorStarting = "close_editor_starting"
    case closeEditorUnresponsive = "close_editor_unresponsive"
    case closeEditorVetoed = "close_editor_vetoed"
    case cleanupFailed = "cleanup_failed"
    case runtimeUnavailable = "runtime_unavailable"
    /// The workspace's workbench kept stopping, so DevHub stopped building it.
    case editorRestartExhausted = "editor_restart_exhausted"
    /// The workspace's workbench could not be started at all.
    case editorUnavailable = "editor_unavailable"
}

/// The steps a close is made of, in the order they run (`CLOSE_STEPS`).
public enum CloseStep: String, Sendable, Hashable, CaseIterable, Codable {
    case editor, agents, terminal, view, worktree, state
}

/// Product-level control lifecycle, independent of status and health.
public enum AgentControlState: Hashable, Sendable {
    case running
    case stopping
    case stopFailed(diagnostic: DiagnosticCode)

    public var isInteractive: Bool { self == .running }
    public var canRetryStop: Bool { if case .stopFailed = self { return true } else { return false } }
    public var kind: String {
        switch self {
        case .running: return "running"
        case .stopping: return "stopping"
        case .stopFailed: return "stop-failed"
        }
    }
}

/// Provider-free observation used for one atomic Agent reconciliation.
public struct AgentObservation: Equatable, Sendable {
    public var agentId: AgentId
    public var status: AgentStatus
    public var runtimeHealth: AgentRuntimeHealth
    /// What the Agent says it is doing, or nothing if it has not said.
    public var activity: String?
    /// A GUI Claude Agent's prompt cache, as its conversation last reported it.
    public var promptCache: PromptCache?
    /// What DevHub is holding for this Agent, and why it has not gone yet.
    public var injection: AgentInjection
    /// A failure that is a reading, not a refusal.
    public var failure: AgentFailure?

    public init(
        agentId: AgentId, status: AgentStatus, runtimeHealth: AgentRuntimeHealth, activity: String? = nil,
        promptCache: PromptCache? = nil, injection: AgentInjection = .none, failure: AgentFailure? = nil
    ) {
        self.agentId = agentId
        self.status = status
        self.runtimeHealth = runtimeHealth
        self.activity = activity
        self.promptCache = promptCache
        self.injection = injection
        self.failure = failure
    }
}

/// A complete provider reconciliation. Missing provider Agents are represented
/// by `exited`; both lists are applied atomically once every identity is known.
public struct AgentReconciliation: Equatable, Sendable {
    public var observations: [AgentObservation]
    public var exited: [AgentId]

    public init(observations: [AgentObservation] = [], exited: [AgentId] = []) {
        self.observations = observations
        self.exited = exited
    }
}

/// Validated, provider-free restoration record for an existing Agent.
public struct AgentRestoreRecord: Equatable, Sendable {
    public var id: AgentId
    public var workspaceId: WorkspaceId
    public var profile: AgentProfile
    public var presentation: AgentPresentation
    public var ordinal: Int
    public var temporaryName: String?
    public var status: AgentStatus
    public var runtimeHealth: AgentRuntimeHealth
    public var controlState: AgentControlState
    public var unread: UnreadReason?

    public init(
        id: AgentId, workspaceId: WorkspaceId, profile: AgentProfile, presentation: AgentPresentation, ordinal: Int,
        temporaryName: String? = nil, status: AgentStatus, runtimeHealth: AgentRuntimeHealth,
        controlState: AgentControlState, unread: UnreadReason? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.profile = profile
        self.presentation = presentation
        self.ordinal = ordinal
        self.temporaryName = temporaryName
        self.status = status
        self.runtimeHealth = runtimeHealth
        self.controlState = controlState
        self.unread = unread
    }

    /// `agentRestoreRecord`.
    public func validated() throws -> AgentRestoreRecord {
        if ordinal == 0 { throw domainFail(.invalidOrdinal) }
        guard profile.kind.presentations.contains(presentation) else { throw domainFail(.invalidProfile) }
        if let temporaryName, !DomainNames.validDisplayName(temporaryName) { throw domainFail(.invalidDisplayName) }
        return self
    }
}

/// Agent resource owned by exactly one Workspace.
public struct Agent: Equatable, Sendable {
    public let id: AgentId
    public let workspaceId: WorkspaceId
    public let profile: AgentProfile
    /// How this Agent is shown, fixed when it was launched.
    public let presentation: AgentPresentation
    public let ordinal: Int
    private var nameOverride: String?
    public private(set) var status: AgentStatus
    public private(set) var runtimeHealth: AgentRuntimeHealth
    public private(set) var controlState: AgentControlState
    /// The Agent wanted you and nobody has looked yet, and why.
    public private(set) var unread: UnreadReason?
    /// What this Agent last said it was doing. Not part of the restore record:
    /// a reading of a pane taken again 300ms from now.
    public private(set) var activity: String?
    public private(set) var promptCache: PromptCache?
    public private(set) var injection: AgentInjection = .none
    /// The ids of the actions ticked as automatic for this Agent, for this run.
    public private(set) var automaticActions: [String] = []
    /// The refusal this Agent's pane is still showing, or nothing. Retired by
    /// the next reconcile that actually read this Agent, and by nothing else.
    public private(set) var failure: AgentFailure?

    private init(record: AgentRestoreRecord) {
        id = record.id
        workspaceId = record.workspaceId
        profile = record.profile
        presentation = record.presentation
        ordinal = record.ordinal
        nameOverride = record.temporaryName
        status = record.status
        runtimeHealth = record.runtimeHealth
        controlState = record.controlState
        unread = record.unread
    }

    public static func create(
        id: AgentId, owner: WorkspaceId, profile: AgentProfile, ordinal: Int, presentation: AgentPresentation
    ) throws -> Agent {
        // Nothing has read this Agent's screen yet, and "idle" would be a
        // reading. The first reconcile replaces it.
        try restore(AgentRestoreRecord(
            id: id, workspaceId: owner, profile: profile, presentation: presentation, ordinal: ordinal,
            status: .unknown, runtimeHealth: .starting, controlState: .running
        ))
    }

    public static func restore(_ record: AgentRestoreRecord) throws -> Agent {
        Agent(record: try record.validated())
    }

    public var displayName: String { nameOverride ?? "\(profile.displayName) \(ordinal)" }
    public var temporaryName: String? { nameOverride }
    public var isInteractive: Bool { controlState.isInteractive }
    public var canRetryStop: Bool { controlState.canRetryStop }
    public var interruptsNothing: Bool { AgentRules.interruptsNothing(status: status, failure: failure) }

    @discardableResult
    public mutating func setPromptCache(_ cache: PromptCache?) -> Bool {
        if promptCache == cache { return false }
        promptCache = cache
        return true
    }

    @discardableResult
    public mutating func setAutomaticAction(_ actionId: String, automatic: Bool) -> Bool {
        let has = automaticActions.contains(actionId)
        if has == automatic { return false }
        if automatic { automaticActions.append(actionId) } else { automaticActions.removeAll { $0 == actionId } }
        return true
    }

    /// An operation on this Agent was refused. Shown until a reconcile succeeds.
    @discardableResult
    public mutating func fail(_ next: AgentFailure) -> Bool {
        if failure == next { return false }
        failure = next
        return true
    }

    /// A reconcile read this Agent, so whatever it last refused is no longer news.
    @discardableResult
    public mutating func clearFailure() -> Bool {
        if failure == nil { return false }
        failure = nil
        return true
    }

    @discardableResult
    public mutating func setUnread(_ reason: UnreadReason?) -> Bool {
        if unread == reason { return false }
        unread = reason
        return true
    }

    @discardableResult
    public mutating func rename(_ displayName: String) throws -> Bool {
        guard DomainNames.validDisplayName(displayName) else { throw domainFail(.invalidDisplayName) }
        if nameOverride == displayName { return false }
        nameOverride = displayName
        return true
    }

    @discardableResult
    public mutating func resetName() -> Bool {
        if nameOverride == nil { return false }
        nameOverride = nil
        return true
    }

    @discardableResult
    public mutating func setStatus(_ next: AgentStatus) -> Bool {
        if status == next { return false }
        status = next
        return true
    }

    @discardableResult
    public mutating func setInjection(_ next: AgentInjection) -> Bool {
        if injection == next { return false }
        injection = next
        return true
    }

    @discardableResult
    public mutating func setActivity(_ next: String?) -> Bool {
        if activity == next { return false }
        activity = next
        return true
    }

    @discardableResult
    public mutating func setRuntimeHealth(_ next: AgentRuntimeHealth) -> Bool {
        if runtimeHealth == next { return false }
        runtimeHealth = next
        return true
    }

    @discardableResult
    public mutating func requestStop() -> Bool {
        if controlState == .stopping { return false }
        controlState = .stopping
        return true
    }

    @discardableResult
    public mutating func markStopFailed(_ diagnostic: DiagnosticCode) throws -> Bool {
        if controlState == .running { throw domainFail(.invalidAgentControlTransition) }
        if controlState == .stopFailed(diagnostic: diagnostic) { return false }
        controlState = .stopFailed(diagnostic: diagnostic)
        return true
    }

    @discardableResult
    public mutating func returnToRunning() -> Bool {
        if controlState == .running { return false }
        controlState = .running
        return true
    }
}

// MARK: - Workspaces

/// What this Workspace's close has to say — the one it is running, or the
/// last one that stopped. Never persisted, and deliberately not a progress
/// record.
public enum WorkspaceClose: Hashable, Sendable {
    case idle
    case running
    case failed(step: CloseStep, diagnostic: DiagnosticCode, detail: String?)

    public var isRunning: Bool { self == .running }
}

/// Workspace availability: whether its folder is there.
public enum WorkspaceState: Hashable, Sendable {
    case available
    case unavailable(reason: DiagnosticCode)

    public var isAvailable: Bool { self == .available }
}

/// A Workspace is an open context rooted at one canonical folder. Repository
/// identity is optional and never replaces Workspace identity.
public struct Workspace: Equatable, Sendable {
    public let id: WorkspaceId
    public private(set) var location: WorkspaceLocation
    public private(set) var selectedPath: String
    public private(set) var repositoryId: RepositoryId?
    public private(set) var state: WorkspaceState
    public private(set) var editor: EditorAttachment
    /// See `WorkspaceClose`. In memory only; a launch starts every close idle.
    public private(set) var close: WorkspaceClose = .idle
    /// The container DevHub itself started for this editor's dev container.
    public private(set) var startedContainer: String?
    public private(set) var agents: [Agent] = []
    /// Its own terminals' panes. In memory only — see `TerminalPanes`.
    public var terminals = TerminalPanes()

    public init(
        id: WorkspaceId, location: WorkspaceLocation, selectedPath: String, repositoryId: RepositoryId? = nil,
        state: WorkspaceState = .available, editor: EditorAttachment = .host
    ) {
        self.id = id
        self.location = location
        self.selectedPath = selectedPath
        self.repositoryId = repositoryId
        self.state = state
        self.editor = editor
    }

    /// The folder's path, wherever the folder is.
    public var root: String { location.path }
    /// What makes this Workspace this one. See `WorkspaceLocation.key`.
    public var key: String { location.key }

    /// An Agent is a process, and a process runs where the folder is: the two
    /// terms are whether it is available, and whether it is on its way out.
    public var canCreateAgent: Bool { state.isAvailable && !close.isRunning }

    /// Attach the editor somewhere else. The Workspace itself does not move.
    @discardableResult
    public mutating func attachEditor(_ next: EditorAttachment) -> Bool {
        let recovered = state == .unavailable(reason: .editorRestartExhausted)
        if recovered { state = .available }
        if editor == next { return recovered }
        editor = next
        startedContainer = nil
        return true
    }

    @discardableResult
    public mutating func noteStartedContainer(_ containerId: String) throws -> Bool {
        guard case .devContainer = editor else { throw domainFail(.invalidEditorAttachment) }
        if startedContainer == containerId { return false }
        startedContainer = containerId
        return true
    }

    @discardableResult
    public mutating func setRepositoryId(_ next: RepositoryId?) -> Bool {
        if repositoryId == next { return false }
        repositoryId = next
        return true
    }

    /// Rebind an unavailable Workspace to a newly located canonical root while
    /// preserving its WorkspaceId and its live Agents.
    public mutating func relocate(_ location: WorkspaceLocation, selectedPath: String) {
        self.location = location
        self.selectedPath = selectedPath
        state = .available
    }

    @discardableResult
    public mutating func markUnavailable(_ reason: DiagnosticCode) -> Bool {
        let next = WorkspaceState.unavailable(reason: reason)
        if state == next { return false }
        state = next
        return true
    }

    @discardableResult
    public mutating func markAvailable() -> Bool {
        if state == .available { return false }
        state = .available
        return true
    }

    /// A close is starting. Whatever the last one said is no longer the news.
    @discardableResult
    public mutating func beginClose() throws -> Bool {
        if close.isRunning { throw domainFail(.workspaceClosing) }
        return setClose(.running)
    }

    /// A close stopped at this step, for this reason. Final for that attempt.
    @discardableResult
    public mutating func closeFailed(_ step: CloseStep, _ diagnostic: DiagnosticCode, detail: String? = nil) -> Bool {
        setClose(.failed(step: step, diagnostic: diagnostic, detail: detail))
    }

    private mutating func setClose(_ next: WorkspaceClose) -> Bool {
        if close == next { return false }
        close = next
        return true
    }

    public func agent(_ id: AgentId) -> Agent? { agents.first { $0.id == id } }

    /// Change one of its Agents in place; nil when it has no such Agent.
    @discardableResult
    public mutating func withAgent<T>(_ id: AgentId, _ body: (inout Agent) throws -> T) rethrows -> T? {
        guard let index = agents.firstIndex(where: { $0.id == id }) else { return nil }
        return try body(&agents[index])
    }

    public mutating func addAgent(_ agent: Agent) throws {
        guard canCreateAgent else { throw domainFail(.workspaceUnavailable) }
        try restoreAgent(agent)
    }

    public mutating func restoreAgent(_ agent: Agent) throws {
        guard agent.workspaceId == id else { throw domainFail(.agentWorkspaceMismatch) }
        if self.agent(agent.id) != nil { throw domainFail(.duplicateAgent) }
        agents.append(agent)
    }

    @discardableResult
    public mutating func removeAgent(_ id: AgentId) -> Agent? {
        guard let index = agents.firstIndex(where: { $0.id == id }) else { return nil }
        return agents.remove(at: index)
    }

    /// Put the Agents in the order a person arranged them. The order given has
    /// to name exactly the Agents this workspace has.
    public mutating func reorderAgents(_ order: [AgentId]) throws {
        guard order.count == agents.count else { throw domainFail(.unknownAgent) }
        var moved: [Agent] = []
        for id in order {
            guard let agent = agent(id), !moved.contains(where: { $0.id == id }) else { throw domainFail(.unknownAgent) }
            moved.append(agent)
        }
        agents = moved
    }
}

// MARK: - Navigation and surfaces

/// The left-pane Navigation Context, and the whole of the selection. Scratch
/// is not a kind of its own: it is a Workspace.
public enum NavigationContext: Hashable, Sendable {
    case workspace(WorkspaceId)
    case agent(AgentId)

    public var workspaceId: WorkspaceId? { if case let .workspace(id) = self { return id } else { return nil } }
    public var agentId: AgentId? { if case let .agent(id) = self { return id } else { return nil } }
    public var isAgent: Bool { agentId != nil }
}

/// Semantic DevHub surface identity.
public enum SurfaceKey: Hashable, Sendable {
    case workspaceEditor(WorkspaceId)
    case agent(AgentId)

    /// `surfaceKeyName`.
    public var name: String {
        switch self {
        case let .workspaceEditor(id): return "workspace-editor:\(id.rawValue)"
        case let .agent(id): return "agent:\(id.rawValue)"
        }
    }
}

/// What the content area holds for the selected context.
public enum SurfaceLayout: Hashable, Sendable {
    case workbench(editor: SurfaceKey)
    case agent(agent: SurfaceKey)
    case split(editor: SurfaceKey, agent: SurfaceKey)
    case unavailable

    public var isSplit: Bool { if case .split = self { return true } else { return false } }
}

/// How much of the content area the thing you selected takes.
public enum SurfacePresentation: String, Hashable, Sendable, Codable {
    case full
    case beside
}

// MARK: - Close inspection

/// One input to the consolidated Workspace close inspection.
public enum ResourceInspection: Hashable, Sendable {
    case clean
    case busy(count: Int)
    /// `reason`: the one sentence that says *why*, when the diagnostic's stock
    /// words leave the reader nowhere to go.
    case unknown(diagnostic: DiagnosticCode, reason: String?)

    /// `busy`.
    public static func busyCount(_ count: Int) throws -> ResourceInspection {
        if count == 0 { throw domainFail(.invalidBusyCount) }
        return .busy(count: count)
    }

    /// `unknownResource`.
    public static func unknownResource(_ diagnostic: DiagnosticCode, reason: String? = nil) -> ResourceInspection {
        .unknown(diagnostic: diagnostic, reason: reason?.isEmpty == false ? reason : nil)
    }

    /// `agentsInspection`: only the Agents stopping would interrupt are counted.
    public static func agents(_ agents: [(status: AgentStatus, failure: AgentFailure?)]) -> ResourceInspection {
        let busy = agents.filter { !AgentRules.interruptsNothing(status: $0.status, failure: $0.failure) }.count
        return busy == 0 ? .clean : .busy(count: busy)
    }
}

/// What a Workspace's workbench holds that a close would throw away. Terminal
/// mode has no workbench, so it is always `clean` here; the type is kept
/// because the close confirmation's shape is shared with the TS app.
public enum UnsavedEditorsInspection: Hashable, Sendable {
    case clean
    case unsaved(tabs: [String])
    case unknown(diagnostic: DiagnosticCode, reason: String?)

    /// `unsavedEditors`.
    public static func of(_ tabs: [String]) -> UnsavedEditorsInspection { tabs.isEmpty ? .clean : .unsaved(tabs: tabs) }

    var asResource: ResourceInspection {
        switch self {
        case .clean: return .clean
        case let .unsaved(tabs): return .busy(count: tabs.count)
        case let .unknown(diagnostic, reason): return .unknown(diagnostic: diagnostic, reason: reason)
        }
    }
}

/// Resource counts collected before a Workspace close confirmation.
public struct CloseInspectionInputs: Hashable, Sendable {
    public var agents: ResourceInspection
    public var terminalProcesses: ResourceInspection
    public var terminalPanes: ResourceInspection
    public var terminalWindows: ResourceInspection
    public var unsavedEditors: UnsavedEditorsInspection

    public init(
        agents: ResourceInspection = .clean, terminalProcesses: ResourceInspection = .clean,
        terminalPanes: ResourceInspection = .clean, terminalWindows: ResourceInspection = .clean,
        unsavedEditors: UnsavedEditorsInspection = .clean
    ) {
        self.agents = agents
        self.terminalProcesses = terminalProcesses
        self.terminalPanes = terminalPanes
        self.terminalWindows = terminalWindows
        self.unsavedEditors = unsavedEditors
    }

    public static let clean = CloseInspectionInputs()
}

/// Counted reasons shown in one destructive Workspace confirmation.
public struct BusyReasons: Hashable, Sendable {
    public var agents = 0
    public var terminalProcesses = 0
    public var terminalPanes = 0
    public var terminalWindows = 0
    public var unsavedEditors = 0

    public init(agents: Int = 0, terminalProcesses: Int = 0, terminalPanes: Int = 0, terminalWindows: Int = 0, unsavedEditors: Int = 0) {
        self.agents = agents
        self.terminalProcesses = terminalProcesses
        self.terminalPanes = terminalPanes
        self.terminalWindows = terminalWindows
        self.unsavedEditors = unsavedEditors
    }
}

/// The only three consolidated close outcomes.
public enum CloseInspection: Hashable, Sendable {
    case clean
    case requiresConfirmation(reasons: BusyReasons, unknownDiagnostics: [DiagnosticCode])

    public var isClean: Bool { self == .clean }

    /// `consolidateCloseInspection`.
    public static func consolidate(_ inputs: CloseInspectionInputs) -> CloseInspection {
        let resources: [(WritableKeyPath<BusyReasons, Int>, ResourceInspection)] = [
            (\.agents, inputs.agents),
            (\.terminalProcesses, inputs.terminalProcesses),
            (\.terminalPanes, inputs.terminalPanes),
            (\.terminalWindows, inputs.terminalWindows),
            (\.unsavedEditors, inputs.unsavedEditors.asResource),
        ]
        var unknown: [DiagnosticCode] = []
        for (_, check) in resources {
            if case let .unknown(diagnostic, _) = check, !unknown.contains(diagnostic) { unknown.append(diagnostic) }
        }
        var reasons = BusyReasons()
        var anyBusy = false
        for (path, check) in resources {
            if case let .busy(count) = check {
                reasons[keyPath: path] = count
                anyBusy = true
            }
        }
        if !anyBusy && unknown.isEmpty { return .clean }
        return .requiresConfirmation(reasons: reasons, unknownDiagnostics: unknown)
    }
}

/// The content-free projection the close confirmation renders.
public struct CloseInspectionProjection: Hashable, Sendable {
    public var workspaceId: WorkspaceId
    public var workspaceLabel: String
    public var inputs: CloseInspectionInputs

    public init(workspaceId: WorkspaceId, workspaceLabel: String, inputs: CloseInspectionInputs) {
        self.workspaceId = workspaceId
        self.workspaceLabel = workspaceLabel
        self.inputs = inputs
    }

    public var agents: ResourceInspection { inputs.agents }
    public var terminalProcesses: ResourceInspection { inputs.terminalProcesses }
    public var terminalPanes: ResourceInspection { inputs.terminalPanes }
    public var terminalWindows: ResourceInspection { inputs.terminalWindows }
    public var unsavedEditors: UnsavedEditorsInspection { inputs.unsavedEditors }
}
