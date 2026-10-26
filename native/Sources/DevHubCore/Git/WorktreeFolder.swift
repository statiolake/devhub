// Port of apps/desktop/src/main/shell/worktreeFolder.ts.
//
// What a folder says about itself, before git is asked anything.
//
// **Is it there.** A probe failing is not one answer. `ENOENT` and `ENOTDIR`
// mean the folder is not there, which for a close is the state it was trying
// to reach. Every *other* errno — `EACCES` on a parent whose permissions
// changed, `EIO` on a failing disk, a dead network mount — means DevHub could
// not find out, and a close that reads "could not find out" as "already gone"
// deletes git's record of a worktree whose folder is still sitting there with
// work in it, and reports success. So not-there is one answer and could-not-
// look is a failure, and the errno and the path travel with it.
//
// **Is it a worktree.** git's own list is not the authority, because the case
// that matters is exactly the case where git's list is wrong: `git worktree
// remove` can delete the administrative record and then fail to delete the
// folder, after which git no longer lists a worktree and the folder is still
// there for ever. The folder itself still says what it is — a linked worktree
// has a `.git` *file* whose `gitdir:` points inside some repository's
// `.git/worktrees/` — and that survives the record, which is why it is what
// DevHub reads.

import Foundation

/// A folder that is a linked worktree, and the repository it belongs to.
public struct WorktreeFolder: Equatable, Sendable {
    /// The worktree's own root — the folder holding the `.git` file.
    public var root: String
    /// The repository whose `.git/worktrees/` holds this worktree's record.
    public var mainWorktree: String
    /// The administrative record this worktree points at, there or not.
    public var gitdir: String

    public init(root: String, mainWorktree: String, gitdir: String) {
        self.root = root
        self.mainWorktree = mainWorktree
        self.gitdir = gitdir
    }
}

/// Why a folder cannot be opened, in the vocabulary of a Workspace's
/// `unavailable` state: `root_missing` offers Locate…, `root_inaccessible`
/// does not, because the folder is exactly where it was.
public enum FolderUnreadableReason: String, Sendable, Equatable {
    case rootMissing = "root_missing"
    case rootInaccessible = "root_inaccessible"
}

public enum WorktreeFolders {
    static let maxMarkerBytes = 4096
    /// The segment that makes a `gitdir:` an *administrative record for a
    /// linked worktree*.
    static let worktreesSegment = "/.git/worktrees/"

    /// The errno as a sentence, so a failure can quote the system rather than
    /// invent.
    static func unreadable(_ path: String, _ error: Error) -> CodedFailure {
        if let file = error as? RuntimeFileError {
            return .workspace("\(path) could not be read (\(file.code)).")
        }
        return .workspace("\(path) could not be read (\(failureText(error))).")
    }

    /// Whether a folder is there and is a folder. `false` means *not there*;
    /// anything else throws, because the caller's next move for "it is gone"
    /// is destructive.
    public static func folderIsDirectory(_ runtime: RepositoryRuntime, _ folder: String) throws -> Bool {
        do {
            return try runtime.stat(folder) == .directory
        } catch {
            throw unreadable(folder, error)
        }
    }

    /// Read the folder's own claim to be a worktree, or `nil` if it makes
    /// none: no `.git`, a `.git` *directory*, or a `.git` file pointing
    /// somewhere that is not a worktree record. Only a folder that cannot be
    /// read throws.
    public static func read(_ runtime: RepositoryRuntime, _ folder: String) throws -> WorktreeFolder? {
        let marker = Path.join(folder, ".git")
        let contents: String
        do {
            let kind = try runtime.stat(marker)
            if kind == .absent { return nil }
            // A repository has a `.git` directory. Only a linked worktree has a file.
            if kind == .directory { return nil }
            contents = try runtime.readTextFile(marker, maxBytes: maxMarkerBytes)
        } catch {
            throw unreadable(marker, error)
        }
        guard let gitdir = TextPattern("^gitdir:\\s*(.+?)\\s*$", options: [.anchorsMatchLines]).firstMatch(in: contents)?[1],
              let cut = gitdir.range(of: worktreesSegment), cut.lowerBound > gitdir.startIndex
        else { return nil }
        return WorktreeFolder(root: folder, mainWorktree: String(gitdir[..<cut.lowerBound]), gitdir: gitdir)
    }

    /// Whether this folder is a worktree of *this* repository — the question
    /// asked before DevHub ever deletes a folder itself.
    public static func isWorktree(_ folder: WorktreeFolder?, of mainWorktree: String) -> Bool {
        folder?.mainWorktree == mainWorktree
    }

    /// Why a workbench cannot be opened in `folder`, or `nil` if it can.
    public static func unreadableReason(_ runtime: RepositoryRuntime, _ folder: String) -> FolderUnreadableReason? {
        do {
            return try runtime.stat(folder) == .directory ? nil : .rootMissing
        } catch {
            // Every failure the runtime raises for a path is "DevHub could not
            // look", and that is one of the two answers this exists to give.
            return .rootInaccessible
        }
    }

    /// Get rid of a worktree folder and git's record of it, in that order of
    /// care.
    ///
    ///   - **The folder is gone.** Nothing to remove and everything still to
    ///     tidy: prune.
    ///   - **The folder is there.** `git worktree remove`, forcing only if the
    ///     person was asked about what would be destroyed.
    ///   - **git removed its record and then failed.** The folder still says
    ///     what it is, so DevHub finishes what git started — prune the record,
    ///     delete the folder — but only for a folder whose `.git` file names
    ///     *this* repository, and only because the answer was to delete.
    ///
    /// A folder that cannot be *read* is none of these: it throws, with the
    /// errno, so the close stops at this step and says so.
    public static func dispose(_ command: GitCommand, mainWorktree: String, root: String, force: Bool) async throws {
        // Read first, and from the folder: this is the claim that survives a
        // half-finished `git worktree remove`.
        let folder = try read(command.runtime, root)
        // DevHub locks the worktrees it creates; a lock stops both remove and prune.
        try await command.unlockWorktree(mainWorktree: mainWorktree, worktree: root)
        if try !folderIsDirectory(command.runtime, root) {
            try await command.pruneWorktrees(mainWorktree: mainWorktree)
            return
        }
        do {
            try await command.removeWorktree(mainWorktree: mainWorktree, worktree: root, force: force)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            // Only one refusal is DevHub's to overrule: git has no record left
            // to remove. Every other refusal — "contains modified or untracked
            // files" above all — is git standing between somebody and work.
            guard let folder, isWorktree(folder, of: mainWorktree) else { throw error }
            if try folderIsDirectory(command.runtime, folder.gitdir) { throw error }
            try await command.pruneWorktrees(mainWorktree: mainWorktree)
            do {
                try command.runtime.removeTree(root)
            } catch let file as RuntimeFileError {
                throw unreadable(root, file)
            }
        }
    }
}
