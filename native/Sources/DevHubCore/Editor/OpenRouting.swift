// Port of apps/desktop/src/main/cli/route.ts and resolve.ts
//
// Which Workspace an `open` lands in. One rule, and this is the only place it
// is written.
//
// DevHub deliberately does not do what `code` does. `code <file>` opens the
// file in the *last focused window*, so the same command lands somewhere
// different depending on where you happened to click a minute ago. DevHub
// answers from facts the request carries:
//
// > An open lands in the workbench the request came from. If the request did
// > not say, it lands in the Workspace **on the machine the path is on** whose
// > root contains it; if none does, in Scratch.
//
// An origin says which *pane* as well as which window, and when that pane is
// an Agent's the first clause says one thing more: the file is shown **beside
// that Agent**, in the split the person would have made by hand. That is not a
// second rule about where an open lands — it lands in the same window either
// way — it is the arrangement the window is put into, and it is here because
// the fact it is read from is the origin and nothing else knows it.
//
// The origin is carried on the tmux session (`DEVHUB_ORIGIN`), so a `devhub`
// run from a pane says which Workspace is asking and a `devhub` run from a
// login shell says nothing — which is the honest unknown, and the second
// clause is what answers for it.
//
// The machine is half the second clause and not a refinement of it. A path is
// a path on one computer: `/srv/app` on this Mac and `/srv/app` on a host are
// two folders, and a matcher handed both roots answers one of them with the
// other's Workspace.
//
// Everything here is pure: canonical paths in, a destination out.
// Canonicalisation (`~`, relative paths, symlinks) happens before these are
// called (`PathCanonicalisation`), because that is the part that needs the
// filesystem, and comparing anything but canonical paths is how two spellings
// of one folder become two Workspaces.

import Foundation

public enum PathResolution {
    /// Whether `root` contains `path`, or is `path`. Both must be canonical.
    public static func contains(_ root: String, _ path: String) -> Bool {
        path == root || path.hasPrefix(root + "/")
    }

    /// The open Workspace root a path belongs to, or `nil` for the Scratch
    /// editor. When Workspaces are nested the deepest one wins: it is the one
    /// whose root is the *nearest* ancestor.
    public static func workspaceRoot(for path: String, roots: [String]) -> String? {
        var best: String?
        for root in roots where contains(root, path) {
            if best == nil || root.utf16.count > best!.utf16.count { best = root }
        }
        return best
    }

    /// Expand a path the way a shell would not: `~` is ours to expand because
    /// the CLI may be called from a script that passed it through unexpanded,
    /// and a relative path is resolved against the caller's directory rather
    /// than the app's, which is somewhere else entirely.
    ///
    /// This is lexical only. `..` is left for `realpath` to settle, because a
    /// `..` that crosses a symlink means something different before and after
    /// resolution.
    public static func expand(_ raw: String, cwd: String, home: String) -> String {
        let expanded = raw == "~" ? home : raw.hasPrefix("~/") ? "\(home)/\(raw.dropFirst(2))" : raw
        return expanded.hasPrefix("/") ? expanded : "\(cwd)/\(expanded)"
    }

    /// `path.posix.normalize`: `.` and `..` folded, repeated slashes merged, a
    /// trailing slash kept.
    public static func normalize(_ path: String) -> String {
        if path.isEmpty { return "." }
        let absolute = path.hasPrefix("/")
        let trailing = path.hasSuffix("/")
        var parts: [Substring] = []
        for part in path.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." {
                if let last = parts.last, last != ".." {
                    parts.removeLast()
                } else if !absolute {
                    parts.append(part)
                }
                continue
            }
            parts.append(part)
        }
        var joined = parts.joined(separator: "/")
        if joined.isEmpty {
            if absolute { return "/" }
            return trailing ? "./" : "."
        }
        if trailing { joined += "/" }
        return absolute ? "/" + joined : joined
    }
}

/// An open Workspace, as the routing rule sees one: four fields, because four
/// is what the rule reads. Deliberately not the model's Workspace, so the rule
/// stays something a test can build by hand.
public struct RoutableWorkspace: Equatable, Sendable {
    public let workspaceId: String
    /// Canonical, and a path on `machine`.
    public let root: String
    /// A `RuntimeId`: `local`, or `ssh:<host>`.
    public let machine: String
    /// The Agents running in it, by id. An origin names something that may
    /// have gone away since the pane was made, so "beside that Agent" is
    /// checked against what is running and not believed.
    public let agents: [String]

    public init(workspaceId: String, root: String, machine: String, agents: [String] = []) {
        self.workspaceId = workspaceId
        self.root = root
        self.machine = machine
        self.agents = agents
    }
}

/// Which of the three clauses answered. Carried out of the rule rather than
/// reconstructed by the caller, because the sentence the CLI prints has to say
/// which one happened.
public enum OpenReason: String, Equatable, Sendable {
    /// The request said which Workspace it came from, and that one is open.
    case origin
    /// The request came from an Agent's own pane, and that Agent is running:
    /// the file goes into that Workspace's editor beside that Agent.
    case originAgent = "origin-agent"
    /// No origin, or a stale one; this Workspace's root contains the path.
    case containing
    /// No origin, and no open Workspace on that machine contains the path.
    case noContainingWorkspace = "no-containing-workspace"
}

/// Where an open goes, and — for the sentence the CLI prints — why.
public enum OpenDestination: Equatable, Sendable {
    /// `reason` is `.origin` or `.containing`.
    case workspace(RoutableWorkspace, reason: OpenReason)
    /// Beside a running Agent of `workspace` (`.originAgent`).
    case besideAgent(RoutableWorkspace, agentId: String)
    /// `reason` is `.origin` or `.noContainingWorkspace`.
    case scratch(reason: OpenReason)

    public var reason: OpenReason {
        switch self {
        case let .workspace(_, reason): return reason
        case .besideAgent: return .originAgent
        case let .scratch(reason): return reason
        }
    }
}

public enum OpenRouting {
    /// The Workspace field of an origin written by the tmux anchor session,
    /// which belongs to no Workspace. Such a pane's opens go to Scratch.
    static let scratchOrigin = "scratch"
    /// The Agent field of an origin that is not an Agent's pane.
    static let noAgentOrigin = "none"

    /// A pane's `DEVHUB_ORIGIN`, read. Anything that is not the three-field
    /// shape DevHub writes is no origin at all: a malformed one came from
    /// somewhere else, and says nothing about DevHub.
    public static func parseOrigin(_ origin: String?) -> (machine: String, workspaceId: String, agentId: String)? {
        guard let origin else { return nil }
        let fields = origin.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
        guard fields.count == 3, !fields[0].isEmpty, !fields[1].isEmpty, !fields[2].isEmpty else { return nil }
        return (fields[0], fields[1], fields[2])
    }

    public static func routeOpen(
        _ path: String, machine: String, workspaces: [RoutableWorkspace], origin: String? = nil
    ) throws -> OpenDestination {
        if let asked = parseOrigin(origin) {
            if asked.workspaceId == scratchOrigin {
                return .scratch(reason: .origin)
            }
            // "Still open" is the whole of why this is a lookup and not a
            // trust: a tmux session outlives the window it was made for. The
            // machine is checked too — an origin whose machine disagrees with
            // the Workspace's is not this Workspace's pane.
            if let window = workspaces.first(where: {
                $0.workspaceId == asked.workspaceId && $0.machine == asked.machine
            }) {
                if asked.agentId != noAgentOrigin && window.agents.contains(asked.agentId) {
                    return .besideAgent(window, agentId: asked.agentId)
                }
                return .workspace(window, reason: .origin)
            }
        }
        guard let workspace = try containingWorkspace(path, machine: machine, workspaces: workspaces) else {
            return .scratch(reason: .noContainingWorkspace)
        }
        return .workspace(workspace, reason: .containing)
    }

    /// Where a file link in a GUI Agent's conversation opens:
    ///
    /// > A link opens in the Workspace on the Agent's machine whose root
    /// > contains the file; if none does, in the Agent's own Workspace.
    ///
    /// Never Scratch. When the answer is the Agent's own Workspace the editor
    /// is shown beside the Agent; another Workspace is shown as a plain open.
    public static func routeAgentOpen(
        _ path: String, machine: String, workspaces: [RoutableWorkspace], agentWorkspaceId: String, agentId: String
    ) throws -> OpenDestination {
        let containing = try containingWorkspace(path, machine: machine, workspaces: workspaces)
        guard let workspace = containing ?? workspaces.first(where: { $0.workspaceId == agentWorkspaceId }) else {
            throw ManagedNeovimError("the Agent \(agentId)'s Workspace \(agentWorkspaceId) is not open")
        }
        if workspace.workspaceId == agentWorkspaceId && workspace.agents.contains(agentId) {
            return .besideAgent(workspace, agentId: agentId)
        }
        return .workspace(workspace, reason: .containing)
    }

    /// The open Workspace on `machine` whose root is `path`'s nearest ancestor.
    static func containingWorkspace(_ path: String, machine: String, workspaces: [RoutableWorkspace]) throws
        -> RoutableWorkspace?
    {
        let onMachine = workspaces.filter { $0.machine == machine }
        guard let root = PathResolution.workspaceRoot(for: path, roots: onMachine.map(\.root)) else { return nil }
        guard let workspace = onMachine.first(where: { $0.root == root }) else {
            throw ManagedNeovimError("no workspace is rooted at \(root) on \(machine)")
        }
        return workspace
    }
}
