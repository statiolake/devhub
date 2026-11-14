/**
 * Neovim's prompts drawn natively (`prompts.ts` reads them;
 * `docs/neovim-editor.md`, "Prompts").
 *
 * - **`confirm()`, `:confirm`, the swap file's E325, `inputlist()`, `z=`** —
 *   a confirmation sheet hanging from the top of the editor, in the quick
 *   pick's parts (`PickerParts`, as tmux's chooser is drawn): the question's
 *   first line its title, the rest under it in the grid's face (Neovim lays
 *   it out in columns), one row per answer, its accelerator underlined and
 *   its key at the row's end, the default the selected row (Return takes
 *   it, as in every DevHub confirmation). In a short editor the words
 *   scroll and the answers stay (`.picker.is-confirmation`).
 * - **`:s///c`** — a bar of one row under the match it asks about: what it
 *   is replaced with, and Yes, No, All, Quit, Last with their keys.
 *
 * Neovim keeps the keys: they reach it as they always do (the editor's
 * textarea keeps the focus — a click here does not take it), and a click
 * on an answer sends that answer's key (`nvim_input`). The prompt goes when
 * Neovim leaves it, never when it is clicked; the row clicked shows as
 * taken until then (a round trip). Between two of `:s///c`'s questions
 * Neovim hides its command line and flushes before asking the next, so the
 * bar is held that long (`SUBSTITUTE_HOLD_MS`) and moves to the next match
 * instead of blinking out and back.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { PickerHeader } from "../components/shell/PickerParts";
import type { NeovimEditor } from "./editor";
import {
  nativePrompt,
  substituteMatch,
  type NativePrompt,
  type PromptChoice,
} from "./prompts";
import type { NeovimUiState } from "./redraw";

/**
 * How long `:s///c`'s bar stays after its command line hides, for the next
 * question's: Neovim asks it straight away (no key is waited for), so this
 * is a frame or two in practice; after the last match nothing comes.
 */
export const SUBSTITUTE_HOLD_MS = 120;

/** How long a clicked answer shows as taken while Neovim answers, at most. */
const TAKEN_MS = 600;

type Send = (method: string, args: readonly unknown[]) => void;

/** The label, its accelerator underlined. */
function Accelerated({ choice }: { readonly choice: PromptChoice }): ReactNode {
  if (choice.accel < 0) return choice.label;
  const at = choice.accel;
  const key = [...choice.label.slice(at)][0] ?? "";
  return (
    <>
      {choice.label.slice(0, at)}
      <u className="nvim-prompt-accel">{key}</u>
      {choice.label.slice(at + key.length)}
    </>
  );
}

/** Which answer was clicked, until Neovim moves on (or `TAKEN_MS`). */
function useTaken(identity: string) {
  const [taken, setTaken] = useState<{ id: string; keys: string }>();
  useEffect(() => {
    if (!taken) return;
    const timer = window.setTimeout(() => {
      setTaken(undefined);
    }, TAKEN_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [taken]);
  const current = taken?.id === identity ? taken.keys : undefined;
  return [
    current,
    (keys: string) => {
      setTaken({ id: identity, keys });
    },
  ] as const;
}

function identityOf(prompt: NativePrompt): string {
  return JSON.stringify(prompt);
}

function ConfirmSheet({
  prompt,
  editor,
  answer,
}: {
  readonly prompt: Extract<NativePrompt, { kind: "confirm" | "list" }>;
  readonly editor: NeovimEditor;
  readonly answer: (keys: string) => void;
}) {
  const [taken, take] = useTaken(identityOf(prompt));
  const cell = editor.cellMetrics();
  const area = editor.areaSize();
  const list = prompt.kind === "list";
  const choices = list ? prompt.items : prompt.choices;
  const body = prompt.body.join("\n").replace(/^\n+|\s+$/g, "");
  const title =
    prompt.title !== "" ? prompt.title : list ? "Choose one" : "Neovim asks";
  return (
    <section
      className="nvim-prompt mac-sheet picker is-confirmation"
      role="dialog"
      aria-label={title}
      data-kind={prompt.kind}
      style={{
        maxHeight: Math.max(cell.height * 6, area.height - cell.height * 2),
        width: `min(560px, ${String(Math.max(240, area.width - 2 * cell.width))}px)`,
        ["--nvim-grid-font" as string]: editor.font().family,
      }}
      onMouseDown={(event) => {
        // A click here answers; the keyboard stays the editor's.
        event.preventDefault();
      }}
    >
      <PickerHeader
        title={title}
        {...(body === ""
          ? {}
          : {
              question: <span className="nvim-prompt-body">{body}</span>,
            })}
      />
      {list ? (
        <div className="picker-search nvim-prompt-field">
          <span className="picker-input">
            {prompt.typed === "" ? (
              <span className="nvim-prompt-placeholder">Type a number</span>
            ) : (
              prompt.typed
            )}
            <span className="nvim-prompt-caret" />
          </span>
        </div>
      ) : null}
      <div className="picker-body">
        <div className="picker-list">
          <ul className="mac-list picker-results" role="listbox">
            {choices.map((choice, index) => (
              <li key={`${String(index)}:${choice.label}`}>
                <button
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={
                    taken === undefined
                      ? choice.isDefault ||
                        (list &&
                          prompt.typed !== "" &&
                          prompt.typed === choice.key)
                      : taken === choice.keys
                  }
                  className="mac-list-row nvim-prompt-choice"
                  data-key={choice.key}
                  onClick={() => {
                    take(choice.keys);
                    answer(choice.keys);
                  }}
                >
                  <span className="mac-list-text">
                    <span className="mac-list-title">
                      <Accelerated choice={choice} />
                    </span>
                  </span>
                  <span className="picker-accessory mac-caption nvim-prompt-keys">
                    {choice.isDefault ? <kbd>↩</kbd> : null}
                    {choice.key === "" ? null : <kbd>{choice.key}</kbd>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <footer className="picker-footer">
        <div className="picker-note mac-caption">
          {list ? (
            <>
              Type its number and <kbd>↩</kbd>, or click it · <kbd>esc</kbd>{" "}
              cancels
            </>
          ) : (
            <>
              Press its key or click it · <kbd>esc</kbd> cancels
            </>
          )}
        </div>
      </footer>
    </section>
  );
}

/** The bar's height: one row of buttons. */
function barHeight(cell: { readonly height: number }): number {
  return Math.round(cell.height + 12);
}

function SubstituteBar({
  prompt,
  state,
  editor,
  answer,
}: {
  readonly prompt: Extract<NativePrompt, { kind: "substitute" }>;
  readonly state: NeovimUiState;
  readonly editor: NeovimEditor;
  readonly answer: (keys: string) => void;
}) {
  const [taken, take] = useTaken(identityOf(prompt));
  const bar = useRef<HTMLDivElement | null>(null);
  const lastPlace = useRef<{ left: number; top: number } | undefined>(
    undefined,
  );
  const cell = editor.cellMetrics();
  const area = editor.areaSize();
  const height = barHeight(cell);
  const match = substituteMatch(state);
  const box =
    match === undefined
      ? undefined
      : editor.gridBoxes().find((b) => b.grid === match.grid);
  let left: number;
  let top: number;
  if (match && box) {
    left = (box.col + match.col) * cell.width;
    const row = box.row + match.row;
    const below = (row + 1) * cell.height + 2;
    // Under the match, or over it where the editor ends.
    top =
      below + height > area.height - cell.height
        ? row * cell.height - height - 2
        : below;
  } else if (lastPlace.current) {
    // Held between two questions: where the last match was.
    ({ left, top } = lastPlace.current);
  } else {
    const place = editor.cmdlinePlace();
    left = place.left;
    top = place.top + place.height - height;
  }
  // Inside the editor: measured before it is painted, so it never shows
  // where it does not fit.
  useLayoutEffect(() => {
    lastPlace.current = { left, top };
    const el = bar.current;
    if (!el) return;
    const width = el.offsetWidth;
    el.style.left = `${String(Math.max(0, Math.min(left, area.width - width - 4)))}px`;
  });
  return (
    <div
      ref={bar}
      className="nvim-prompt-bar"
      role="dialog"
      aria-label="Replace this match?"
      style={{
        left,
        top: Math.max(0, top),
        height,
        ["--nvim-grid-font" as string]: editor.font().family,
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
    >
      <span className="nvim-prompt-bar-question">
        Replace with <code>{prompt.replacement}</code>?
      </span>
      {prompt.choices.map((choice) => (
        <button
          key={choice.key}
          type="button"
          tabIndex={-1}
          className={
            taken === choice.keys
              ? "nvim-prompt-bar-button is-taken"
              : "nvim-prompt-bar-button"
          }
          data-key={choice.key}
          onClick={() => {
            take(choice.keys);
            answer(choice.keys);
          }}
        >
          <span>
            <Accelerated choice={choice} />
          </span>
          <kbd>{choice.key}</kbd>
        </button>
      ))}
      <span className="nvim-prompt-bar-hint">
        <kbd>⌃E</kbd> <kbd>⌃Y</kbd> scroll · <kbd>esc</kbd> quits
      </span>
    </div>
  );
}

/**
 * `:s///c`'s prompt, held through the flush between two questions: the
 * prompt as Neovim shows it, or the last substitute one for
 * `SUBSTITUTE_HOLD_MS` after it went.
 */
function useHeld(prompt: NativePrompt | undefined): NativePrompt | undefined {
  const last = useRef<{ prompt: NativePrompt; gone: number } | undefined>(
    undefined,
  );
  const [, wake] = useState(0);
  const now = performance.now();
  if (prompt !== undefined) {
    last.current =
      prompt.kind === "substitute"
        ? { prompt, gone: Number.POSITIVE_INFINITY }
        : undefined;
  } else if (last.current?.gone === Number.POSITIVE_INFINITY) {
    last.current = { prompt: last.current.prompt, gone: now };
  }
  const held =
    prompt === undefined &&
    last.current !== undefined &&
    now - last.current.gone < SUBSTITUTE_HOLD_MS
      ? last.current.prompt
      : undefined;
  useEffect(() => {
    if (held === undefined) return;
    const timer = window.setTimeout(() => {
      wake((n) => n + 1);
    }, SUBSTITUTE_HOLD_MS + 1);
    return () => {
      window.clearTimeout(timer);
    };
  }, [held]);
  if (prompt === undefined && held === undefined) last.current = undefined;
  return prompt ?? held;
}

/** The prompt Neovim waits at, drawn natively — or nothing. */
export function NativePrompts({
  state,
  editor,
  send,
}: {
  readonly state: NeovimUiState;
  readonly editor: NeovimEditor;
  readonly send: Send;
}) {
  const prompt = useHeld(nativePrompt(state));
  if (prompt === undefined) return null;
  const answer = (keys: string) => {
    send("nvim_input", [keys]);
  };
  if (prompt.kind === "substitute")
    return (
      <SubstituteBar
        prompt={prompt}
        state={state}
        editor={editor}
        answer={answer}
      />
    );
  return <ConfirmSheet prompt={prompt} editor={editor} answer={answer} />;
}

/**
 * Whether the command line's box leaves the prompt to `NativePrompts`: it
 * is one of theirs, or its question has come and its answers are on their
 * way (the `confirm` message is flushed before the command line asking).
 */
export function promptIsNative(state: NeovimUiState): boolean {
  if (state.prompt !== undefined && state.cmdline.length === 0) return true;
  return nativePrompt(state) !== undefined;
}
