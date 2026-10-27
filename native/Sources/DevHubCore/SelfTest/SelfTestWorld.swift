// The world `DevHub --self-test`'s end-to-end phase runs in (and the Linux
// test that runs the same runtime without a window): a home of its own with a
// settings file, two project folders (one a git clone of a GitHub
// repository), a Claude session to resume, and stand-ins for the CLIs DevHub
// drives — `claude` and `codex` in their structured modes, and `gh` signed
// out. Nothing in it reaches the network or the person's own files.
//
// The stand-ins are small Python programs (`python3` is on every Mac the
// self-test runs on, and in the Linux test's image). They are not models:
//
// - `claude` answers the control requests DevHub makes (`initialize`,
//   `mcp_status`, `get_usage`, `set_model`, …), echoes every message it is
//   sent the way `--replay-user-messages` does, and answers it with a streamed
//   reply in Markdown — a table, a TypeScript code block, inline and display
//   math. A message that says "permission" is answered with a Bash call that
//   asks for permission first (`can_use_tool`), and the reply after it says
//   which answer it got.
// - `codex` is an `app-server`: the handshake, `model/list` with two models,
//   and a turn that says one thing.
// - `gh` is signed out: `gh auth token` declines.
//
// Every line a stand-in reads is appended to `log` as JSON (`FakeLogLine`),
// so a check can see what DevHub actually wrote.

import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

public struct SelfTestWorld: Sendable {
    /// The world's root; everything below is made by `make`.
    public let home: String
    public let locations: ProfileLocations
    public let scratchRoot: String
    public let bin: String
    public let projects: String
    /// A git clone of `acme/widget`, the folder the Issue flow finds.
    public let alpha: String
    /// A plain folder.
    public let beta: String
    public let claudeConfig: String
    public let codexHome: String
    public let log: String
    public let python: String

    public static let claudeProfile = "fake-claude"
    public static let codexProfile = "fake-codex"
    /// The session `claude` was in before, which `/resume` lists.
    public static let pastSession = "00000000-0000-4000-8000-00000000e2e0"
    /// What a reply of the stand-in Claude says first, to look for.
    public static let replyMarker = "Fake reply"
    public static let issueURL = "https://github.com/acme/widget/issues/7"

    /// `python3`, where it is.
    public static func findPython(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        let path = environment["PATH"] ?? ""
        let candidates = path.split(separator: ":").map { "\($0)/python3" } + ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// The canonical path (`realpath(3)`), as DevHub names Workspace roots.
    public static func canonical(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else { return path }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    /// Make the world under `home` (which must not exist yet, or be empty).
    /// `git` is run to make the clone; a failure says which step.
    public static func make(home: String, scratchRoot: String, profile: String = "selftest", python: String, git: String = "/usr/bin/git") throws -> SelfTestWorld {
        let fm = FileManager.default
        try fm.createDirectory(atPath: home, withIntermediateDirectories: true)
        try fm.createDirectory(atPath: scratchRoot, withIntermediateDirectories: true)
        let home = canonical(home)
        let scratchRoot = canonical(scratchRoot)
        let locations = ProfileLocations(profile: profile, home: home, environment: [:])
        let world = SelfTestWorld(
            home: home, locations: locations, scratchRoot: scratchRoot, bin: Path.join(home, "bin"),
            projects: Path.join(home, "projects"), alpha: Path.join(home, "projects", "alpha"),
            beta: Path.join(home, "projects", "beta"), claudeConfig: Path.join(home, "claude-config"),
            codexHome: Path.join(home, "codex-home"), log: Path.join(home, "fake-cli.log"), python: python)
        for directory in [world.bin, world.alpha, world.beta, world.claudeConfig, world.codexHome, locations.configDirectory] {
            try fm.createDirectory(atPath: directory, withIntermediateDirectories: true)
        }
        try world.write(Self.claudeScript, to: Path.join(world.bin, "claude"), shebang: "#!\(python)\n", executable: true)
        try world.write(Self.codexScript, to: Path.join(world.bin, "codex"), shebang: "#!\(python)\n", executable: true)
        try world.write(Self.ghScript(log: world.log), to: Path.join(world.bin, "gh"), shebang: "#!/bin/sh\n", executable: true)
        try world.write(world.settingsText(), to: locations.settingsFilePath)
        try world.write("# The beta project\n", to: Path.join(world.beta, "README.md"))
        // The clone the Issue flow finds by its origin.
        try world.write("# widget\n", to: Path.join(world.alpha, "README.md"))
        for args in [
            ["init", "-q", "-b", "main"], ["config", "user.email", "selftest@example.com"], ["config", "user.name", "Self Test"],
            ["remote", "add", "origin", "https://github.com/acme/widget.git"], ["add", "README.md"],
            ["commit", "-q", "-m", "First"],
        ] {
            try run(git, ["-C", world.alpha] + args)
        }
        try world.seedClaudeSession()
        return world
    }

    private static func run(_ executable: String, _ args: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        var environment = ProcessInfo.processInfo.environment
        environment["GIT_CONFIG_NOSYSTEM"] = "1"
        environment["HOME"] = FileManager.default.temporaryDirectory.path
        process.environment = environment
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus != 0 {
            throw DevhubFailure("`\(([executable] + args).joined(separator: " "))` exited \(process.terminationStatus)")
        }
    }

    private func write(_ text: String, to path: String, shebang: String = "", executable: Bool = false) throws {
        try (shebang + text).write(toFile: path, atomically: true, encoding: .utf8)
        if executable { try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path) }
    }

    /// `"…"` for TOML.
    private static func quoted(_ text: String) -> String {
        "\"" + text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// The settings the run starts on.
    public func settingsText() -> String {
        let q = Self.quoted
        return """
            version = \(Int(ConfigConstants.schemaVersion))

            [general]
            workbench = "terminal"
            import_login_environment = false
            notify_on_idle = false
            notice_seconds = 2

            [scratch]
            daily = \(q("\(scratchRoot)/YYYYMMDD"))

            [appearance]
            title_bar = "hidden"

            [agents]
            default_presentation = "gui"

            [[workspace_sources]]
            id = "self-test"
            type = "filesystem"
            path = \(q(projects))
            min_depth = 1
            max_depth = 1

            [[agent_profiles]]
            id = \(q(Self.claudeProfile))
            display_name = "Fake Claude"
            kind = "claude"
            command = \(q(Path.join(bin, "claude")))
            presentation = "gui"
            env = { CLAUDE_CONFIG_DIR = \(q(claudeConfig)), DEVHUB_FAKE_LOG = \(q(log)) }

            [[agent_profiles]]
            id = \(q(Self.codexProfile))
            display_name = "Fake Codex"
            kind = "codex"
            command = \(q(Path.join(bin, "codex")))
            presentation = "gui"
            env = { CODEX_HOME = \(q(codexHome)), DEVHUB_FAKE_LOG = \(q(log)) }

            """
    }

    /// One earlier Claude session in `alpha`, where Claude keeps it.
    private func seedClaudeSession() throws {
        let cwd = Self.canonical(alpha)
        let project = String(decoding: cwd.utf16.map { unit -> UInt16 in
            switch unit {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A: return unit
            default: return 0x2D
            }
        }, as: UTF16.self)
        let directory = Path.join(claudeConfig, "projects", project)
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let id = Self.pastSession
        func line(_ object: [String: Any]) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
        }
        let common: [String: Any] = ["isSidechain": false, "userType": "external", "cwd": cwd, "sessionId": id, "version": "2.1.0", "gitBranch": "main"]
        var user = common
        user.merge(["parentUuid": NSNull(), "type": "user", "uuid": "e2e-u1", "timestamp": "2026-09-20T10:00:01.000Z",
                    "message": ["role": "user", "content": "An earlier question about the widget"]]) { $1 }
        var assistant = common
        assistant.merge(["parentUuid": "e2e-u1", "type": "assistant", "uuid": "e2e-a1", "timestamp": "2026-09-20T10:00:02.000Z",
                         "message": ["id": "msg_e2e_0", "type": "message", "role": "assistant", "model": "claude-sonnet-5",
                                     "content": [["type": "text", "text": "An earlier answer about the widget."]], "stop_reason": "end_turn"]]) { $1 }
        let lines = [try line(user), try line(assistant),
                     try line(["type": "ai-title", "aiTitle": "The earlier widget session", "sessionId": id])]
        try write(lines.joined(separator: "\n") + "\n", to: Path.join(directory, "\(id).jsonl"))
    }

    // MARK: What the stand-ins read

    /// One line a stand-in read, as it logged it.
    public struct FakeLogLine: Equatable, Sendable {
        public var cli: String
        public var line: String
    }

    /// Everything the stand-ins have read so far.
    public func fakeLog() -> [FakeLogLine] {
        guard let text = try? String(contentsOfFile: log, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { row in
            guard let object = try? JSONSerialization.jsonObject(with: Data(row.utf8)) as? [String: Any],
                  let cli = object["cli"] as? String, let line = object["line"] as? String else { return nil }
            return FakeLogLine(cli: cli, line: line)
        }
    }

    // MARK: The stand-ins

    static func ghScript(log: String) -> String {
        """
        # gh, signed out: every question is declined.
        printf '{"cli":"gh","line":"%s"}\\n' "$*" >> \(quoted(log).replacingOccurrences(of: "\"", with: "'"))
        echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2
        exit 1

        """
    }

    static let claudeScript = #"""
# A stand-in for `claude -p --input-format stream-json --output-format
# stream-json`: see SelfTestWorld.swift. Not a model.
import json, os, sys, time, uuid

LOG = os.environ.get("DEVHUB_FAKE_LOG")
SESSION = "00000000-0000-4000-8000-00000000e2e1"
MODEL = "claude-sonnet-5"

def log(line):
    if LOG:
        with open(LOG, "a") as f:
            f.write(json.dumps({"cli": "claude", "pid": os.getpid(), "line": line}) + "\n")

def out(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def ids():
    return str(uuid.uuid4())

def event(e):
    out({"type": "stream_event", "event": e, "parent_tool_use_id": None, "session_id": SESSION, "uuid": ids()})

def assistant(msg_id, block):
    out({"type": "assistant", "message": {"id": msg_id, "type": "message", "role": "assistant", "model": MODEL,
         "content": [block]}, "parent_tool_use_id": None, "session_id": SESSION, "uuid": ids()})

def text_block(msg_id, index, text, pieces=6):
    event({"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}})
    size = max(1, len(text) // pieces + 1)
    for start in range(0, len(text), size):
        event({"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": text[start:start + size]}})
        time.sleep(0.04)
    event({"type": "content_block_stop", "index": index})
    assistant(msg_id, {"type": "text", "text": text})

def message_start(msg_id):
    event({"type": "message_start", "message": {"id": msg_id, "type": "message", "role": "assistant", "content": [], "model": MODEL}})

def message_end(reason):
    event({"type": "message_delta", "delta": {"stop_reason": reason}, "usage": {"output_tokens": 40}})
    event({"type": "message_stop"})

def result(text):
    out({"type": "result", "subtype": "success", "is_error": False, "duration_ms": 900, "duration_api_ms": 800,
         "num_turns": 1, "result": text, "session_id": SESSION, "total_cost_usd": 0.001,
         "usage": {"input_tokens": 100, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 40},
         "permission_denials": [], "uuid": ids()})

REPLY = ("Fake reply: here is **Markdown** from the stand-in.\n\n"
         "| Name | Value |\n|---|---|\n| alpha | 1 |\n| beta | 2 |\n\n"
         "```ts\nconst answer: number = 42;\nconsole.log(answer);\n```\n\n"
         "Inline math $e^{i\\pi} + 1 = 0$ and a display:\n\n"
         "$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$\n\n"
         "The end of the fake reply.")

COMMANDS = [{"name": "compact", "description": "Compact the conversation", "argumentHint": "[instructions]"},
            {"name": "review", "description": "Review a pull request", "argumentHint": "<pr>"}]
MODELS = [{"value": "default", "displayName": "Default", "description": "Recommended", "supportedEffortLevels": ["low", "medium", "high"]},
          {"value": "sonnet", "displayName": "Sonnet", "description": "Everyday tasks", "resolvedModel": "claude-sonnet-5", "supportedEffortLevels": ["low", "medium", "high"]},
          {"value": "opus", "displayName": "Opus", "description": "Hard tasks", "resolvedModel": "claude-opus-5", "supportedEffortLevels": ["low", "medium", "high"]}]

pending = {}
counter = [0]

def answer(request_id, response):
    out({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": response}})

def control(request_id, request):
    subtype = request.get("subtype")
    if subtype == "initialize":
        answer(request_id, {"commands": COMMANDS, "models": MODELS, "current_permission_mode": "default"})
        out({"type": "system", "subtype": "init", "session_id": SESSION, "cwd": os.getcwd(), "model": MODEL,
             "permissionMode": "default", "slash_commands": [c["name"] for c in COMMANDS], "claude_code_version": "2.1.0",
             "tools": ["Bash", "Read"], "mcp_servers": [], "uuid": ids()})
    elif subtype == "mcp_status":
        answer(request_id, {"mcpServers": []})
    elif subtype == "get_usage":
        answer(request_id, {"rate_limits_available": False})
    else:
        answer(request_id, {})

def user(message):
    content = message.get("message", {}).get("content")
    if isinstance(content, list):
        text = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    else:
        text = content or ""
    out({"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": None,
         "session_id": SESSION, "uuid": ids(), "isReplay": True})
    counter[0] += 1
    msg_id = "msg_fake_%d" % counter[0]
    message_start(msg_id)
    if "permission" in text.lower():
        text_block(msg_id, 0, "I will run a command first.", 2)
        tool = "toolu_fake_%d" % counter[0]
        command = {"command": "echo devhub-self-test", "description": "Say something"}
        event({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": tool, "name": "Bash", "input": {}}})
        event({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": json.dumps(command)}})
        event({"type": "content_block_stop", "index": 1})
        assistant(msg_id, {"type": "tool_use", "id": tool, "name": "Bash", "input": command})
        message_end("tool_use")
        request = "perm-%d" % counter[0]
        pending[request] = (tool, command)
        out({"type": "control_request", "request_id": request, "request": {"subtype": "can_use_tool", "tool_name": "Bash",
             "input": command, "tool_use_id": tool, "permission_suggestions": []}})
        return
    text_block(msg_id, 0, REPLY)
    message_end("end_turn")
    result(REPLY)

def permitted(request_id, response):
    tool, command = pending.pop(request_id)
    behavior = (response or {}).get("behavior", "unknown")
    out({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool,
         "content": "devhub-self-test" if behavior == "allow" else "Permission denied", "is_error": behavior != "allow"}]},
         "parent_tool_use_id": None, "session_id": SESSION, "uuid": ids()})
    counter[0] += 1
    msg_id = "msg_fake_%d" % counter[0]
    message_start(msg_id)
    text = "Permission answer: %s." % behavior
    text_block(msg_id, 0, text, 2)
    message_end("end_turn")
    result(text)

for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    log(line)
    try:
        message = json.loads(line)
    except ValueError:
        continue
    kind = message.get("type")
    if kind == "control_request":
        control(message.get("request_id"), message.get("request") or {})
    elif kind == "control_response":
        response = message.get("response") or {}
        if response.get("request_id") in pending:
            permitted(response.get("request_id"), response.get("response"))
    elif kind == "user":
        user(message)
"""#

    static let codexScript = #"""
# A stand-in for `codex app-server`: see SelfTestWorld.swift. Not a model.
import json, os, sys

LOG = os.environ.get("DEVHUB_FAKE_LOG")
THREAD = "00000000-0000-7000-8000-00000000e2e2"

def log(line):
    if LOG:
        with open(LOG, "a") as f:
            f.write(json.dumps({"cli": "codex", "pid": os.getpid(), "line": line}) + "\n")

def out(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def thread():
    cwd = os.getcwd()
    return {"id": THREAD, "sessionId": THREAD, "forkedFromId": None, "parentThreadId": None, "preview": "", "ephemeral": False,
            "section": None, "sectionEnteredAt": None, "projectId": None, "historyMode": "paginated", "modelProvider": "openai",
            "model": "gpt-5.5-codex", "reasoningEffort": "medium", "createdAt": 1790000000, "updatedAt": 1790000000,
            "recencyAt": None, "status": {"type": "idle"}, "path": None, "cwd": cwd, "cliVersion": "0.156.1", "originator": None,
            "source": "appServer", "threadSource": None, "agentNickname": None, "agentRole": None, "gitInfo": None, "name": None,
            "turns": []}

def model(id, name, efforts, default):
    return {"id": id, "model": id, "upgrade": None, "upgradeInfo": None, "availabilityNux": None, "displayName": name,
            "description": "A stand-in model", "modelSpecialty": None, "hidden": False,
            "supportedReasoningEfforts": [{"reasoningEffort": e, "description": e} for e in efforts],
            "defaultReasoningEffort": efforts[0], "inputModalities": ["text"], "supportsPersonality": False,
            "multiAgentVersion": None, "additionalSpeedTiers": [], "serviceTiers": [], "defaultServiceTier": None,
            "availableAccessPrograms": None, "isDefault": default}

turns = [0]

def turn(id, params):
    turns[0] += 1
    turn_id = "turn-%d" % turns[0]
    started = {"id": turn_id, "items": [], "itemsView": "notLoaded", "status": "inProgress", "error": None,
               "startedAt": 1790000000, "completedAt": None, "durationMs": None}
    out({"id": id, "result": {"turn": started}})
    out({"method": "turn/started", "params": {"threadId": THREAD, "turn": started}})
    text = ""
    for part in params.get("input") or []:
        if isinstance(part, dict) and part.get("type") == "text":
            text += part.get("text", "")
    user = {"type": "userMessage", "id": "item-user-%d" % turns[0], "clientId": params.get("clientId"),
            "content": [{"type": "text", "text": text, "text_elements": []}]}
    out({"method": "item/started", "params": {"item": user, "threadId": THREAD, "turnId": turn_id, "startedAtMs": 1790000000000}})
    out({"method": "item/completed", "params": {"item": user, "threadId": THREAD, "turnId": turn_id, "completedAtMs": 1790000000000}})
    say = {"type": "agentMessage", "id": "item-say-%d" % turns[0], "text": "", "phase": None, "memoryCitation": None,
           "delivery": None, "questions": None}
    out({"method": "item/started", "params": {"item": say, "threadId": THREAD, "turnId": turn_id, "startedAtMs": 1790000000000}})
    reply = "Fake Codex reply."
    out({"method": "item/agentMessage/delta", "params": {"threadId": THREAD, "turnId": turn_id, "itemId": say["id"], "delta": reply}})
    say["text"] = reply
    out({"method": "item/completed", "params": {"item": say, "threadId": THREAD, "turnId": turn_id, "completedAtMs": 1790000000000}})
    done = dict(started)
    done.update({"status": "completed", "completedAt": 1790000001, "durationMs": 1000})
    out({"method": "turn/completed", "params": {"threadId": THREAD, "turn": done}})

for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    log(line)
    try:
        message = json.loads(line)
    except ValueError:
        continue
    method = message.get("method")
    id = message.get("id")
    if method is None or id is None:
        continue
    params = message.get("params") or {}
    if method == "initialize":
        out({"id": id, "result": {"userAgent": "codex_cli_rs/0.156.1 (Mac OS 15.0.0; arm64) devhub/0.1.0",
             "codexHome": os.environ.get("CODEX_HOME", ""), "platformFamily": "unix", "platformOs": "macos"}})
    elif method == "account/read":
        out({"id": id, "result": {"account": {"type": "apiKey"}, "requiresOpenaiAuth": True}})
    elif method in ("thread/start", "thread/resume"):
        t = thread()
        out({"id": id, "result": {"thread": t, "model": t["model"], "modelProvider": "openai", "serviceTier": None,
             "disabledPluginIds": [], "cwd": t["cwd"], "instructionSources": [], "approvalPolicy": "on-request",
             "approvalsReviewer": "user", "sandbox": {"type": "workspaceWrite", "writableRoots": [t["cwd"]],
             "networkAccess": False, "excludeTmpdirEnvVar": False, "excludeSlashTmp": False}, "reasoningEffort": "medium"}})
        out({"method": "thread/started", "params": {"thread": t}})
    elif method == "model/list":
        out({"id": id, "result": {"data": [model("gpt-5.5-codex", "GPT-5.5 Codex", ["low", "medium", "high"], True),
             model("gpt-5.5-mini", "GPT-5.5 mini", ["low"], False)], "nextCursor": None}})
    elif method == "skills/list":
        out({"id": id, "result": {"data": [{"cwd": os.getcwd(), "skills": [], "errors": []}]}})
    elif method == "turn/start":
        turn(id, params)
    else:
        out({"id": id, "error": {"code": -32601, "message": "the self-test's codex does not do %s" % method}})
"""#
}
