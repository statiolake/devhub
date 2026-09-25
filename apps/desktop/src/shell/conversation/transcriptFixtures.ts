/**
 * Transcripts to draw without an Agent: for the component tests, and for the
 * long-transcript measurement that loads the surface in a real browser.
 *
 * Every transcript here is built by folding events through `applyEvents`, the
 * same fold main and the page use, so a fixture cannot be a Transcript the
 * fold would have refused.
 */

import {
  applyEvents,
  EMPTY_TRANSCRIPT,
  entryId,
  requestId,
  type AssistantBlock,
  type ConversationEvent,
  type EntryId,
  type JsonValue,
  type PendingRequest,
  type RequestChoice,
  type SubagentInfo,
  type ToolEntry,
  type ToolOutput,
  type Transcript,
  type TranscriptEntry,
  type Usage,
} from "../../model/conversation";

export const READY: ConversationEvent = {
  type: "state",
  state: { phase: "ready", turn: "none" },
};

export function transcriptOf(events: readonly ConversationEvent[]): Transcript {
  return applyEvents(EMPTY_TRANSCRIPT, [READY, ...events]);
}

export function put(entry: TranscriptEntry): ConversationEvent {
  return { type: "entry", entry };
}

export function user(
  id: string,
  text: string,
  origin: "person" | "injection" = "person",
  parent: string | null = null,
): TranscriptEntry {
  return {
    kind: "user",
    id: entryId(id),
    parent: parent === null ? null : entryId(parent),
    text,
    images: [],
    origin,
    rewindable: true,
  };
}

export function assistant(
  id: string,
  blocks: readonly AssistantBlock[] | string,
  {
    streaming = false,
    parent = null,
  }: { streaming?: boolean; parent?: string | null } = {},
): TranscriptEntry {
  return {
    kind: "assistant",
    id: entryId(id),
    parent: parent === null ? null : entryId(parent),
    blocks:
      typeof blocks === "string"
        ? [{ kind: "text", markdown: blocks }]
        : blocks,
    streaming,
  };
}

export function tool(
  id: string,
  title: string,
  {
    name = title.split(":", 1)[0]!,
    input = {},
    status = "succeeded",
    output,
    spawns,
    parent = null,
  }: {
    name?: string;
    input?: JsonValue;
    status?: ToolEntry["status"];
    output?: ToolOutput;
    spawns?: SubagentInfo;
    parent?: string | null;
  } = {},
): TranscriptEntry {
  return {
    kind: "tool",
    id: entryId(id),
    parent: parent === null ? null : entryId(parent),
    tool: name,
    title,
    input,
    status,
    output,
    spawns,
  };
}

export function notice(
  id: string,
  text: string,
  level: "info" | "warning" | "error" = "info",
  raw: JsonValue | undefined = undefined,
): TranscriptEntry {
  return { kind: "notice", id: entryId(id), parent: null, level, text, raw };
}

export const USAGE: Usage = {
  inputTokens: 12_400,
  outputTokens: 830,
  cachedInputTokens: undefined,
  contextTokens: undefined,
  contextWindow: undefined,
  costUsd: 0.042,
  rateLimits: undefined,
};

export function turnEnd(
  id: string,
  outcome: "completed" | "interrupted" | "failed" = "completed",
  {
    detail,
    durationMs = 4_200,
    usage = USAGE,
  }: { detail?: string; durationMs?: number; usage?: Usage } = {},
): TranscriptEntry {
  return {
    kind: "turn-end",
    id: entryId(id),
    outcome,
    detail,
    usage,
    durationMs,
  };
}

export const ALLOW_DENY: readonly RequestChoice[] = [
  { id: "allow-once", label: "Allow once", tone: "allow", takesText: false },
  {
    id: "always",
    label: "Always allow Bash(npm test:*)",
    tone: "neutral",
    takesText: false,
  },
  { id: "deny", label: "Deny", tone: "deny", takesText: true },
];

export function toolRequest(
  id: string,
  entry: string | undefined,
  choices: readonly RequestChoice[] = ALLOW_DENY,
): PendingRequest {
  return {
    id: requestId(id),
    entry: entry === undefined ? undefined : entryId(entry),
    subject: {
      kind: "tool",
      tool: "Bash",
      title: "Bash: npm test",
      input: { command: "npm test" },
      reason: undefined,
    },
    choices,
  };
}

export function opened(request: PendingRequest): ConversationEvent {
  return { type: "request-opened", request };
}

export function delta(
  entry: string,
  text: string,
  block = 0,
): ConversationEvent {
  return { type: "text-delta", entry: entryId(entry) as EntryId, block, text };
}

// ---------------------------------------------------------------------------
// The long transcript: 2,000 entries of what a working session is made of.

/** Code in ten languages, one sample each, for the highlighting cost. */
export const CODE_SAMPLES: readonly { lang: string; code: string }[] = [
  {
    lang: "ts",
    code: "export function greet(name: string): string {\n  const now = new Date();\n  return `Hello, ${name} — it is ${now.toISOString()}`;\n}",
  },
  {
    lang: "tsx",
    code: 'export function Row({ label }: { readonly label: string }) {\n  return <li className="row">{label}</li>;\n}',
  },
  {
    lang: "python",
    code: "def fib(n: int) -> int:\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a",
  },
  {
    lang: "rust",
    code: 'fn main() {\n    let words: Vec<&str> = "a b c".split(\' \').collect();\n    println!("{}", words.len());\n}',
  },
  {
    lang: "go",
    code: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n}',
  },
  {
    lang: "bash",
    code: 'set -eu\nfor file in *.ts; do\n  printf "%s\\n" "$file"\ndone',
  },
  {
    lang: "json",
    code: '{\n  "name": "example",\n  "version": "1.0.0",\n  "private": true\n}',
  },
  {
    lang: "css",
    code: ".row:hover {\n  background: color-mix(in srgb, red 10%, transparent);\n}",
  },
  {
    lang: "sql",
    code: "SELECT id, name\nFROM users\nWHERE created_at > now() - interval '1 day'\nORDER BY name;",
  },
  {
    lang: "java",
    code: 'public final class Main {\n  public static void main(String[] args) {\n    System.out.println("hello");\n  }\n}',
  },
];

const TABLE = [
  "| File | Lines | Status |",
  "|:-----|------:|:------:|",
  "| `src/a.ts` | 120 | ✅ |",
  "| `src/b.ts` | 48 | ⚠️ |",
  "| `src/c.ts` | 9 | ❌ |",
].join("\n");

function answerMarkdown(index: number): string {
  const sample = CODE_SAMPLES[index % CODE_SAMPLES.length]!;
  const parts = [
    `## Step ${index}`,
    `Here is what I found in **step ${index}**. The change touches a few files, and the [docs](https://example.com/docs/${index}) explain why.`,
    "- first, read the existing module\n- then, change the *one* call site\n- finally, run the tests",
  ];
  if (index % 3 === 0) parts.push(TABLE);
  parts.push("```" + sample.lang + "\n" + sample.code + "\n```");
  parts.push("That should do it — `npm test` passes locally.");
  return parts.join("\n\n");
}

/**
 * About `count` entries in turns of: a user message, an answer with a code
 * block (and a table every third turn), a tool call with output, and a
 * turn end — with a subagent every tenth turn.
 */
export function longTranscript(count = 2_000): Transcript {
  const events: ConversationEvent[] = [];
  let entries = 0;
  for (let turn = 0; entries < count; turn += 1) {
    events.push(put(user(`u${turn}`, `Please do step ${turn} of the plan.`)));
    events.push(put(assistant(`a${turn}`, answerMarkdown(turn))));
    events.push(
      put(
        tool(`t${turn}`, `Bash: npm test -- step${turn}`, {
          input: { command: `npm test -- step${turn}` },
          output: {
            kind: "command",
            exitCode: 0,
            output: `PASS step${turn}\nTests: 12 passed, 12 total`,
          },
        }),
      ),
    );
    entries += 3;
    if (turn % 10 === 0) {
      events.push(
        put(
          tool(`s${turn}`, "Task: explore the repository", {
            name: "Task",
            spawns: {
              label: "Explore",
              prompt: "List the modules under src/",
              model: "example-model",
              state: "completed",
              takesMessages: false,
            },
          }),
        ),
      );
      events.push(
        put(
          assistant(`sa${turn}`, "The modules are `a`, `b` and `c`.", {
            parent: `s${turn}`,
          }),
        ),
      );
      entries += 2;
    }
    events.push(put(turnEnd(`e${turn}`)));
    entries += 1;
  }
  return transcriptOf(events);
}
