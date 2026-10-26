// Port of apps/desktop/src/model/worktrees.ts.
//
// Where the worktree for a piece of work goes.
//
// A worktree is named for the *work* — the Issue it is for — and not for the
// branch it holds. A branch is renamed once somebody knows what the work is
// (`feature/128-wip` becomes `feature/128-short-name`), and a folder named
// after the old name would then be a second folder for the same Issue the
// next time the work is checked out for review. The number does not change.
//
// The parent is always the *main* worktree's parent, never the current one's.
// A worktree made from inside another worktree otherwise nests, and the work's
// directory would then depend on where you happened to be standing.
//
// The name is only where a *new* worktree goes. A branch that is already
// checked out somewhere is found by git's own record of which worktree holds
// which branch (`ensureWorktree`), whatever its folder is called — including
// the `{repo}_{branch}` folders earlier versions of DevHub made.

import Foundation

/// The work a worktree is for: an Issue, or a pull request.
public struct WorkItem: Hashable, Sendable, Codable {
    public var kind: GitHubItemKind
    public var number: Int

    public init(kind: GitHubItemKind, number: Int) {
        self.kind = kind
        self.number = number
    }

    public static func issue(_ number: Int) -> WorkItem { WorkItem(kind: .issue, number: number) }
    public static func pull(_ number: Int) -> WorkItem { WorkItem(kind: .pull, number: number) }
}

public enum Worktrees {
    /// The number a worktree is named by: the Issue's.
    ///
    /// An Issue is its own number. A pull request is named by the Issue it is
    /// for when DevHub can tell — by the Issue number its branch carries — so
    /// an Issue's worktree and the worktree its pull request is reviewed in are
    /// the same folder. A pull request whose branch names no Issue is named by
    /// its own number.
    public static func number(for work: WorkItem, branch: String) -> Int {
        work.kind == .issue ? work.number : (GitHubBranchNaming.issueNumber(fromBranch: branch) ?? work.number)
    }

    /// The directory part of a path, with no trailing separator.
    static func parentDirectory(_ path: String) -> String {
        let trimmed = trimTrailingSlashes(path)
        guard let cut = trimmed.lastIndex(of: "/"), cut > trimmed.startIndex else { return "/" }
        return String(trimmed[..<cut])
    }

    static func trimTrailingSlashes(_ path: String) -> String {
        var trimmed = path
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        return trimmed
    }

    /// The last segment of a path.
    public static func baseName(_ path: String) -> String {
        let trimmed = trimTrailingSlashes(path)
        guard let cut = trimmed.lastIndex(of: "/") else { return trimmed }
        return String(trimmed[trimmed.index(after: cut)...])
    }

    /// `{main worktree's parent}/{repo}_{number}` — a sibling of the
    /// repository, named for the repository and the Issue.
    public static func directory(mainWorktree: String, work: WorkItem, branch: String) -> String {
        let parent = parentDirectory(mainWorktree)
        let name = "\(baseName(mainWorktree))_\(number(for: work, branch: branch))"
        return parent == "/" ? "/\(name)" : "\(parent)/\(name)"
    }

    /// Whether closing this workspace deletes a folder — the one rule, in one
    /// place.
    ///
    /// Three facts have to hold, and each of them rules out a real row:
    ///
    ///   - git knows a main worktree for it. Its absence is the whole of what
    ///     "not a repository" means, and a plain folder is only ever closed.
    ///   - the checkout is not that main worktree. Removing the repository
    ///     itself is not a close, it is losing the repository.
    ///   - the row *is* the checkout's root, not merely inside it. `git worktree
    ///     remove` takes the root, so a workspace opened on
    ///     `worktree/packages/app` would delete the whole checkout around it.
    public static func closingDeletesWorktree(mainWorktree: String?, worktree: String?, root: String) -> Bool {
        guard let mainWorktree, let worktree else { return false }
        return worktree != mainWorktree && worktree == root
    }
}
