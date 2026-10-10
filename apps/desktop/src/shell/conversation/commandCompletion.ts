/**
 * What the composer offers after a `/` or a `$`, and what it walks with ↑ and ↓.
 *
 * Both are readings of what the page already has. The commands are the
 * Agent's own (`SessionFacts.commands`), each with the character it is typed
 * after (`trigger`), ranked by the scorer every picker in
 * DevHub uses; the history is the person's own messages in this Agent's
 * transcript. Neither is stored anywhere else, so neither can disagree with
 * the conversation it belongs to.
 */

import { score } from "../../model/fuzzy";
import type {
  SlashCommand,
  Transcript,
  TranscriptEntry,
} from "../../model/conversation";

/** A name being typed after a trigger, and where its trigger starts in the text. */
export interface CompletionQuery {
  readonly trigger: SlashCommand["trigger"];
  readonly name: string;
  readonly start: number;
  /** Where the typed name ends: the caret. */
  readonly end: number;
  /** Whether the trigger is the message's first word. */
  readonly leading: boolean;
}

/**
 * Built-in CLI commands, which act only as a message's first word. Mid-sentence
 * a `/` offers the Agent's other commands (skills, custom and plugin commands),
 * never these. The Agent's list does not say which are built in, so this is
 * the known set.
 */
const BUILT_IN = new Set([
  "add-dir",
  "agents",
  "bug",
  "clear",
  "compact",
  "config",
  "context",
  "cost",
  "doctor",
  "effort",
  "exit",
  "help",
  "hooks",
  "ide",
  "login",
  "logout",
  "mcp",
  "memory",
  "model",
  "output-style",
  "permissions",
  "plugin",
  "quit",
  "restart",
  "resume",
  "rewind",
  "status",
  "terminal-setup",
  "usage",
  "vim",
]);

/** Whether `/name` may be written (and so offered or tinted) away from the message's start. */
export function midSentenceCommand(name: string): boolean {
  return !BUILT_IN.has(name);
}

const JAPANESE =
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u3000-\\u303f\\uff00-\\uffef";
const JAPANESE_CHAR = new RegExp(`[${JAPANESE}]`, "u");
const NAME_END = new RegExp(`[\\s/$]|[${JAPANESE}]`, "u");

/**
 * Whether a `/` after `before` begins a command: at the start, after
 * whitespace, an opening bracket, or Japanese text (written without spaces),
 * and not after what makes a path or URL (`src/foo`, `a/b`, `~/x`, `./x`,
 * `https://x`).
 */
export function opensCommand(before: string): boolean {
  if (before === "") return true;
  const last = [...before].pop()!;
  return /[\s([{]/u.test(last) || JAPANESE_CHAR.test(last);
}

/** How much of `rest` is a name typed after a trigger: up to whitespace, a `/` or `$`, or Japanese text. */
export function nameLength(rest: string): number {
  const end = rest.search(NAME_END);
  return end === -1 ? rest.length : end;
}

/**
 * The name being typed at the caret (default: the end), or `undefined` when
 * the composer is not typing one. A completion is offered while the word
 * before the caret is a trigger and a name: a `/` as the first word or
 * anywhere a command can start (see `opensCommand`), a `$` after any
 * whitespace or at the start.
 */
export function completionQuery(
  text: string,
  caret: number = text.length,
): CompletionQuery | undefined {
  const before = text.slice(0, caret);
  const found = /[/$][^\s/$]*$/u.exec(before);
  if (!found) return undefined;
  const start = found.index;
  const trigger = found[0][0] as SlashCommand["trigger"];
  const head = before.slice(0, start);
  const opens =
    trigger === "/" ? opensCommand(head) : head === "" || /\s$/u.test(head);
  if (!opens) return undefined;
  const name = found[0].slice(1);
  if (nameLength(name) !== name.length) return undefined;
  return { trigger, name, start, end: caret, leading: start === 0 };
}

/**
 * The text with the name being typed replaced by the chosen one and a space
 * after it (unless one follows), so the next word can follow; and where the
 * caret goes. Only the token at the caret is replaced.
 */
export function completed(
  text: string,
  query: CompletionQuery,
  command: SlashCommand,
): { readonly text: string; readonly caret: number } {
  const rest = text.slice(query.end);
  const word = `${command.trigger}${command.name}`;
  const space = /^\s/u.test(rest) ? "" : " ";
  const head = `${text.slice(0, query.start)}${word}${space}`;
  return {
    text: `${head}${rest}`,
    caret: head.length + (space === "" ? 1 : 0),
  };
}

/** The commands typed after `query`'s trigger that match its name, best first; ties keep the Agent's order. */
export function completions(
  commands: readonly SlashCommand[],
  query: CompletionQuery,
): readonly SlashCommand[] {
  return commands
    .filter((command) => command.trigger === query.trigger)
    .filter(
      (command) =>
        query.leading ||
        query.trigger === "$" ||
        (command.route === "message" && midSentenceCommand(command.name)),
    )
    .map((command, index) => ({
      command,
      index,
      score: score(command.name, query.name),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((candidate) => candidate.command);
}

function personText(entry: TranscriptEntry): string | undefined {
  return entry.kind === "user" &&
    entry.parent === null &&
    entry.origin === "person"
    ? entry.text
    : undefined;
}

/**
 * What the person has said to this Agent, newest first, each message once
 * however often it was repeated in a row. A template's injection and a
 * subagent's prompt are not the person's, and are not here.
 */
export function inputHistory(transcript: Transcript): readonly string[] {
  const history: string[] = [];
  for (let index = transcript.entries.length - 1; index >= 0; index -= 1) {
    const text = personText(transcript.entries[index]!);
    if (text === undefined || text === history[history.length - 1]) continue;
    history.push(text);
  }
  return history;
}
