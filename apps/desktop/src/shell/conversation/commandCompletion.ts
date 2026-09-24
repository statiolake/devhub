/**
 * What the composer offers after a `/`, and what it walks with ↑ and ↓.
 *
 * Both are readings of what the page already has. The commands are the
 * Agent's own (`SessionFacts.commands`), ranked by the scorer every picker in
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

/**
 * The command name being typed, or `undefined` when the composer is not
 * typing one: a completion is offered only while the text is a `/` and a
 * name with nothing after it.
 */
export function commandQuery(text: string): string | undefined {
  const match = /^\/(\S*)$/.exec(text);
  return match ? match[1] : undefined;
}

/** The commands matching `query`, best first; ties keep the Agent's order. */
export function completions(
  commands: readonly SlashCommand[],
  query: string,
): readonly SlashCommand[] {
  return commands
    .map((command, index) => ({
      command,
      index,
      score: score(command.name, query),
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
