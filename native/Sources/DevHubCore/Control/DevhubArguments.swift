// Port of apps/desktop/src/main/cli/devhubCli.ts (the argument half) and
// apps/desktop/src/main/cli/goto.ts
//
// The `devhub` command's arguments: what was asked for, and the control
// request that asks it. The whole of DevHub's behaviour lives on the other
// side of the socket; this is an argument parser and a request builder.

import Foundation

/// `devhub --help`, verbatim from the TypeScript CLI.
public let devhubUsage = """
    devhub — drive the running DevHub from a terminal.

    usage:
      devhub                           bring DevHub to the front
      devhub <folder>                  make the folder a workspace, show it, and
                                       bring DevHub to the front
      devhub <file>                    open the file in the workspace whose root
                                       contains it, or in the Scratch editor when
                                       no open workspace does
      devhub -                         open what is piped in as an editor, the way
                                       'code -' does; it lands in Scratch, like any
                                       other file no open workspace contains
      devhub -w|--wait <file>          open the file and do not return until its
                                       editor is closed again, so that this can be
                                       your EDITOR; closing it puts DevHub back
                                       where it was; combines with - and --goto
      devhub -g|--goto <file:line[:col]>
                                       open the file the same way and put the
                                       cursor on that line and column
      devhub --agent <profile> [-- <args>...]
                                       add an agent with that profile to the
                                       workspace containing the current directory
                                       and select it; <args> are appended to the
                                       profile's own arguments

    extensions:
      devhub --install-extension <ext-id|path-to-vsix>
                                       install an extension from the gallery, or
                                       from a .vsix file; repeat the option to
                                       install several
      devhub --uninstall-extension <ext-id>
                                       uninstall an extension; repeat for several
      --force                          install over an extension that is already
                                       there, and uninstall one the user marked as
                                       built in
      devhub --list-extensions         list the installed extensions, one per line
      --show-versions                  list them as <ext-id>@<version>

      devhub -v|--version              print DevHub's version, VS Code's, and the
                                       commit it was built from
      devhub --metrics                 print, as JSON, what the running DevHub is
                                       costing: every process's CPU and memory,
                                       which workbench each renderer is showing,
                                       and how often DevHub polls. Take two
                                       readings a known time apart to get a rate.
      devhub --tell <subcommand> ...   ask DevHub to do what its window does:
                                       list workspaces and agents, open a
                                       workspace, start an agent, hand it an
                                       Issue, read, message and answer agents.
                                       'devhub --tell help' lists them all
      devhub -h|--help                 show this text

    The command talks to DevHub over its control socket. If DevHub is not running
    it is started first, and the command then does what it was asked.
    """

/// What to say after a refusal, so nobody has to guess where the list is.
public let devhubHint = "Run 'devhub --help' to see what devhub takes."

/// Where the cursor goes. One-based, as every editor counts.
public typealias FilePosition = ControlPosition

/// What the arguments asked for.
public enum DevhubCommand: Equatable, Sendable {
    case usage
    case activate
    case openStdin(wait: Bool)
    case invalid(String)
    case open(path: String, position: FilePosition?, wait: Bool)
    case addAgent(profileId: String, args: [String])
    case installExtensions(targets: [String], force: Bool)
    case uninstallExtensions(ids: [String], force: Bool)
    case listExtensions(showVersions: Bool)
    case version
    case metrics
    case tell(TellCommand, json: Bool)
}

/// What a `devhub` run knows about where it is running: read from the
/// environment, because that is where DevHub put it — on the tmux session, at
/// the moment DevHub created it. A run from a login shell, a script or a cron
/// job has neither, and says so by leaving them out.
public struct CallerContext: Equatable, Sendable {
    /// The pane's `DEVHUB_ORIGIN`: which Workspace this terminal belongs to.
    public var origin: String?
    /// Which computer this `devhub` is running on, and so which the paths are on.
    public var machine: String?

    public init(origin: String? = nil, machine: String? = nil) {
        self.origin = origin
        self.machine = machine
    }

    /// The environment read once, so that nothing downstream reaches for it again.
    public init(environment: [String: String]) {
        let origin = environment["DEVHUB_ORIGIN"]
        let machine = environment["DEVHUB_MACHINE"]
        self.origin = origin?.isEmpty == false ? origin : nil
        self.machine = machine?.isEmpty == false ? machine : nil
    }
}

/// `FILE:LINE[:COLUMN]`, the way `code --goto` reads it (port of `goto.ts`).
///
/// The split is upstream's (`parseLineAndColumnAware`): split on `:`, and
/// every segment that is not a number is part of the path, because a path may
/// well contain a colon. What is added is a check upstream does not make: a
/// line has to be a whole number from 1 up. A spec with no line at all is just
/// a path.
public enum GotoSpec {
    public static let format = "the format for --goto is FILE:LINE(:COLUMN), for example src/main.ts:42:7."

    public struct Failure: Error, Equatable, CustomStringConvertible, Sendable {
        public var description: String { GotoSpec.format }
    }

    public static func parse(_ spec: String) throws -> (path: String, position: FilePosition?) {
        var path: String?
        var line: Double?
        var column: Double?
        for segment in spec.split(separator: ":", omittingEmptySubsequences: false).map(String.init) {
            let number = JavaScriptNumber.parse(segment)
            if !number.isFinite {
                path = path == nil ? segment : "\(path!):\(segment)"
            } else if line == nil {
                line = number
            } else if column == nil {
                column = number
            }
        }
        guard let path, !path.isEmpty else { throw Failure() }
        guard let line else { return (path, nil) }
        func positive(_ value: Double) -> Bool { value.rounded(.towardZero) == value && value >= 1 }
        if !positive(line) || (column.map { !positive($0) } ?? false) { throw Failure() }
        // A line without a column means the start of the line, which is column 1.
        // Past 2^53 a JavaScript number stops being exact; nothing has that
        // many lines, and an `Int` must not trap on it.
        func whole(_ value: Double) -> Int { Int(min(value, 9_007_199_254_740_991)) }
        return (path, FilePosition(line: whole(line), column: whole(column ?? 1)))
    }
}

public enum DevhubArguments {
    /// What the arguments asked for.
    ///
    /// `--` is the boundary and nothing else is: every argument after it
    /// belongs to the agent, including ones that look like DevHub's own
    /// options. `--agent` therefore has to come first, and everything else is
    /// read by the scanner below.
    ///
    /// An option this command does not know is a refusal with a sentence,
    /// never a path.
    public static func parse(_ argv: [String]) -> DevhubCommand {
        // Before anything else reads them: what follows `--tell` is its own
        // vocabulary, including words of free text that look like options.
        if argv.first == "--tell" {
            switch TellArguments.parse(Array(argv.dropFirst())) {
            case let .invalid(message): return .invalid("--tell: \(message)")
            case let .tell(command, json): return .tell(command, json: json)
            }
        }
        let args = splitAssignments(argv)
        // `devhub` on its own is not a mistake: put the app in front of you.
        if args.isEmpty { return .activate }
        if args[0] == "--help" || args[0] == "-h" { return .usage }
        if args[0] == "--agent" { return parseAgent(Array(args.dropFirst())) }
        return parseOptions(args)
    }

    /// `--option=value` is `--option value`; every reader downstream sees one form.
    static func splitAssignments(_ argv: [String]) -> [String] {
        var out: [String] = []
        for arg in argv {
            let equals = arg.hasPrefix("--") ? JSStringIndex.indexOf("=", in: arg) : -1
            if equals > 2 {
                out.append(JSStringIndex.prefix(arg, equals))
                out.append(JSStringIndex.suffix(arg, from: equals + 1))
            } else {
                out.append(arg)
            }
        }
        return out
    }

    static func parseAgent(_ rest: [String]) -> DevhubCommand {
        guard let profileId = rest.first, !profileId.hasPrefix("-") else {
            return .invalid("--agent needs the name of an agent profile.")
        }
        let args = Array(rest.dropFirst())
        if args.isEmpty { return .addAgent(profileId: profileId, args: []) }
        if args[0] != "--" {
            return .invalid(
                "arguments for the agent go after `--`, as in: devhub --agent claude -- --model opus.")
        }
        return .addAgent(profileId: profileId, args: Array(args.dropFirst()))
    }

    static func needsValue(_ option: String, _ what: String) -> DevhubCommand {
        .invalid("\(option) needs \(what).")
    }

    /// Everything that is not `--agent`: the options are gathered in any
    /// order and the mode is decided at the end, from what was gathered.
    static func parseOptions(_ args: [String]) -> DevhubCommand {
        var install: [String] = []
        var uninstall: [String] = []
        var paths: [String] = []
        var goto: String?
        var stdin = false
        var wait = false
        var force = false
        var list = false
        var showVersions = false
        var version = false
        var metrics = false

        var index = 0
        while index < args.count {
            let arg = args[index]
            // Every option that takes a value takes exactly one, and it is the
            // next argument.
            let takesValue = ["--install-extension", "--uninstall-extension", "-g", "--goto"].contains(arg)
            var value: String?
            if takesValue {
                index += 1
                value = index < args.count ? args[index] : nil
            }
            index += 1
            switch arg {
            case "--install-extension":
                guard let value, !value.isEmpty else {
                    return needsValue(arg, "an extension id or a path to a .vsix file")
                }
                install.append(value)
            case "--uninstall-extension":
                guard let value, !value.isEmpty else { return needsValue(arg, "an extension id") }
                uninstall.append(value)
            case "-g", "--goto":
                guard let value, !value.isEmpty else { return needsValue(arg, "a file, optionally with :line:column") }
                goto = value
            case "--force":
                force = true
            // A modifier rather than a mode: `--wait` says how to open, not
            // what to open.
            case "-w", "--wait":
                wait = true
            case "--list-extensions":
                list = true
            case "--show-versions":
                showVersions = true
            case "--metrics":
                metrics = true
            case "-v", "--version":
                version = true
            case "-h", "--help":
                return .usage
            // A lone `-` is the pipe, not an option and not a file called `-`.
            case "-":
                stdin = true
            default:
                if arg.hasPrefix("-") {
                    return .invalid("devhub does not know the option '\(arg)'.")
                }
                paths.append(arg)
            }
        }

        let modes = [
            !install.isEmpty, !uninstall.isEmpty, list, version, metrics, goto != nil, stdin, !paths.isEmpty,
        ].filter { $0 }.count
        if modes == 0 {
            return .invalid(
                wait
                    ? "--wait waits for a file to be closed, so it needs a file to open."
                    : "devhub was not asked to do anything.")
        }
        if modes > 1 { return .invalid("devhub does one of these things at a time.") }

        if !install.isEmpty { return .installExtensions(targets: install, force: force) }
        if !uninstall.isEmpty { return .uninstallExtensions(ids: uninstall, force: force) }
        if list { return .listExtensions(showVersions: showVersions) }
        if metrics { return .metrics }
        if version { return .version }
        if stdin { return .openStdin(wait: wait) }
        if let goto {
            do {
                let parsed = try GotoSpec.parse(goto)
                return .open(path: parsed.path, position: parsed.position, wait: wait)
            } catch {
                return .invalid(GotoSpec.format)
            }
        }
        if paths.count > 1 { return .invalid("devhub opens one path at a time.") }
        return .open(path: paths.first ?? "", position: nil, wait: wait)
    }

    /// `devhub -` reached the request builder before its pipe was spooled.
    public struct UnspooledStdin: Error, CustomStringConvertible, Sendable {
        public var description: String {
            "devhub -: stdin must be spooled to a file before the app is asked to open it"
        }
    }

    /// The control request the command sends; nil for usage and refusals.
    public static func request(
        for command: DevhubCommand, cwd: String, home: String, waitMarkerPath: String? = nil,
        caller: CallerContext = CallerContext()
    ) throws -> ControlRequest? {
        switch command {
        case .usage, .invalid:
            return nil
        case .openStdin:
            // `run` spools stdin to a file and continues as an `open` of that
            // file. Reaching here means that step was skipped.
            throw UnspooledStdin()
        case .activate:
            return .activate
        case let .open(path, position, _):
            // Passed through exactly as it arrived, including not at all.
            return .open(
                ControlOpenRequest(
                    path: PathResolution.expand(path, cwd: cwd, home: home), cwd: cwd, machine: caller.machine,
                    origin: caller.origin, position: position, waitMarkerPath: waitMarkerPath))
        case let .addAgent(profileId, args):
            return .addAgent(profileId: profileId, args: args, cwd: cwd)
        case let .installExtensions(targets, force):
            return .installExtensions(targets: targets, force: force, cwd: cwd)
        case let .uninstallExtensions(ids, force):
            return .uninstallExtensions(ids: ids, force: force)
        case let .listExtensions(showVersions):
            return .listExtensions(showVersions: showVersions)
        case .version:
            return .version
        case .metrics:
            return .metrics
        case let .tell(command, _):
            return .tell(expandTellPaths(command, cwd: cwd, home: home), origin: caller.origin, machine: caller.machine)
        }
    }

    /// The paths a `--tell` names, made absolute where the command was typed.
    static func expandTellPaths(_ command: TellCommand, cwd: String, home: String) -> TellCommand {
        switch command {
        case let .workspaceOpen(path, worktree):
            return .workspaceOpen(path: PathResolution.expand(path, cwd: cwd, home: home), worktree: worktree)
        case var .issueAssign(issue):
            if let repo = issue.repo { issue.repo = PathResolution.expand(repo, cwd: cwd, home: home) }
            return .issueAssign(issue)
        case let .agents(workspace):
            return .agents(workspace: workspace.map { expandWorkspacePath($0, cwd: cwd, home: home) })
        case var .agentNew(new):
            new.workspace = new.workspace.map { expandWorkspacePath($0, cwd: cwd, home: home) }
            return .agentNew(new)
        default:
            return command
        }
    }

    /// A `<w>` spelled as a relative path (`.`, `./x`, `~/x`) made absolute
    /// here, where it was typed: the app cannot know this shell's cwd, and on
    /// a host it is a path on the host. Ids, names and absolute roots pass
    /// through.
    public static func expandWorkspacePath(_ workspace: String, cwd: String, home: String) -> String {
        let relative =
            workspace == "." || workspace == ".." || workspace.hasPrefix("./") || workspace.hasPrefix("../")
            || workspace == "~" || workspace.hasPrefix("~/")
        return relative ? PathResolution.normalize(PathResolution.expand(workspace, cwd: cwd, home: home)) : workspace
    }

    /// Text given as `-` is what is piped in: a prompt or a message too long,
    /// or too full of quotes, for a command line.
    public static func withStdinText(_ command: TellCommand, _ stdin: String) -> TellCommand {
        // `/\n$/`: one newline, by itself — not the `\r` before it.
        var scalars = stdin.unicodeScalars
        if scalars.last == "\n" { scalars.removeLast() }
        let text = String(scalars)
        switch command {
        case let .agentSend(agent, current) where current == tellStdinText:
            return .agentSend(agent: agent, text: text)
        case var .agentNew(new) where new.prompt == tellStdinText:
            new.prompt = text
            return .agentNew(new)
        case var .issueAssign(issue) where issue.prompt == tellStdinText:
            issue.prompt = text
            return .issueAssign(issue)
        default:
            return command
        }
    }

    static func readsStdin(_ command: TellCommand) -> Bool {
        switch command {
        case let .agentSend(_, text): return text == tellStdinText
        case let .agentNew(new): return new.prompt == tellStdinText
        case let .issueAssign(issue): return issue.prompt == tellStdinText
        default: return false
        }
    }
}
