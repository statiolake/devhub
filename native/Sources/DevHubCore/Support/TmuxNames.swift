/// The names DevHub gives its tmux sessions (`main/terminal/tmux.ts`).
///
/// These are wire compatibility, not style: the native app adopts the
/// sessions the TypeScript app left running (and the reverse), so every name
/// must be the same bytes.
public enum TmuxNames {
    /// The anchor session the bootstrap creates with the server.
    public static let scratchAnchorSession = "scratch"

    /// An Agent's session: `ag-<agent id>`.
    public static func agentSession(agentId: String) -> String { "ag-\(agentId)" }

    /// The SHA-256 hex of a Workspace root, as `workspaceDigest` computes it.
    public static func workspaceDigest(root: String) -> String { SHA256.hex(root) }

    /// A Workspace's session: `ws-` and the first 20 hex digits of its root's
    /// digest. (A 32-digit name, from an older DevHub, is also recognised.)
    public static func workspaceSession(root: String) -> String {
        "ws-" + workspaceDigest(root: root).prefix(20)
    }

    public static func isWorkspaceSession(_ name: String, root: String) -> Bool {
        let digest = workspaceDigest(root: root)
        return name == "ws-" + digest.prefix(20) || name == "ws-" + digest.prefix(32)
    }

    /// The managed Neovim's socket file name for a Workspace
    /// (`main/editor/managedNeovim.ts`): first 12 hex digits of the SHA-256
    /// of the Workspace id.
    public static func neovimSocketName(workspaceId: String) -> String {
        SHA256.hex(workspaceId).prefix(12) + ".sock"
    }
}
