/**
 * The command palette's list: every command in the registry, as rows to choose.
 *
 * `Cmd+Q :`. The palette is not a second table of things DevHub can do — it is
 * `COMMANDS` (`model/commands.ts`) drawn as a picker, with the chords actually
 * in effect beside each row, so a command cannot have a key and be missing
 * here, and a rebound key reads as the person's own. Choosing a row runs the
 * command through the same resolver a chord does (`resolveChord`), so the
 * palette and the keys cannot disagree about what a command does.
 *
 * Pure, so the order, the availability and the filtering are tested without a
 * window.
 */

import { describeChordKey, type ChordKey } from "./chordKeys.js";
import {
  COMMANDS,
  keysForCommand,
  type CommandId,
  type KeyBinding,
} from "./commands.js";
import { score } from "./fuzzy.js";

/** How many commands the palette remembers having run. */
export const RECENT_COMMAND_LIMIT = 8;

/**
 * Commands the palette never lists.
 *
 * `forward_prefix` is a *key* — the real Command-Q passed to the surface — and
 * from a palette there is no keystroke to forward. The palette itself is left
 * out because choosing it would only reopen what is already open.
 */
const NOT_IN_PALETTE: ReadonlySet<CommandId> = new Set<CommandId>([
  "forward_prefix",
  "open_command_palette",
]);

export interface CommandPaletteRow {
  readonly commandId: CommandId;
  /** `Category: Label`, the way VS Code writes a palette row. */
  readonly title: string;
  /** Every chord that reaches it, written out: `Cmd+Q Shift+N`. */
  readonly chords: readonly string[];
  /** Whether it was run from the palette lately, so it leads the list. */
  readonly recent: boolean;
}

/**
 * Remember a command as just run: to the front, once, and no more than the
 * limit.
 */
export function rememberRecentCommand(
  recent: readonly CommandId[],
  commandId: CommandId,
  limit: number = RECENT_COMMAND_LIMIT,
): readonly CommandId[] {
  return [commandId, ...recent.filter((id) => id !== commandId)].slice(
    0,
    limit,
  );
}

/**
 * The palette's rows, in the order it opens on.
 *
 * Only the commands that would do something now are listed: `available` is
 * asked about each, and the caller answers it with the chord resolver itself,
 * so a row is offered exactly when its chord would not be a no-op. A command
 * that depends on the selection (an Agent's Rename with a workspace selected)
 * is therefore hidden rather than offered and then ignored.
 *
 * Recently run commands lead, most recent first; the rest follow in registry
 * order, which is the order the help overlay reads in.
 */
export function commandPaletteRows(input: {
  readonly prefix: ChordKey;
  readonly bindings: readonly KeyBinding[];
  readonly recent: readonly CommandId[];
  readonly available: (commandId: CommandId) => boolean;
}): readonly CommandPaletteRow[] {
  const armed = describeChordKey(input.prefix);
  const rows = COMMANDS.filter(
    (command) => !NOT_IN_PALETTE.has(command.id) && input.available(command.id),
  ).map(
    (command): CommandPaletteRow => ({
      commandId: command.id,
      title: `${command.category}: ${command.label}`,
      chords: keysForCommand(input.bindings, command.id).map(
        (key) => `${armed} ${describeChordKey(key)}`,
      ),
      recent: input.recent.includes(command.id),
    }),
  );
  const rank = (row: CommandPaletteRow): number => {
    const index = input.recent.indexOf(row.commandId);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (left, right) =>
        rank(left.row) - rank(right.row) || left.index - right.index,
    )
    .map((entry) => entry.row);
}

/**
 * What a query leaves of the rows, best first — the picker's own rule
 * (`score`, then the order the rows came in), so this is what the sheet draws.
 */
export function filterCommandPaletteRows(
  rows: readonly CommandPaletteRow[],
  query: string,
): readonly CommandPaletteRow[] {
  return rows
    .map((row, index) => ({
      row,
      index,
      value: score(paletteSearchText(row), query),
    }))
    .filter((entry) => entry.value > 0)
    .sort((left, right) => right.value - left.value || left.index - right.index)
    .map((entry) => entry.row);
}

/** What a palette query matches: the title, and the command's id. */
export function paletteSearchText(row: {
  readonly title: string;
  readonly commandId: string;
}): string {
  return `${row.title} ${row.commandId}`;
}
