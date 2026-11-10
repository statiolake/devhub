/**
 * A permission request about a tool whose input DevHub knows the shape of,
 * read for the card that asks it (`RequestCard.tsx`).
 *
 * Deciding on a request takes two things: what the call is for, in a
 * sentence, and exactly what it will do — the command it runs, the file it
 * touches, the page it fetches. So a known tool's card is a heading (the
 * call's own `description` when it has one, else what the tool does), the
 * one value it acts on as a monospace block, and a quiet line for anything
 * else that changes what allowing it means. The raw input is drawn only for
 * a tool this does not know, or for an input with a key it does not know:
 * nothing the call carries is ever left off the card unread.
 *
 * Read by the tool's name, not by which CLI asked: the names are the tools'
 * own (Claude's), and a tool another CLI calls by the same name with
 * another shape fails `known` and is drawn as its input.
 */

import type { JsonValue } from "../../model/conversation";

type JsonObject = { readonly [key: string]: JsonValue };

/** What the card says about a known tool's request. */
export interface ToolRequestView {
  /** What the call is for, as a sentence. */
  readonly heading: string;
  /** The one thing it acts on, exactly: drawn monospace. */
  readonly target: string;
  /** Anything else that changes what allowing it means, a line each. */
  readonly notes: readonly ToolRequestNote[];
}

export interface ToolRequestNote {
  readonly text: string;
  /** A note that makes the call riskier than its target says. */
  readonly warning?: boolean;
}

interface Shape {
  /** The key holding the target; the input must have it as text. */
  readonly target: string;
  /** Every other key the tool takes. An input with another is unknown. */
  readonly keys: readonly string[];
  readonly heading: (input: JsonObject) => string;
  readonly notes?: (input: JsonObject) => readonly (ToolRequestNote | false)[];
}

const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const count = (value: JsonValue | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const within = (input: JsonObject): ToolRequestNote | false => {
  const path = text(input.path);
  return path === undefined ? false : { text: `In ${path}` };
};

/** Which lines of a file a Read takes, when not the whole of it. */
function lines(input: JsonObject): ToolRequestNote | false {
  const offset = count(input.offset);
  const limit = count(input.limit);
  if (offset === undefined && limit === undefined) return false;
  const from = offset ?? 1;
  if (limit === undefined) return { text: `From line ${String(from)}` };
  return { text: `Lines ${String(from)}–${String(from + limit - 1)}` };
}

const SHAPES: Readonly<Record<string, Shape>> = {
  Bash: {
    target: "command",
    keys: [
      "description",
      "timeout",
      "run_in_background",
      "dangerouslyDisableSandbox",
    ],
    heading: (input) => text(input.description) ?? "Run a command",
    notes: (input) => [
      input.run_in_background === true && { text: "Runs in the background" },
      input.dangerouslyDisableSandbox === true && {
        text: "Outside the sandbox",
        warning: true,
      },
    ],
  },
  Read: {
    target: "file_path",
    keys: ["offset", "limit", "pages"],
    heading: () => "Read a file",
    notes: (input) => [
      lines(input),
      text(input.pages) !== undefined && {
        text: `Pages ${text(input.pages) ?? ""}`,
      },
    ],
  },
  Edit: {
    target: "file_path",
    keys: ["old_string", "new_string", "replace_all"],
    heading: () => "Edit a file",
    notes: (input) => [
      input.replace_all === true && { text: "Every occurrence" },
    ],
  },
  MultiEdit: {
    target: "file_path",
    keys: ["edits"],
    heading: () => "Edit a file",
    notes: (input) => [
      Array.isArray(input.edits) &&
        input.edits.length > 1 && {
          text: `${String(input.edits.length)} changes`,
        },
    ],
  },
  Write: {
    target: "file_path",
    keys: ["content"],
    heading: () => "Write a file",
  },
  NotebookEdit: {
    target: "notebook_path",
    keys: ["cell_id", "new_source", "cell_type", "edit_mode"],
    heading: (input) =>
      input.edit_mode === "insert"
        ? "Add a notebook cell"
        : input.edit_mode === "delete"
          ? "Delete a notebook cell"
          : "Edit a notebook cell",
  },
  WebFetch: {
    target: "url",
    keys: ["prompt"],
    heading: () => "Fetch a web page",
    notes: (input) => {
      const prompt = text(input.prompt);
      return [prompt !== undefined && { text: prompt }];
    },
  },
  WebSearch: {
    target: "query",
    keys: ["allowed_domains", "blocked_domains"],
    heading: () => "Search the web",
    notes: (input) => [
      Array.isArray(input.allowed_domains) &&
        input.allowed_domains.length > 0 && {
          text: `Only ${input.allowed_domains.join(", ")}`,
        },
      Array.isArray(input.blocked_domains) &&
        input.blocked_domains.length > 0 && {
          text: `Not ${input.blocked_domains.join(", ")}`,
        },
    ],
  },
  Glob: {
    target: "pattern",
    keys: ["path"],
    heading: () => "Find files",
    notes: (input) => [within(input)],
  },
  Grep: {
    target: "pattern",
    keys: [
      "path",
      "glob",
      "type",
      "output_mode",
      "-i",
      "-n",
      "-A",
      "-B",
      "-C",
      "context",
      "multiline",
      "head_limit",
      "offset",
    ],
    heading: () => "Search file contents",
    notes: (input) => [within(input)],
  },
  Skill: {
    target: "skill",
    keys: ["args"],
    heading: () => "Use a skill",
    notes: (input) => {
      const args = text(input.args);
      return [args !== undefined && { text: args }];
    },
  },
};

/**
 * The card's reading of a request about `tool`, or undefined when its shape
 * is not one this knows: an unknown tool, the target missing or not text, or
 * a key the tool is not known to take.
 */
export function knownToolRequest(
  tool: string,
  input: JsonValue,
): ToolRequestView | undefined {
  const shape = Object.hasOwn(SHAPES, tool) ? SHAPES[tool] : undefined;
  if (shape === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const object = input as JsonObject;
  const target = object[shape.target];
  if (typeof target !== "string" || target.trim() === "") return undefined;
  const allowed = new Set([shape.target, ...shape.keys]);
  if (Object.keys(object).some((key) => !allowed.has(key))) return undefined;
  return {
    heading: shape.heading(object),
    target,
    notes: (shape.notes?.(object) ?? []).filter(
      (note): note is ToolRequestNote => note !== false,
    ),
  };
}
