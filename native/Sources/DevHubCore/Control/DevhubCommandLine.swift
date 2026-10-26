// Port of apps/desktop/src/main/cli/devhubCli.ts (`main` and `run`)
//
// The `devhub` command, as a thing that is run.
//
// Nothing here knows the app: this is a socket client and an argument parser,
// and the whole of DevHub's behaviour lives on the other side of the socket —
// including `--version`, which the running app answers. When DevHub is not
// running the command starts it, waits for its socket, and then sends the
// request it was given (`DevhubLaunch`). Every command does this, so nothing
// downstream of the send is written twice.
//
// The process's world (output streams, stdin, the environment, where it runs)
// is `DevhubIO`, so the whole command runs in tests without a terminal.
//
// Two things differ from the TypeScript CLI, both because there is no
// workbench in the native app:
//
//  - `--install-extension`, `--uninstall-extension` and `--list-extensions`
//    are refused here with a sentence and exit status 2 (PLAN §1).
//  - `--version` with no `DEVHUB_CONTROL_SOCKET` (the bare binary, as CI and
//    a person poking at the bundle run it) prints the CLI's own version
//    instead of failing; with a socket it asks the app, as the TypeScript CLI
//    does.

import Foundation

/// The process a `devhub` run lives in.
public protocol DevhubIO: Sendable {
    /// One line on stdout (`console.log`).
    func out(_ text: String)
    /// One line on stderr (`console.error`).
    func err(_ text: String)
    var environment: [String: String] { get }
    var cwd: String { get }
    var home: String { get }
    var temporaryDirectory: String { get }
    /// stdin is a terminal: nothing is piped in, and nothing ever will be.
    var stdinIsTerminal: Bool { get }
    /// All of stdin, as text.
    func readStdin() -> String
    /// All of stdin, into a new file at `path`, byte for byte.
    func spoolStdin(to path: String) throws
}

/// The real process.
public struct ProcessDevhubIO: DevhubIO {
    public init() {}

    public func out(_ text: String) { FileHandle.standardOutput.write(Data((text + "\n").utf8)) }
    public func err(_ text: String) { FileHandle.standardError.write(Data((text + "\n").utf8)) }
    public var environment: [String: String] { ProcessInfo.processInfo.environment }
    public var cwd: String { FileManager.default.currentDirectoryPath }
    public var home: String { ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory() }
    public var temporaryDirectory: String {
        // `os.tmpdir()`: $TMPDIR without its trailing slash, else /tmp.
        var directory = ProcessInfo.processInfo.environment["TMPDIR"] ?? "/tmp"
        while directory.count > 1 && directory.hasSuffix("/") { directory.removeLast() }
        return directory.isEmpty ? "/tmp" : directory
    }
    public var stdinIsTerminal: Bool { isatty(STDIN_FILENO) != 0 }
    public func readStdin() -> String {
        String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
    }
    public func spoolStdin(to path: String) throws {
        try DevhubWait.spoolStdin(from: FileHandle.standardInput, to: path)
    }
}

public enum DevhubCommandLine {
    /// The control socket and launcher seams a run uses; real ones by default.
    public struct World: Sendable {
        public var ask: @Sendable (String, ControlRequest) async throws -> ControlResponse
        public var launcher: (@Sendable (String, CallerContext, [String: String]) throws -> any DevhubLauncher)?
        public var waitWorld: @Sendable (String, String) -> any WaitWorld

        public init(
            ask: @escaping @Sendable (String, ControlRequest) async throws -> ControlResponse = ControlClient.ask,
            launcher: (@Sendable (String, CallerContext, [String: String]) throws -> any DevhubLauncher)? = nil,
            waitWorld: @escaping @Sendable (String, String) -> any WaitWorld = { marker, socket in
                MarkerWaitWorld(markerPath: marker, socketPath: socket)
            }
        ) {
            self.ask = ask
            self.launcher = launcher
            self.waitWorld = waitWorld
        }
    }

    /// What to do when nothing is listening — and the two machines answer it
    /// differently in kind: on DevHub's own machine there is an app to start;
    /// on a host there is not.
    static func defaultLauncher(socketPath: String, caller: CallerContext, environment: [String: String]) throws
        -> any DevhubLauncher
    {
        if caller.machine == nil || caller.machine == "local" {
            return CommandLauncher(
                socketPath: socketPath,
                command: try DevhubLaunch.parseLaunchCommand(environment[launchCommandEnvironmentVariable]),
                environment: environment)
        }
        return ForwardedSocketLauncher(socketPath: socketPath, machine: caller.machine!)
    }

    public static func run(_ argv: [String], io: any DevhubIO, world: World = World()) async -> Int32 {
        let parsed = DevhubArguments.parse(argv)
        var command = parsed
        switch parsed {
        case .usage:
            io.out(devhubUsage)
            return 0
        case let .invalid(message):
            io.err("devhub: \(message)\n\(devhubHint)")
            return 2
        case .installExtensions, .uninstallExtensions, .listExtensions:
            io.err("devhub: \(NativeUnavailable.extensions)\n\(devhubHint)")
            return 2
        case .tell(.help, _):
            io.out(tellUsage)
            return 0
        case let .tell(tell, json) where DevhubArguments.readsStdin(tell):
            if io.stdinIsTerminal {
                io.err("devhub: '-' reads the text from what is piped in, and nothing is.")
                return 2
            }
            command = .tell(DevhubArguments.withStdinText(tell, io.readStdin()), json: json)
        case let .openStdin(wait):
            // `devhub -` becomes `devhub <spool file>` here, and everything
            // past this point is the ordinary open.
            if io.stdinIsTerminal {
                io.err(
                    "devhub: 'devhub -' opens what is piped into it, and nothing is piped into this one. Try: echo hello | devhub -\n\(devhubHint)"
                )
                return 2
            }
            let spool = DevhubWait.stdinSpoolPath(io.temporaryDirectory)
            do {
                try io.spoolStdin(to: spool)
            } catch {
                io.err(controlFailureText(error))
                return 1
            }
            command = .open(path: spool, position: nil, wait: wait)
        default:
            break
        }
        let environment = io.environment
        guard let socketPath = environment["DEVHUB_CONTROL_SOCKET"], !socketPath.isEmpty else {
            if case .version = command {
                io.out(DevHubVersion.description)
                return 0
            }
            io.err(
                "DEVHUB_CONTROL_SOCKET is not set. Run \"DevHub: Install 'devhub' command in PATH\" from DevHub's command palette to write a launcher that sets it."
            )
            return 1
        }
        let caller = CallerContext(environment: environment)
        // Read before anything is sent, not at the moment DevHub turns out to
        // be missing: a launcher that cannot say how to start DevHub is broken
        // whether or not this particular run needed it.
        let launcher: any DevhubLauncher
        do {
            launcher = try (world.launcher ?? defaultLauncher)(socketPath, caller, environment)
        } catch {
            io.err(controlFailureText(error))
            return 1
        }
        // The marker exists before the request that names it, because the
        // editor deletes it to say the file was closed — and a file that is
        // not there yet cannot be deleted, which would read as "closed".
        var marker: String?
        if case .open(_, _, true) = command {
            do {
                marker = try DevhubWait.createMarker(temporaryDirectory: io.temporaryDirectory)
            } catch {
                io.err(controlFailureText(error))
                return 1
            }
        }
        defer { if let marker { DevhubWait.removeMarker(marker) } }
        do {
            return try await send(command, socketPath: socketPath, launcher: launcher, caller: caller,
                marker: marker, io: io, world: world)
        } catch {
            io.err(controlFailureText(error))
            return 1
        }
    }

    /// Send the command, print the answer, and — for `--wait` — hold the
    /// terminal until the editor is closed.
    static func send(
        _ command: DevhubCommand, socketPath: String, launcher: any DevhubLauncher, caller: CallerContext, marker: String?,
        io: any DevhubIO, world: World
    ) async throws -> Int32 {
        guard
            let request = try DevhubArguments.request(
                for: command, cwd: io.cwd, home: io.home, waitMarkerPath: marker, caller: caller)
        else { return 2 }
        let ask = world.ask
        // A DevHub that is not running is started and then asked, so what
        // comes back is always an answer to the request above.
        let response = try await DevhubLaunch.sendOrLaunch({ try await ask(socketPath, request) }, launcher: launcher)
        let json: Bool
        if case let .tell(_, wantsJSON) = command { json = wantsJSON } else { json = false }
        if !response.ok {
            if json {
                io.out(WireJSON.object([(key: "ok", value: false), (key: "error", value: .string(response.message))]).compact)
            }
            io.err(response.message)
            return 1
        }
        if json {
            io.out(spreadOk(response.data).pretty)
            return 0
        }
        guard let marker else {
            io.out(response.message)
            return 0
        }
        // Nothing is printed for a `--wait`: this command is somebody's
        // EDITOR, and an EDITOR that writes to stdout writes into whatever is
        // reading it. The report is the exit status, and the file.
        try await DevhubWait.waitForClose(world.waitWorld(marker, socketPath))
        // The editor is closed, so DevHub goes back to where it was
        // (`WaitSelectionReturns`). Told rather than noticed, because this
        // process is the one that watched the marker.
        do {
            let ended = try await ask(socketPath, .waitEnded(waitMarkerPath: marker))
            if !ended.ok { io.err(ended.message) }
        } catch {
            // The edit itself happened, and `git commit` is reading this exit
            // status — so a DevHub that quit between closing the file and
            // being told about it must not fail a finished commit message.
            io.err(controlFailureText(error))
        }
        return 0
    }

    /// `{ ok: true, ...asRecord(data) }`: an object's keys after `ok`
    /// (an `ok` among them taking the first place's value), anything else
    /// under `data`.
    static func spreadOk(_ data: WireJSON?) -> WireJSON {
        var result: WireJSON = ["ok": true]
        let record: WireJSON
        if let data, data.isObject {
            record = data
        } else {
            // `asRecord(undefined)` is `{ data: undefined }`, which prints as `{}`.
            record = data.map { ["data": $0] } ?? [:]
        }
        for (key, value) in record.objectValue ?? [] {
            result = result.setting(key, value)
        }
        return result
    }
}
