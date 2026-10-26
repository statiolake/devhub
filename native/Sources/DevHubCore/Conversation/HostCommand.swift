// Port of apps/desktop/src/main/agent/conversation/hostCommand.ts
//
// Where a GUI Agent's host keeps its files, and the session command that
// starts it.
//
// The launch itself is the tmux runtime's (WP3), unchanged: a GUI Agent's
// session is created, marked, listed and killed exactly as a TUI Agent's is.
// What differs is only the command handed to it, and this is the one place
// that composes it.

import Foundation

/// A failure to name a host's directory: DevHub's own bug, never the person's.
public struct HostDirectoryRefused: Error, CustomStringConvertible, Equatable {
    public let message: String
    public var description: String { message }
}

/// What an Agent id may look like to become a directory name.
///
/// The ids are UUIDs DevHub mints, so anything else reaching here is a bug
/// and not a name to sanitise: a `/` or a `..` in it would put a host's
/// files, and a later `removeTree`, somewhere other than under `agents/`.
private func isAgentDirectoryName(_ id: String) -> Bool {
    id.range(of: "^[A-Za-z0-9][A-Za-z0-9-]*$", options: .regularExpression) != nil
}

/// What a profile tag (`remoteProfileTag`) looks like: a hex digest.
private func isProfileTag(_ tag: String) -> Bool {
    tag.range(of: "^[0-9a-f]+$", options: .regularExpression) != nil
}

/// A canonical UUID, lower case (`model/domain.ts` `isCanonicalUuid`).
public func isCanonicalUuid(_ raw: String) -> Bool {
    let characters = Array(raw)
    guard characters.count == 36, raw == raw.lowercased() else { return false }
    return characters.enumerated().allSatisfy { index, character in
        [8, 13, 18, 23].contains(index) ? character == "-" : character.isASCII && character.isHexDigit
    }
}

private func posixJoin(_ parts: String...) -> String {
    var joined = parts.filter { !$0.isEmpty }.joined(separator: "/")
    while joined.contains("//") { joined = joined.replacingOccurrences(of: "//", with: "/") }
    return joined
}

/// `<home>/.devhub/agents-<profile tag>`: one DevHub profile's host
/// directories on a machine.
///
/// Per profile, like the `bin-<tag>` beside it, because two DevHubs — two
/// profiles on this Mac — reach the same home, and each accounts only for its
/// own Agents: a directory shared between them would be one whose every entry
/// the other profile's sweep takes for an Agent nobody has.
private func agentsDirectory(_ home: String, _ profileTag: String) throws -> String {
    guard isProfileTag(profileTag) else {
        throw HostDirectoryRefused(
            message: "\(JsonValue.quoted(profileTag)) is not a profile tag DevHub makes, so it cannot name a directory")
    }
    return posixJoin(home, ".devhub", "agents-\(profileTag)")
}

/// `<home>/.devhub/agents-<profile tag>/<agentId>` on the Agent's machine.
///
/// Beside `~/.devhub/terminal` and `~/.devhub/tmp`, which DevHub already
/// keeps on a far machine, and built from the machine's home on this one
/// too, so there is one rule for where a host's files are.
public func agentStateDirectory(home: String, profileTag: String, agentId: String) throws -> String {
    guard isAgentDirectoryName(agentId) else {
        throw HostDirectoryRefused(
            message: "\(JsonValue.quoted(agentId)) is not an Agent id DevHub mints, so it cannot name a directory")
    }
    return posixJoin(try agentsDirectory(home, profileTag), agentId)
}

/// Every GUI Agent host directory on a machine, by Agent id, and the removal of one.
public struct HostDirectories: AgentHostFiles {
    let machine: HostMachine
    let home: String
    let root: String
    let profileTag: String

    /// Only a name DevHub could have made is listed: anything else under
    /// `agents/` is not a host directory, and DevHub does not remove what it
    /// did not make.
    public func list() async throws -> [String] {
        if try await machine.stat(root) == .absent { return [] }
        // An Agent id DevHub mints is a canonical UUID, and nothing else
        // here is a host directory of this profile's.
        return try await machine.readDirectory(root).filter { $0.directory && isCanonicalUuid($0.name) }.map(\.name)
    }

    public func remove(_ agentId: String) async throws {
        try await machine.removeTree(try agentStateDirectory(home: home, profileTag: profileTag, agentId: agentId))
    }
}

public func agentHostFiles(_ machine: HostMachine, profileTag: String) async throws -> HostDirectories {
    let home = try await machine.home()
    return HostDirectories(machine: machine, home: home, root: try agentsDirectory(home, profileTag), profileTag: profileTag)
}

/// Put `lines` at the head of a new Agent's journal, before its host starts:
/// the one thing DevHub ever writes to `out`, and only while nothing else can.
public func seedJournal(_ machine: HostMachine, stateDirectory: String, lines: [String]) async throws {
    if lines.isEmpty { return }
    try await machine.writeTextFile(
        posixJoin(stateDirectory, "out"), lines.map { "\($0)\n" }.joined(), mode: 0o600)
}

/// The session command that runs `cli` under the host.
///
/// `/bin/sh -c <script> devhub-agent-host <state dir> <cli argv…>`: the
/// script rides in argv, so there is nothing to install on any machine, and
/// the CLI's own argv follows it as positional words, so nothing in it is
/// ever re-parsed by a shell. The profile's environment is the session's, as
/// it is for a TUI Agent.
public func hostSessionCommand(stateDirectory: String, cli: CLICommand) -> CLICommand {
    CLICommand(
        file: "/bin/sh", args: ["-c", HOST_SCRIPT, HOST_NAME, stateDirectory, cli.file] + cli.args, env: cli.env)
}

/// What of a profile a GUI Agent's CLI is made from (`AgentProfile`'s kind,
/// command, args and env).
public struct GuiAgentProfile: Hashable, Sendable {
    public var kind: SessionCLIKind
    public var command: String
    public var args: [String]
    public var env: [(String, String)]

    public init(kind: SessionCLIKind, command: String, args: [String], env: [(String, String)] = []) {
        self.kind = kind
        self.command = command
        self.args = args
        self.env = env
    }

    public static func == (lhs: GuiAgentProfile, rhs: GuiAgentProfile) -> Bool {
        lhs.kind == rhs.kind && lhs.command == rhs.command && lhs.args == rhs.args
            && lhs.env.map(\.0) == rhs.env.map(\.0) && lhs.env.map(\.1) == rhs.env.map(\.1)
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(kind)
        hasher.combine(command)
        hasher.combine(args)
    }
}

/// The CLI a GUI Agent's host runs: `profile`'s command in the structured
/// mode its adapter reads, on the session its record picks — or, given
/// `session`, on the one a rewind or a `/resume` picks in its place
/// (`withSession`), which is the whole argv the host starts it again with.
///
/// Only Claude and Codex can be GUI Agents — the domain refuses any other
/// kind a GUI presentation — which `SessionCLIKind` says by having no other.
public func guiAgentCli(_ profile: GuiAgentProfile, session: [String]? = nil) -> CLICommand {
    let cli = CLICommand(
        file: profile.command,
        args: session.map { withSession(profile.kind, profile.args, $0) } ?? profile.args,
        env: Dictionary(profile.env, uniquingKeysWith: { $1 }))
    switch profile.kind {
    case .claude:
        return claudeStructuredCommand(cli)
    case .codex:
        var codex = cli
        codex.args = codexStructuredArgs(cli.args).args
        return codex
    }
}
