// Port of apps/desktop/src/model/persistence.ts — decoding, migration and
// validation.
//
// Where untyped bytes become typed values, and the only place they do. A
// decoder that returns an `AgentStatus` rejects everything that is not one, and
// a field typed number is checked to be one before anybody compares it.
// Ranges stay in `validate` — it owns them — so a decoded document is
// *well-typed*, and `validate` then says whether it is *well-formed*.
//
// Unknown keys are ignored, deliberately: `navigation.activity`,
// `sidebar.expanded` and `issue_url` are fields a past DevHub wrote. What is
// *present* under a key this build reads has to be what that key means.
//
// A refusal names the path and the value, and travels as the cause of a
// `STATE_INVALID` — which `StateError.describe` renders next to the file name.

import Foundation

public enum StateDecoding {
    // MARK: Refusals

    /// The offending value, said back short enough to read in one line.
    static func render(_ value: WireJSON?) -> String {
        guard let value else { return "nothing" }
        let text = value.compact
        let units = Array(text.utf16)
        return units.count > 60 ? String(decoding: units.prefix(57), as: UTF16.self) + "..." : text
    }

    static func refuse(_ place: String, _ expected: String, _ value: WireJSON?) -> StateError {
        StateError(.invalid, cause: "\(place) should be \(expected), and the file has \(render(value))")
    }

    static func invalid(_ path: String? = nil) -> StateError { StateError(.invalid, path: path) }

    static func object(_ place: String, _ value: WireJSON?) throws -> WireJSON {
        guard let value, value.isObject else { throw refuse(place, "an object", value) }
        return value
    }

    static func array(_ place: String, _ value: WireJSON?) throws -> [WireJSON] {
        guard let items = value?.arrayValue else { throw refuse(place, "an array", value) }
        return items
    }

    static func string(_ place: String, _ value: WireJSON?) throws -> String {
        guard let text = value?.stringValue else { throw refuse(place, "a string", value) }
        return text
    }

    static func number(_ place: String, _ value: WireJSON?) throws -> Double {
        guard let number = value?.numberValue, number.isFinite else { throw refuse(place, "a number", value) }
        return number
    }

    static func boolean(_ place: String, _ value: WireJSON?) throws -> Bool {
        guard let flag = value?.boolValue else { throw refuse(place, "true or false", value) }
        return flag
    }

    static func member<T: RawRepresentable>(_ place: String, _ value: WireJSON?, _ allowed: [T]) throws -> T where T.RawValue == String {
        guard let text = value?.stringValue, let found = allowed.first(where: { $0.rawValue == text }) else {
            throw refuse(place, "one of \(allowed.map(\.rawValue).joined(separator: ", "))", value)
        }
        return found
    }

    static func member(_ place: String, _ value: WireJSON?, _ allowed: [String]) throws -> String {
        guard let text = value?.stringValue, allowed.contains(text) else {
            throw refuse(place, "one of \(allowed.joined(separator: ", "))", value)
        }
        return text
    }

    /// A key that may be absent (or `null`), decoded once into the model's type.
    static func optional<T>(_ value: WireJSON?, _ decode: (WireJSON) throws -> T) rethrows -> T? {
        guard let value, value != .null else { return nil }
        return try decode(value)
    }

    static func stringArray(_ place: String, _ value: WireJSON?) throws -> [String] {
        try array(place, value).enumerated().map { try string("\(place)[\($0.offset)]", $0.element) }
    }

    static func stringMap(_ place: String, _ value: WireJSON?) throws -> OrderedStringMap {
        let pairs = try object(place, value).objectValue ?? []
        var map = OrderedStringMap()
        for (key, entry) in pairs { map[key] = try string("\(place).\(key)", entry) }
        return map
    }

    // MARK: Member lists

    static let controlStateKinds = ["running", "stopping", "stop_failed"]
    /// Every lifecycle a file can name, including the two this build no longer writes.
    static let lifecycleKinds = ["available", "unavailable", "closing", "closing_failed"]
    static let locationKinds = ["local", "ssh"]
    static let editorKinds = ["dev_container"]
    static let navigationKinds = ["workspace", "agent"]
    static let ownedSessionKinds = ["workspace"]
    static let socketTransitionKinds = ["stable", "pending", "cleaning_old", "old_cleaned", "recreation_pending"]
    static let preflightStates: [SocketTargetPreflightState] = [
        .notChecked, .targetAbsent, .targetDevhubEmpty, .wrongMarker, .markedSessions,
    ]
    static let runtimeHealths: [AgentRuntimeHealth] = [.starting, .healthy, .degraded, .unavailable, .failed]

    // MARK: Decoders

    static func controlState(_ place: String, _ value: WireJSON?) throws -> PersistedAgentControlState {
        let object = try object(place, value)
        switch try member("\(place).kind", object["kind"], controlStateKinds) {
        case "stop_failed": return .stopFailed(try member("\(place).diagnostic", object["diagnostic"], DiagnosticCode.allCases))
        case "stopping": return .stopping
        default: return .running
        }
    }

    static func unread(_ place: String, _ value: WireJSON) throws -> UnreadRecord {
        if let flag = value.boolValue { return .flag(flag) }
        return .reason(try member(place, value, AgentStatus.allCases))
    }

    static func location(_ place: String, _ value: WireJSON?) throws -> WorkspaceLocationRecord {
        let object = try object(place, value)
        switch try member("\(place).kind", object["kind"], locationKinds) {
        case "ssh": return .ssh(host: try string("\(place).host", object["host"]))
        default: return .local
        }
    }

    static func editor(_ place: String, _ value: WireJSON?) throws -> EditorRecord {
        let object = try object(place, value)
        _ = try member("\(place).kind", object["kind"], editorKinds)
        return EditorRecord(
            configPath: try string("\(place).config_path", object["config_path"]),
            startedContainerId: try object["started_container_id"].map { try string("\(place).started_container_id", $0) }
        )
    }

    static func agentTerminal(_ place: String, _ value: WireJSON?) throws -> AgentTerminalRecord {
        let object = try object(place, value)
        guard let open = object["open"]?.boolValue else { throw refuse("\(place).open", "a boolean", object["open"]) }
        return AgentTerminalRecord(terminalId: try string("\(place).terminal_id", object["terminal_id"]), open: open)
    }

    static func agent(_ place: String, _ value: WireJSON) throws -> AgentStateRecord {
        let object = try object(place, value)
        func at(_ key: String) -> String { "\(place).\(key)" }
        return AgentStateRecord(
            agentId: try string(at("agent_id"), object["agent_id"]),
            workspaceId: try string(at("workspace_id"), object["workspace_id"]),
            profileId: try string(at("profile_id"), object["profile_id"]),
            profileKind: try optional(object["profile_kind"]) { try member(at("profile_kind"), $0, AgentProfileKind.allCases) },
            profileDisplayName: try optional(object["profile_display_name"]) { try string(at("profile_display_name"), $0) },
            profileCommand: try optional(object["profile_command"]) { try string(at("profile_command"), $0) },
            profileArgs: try optional(object["profile_args"]) { try stringArray(at("profile_args"), $0) },
            profileEnv: try optional(object["profile_env"]) { try stringMap(at("profile_env"), $0) },
            profilePresentation: try optional(object["profile_presentation"]) {
                try member(at("profile_presentation"), $0, AgentPresentation.allCases)
            },
            presentation: try member(at("presentation"), object["presentation"], AgentPresentation.allCases),
            ordinal: try number(at("ordinal"), object["ordinal"]),
            temporaryName: try optional(object["temporary_name"]) { try string(at("temporary_name"), $0) },
            status: try member(at("status"), object["status"], AgentStatus.allCases),
            unread: try optional(object["unread"]) { try unread(at("unread"), $0) },
            runtimeHealth: try member(at("runtime_health"), object["runtime_health"], runtimeHealths),
            controlState: try controlState(at("control_state"), object["control_state"]),
            providerMapping: try optional(object["provider_mapping"]) { try string(at("provider_mapping"), $0) },
            terminal: try object["terminal"].map { try agentTerminal(at("terminal"), $0) },
            terminalShare: try object["terminal_share"].map { try number(at("terminal_share"), $0) },
            terminalStackedShare: try object["terminal_stacked_share"].map { try number(at("terminal_stacked_share"), $0) }
        )
    }

    static func lifecycle(_ place: String, _ value: WireJSON?) throws -> WorkspaceLifecycleRecord {
        let object = try object(place, value)
        switch try member("\(place).kind", object["kind"], lifecycleKinds) {
        case "unavailable": return .unavailable(try member("\(place).reason", object["reason"], DiagnosticCode.allCases))
        // A version-3 file mid-close: the close was never finished and cannot
        // be resumed, so the Workspace comes back exactly as it is: open.
        default: return .available
        }
    }

    static func workspace(_ place: String, _ value: WireJSON) throws -> WorkspaceStateRecord {
        let object = try object(place, value)
        func at(_ key: String) -> String { "\(place).\(key)" }
        return WorkspaceStateRecord(
            workspaceId: try string(at("workspace_id"), object["workspace_id"]),
            selectedPath: try string(at("selected_path"), object["selected_path"]),
            canonicalPath: try string(at("canonical_path"), object["canonical_path"]),
            // A version-4 record has no `location`: absent is the answer.
            location: try object["location"].map { try location(at("location"), $0) } ?? .local,
            editor: try object["editor"].map { try editor(at("editor"), $0) },
            repositoryId: try optional(object["repository_id"]) { try string(at("repository_id"), $0) },
            lastAgentId: try optional(object["last_agent_id"]) { try string(at("last_agent_id"), $0) },
            lifecycle: try lifecycle(at("lifecycle"), object["lifecycle"]),
            agents: try array(at("agents"), object["agents"]).enumerated().map { try agent("\(at("agents"))[\($0.offset)]", $0.element) },
            paneLayout: object["pane_layout"],
            paneTerminals: object["pane_terminals"]
        )
    }

    static func navigation(_ place: String, _ value: WireJSON?) throws -> NavigationContextRecord? {
        let object = try object(place, value)
        guard let raw = object["context"] else { return nil }
        let context = try self.object("\(place).context", raw)
        switch try member("\(place).context.kind", context["kind"], navigationKinds) {
        case "agent": return .agent(try string("\(place).context.agent_id", context["agent_id"]))
        default: return .workspace(try string("\(place).context.workspace_id", context["workspace_id"]))
        }
    }

    static func ownedSession(_ place: String, _ value: WireJSON?) throws -> OwnedSessionRecordState {
        let object = try object(place, value)
        _ = try member("\(place).kind", object["kind"], ownedSessionKinds)
        let name = try string("\(place).session_name", object["session_name"])
        return OwnedSessionRecordState(workspaceId: try string("\(place).workspace_id", object["workspace_id"]), sessionName: name)
    }

    static func ownedSessions(_ place: String, _ value: WireJSON?) throws -> [OwnedSessionRecordState] {
        try array(place, value).enumerated().map { try ownedSession("\(place)[\($0.offset)]", $0.element) }
    }

    static func sessionStatuses<T: RawRepresentable & CaseIterable>(
        _ place: String, _ value: WireJSON?, _: T.Type
    ) throws -> [(session: OwnedSessionRecordState, status: T)] where T.RawValue == String {
        try array(place, value).enumerated().map { index, entry in
            let at = "\(place)[\(index)]"
            let object = try object(at, entry)
            return (try ownedSession("\(at).session", object["session"]), try member("\(at).status", object["status"], Array(T.allCases)))
        }
    }

    static func transition(_ place: String, _ value: WireJSON?) throws -> SocketTransitionState {
        let object = try object(place, value)
        func at(_ key: String) -> String { "\(place).\(key)" }
        switch try member(at("kind"), object["kind"], socketTransitionKinds) {
        case "pending":
            return .pending(
                requestedSocketName: try string(at("requested_socket_name"), object["requested_socket_name"]),
                required: try ownedSessions(at("required"), object["required"]),
                preflight: try member(at("preflight"), object["preflight"], preflightStates),
                verifiedOldSessions: try optional(object["verified_old_sessions"]) { try ownedSessions(at("verified_old_sessions"), $0) }
            )
        case "cleaning_old":
            return .cleaningOld(
                oldSocketName: try string(at("old_socket_name"), object["old_socket_name"]),
                requestedSocketName: try string(at("requested_socket_name"), object["requested_socket_name"]),
                required: try ownedSessions(at("required"), object["required"]),
                targetPreflight: try member(at("target_preflight"), object["target_preflight"], preflightStates),
                sessions: try sessionStatuses(at("sessions"), object["sessions"], CleanupSessionStatus.self)
            )
        case "old_cleaned":
            return .oldCleaned(
                oldSocketName: try string(at("old_socket_name"), object["old_socket_name"]),
                newSocketName: try string(at("new_socket_name"), object["new_socket_name"]),
                required: try ownedSessions(at("required"), object["required"])
            )
        case "recreation_pending":
            return .recreationPending(
                effectiveSocketName: try string(at("effective_socket_name"), object["effective_socket_name"]),
                required: try ownedSessions(at("required"), object["required"]),
                sessions: try sessionStatuses(at("sessions"), object["sessions"], RecreationSessionStatus.self)
            )
        default:
            return .stable
        }
    }

    static func smartButtons(_ value: WireJSON) throws -> SmartButtonsPlacement {
        let table = try object("smart_buttons", value)
        var placement = SmartButtonsPlacement()
        for (key, entry) in table.objectValue ?? [] {
            guard let presentation = AgentPresentation(rawValue: key) else { throw invalid("smart_buttons.\(key)") }
            let place = "smart_buttons.\(key)"
            let spot = try object(place, entry)
            if spot["anchored"] != nil {
                let edge: SmartButtonsEdge
                switch spot["anchored"]?.stringValue {
                case "side": edge = .side
                case "top": edge = .top
                default: throw invalid("\(place).anchored")
                }
                placement[presentation] = .anchored(edge: edge, along: try number("\(place).along", spot["along"]))
            } else {
                placement[presentation] = .free(SmartButtonsOffset(
                    right: try number("\(place).right", spot["right"]), bottom: try number("\(place).bottom", spot["bottom"])
                ))
            }
        }
        return placement
    }

    // MARK: Parse and migrate

    enum Parsed {
        case document(WireJSON, version: Int, legacy: WireJSON?)
        case corrupt(String)
        case newerVersion
    }

    public enum Decoded: Equatable, Sendable {
        case state(PersistedAppState, migrated: Bool, migrationNotes: [String])
        case corrupt(String)
        case newerVersion
    }

    static func parse(_ bytes: [UInt8]) -> Parsed {
        let value: WireJSON
        do { value = try WireJSON.parse(bytes) } catch { return .corrupt(String(describing: error)) }
        guard value.isObject else { return .corrupt("the document is not a JSON object") }
        let schema = value["schema_version"]?.numberValue
        let legacy = value["version"]?.numberValue
        let version: Double
        switch (schema, legacy) {
        case let (schema?, legacy?):
            if schema != legacy {
                return .corrupt("schema_version is \(JavaScriptNumber.string(schema)) and version is \(JavaScriptNumber.string(legacy))")
            }
            version = schema
        case let (schema?, nil): version = schema
        case let (nil, legacy?): version = legacy
        default: return .corrupt("the document has no schema_version")
        }
        if version > Double(StateSchema.version) { return .newerVersion }
        return .document(value, version: Int(version.rounded(.down)), legacy: value["version"])
    }

    /// `migrateToVersion10`: Scratch as a context and a tmux session of its
    /// own, taken out of a version-9 document before it is decoded.
    static func migrateToVersion10(_ document: WireJSON) -> WireJSON {
        var document = document
        if let navigation = document["navigation"], navigation.isObject,
           let context = navigation["context"], context.isObject, context["kind"]?.stringValue == "global" {
            document = document.setting("navigation", navigation.removing("context"))
        }
        guard let tmux = document["tmux"], tmux.isObject, let transition = tmux["transition"], transition.isObject else { return document }
        func isScratch(_ entry: WireJSON) -> Bool {
            entry.isObject && (entry["kind"]?.stringValue == "scratch" || (entry["session"].map { $0.isObject && $0["kind"]?.stringValue == "scratch" } ?? false))
        }
        var next = transition
        for key in ["required", "verified_old_sessions", "sessions"] {
            if let list = transition[key]?.arrayValue { next = next.setting(key, .array(list.filter { !isScratch($0) })) }
        }
        return document.setting("tmux", tmux.setting("transition", next))
    }

    /// `migrateToVersion11`: every Agent of a version-10 document made a terminal.
    static func migrateToVersion11(_ document: WireJSON) -> WireJSON {
        guard let workspaces = document["workspaces"]?.arrayValue else { return document }
        let migrated = workspaces.map { workspace -> WireJSON in
            guard workspace.isObject, let agents = workspace["agents"]?.arrayValue else { return workspace }
            return workspace.setting("agents", .array(agents.map { agent in
                agent.isObject ? agent.setting("presentation", "tui").setting("profile_presentation", "tui") : agent
            }))
        }
        return document.setting("workspaces", .array(migrated))
    }

    static func normalizePathString(_ value: String) -> String {
        var parts: [Substring] = []
        for component in value.split(separator: "/", omittingEmptySubsequences: false) {
            if component.isEmpty || component == "." { continue }
            if component == ".." {
                _ = parts.popLast()
                continue
            }
            parts.append(component)
        }
        return "/" + parts.joined(separator: "/")
    }

    /// `migrateToVersion12`: the dev container out of `location` and onto
    /// `editor`. Answers the sentences a person has to be told.
    public static func migrateToVersion12(_ document: WireJSON) -> (WireJSON, [String]) {
        var document = document
        var notes: [String] = []
        if let machines = document["session_machines"]?.arrayValue {
            document = document.setting("session_machines", .array(machines.filter { !($0.stringValue?.hasPrefix("container:") ?? false) }))
        }
        guard let workspaces = document["workspaces"]?.arrayValue else { return (document, notes) }

        func hostKey(_ record: WireJSON) -> String? {
            let location = record["location"]
            let host: WireJSON? = location.map { $0.isObject && $0["kind"]?.stringValue == "ssh" ? ($0["host"] ?? .null) : .string("") } ?? .string("")
            guard let hostText = host?.stringValue, let path = record["canonical_path"]?.stringValue else { return nil }
            return "\(hostText)\u{0}\(normalizePathString(path))"
        }
        var plain: [String: WireJSON] = [:]
        for record in workspaces where record.isObject {
            if let location = record["location"], location.isObject, location["kind"]?.stringValue == "container" { continue }
            if let key = hostKey(record) { plain[key] = record }
        }

        var survivorOf: [String: String] = [:]
        var removedAgents: [String: String] = [:]
        var kept: [WireJSON] = []
        for record in workspaces {
            guard record.isObject, let location = record["location"], location.isObject, location["kind"]?.stringValue == "container" else {
                kept.append(record)
                continue
            }
            guard let folder = location["workspace_folder"]?.stringValue, let id = record["workspace_id"]?.stringValue else {
                kept.append(record)
                continue
            }
            let agents = record["agents"]?.arrayValue ?? []
            for agent in agents {
                if agent.isObject, let agentId = agent["agent_id"]?.stringValue { removedAgents[agentId] = id }
            }
            if !agents.isEmpty {
                notes.append(
                    "\(agents.count) Agent\(agents.count == 1 ? "" : "s") ran inside the dev container for \(folder). DevHub runs Agents on the Workspace's own machine now, so \(agents.count == 1 ? "it was" : "they were") removed."
                )
            }
            let configPath = location["config_path"]?.stringValue
            let key = "\u{0}\(normalizePathString(folder))"
            if let existing = plain[key], let existingId = existing["workspace_id"]?.stringValue {
                survivorOf[id] = existingId
                notes.append(
                    "\(folder) was open both on this Mac and in its dev container. They are one Workspace now; its editor opens on this Mac, and Reopen in Container attaches it again."
                )
                continue
            }
            var next = record.setting("canonical_path", .string(folder)).setting("selected_path", .string(folder))
                .setting("location", ["kind": "local"]).setting("agents", []).removing("last_agent_id")
            if let configPath {
                next = next.setting("editor", ["kind": "dev_container", "config_path": .string(configPath)])
            } else {
                notes.append("No dev container definition was found for \(folder), so its editor opens on this Mac.")
            }
            plain[key] = next
            kept.append(next)
        }
        document = document.setting("workspaces", .array(kept))

        if let navigation = document["navigation"], navigation.isObject, let context = navigation["context"], context.isObject {
            if context["kind"]?.stringValue == "workspace", let workspaceId = context["workspace_id"]?.stringValue,
               let survivor = survivorOf[workspaceId] {
                document = document.setting("navigation", navigation.setting("context", context.setting("workspace_id", .string(survivor))))
            }
            if context["kind"]?.stringValue == "agent", let agentId = context["agent_id"]?.stringValue, let owner = removedAgents[agentId] {
                document = document.setting("navigation", navigation.setting(
                    "context", ["kind": "workspace", "workspace_id": .string(survivorOf[owner] ?? owner)]
                ))
            }
        }
        if let sidebar = document["sidebar"], sidebar.isObject, let order = sidebar["order"]?.arrayValue {
            document = document.setting("sidebar", sidebar.setting("order", .array(order.filter {
                !($0.stringValue.map { survivorOf[$0] != nil } ?? false)
            })))
        }
        func repoint(_ value: WireJSON) -> WireJSON {
            switch value {
            case let .array(items): return .array(items.map(repoint))
            case let .object(pairs):
                return .object(pairs.map { pair in
                    if pair.key == "workspace_id", let id = pair.value.stringValue, let survivor = survivorOf[id] {
                        return (pair.key, .string(survivor))
                    }
                    return (pair.key, repoint(pair.value))
                })
            default: return value
            }
        }
        if let tmux = document["tmux"] { document = document.setting("tmux", repoint(tmux)) }
        return (document, notes)
    }

    /// `decodeParsed`.
    static func decodeParsed(_ document: WireJSON, version: Int, legacy: WireJSON?) -> Decoded {
        let migrated = version < StateSchema.version || legacy != nil
        var document = document
        if version < 10 { document = migrateToVersion10(document) }
        if version < 11 { document = migrateToVersion11(document) }
        var notes: [String] = []
        if version < 12 { (document, notes) = migrateToVersion12(document) }
        let fresh = PersistedAppState.fresh()
        let state: PersistedAppState
        do {
            let sidebar = try document["sidebar"].map { raw -> SidebarState in
                let object = try object("sidebar", raw)
                return SidebarState(
                    width: try number("sidebar.width", object["width"]),
                    collapsed: object["collapsed"] == .bool(true),
                    order: try stringArray("sidebar.order", object["order"] ?? .array([]))
                )
            } ?? fresh.sidebar
            let frame = try document["window"].map { raw -> WindowFrame in
                let window = try object("window", raw)
                let frame = try object("window.frame", window["frame"])
                return WindowFrame(
                    x: try number("window.frame.x", frame["x"]), y: try number("window.frame.y", frame["y"]),
                    width: try number("window.frame.width", frame["width"]), height: try number("window.frame.height", frame["height"]),
                    maximized: try boolean("window.frame.maximized", frame["maximized"])
                )
            } ?? fresh.windowFrame
            let tmux = try document["tmux"].map { raw -> TmuxState in
                let object = try object("tmux", raw)
                return TmuxState(
                    effectiveSocketName: try string("tmux.effective_socket_name", object["effective_socket_name"]),
                    transition: try transition("tmux.transition", object["transition"])
                )
            } ?? fresh.tmux
            let shutdown = try document["shutdown"].map { raw -> ShutdownMetadata in
                let object = try object("shutdown", raw)
                return ShutdownMetadata(
                    clean: try boolean("shutdown.clean", object["clean"]),
                    launchGeneration: try number("shutdown.launch_generation", object["launch_generation"])
                )
            } ?? fresh.shutdown
            state = PersistedAppState(
                schemaVersion: StateSchema.version,
                workspaces: try array("workspaces", document["workspaces"] ?? .array([])).enumerated().map {
                    try workspace("workspaces[\($0.offset)]", $0.element)
                },
                sessionMachines: try stringArray("session_machines", document["session_machines"] ?? .array([])),
                navigation: try document["navigation"].map { try navigation("navigation", $0) } ?? nil,
                sidebar: sidebar,
                splitRatio: try document["split"].map { try number("split.ratio", try object("split", $0)["ratio"]) } ?? fresh.splitRatio,
                zoomOffset: try document["terminal"].map {
                    try number("terminal.zoom_offset", try object("terminal", $0)["zoom_offset"])
                } ?? fresh.zoomOffset,
                smartButtons: try document["smart_buttons"].map { try smartButtons($0) } ?? fresh.smartButtons,
                windowFrame: frame,
                tmux: tmux,
                shutdown: shutdown
            )
        } catch let error as StateError where error.code == .invalid {
            return .corrupt(detail(error))
        } catch {
            return .corrupt(String(describing: error))
        }
        do {
            try StateValidation.validate(state)
        } catch let error as StateError {
            if error.code == .newerVersion { return .newerVersion }
            return .corrupt(detail(error))
        } catch {
            return .corrupt(String(describing: error))
        }
        return .state(state, migrated: migrated, migrationNotes: notes)
    }

    /// `decodeState`: a document with nothing prepared.
    public static func decode(_ bytes: [UInt8]) -> Decoded {
        switch parse(bytes) {
        case let .document(document, version, legacy): return decodeParsed(document, version: version, legacy: legacy)
        case let .corrupt(detail): return .corrupt(detail)
        case .newerVersion: return .newerVersion
        }
    }

    /// `detailOf`: the words a decode refusal contributes.
    static func detail(_ error: StateError) -> String {
        if let cause = error.cause, !cause.isEmpty { return cause }
        return error.code.reason
    }
}

extension WireJSON {
    /// The object without `key` (`delete object[key]`).
    func removing(_ key: String) -> WireJSON {
        guard case let .object(pairs) = self else { return self }
        return .object(pairs.filter { $0.key != key })
    }
}
