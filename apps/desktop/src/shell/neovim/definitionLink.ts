/**
 * Go to definition with the pointer, as VS Code's Cmd-hover and Cmd-click
 * (docs/neovim-editor.md, "Go to definition with the pointer").
 *
 * While the modifier (`[editor] definition_modifier`, Option by default) is
 * held, the cell under the pointer is asked about — one ask a frame at most
 * (`PerFrame`), none while the modifier is up — and Neovim (devhub.nvim's
 * `devhub.definition`) answers whether it is a symbol with a definition and
 * which cells the symbol takes. A symbol that has one is drawn as a link
 * over exactly those cells, by the page (`NeovimEditor.drawLink`, the same
 * highlight overrides as Visual's band in a drag): nothing in the buffer,
 * and gone in the frame the modifier goes up or the pointer leaves it.
 *
 * A click with the modifier on the link, or on the symbol whose answer is
 * still coming, is the jump (Neovim's `vim.lsp.buf.definition()`) and not a
 * click: Neovim never sees the press, so no cursor move or Visual drag
 * comes first. Anywhere else — no LSP, no definition, not a word — the
 * click is Neovim's, unchanged (its own Alt-click: a blockwise Visual).
 *
 * The state machine is here, with no DOM; the editor wires it to the
 * pointer, the keys and Neovim.
 */

import type { DefinitionModifier } from "../../model/definitionModifier";
import { PerFrame } from "./perFrame";
import type { HlAttr } from "./redraw";

export interface LinkCell {
  readonly grid: number;
  readonly row: number;
  readonly col: number;
}

/** A row of a symbol's cells, in its window's grid: `col0`..`col1`. */
export interface LinkSpan {
  readonly row: number;
  readonly col0: number;
  readonly col1: number;
}

/** The symbol drawn as a link. */
export interface Link {
  readonly grid: number;
  readonly spans: readonly LinkSpan[];
}

/** What Neovim answers an ask with (`hover`, or the `definition_link` event). */
export type LinkAnswer =
  | false
  | {
      readonly seq: number;
      readonly spans: readonly LinkSpan[];
      readonly link?: boolean;
      readonly pending?: boolean;
    };

/** Asked of Neovim with `nvim_exec_lua`: `seq, win, row, col`. */
export const LINK_HOVER_LUA =
  "local d = package.loaded['devhub.definition']; if not d then return false end; return d.hover(...)";
/** The modifier's click: `win, row, col`. */
export const LINK_JUMP_LUA =
  "local d = package.loaded['devhub.definition']; if d then d.jump(...) end";
/** The modifier went up: the request in flight is dropped. */
export const LINK_CANCEL_LUA =
  "local d = package.loaded['devhub.definition']; if d then d.cancel() end";

interface ModifierState {
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}

/** Whether the modifier, and no other, is held. */
export function modifierHeld(
  event: ModifierState,
  modifier: DefinitionModifier,
): boolean {
  if (modifier === "off" || event.shiftKey) return false;
  const { altKey: a, metaKey: m, ctrlKey: c } = event;
  if (modifier === "alt") return a && !m && !c;
  if (modifier === "cmd") return m && !a && !c;
  return c && !a && !m;
}

/** Whether `key` (`KeyboardEvent.key`) is the modifier itself. */
export function isModifierKey(
  key: string,
  modifier: DefinitionModifier,
): boolean {
  if (modifier === "alt") return key === "Alt";
  if (modifier === "cmd") return key === "Meta";
  if (modifier === "ctrl") return key === "Control";
  return false;
}

/** Whether `at` is one of `spans`' cells in `grid`. */
export function inSpans(
  grid: number,
  spans: readonly LinkSpan[],
  at: LinkCell,
): boolean {
  return (
    at.grid === grid &&
    spans.some((s) => s.row === at.row && at.col >= s.col0 && at.col <= s.col1)
  );
}

/**
 * A cell's colours as a link: its own, with the link's ink and a plain
 * underline in it (as Neovim draws `@markup.link` over a cell's own).
 */
export function linkAttr(attr: HlAttr, ink: number): HlAttr {
  return {
    ...attr,
    reverse: false,
    foreground: ink,
    special: ink,
    underline: true,
    undercurl: false,
    underdouble: false,
    underdotted: false,
    underdashed: false,
  };
}

/** The grid's cells (row-major indices) a link's spans cover, clipped. */
export function linkCells(
  width: number,
  height: number,
  spans: readonly LinkSpan[],
): number[] {
  const out: number[] = [];
  for (const { row, col0, col1 } of spans) {
    if (row < 0 || row >= height) continue;
    for (let col = Math.max(0, col0); col <= col1 && col < width; col += 1)
      out.push(row * width + col);
  }
  return out;
}

/** An answer read from what Neovim sent: anything odd is `false`. */
export function linkAnswerOf(value: unknown): LinkAnswer {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const v = value as Record<string, unknown>;
  const seq = v["seq"];
  if (typeof seq !== "number") return false;
  const spans: LinkSpan[] = [];
  for (const s of Array.isArray(v["spans"]) ? v["spans"] : []) {
    if (typeof s !== "object" || s === null) continue;
    const r = s as Record<string, unknown>;
    const row = r["row"];
    const col0 = r["col0"];
    const col1 = r["col1"];
    if (
      typeof row === "number" &&
      typeof col0 === "number" &&
      typeof col1 === "number" &&
      col1 >= col0
    )
      spans.push({ row, col0, col1 });
  }
  return {
    seq,
    spans,
    ...(v["link"] === true ? { link: true } : {}),
    ...(v["pending"] === true ? { pending: true } : {}),
  };
}

export interface LinkPort {
  /** Ask about a cell; its answer, or undefined when it cannot be asked. */
  hover(seq: number, at: LinkCell): Promise<unknown> | undefined;
  /** The modifier's click on a cell. */
  jump(at: LinkCell): void;
  /** Drop the request in flight. */
  cancel(): void;
  /** The link drawn, or gone: paint. */
  changed(link: Link | undefined): void;
}

export class DefinitionLinks {
  /** The modifier is held (keys and the pointer's own events agree). */
  private held = false;
  private pointer: LinkCell | undefined;
  private seq = 0;
  /** The newest ask: where, and once answered, the symbol's cells. */
  private asked:
    | {
        readonly seq: number;
        readonly at: LinkCell;
        spans: readonly LinkSpan[];
        state: "pending" | "link" | "none";
      }
    | undefined;
  private drawn: Link | undefined;
  private readonly asks: PerFrame<LinkCell>;

  constructor(
    private readonly port: LinkPort,
    schedule?: (fn: () => void) => void,
  ) {
    this.asks = new PerFrame((at) => {
      this.send(at);
    }, schedule);
  }

  /** The link drawn now, if any. */
  get link(): Link | undefined {
    return this.drawn;
  }

  /** Whether the pointer is on the link (the hand). */
  get overLink(): boolean {
    const at = this.pointer;
    const link = this.drawn;
    return (
      at !== undefined &&
      link !== undefined &&
      inSpans(link.grid, link.spans, at)
    );
  }

  /** The modifier went down or up (a key, the window's focus lost). */
  modifier(held: boolean): void {
    if (held === this.held) return;
    this.held = held;
    if (!held) {
      this.drop(true);
      return;
    }
    if (this.pointer !== undefined) this.asks.push(this.pointer);
  }

  /**
   * The pointer over a window's cell (`undefined`: off the windows), with
   * the modifier held or not as the event says.
   */
  pointerAt(at: LinkCell | undefined, held: boolean): void {
    const was = this.pointer;
    this.pointer = at;
    if (held !== this.held) {
      this.modifier(held);
      return;
    }
    if (!held) return;
    if (at === undefined) {
      this.drop(true);
      return;
    }
    if (
      was !== undefined &&
      was.grid === at.grid &&
      was.row === at.row &&
      was.col === at.col
    )
      return;
    // Still over the symbol asked about (a link, one coming, or a word
    // with no definition): nothing new to ask.
    const asked = this.asked;
    if (asked !== undefined && inSpans(asked.at.grid, asked.spans, at)) return;
    this.drop(false);
    this.asks.push(at);
  }

  /**
   * The modifier's click on `at`: whether it is taken (the jump) rather
   * than handed to Neovim as a click.
   */
  click(at: LinkCell, held: boolean): boolean {
    if (!held) return false;
    const asked = this.asked;
    const onLink =
      this.drawn !== undefined &&
      inSpans(this.drawn.grid, this.drawn.spans, at);
    const coming =
      asked !== undefined &&
      asked.state === "pending" &&
      (inSpans(asked.at.grid, asked.spans, at) ||
        (asked.at.grid === at.grid &&
          asked.at.row === at.row &&
          asked.at.col === at.col));
    if (!onLink && !coming) return false;
    this.port.jump(at);
    this.drop(false);
    return true;
  }

  /** Neovim's answer, to `hover` or as the `definition_link` event. */
  answer(value: unknown): void {
    const answer = linkAnswerOf(value);
    if (answer === false) return;
    const asked = this.asked;
    if (asked === undefined || answer.seq !== asked.seq) return;
    if (answer.spans.length > 0) asked.spans = answer.spans;
    if (answer.pending === true) return;
    asked.state = answer.link === true ? "link" : "none";
    if (asked.state !== "link" || !this.held) return;
    this.drawn = { grid: asked.at.grid, spans: asked.spans };
    this.port.changed(this.drawn);
  }

  /**
   * What the link was drawn over changed (a redraw moved or rewrote its
   * cells, a scroll): gone, and asked again while the modifier is held.
   */
  invalidate(): void {
    const at = this.pointer;
    this.drop(false);
    if (this.held && at !== undefined) this.asks.push(at);
  }

  /** An ask, for where the pointer is now (it may have moved on since). */
  private send(_at: LinkCell): void {
    const where = this.pointer;
    if (!this.held || where === undefined) return;
    this.seq += 1;
    const seq = this.seq;
    this.asked = { seq, at: where, spans: [], state: "pending" };
    const reply = this.port.hover(seq, where);
    if (reply === undefined) {
      this.asked = undefined;
      return;
    }
    reply.then(
      (value) => {
        if (value === false && this.asked?.seq === seq) {
          this.asked.state = "none";
          return;
        }
        this.answer(value);
      },
      () => {
        if (this.asked?.seq === seq) this.asked.state = "none";
      },
    );
  }

  /** The link and the ask gone; with `cancel`, Neovim's request too. */
  private drop(cancel: boolean): void {
    const had = this.drawn !== undefined;
    const pending = this.asked?.state === "pending";
    this.asked = undefined;
    this.drawn = undefined;
    if (cancel && pending) this.port.cancel();
    if (had) this.port.changed(undefined);
  }
}
