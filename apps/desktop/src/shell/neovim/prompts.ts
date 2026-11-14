/**
 * Neovim's prompts as DevHub draws them natively, pure: what is asked, read
 * from what `ext_messages` and `ext_cmdline` say (`docs/neovim-editor.md`,
 * "Prompts").
 *
 * On 0.12 a prompt is a `confirm` message (the question; with the swap
 * file's, the E325 heading said just before it) and then a command line
 * with no `firstc` whose `prompt` is the answers as Neovim renders them —
 * `[Y]es, (N)o, (C)ancel: ` for `confirm()` and `:confirm`, `Type number
 * and <Enter> …` for `inputlist()` and `z=` — or, for `:s///c`, that
 * command line alone (`replace with bar? (y)es/(n)o/…`). Neovim reads the
 * answer as keys; the page sends a button's key the same way (`nvim_input`),
 * so Neovim decides, and the prompt goes when Neovim's command line does.
 *
 * - `confirm` — one answer per choice, its accelerator (the letter in
 *   brackets) its key, the one in square brackets the default (Return).
 * - `list` — `inputlist()`'s numbered lines as answers, the number typed so
 *   far, Return to take it.
 * - `substitute` — `:s///c`'s answers: yes, no, all, quit, last.
 *
 * Anything else on a command line with a prompt (`input()`) stays the
 * command line's.
 */

import type {
  CmdlineLevel,
  HlAttr,
  MsgChunk,
  NeovimUiState,
} from "./redraw.js";
import { msgText } from "./redraw.js";

/** One answer: what it says, which of its characters is the key. */
export interface PromptChoice {
  /** The label without its brackets (`Delete`, `Open Read-Only`). */
  readonly label: string;
  /** The accelerator's index in `label` (UTF-16), or -1 for none. */
  readonly accel: number;
  /** The key, as shown (`D`); `""` when the choice has none. */
  readonly key: string;
  /** What is sent to answer with it (`nvim_input`). */
  readonly keys: string;
  readonly isDefault: boolean;
}

export type NativePrompt =
  | {
      readonly kind: "confirm";
      /** The question's first line: the sheet's title. */
      readonly title: string;
      /** The rest of the question, line by line, as Neovim laid it out. */
      readonly body: readonly string[];
      readonly choices: readonly PromptChoice[];
    }
  | {
      readonly kind: "list";
      readonly title: string;
      /** Lines that are not an item (a heading under the title). */
      readonly body: readonly string[];
      readonly items: readonly PromptChoice[];
      /** What has been typed so far. */
      readonly typed: string;
    }
  | {
      readonly kind: "substitute";
      /** What a match is replaced with, as Neovim says it. */
      readonly replacement: string;
      readonly choices: readonly PromptChoice[];
    };

/** `nvim_input`'s text for a typed character. */
function inputOf(ch: string): string {
  return ch === "<" ? "<lt>" : ch;
}

/** One rendered choice (`(D)elete`, `[C]ancel`, `Open Read-Only`). */
function choiceOf(text: string): PromptChoice {
  const m = /^(.*?)([([])(.)([)\]])(.*)$/u.exec(text);
  if (m && ((m[2] === "(" && m[4] === ")") || (m[2] === "[" && m[4] === "]"))) {
    const before = m[1] ?? "";
    const key = m[3] ?? "";
    return {
      label: before + key + (m[5] ?? ""),
      accel: before.length,
      key,
      keys: inputOf(key.toLowerCase()),
      isDefault: m[2] === "[",
    };
  }
  // No accelerator Neovim could show (`&&Amp`): its first character is it.
  const first = [...text][0] ?? "";
  return {
    label: text,
    accel: -1,
    key: "",
    keys: inputOf(first.toLowerCase()),
    isDefault: false,
  };
}

const HOTKEY = /[([].[)\]]/u;

/**
 * The choices of `confirm()`'s rendered answers (`(D)elete, [C]ancel: `),
 * or `undefined` when the text is not that. Neovim joins them with `, `; a
 * piece without an accelerator is the rest of the one before (`[y]es,
 * please`), as only the first can lack one.
 */
export function confirmChoices(prompt: string): PromptChoice[] | undefined {
  if (!prompt.endsWith(": ")) return undefined;
  const text = prompt.slice(0, -2);
  const pieces = text.split(", ");
  const merged: string[] = [];
  for (const piece of pieces) {
    if (merged.length > 0 && !HOTKEY.test(piece))
      merged[merged.length - 1] += `, ${piece}`;
    else merged.push(piece);
  }
  if (merged.length === 0 || !merged.some((p) => HOTKEY.test(p)))
    return undefined;
  return merged.map(choiceOf);
}

const SUBSTITUTE =
  /^replace with (.*)\? \(y\)es\/\(n\)o\/\(a\)ll\/\(q\)uit\/\(l\)ast\/scroll up\(\^E\)\/down\(\^Y\)$/su;

const SUBSTITUTE_CHOICES: readonly PromptChoice[] = [
  ["Yes", "y"],
  ["No", "n"],
  ["All", "a"],
  ["Quit", "q"],
  ["Last", "l"],
].map(([label = "", key = ""]) => ({
  label,
  accel: 0,
  key,
  keys: key,
  isDefault: false,
}));

const LIST = /^Type number and <Enter>/u;

/** `1. alpha`, ` 2 "word"` (`z=`): a numbered line of inputlist(). */
const ITEM = /^\s*(\d+)(?:[.):]\s*|\s+)(.*)$/su;

/** The question's lines, its trailing blank ones dropped. */
function linesOf(prompt: readonly (readonly MsgChunk[])[] | undefined) {
  const lines = (prompt ?? []).map((line) => msgText(line));
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
  return lines;
}

/** The title (first line with words) and what follows it. */
function titled(lines: readonly string[]): { title: string; body: string[] } {
  const at = lines.findIndex((l) => l.trim() !== "");
  if (at === -1) return { title: "", body: [] };
  return { title: (lines[at] ?? "").trim(), body: lines.slice(at + 1) };
}

/** The native form of the prompt Neovim waits at, if it has one. */
export function nativePrompt(state: {
  readonly cmdline: readonly CmdlineLevel[];
  readonly prompt: readonly (readonly MsgChunk[])[] | undefined;
}): NativePrompt | undefined {
  const line = state.cmdline.at(-1);
  if (!line || line.firstc !== "" || line.prompt === "") return undefined;
  // A prompt inside another command line (`<C-r>=input()`) stays its own.
  if (line.level !== 1) return undefined;
  const typed = line.content.map(([, text]) => text).join("");
  const sub = SUBSTITUTE.exec(line.prompt);
  if (sub) {
    return {
      kind: "substitute",
      replacement: sub[1] ?? "",
      choices: SUBSTITUTE_CHOICES,
    };
  }
  if (LIST.test(line.prompt)) {
    const { title, body } = titled(linesOf(state.prompt));
    const rest: string[] = [];
    const items: PromptChoice[] = [];
    for (const text of body) {
      const m = ITEM.exec(text);
      if (m) {
        const n = m[1] ?? "";
        items.push({
          label: (m[2] ?? "").trim(),
          accel: -1,
          key: n,
          // What was typed goes first: the number is the whole answer.
          keys: `<C-u>${n}<CR>`,
          isDefault: false,
        });
      } else if (items.length === 0) {
        rest.push(text);
      }
    }
    return { kind: "list", title, body: rest, items, typed };
  }
  // A confirm() answers with one key: nothing typed is in its line.
  if (typed !== "") return undefined;
  const choices = confirmChoices(line.prompt);
  if (!choices) return undefined;
  const { title, body } = titled(linesOf(state.prompt));
  return { kind: "confirm", title, body, choices };
}

/**
 * Where `:s///c`'s match is: the cell Neovim draws with `IncSearch` in a
 * window's grid (the match it asks about), first in reading order — or
 * `undefined` when none is (a colorscheme that clears it).
 */
export function substituteMatch(
  state: Pick<NeovimUiState, "grids" | "gridWins" | "hl" | "windows">,
): { grid: number; row: number; col: number; end: number } | undefined {
  const incsearch = new Set<number>();
  for (const [id, attr] of state.hl as Map<number, HlAttr>) {
    if (attr.groups?.includes("IncSearch")) incsearch.add(id);
  }
  if (incsearch.size === 0) return undefined;
  for (const [id, grid] of state.grids) {
    if (id === 1) continue;
    const win = state.windows.get(id);
    if (win?.hidden === true || win?.placement.kind === "float") continue;
    for (let row = 0; row < grid.height; row += 1) {
      for (let col = 0; col < grid.width; col += 1) {
        if (!incsearch.has(grid.hls[row * grid.width + col] ?? 0)) continue;
        let end = col;
        while (
          end + 1 < grid.width &&
          incsearch.has(grid.hls[row * grid.width + end + 1] ?? 0)
        )
          end += 1;
        return { grid: id, row, col, end: end + 1 };
      }
    }
  }
  return undefined;
}
