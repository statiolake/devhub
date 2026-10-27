// Port of apps/desktop/src/shell/conversation/textLinks.ts and the pure half
// of issueLinks.tsx.
//
// The links in a piece of the conversation's text, found by their spelling
// alone: file paths, and GitHub Issue and pull request references.
//
// One tokenizer for both, so a word is read once and is at most one of them:
// `owner/repo#12` is a reference and never also a path, and `src/a.ts#L12` is
// a path's line and never a reference. Every place a path is looked for is a
// place a reference is looked for (`LinkedText`), and no other.
//
// **Paths.** This is the first of two gates, and the loose one: it says which
// words *could* name a file, and Core says which of those do, on the Agent's
// own machine (`resolvePathCandidates`). Only a word both gates pass is drawn
// as a link, so this side leans towards asking — a word that is not a file
// costs one line of a batched `test -f` — and never towards guessing a link.
//
// **References.** `#12` and `owner/repo#12`, which GitHub itself links. A
// reference needs no second gate: `owner/repo#12` names its repository, and a
// bare `#12` is a link only when the Agent's Workspace has a GitHub
// repository to number it in (`IssueRepository`).
//
// The rule, which `docs/agent-gui.md` states for the person:
//
// - A link is inside one word. Whitespace, quotes, backticks, brackets and
//   braces, `, ; | = * ?` and CJK punctuation end it, so a path with a space
//   in it, or one quoted in a way this cannot see through, is not found.
// - A word with `://` in it is a URL, and nothing in it is either kind: a
//   `#12` in a URL is the URL's.
// - A reference is `#` and a number, with `owner/repo` before it or not, not
//   run on from a letter, digit, `/`, `.`, `#`, `&` or `@` before it
//   (`PR#12`, `a.ts#12`, `&#12;`) nor into one after it (`#12a`). Anything
//   else, CJK included, may stand either side: `#12を` is `#12`. A word with a
//   reference in it is not also looked through for a path.
// - A path has no `:` in it: the first colon starts its position. `:12`,
//   `:12:5` and `:12-20` are a line, a line and column, and a range of lines;
//   GitHub's `#L12` and `#L12-L20` are the same line and range. Whatever
//   follows the position (`src/a.ts:12:const x` in grep's output) is not part
//   of the link.
// - A word is a path candidate when it is absolute, starts with `~/`, or is
//   relative and either has a `/` in it or ends in a file extension (`a.ts`).
//   A trailing full stop or `!` is the sentence's, not the file's.
//
// Offsets are UTF-16 code units, as the TS side's and as AppKit's ranges are.

import Foundation

/// A path as the text spells it, and where it points in the file.
public struct PathCandidate: Hashable, Sendable {
    /// As written: absolute, `~/…`, or relative to the Agent's directory.
    public var path: String
    public var range: FileRange?

    public init(path: String, range: FileRange?) {
        self.path = path
        self.range = range
    }
}

/// An Issue or pull request, as the text names it.
public struct TextIssueReference: Hashable, Sendable {
    /// `owner/repo` as written, or nil for a bare `#12`.
    public var owner: String?
    public var repository: String?
    public var number: Int

    public init(owner: String?, repository: String?, number: Int) {
        self.owner = owner
        self.repository = repository
        self.number = number
    }
}

public enum LinkSpan: Hashable, Sendable {
    case path(PathCandidate, start: Int, end: Int)
    case issue(TextIssueReference, start: Int, end: Int)

    public var start: Int {
        switch self {
        case .path(_, let start, _), .issue(_, let start, _): return start
        }
    }

    public var end: Int {
        switch self {
        case .path(_, _, let end), .issue(_, _, let end): return end
        }
    }
}

public enum TextLinks {
    private static func regex(_ pattern: String) -> NSRegularExpression {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: pattern)
    }

    /// Everything that ends a word, a path's included.
    private static let word = regex("[^\\s\"'`<>()\\[\\]{},;|=*?\\x{3000}-\\x{303f}\\x{ff08}\\x{ff09}\\x{ff0c}\\x{ff1a}]+")

    /// `:12`, `:12:5`, `:12-20`, `#L12`, `#L12-L20`, at the start of what follows a path.
    private static let position = regex("^(?::([0-9]+)(?:([:-])([0-9]+))?|#L([0-9]+)(?:-L([0-9]+))?)")

    /// A relative name without a `/` is a candidate only as a file with an extension.
    private static let fileName = regex("^\\.?[A-Za-z0-9_@+.-]*[A-Za-z][A-Za-z0-9_@+.-]*\\.[A-Za-z0-9]{1,12}$")

    /// `#12` or `owner/repo#12`, inside a word. The owner is GitHub's spelling
    /// of a login (letters, digits, single hyphens); the repository is
    /// GitHub's of a name. `\w` is JavaScript's: ASCII.
    private static let issue = regex(
        "(?<![A-Za-z0-9_./#&@-])(?:([A-Za-z0-9](?:-?[A-Za-z0-9])*)/([A-Za-z0-9_.-]+))?#([1-9][0-9]{0,9})(?![A-Za-z0-9_])")

    private static let githubLine = regex("#L[0-9]")

    /// Every link candidate in `text`, in order, none overlapping.
    public static func spans(_ text: String) -> [LinkSpan] {
        let ns = text as NSString
        var spans: [LinkSpan] = []
        for match in word.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let wordText = ns.substring(with: match.range)
            if wordText.contains("://") { continue }
            let issues = issueSpans(wordText, match.range.location)
            if !issues.isEmpty {
                spans += issues
                continue
            }
            if let path = pathSpan(wordText, match.range.location) { spans.append(path) }
        }
        return spans
    }

    private static func group(_ match: NSTextCheckingResult, _ index: Int, _ text: NSString) -> String? {
        let range = match.range(at: index)
        return range.location == NSNotFound ? nil : text.substring(with: range)
    }

    private static func issueSpans(_ word: String, _ start: Int) -> [LinkSpan] {
        let ns = word as NSString
        return issue.matches(in: word, range: NSRange(location: 0, length: ns.length)).compactMap { match in
            guard let numberText = group(match, 3, ns), let number = Int(numberText) else { return nil }
            let owner = group(match, 1, ns)
            let repository = group(match, 2, ns)
            let reference = TextIssueReference(
                owner: owner != nil && repository != nil ? owner : nil,
                repository: owner != nil && repository != nil ? repository : nil, number: number)
            return .issue(reference, start: start + match.range.location, end: start + NSMaxRange(match.range))
        }
    }

    /// Where a path ends in `word`: its first `:`, or its first `#L` and a digit.
    private static func cut(_ word: NSString) -> Int {
        var cut = word.length
        let colon = word.range(of: ":")
        if colon.location != NSNotFound { cut = min(cut, colon.location) }
        if let hash = githubLine.firstMatch(in: word as String, range: NSRange(location: 0, length: word.length)) {
            cut = min(cut, hash.range.location)
        }
        return cut
    }

    private static func pathSpan(_ word: String, _ start: Int) -> LinkSpan? {
        let ns = word as NSString
        let at = cut(ns)
        var path = ns.substring(to: at)
        let rest = ns.substring(from: at)
        let found = position.firstMatch(in: rest, range: NSRange(location: 0, length: (rest as NSString).length))
        let range = found.flatMap { rangeOf($0, rest as NSString) }
        if range == nil {
            while let last = path.last, last == "." || last == "!" { path.removeLast() }
        }
        guard isCandidate(path) else { return nil }
        let covered = range == nil ? (path as NSString).length : at + (found?.range.length ?? 0)
        return .path(PathCandidate(path: path, range: range), start: start, end: start + covered)
    }

    private static func rangeOf(_ match: NSTextCheckingResult, _ text: NSString) -> FileRange? {
        let line = Int(group(match, 1, text) ?? group(match, 4, text) ?? "") ?? 0
        guard line >= 1 else { return nil }
        let separator = group(match, 2, text)
        let second = group(match, 3, text)
        let toText = group(match, 5, text) ?? (separator == "-" ? second : nil)
        if let toText, let to = Int(toText) {
            return to > line ? .lines(from: line, to: to) : .line(line: line, column: 1)
        }
        let column = separator == ":" ? Int(second ?? "") ?? 1 : 1
        return .line(line: line, column: column >= 1 ? column : 1)
    }

    private static func isCandidate(_ path: String) -> Bool {
        if path.isEmpty || path.hasSuffix("/") || path.hasPrefix("-") { return false }
        if path.hasPrefix("~"), !path.hasPrefix("~/") { return false }
        if path.contains("/") { return path.unicodeScalars.contains { $0.isASCIIAlphanumeric || $0 == "_" } }
        let ns = path as NSString
        return fileName.firstMatch(in: path, range: NSRange(location: 0, length: ns.length)) != nil
    }

    /// The file a Markdown link's target names, when it names one rather than
    /// a page: `[a.ts](src/a.ts)`, `[a.ts](/abs/a.ts#L12)`,
    /// `[a.ts](file:///abs/a.ts)`. Nil for a URL with any other scheme, and for
    /// an anchor (`#usage`), which are the browser's.
    ///
    /// Unlike a word in prose, a link's target is a path because the Agent
    /// wrote it as one, so it needs no spelling to look like one: only the
    /// second gate applies, when it is followed.
    public static func pathOfHref(_ href: String) -> PathCandidate? {
        var target = href.trimmingCharacters(in: .whitespacesAndNewlines)
        if target.lowercased().hasPrefix("file:") {
            guard let url = URL(string: target) else { return nil }
            let fragment = url.fragment.map { "#" + $0 } ?? ""
            target = (url.path.removingPercentEncoding ?? url.path) + fragment
            if url.path.isEmpty, let components = URLComponents(string: target) { target = components.path }
        } else if target.range(of: "^[A-Za-z][A-Za-z0-9+.-]*:", options: .regularExpression) != nil {
            return nil
        } else {
            // A stray `%` is the name's own.
            target = target.removingPercentEncoding ?? target
        }
        if target.isEmpty || target.hasPrefix("#") { return nil }
        let ns = target as NSString
        let at = cut(ns)
        var path = ns.substring(to: at)
        if let stop = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { path = String(path[..<stop]) }
        if path.isEmpty || path.hasSuffix("/") { return nil }
        let rest = ns.substring(from: at)
        let found = position.firstMatch(in: rest, range: NSRange(location: 0, length: (rest as NSString).length))
        return PathCandidate(path: path, range: found.flatMap { rangeOf($0, rest as NSString) })
    }

    /// `:12`, `:12:5`, `:12-20`: a range as the text after a path would spell it.
    public static func rangeSuffix(_ range: FileRange?) -> String {
        guard let range else { return "" }
        switch range {
        case let .line(line, column): return ":\(line)" + (column == 1 ? "" : ":\(column)")
        case let .lines(from, to): return ":\(from)-\(to)"
        }
    }
}

// MARK: - Issue references on GitHub (issueLinks.tsx)

/// Where a bare `#12` is numbered, and the titles already known there.
public struct IssueRepository: Hashable, Sendable {
    public var owner: String
    public var repository: String
    /// By number: the Workspace's Issue and pull request, as last read.
    public var titles: [Int: String]

    public init(owner: String, repository: String, titles: [Int: String] = [:]) {
        self.owner = owner
        self.repository = repository
        self.titles = titles
    }

    /// Where `reference` is on GitHub, or nil for a bare one with no repository.
    public static func url(_ reference: TextIssueReference, _ here: IssueRepository?) -> String? {
        let owner = reference.owner ?? here?.owner
        let repository = reference.repository ?? here?.repository
        guard let owner, let repository else { return nil }
        return "https://github.com/\(owner)/\(repository)/issues/\(reference.number)"
    }

    /// The title DevHub already knows for the reference: the Workspace's own Issue or pull request.
    public static func title(_ reference: TextIssueReference, _ here: IssueRepository?) -> String? {
        guard let here else { return nil }
        if let owner = reference.owner, let repository = reference.repository {
            guard owner.lowercased() == here.owner.lowercased(), repository.lowercased() == here.repository.lowercased()
            else { return nil }
        }
        return here.titles[reference.number]
    }

    /// The tooltip of a reference's link.
    public static func tooltip(_ reference: TextIssueReference, _ here: IssueRepository?) -> String? {
        guard let url = url(reference, here) else { return nil }
        if let title = title(reference, here) { return "#\(reference.number) \(title)" }
        return url
    }
}

extension IssueRepository {
    /// The Workspace's row of the repository status, as a bare `#12` reads it (`issueRepositoryOf`).
    public init?(_ row: WorkspaceRepositoryWire?) {
        guard let row, let where_ = row.issueRepository else { return nil }
        var titles: [Int: String] = [:]
        if let issue = row.issue { titles[issue.number] = issue.title }
        if let pull = row.pullRequest { titles[pull.number] = pull.title }
        self.init(owner: where_.owner, repository: where_.repository, titles: titles)
    }
}
