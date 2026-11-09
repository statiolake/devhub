/**
 * Where Neovim's messages go (`ext_messages`), pure: the person's pick of
 * three mocks ("C"), the messages merged into the notifications' corner.
 *
 * - **The corner** — an ordinary message (`:echo`, an error, a warning,
 *   undo's report, a write's) is a notification under the source "Neovim",
 *   in the same quiet lines as `gui.notify`: one place for what the editor
 *   says, and the command line's rows stay for typing.
 * - **The pager** — output the person asked to read (`:ls`, `:map`,
 *   `:messages`, a typed command's long output) opens in the pager, a
 *   Neovim buffer in a float (`neovimPager.ts`): a corner that fades is no
 *   place for a list, and in a buffer it is moved through, searched and
 *   yanked with the person's own keys.
 * - **The command line's box** — prompts and the search echo stay where
 *   they are typed (`redraw.ts` keeps them: `prompt`, `searchEcho`).
 *
 * Repeats collapse: undo's and redo's reports, a quickfix step, a
 * completion's count say where something is now, so each replaces the one
 * before (one line that changes, not a column of them); any message said
 * again while its line still shows is that line again, its fade restarted.
 */

import type { HlAttr, MessageEvent, MsgChunk, MsgShow } from "./redraw";
import { msgLines, msgText } from "./redraw";
import type { ToastLevel } from "./decorations";

/** A message for the corner, as `gui.notify` takes one. */
export interface MessageToast {
  /** Its key: a message with the same one replaces it (collapses). */
  readonly key: string;
  readonly msg: string;
  readonly level: ToastLevel;
}

/** Output for the pager: a title and its lines, with Neovim's highlights. */
export interface PagerOutput {
  readonly source: "output" | "messages";
  readonly title: string;
  readonly lines: readonly (readonly MsgChunk[])[];
}

export interface RoutedMessages {
  readonly toasts: readonly MessageToast[];
  readonly pager: PagerOutput | undefined;
}

/** Status reports that say where something is now: the newest replaces. */
const COLLAPSED = new Set(["undo", "quickfix", "completion", "wildlist"]);

/** Kinds that are errors or warnings, whatever their highlight. */
const ERRORS = new Set([
  "emsg",
  "echoerr",
  "lua_error",
  "rpc_error",
  "shell_err",
]);

/**
 * A typed command's output this long goes to the pager: three lines is
 * more than a notification's corner reads well (it is 48 cells wide), and
 * a one- or two-line answer (`:pwd`, `:set ts?`) is not worth a window.
 */
const PAGER_LINES = 3;

/** In the corner, at most this many lines of a long message, then a count. */
const TOAST_LINES = 4;

/** The kinds that print what a command was asked for, whatever its length. */
const LISTS = new Set(["list_cmd", "shell_out", "shell_err"]);

function levelOf(
  msg: MsgShow,
  hl: (attr: number) => HlAttr | undefined,
): ToastLevel {
  if (ERRORS.has(msg.kind)) return "error";
  if (msg.kind === "wmsg") return "warn";
  // `:echohl ErrorMsg | echomsg …`: the highlight says what it is.
  for (const chunk of msg.content) {
    const groups = hl(chunk.attr)?.groups ?? [];
    if (groups.includes("ErrorMsg")) return "error";
    if (groups.includes("WarningMsg")) return "warn";
  }
  return "info";
}

function keyOf(msg: MsgShow, text: string, level: ToastLevel): string {
  if (COLLAPSED.has(msg.kind)) return `nvim:kind:${msg.kind}`;
  // A progress message (`:w`'s "written") is updated under its id.
  if (msg.kind === "progress") return `nvim:id:${msg.id}`;
  return `nvim:text:${level}:${text}`;
}

/** A long message in the corner: its first lines and how many more. */
function clipped(text: string): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length <= TOAST_LINES) return lines.join("\n");
  const more = lines.length - TOAST_LINES;
  return `${lines.slice(0, TOAST_LINES).join("\n")}\n… ${String(more)} more line${more === 1 ? "" : "s"} (:messages)`;
}

function lineCount(msgs: readonly MsgShow[]): number {
  return msgs.reduce(
    (n, m) => n + msgText(m.content).replace(/\n+$/, "").split("\n").length,
    0,
  );
}

/**
 * The pager's lines for messages said one after another: an `append`ed one
 * (`:echon`, `:!cmd`'s output after its command) goes on the line before.
 */
function pagerLines(msgs: readonly MsgShow[]): MsgChunk[][] {
  const out: MsgChunk[][] = [];
  for (const msg of msgs) {
    const lines = msgLines(msg.content);
    const first = lines.shift() ?? [];
    if (msg.append && out.length > 0) out.at(-1)?.push(...first);
    else out.push(first);
    out.push(...lines);
  }
  // Trailing blank lines (a shell's last newline) are not output.
  while (out.length > 0 && out.at(-1)?.every((c) => c.text.trim() === ""))
    out.pop();
  return out;
}

/**
 * Route what `ext_messages` said since the last time: `:messages` and a
 * typed command's long output to the pager, the rest to the corner.
 */
export function routeMessages(
  events: readonly MessageEvent[],
  lastCommand: string | undefined,
  hl: (attr: number) => HlAttr | undefined,
): RoutedMessages {
  let pager: PagerOutput | undefined;
  const shows: MsgShow[] = [];
  for (const event of events) {
    if (event.type === "history") {
      pager = {
        source: "messages",
        title: "Messages",
        lines: event.entries.flatMap((entry) => msgLines(entry.content)),
      };
    } else {
      shows.push(event.msg);
    }
  }
  // What a typed command printed: one piece of output, read together. Its
  // `:!cmd` echo is left out (the title names the command).
  const typed = shows.filter(
    (m) => m.trigger === "typed_cmd" && m.kind !== "shell_cmd",
  );
  const asked =
    typed.length > 0 &&
    (lineCount(typed) >= PAGER_LINES ||
      (typed.some((m) => LISTS.has(m.kind)) && lineCount(typed) >= 2));
  if (asked && pager === undefined) {
    pager = {
      source: "output",
      title: lastCommand ?? "Output",
      lines: pagerLines(typed),
    };
  }
  const toasts: MessageToast[] = [];
  for (const msg of shows) {
    if (asked && msg.trigger === "typed_cmd") continue;
    if (msg.kind === "shell_cmd") continue;
    const text = msgText(msg.content).replace(/\s+$/, "");
    if (text.trim() === "") continue;
    const level = levelOf(msg, hl);
    const key = keyOf(msg, text, level);
    // An appended piece (`:echon`) goes on the message before it.
    const before = toasts.at(-1);
    if (msg.append && before) {
      toasts[toasts.length - 1] = {
        ...before,
        msg: clipped(before.msg + text),
      };
      continue;
    }
    const same = toasts.findIndex((t) => t.key === key);
    if (same !== -1) toasts.splice(same, 1);
    toasts.push({ key, msg: clipped(text), level });
  }
  return { toasts, pager };
}
