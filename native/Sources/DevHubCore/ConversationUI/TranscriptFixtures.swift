// Port of apps/desktop/src/shell/conversation/transcriptFixtures.ts.
//
// Transcripts to draw without an Agent: for the tests, and for the App's
// self-test, which draws them and measures a long one.
//
// Every transcript here is built by folding events through `applyEvents`, the
// same fold Core and the view use, so a fixture cannot be a Transcript the
// fold would have refused.

import Foundation

public enum TranscriptFixtures {
    public static let ready = ConversationEvent.state(.ready(turn: .none))
    public static let running = ConversationEvent.state(.ready(turn: .running))

    public static func transcript(_ events: [ConversationEvent]) -> Transcript {
        // swiftlint:disable:next force_try
        try! applyEvents(EMPTY_TRANSCRIPT, [ready] + events)
    }

    public static func put(_ entry: TranscriptEntry) -> ConversationEvent { .entry(entry) }

    public static func user(_ id: String, _ text: String, origin: UserOrigin = .person, parent: String? = nil, images: [ImageRef] = []) -> TranscriptEntry {
        .user(UserEntry(id: EntryId(id), parent: parent.map { EntryId($0) }, text: text, images: images, origin: origin, rewindable: true))
    }

    public static func assistant(_ id: String, _ markdown: String, streaming: Bool = false, parent: String? = nil) -> TranscriptEntry {
        assistant(id, [.text(markdown: markdown)], streaming: streaming, parent: parent)
    }

    public static func assistant(_ id: String, _ blocks: [AssistantBlock], streaming: Bool = false, parent: String? = nil) -> TranscriptEntry {
        .assistant(AssistantEntry(id: EntryId(id), parent: parent.map { EntryId($0) }, blocks: blocks, streaming: streaming))
    }

    public static func tool(
        _ id: String, _ title: String, name: String? = nil, input: JsonValue = .object(JsonObject()), status: ToolStatus = .succeeded,
        output: ToolOutput? = nil, spawns: SubagentInfo? = nil, background: BackgroundTask? = nil, parent: String? = nil,
        outsideSandbox: Bool = false, plan: [PlanStep]? = nil, denial: Denial? = nil, change: [FileDiff]? = nil,
        asked: [AskedQuestion]? = nil
    ) -> TranscriptEntry {
        .tool(ToolEntry(
            id: EntryId(id), parent: parent.map { EntryId($0) },
            tool: name ?? String(title.split(separator: ":", maxSplits: 1).first ?? Substring(title)), title: title,
            input: input, status: status, output: output, spawns: spawns, background: background,
            outsideSandbox: outsideSandbox, plan: plan, change: change, asked: asked, denial: denial))
    }

    public static func notice(_ id: String, _ text: String, level: NoticeLevel = .info, raw: JsonValue? = nil) -> TranscriptEntry {
        .notice(NoticeEntry(id: EntryId(id), level: level, text: text, raw: raw))
    }

    public static let usage = Usage(inputTokens: 12_400, outputTokens: 830, costUsd: 0.042)

    public static func turnEnd(_ id: String, _ outcome: TurnOutcome = .completed, detail: String? = nil, limit: LimitStop? = nil) -> TranscriptEntry {
        .turnEnd(TurnEndEntry(id: EntryId(id), outcome: outcome, detail: detail, usage: usage, durationMs: 4_200, limit: limit))
    }

    public static let allowDeny: [RequestChoice] = [
        RequestChoice(id: "allow-once", label: "Allow once", tone: .allow, takesText: false),
        RequestChoice(id: "always", label: "Always allow Bash(npm test:*)", tone: .neutral, takesText: false),
        RequestChoice(id: "deny", label: "Deny", tone: .deny, takesText: true),
    ]

    public static func toolRequest(_ id: String, entry: String?, choices: [RequestChoice] = allowDeny) -> PendingRequest {
        PendingRequest(
            id: RequestId(id), entry: entry.map { EntryId($0) },
            subject: .tool(tool: "Bash", title: "Bash: npm test", input: ["command": "npm test"], reason: nil), choices: choices)
    }

    public static func opened(_ request: PendingRequest) -> ConversationEvent { .requestOpened(request) }

    public static func delta(_ entry: String, _ text: String, block: Int = 0) -> ConversationEvent {
        .textDelta(entry: EntryId(entry), block: block, text: text)
    }

    // MARK: - The long transcript: 2,000 entries of what a working session is made of

    /// Code in ten languages, one sample each, for the highlighting cost.
    public static let codeSamples: [(lang: String, code: String)] = [
        ("ts", "export function greet(name: string): string {\n  const now = new Date();\n  return `Hello, ${name} — it is ${now.toISOString()}`;\n}"),
        ("tsx", "export function Row({ label }: { readonly label: string }) {\n  return <li className=\"row\">{label}</li>;\n}"),
        ("python", "def fib(n: int) -> int:\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a"),
        ("rust", "fn main() {\n    let words: Vec<&str> = \"a b c\".split(' ').collect();\n    println!(\"{}\", words.len());\n}"),
        ("go", "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"hello\")\n}"),
        ("bash", "set -eu\nfor file in *.ts; do\n  printf \"%s\\n\" \"$file\"\ndone"),
        ("json", "{\n  \"name\": \"example\",\n  \"version\": \"1.0.0\",\n  \"private\": true\n}"),
        ("css", ".row:hover {\n  background: color-mix(in srgb, red 10%, transparent);\n}"),
        ("sql", "SELECT id, name\nFROM users\nWHERE created_at > now() - interval '1 day'\nORDER BY name;"),
        ("java", "public final class Main {\n  public static void main(String[] args) {\n    System.out.println(\"hello\");\n  }\n}"),
    ]

    static let table = [
        "| File | Lines | Status |", "|:-----|------:|:------:|", "| `src/a.ts` | 120 | ✅ |", "| `src/b.ts` | 48 | ⚠️ |",
        "| `src/c.ts` | 9 | ❌ |",
    ].joined(separator: "\n")

    static func answerMarkdown(_ index: Int) -> String {
        let sample = codeSamples[index % codeSamples.count]
        var parts = [
            "## Step \(index)",
            "Here is what I found in **step \(index)**. The change touches a few files, and the [docs](https://example.com/docs/\(index)) explain why.",
            "- first, read the existing module\n- then, change the *one* call site\n- finally, run the tests",
        ]
        if index % 3 == 0 { parts.append(table) }
        parts.append("```" + sample.lang + "\n" + sample.code + "\n```")
        parts.append("That should do it — `npm test` passes locally.")
        return parts.joined(separator: "\n\n")
    }

    /// About `count` entries in turns of: a user message, an answer with a
    /// code block (and a table every third turn), a tool call with output, and
    /// a turn end — with a subagent every tenth turn.
    public static func long(_ count: Int = 2_000) -> Transcript {
        var events: [ConversationEvent] = []
        var entries = 0
        var turn = 0
        while entries < count {
            events.append(put(user("u\(turn)", "Please do step \(turn) of the plan.")))
            events.append(put(assistant("a\(turn)", answerMarkdown(turn))))
            events.append(put(tool(
                "t\(turn)", "Bash: npm test -- step\(turn)", input: ["command": .string("npm test -- step\(turn)")],
                output: [.command(exitCode: 0, output: "PASS step\(turn)\nTests: 12 passed, 12 total", stderr: nil, interrupted: false)])))
            entries += 3
            if turn % 10 == 0 {
                events.append(put(tool(
                    "s\(turn)", "Task: explore the repository", name: "Task",
                    spawns: SubagentInfo(label: "Explore", prompt: "List the modules under src/", model: "example-model", state: .completed, takesMessages: false))))
                events.append(put(assistant("sa\(turn)", "The modules are `a`, `b` and `c`.", parent: "s\(turn)")))
                entries += 2
            }
            events.append(put(turnEnd("e\(turn)")))
            entries += 1
            turn += 1
        }
        return transcript(events)
    }

    /// One transcript with every kind of thing the surface draws: the self-test's fixture.
    public static func everything() -> Transcript {
        let diff = FileDiff(path: "/home/me/project/src/a.ts", unifiedDiff: "@@ -1,3 +1,4 @@\n import x from \"x\";\n-const a = 1;\n+const a = 2;\n+const b = 3;\n export { a };")
        let pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
        var events: [ConversationEvent] = [
            .session(SessionFacts(
                agentVersion: "2.1.0", sessionId: "s1", cwd: "/home/me/project",
                model: Setting(current: "opus", choices: [SettingChoice(id: "opus", label: "Opus", resolved: "claude-opus-5-5"), SettingChoice(id: "sonnet", label: "Sonnet")]),
                effort: Setting(current: nil, choices: [SettingChoice(id: "low", label: "Low"), SettingChoice(id: "high", label: "High")]),
                mode: Setting(current: "default", choices: [SettingChoice(id: "default", label: "Ask"), SettingChoice(id: "acceptEdits", label: "Accept edits")]),
                commands: [
                    SlashCommand(trigger: .slash, name: "review", description: "Review the change", argumentHint: "[file]", route: .message),
                    SlashCommand(trigger: .slash, name: "model", description: "Change the model", argumentHint: nil, route: .model),
                    SlashCommand(trigger: .slash, name: "mcp", description: "MCP servers", argumentHint: nil, route: .mcp),
                ], canRewind: true)),
            put(user("u1", "Fix the bug in src/a.ts and run /review #12", images: [ImageRef(mediaType: "image/png", source: .data(base64: pixel), label: "shot.png")])),
            put(assistant("a1", [
                .thinking(text: "Let me look at the file first."),
                .text(markdown: "## Plan\n\nI'll change **`a`** in `src/a.ts:2` — see [the docs](https://example.com).\n\n| Step | State |\n|:--|--:|\n| read | ✅ |\n| edit | ⏳ |\n\n- [x] read\n- [ ] edit\n\n> Note: ~~old~~ new.\n\n```ts\nconst a: number = 2; // fixed\n```\n\nMath: $E = mc^2$ and a footnote[^1].\n\n[^1]: The note."),
            ])),
            put(tool("t1", "Edit: src/a.ts", change: [diff])),
            put(tool("t2", "Bash: npm test", input: ["command": "npm test"], output: [.command(exitCode: 1, output: "FAIL src/a.test.ts\n  ✕ adds", stderr: "npm ERR! Test failed", interrupted: false)], outsideSandbox: true)),
            put(tool("t3", "TodoWrite", plan: [PlanStep(text: "Read", status: .completed), PlanStep(text: "Edit", status: .inProgress), PlanStep(text: "Test", status: .pending)])),
            put(tool("t4", "Task: explore", name: "Task", status: .running, spawns: SubagentInfo(label: "Explore", prompt: "List the modules", model: "haiku", state: .running, takesMessages: true))),
            put(assistant("t4a", "Found `a`, `b`.", parent: "t4")),
            put(tool("t5", "Bash: rm -rf build", status: .denied, denial: Denial(summary: "Denied by auto mode: Destructive command", detail: "The command deletes files."))),
            put(notice("n1", "Pushed to origin/main")),
            put(notice("n2", "The CLI is retrying", level: .warning)),
            .entry(.command(CommandEntry(id: EntryId("c1"), line: "/model sonnet", output: "Set model to sonnet", failed: false))),
            .entry(.compaction(CompactionEntry(id: EntryId("k1"), trigger: "auto", preTokens: 120_000, postTokens: 12_000))),
            put(user("u2", "Template text", origin: .injection)),
            put(user("u3", (1...12).map { "line \($0)" }.joined(separator: "\n"), origin: .other)),
            .entry(.answer(AnswerEntry(id: EntryId("q1"), answers: [QuestionAnswer(header: "Scope", question: "Which files?", chosen: ["src/"], written: nil, notes: nil, secret: false)]))),
            put(turnEnd("e1", .interrupted, detail: "Stopped by the person")),
            put(user("u4", "Now continue.")),
            running,
            put(assistant("a2", "Working on it…", streaming: true)),
            opened(toolRequest("r1", entry: "t2")),
            opened(PendingRequest(
                id: RequestId("r2"), entry: nil,
                subject: .question(questions: [Question(id: "q", header: "Choice", text: "Which approach?", options: [QuestionOption(label: "A", description: "The first", preview: "```\nA\n```"), QuestionOption(label: "B", description: "The second")], multiSelect: false, allowsOther: true)]),
                choices: [RequestChoice(id: "cancel", label: "Cancel", tone: .neutral, takesText: false)])),
            .usage(Usage(contextTokens: 54_000, contextWindow: 200_000)),
            .pending([PendingMessage(id: PendingId("p1"), text: "And then the docs", images: [], failure: nil, editing: false)]),
            .backgroundTasks([RunningTask(id: "bg1", kind: "shell", title: "npm run dev", call: EntryId("t2"), startedAt: 0, stoppable: .yes)]),
        ]
        events.append(.mcp(McpState(
            servers: [McpServer(name: "github", status: .connected, said: "connected", error: nil, source: "user", actions: [.reconnect, .disable])],
            pluginErrors: [], working: [], failure: nil)))
        return transcript(events)
    }
}
