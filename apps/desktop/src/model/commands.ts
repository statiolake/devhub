/**
 * Every command a DevHub chord can raise, in one list.
 *
 * Command-Q is DevHub's prefix, the way Ctrl-Q is the prefix in the terminal
 * multiplexer this app is meant to replace. Every DevHub-level command is a
 * two-stroke chord: Command-Q, then one ordinary key. Nothing is a single
 * shortcut, because DevHub's surfaces are whole applications — a VS Code
 * workbench, an xterm — and a single key taken from them is a key their own
 * users lose (see `main/shell/menu.ts`, which deliberately has no
 * accelerators).
 *
 * The bindings are modelled on the person's existing multiplexer environment
 * (`prefix = ctrl+q` there, `Command-Q` here) so the muscle memory carries
 * over unchanged. A stroke is written as the character it produces — `{`, `N`,
 * `<` — and the `Shift+[` spelling that multiplexer uses is accepted as an
 * alias for it. See `model/chordKeys.ts` for why the character is the identity
 * and the physical key is not.
 *
 * # Why a registry, and not a table of key→behaviour
 *
 * A chord used to be a key with an action inlined beside it, and that shape had
 * exactly one reader. Now three things have to agree about the same set: the
 * dispatcher that runs a chord, the configuration file that rebinds one, and
 * the Settings window that lists them. So the *command* is the thing with an
 * identity — a snake_case id DevHub owns, the way `agent_actions` ids are owned
 * (`model/agentActions.ts`) — and a key is only ever a way to reach one.
 *
 * That is what makes the rest of it decidable:
 *
 * - **Many keys may name one command; one key may never name two.** A stroke
 *   has to do one thing; a command may be reachable from two habits.
 * - The help overlay is rendered from this list, so it cannot be out of date.
 * - A configuration naming an id that is not here is a diagnostic rather than a
 *   silently dead binding.
 *
 * # The default table
 *
 * | Chord                       | Command                   |
 * | --------------------------- | ------------------------- |
 * | `Cmd+Q Cmd+Q`               | `forward_prefix`          |
 * | `Cmd+Q Shift+N` / `Shift+P` | `next_workspace` / `previous_workspace` |
 * | `Cmd+Q }` / `{`             | `next_agent` / `previous_agent` |
 * | `Cmd+Q Cmd+N` / `Cmd+P`     | `next_tab` / `previous_tab` |
 * | `Cmd+Q G`                   | `open_tab_picker`         |
 * | `Cmd+Q 1`…`9`               | `select_entry_1`…`9`      |
 * | `Cmd+Q Cmd+J`               | `toggle_workspace_agent`  |
 * | `Cmd+Q Z`                   | `toggle_split`            |
 * | `Cmd+Q E`                   | `focus_editor`            |
 * | `Cmd+Q F`                   | `add_workspace`           |
 * | `Cmd+Q C`                   | `add_agent`               |
 * | `Cmd+Q I`                   | `open_issue_picker`       |
 * | `Cmd+Q A`                   | `send_agent_action`       |
 * | `Cmd+Q ,`                   | `rename_agent`            |
 * | `Cmd+Q X`                   | `close_selection`         |
 * | `Cmd+Q Shift+W`             | `close_workspace`         |
 * | `Cmd+Q O`                   | `open_workspace_externally` |
 * | `Cmd+Q R`                   | `refresh_repositories`    |
 * | `Cmd+Q Shift+,`             | `open_settings`           |
 * | `Cmd+Q ?`                   | `show_chord_help`         |
 *
 * # The decisions behind that table
 *
 * **Scratch is entry 1 and part of the workspace cycle.** It is a row of the
 * sidebar like any other, it is where the global terminal and the folderless
 * workbench live, and a cycle that skipped it would make `Cmd+Q Shift+N` and
 * `Cmd+Q 1` disagree about what the list is. One list, one order: Scratch, then
 * the workspaces in sidebar order, wrapping at both ends.
 *
 * **Three ways of stepping, because there are three lists.** The sidebar is a
 * tree, and "the next thing" means something different depending on which level
 * you are working at: `Shift+N`/`Shift+P` step the *workspaces*, `{`/`}` step
 * the *Agents* — every Agent there is, in sidebar order, not only the ones
 * under the workspace you happen to be in, because an Agent is the unit of work
 * and which folder it belongs to is not what you are cycling through — and
 * `Cmd+N`/`Cmd+P` step every row of the tree in order without caring which kind
 * it is, which is what a person means by "the next tab". Three commands rather
 * than one that guesses, because a guess would be wrong a third of the time and
 * there would be no way to ask for the other two.
 *
 * **`Cmd+Q G` is the same list as a picker.** Stepping is for the neighbour;
 * the picker is for the one you can name. It is the ordinary picker component,
 * so `Return` activates and `Command-Return` mounts an Agent beside its
 * workbench — the same two gestures the workspace picker has, because they mean
 * the same two things.
 *
 * **`Cmd+Q Cmd+J` is the toggle between the two halves of one workspace.** In
 * the single layout it swaps the selected row between the workspace and the
 * last Agent you had open *in that workspace* — a fact the model keeps, because
 * "the Agent I was in" is per workspace and there is no other way back to it.
 * Side by side, both are already on screen, so there is nothing to select and
 * the same chord moves the keyboard between them instead. One chord, one
 * meaning — "the other half" — and the layout decides what that costs.
 *
 * **`Cmd+Q Z` is the multiplexer's `zoom`, moved to the noun DevHub has.** A
 * DevHub context is not tiled panes, so there is nothing to zoom in the tmux
 * sense — but an Agent shown beside its workbench and an Agent shown alone are
 * exactly the two arrangements that command toggled between, and DevHub already
 * had both. So it moves the *selection's presentation* rather than adding a
 * second notion of "maximised" the layout would then have to reconcile with the
 * one it has.
 *
 * **`Cmd+Q X` closes what is selected, and `Cmd+Q Shift+W` closes the
 * workspace.** They are the same command on a workspace row on purpose: there
 * is one rule for "get rid of this workspace" and two keys that reach it, the
 * way the multiplexer's `kill-pane` and `kill-window` fall together when a
 * window holds one pane. On an Agent, `X` closes the Agent — so the pair reads
 * as "close the small thing" and "close the big thing", and `X` is whichever of
 * the two you happen to be standing on.
 *
 * **Closing a worktree deletes it.** A worktree is a folder git made so that
 * work could happen somewhere; closing the workspace and leaving the folder
 * behind is how a machine fills with directories nobody can account for. So
 * there is one path (`closeWorkspaceOrWorktree`, in
 * `main/shell/appController.ts`) for the chord, for `X` and for the sidebar's
 * own button, and it asks before destroying anything that cannot be rebuilt —
 * with three answers, because there really are three: keep the worktree and
 * just close the workspace, delete it anyway, or do nothing.
 *
 * **Rename means the selected Agent.** A workspace is named by the folder it is
 * open on, so there is nothing about it to rename; an Agent has a display name
 * a person chose. With a workspace row or Scratch selected the chord is a
 * no-op, like every other chord with nothing to act on.
 *
 * **Gone, and why.** `Cmd+Q T` and `Cmd+Q Ctrl+J` toggled the workbench's
 * integrated terminal: that is a workbench command with a workbench key, and
 * putting a DevHub chord in front of it was DevHub claiming a key in order to
 * forward a command whose real binding it had to guess. `Cmd+Q Shift+C` was a
 * second key onto the workspace picker, carried over from a multiplexer where
 * making a session and finding a project were two commands; DevHub's picker is
 * both, and one key for one command is the rule everywhere else.
 *
 * **Not applicable, deliberately absent.** Panes (`focus_pane_*`,
 * `swap_pane_*`), splits (`split_vertical`, `split_horizontal`), the
 * pane-moving commands, `detach`, `reload_config` and the popup runners have no
 * DevHub concept behind them: DevHub's surfaces are not tiled, there is no
 * session to detach from a client, and the config file is re-read when it
 * changes rather than on request. They are left unbound rather than given
 * invented meanings — an unbound chord key cancels, so nothing surprising
 * happens if one is typed out of habit.
 *
 * # The rules
 *
 * - The prefix arms for exactly `PREFIX_TIMEOUT_MS`; after that the next
 *   Command-Q arms again rather than completing.
 * - **A bare modifier neither completes nor cancels.** Chromium sends a
 *   `keyDown` for Shift before it sends the shifted key, and treating that as a
 *   second stroke is what broke every shifted chord. See `isModifierKey`.
 * - **A stroke is the character, so the same binding is right on every
 *   layout.** `{` is `{` whether the key that made it sits where a US keyboard
 *   puts it or where a JIS one does.
 * - **A second key that is not in the table cancels the chord and is *not*
 *   forwarded.** Once the prefix is armed the keyboard belongs to the chord
 *   layer, so a mistyped chord does nothing at all rather than firing whatever
 *   the surface would have done with that key. Only `forward_prefix` is ever
 *   forwarded, and that is a table entry.
 * - A chord whose command has nothing to act on is a no-op, not an error.
 * - Changing focus disarms, so the second stroke cannot land somewhere else.
 */

import {
  ChordKeyError,
  chordKeyId,
  parseChordKey,
  type ChordKey,
} from "./chordKeys.js";

/**
 * The prefix DevHub arms on, as the config's `keybindings.prefix` default.
 *
 * A key string like any other, read by the same parser, so the one setting that
 * decides what arms a chord cannot be spelled in a way the second strokes are
 * not.
 */
export const DEFAULT_CHORD_PREFIX = "Cmd+q";

/** The nine sidebar rows a digit can name. Scratch is 1. */
export type SelectEntryDigit = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type SelectEntryCommandId = `select_entry_${SelectEntryDigit}`;

export type CommandId =
  | SelectEntryCommandId
  | "forward_prefix"
  | "previous_workspace"
  | "next_workspace"
  | "previous_agent"
  | "next_agent"
  | "previous_tab"
  | "next_tab"
  | "open_tab_picker"
  | "toggle_workspace_agent"
  | "toggle_split"
  | "focus_editor"
  | "add_workspace"
  | "add_agent"
  | "rename_agent"
  | "close_selection"
  | "close_workspace"
  | "open_issue_picker"
  | "send_agent_action"
  | "open_workspace_externally"
  | "refresh_repositories"
  | "open_settings"
  | "show_chord_help";

/**
 * What has to be selected for a command to have anything to do.
 *
 * The single gate. `resolveChord` reads it once and answers "no-op" for
 * everything that fails it, so no command re-states the check and no new
 * command can forget it — and the Settings window shows the same words next to
 * the row, so "why does this key do nothing here" has an answer on screen.
 */
export type CommandNeeds = "nothing" | "workspace" | "agent";

export interface CommandDefinition {
  readonly id: CommandId;
  /** What it is called, in the help overlay and in Settings. */
  readonly label: string;
  readonly needs: CommandNeeds;
  /** The second strokes DevHub ships, as key strings. */
  readonly defaultKeys: readonly string[];
  /** Which sidebar row it selects, for the digit commands only. */
  readonly ordinal?: SelectEntryDigit;
}

/**
 * `Cmd+Q 1` … `Cmd+Q 9`.
 *
 * Nine definitions written by a loop rather than by hand: they differ only in
 * the digit, and nine hand-written rows are nine chances to mistype one.
 */
const SELECT_ENTRY_COMMANDS: readonly CommandDefinition[] = Array.from(
  { length: 9 },
  (_unused, index): CommandDefinition => {
    const ordinal = (index + 1) as SelectEntryDigit;
    return {
      id: `select_entry_${ordinal}`,
      label:
        ordinal === 1
          ? "Select Scratch (sidebar entry 1)"
          : `Select sidebar entry ${String(ordinal)}`,
      needs: "nothing",
      defaultKeys: [String(ordinal)],
      ordinal,
    };
  },
);

/**
 * Every command, in the order the help overlay lists them.
 *
 * Grouped the way a person meets them: moving around, then the toggles that
 * change what the content area holds, then the things that make and unmake
 * work, then what reaches outside DevHub, and help last.
 */
export const COMMANDS: readonly CommandDefinition[] = [
  {
    // The chord DevHub started with: the second Command-Q is the real one.
    id: "forward_prefix",
    label: "Send a real Command-Q to the surface",
    needs: "nothing",
    defaultKeys: [DEFAULT_CHORD_PREFIX],
  },

  {
    id: "next_workspace",
    label: "Next workspace",
    needs: "nothing",
    defaultKeys: ["N"],
  },
  {
    id: "previous_workspace",
    label: "Previous workspace",
    needs: "nothing",
    defaultKeys: ["P"],
  },
  {
    id: "next_agent",
    label: "Next Agent",
    needs: "nothing",
    defaultKeys: ["}"],
  },
  {
    id: "previous_agent",
    label: "Previous Agent",
    needs: "nothing",
    defaultKeys: ["{"],
  },
  {
    id: "next_tab",
    label: "Next sidebar row",
    needs: "nothing",
    defaultKeys: ["Cmd+n"],
  },
  {
    id: "previous_tab",
    label: "Previous sidebar row",
    needs: "nothing",
    defaultKeys: ["Cmd+p"],
  },
  {
    id: "open_tab_picker",
    label: "Go to workspace or Agent…",
    needs: "nothing",
    defaultKeys: ["g"],
  },
  ...SELECT_ENTRY_COMMANDS,

  {
    id: "toggle_workspace_agent",
    label: "Switch between the workspace and its Agent",
    needs: "workspace",
    defaultKeys: ["Cmd+j"],
  },
  {
    id: "toggle_split",
    label: "Show the Agent beside the editor, or alone",
    needs: "agent",
    defaultKeys: ["z"],
  },
  {
    id: "focus_editor",
    label: "Show the editor",
    needs: "nothing",
    defaultKeys: ["e"],
  },

  {
    id: "add_workspace",
    label: "Add Workspace…",
    needs: "nothing",
    defaultKeys: ["f"],
  },
  {
    id: "add_agent",
    label: "New Agent in this workspace",
    needs: "workspace",
    defaultKeys: ["c"],
  },
  {
    id: "open_issue_picker",
    label: "Assign an Issue…",
    needs: "nothing",
    defaultKeys: ["i"],
  },
  {
    id: "send_agent_action",
    label: "Send an Agent action…",
    needs: "agent",
    defaultKeys: ["a"],
  },
  {
    id: "rename_agent",
    label: "Rename this Agent…",
    needs: "agent",
    defaultKeys: [","],
  },
  {
    id: "close_selection",
    label: "Close what is selected",
    needs: "nothing",
    defaultKeys: ["x"],
  },
  {
    id: "close_workspace",
    label: "Close this workspace",
    needs: "workspace",
    defaultKeys: ["W"],
  },

  {
    id: "open_workspace_externally",
    label: "Open this workspace outside DevHub…",
    needs: "workspace",
    defaultKeys: ["o"],
  },
  {
    id: "refresh_repositories",
    label: "Refresh branch, pull request and Issue information",
    needs: "nothing",
    defaultKeys: ["r"],
  },

  {
    id: "open_settings",
    label: "DevHub Settings…",
    needs: "nothing",
    defaultKeys: ["<"],
  },
  {
    id: "show_chord_help",
    label: "Keyboard shortcuts",
    needs: "nothing",
    // `?` is Shift and the slash key, which is what the physical name says.
    defaultKeys: ["?"],
  },
];

const BY_ID = new Map<string, CommandDefinition>(
  COMMANDS.map((command) => [command.id, command]),
);

/** The definition, or nothing when the id is not one DevHub has. */
export function commandById(id: string): CommandDefinition | undefined {
  return BY_ID.get(id);
}

/** Whether a string is an id DevHub owns. The config's whole check. */
export function isCommandId(id: string): id is CommandId {
  return BY_ID.has(id);
}

/**
 * Whether this command selects a numbered sidebar row.
 *
 * A type guard rather than a lookup on `ordinal`, so that resolving a chord can
 * deal with the nine of them once and then switch exhaustively over what is
 * left — which is what makes a new command a compile error until it is handled.
 */
export function isSelectEntryCommand(
  id: CommandId,
): id is SelectEntryCommandId {
  return BY_ID.get(id)?.ordinal !== undefined;
}

/** One binding, flattened: a key, and the command it reaches. */
export interface KeyBinding {
  readonly key: ChordKey;
  readonly commandId: CommandId;
}

/**
 * The shipped table, parsed.
 *
 * Parsed rather than written as structures, so the strings in `COMMANDS` are
 * the same strings the configuration file writes and the Settings window shows.
 * A default that does not parse throws here — `commands.test.ts` is the thing
 * that catches DevHub's own typo before anybody runs the app.
 */
export function defaultBindings(): readonly KeyBinding[] {
  return COMMANDS.flatMap((command) =>
    command.defaultKeys.map((text) => ({
      key: parseChordKey(text),
      commandId: command.id,
    })),
  );
}

/**
 * What `[keybindings]` says, before it means anything.
 *
 * `chords` is the file's own table: the second stroke as a key string, and the
 * command id it should reach. An entry whose value is the empty string unbinds
 * that key — which is the only way to take a shipped chord away, because a
 * table states what somebody wrote and silence has to keep meaning "the
 * default", or a file written today would delete every command DevHub adds
 * tomorrow.
 */
export interface KeybindingsSpec {
  readonly prefix: string;
  readonly chords: Readonly<Record<string, string>>;
}

export function defaultKeybindings(): KeybindingsSpec {
  return { prefix: DEFAULT_CHORD_PREFIX, chords: {} };
}

/** What is wrong with one entry of `[keybindings]`, and where. */
export interface KeybindingProblem {
  readonly code: "invalid_key" | "unknown_command" | "duplicate_key";
  /** The config path, so the diagnostic names the line to go and fix. */
  readonly path: string;
}

/**
 * Everything wrong with a `[keybindings]` table, rather than the first thing.
 *
 * All of them, because a person who mistyped two keys should be told about two
 * keys — and because the Settings window shows conflicts before a save, which
 * means asking this question about a table nobody has written yet.
 *
 * Silence is not an option for any of these. An unknown command id and an
 * unparsable key both produce a binding that does nothing, and a chord that
 * does nothing is indistinguishable from a chord layer that is broken.
 */
export function checkKeybindings(
  spec: KeybindingsSpec,
): readonly KeybindingProblem[] {
  const problems: KeybindingProblem[] = [];
  try {
    parseChordKey(spec.prefix);
  } catch (error) {
    if (!(error instanceof ChordKeyError)) throw error;
    problems.push({ code: "invalid_key", path: "keybindings.prefix" });
  }
  const seen = new Map<string, string>();
  for (const [text, commandId] of Object.entries(spec.chords)) {
    const path = `keybindings.chords.${text}`;
    let key: ChordKey;
    try {
      key = parseChordKey(text);
    } catch (error) {
      if (!(error instanceof ChordKeyError)) throw error;
      problems.push({ code: "invalid_key", path });
      continue;
    }
    const id = chordKeyId(key);
    const previous = seen.get(id);
    if (previous !== undefined) {
      // Two spellings of one stroke — `Shift+n` and `shift+N` — are one key,
      // and a key can only ever reach one command. Last-one-wins would make
      // which of the two lines matters depend on TOML key order, which TOML
      // does not promise.
      problems.push({
        code: "duplicate_key",
        path: `${path} (also ${previous})`,
      });
      continue;
    }
    seen.set(id, path);
    // The empty string is how a key is taken away, so it is not an id and is
    // not checked against the registry.
    if (commandId.length === 0) continue;
    if (!isCommandId(commandId)) {
      problems.push({ code: "unknown_command", path });
    }
  }
  return problems;
}

/**
 * The table actually in effect: what DevHub ships, with the file's word over it.
 *
 * Keyed by the stroke, because that is what a keypress is looked up by and
 * because it is what makes "one key, one command" true rather than hoped for.
 * A key the file names replaces whatever default stood on it; a key set to the
 * empty string is removed; every key the file does not mention keeps the
 * command DevHub gave it — including one added in a later version, which is why
 * the file holds overrides and not the whole table.
 *
 * Entries `checkKeybindings` would refuse are skipped here rather than throwing:
 * the caller has already turned them into diagnostics the person can see, and a
 * chord layer that refused to exist because one line was mistyped would take
 * every other chord away with it.
 */
export function resolveBindings(spec: KeybindingsSpec): {
  readonly prefix: ChordKey;
  readonly bindings: readonly KeyBinding[];
} {
  const table = new Map<string, KeyBinding>(
    defaultBindings().map((binding) => [chordKeyId(binding.key), binding]),
  );
  for (const [text, commandId] of Object.entries(spec.chords)) {
    let key: ChordKey;
    try {
      key = parseChordKey(text);
    } catch (error) {
      if (!(error instanceof ChordKeyError)) throw error;
      continue;
    }
    const id = chordKeyId(key);
    if (commandId.length === 0) {
      table.delete(id);
      continue;
    }
    if (!isCommandId(commandId)) continue;
    table.set(id, { key, commandId });
  }
  let prefix: ChordKey;
  try {
    prefix = parseChordKey(spec.prefix);
  } catch (error) {
    if (!(error instanceof ChordKeyError)) throw error;
    prefix = parseChordKey(DEFAULT_CHORD_PREFIX);
  }
  return { prefix, bindings: [...table.values()] };
}

/**
 * Every key that reaches one command under a given table, written out.
 *
 * What the help overlay and the Settings window both list, so neither of them
 * has to walk the table itself and come to a different answer about which keys
 * a command has.
 */
export function keysForCommand(
  bindings: readonly KeyBinding[],
  commandId: CommandId,
): readonly ChordKey[] {
  return bindings
    .filter((binding) => binding.commandId === commandId)
    .map((binding) => binding.key);
}
