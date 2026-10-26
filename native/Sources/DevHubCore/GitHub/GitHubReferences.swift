// Port of apps/desktop/src/model/github.ts.
//
// What DevHub reads out of GitHub, as rules about strings.
//
// Three questions live here, and all three are asked on both sides of the UI
// seam — which is why they are rules rather than requests. The sheet validates
// an Issue URL as it is typed, and the controller parses the same URL to know
// what to clone. The sidebar decides a workspace looks like it belongs to an
// Issue, and the poller decides which Issue to ask about. Two implementations
// of any of these would disagree on the first URL neither author thought about.
//
// Nothing here talks to the network.

import Foundation

/// An Issue, as GitHub names one.
public struct IssueReference: Hashable, Sendable, Codable {
    public var owner: String
    public var repository: String
    public var number: Int

    public init(owner: String, repository: String, number: Int) {
        self.owner = owner
        self.repository = repository
        self.number = number
    }

    /// `https://github.com/owner/repo/issues/128`, and nothing else.
    ///
    /// A pull request URL is deliberately not an Issue URL *here*: this is what
    /// the poller and the sidebar read, and both ask Issue questions of what
    /// they get. The flow that assigns work uses `GitHubItem.parse` instead.
    public static func parse(url: String) -> IssueReference? {
        guard let item = GitHubItem.parse(url: url), item.kind == .issue else { return nil }
        return item.reference
    }

    /// The URL an Issue is read at, from the reference DevHub kept.
    public var url: String { "https://github.com/\(owner)/\(repository)/issues/\(number)" }
}

/// Which of GitHub's two numbered things a reference names.
///
/// They share one sequence per repository — #128 is an Issue or a pull request
/// and never both — so the number alone cannot say, and every reference that
/// travels has to carry which it was.
public enum GitHubItemKind: String, Hashable, Sendable, Codable {
    case issue, pull
}

/// An Issue or a pull request: the two things DevHub can be pointed at.
public struct GitHubItem: Hashable, Sendable, Codable {
    public var owner: String
    public var repository: String
    public var number: Int
    public var kind: GitHubItemKind

    public init(owner: String, repository: String, number: Int, kind: GitHubItemKind) {
        self.owner = owner
        self.repository = repository
        self.number = number
        self.kind = kind
    }

    public var reference: IssueReference { IssueReference(owner: owner, repository: repository, number: number) }

    private static let pattern = TextPattern(
        "^https?://(?:www\\.)?github\\.com/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)/(issues|pull)/([0-9]+)(?:[/?#].*)?$"
    )

    /// `https://github.com/owner/repo/issues/128`, or `.../pull/128`.
    ///
    /// The shape of the URL is the whole of the evidence. GitHub numbers Issues
    /// and pull requests together, so `/issues/128` and `/pull/128` are
    /// different things with the same number, and nothing but the path can tell
    /// them apart.
    public static func parse(url: String) -> GitHubItem? {
        guard let match = pattern.firstMatch(in: url.jsTrimmed),
              let owner = match[1], let repository = match[2], let section = match[3],
              let digits = match[4], let number = Int(digits)
        else { return nil }
        return GitHubItem(owner: owner, repository: repository, number: number, kind: section == "pull" ? .pull : .issue)
    }

    /// The URL an Issue or a pull request is read at.
    public var url: String {
        "https://github.com/\(owner)/\(repository)/\(kind == .pull ? "pull" : "issues")/\(number)"
    }
}

public enum GitHubBranchNaming {
    private static let sigil = TextPattern("#([0-9]+)")
    private static let bare = TextPattern("^(?:[^/]*/)+([0-9]+)-")

    /// The Issue a branch name says it is for, by DevHub's own naming
    /// convention.
    ///
    /// This is the fallback, not the record: how a branch made outside DevHub —
    /// by hand, by an agent, on another machine — can still be recognised.
    ///
    /// `#128` is read wherever it appears: in a branch name `#` means an Issue
    /// and means nothing else. A bare `128` has to look like the name DevHub
    /// itself would have made: `feature/128-…`, the number first in its path
    /// segment and a dash after it. Both halves are load-bearing, because a
    /// bare number in a branch name is usually not an Issue — dropping the
    /// slash makes `v2-rewrite` an Issue, and dropping the dash makes
    /// `release/2024` one.
    public static func issueNumber(fromBranch branch: String) -> Int? {
        if let found = sigil.firstMatch(in: branch)?[1], let number = Int(found) { return number }
        if let found = bare.firstMatch(in: branch)?[1], let number = Int(found) { return number }
        return nil
    }

    /// The branch DevHub starts an Issue on, before anybody knows what to call
    /// it: `feature/128-wip`.
    ///
    /// The flow does not ask for a branch name, because the good name is the
    /// one you have *after* reading the Issue. It matches `issueNumber`, so a
    /// workspace on it is linked to its Issue from the first second, and stays
    /// linked through the rename as long as the new name keeps the number.
    public static func wipBranch(forIssue number: Int) -> String {
        "feature/\(number)-wip"
    }
}
