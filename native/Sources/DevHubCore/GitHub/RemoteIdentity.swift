// Port of `remoteIdentity` (and `RemoteIdentity`) from
// apps/desktop/src/model/domain.ts.
//
// Here rather than in the model because every reader of a remote in WP4 —
// `readRepository`, the Issue clone search, the repository status poller —
// compares remotes by this identity, and WP2's `Repository.matchesRemote`
// reuses it.

import Foundation

/// A normalised remote identity. Credentials, scheme, leading slash and a
/// trailing `.git` are deliberately absent, so HTTPS and SSH aliases compare
/// equal without touching Git or the network.
public struct RemoteIdentity: Hashable, Sendable, Codable, CustomStringConvertible, Comparable {
    public let rawValue: String

    /// An identity already normalised (as `state.json` stores one).
    public init(normalized rawValue: String) { self.rawValue = rawValue }

    public var description: String { rawValue }

    public static func < (lhs: RemoteIdentity, rhs: RemoteIdentity) -> Bool { lhs.rawValue < rhs.rawValue }

    public init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    /// `DomainErrorCode.InvalidRemote`.
    public struct Invalid: Error, Equatable, Sendable, CustomStringConvertible {
        public let input: String
        public var description: String { "INVALID_REMOTE" }
    }

    private enum Scheme { case bare, scp, http, https, ssh }

    private static func defaultPort(_ scheme: Scheme) -> Int? {
        switch scheme {
        case .bare, .scp: return nil
        case .http: return 80
        case .https: return 443
        case .ssh: return 22
        }
    }

    /// `remoteIdentity(input)`: throws `Invalid` for a remote that cannot be
    /// normalised.
    public static func parse(_ input: String) throws -> RemoteIdentity {
        let raw = input.jsTrimmed
        guard !raw.isEmpty, !raw.contains("\0") else { throw Invalid(input: input) }
        let withoutQuery = String(raw.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0]
            .split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0])

        var authority: String
        var path: String
        var scheme: Scheme
        if !withoutQuery.contains("://") {
            if let colon = withoutQuery.firstIndex(of: ":") {
                let before = withoutQuery[..<colon]
                guard let at = before.lastIndex(of: "@") else { throw Invalid(input: input) }
                authority = String(withoutQuery[withoutQuery.index(after: at)..<colon])
                path = String(withoutQuery[withoutQuery.index(after: colon)...])
                scheme = .scp
            } else {
                guard let slash = withoutQuery.firstIndex(of: "/") else { throw Invalid(input: input) }
                authority = String(withoutQuery[..<slash])
                path = String(withoutQuery[withoutQuery.index(after: slash)...])
                scheme = .bare
            }
        } else if let match = TextPattern("^(https|http|ssh)://(.*)$", options: [.dotMatchesLineSeparators]).firstMatch(in: withoutQuery),
                  let name = match[1], let rest = match[2] {
            scheme = name == "https" ? .https : name == "http" ? .http : .ssh
            guard let slash = rest.firstIndex(of: "/") else { throw Invalid(input: input) }
            let rawAuthority = rest[..<slash]
            if let at = rawAuthority.lastIndex(of: "@") {
                authority = String(rawAuthority[rawAuthority.index(after: at)...])
            } else {
                authority = String(rawAuthority)
            }
            path = String(rest[rest.index(after: slash)...])
        } else {
            throw Invalid(input: input)
        }

        let (rawHost, rawPort) = try normalizeAuthority(authority, input: input)
        let port: Int? = defaultPort(scheme) != nil && rawPort == defaultPort(scheme) ? nil : rawPort

        var normalizedPath = path.jsTrimmed
        while normalizedPath.hasPrefix("/") { normalizedPath.removeFirst() }
        while normalizedPath.hasSuffix("/") { normalizedPath.removeLast() }
        if normalizedPath.hasSuffix(".git") { normalizedPath.removeLast(4) }
        let host = rawHost.jsTrimmed
        let whitespace = TextPattern("\\s")
        if host.isEmpty || normalizedPath.isEmpty || whitespace.matches(host) || whitespace.matches(normalizedPath)
            || normalizedPath.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) {
            throw Invalid(input: input)
        }
        let lowerHost = host.lowercased()
        let finalPath = lowerHost == "github.com" ? normalizedPath.lowercased() : normalizedPath
        let finalAuthority = port.map { "\(lowerHost):\($0)" } ?? lowerHost
        return RemoteIdentity(normalized: "\(finalAuthority)/\(finalPath)")
    }

    /// The identity, or `nil` for a remote DevHub cannot normalise.
    public static func normalize(_ input: String) -> RemoteIdentity? { try? parse(input) }

    private static func normalizeAuthority(_ authority: String, input: String) throws -> (String, Int?) {
        let trimmed = authority.jsTrimmed
        if let colon = trimmed.lastIndex(of: ":"), colon > trimmed.startIndex {
            let host = String(trimmed[..<colon])
            let port = String(trimmed[trimmed.index(after: colon)...])
            if !host.isEmpty, !port.isEmpty, port.allSatisfy({ $0.isASCII && $0.isNumber }), let number = Int(port) {
                return (host, number)
            }
        }
        if trimmed.isEmpty { throw Invalid(input: input) }
        return (trimmed, nil)
    }
}
