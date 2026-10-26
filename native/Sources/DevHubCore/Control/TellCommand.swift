// Port of apps/desktop/src/main/cli/tell/command.ts
//
// `devhub --tell`: what can be asked of the running DevHub by name.
//
// One vocabulary, read in two places. The CLI turns a command line into a
// `TellCommand` (`TellArguments.parse`) and sends it as the `tell` control
// request; the app takes it back off the socket through `TellCommand(json:)`,
// which accepts exactly the shapes the parser can produce and nothing else.
// Neither side trusts the other to have checked: a socket is a door anything
// running as the user can knock on, and a command line is something a person
// (or an Agent) typed.
//
// Every operation here is one the person can already do in DevHub's own
// window — open a folder, start an Agent, hand an Issue to an Agent, write to
// an Agent, answer the question it asked — and it goes through the same path
// the window's does (see `TellService`). The one thing deliberately left out
// is a permission prompt: whether a tool call may run is the person's
// decision, in DevHub, and no command line can make it for them.

import Foundation

public enum AgentWaitUntil: String, Equatable, Sendable {
    case idle
    case waiting
    case any
}

public enum TellPresentation: String, Equatable, Sendable {
    case gui
    case tui
}

public enum IssuePlace: String, Equatable, Sendable {
    /// A new worktree for the branch (the default).
    case worktree
    /// The clone itself.
    case root
}

public struct TellAgentNew: Equatable, Sendable {
    /// Absent: the workspace of the pane that asked (`DEVHUB_ORIGIN`).
    public var workspace: String?
    public var profile: String?
    public var name: String?
    public var prompt: String?
    public var presentation: TellPresentation?

    public init(
        workspace: String? = nil, profile: String? = nil, name: String? = nil, prompt: String? = nil,
        presentation: TellPresentation? = nil
    ) {
        self.workspace = workspace
        self.profile = profile
        self.name = name
        self.prompt = prompt
        self.presentation = presentation
    }
}

public struct TellIssueAssign: Equatable, Sendable {
    public var url: String
    /// A clone of the repository: its absolute path. Absent: the first DevHub finds.
    public var repo: String?
    public var branch: String?
    /// Where the branch is checked out: a new worktree (default) or the clone itself.
    public var place: IssuePlace
    public var profile: String?
    /// One of the configured `agent_actions`, by id. Absent: the first enabled one.
    public var action: String?
    public var prompt: String?
    public var editorOnly: Bool
    public var presentation: TellPresentation?

    public init(
        url: String, repo: String? = nil, branch: String? = nil, place: IssuePlace = .worktree,
        profile: String? = nil, action: String? = nil, prompt: String? = nil, editorOnly: Bool = false,
        presentation: TellPresentation? = nil
    ) {
        self.url = url
        self.repo = repo
        self.branch = branch
        self.place = place
        self.profile = profile
        self.action = action
        self.prompt = prompt
        self.editorOnly = editorOnly
        self.presentation = presentation
    }
}

public enum TellCommand: Equatable, Sendable {
    case help
    case workspaces
    /// `path` is absolute, expanded on the CLI's side against its cwd;
    /// `worktree` a branch to open a worktree of, made if it is not there yet.
    case workspaceOpen(path: String, worktree: String?)
    case agents(workspace: String?)
    case agentNew(TellAgentNew)
    case issueAssign(TellIssueAssign)
    case agentRead(agent: String, last: Int?, since: String?)
    case agentSend(agent: String, text: String)
    case agentInterrupt(agent: String)
    case agentRequests(agent: String)
    /// `options` are one-based option numbers; `text` free text, for a
    /// question that takes an answer of its own.
    case agentAnswer(agent: String, request: String, options: [Int], text: String?)
    case agentWait(agent: String, until: AgentWaitUntil, timeoutSeconds: Int)
    /// The asking Agent's own terminal, opened or shown. `command` is typed
    /// into its shell when this starts it; `focus` puts the keyboard in it.
    case terminalOpen(command: String?, focus: Bool)
    case terminalStatus
    case terminalClose
    /// The panes of your Workspace's editor terminals, to `bring` by id.
    case terminalPanes
    /// Move one of those panes (tmux's id, `%7`) into your terminal, still running.
    case terminalBring(pane: String, focus: Bool)
    case commands
    case run(command: String)
    case focus(target: String)
    case notify(text: String)

    /// The longest `agent wait` there is: a request stays open no longer.
    public static let maxWaitSeconds = 600
    public static let defaultWaitSeconds = 300

    public var verb: String {
        switch self {
        case .help: return "help"
        case .workspaces: return "workspaces"
        case .workspaceOpen: return "workspace-open"
        case .agents: return "agents"
        case .agentNew: return "agent-new"
        case .issueAssign: return "issue-assign"
        case .agentRead: return "agent-read"
        case .agentSend: return "agent-send"
        case .agentInterrupt: return "agent-interrupt"
        case .agentRequests: return "agent-requests"
        case .agentAnswer: return "agent-answer"
        case .agentWait: return "agent-wait"
        case .terminalOpen: return "terminal-open"
        case .terminalStatus: return "terminal-status"
        case .terminalClose: return "terminal-close"
        case .terminalPanes: return "terminal-panes"
        case .terminalBring: return "terminal-bring"
        case .commands: return "commands"
        case .run: return "run"
        case .focus: return "focus"
        case .notify: return "notify"
        }
    }

    /// The command on the wire, keys in the order the TypeScript parser
    /// builds them, so both CLIs send the same bytes.
    public var json: WireJSON {
        let verb: (String, WireJSON?) = ("verb", .string(self.verb))
        switch self {
        case .help, .workspaces, .commands, .terminalStatus, .terminalClose, .terminalPanes:
            return .object(dropping: [verb])
        case let .workspaceOpen(path, worktree):
            return .object(dropping: [verb, ("path", .string(path)), ("worktree", .optional(worktree))])
        case let .agents(workspace):
            return .object(dropping: [verb, ("workspace", .optional(workspace))])
        case let .agentNew(new):
            return .object(dropping: [
                verb, ("workspace", .optional(new.workspace)), ("profile", .optional(new.profile)),
                ("name", .optional(new.name)), ("prompt", .optional(new.prompt)),
                ("presentation", .optional(new.presentation?.rawValue)),
            ])
        case let .issueAssign(issue):
            return .object(dropping: [
                verb, ("url", .string(issue.url)), ("place", .string(issue.place.rawValue)),
                ("editorOnly", .bool(issue.editorOnly)), ("repo", .optional(issue.repo)),
                ("branch", .optional(issue.branch)), ("profile", .optional(issue.profile)),
                ("action", .optional(issue.action)), ("prompt", .optional(issue.prompt)),
                ("presentation", .optional(issue.presentation?.rawValue)),
            ])
        case let .agentRead(agent, last, since):
            return .object(dropping: [
                verb, ("agent", .string(agent)), ("last", .optional(last)), ("since", .optional(since)),
            ])
        case let .agentSend(agent, text):
            return .object(dropping: [verb, ("agent", .string(agent)), ("text", .string(text))])
        case let .agentInterrupt(agent), let .agentRequests(agent):
            return .object(dropping: [verb, ("agent", .string(agent))])
        case let .agentAnswer(agent, request, options, text):
            return .object(dropping: [
                verb, ("agent", .string(agent)), ("request", .string(request)),
                ("options", .array(options.map { .int($0) })), ("text", .optional(text)),
            ])
        case let .agentWait(agent, until, timeoutSeconds):
            return .object(dropping: [
                verb, ("agent", .string(agent)), ("until", .string(until.rawValue)),
                ("timeoutSeconds", .int(timeoutSeconds)),
            ])
        case let .terminalOpen(command, focus):
            return .object(dropping: [verb, ("focus", .bool(focus)), ("command", .optional(command))])
        case let .terminalBring(pane, focus):
            return .object(dropping: [verb, ("pane", .string(pane)), ("focus", .bool(focus))])
        case let .run(command):
            return .object(dropping: [verb, ("command", .string(command))])
        case let .focus(target):
            return .object(dropping: [verb, ("target", .string(target))])
        case let .notify(text):
            return .object(dropping: [verb, ("text", .string(text))])
        }
    }
}

/// `devhub --tell`'s help, verbatim.
public let tellUsage = """
    devhub --tell — ask the running DevHub to do what its window does.

    usage: devhub --tell [--json] <subcommand> [arguments]

      --json  print the answer as JSON (for scripts and agents) instead of text

    workspaces
      workspaces                       list open workspaces: id, name, path,
                                       machine, branch, worktree, Issue
      workspace open <path> [--worktree <branch>]
                                       open a folder as a workspace (Cmd+Q f);
                                       with --worktree, open (making it if needed)
                                       the worktree of <branch> in the clone at
                                       <path>; the branch must name an Issue
                                       number, like 123-fix-login

    agents
      agents [--workspace <w>]         list agents: id, name, kind, status,
                                       unread, open requests, activity
      agent new [--workspace <w>] [--profile <p>] [--name <n>] [--gui|--tui]
                [--prompt <text>|-]    start an agent (Cmd+Q c) and, with
                                       --prompt, tell it something once it is up;
                                       without --workspace, in the workspace of
                                       the terminal or agent asking
      agent read <a> [--last <n>] [--since <cursor>]
                                       the transcript of a GUI agent, as text;
                                       prints a cursor to pass as --since
      agent send <a> <text>|-          say something to an agent; queued while
                                       it is busy, like the composer does
      agent interrupt <a>              stop the agent's current turn
      agent requests <a>               the questions it is waiting on, with ids
                                       (permission prompts are listed, but are
                                       answered in DevHub only)
      agent answer <a> <request> [--option <n>]... [--text <t>]
                                       answer an AskUserQuestion-style question
      agent wait <a> [--until idle|waiting|any] [--timeout <seconds>]
                                       return when the agent is idle, waiting on
                                       somebody, or either (default: any)

    issues
      issue assign <url> [--repo <path>] [--branch <name>] [--root]
                   [--profile <p>] [--action <id>] [--prompt <text>|-]
                   [--editor-only] [--gui|--tui]
                                       hand an Issue or pull request to a new
                                       agent (Cmd+Q i), in a worktree of
                                       <branch> (default: the Issue's own
                                       feature/<n>-wip)

    terminal (your own: one per agent, beside your pane; hidden with the editor alone)
      terminal open [--command <cmd>] [--focus]
                                       open your terminal, or show it if it is
                                       already open (the same one every time: a
                                       tmux session of its own, in your workspace,
                                       on its machine); prints the tmux handle.
                                       --command is typed into it only when this
                                       starts it
      terminal status                  your terminal: open/visible/focused, and the
                                       tmux handle with every pane in it (the
                                       person may have split it), each with where
                                       it is (top-left, bottom-right, ...)
      terminal close                   close it, and its session
      terminal panes                   the panes of your workspace's editor
                                       terminals: id, window, what runs in front
                                       (its command line, e.g. ssh host), cwd,
                                       title
      terminal bring <pane> [--focus]  move one of them (by id, %N) into your
                                       terminal, still running: it opens your
                                       terminal with it, or adds it as a split.
                                       An editor terminal left with no pane ends

    app
      commands                         list the command palette's commands
      run <command-id>                 run one of them, exactly as the palette
                                       does (it asks first wherever the window
                                       would)
      focus <agent|workspace>          select it in DevHub
      notify <text>                    show a notification in DevHub

    <w> is a workspace id, its folder, its name, or "scratch". A folder is a
    folder on the machine devhub runs on: on an SSH host, the host's.
    <a> is an agent id (or a unique prefix of one) or its name.
    """

/// What `devhub --tell …` asked for, or why it is not a request.
public enum TellParse: Equatable, Sendable {
    case tell(TellCommand, json: Bool)
    case invalid(String)
}

/// A value read from stdin, standing in for a `-` where text was asked for.
public let tellStdinText = "-"

public enum TellArguments {
    private struct Refusal: Error {
        let message: String
        init(_ message: String) { self.message = message }
    }

    private struct FlagSpec {
        /// Flags that take a value; repeated ones collect.
        var values: [String] = []
        /// Flags that stand alone.
        var switches: [String] = []
    }

    private struct Flags {
        var positional: [String] = []
        var values: [String: [String]] = [:]
        var switches: Set<String> = []
    }

    private static let noFlags = FlagSpec()

    private static func readFlags(_ args: [String], _ spec: FlagSpec) throws -> Flags {
        var flags = Flags()
        var index = 0
        while index < args.count {
            let arg = args[index]
            if arg == "--" {
                flags.positional.append(contentsOf: args[(index + 1)...])
                break
            }
            if arg.hasPrefix("--") {
                let equals = JSStringIndex.indexOf("=", in: arg)
                let name = equals > 2 ? JSStringIndex.prefix(arg, equals) : arg
                if spec.values.contains(name) {
                    let value: String?
                    if equals > 2 {
                        value = JSStringIndex.suffix(arg, from: equals + 1)
                    } else {
                        index += 1
                        value = index < args.count ? args[index] : nil
                    }
                    guard let value else { throw Refusal("\(name) needs a value.") }
                    flags.values[name, default: []].append(value)
                    index += 1
                    continue
                }
                if spec.switches.contains(name) && equals < 0 {
                    flags.switches.insert(name)
                    index += 1
                    continue
                }
                throw Refusal("\(arg) is not an option here.")
            }
            flags.positional.append(arg)
            index += 1
        }
        return flags
    }

    private static func one(_ flags: Flags, _ name: String) throws -> String? {
        guard let all = flags.values[name] else { return nil }
        if all.count > 1 { throw Refusal("\(name) is given more than once.") }
        return all.first
    }

    private static func positionals(_ flags: Flags, _ names: [String]) throws -> [String] {
        if flags.positional.count < names.count {
            throw Refusal("missing \(names[flags.positional.count...].joined(separator: " ")).")
        }
        if flags.positional.count > names.count {
            throw Refusal("unexpected \(WireJSON.quoted(flags.positional[names.count])).")
        }
        return flags.positional
    }

    private static func count(_ value: String, _ name: String, _ min: Int, _ max: Int) throws -> Int {
        guard !value.isEmpty, value.unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }) else {
            throw Refusal("\(name) takes a whole number.")
        }
        let number = Double(value) ?? .infinity
        if number < Double(min) || number > Double(max) {
            throw Refusal("\(name) takes a number from \(min) to \(max).")
        }
        return Int(number)
    }

    private static func presentation(_ flags: Flags) throws -> TellPresentation? {
        let gui = flags.switches.contains("--gui")
        let tui = flags.switches.contains("--tui")
        if gui && tui { throw Refusal("--gui and --tui ask for different things.") }
        return gui ? .gui : tui ? .tui : nil
    }

    /// `devhub --tell …`, everything after `--tell`.
    ///
    /// Paths are left as typed: the CLI expands them against its own cwd,
    /// which is the one place that knows it. Text given as `-` is left as `-`
    /// too, and read from stdin by the CLI before anything is sent.
    public static func parse(_ argv: [String]) -> TellParse {
        var args = argv
        var json = false
        while args.first == "--json" {
            json = true
            args.removeFirst()
        }
        do {
            return .tell(try parseVerb(args), json: json)
        } catch let refusal as Refusal {
            return .invalid(refusal.message)
        } catch {
            return .invalid("\(error)")
        }
    }

    private static func parseVerb(_ args: [String]) throws -> TellCommand {
        let head = args.first
        let sub = args.count > 1 ? args[1] : nil
        let rest = args.count > 2 ? Array(args[2...]) : []
        let afterHead = Array(args.dropFirst())
        switch head {
        case nil, "help", "--help", "-h":
            return .help
        case "workspaces":
            _ = try positionals(try readFlags(afterHead, noFlags), [])
            return .workspaces
        case "workspace":
            guard sub == "open" else { throw Refusal("workspace takes one subcommand: open.") }
            let flags = try readFlags(rest, FlagSpec(values: ["--worktree"]))
            let path = try positionals(flags, ["<path>"])[0]
            return .workspaceOpen(path: path, worktree: try one(flags, "--worktree"))
        case "agents":
            let flags = try readFlags(afterHead, FlagSpec(values: ["--workspace"]))
            _ = try positionals(flags, [])
            return .agents(workspace: try one(flags, "--workspace"))
        case "agent":
            return try parseAgent(sub, rest)
        case "issue":
            guard sub == "assign" else { throw Refusal("issue takes one subcommand: assign.") }
            let flags = try readFlags(
                rest,
                FlagSpec(
                    values: ["--repo", "--branch", "--profile", "--action", "--prompt", "--prompt-extra"],
                    switches: ["--root", "--worktree", "--editor-only", "--gui", "--tui"]))
            let url = try positionals(flags, ["<url>"])[0]
            if flags.switches.contains("--root") && flags.switches.contains("--worktree") {
                throw Refusal("--root and --worktree ask for different things.")
            }
            let prompt = try one(flags, "--prompt") ?? one(flags, "--prompt-extra")
            return .issueAssign(
                TellIssueAssign(
                    url: url,
                    repo: try one(flags, "--repo"),
                    branch: try one(flags, "--branch"),
                    place: flags.switches.contains("--root") ? .root : .worktree,
                    profile: try one(flags, "--profile"),
                    action: try one(flags, "--action"),
                    prompt: prompt,
                    editorOnly: flags.switches.contains("--editor-only"),
                    presentation: try presentation(flags)))
        case "terminal":
            return try parseTerminal(sub, rest)
        case "commands":
            _ = try positionals(try readFlags(afterHead, noFlags), [])
            return .commands
        case "run":
            return .run(command: try positionals(try readFlags(afterHead, noFlags), ["<command-id>"])[0])
        case "focus":
            return .focus(target: try positionals(try readFlags(afterHead, noFlags), ["<agent|workspace>"])[0])
        case "notify":
            if afterHead.isEmpty { throw Refusal("missing <text>.") }
            return .notify(text: afterHead.joined(separator: " "))
        case let .some(other):
            throw Refusal("\(WireJSON.quoted(other)) is not a --tell subcommand. Run 'devhub --tell help'.")
        }
    }

    private static func parseAgent(_ sub: String?, _ rest: [String]) throws -> TellCommand {
        switch sub {
        case "new":
            let flags = try readFlags(
                rest, FlagSpec(values: ["--workspace", "--profile", "--name", "--prompt"], switches: ["--gui", "--tui"]))
            _ = try positionals(flags, [])
            return .agentNew(
                TellAgentNew(
                    workspace: try one(flags, "--workspace"),
                    profile: try one(flags, "--profile"),
                    name: try one(flags, "--name"),
                    prompt: try one(flags, "--prompt"),
                    presentation: try presentation(flags)))
        case "read":
            let flags = try readFlags(rest, FlagSpec(values: ["--last", "--since"]))
            let agent = try positionals(flags, ["<agent>"])[0]
            let last = try one(flags, "--last")
            let since = try one(flags, "--since")
            return .agentRead(agent: agent, last: try last.map { try count($0, "--last", 1, 1000) }, since: since)
        case "send":
            // The words are the message, whatever they look like.
            guard let agent = rest.first else { throw Refusal("missing <agent>.") }
            let words = rest.dropFirst()
            if words.isEmpty { throw Refusal("missing <text> (or - for stdin).") }
            return .agentSend(agent: agent, text: words.joined(separator: " "))
        case "interrupt", "requests":
            let agent = try positionals(try readFlags(rest, noFlags), ["<agent>"])[0]
            return sub == "interrupt" ? .agentInterrupt(agent: agent) : .agentRequests(agent: agent)
        case "answer":
            let flags = try readFlags(rest, FlagSpec(values: ["--option", "--text"], switches: ["--allow", "--deny"]))
            if flags.switches.contains("--allow") || flags.switches.contains("--deny") {
                throw Refusal(
                    "permission prompts are answered in DevHub, by the person, and never from the command line.")
            }
            let named = try positionals(flags, ["<agent>", "<request>"])
            let options = try (flags.values["--option"] ?? []).map { try count($0, "--option", 1, 100) }
            let text = try one(flags, "--text")
            if options.isEmpty && text == nil {
                throw Refusal("agent answer needs --option <n> or --text <t>.")
            }
            return .agentAnswer(agent: named[0], request: named[1], options: options, text: text)
        case "wait":
            let flags = try readFlags(rest, FlagSpec(values: ["--until", "--timeout"]))
            let agent = try positionals(flags, ["<agent>"])[0]
            let untilText = try one(flags, "--until") ?? "any"
            guard let until = AgentWaitUntil(rawValue: untilText) else {
                throw Refusal("--until takes idle, waiting or any.")
            }
            let timeout = try one(flags, "--timeout")
            return .agentWait(
                agent: agent, until: until,
                timeoutSeconds: try timeout.map { try count($0, "--timeout", 1, TellCommand.maxWaitSeconds) }
                    ?? TellCommand.defaultWaitSeconds)
        default:
            throw Refusal("agent takes: new, read, send, interrupt, requests, answer, wait.")
        }
    }

    private static func parseTerminal(_ sub: String?, _ rest: [String]) throws -> TellCommand {
        switch sub {
        case "open":
            let flags = try readFlags(rest, FlagSpec(values: ["--command"], switches: ["--focus"]))
            _ = try positionals(flags, [])
            return .terminalOpen(command: try one(flags, "--command"), focus: flags.switches.contains("--focus"))
        case "status", "show":
            _ = try positionals(try readFlags(rest, noFlags), [])
            return .terminalStatus
        case "close":
            _ = try positionals(try readFlags(rest, noFlags), [])
            return .terminalClose
        case "panes":
            _ = try positionals(try readFlags(rest, noFlags), [])
            return .terminalPanes
        case "bring":
            let flags = try readFlags(rest, FlagSpec(switches: ["--focus"]))
            let pane = try positionals(flags, ["<pane>"])[0]
            guard EditorPaneCommands.isPaneId(pane) else {
                throw Refusal("bring takes a tmux pane id, like %7: see 'devhub --tell terminal panes'.")
            }
            return .terminalBring(pane: pane, focus: flags.switches.contains("--focus"))
        default:
            throw Refusal(
                "terminal takes: open, status (or show), close, panes, bring. It is always your own terminal, shown with your pane."
            )
        }
    }
}

/// A tell command off the socket that is not one the parser could produce.
public struct TellCommandError: Error, Equatable, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

extension TellCommand {
    /// The app's side: a `TellCommand` back off the socket, accepting exactly
    /// what `TellArguments.parse` can produce.
    public init(json value: WireJSON?) throws {
        guard let value, value.isObject else { throw TellCommandError("a tell command must be a JSON object") }
        func text(_ key: String) throws -> String {
            guard let found = value[key]?.stringValue, !found.isEmpty else {
                throw TellCommandError("a tell command's \(key) must be a non-empty string")
            }
            return found
        }
        func optionalText(_ key: String) throws -> String? {
            value[key] == nil ? nil : try text(key)
        }
        func optionalPresentation() throws -> TellPresentation? {
            guard let found = value["presentation"] else { return nil }
            guard let raw = found.stringValue, let presentation = TellPresentation(rawValue: raw) else {
                throw TellCommandError("a tell command's presentation must be gui or tui")
            }
            return presentation
        }
        func absolute(_ key: String) throws -> String {
            let found = try text(key)
            guard found.hasPrefix("/") else { throw TellCommandError("a tell command's \(key) must be an absolute path") }
            return found
        }
        func integer(_ found: WireJSON?, _ key: String, _ min: Int, _ max: Int) throws -> Int {
            guard let number = found?.integerValue, number >= min, number <= max else {
                throw TellCommandError("a tell command's \(key) must be a whole number from \(min) to \(max)")
            }
            return number
        }
        func focus() throws -> Bool {
            guard let flag = value["focus"]?.boolValue else {
                throw TellCommandError("a tell command's focus must be a boolean")
            }
            return flag
        }
        switch value["verb"]?.stringValue {
        case "help": self = .help
        case "workspaces": self = .workspaces
        case "commands": self = .commands
        case "workspace-open":
            self = .workspaceOpen(path: try absolute("path"), worktree: try optionalText("worktree"))
        case "agents":
            self = .agents(workspace: try optionalText("workspace"))
        case "agent-new":
            self = .agentNew(
                TellAgentNew(
                    workspace: try optionalText("workspace"), profile: try optionalText("profile"),
                    name: try optionalText("name"), prompt: try optionalText("prompt"),
                    presentation: try optionalPresentation()))
        case "issue-assign":
            guard let placeText = value["place"]?.stringValue, let place = IssuePlace(rawValue: placeText) else {
                throw TellCommandError("a tell command's place must be worktree or root")
            }
            guard let editorOnly = value["editorOnly"]?.boolValue else {
                throw TellCommandError("a tell command's editorOnly must be a boolean")
            }
            self = .issueAssign(
                TellIssueAssign(
                    url: try text("url"),
                    repo: value["repo"] == nil ? nil : try absolute("repo"),
                    branch: try optionalText("branch"),
                    place: place,
                    profile: try optionalText("profile"),
                    action: try optionalText("action"),
                    prompt: try optionalText("prompt"),
                    editorOnly: editorOnly,
                    presentation: try optionalPresentation()))
        case "agent-read":
            self = .agentRead(
                agent: try text("agent"),
                last: value["last"] == nil ? nil : try integer(value["last"], "last", 1, 1000),
                since: try optionalText("since"))
        case "agent-send":
            self = .agentSend(agent: try text("agent"), text: try text("text"))
        case "agent-interrupt":
            self = .agentInterrupt(agent: try text("agent"))
        case "agent-requests":
            self = .agentRequests(agent: try text("agent"))
        case "agent-answer":
            guard let options = value["options"]?.arrayValue else {
                throw TellCommandError("a tell command's options must be a list")
            }
            var answerText: String?
            if let found = value["text"] {
                guard let string = found.stringValue else {
                    throw TellCommandError("a tell command's text must be a string")
                }
                answerText = string
            }
            self = .agentAnswer(
                agent: try text("agent"), request: try text("request"),
                options: try options.map { try integer($0, "option", 1, 100) }, text: answerText)
        case "agent-wait":
            guard let raw = value["until"]?.stringValue, let until = AgentWaitUntil(rawValue: raw) else {
                throw TellCommandError("a tell command's until must be idle, waiting or any")
            }
            self = .agentWait(
                agent: try text("agent"), until: until,
                timeoutSeconds: try integer(
                    value["timeoutSeconds"], "timeoutSeconds", 1, TellCommand.maxWaitSeconds))
        case "terminal-open":
            let focus = try focus()
            self = .terminalOpen(command: try optionalText("command"), focus: focus)
        case "terminal-status": self = .terminalStatus
        case "terminal-close": self = .terminalClose
        case "terminal-panes": self = .terminalPanes
        case "terminal-bring":
            let focus = try focus()
            self = .terminalBring(pane: try text("pane"), focus: focus)
        case "run": self = .run(command: try text("command"))
        case "focus": self = .focus(target: try text("target"))
        case "notify": self = .notify(text: try text("text"))
        default:
            throw TellCommandError("unknown tell command: \(JSStringIndex.jsString(value["verb"]))")
        }
    }
}

/// JavaScript's string indexing, in UTF-16 units, where a port has to agree
/// with it about where an `=` is.
enum JSStringIndex {
    static func indexOf(_ needle: Character, in text: String) -> Int {
        guard let found = text.firstIndex(of: needle) else { return -1 }
        return text.utf16.distance(from: text.utf16.startIndex, to: found.samePosition(in: text.utf16)!)
    }

    static func prefix(_ text: String, _ units: Int) -> String {
        String(decoding: Array(text.utf16.prefix(units)), as: UTF16.self)
    }

    static func suffix(_ text: String, from units: Int) -> String {
        String(decoding: Array(text.utf16.dropFirst(units)), as: UTF16.self)
    }

    /// `String(value)` for a JSON value as JavaScript prints it in a message.
    static func jsString(_ value: WireJSON?) -> String {
        guard let value else { return "undefined" }
        switch value {
        case .null: return "null"
        case let .bool(flag): return flag ? "true" : "false"
        case let .number(number): return number.isNaN ? "NaN" : JavaScriptNumber.string(number)
        case let .string(text): return text
        case let .array(items): return items.map { jsString($0) }.joined(separator: ",")
        case .object: return "[object Object]"
        }
    }
}
