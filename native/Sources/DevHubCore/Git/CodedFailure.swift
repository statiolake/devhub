// The failures WP4 raises, in the words they are shown in.
//
// Port of the parts of apps/desktop/src/model/wire.ts that git.ts, github.ts
// and usageReaders.ts lean on: `NamedFailure` (a failure DevHub knows by
// name), `errorWireAt` + `withSummary` / `withDetail`, and `failureText`.
// The full `AppErrorWire` (module, actions, timestamps) belongs to the model
// (WP2); this keeps exactly what a git refusal, a GitHub refusal and a usage
// reader's failure carry — a code, the title it is drawn under, and the
// raiser's own sentence — so WP2 can map it onto its wire one to one.

import Foundation

/// A failure DevHub knows by name: a code, the title it is drawn under, and the
/// raiser's own words as the detail.
///
/// `summary` is the code's own sentence unless the raiser gave a sharper one
/// (`withSummary`: git's own last line). `detail` is the raiser's sentence
/// (`withDetail`: GitHub's own words), never carrying a token.
public struct CodedFailure: Error, Equatable, Sendable, CustomStringConvertible {
    public let code: String
    public let summary: String
    public let detail: String?

    public init(code: String, summary: String? = nil, detail: String? = nil) {
        self.code = code
        let fallback = CodedFailure.safeSummaries[code] ?? "DevHub could not do that."
        if let summary, !summary.isEmpty { self.summary = summary } else { self.summary = fallback }
        if let detail, !detail.isEmpty {
            self.detail = detail.count <= 4096 ? detail : String(detail.prefix(4096)) + "…"
        } else {
            self.detail = nil
        }
    }

    /// The failure as one line of text: its title and its detail.
    public var text: String {
        guard let detail else { return summary }
        return "\(summary) \(detail)"
    }

    public var description: String { text }

    /// Whether trying again could change anything (`errorWireAt`'s `actions`).
    /// A usage reader's failure is retried on its own at the next reading.
    public var offersRetry: Bool { code != "usage_unreadable" }

    /// The titles of the codes this package raises, verbatim from
    /// `ipc/appShell.ts` `SAFE_ERROR_SUMMARY`.
    static let safeSummaries: [String: String] = [
        "workspace_unavailable": "The workspace is unavailable.",
        "github_unavailable": "DevHub could not get this from GitHub.",
        "git_fetch_failed": "The latest changes could not be fetched from the remote.",
        "usage_unreadable": "DevHub could not read a CLI's usage limits. It tries again at the next reading.",
    ]

    // MARK: The failures of git.ts

    /// `workspaceFailure`: a refusal in the words it should be read in.
    ///
    /// "That folder already exists", "Repository not found", "fatal: 'x' is
    /// already checked out" — the whole value of these failing is that a person
    /// can act on each one, so the sentence is the title.
    public static func workspace(_ summary: String) -> CodedFailure {
        CodedFailure(code: "workspace_unavailable", summary: summary)
    }

    /// `fetchFailure`: the fetch before a new branch did not work.
    ///
    /// Its own code, because it is the only one here that has a second answer:
    /// `origin` as of the last successful fetch is still on disk, and whether to
    /// start a branch from a copy that may be days old is the person's call.
    public static func fetch(_ reason: String) -> CodedFailure {
        CodedFailure(code: "git_fetch_failed", summary: "The latest changes could not be fetched: \(reason)")
    }

    // MARK: github.ts

    /// `GitHubUnavailable`: GitHub's own words, or DevHub's about what GitHub
    /// answered — never the token.
    public static func gitHub(_ reason: String) -> CodedFailure {
        CodedFailure(code: "github_unavailable", detail: reason)
    }

    public var isGitHubUnavailable: Bool { code == "github_unavailable" }

    // MARK: usageReaders.ts

    public static func usageUnreadable(_ detail: String) -> CodedFailure {
        CodedFailure(code: "usage_unreadable", detail: detail)
    }
}

/// Any failure as one line of text (`failureText`): a coded failure as its
/// title and its detail, anything else as its own description.
public func failureText(_ error: Error) -> String {
    if let coded = error as? CodedFailure { return coded.text }
    return String(describing: error)
}
