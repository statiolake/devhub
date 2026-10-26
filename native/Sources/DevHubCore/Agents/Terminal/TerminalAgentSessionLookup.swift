// Port of the terminal-session half of
// apps/desktop/src/main/agent/conversation/resume.ts (`terminalSession`,
// `PANE_PROCESSES_SCRIPT`, `parsePaneRecords`, `codexPaneThread`,
// `claudeConfigDirectory`) and its two failures in failures.ts.
//
// The session a terminal Agent's CLI is in, found from the Agent's own
// processes — the pane's and those under it — so another terminal of the same
// CLI in the same directory is never taken for it. What Restart Session (to
// resume it) and Continue in GUI (to go on with it) both need.

import Foundation

/// Why the session of a terminal Agent could not be told.
public enum TerminalAgentSessionLookupError: Error, Equatable, CustomStringConvertible {
    /// `SessionNotResumable`: the session cannot be told or is not there.
    case notResumable(String)
    /// `SessionsUnreadable`: the machine could not be asked, or answered
    /// something DevHub could not read.
    case unreadable(String)

    public var description: String {
        switch self {
        case .notResumable(let detail), .unreadable(let detail): return detail
        }
    }
}

/// One record `paneProcessesScript` printed.
public struct PaneRecord: Sendable, Equatable {
    public enum Kind: String, Sendable, Equatable { case claude, codex, proc, note }
    public var kind: Kind
    /// nil for a `note` about no one process.
    public var pid: Int?
    /// Seconds since the epoch; a Codex rollout's only.
    public var mtime: Double?
    /// The file; a `proc`'s command, a `note`'s text.
    public var path: String
    public var line: String

    public init(kind: Kind, pid: Int?, mtime: Double?, path: String, line: String) {
        self.kind = kind
        self.pid = pid
        self.mtime = mtime
        self.path = path
        self.line = line
    }
}

public enum TerminalAgentSessionLookup {
    /// What the processes of a pane hold of a CLI's sessions, asked of the
    /// machine in one `sh -c`:
    ///
    /// - `claude`: the record Claude keeps of each running process,
    ///   `$3/<pid>.json` (`$3` is `<config>/sessions`), which names the session
    ///   the process is in and follows `/clear` and `/resume` inside it;
    /// - `codex`: each Codex rollout (`rollout-*.jsonl`) the process holds open
    ///   — the threads it is writing — with its modification time and first
    ///   line (`session_meta`). Every process looked at is a `proc` record too,
    ///   and what could not be looked at a `note`.
    ///
    /// Each record is a header line — kind, pid, modification time, path, by
    /// tabs — and the file's first line. The process tree is `ps` where there
    /// is one and `/proc` where not; open files are `/proc/<pid>/fd` or else
    /// `lsof` (macOS; `$4` = `lsof` takes that way where there is `/proc` too,
    /// for its tests). `lsof` is asked once for every process of the pane.
    ///
    /// The text is byte-identical to the TS app's.
    public static let paneProcessesScript = #"""
pane=$1 kind=$2 dir=$3 files=${4:-}
if command -v ps >/dev/null 2>&1; then
	table=$(ps -A -o pid= -o ppid= -o comm=) || exit 70
elif [ -d /proc/self ]; then
	table=$(for s in /proc/[0-9]*/stat; do sed -n 's/^\([0-9]*\) (\(.*\)) [A-Za-z] \([0-9]*\) .*/\1 \3 \2/p' "$s" 2>/dev/null; done)
else
	echo "there is neither ps nor /proc to find the processes under pane $pane" >&2
	exit 69
fi
if [ "$kind" = codex ] && [ ! -d /proc/self/fd ] && ! command -v lsof >/dev/null 2>&1; then
	echo "there is neither /proc nor lsof to find the files Codex holds open" >&2
	exit 69
fi
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
tree=$(printf '%s\n' "$table" | awk -v root="$pane" '
{ cmd = $0; sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]*/, "", cmd); name[$1] = cmd; kids[$2] = kids[$2] " " $1 }
END { q[1] = root; n = 1; for (i = 1; i <= n; i++) { print q[i] " " name[q[i]]; m = split(kids[q[i]], c, " "); for (j = 1; j <= m; j++) q[++n] = c[j] } }
')
if [ "$kind" = claude ]; then
	printf '%s\n' "$tree" | while read -r pid comm; do
		f="$dir/$pid.json"
		[ -f "$f" ] || continue
		printf 'claude\t%s\t\t%s\n' "$pid" "$f"
		tr -d '\n' <"$f"
		echo
	done
	exit 0
fi
printf '%s\n' "$tree" | while read -r pid comm; do
	printf 'proc\t%s\t\t%s\n\n' "$pid" "$comm"
done
rollouts() { awk -v p="$1" '/\/rollout-[^\/]*\.jsonl$/ { print p "\t" $0 }'; }
if [ -d /proc/self/fd ] && [ "$files" != lsof ]; then
	open=$(printf '%s\n' "$tree" | while read -r pid comm; do
		for fd in /proc/"$pid"/fd/*; do readlink "$fd" 2>/dev/null; done | rollouts "$pid"
	done)
else
	pids=$(printf '%s\n' "$tree" | awk '{ printf "%s%s", (NR > 1 ? "," : ""), $1 }')
	listed=$(lsof -n -P -Fn -p "$pids" 2>/dev/null)
	status=$?
	open=$(printf '%s\n' "$listed" | awk '/^p/ { p = substr($0, 2); next } /^n/ && p != "" { f = substr($0, 2); if (f ~ /\/rollout-[^\/]*\.jsonl$/) print p "\t" f }')
	[ "$status" -eq 0 ] || printf 'note\t\t\tlsof exited %s listing the files of processes %s\n\n' "$status" "$pids"
fi
printf '%s\n' "$open" | sort -u | while IFS='	' read -r pid f; do
	[ -n "$f" ] && [ -f "$f" ] || continue
	printf 'codex\t%s\t%s\t%s\n' "$pid" "$(mtime "$f")" "$f"
	head -n 1 "$f" | head -c 1048576 | tr -d '\n'
	echo
done

"""#

    /// What `paneProcessesScript` printed, as records.
    public static func parsePaneRecords(_ text: String) throws -> [PaneRecord] {
        var lines = text.scalarSplit("\n")
        if lines.last == "" { lines.removeLast() }
        if lines.count % 2 != 0 {
            throw TerminalAgentSessionLookupError.unreadable("the listing of a pane's processes ended between a record's two lines")
        }
        var records: [PaneRecord] = []
        var index = 0
        while index < lines.count {
            let header = lines[index].scalarSplit("\t")
            let kind = PaneRecord.Kind(rawValue: header[0])
            let pid = header.count > 1 ? header[1] : nil
            let digits = pid.map { !$0.isEmpty && $0.allSatisfy { $0.isASCII && $0.isNumber } } ?? false
            guard let kind, digits || (kind == .note && pid == "") else {
                throw TerminalAgentSessionLookupError.unreadable(
                    "the listing of a pane's processes has a record DevHub did not ask for: \(jsonQuoted(lines[index]))"
                )
            }
            let mtime = header.count > 2 ? header[2] : nil
            records.append(PaneRecord(
                kind: kind,
                pid: pid == "" ? nil : Int(pid!),
                mtime: mtime == nil || mtime == "" ? nil : Double(mtime!),
                path: header.count > 3 ? header[3...].joined(separator: "\t") : "",
                line: lines[index + 1]
            ))
            index += 2
        }
        return records
    }

    /// `JSON.stringify` of a string, for a sentence that quotes one.
    static func jsonQuoted(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value], options: [.withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8)
        else { return "\"\(value)\"" }
        return String(text.dropFirst().dropLast())
    }

    /// Where Claude keeps its state: `CLAUDE_CONFIG_DIR`, the profile's before
    /// the machine's.
    public static func claudeConfigDirectory(_ runtime: any MachineRuntime, profileEnv: [String: String]) async throws -> String {
        if let configured = profileEnv["CLAUDE_CONFIG_DIR"] { return configured }
        if let configured = try await runtime.environment()["CLAUDE_CONFIG_DIR"] { return configured }
        return "\(try await runtime.home())/.claude"
    }

    /// Ask the machine what the processes of pane `panePid` hold of `kind`'s
    /// sessions.
    static func paneRecords(
        _ runtime: any MachineRuntime,
        kind: AgentProfileKind,
        panePid: Int,
        directory: String,
        files: FilesWay
    ) async throws -> [PaneRecord] {
        let what = "DevHub could not read the processes of the terminal Agent's pane (pid \(panePid))"
        let answer: ExecResult
        do {
            answer = try await runtime.exec(ExecRequest(
                argv: ["sh", "-c", paneProcessesScript, "sh", String(panePid), kind.rawValue, directory, files == .lsof ? "lsof" : ""],
                env: try await runtime.environment(),
                deadline: OperationDeadline.within(15_000),
                cancel: CancellationToken(),
                limits: ExecLimits(
                    stdoutBytes: 16 * 1024 * 1024,
                    stderrBytes: 16 * 1024,
                    overflow: .fail({ portFailure(.failed, detail: "the processes of pane \(panePid) held more than DevHub will read") })
                )
            ))
        } catch let failure as TerminalAgentSessionLookupError {
            throw failure
        } catch {
            throw TerminalAgentSessionLookupError.unreadable("\(what)\(runtime.where): \(RuntimeFailureText.of(error))")
        }
        if answer.code != 0 {
            let said = answer.stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
            let status = answer.code.map(String.init) ?? answer.signal.map { "signal \($0)" } ?? "?"
            throw TerminalAgentSessionLookupError.unreadable("\(what)\(runtime.where): \(said.isEmpty ? "exit \(status)" : said)")
        }
        return try parsePaneRecords(answer.stdoutText)
    }

    /// How a pane's open files are read: `/proc` where there is one, or
    /// `lsof` (as on macOS) even where there is `/proc`, for its tests.
    public enum FilesWay: Sendable { case auto, lsof }

    /// The session a terminal Agent's CLI is in, for a GUI Agent to go on
    /// with, or for Restart Session to resume.
    ///
    /// Claude: the record Claude keeps of its running process,
    /// `<config>/sessions/<pid>.json`, whose `sessionId` follows the session
    /// the TUI is in; the outermost Claude under the pane is the Agent's. A pane
    /// none of whose processes has one is refused, saying where DevHub looked.
    ///
    /// Codex: the thread whose rollout the Agent's Codex holds open
    /// (`codexPaneThread` says which when it holds several).
    ///
    /// Nothing of it is kept: each ask looks again.
    public static func terminalSession(
        _ runtime: any MachineRuntime,
        kind: AgentProfileKind,
        profileEnv: [String: String],
        panePid: Int,
        files: FilesWay = .auto
    ) async throws -> String {
        switch kind {
        case .claude:
            let sessions = "\(try await claudeConfigDirectory(runtime, profileEnv: profileEnv))/sessions"
            let records = try await paneRecords(runtime, kind: .claude, panePid: panePid, directory: sessions, files: .auto)
            guard let outermost = records.first else {
                throw TerminalAgentSessionLookupError.notResumable(
                    "DevHub cannot tell which Claude session this terminal Agent is in: no process of its pane (pid \(panePid)\(runtime.where)) has Claude's record of it in \(sessions). Claude keeps one (<pid>.json) for as long as it runs in a terminal; there is none when Claude is no longer running in the pane, or when it is a version too old to keep one."
                )
            }
            return try claudeProcessSession(outermost, where: runtime.where)
        case .codex:
            return try codexPaneThread(
                try await paneRecords(runtime, kind: .codex, panePid: panePid, directory: "", files: files),
                where: "pane pid \(panePid)\(runtime.where)"
            )
        default:
            throw NoSessionsForKind(kind: kind, what: "list")
        }
    }

    /// `rollout-<time>-<thread id>.jsonl`: the thread's id, from the file's name.
    static let rolloutName = try! NSRegularExpression(
        pattern: #"(?:^|/)rollout-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-([^/]+)\.jsonl$"#
    )

    static func rolloutThread(_ path: String) -> String? {
        guard let match = rolloutName.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)),
              let range = Range(match.range(at: 1), in: path)
        else { return nil }
        return String(path[range])
    }

    /// Whether a `session_meta.source` is a subagent's — spelled `subagent`
    /// in the rollouts Codex writes and `subAgent` on the wire; either, as a
    /// key or a kind's name.
    static func isSubagentSource(_ source: Any?) -> Bool {
        func subagent(_ name: String) -> Bool {
            name.replacingOccurrences(of: "_", with: "").replacingOccurrences(of: "-", with: "").lowercased().hasPrefix("subagent")
        }
        if let text = source as? String { return subagent(text) }
        if let object = source as? [String: Any] { return object.keys.contains(where: subagent) }
        return false
    }

    /// The thread the Codex of a pane is in, from what its processes hold open.
    ///
    /// Any thread but a subagent's. Of several, the one written last. A rollout
    /// whose first line cannot be read is still the thread its file's name
    /// says, taken only when no other is readable.
    public static func codexPaneThread(_ records: [PaneRecord], where place: String) throws -> String {
        var readable: [(id: String, mtime: Double)] = []
        var unread: [(id: String, mtime: Double)] = []
        var passed: [String] = []
        for record in records where record.kind == .codex {
            let named = rolloutThread(record.path)
            let mtime = record.mtime ?? 0
            guard let payload = sessionMeta(record.line) else {
                if let named { unread.append((named, mtime)) }
                passed.append("\(record.path) (its first line is not a session_meta)")
                continue
            }
            if isSubagentSource(payload.source) {
                passed.append("\(record.path) (a subagent's)")
                continue
            }
            readable.append((payload.id, mtime))
        }
        func newest(_ threads: [(id: String, mtime: Double)]) -> (id: String, mtime: Double)? {
            threads.reduce(nil) { best, thread in
                best == nil || thread.mtime > best!.mtime ? thread : best
            }
        }
        if let found = newest(readable) ?? newest(unread) { return found.id }
        let processes = records.filter { $0.kind == .proc }.map { "\($0.path.isEmpty ? "?" : $0.path) (\($0.pid.map(String.init) ?? "undefined"))" }
        let notes = records.filter { $0.kind == .note }.map(\.path)
        let codexRuns = processes.contains { $0.range(of: "codex", options: .caseInsensitive) != nil }
        let parts = [
            "The Codex of this terminal Agent (\(place)) has no thread open yet: Codex writes a thread from its first turn.",
            codexRuns ? "" : "No process in the pane is Codex: it may have exited, or not have started yet.",
            "Processes looked at: \(processes.isEmpty ? "none" : processes.joined(separator: ", ")).",
            passed.isEmpty ? "" : "Rollouts open but not taken: \(passed.joined(separator: "; ")).",
            notes.isEmpty ? "" : "\(notes.joined(separator: "; ")).",
        ]
        throw TerminalAgentSessionLookupError.notResumable(parts.filter { !$0.isEmpty }.joined(separator: " "))
    }

    /// A rollout's first line's thread and source, when it is a
    /// `session_meta` naming one.
    static func sessionMeta(_ line: String) -> (id: String, source: Any?)? {
        guard let data = line.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
              let meta = value as? [String: Any],
              meta["type"] as? String == "session_meta",
              let payload = meta["payload"] as? [String: Any],
              let id = payload["id"] as? String
        else { return nil }
        return (id, payload["source"])
    }

    /// The `sessionId` of Claude's record of one of its processes.
    static func claudeProcessSession(_ record: PaneRecord, where place: String) throws -> String {
        guard let data = record.line.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
              let object = value as? [String: Any]
        else {
            throw TerminalAgentSessionLookupError.unreadable("\(record.path)\(place) does not begin with a JSON object")
        }
        guard let session = object["sessionId"] as? String, !session.isEmpty else {
            throw TerminalAgentSessionLookupError.unreadable("Claude's record \(record.path)\(place) names no sessionId")
        }
        return session
    }
}
