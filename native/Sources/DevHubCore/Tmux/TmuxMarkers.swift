// Port of the marker protocol, the formats and the pure readers of
// apps/desktop/src/main/terminal/tmux.ts.
//
// Ownership is never assumed from a name. A session is DevHub's only if the
// server carries `@devhub-protocol 1` *and* the session carries the full
// `@devhub-context` / `@devhub-workspace-id` / `@devhub-root` /
// `@devhub-agent-id` tuple that matches the target being asked for. Anything
// else — a foreign server, a partially created session, a same-named session
// with different metadata — is an opaque resource: it is counted, never named,
// and never killed or repaired in place.
//
// Every string here is wire compatibility with the TypeScript DevHub: the two
// apps share one tmux server and adopt each other's sessions.

import Foundation

extension TmuxNames {
    /// An Agent terminal's session: `tm-<terminal id>`
    /// (`agentTerminalSessionName` in `model/agentTerminal.ts`).
    public static func terminalSession(terminalId: String) -> String { "tm-\(terminalId)" }
}

public enum TmuxMarkers {
    public static let protocolOption = "@devhub-protocol"
    public static let protocolValue = "1"
    /// Which user config the running server has been given, as a digest of it.
    ///
    /// A tmux server outlives DevHub, and `-f` is read once, while it starts.
    /// So a server that came up before the person's `tmux.conf` existed would
    /// go on running without it. The digest is that missing fact, kept where
    /// the server keeps everything else DevHub knows about it: **the server
    /// DevHub is attached to runs DevHub's current config.**
    public static let configDigestOption = "@devhub-config-digest"
    public static let contextOption = "@devhub-context"
    public static let workspaceIdOption = "@devhub-workspace-id"
    public static let rootOption = "@devhub-root"
    public static let agentIdOption = "@devhub-agent-id"
    public static let globalContext = "global"
    public static let workspaceContext = "workspace"
    public static let agentContext = "agent"
    /// An Agent's own terminal, drawn with its Agent. Its own context, because
    /// it is neither an Agent's nor the Workspace's: the sweep accounts for it
    /// by its Agent's terminal, nothing reads its screen as an Agent, and it is
    /// never recreated on demand as the Workspace's session is.
    public static let terminalContext = "terminal"
    public static let globalId = "global"
    /// The marker value a session that is not an Agent carries.
    public static let noAgent = "none"
    public static let scratchSession = TmuxNames.scratchAnchorSession
    public static let minTmuxMajor = 3
    public static let minTmuxMinor = 3
    static let markerRecord = "marker"
    static let sessionRecord = "session"

    static let fs = TmuxCommand.fieldSeparator
    static let rs = TmuxCommand.recordSeparator

    /// One session's whole identity, as tmux expands it: the record kind, the
    /// name, then the markers, `#{window_activity}` (when the session's window
    /// last produced output — `session_activity` tracks a *client* and is the
    /// wrong variable), with the root last because it is the only value that
    /// may contain a newline of its own.
    public static let sessionFields = [
        sessionRecord,
        "#{session_name}",
        "#{\(contextOption)}",
        "#{\(workspaceIdOption)}",
        "#{\(agentIdOption)}",
        "#{window_activity}",
        "#{\(rootOption)}",
    ]
    public static let sessionFormat = sessionFields.joined(separator: fs) + rs

    /// The server's protocol marker, in the same shape a session answers in:
    /// the value is the second field and the rest are empty.
    public static let markerFormat =
        ([markerRecord, "#{\(protocolOption)}"] + Array(repeating: "", count: sessionFields.count - 2))
            .joined(separator: fs) + rs

    /// The record that says the listing finished, in a round that reads screens.
    static let listedRecord = "listed"
    public static let listedFormat = listedRecord + rs

    /// What a batched round says before each screen it read: the Agent id (the
    /// ownership check, made in the same client queue as the read it guards)
    /// and the pane title.
    static let captureRecord = "capture"
    public static let captureFields = [captureRecord, "#{\(agentIdOption)}", "#{pane_title}"]
    public static let captureFormat = captureFields.joined(separator: fs) + rs
    /// What closes a screen. `recordSeparator` is a C0 control character, and a
    /// terminal consumes those rather than storing them in a cell, so
    /// `capture-pane` can never emit one.
    public static let captureEndFormat = rs
    /// The guard that makes one Agent's dead session that Agent's business
    /// alone: `if-shell -F` evaluates a format, not a shell command.
    public static let sessionExistsFormat = "#{session_name}"
    /// How many screens one round will read.
    public static let maxCapturesPerRound = 8
    static let clientRecord = "client"
    public static let clientFields = [clientRecord, "#{client_tty}", "#{client_session}"]
    public static let clientFormat = clientFields.joined(separator: fs) + rs
    static let windowRecord = "window"
    static let paneRecord = "pane"
    public static let maxSessions = 1024
    public static let maxWindows = 256
    public static let maxPanes = 1024
    public static let defaultTimeoutMs = 3_000.0
    /// How long to wait between finishing a paste and pressing Return.
    ///
    /// Codex's `PASTE_ENTER_SUPPRESS_WINDOW` is 120ms, and while that window is
    /// open a Return *inserts a newline instead of submitting*; each newline
    /// that lands during the burst re-arms it. Twice the documented window.
    public static let pasteSubmitDelayMs = 250.0
    public static let bootstrapEnvRoot = "DEVHUB_BOOTSTRAP_ROOT"
    public static let bootstrapEnvUserConfig = "DEVHUB_USER_TMUX_CONFIG"
    /// The prefix a session-environment entry is handed to the bootstrap under.
    public static let bootstrapEnvPrefix = "DEVHUB_BOOTSTRAP_E_"

    /// The variable a pane says which workbench it belongs to with.
    ///
    /// Set once, on the session, at the moment DevHub creates it. Absent is the
    /// honest "unknown", not a default.
    public static let devhubOrigin = "DEVHUB_ORIGIN"

    /// `<machine>\t<workspaceId | "scratch">\t<agentId | "none">`.
    public static func originValue(machine: RuntimeId, context: String, workspaceId: String, agentId: String) -> String {
        let window = context == globalContext ? "scratch" : workspaceId
        return "\(machine.rawValue)\t\(window)\t\(agentId)"
    }

    /// The session environment, as the variables the bootstrap config reads it
    /// from.
    public static func bootstrapEnvironment(_ sessionEnvironment: [String: String]) -> [String: String] {
        var result: [String: String] = [:]
        for (name, value) in sessionEnvironment { result[bootstrapEnvPrefix + name] = value }
        return result
    }

    /// The startup config an absent server is created with.
    ///
    /// `-f` selects this file instead of tmux's normal startup config. The
    /// user's own config is sourced by a fixed environment variable, so no user
    /// value is ever interpolated into argv. The ownership transaction is one
    /// tmux command sequence: a failure creating the anchor stops every
    /// following metadata and marker command, so a half-owned server cannot
    /// exist.
    public static func bootstrapConfig(_ sessionEnvironment: [String: String]) -> String {
        let names = sessionEnvironment.keys.sorted()
        return [
            "source-file -q \"$DEVHUB_USER_TMUX_CONFIG\"",
            // Every client of this server renders 24-bit colour; `-a` appends to
            // whatever the user's config set, `-s` because `terminal-features`
            // is a server option.
            "set -as terminal-features ',*:RGB'",
            // DevHub's variables are unset before the session is created, so
            // they never reach a pane; tmux expands `$VAR` in a config file from
            // the environment the server was started with, so the
            // `new-session` below still sees the root.
            ([
                "set-environment -gu \(bootstrapEnvRoot)",
                "set-environment -gu \(bootstrapEnvUserConfig)",
            ] + names.map { "set-environment -gu \(bootstrapEnvPrefix)\($0)" }).joined(separator: " ; "),
            [
                "new-session -d -s \(scratchSession) -c \"$\(bootstrapEnvRoot)\""
                    + names.map { " -e \($0)=\"$\(bootstrapEnvPrefix)\($0)\"" }.joined(),
                "set-option -t \(scratchSession) \(contextOption) \(globalContext)",
                "set-option -t \(scratchSession) \(workspaceIdOption) \(globalId)",
                "set-option -t \(scratchSession) \(rootOption) \"$\(bootstrapEnvRoot)\"",
                "set-option -t \(scratchSession) \(agentIdOption) \(noAgent)",
                "set-option -g \(protocolOption) \(protocolValue)",
            ].joined(separator: " ; "),
            "",
        ].joined(separator: "\n")
    }

    /// The tmux options a session carries because of what it is.
    ///
    /// **The window follows its client.** `window-size latest` is tmux's own
    /// default, said out loud because an earlier build latched windows to
    /// `window-size manual` with an explicit `resize-window`, and the latch
    /// lives in the server, which outlives the app.
    ///
    /// **An Agent has no status bar.** Its single pane is the Agent's own
    /// process; every other session *is* the user's tmux and keeps whatever
    /// their config asked for.
    public static func sessionOptions(context: String) -> [(String, String)] {
        [("window-size", "latest")] + (context == agentContext ? [("status", "off")] : [])
    }

    public static func workspaceDigest(root: String) -> String { TmuxNames.workspaceDigest(root: root) }

    public static func isWorkspaceSessionName(_ name: String, root: String) -> Bool {
        TmuxNames.isWorkspaceSession(name, root: root)
    }

    /// A marker as read from a format expansion. DevHub never writes an empty
    /// marker, so empty is how an unset one arrives.
    static func markerValue(_ raw: String) -> String? { raw.isEmpty ? nil : raw }

    /// The agent-id marker, as everything compares it.
    ///
    /// `@devhub-agent-id` joined the marker tuple after the other three, so a
    /// session DevHub itself created before the marker existed carries the
    /// other three exactly, and nothing here. That session is DevHub's own,
    /// and the fact it states about agents is the one `none` states. The
    /// absence is not read as permission for anything: an Agent session still
    /// has to carry a real id.
    static func agentIdMarker(_ raw: String?) -> String { raw ?? noAgent }

    public static func isRootMetadata(_ value: String) -> Bool {
        !value.isEmpty && value.utf16.count <= TmuxCommand.maxRootMetadataBytes
            && !value.scalarContains("\0") && value.hasPrefix("/")
    }

    /// The leading digits of a value, as a number (0 when there are none).
    public static func parseNumericPrefix(_ value: String) -> Int {
        let digits = value.unicodeScalars.prefix { $0 >= "0" && $0 <= "9" }
        return digits.isEmpty ? 0 : Int(String(String.UnicodeScalarView(digits))) ?? Int.max
    }

    public static func isUuid(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars)
        guard scalars.count == 36 else { return false }
        for (index, scalar) in scalars.enumerated() {
            if [8, 13, 18, 23].contains(index) {
                if scalar != "-" { return false }
            } else if !((scalar >= "0" && scalar <= "9") || (scalar >= "a" && scalar <= "f")) {
                return false
            }
        }
        return true
    }

    /// The terminal id a `tm-` session name carries, if it is one.
    public static func terminalIdOfSession(_ name: String) -> String? {
        guard name.hasPrefix("tm-") else { return nil }
        let id = String(name.dropFirst(3))
        return isUuid(id) ? id : nil
    }

    public static func isMarked(_ session: SessionMarking, expectedGlobalRoot: String) -> Bool {
        guard let context = session.context, let workspaceId = session.workspaceId,
              let root = session.root, let agentId = session.agentId
        else { return false }
        if context == globalContext && workspaceId == globalId {
            return agentId == noAgent && session.name == scratchSession
                && expectedGlobalRoot == root && isRootMetadata(root)
        }
        if context == workspaceContext {
            return agentId == noAgent && isUuid(workspaceId) && isRootMetadata(root)
                && isWorkspaceSessionName(session.name, root: root)
        }
        if context == agentContext {
            return isUuid(agentId) && isUuid(workspaceId) && isRootMetadata(root)
                && session.name == TmuxNames.agentSession(agentId: agentId)
        }
        if context == terminalContext {
            return agentId == noAgent && isUuid(workspaceId) && isRootMetadata(root)
                && terminalIdOfSession(session.name) != nil
        }
        return false
    }

    /// Whether a session is the exact one an identity names. The whole marker
    /// tuple is compared, never a prefix of it.
    public static func sessionMatches(_ session: SessionMarking, _ identity: TargetIdentity) -> Bool {
        session.context == identity.context && session.workspaceId == identity.workspaceId
            && session.root == identity.root && session.agentId == identity.agentId
    }

    /// The session records of a listing, as identities. A record that does not
    /// say it is a session is malformed provider output.
    public static func sessionsFrom(_ records: [[String]]) throws -> [SessionInfo] {
        if records.count > maxSessions { throw TmuxCommand.shapeFailure("more sessions than DevHub will read") }
        return try records.map { record in
            if record.first != sessionRecord {
                throw TmuxCommand.shapeFailure("a record from a listing DevHub did not ask for")
            }
            return SessionInfo(
                name: record[1],
                context: markerValue(record[2]),
                workspaceId: markerValue(record[3]),
                root: markerValue(record[6]),
                agentId: agentIdMarker(markerValue(record[4])),
                activity: markerValue(record[5])
            )
        }
    }

    /// What `terminalPanes` asks each pane, in the order it is read back.
    static let paneActivityRecord = "pane-activity"
    public static let paneActivityFields = [
        paneActivityRecord,
        "#{session_name}",
        "#{\(contextOption)}",
        "#{\(workspaceIdOption)}",
        "#{\(agentIdOption)}",
        "#{window_id}",
        "#{pane_id}",
        "#{window_active}",
        "#{session_attached}",
        "#{window_activity}",
        "#{pane_dead}",
        "#{history_size}:#{cursor_x}:#{cursor_y}",
        "#{pane_current_command}",
        "#{\(rootOption)}",
    ]
    public static let paneActivityFormat = paneActivityFields.joined(separator: fs) + rs
    public static let paneMarkerFormat = [markerRecord, "#{\(protocolOption)}"].joined(separator: fs) + rs

    /// Read what `terminalPanes` answered: the marker, then one record per pane.
    ///
    /// Only panes of sessions DevHub marked as a Workspace terminal are
    /// returned; every Agent terminal (`tm-` session) is returned by id and
    /// Workspace in `terminals`. `marker` is `wrong` for a server DevHub does
    /// not own, in which case there are no panes.
    public static func parsePaneActivity(_ stdout: Data, contextHome: String) throws -> PaneActivityReading {
        let records = try TmuxCommand.splitRecords(stdout)
        guard let first = records.first?.scalarSplit("\u{1f}"), first.first == markerRecord else {
            throw TmuxCommand.shapeFailure("no marker where the marker record should be")
        }
        if first.count < 2 || first[1] != protocolValue {
            return PaneActivityReading(marker: .wrong, panes: [], terminals: [])
        }
        if records.count - 1 > maxPanes { throw TmuxCommand.shapeFailure("more windows or panes than DevHub will read") }
        var panes: [PaneSample] = []
        var terminals: [String: TerminalSessionSample] = [:]
        var terminalOrder: [String] = []
        for record in records.dropFirst() {
            let fields = record.scalarSplit("\u{1f}")
            if fields.count != paneActivityFields.count || fields[0] != paneActivityRecord {
                throw TmuxCommand.shapeFailure("a record of the wrong width")
            }
            let marking = SessionMarking(
                name: fields[1],
                context: markerValue(fields[2]),
                workspaceId: markerValue(fields[3]),
                root: markerValue(fields[13]),
                agentId: agentIdMarker(markerValue(fields[4]))
            )
            if !isMarked(marking, expectedGlobalRoot: contextHome) { continue }
            if marking.context == terminalContext {
                if let id = terminalIdOfSession(marking.name), let workspaceId = marking.workspaceId {
                    if terminals[id] == nil { terminalOrder.append(id) }
                    terminals[id] = TerminalSessionSample(terminalId: id, workspaceId: workspaceId)
                }
                continue
            }
            guard marking.context == workspaceContext, let workspaceId = marking.workspaceId else { continue }
            let activity = fields[9]
            panes.append(PaneSample(
                workspaceId: workspaceId,
                pane: fields[6],
                window: fields[5],
                inView: fields[7] == "1" && parseNumericPrefix(fields[8]) > 0,
                command: fields[12],
                dead: fields[10] == "1",
                windowActivity: isAllDigits(activity) ? Int(activity) : nil,
                screen: fields[11]
            ))
        }
        return PaneActivityReading(marker: .owned, panes: panes, terminals: terminalOrder.compactMap { terminals[$0] })
    }

    static func isAllDigits(_ value: String) -> Bool {
        !value.isEmpty && value.unicodeScalars.allSatisfy { $0 >= "0" && $0 <= "9" }
    }

    static let terminalPaneRecord = "terminal-pane"
    public static let terminalPaneFields = [
        terminalPaneRecord,
        "#{session_name}",
        "#{\(contextOption)}",
        "#{\(workspaceIdOption)}",
        "#{\(agentIdOption)}",
        "#{window_id}",
        "#{window_index}",
        "#{pane_id}",
        "#{pane_index}",
        "#{pane_active}",
        "#{window_active}",
        "#{pane_current_command}",
        "#{pane_title}",
        "#{pane_dead}",
        "#{socket_path}",
        "#{pane_current_path}",
        "#{pane_left}",
        "#{pane_top}",
        "#{pane_width}",
        "#{pane_height}",
        "#{window_name}",
        "#{pane_pid}",
        "#{\(rootOption)}",
    ]
    public static let terminalPaneFormat = terminalPaneFields.joined(separator: fs) + rs

    /// Read what `paneTerminals` answered: the marker, then one record per pane.
    public static func parsePaneTerminals(_ stdout: Data, contextHome: String) throws -> (marker: MarkerState, panes: [PaneTerminalPane]) {
        let (marker, panes) = try parseMarkedPanes(stdout, contextHome: contextHome, context: terminalContext)
        return (marker, panes.compactMap { pane in
            terminalIdOfSession(pane.sessionName).map { PaneTerminalPane(pane: pane, terminalId: $0) }
        })
    }

    /// The same reading, for the Workspaces' own (`ws-`) sessions' panes.
    public static func parseWorkspacePanes(_ stdout: Data, contextHome: String) throws -> (marker: MarkerState, panes: [MarkedPane]) {
        try parseMarkedPanes(stdout, contextHome: contextHome, context: workspaceContext)
    }

    static func parseMarkedPanes(_ stdout: Data, contextHome: String, context: String) throws -> (marker: MarkerState, panes: [MarkedPane]) {
        let records = try TmuxCommand.splitRecords(stdout)
        guard let first = records.first?.scalarSplit("\u{1f}"), first.first == markerRecord else {
            throw TmuxCommand.shapeFailure("no marker where the marker record should be")
        }
        if first.count < 2 || first[1] != protocolValue { return (.wrong, []) }
        if records.count - 1 > maxPanes { throw TmuxCommand.shapeFailure("more windows or panes than DevHub will read") }
        var panes: [MarkedPane] = []
        for record in records.dropFirst() {
            let fields = record.scalarSplit("\u{1f}")
            if fields.count != terminalPaneFields.count || fields[0] != terminalPaneRecord {
                throw TmuxCommand.shapeFailure("a record of the wrong width")
            }
            let marking = SessionMarking(
                name: fields[1],
                context: markerValue(fields[2]),
                workspaceId: markerValue(fields[3]),
                root: markerValue(fields[22]),
                agentId: agentIdMarker(markerValue(fields[4]))
            )
            if !isMarked(marking, expectedGlobalRoot: contextHome) { continue }
            guard marking.context == context, let workspaceId = marking.workspaceId else { continue }
            panes.append(MarkedPane(
                workspaceId: workspaceId,
                sessionName: marking.name,
                windowId: fields[5],
                windowIndex: parseNumericPrefix(fields[6]),
                paneId: fields[7],
                paneIndex: parseNumericPrefix(fields[8]),
                active: fields[9] == "1" && fields[10] == "1",
                windowActive: fields[10] == "1",
                windowName: fields[20],
                command: fields[11],
                title: fields[12],
                cwd: fields[15],
                dead: fields[13] == "1",
                socketPath: fields[14],
                left: parseNumericPrefix(fields[16]),
                top: parseNumericPrefix(fields[17]),
                width: parseNumericPrefix(fields[18]),
                height: parseNumericPrefix(fields[19]),
                pid: parseNumericPrefix(fields[21])
            ))
        }
        return (.owned, panes)
    }

    /// `new-session -e KEY=VALUE` for each of a session's own variables.
    ///
    /// Sorted, so the argv a launch produces depends on what is being launched
    /// and nothing else.
    public static func envArguments(_ env: [String: String]?) throws -> [String] {
        guard let env else { return [] }
        var args: [String] = []
        for key in env.keys.sorted() {
            if !isEnvironmentName(key) { throw portFailure(.failed) }
            let value = env[key] ?? ""
            if value.scalarContains("\0") { throw portFailure(.failed) }
            args += ["-e", "\(key)=\(value)"]
        }
        return args
    }

    static func isEnvironmentName(_ key: String) -> Bool {
        guard let first = key.unicodeScalars.first else { return false }
        func letter(_ s: Unicode.Scalar) -> Bool { (s >= "A" && s <= "Z") || (s >= "a" && s <= "z") || s == "_" }
        return letter(first) && key.unicodeScalars.dropFirst().allSatisfy { letter($0) || ($0 >= "0" && $0 <= "9") }
    }

    /// What tmux was asked to do, in the word a diagnostic should use: the
    /// first word of the argv that is not a flag.
    public static func tmuxSubcommand(_ args: [String]) -> String {
        args.first { !$0.hasPrefix("-") } ?? "tmux"
    }

    static let maxStderrLine = 200

    /// tmux's last word about why it refused: one line, bounded.
    static func lastStderrLine(_ stderr: Data) -> String? {
        let said = String(decoding: stderr, as: UTF8.self)
            .scalarSplit("\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return said.last.map { String($0.utf16.prefix(maxStderrLine)) ?? String($0.prefix(maxStderrLine)) }
    }

    /// The refusal a non-zero exit of this subcommand raises.
    public static func tmuxRefusal(_ subcommand: String, stderr: Data) -> PortFailure {
        if let said = lastStderrLine(stderr) {
            return portFailure(.failed, detail: "tmux `\(subcommand)` failed: \(said)")
        }
        return portFailure(.failed, detail: "tmux `\(subcommand)` failed.")
    }

    /// What a config tmux would not load says, in tmux's own words — from
    /// either stream, because tmux reports a config error on stdout.
    public static func configRefusal(path: String, stdout: Data, stderr: Data) -> PortFailure {
        if let said = lastStderrLine(stderr) ?? lastStderrLine(stdout) {
            return portFailure(.failed, detail: "DevHub could not load the tmux config at \(path): \(said)")
        }
        return portFailure(.failed, detail: "DevHub could not load the tmux config at \(path).")
    }

    /// A tmux pane id, which is the only target DevHub addresses a pane by.
    public static func isPaneId(_ value: String) -> Bool {
        value.hasPrefix("%") && value.count > 1 && value.dropFirst().unicodeScalars.allSatisfy { $0 >= "0" && $0 <= "9" }
    }

    /// `new-window` in a session, at its next free index, in `root`, running
    /// `argv` directly, and printing the new pane's id. `--` ends tmux's own
    /// options, so a program whose path starts with `-` is still the program.
    public static func editorWindowArgs(session: String, root: String, argv: [String]) -> [String] {
        ["new-window", "-P", "-F", "#{pane_id}", "-t", "\(session):", "-c", root, "--"] + argv
    }

    /// Bring a pane's window to the front of its session, and the pane in it.
    public static func activatePaneArgs(_ paneId: String) -> [String] {
        ["select-window", "-t", paneId, ";", "select-pane", "-t", paneId]
    }
}

/// What the server's global marker says about who owns it.
public enum MarkerState: String, Sendable, Equatable {
    case absent, wrong, owned
}

/// The part of a listing that says whether DevHub wrote the session.
public struct SessionMarking: Sendable, Equatable {
    public var name: String
    public var context: String?
    public var workspaceId: String?
    public var root: String?
    public var agentId: String?
    public init(name: String, context: String?, workspaceId: String?, root: String?, agentId: String?) {
        self.name = name
        self.context = context
        self.workspaceId = workspaceId
        self.root = root
        self.agentId = agentId
    }
}

/// One session of a listing: its markers, and when its window last wrote.
public struct SessionInfo: Sendable, Equatable {
    public var name: String
    public var context: String?
    public var workspaceId: String?
    public var root: String?
    public var agentId: String?
    /// `#{window_activity}`, unix seconds as text; nil is "assume it changed".
    public var activity: String?

    public init(name: String, context: String?, workspaceId: String?, root: String?, agentId: String?, activity: String?) {
        self.name = name
        self.context = context
        self.workspaceId = workspaceId
        self.root = root
        self.agentId = agentId
        self.activity = activity
    }

    public var marking: SessionMarking {
        SessionMarking(name: name, context: context, workspaceId: workspaceId, root: root, agentId: agentId)
    }
}

/// One tmux client: a terminal on screen, attached to one session.
public struct ClientInfo: Sendable, Equatable {
    public var tty: String
    public var session: String
}

/// The identity a target resolves to on a given server.
public struct TargetIdentity: Sendable, Equatable {
    public var sessionName: String
    public var root: String
    public var workspaceId: String
    public var context: String
    /// `none` for everything that is not an Agent.
    public var agentId: String
    public init(sessionName: String, root: String, workspaceId: String, context: String, agentId: String) {
        self.sessionName = sessionName
        self.root = root
        self.workspaceId = workspaceId
        self.context = context
        self.agentId = agentId
    }
}

/// One Agent terminal's session, as the once-a-second reading names it.
public struct TerminalSessionSample: Sendable, Equatable {
    public var terminalId: String
    public var workspaceId: String
    public init(terminalId: String, workspaceId: String) {
        self.terminalId = terminalId
        self.workspaceId = workspaceId
    }
}

/// What `terminalPanes` read: the marker, the Workspace terminals' panes, and
/// every Agent terminal on the server.
public struct PaneActivityReading: Sendable, Equatable {
    public var marker: MarkerState
    public var panes: [PaneSample]
    public var terminals: [TerminalSessionSample]
}

/// One tmux pane of a marked session, as `devhub --tell terminal status` /
/// `panes` report it.
public struct MarkedPane: Sendable, Equatable {
    public var workspaceId: String
    public var sessionName: String
    /// tmux's `@3`.
    public var windowId: String
    public var windowIndex: Int
    /// tmux's `%12`: unique on its server, the most exact target there is.
    public var paneId: String
    public var paneIndex: Int
    /// The pane is its window's active one, and the window its session's.
    public var active: Bool
    /// The window is the session's current one: the one on screen.
    public var windowActive: Bool
    public var windowName: String
    /// The foreground process, as tmux names it.
    public var command: String
    public var title: String
    public var cwd: String
    public var dead: Bool
    /// The server's socket, absolute: what `tmux -S` takes.
    public var socketPath: String
    /// Where the pane is in its window, in cells from the top left.
    public var left: Int
    public var top: Int
    public var width: Int
    public var height: Int
    /// The pane's own process (its shell), on the session's machine.
    public var pid: Int
}

/// A pane of an Agent terminal (`tm-` session).
public struct PaneTerminalPane: Sendable, Equatable {
    public var pane: MarkedPane
    public var terminalId: String
}

/// A Workspace's editor-terminal pane, with what its terminal runs in front.
public struct WorkspacePane: Sendable, Equatable {
    public var pane: MarkedPane
    /// The foreground command line (`ssh prod`), when `ps` said.
    public var argv: String?
}
