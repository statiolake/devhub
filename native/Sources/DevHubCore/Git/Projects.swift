// Port of apps/desktop/src/model/projects.ts and
// apps/desktop/src/main/shell/projects.ts.
//
// What a person means when they name a repository, what it is called on disk
// once it is cloned, and the two ways a workspace can start that are not
// "find one that exists": make an empty folder, or clone a repository into
// one. Both end in the same place — a directory on disk — and neither opens
// it. Opening a folder is one act with one implementation, and these hand it a
// path the way the picker's own candidates do.
//
// The sheet that asked shows a failure and stays open, because the answer to
// a bad URL is a better URL, typed in the field that is already on screen.

import Foundation

/// Who this machine is signed in to GitHub as, or why DevHub cannot say.
public enum GitHubLogin: Equatable, Sendable {
    case known(String)
    case unknown(reason: String)
    case pending
}

/// What is going to be cloned, or why that cannot be said yet. The line under
/// the field and the call that does the cloning read the same value.
public enum CloneTarget: Equatable, Sendable {
    case clone(url: String, name: String)
    case unreadable(reason: String)
}

public enum Projects {
    // MARK: model/projects.ts

    /// The directory `git clone <url>` would create, or nothing when the URL
    /// says no name at all.
    public static func cloneDirectoryName(_ url: String) -> String? {
        let trimmed = url.jsTrimmed
        if trimmed.isEmpty { return nil }
        // `scp`-style remotes (`git@host:owner/repo.git`) have no scheme to
        // strip and a colon where a URL would have a slash; both forms end in
        // the same thing, which is all this needs.
        let withoutQuery = TextPattern("[?#]").split(trimmed).first ?? ""
        let withoutTrailingSlashes = TextPattern("[/\\\\]+$").replacing(in: withoutQuery, with: "")
        let last = TextPattern("[/\\\\:]").split(withoutTrailingSlashes).last ?? ""
        let name = TextPattern("\\.git$", options: [.caseInsensitive]).replacing(in: last, with: "")
        // A name that would escape the directory it is being put in is not a name.
        if name.isEmpty || name == "." || name == ".." { return nil }
        return name
    }

    /// What a folder is called: the last segment of its path. A path that is
    /// all separators has no name and answers with itself, because a blank row
    /// would be worse than a long one.
    public static func folderName(_ path: String) -> String {
        let trimmed = Worktrees.trimTrailingSlashes(path)
        let name: String
        if let cut = trimmed.lastIndex(of: "/") {
            name = String(trimmed[trimmed.index(after: cut)...])
        } else {
            name = trimmed
        }
        return name.isEmpty ? path : name
    }

    /// `parent` and `name`, joined the way a path is, with no doubled
    /// separator. A name that is already a path from the root *is* the answer.
    public static func joinPath(_ parent: String, _ name: String) -> String {
        if name.hasPrefix("/") || name.hasPrefix("~") { return name }
        return "\(Worktrees.trimTrailingSlashes(parent))/\(name)"
    }

    private static let gitHubName = TextPattern("^[A-Za-z0-9._-]+$")
    private static let hasScheme = TextPattern("^[A-Za-z][A-Za-z0-9+.-]*://")
    private static let scpRemote = TextPattern("^[^/\\s@]+@[^/\\s:]+:")

    private static func withoutGitSuffix(_ segment: String) -> String {
        TextPattern("\\.git$", options: [.caseInsensitive]).replacing(in: segment, with: "")
    }

    private static func isName(_ segment: String) -> Bool {
        gitHubName.matches(segment) && segment != "." && segment != ".."
    }

    /// A repository on GitHub, by its owner and name — the same URL a person
    /// who typed `owner/name` into the Clone sheet gets.
    public static func gitHubCloneTarget(owner: String, repository: String) -> CloneTarget {
        let name = withoutGitSuffix(repository)
        guard isName(owner), isName(name) else {
            return .unreadable(reason: "A GitHub owner and repository may only use letters, digits, dots, dashes and underscores.")
        }
        return .clone(url: "https://github.com/\(owner)/\(name).git", name: name)
    }

    /// What `git clone` is going to be handed, read the way `gh repo clone`
    /// reads it: a bare name is the person's own repository, one slash is
    /// `owner/name` on GitHub, and anything that names its own transport is
    /// taken as written.
    public static func cloneTarget(_ typed: String, login: GitHubLogin) -> CloneTarget {
        let trimmed = typed.jsTrimmed
        if trimmed.isEmpty {
            return .unreadable(reason: "Enter a repository: a name, owner/name, or a clone URL.")
        }
        if hasScheme.matches(trimmed) || scpRemote.matches(trimmed) {
            guard let name = cloneDirectoryName(trimmed) else {
                return .unreadable(reason: "That URL names no repository.")
            }
            return .clone(url: trimmed, name: name)
        }
        let segments = Worktrees.trimTrailingSlashes(trimmed).split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if segments.count == 2 {
            return gitHubCloneTarget(owner: segments[0], repository: segments[1])
        }
        if segments.count > 2 {
            return .unreadable(reason: "That is neither a repository name nor a URL. Try owner/name, or paste the whole clone URL.")
        }
        // A bare name: this person's own repository, which means knowing who
        // they are. Saying so beats cloning something they did not name.
        let repository = segments.first ?? ""
        switch login {
        case .pending:
            return .unreadable(reason: "Finding out which GitHub account you are signed in as, to clone your \(withoutGitSuffix(repository))…")
        case .unknown(let reason):
            return .unreadable(reason: "A name on its own means your own repository, and DevHub does not know which GitHub account you are signed in as: \(reason). Type owner/\(withoutGitSuffix(repository)) instead.")
        case .known(let login):
            return gitHubCloneTarget(owner: login, repository: repository)
        }
    }

    // MARK: main/shell/projects.ts

    public static func expandHome(_ path: String, home: String) -> String {
        if path == "~" { return home }
        if path.hasPrefix("~/") { return Path.join(home, String(path.dropFirst(2))) }
        return path
    }

    /// Where a new project goes unless the person says otherwise.
    ///
    /// `[projects] directory` when it is set, because that is the person
    /// saying it. Otherwise the first filesystem workspace source, because that
    /// is the sentence "this is where my projects live" already written in
    /// `settings.toml`; the home directory when there is none. It is a starting
    /// value in an editable field, never a decision taken on the person's
    /// behalf.
    ///
    /// - Parameters:
    ///   - configuredDirectory: `config.projects.directory`.
    ///   - firstFilesystemSource: the `path` of the first `[[workspace_sources]]`
    ///     whose `type` is `filesystem`.
    public static func defaultProjectDirectory(configuredDirectory: String?, firstFilesystemSource: String?, home: String) -> String {
        if let configuredDirectory {
            return normalizedAbsolute(expandHome(configuredDirectory, home: home), home: home)
        }
        if let firstFilesystemSource { return expandHome(firstFilesystemSource, home: home) }
        return home
    }

    /// The folders a clone is offered, given the parents the sources imply.
    ///
    /// A set `[projects] directory` is the new-project default and leads the
    /// list, with the derived parents after it and never twice. Unset, the list
    /// is the derived parents alone. Either way it is never empty.
    public static func cloneParentChoices(configuredDirectory: String?, firstFilesystemSource: String?, derived: [String], home: String) -> [String] {
        let fallback = defaultProjectDirectory(configuredDirectory: configuredDirectory, firstFilesystemSource: firstFilesystemSource, home: home)
        let named = configuredDirectory == nil ? [] : [fallback]
        var seen = Set<String>()
        let choices = (named + derived).filter { seen.insert($0).inserted }
        return choices.isEmpty ? [fallback] : choices
    }

    /// Node's `path.resolve(p)` for an absolute or home-relative path: `.`
    /// and `..` folded and no trailing slash; a relative path is taken against
    /// the process's working directory, as Node does.
    static func normalizedAbsolute(_ path: String, home: String) -> String {
        let base = path.hasPrefix("/") ? "" : FileManager.default.currentDirectoryPath
        return GitDirectory.resolve(base.isEmpty ? "/" : base, path)
    }

    static func requireAbsolute(_ path: String, home: String) throws -> String {
        let expanded = expandHome(path.jsTrimmed, home: home)
        if expanded.isEmpty { throw CodedFailure.workspace("Enter a path for the folder.") }
        if !expanded.hasPrefix("/") { throw CodedFailure.workspace("A folder needs a full path; \(expanded) is not one.") }
        return expanded
    }

    static func refuseIfPresent(_ runtime: RepositoryRuntime, _ path: String) throws {
        let kind: RuntimeFileKind
        do {
            kind = try runtime.stat(path)
        } catch {
            // Not a swallow: this is the question. A path DevHub cannot even
            // look at is not one it can refuse for already existing, and the
            // `mkdir` below fails with the system's own words a moment later.
            return
        }
        if kind == .absent { return }
        throw CodedFailure.workspace("\(path) already exists.")
    }

    /// Make the folder, and say so when it is already there.
    ///
    /// `mkdir -p` would succeed on an existing directory, which is the one
    /// answer that must not be given: "New Project" on a folder full of
    /// somebody's work looks like it worked and is not what was asked for.
    public static func createProject(_ path: String, runtime: RepositoryRuntime = LocalRepositoryRuntime(), home: String) throws -> String {
        let target = try requireAbsolute(path, home: home)
        try refuseIfPresent(runtime, target)
        do { try runtime.makeDirectory(target) } catch { throw CodedFailure.workspace(failureText(error)) }
        return target
    }

    /// Make sure the folder is there, and say where it is — the opposite act:
    /// a date source's row says "today's workspace", and today's workspace is
    /// the same folder whether or not anything has made it yet.
    public static func ensureWorkspaceFolder(_ path: String, runtime: RepositoryRuntime = LocalRepositoryRuntime(), home: String) throws -> String {
        let target = try requireAbsolute(path, home: home)
        do { try runtime.makeDirectory(target) } catch { throw CodedFailure.workspace(failureText(error)) }
        return target
    }

    /// Clone into `<parent>/<name>`, and answer with the directory git created.
    public static func cloneProject(url: String, parentDirectory: String, command: GitCommand, home: String) async throws -> String {
        guard let name = cloneDirectoryName(url) else {
            throw CodedFailure.workspace("That does not look like a repository URL.")
        }
        let parent = try requireAbsolute(parentDirectory, home: home)
        let target = joinPath(parent, name)
        try refuseIfPresent(command.runtime, target)
        do { try command.runtime.makeDirectory(parent) } catch { throw CodedFailure.workspace(failureText(error)) }
        // `--` so a URL that begins with a dash is a URL and not an option.
        _ = try await command.run(["clone", "--", url.jsTrimmed, target], timeoutMs: GitCommand.networkTimeoutMs)
        return target
    }
}
