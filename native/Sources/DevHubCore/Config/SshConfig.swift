// Port of apps/desktop/src/model/sshConfig.ts
//
// The hosts a person has already written down.
//
// Somebody who works on a machine over SSH has named it once, in
// `~/.ssh/config`, and typing `deploy@build.example.com` into a picker to reach
// a machine they already call `build` is asking them to say it twice. So the
// picker offers what the file says, and the alias — not the hostname behind it
// — is what travels: `ssh` resolves the alias.
//
// This reads the file's *shape*, not its meaning. `Host` and `Include` are the
// only two keywords it knows; everything else is a line it steps over: a parser
// that half-understood `Match` would be a parser that quietly offered the wrong
// machine.
//
// Nothing here touches the filesystem. `Include` is resolved by the caller,
// which hands the contents back in.

import Foundation

/// A destination the picker can offer: the alias, and the `HostName` and
/// `User` behind it when the file names them — shown, never sent.
public struct SshConfigHost: Equatable, Hashable, Sendable {
    public var alias: String
    public var hostName: String?
    public var user: String?

    public init(alias: String, hostName: String? = nil, user: String? = nil) {
        self.alias = alias
        self.hostName = hostName
        self.user = user
    }
}

/// What one `Include` line asks for, before anything has looked for it.
public struct SshConfigInclude: Equatable, Hashable, Sendable {
    public var pattern: String
    public init(pattern: String) { self.pattern = pattern }
}

public struct SshConfigContents: Equatable, Sendable {
    public var hosts: [SshConfigHost]
    public var includes: [SshConfigInclude]

    public init(hosts: [SshConfigHost] = [], includes: [SshConfigInclude] = []) {
        self.hosts = hosts
        self.includes = includes
    }
}

public enum SshConfig {
    /// A `Host` line's patterns, or an `Include`'s, split the way OpenSSH
    /// splits them: on whitespace, with double quotes grouping.
    static func splitArguments(_ rest: String) -> [String] {
        var values: [String] = []
        var current = ""
        var quoted = false
        var started = false
        for scalar in rest.unicodeScalars {
            if scalar == "\"" {
                quoted.toggle()
                started = true
                continue
            }
            if !quoted && JSString.isWhitespace(scalar) {
                if started { values.append(current) }
                current = ""
                started = false
                continue
            }
            current.unicodeScalars.append(scalar)
            started = true
        }
        if started { values.append(current) }
        return values
    }

    /// The keyword and the rest of a line, or nothing for a line that is
    /// neither. OpenSSH accepts `Host foo`, `Host=foo` and `Host = foo` alike,
    /// and its keywords are case-insensitive. A comment is a line whose first
    /// non-blank character is `#`; a `#` in the middle of a line is not one.
    static func keyword(_ line: String) -> (keyword: String, rest: String)? {
        let trimmed = Array(JSString.trim(line).unicodeScalars)
        guard let first = trimmed.first, first != "#" else { return nil }
        func isLetter(_ s: Unicode.Scalar) -> Bool { ("A"..."Z").contains(s) || ("a"..."z").contains(s) }
        guard isLetter(first) else { return nil }
        var index = 1
        while index < trimmed.count, isLetter(trimmed[index]) || ("0"..."9").contains(trimmed[index]) || trimmed[index] == "-" { index += 1 }
        var word = String.UnicodeScalarView()
        word.append(contentsOf: trimmed[0..<index])
        // `\s*=?\s*(.*)$`: what follows the keyword must be space or `=`.
        var at = index
        while at < trimmed.count, JSString.isWhitespace(trimmed[at]) { at += 1 }
        if at < trimmed.count, trimmed[at] == "=" {
            at += 1
            while at < trimmed.count, JSString.isWhitespace(trimmed[at]) { at += 1 }
        }
        // `(.*)$` cannot cross a line terminator, so a line with one inside it
        // is no keyword line at all.
        if trimmed[at...].contains(where: { $0 == "\r" || $0 == "\n" || $0 == "\u{2028}" || $0 == "\u{2029}" }) { return nil }
        var rest = String.UnicodeScalarView()
        rest.append(contentsOf: trimmed[at...])
        return (String(word).lowercased(), String(rest))
    }

    /// A pattern, rather than the name of one machine: `Host *`, `Host
    /// *.example.com` and a negation are not anywhere a person can connect to.
    static func isPattern(_ alias: String) -> Bool {
        alias.jsIncludes("*") || alias.jsIncludes("?") || alias.jsStartsWith("!")
    }

    /// What one config file says. A `Host` line opens a block, and `HostName`
    /// and `User` inside it belong to every alias that line named.
    public static func parse(_ text: String) -> SshConfigContents {
        var hosts: [SshConfigHost] = []
        var includes: [SshConfigInclude] = []
        // Indices into `hosts` of the rows the current `Host` block opened.
        var open: [Int] = []
        for line in splitLines(text) {
            guard let parsed = keyword(line) else { continue }
            switch parsed.keyword {
            case "host":
                open = []
                for alias in splitArguments(parsed.rest) where !isPattern(alias) {
                    open.append(hosts.count)
                    hosts.append(SshConfigHost(alias: alias))
                }
            case "include":
                for pattern in splitArguments(parsed.rest) { includes.append(SshConfigInclude(pattern: pattern)) }
            case "hostname", "user":
                guard let value = splitArguments(parsed.rest).first else { continue }
                for index in open {
                    // The first one wins, which is OpenSSH's rule for every keyword.
                    if parsed.keyword == "hostname" {
                        if hosts[index].hostName == nil { hosts[index].hostName = value }
                    } else if hosts[index].user == nil {
                        hosts[index].user = value
                    }
                }
            default:
                continue
            }
        }
        return SshConfigContents(hosts: hosts, includes: includes)
    }

    /// `text.split(/\r?\n/)`.
    static func splitLines(_ text: String) -> [String] {
        // Over scalars: a Swift `Character` holds `\r\n` as one, so splitting
        // the string on "\n" would not see the CRLF lines at all.
        var lines: [String] = []
        var current = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            if scalar == "\n" {
                if current.last == "\r" { current.removeLast() }
                lines.append(String(current))
                current = String.UnicodeScalarView()
            } else {
                current.append(scalar)
            }
        }
        lines.append(String(current))
        return lines
    }

    /// Every host across a config file and the files it includes, in the order
    /// they were read, with the first mention of an alias winning — OpenSSH's
    /// own precedence.
    public static func collectHosts(_ files: [SshConfigContents]) -> [SshConfigHost] {
        var seen = Set<String>()
        var hosts: [SshConfigHost] = []
        for file in files {
            for host in file.hosts where !seen.contains(host.alias) {
                seen.insert(host.alias)
                hosts.append(host)
            }
        }
        return hosts
    }
}
