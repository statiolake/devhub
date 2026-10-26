// Port of apps/desktop/src/main/cli/protocol.ts
//
// DevHub's own front door, and the only one.
//
// The `devhub` CLI speaks this protocol over one unix socket in the running
// app's user-data directory. The framing is one JSON object per line, request
// then response, then the connection closes. There is no token: the socket
// lives under the user's own application-support directory, is created 0600
// inside a 0700 directory, and a unix socket carries no network reachability.
// Anything that can read it can already read the state file beside it.
//
// Both apps speak it byte-compatibly: the TypeScript `devhub` talks to the
// native app and the native `devhub` to the TypeScript one. The requests that
// exist only for VS Code workbenches (extensions, dev containers, port
// forwards, editor reattach) are still parsed exactly — a well-formed request
// is answered, not refused as garbage — and the native app answers them with
// a sentence saying they are not available (`ControlServer`).

import Foundation

public enum ControlSocket {
    /// Where the running app listens. One per user-data directory, so a
    /// scratch run and a real one never meet (`ProfileLocations.controlSocketPath`).
    public static func path(userDataPath: String) -> String {
        Path.join(userDataPath, "devhub", "control.sock")
    }
}

/// Where `--goto` asks for the cursor. One-based, as every editor counts.
public struct ControlPosition: Equatable, Sendable {
    public var line: Int
    public var column: Int

    public init(line: Int, column: Int) {
        self.line = line
        self.column = column
    }

    var json: WireJSON { ["line": .int(line), "column": .int(column)] }
}

/// A workbench window, as it names itself: its folder URI's parts.
public struct WindowFolderWire: Equatable, Sendable {
    public var scheme: String
    public var authority: String
    public var path: String
    public var fsPath: String

    public init(scheme: String, authority: String, path: String, fsPath: String) {
        self.scheme = scheme
        self.authority = authority
        self.path = path
        self.fsPath = fsPath
    }

    var json: WireJSON {
        [
            "scheme": .string(scheme), "authority": .string(authority), "path": .string(path),
            "fsPath": .string(fsPath),
        ]
    }
}

/// Where a window's editor is to be attached.
public enum ReattachTargetWire: Equatable, Sendable {
    case host
    case container(configPath: String)

    var json: WireJSON {
        switch self {
        case .host: return ["kind": "host"]
        case let .container(path): return ["configPath": .string(path)]
        }
    }
}

/// Rebuild the container on the way: with the cache, or without.
public enum RebuildWire: String, Equatable, Sendable {
    case cache
    case noCache = "no-cache"
}

/// An `open`, whole: a path, the machine it is on, where in it, and what is
/// waiting for it.
public struct ControlOpenRequest: Equatable, Sendable {
    public var path: String
    public var cwd: String
    /// Which computer `path` is a path on: `local`, or `ssh:<host>`. Absent
    /// means `local`, because that is what every caller that cannot say is.
    public var machine: String?
    /// Which pane the request came from: `<machine>\t<workspaceId |
    /// "scratch">\t<agentId | "none">`, as the pane's `DEVHUB_ORIGIN` spells it.
    public var origin: String?
    public var position: ControlPosition?
    /// `--wait`: the file the CLI is holding a terminal open for. The editor
    /// deletes it once the file is closed, and the CLI returns when it goes.
    public var waitMarkerPath: String?

    public init(
        path: String, cwd: String, machine: String? = nil, origin: String? = nil, position: ControlPosition? = nil,
        waitMarkerPath: String? = nil
    ) {
        self.path = path
        self.cwd = cwd
        self.machine = machine
        self.origin = origin
        self.position = position
        self.waitMarkerPath = waitMarkerPath
    }
}

public enum ControlRequest: Equatable, Sendable {
    /// Is there a DevHub behind this socket? Answered by the server loop
    /// itself: the answer is the *fact that an answer came back*.
    case ping
    /// `devhub`, with nothing after it: bring DevHub to the front.
    case activate
    case open(ControlOpenRequest)
    /// The `--wait` named by this marker is over: the editor was closed.
    case waitEnded(waitMarkerPath: String)
    case installExtensions(targets: [String], force: Bool, cwd: String)
    case uninstallExtensions(ids: [String], force: Bool)
    case listExtensions(showVersions: Bool)
    case version
    /// One reading of what the running app is costing.
    case metrics
    /// `devhub --tell`. `origin` is the asking pane's; `machine` which
    /// computer the asking `devhub` runs on (`DEVHUB_MACHINE`).
    case tell(TellCommand, origin: String?, machine: String?)
    /// An Agent for the workspace the current directory belongs to.
    case addAgent(profileId: String, args: [String], cwd: String)
    /// Put the `devhub` launcher on the PATH.
    case installCli
    /// Where a workbench on another machine should connect to.
    case resolveRemote(machine: String, attempt: Int)
    case devContainerConfigs(window: WindowFolderWire)
    case devContainerBuildLog(window: WindowFolderWire, configPath: String)
    case reattachEditor(window: WindowFolderWire, to: ReattachTargetWire, rebuild: RebuildWire?)
    case forwardPort(machine: String, host: String, port: Int, localPort: Int?, requireLocalPort: Bool?)
    case devContainerPorts(machine: String)
    /// How a workbench's integrated terminal attaches to its DevHub session.
    /// `root` nil is the folderless window.
    case terminalProfile(machine: String, root: String?, workspace: String?)

    public var kind: String {
        switch self {
        case .ping: return "ping"
        case .activate: return "activate"
        case .open: return "open"
        case .waitEnded: return "wait-ended"
        case .installExtensions: return "install-extensions"
        case .uninstallExtensions: return "uninstall-extensions"
        case .listExtensions: return "list-extensions"
        case .version: return "version"
        case .metrics: return "metrics"
        case .tell: return "tell"
        case .addAgent: return "add-agent"
        case .installCli: return "install-cli"
        case .resolveRemote: return "resolve-remote"
        case .devContainerConfigs: return "dev-container-configs"
        case .devContainerBuildLog: return "dev-container-build-log"
        case .reattachEditor: return "reattach-editor"
        case .forwardPort: return "forward-port"
        case .devContainerPorts: return "dev-container-ports"
        case .terminalProfile: return "terminal-profile"
        }
    }

    /// The request on the wire, keys in the order the TypeScript CLI writes
    /// them.
    public var json: WireJSON {
        let kind: (String, WireJSON?) = ("kind", .string(self.kind))
        switch self {
        case .ping, .activate, .version, .metrics, .installCli:
            return .object(dropping: [kind])
        case let .open(open):
            return .object(dropping: [
                kind, ("path", .string(open.path)), ("cwd", .string(open.cwd)), ("origin", .optional(open.origin)),
                ("machine", .optional(open.machine)), ("position", open.position?.json),
                ("waitMarkerPath", .optional(open.waitMarkerPath)),
            ])
        case let .waitEnded(marker):
            return .object(dropping: [kind, ("waitMarkerPath", .string(marker))])
        case let .installExtensions(targets, force, cwd):
            return .object(dropping: [
                kind, ("targets", .strings(targets)), ("force", .bool(force)), ("cwd", .string(cwd)),
            ])
        case let .uninstallExtensions(ids, force):
            return .object(dropping: [kind, ("ids", .strings(ids)), ("force", .bool(force))])
        case let .listExtensions(showVersions):
            return .object(dropping: [kind, ("showVersions", .bool(showVersions))])
        case let .tell(command, origin, machine):
            return .object(dropping: [
                kind, ("command", command.json), ("origin", .optional(origin)), ("machine", .optional(machine)),
            ])
        case let .addAgent(profileId, args, cwd):
            return .object(dropping: [
                kind, ("profileId", .string(profileId)), ("args", .strings(args)), ("cwd", .string(cwd)),
            ])
        case let .resolveRemote(machine, attempt):
            return .object(dropping: [kind, ("machine", .string(machine)), ("attempt", .int(attempt))])
        case let .devContainerConfigs(window):
            return .object(dropping: [kind, ("window", window.json)])
        case let .devContainerBuildLog(window, configPath):
            return .object(dropping: [kind, ("window", window.json), ("configPath", .string(configPath))])
        case let .reattachEditor(window, to, rebuild):
            return .object(dropping: [
                kind, ("window", window.json), ("to", to.json), ("rebuild", .optional(rebuild?.rawValue)),
            ])
        case let .forwardPort(machine, host, port, localPort, requireLocalPort):
            return .object(dropping: [
                kind, ("machine", .string(machine)), ("host", .string(host)), ("port", .int(port)),
                ("localPort", .optional(localPort)), ("requireLocalPort", .optional(requireLocalPort)),
            ])
        case let .devContainerPorts(machine):
            return .object(dropping: [kind, ("machine", .string(machine))])
        case let .terminalProfile(machine, root, workspace):
            return .object(dropping: [
                kind, ("machine", .string(machine)), ("root", root.map(WireJSON.string) ?? .null),
                ("workspace", .optional(workspace)),
            ])
        }
    }

    /// One line on the wire: the compact JSON and its newline.
    public var line: String { json.compact + "\n" }
}

/// A request that is not one this server understands, in the words the
/// TypeScript server uses.
public struct ControlProtocolError: Error, Equatable, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

extension ControlRequest {
    /// Reject anything that is not a request this server understands.
    public static func parse(_ line: String) throws -> ControlRequest {
        let value: WireJSON
        do {
            value = try WireJSON.parse(line)
        } catch let error as WireJSONError {
            throw ControlProtocolError(error.message)
        }
        return try parse(json: value)
    }

    public static func parse(json value: WireJSON) throws -> ControlRequest {
        // `typeof [] === "object"`: an array gets as far as having no kind.
        guard value.isObject || value.arrayValue != nil else {
            throw ControlProtocolError("a control request must be a JSON object")
        }
        func string(_ field: String, _ found: WireJSON? = nil, name: String? = nil) throws -> String {
            guard let text = (found ?? value[field])?.stringValue, !text.isEmpty, !text.contains("\0") else {
                throw ControlProtocolError("\(name ?? field) must be a non-empty string")
            }
            return text
        }
        func absolute(_ field: String, _ found: WireJSON? = nil, name: String? = nil) throws -> String {
            let raw = try string(field, found, name: name)
            guard raw.hasPrefix("/") else { throw ControlProtocolError("\(name ?? field) must be an absolute path") }
            return raw
        }
        func optionalString(_ field: String) throws -> String? {
            value[field] == nil ? nil : try string(field)
        }
        func strings(_ field: String) throws -> [String] {
            guard let items = value[field]?.arrayValue, items.allSatisfy({ $0.stringValue != nil }) else {
                throw ControlProtocolError("\(field) must be an array of strings")
            }
            return items.compactMap(\.stringValue)
        }
        func nonEmptyStrings(_ field: String) throws -> [String] {
            let items = try strings(field)
            if items.isEmpty || items.contains(where: \.isEmpty) {
                throw ControlProtocolError("\(field) must be a non-empty array of non-empty strings")
            }
            return items
        }
        func boolean(_ field: String) throws -> Bool {
            guard let flag = value[field]?.boolValue else { throw ControlProtocolError("\(field) must be a boolean") }
            return flag
        }
        func port(_ field: String) throws -> Int {
            guard let number = value[field]?.integerValue, number >= 1, number <= 65535 else {
                throw ControlProtocolError("\(field) must be a port number")
            }
            return number
        }
        func lineOrColumn(_ found: WireJSON?, _ field: String) throws -> Int {
            guard let number = found?.integerValue, number >= 1 else {
                throw ControlProtocolError("\(field) must be a whole number from 1 up")
            }
            return number
        }
        func window() throws -> WindowFolderWire {
            guard let record = value["window"], record.isObject else {
                throw ControlProtocolError("window must be the window's folder URI")
            }
            func part(_ field: String) throws -> String {
                guard let text = record[field]?.stringValue, !text.contains("\0") else {
                    throw ControlProtocolError("window.\(field) must be a string")
                }
                return text
            }
            return WindowFolderWire(
                scheme: try part("scheme"), authority: try part("authority"), path: try part("path"),
                fsPath: try part("fsPath"))
        }

        switch value["kind"]?.stringValue {
        case "ping": return .ping
        case "activate": return .activate
        case "open":
            var open = ControlOpenRequest(path: try absolute("path"), cwd: try absolute("cwd"))
            open.machine = try optionalString("machine")
            open.origin = try optionalString("origin")
            if let position = value["position"] {
                guard position.isObject else { throw ControlProtocolError("position must be an object") }
                open.position = ControlPosition(
                    line: try lineOrColumn(position["line"], "line"),
                    column: try lineOrColumn(position["column"], "column"))
            }
            if value["waitMarkerPath"] != nil { open.waitMarkerPath = try absolute("waitMarkerPath") }
            return .open(open)
        case "wait-ended":
            return .waitEnded(waitMarkerPath: try absolute("waitMarkerPath"))
        case "install-extensions":
            return .installExtensions(
                targets: try nonEmptyStrings("targets"), force: try boolean("force"), cwd: try absolute("cwd"))
        case "uninstall-extensions":
            return .uninstallExtensions(ids: try nonEmptyStrings("ids"), force: try boolean("force"))
        case "list-extensions":
            return .listExtensions(showVersions: try boolean("showVersions"))
        case "version": return .version
        case "metrics": return .metrics
        case "tell":
            let command: TellCommand
            do {
                command = try TellCommand(json: value["command"])
            } catch let error as TellCommandError {
                throw ControlProtocolError(error.message)
            }
            return .tell(command, origin: try optionalString("origin"), machine: try optionalString("machine"))
        case "add-agent":
            return .addAgent(profileId: try string("profileId"), args: try strings("args"), cwd: try absolute("cwd"))
        case "install-cli": return .installCli
        case "resolve-remote":
            let machine = try string("machine")
            guard let attempt = value["attempt"]?.integerValue, attempt >= 0 else {
                throw ControlProtocolError("attempt must be a whole number from 0 up")
            }
            return .resolveRemote(machine: machine, attempt: attempt)
        case "dev-container-configs":
            return .devContainerConfigs(window: try window())
        case "dev-container-build-log":
            return .devContainerBuildLog(window: try window(), configPath: try absolute("configPath"))
        case "reattach-editor":
            let window = try window()
            guard let to = value["to"], to.isObject else {
                throw ControlProtocolError("to must say where the editor goes")
            }
            let target: ReattachTargetWire =
                to["kind"]?.stringValue == "host"
                ? .host : .container(configPath: try absolute("configPath", to["configPath"], name: "to.configPath"))
            var rebuild: RebuildWire?
            if let raw = value["rebuild"] {
                guard let text = raw.stringValue, let parsed = RebuildWire(rawValue: text) else {
                    throw ControlProtocolError("rebuild must be \"cache\" or \"no-cache\"")
                }
                rebuild = parsed
            }
            return .reattachEditor(window: window, to: target, rebuild: rebuild)
        case "forward-port":
            let machine = try string("machine")
            let host = try string("host")
            let port = try port("port")
            let localPort: Int? =
                value["localPort"] == nil || value["localPort"] == .number(0) ? nil : try self.portValue(value, "localPort")
            let requireLocalPort: Bool? = value["requireLocalPort"] == nil ? nil : try boolean("requireLocalPort")
            return .forwardPort(
                machine: machine, host: host, port: port, localPort: localPort, requireLocalPort: requireLocalPort)
        case "dev-container-ports":
            return .devContainerPorts(machine: try string("machine"))
        case "terminal-profile":
            let machine = try string("machine")
            let root: String? = value["root"] == .null ? nil : try absolute("root")
            return .terminalProfile(machine: machine, root: root, workspace: try optionalString("workspace"))
        default:
            throw ControlProtocolError("unknown control request: \(JSStringIndex.jsString(value["kind"]))")
        }
    }

    private static func portValue(_ value: WireJSON, _ field: String) throws -> Int {
        guard let number = value[field]?.integerValue, number >= 1, number <= 65535 else {
            throw ControlProtocolError("\(field) must be a port number")
        }
        return number
    }
}

/// The command line a workbench's integrated terminal is started with, and
/// what that command needs in its environment to be itself — WP3's
/// `TerminalProfileAnswer`, on the wire.
extension TerminalProfileAnswer {
    /// Keys sorted: a dictionary has no order of its own to keep.
    public var json: WireJSON {
        [
            "file": .string(file), "args": .strings(args),
            "env": .object(env.keys.sorted().map { (key: $0, value: .string(env[$0]!)) }),
        ]
    }

    public init(json: WireJSON) throws {
        guard let file = json["file"]?.stringValue, let args = json["args"]?.arrayValue?.compactMap(\.stringValue)
        else { throw ControlProtocolError("a terminal profile needs a file and its args") }
        var env: [String: String] = [:]
        for pair in json["env"]?.objectValue ?? [] {
            if let value = pair.value.stringValue { env[pair.key] = value }
        }
        self.init(file: file, args: args, env: env)
    }
}

/// Where a remote workbench connects: a port on 127.0.0.1 and a token.
public struct RemoteEndpointAnswer: Equatable, Sendable {
    public var port: Int
    public var connectionToken: String
    public var extensionHostEnv: [(key: String, value: String)]?

    public init(port: Int, connectionToken: String, extensionHostEnv: [(key: String, value: String)]? = nil) {
        self.port = port
        self.connectionToken = connectionToken
        self.extensionHostEnv = extensionHostEnv
    }

    public static func == (lhs: RemoteEndpointAnswer, rhs: RemoteEndpointAnswer) -> Bool {
        lhs.json == rhs.json
    }

    public var json: WireJSON {
        .object(dropping: [
            ("port", .int(port)), ("connectionToken", .string(connectionToken)),
            ("extensionHostEnv", extensionHostEnv.map { env in .object(env.map { (key: $0.key, value: .string($0.value)) }) }),
        ])
    }
}

public struct ControlResponse: Equatable, Sendable {
    public var ok: Bool
    /// What the CLI prints, as-is.
    public var message: String
    /// A `terminal-profile` answer: data, not a sentence.
    public var profile: TerminalProfileAnswer?
    /// A `resolve-remote` answer's endpoint.
    public var remote: RemoteEndpointAnswer?
    /// Only on a failed `resolve-remote`: whether asking again could help.
    public var retry: Bool?
    /// A `tell` answer, as data: what `devhub --tell --json` prints.
    public var data: WireJSON?
    /// Any other field, kept as it came (`devContainers`, `buildLog`,
    /// `forward`, `ports` from a TypeScript app), in order.
    public var other: [(key: String, value: WireJSON)]

    public init(
        ok: Bool, message: String, profile: TerminalProfileAnswer? = nil, remote: RemoteEndpointAnswer? = nil,
        retry: Bool? = nil, data: WireJSON? = nil, other: [(key: String, value: WireJSON)] = []
    ) {
        self.ok = ok
        self.message = message
        self.profile = profile
        self.remote = remote
        self.retry = retry
        self.data = data
        self.other = other
    }

    public static func == (lhs: ControlResponse, rhs: ControlResponse) -> Bool {
        lhs.json == rhs.json
    }

    public var json: WireJSON {
        .object(
            dropping: [
                ("ok", .bool(ok)), ("message", .string(message)), ("profile", profile?.json), ("remote", remote?.json),
                ("retry", .optional(retry)), ("data", data),
            ] + other.map { ($0.key, Optional($0.value)) })
    }

    public var line: String { json.compact + "\n" }

    /// A response line as the CLI reads it (`JSON.parse(line) as ControlResponse`).
    public static func parse(_ line: String) throws -> ControlResponse {
        let value = try WireJSON.parse(line)
        guard value.isObject else { throw ControlProtocolError("DevHub answered with something that is not an object") }
        var response = ControlResponse(
            ok: value["ok"]?.boolValue ?? false, message: value["message"]?.stringValue ?? "")
        for (key, field) in value.objectValue ?? [] {
            switch key {
            case "ok", "message": continue
            case "profile": response.profile = try? TerminalProfileAnswer(json: field)
            case "remote":
                if let port = field["port"]?.integerValue, let token = field["connectionToken"]?.stringValue {
                    response.remote = RemoteEndpointAnswer(
                        port: port, connectionToken: token,
                        extensionHostEnv: field["extensionHostEnv"]?.objectValue?.compactMap { pair in
                            pair.value.stringValue.map { (key: pair.key, value: $0) }
                        })
                }
            case "retry": response.retry = field.boolValue
            case "data": response.data = field
            default: response.other.append((key: key, value: field))
            }
        }
        return response
    }
}
