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
}

/**
 * The name being typed at the end of the text, or `undefined` when the
 * composer is not typing one. A completion is offered only while the last
 * word is a trigger and a name with nothing after it: a `/` only as the
 * whole text (a command is the message's first word), a `$` as any word.
 */
export function completionQuery(text: string): CompletionQuery | undefined {
  const command = /^\/(\S*)$/u.exec(text);
  if (command) return { trigger: "/", name: command[1]!, start: 0 };
  const skill = /(?:^|\s)\$([^\s$]*)$/u.exec(text);
  if (skill)
    return {
      trigger: "$",
      name: skill[1]!,
      start: text.length - skill[1]!.length - 1,
    };
  return undefined;
}

/**
 * The text with the name being typed replaced by the chosen one and a space
 * after it, so the next word can follow.
 */
export function completed(
  text: string,
  query: CompletionQuery,
  command: SlashCommand,
): string {
  return `${text.slice(0, query.start)}${command.trigger}${command.name} `;
}

/** The commands typed after `query`'s trigger that match its name, best first; ties keep the Agent's order. */
export function completions(
  commands: readonly SlashCommand[],
  query: CompletionQuery,
): readonly SlashCommand[] {
  return commands
    .filter((command) => command.trigger === query.trigger)
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
