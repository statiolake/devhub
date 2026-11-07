/**
 * Text input for the Neovim page: the hidden textarea's events, as what to
 * show and what to send.
 *
 * Every character the person types — plain ASCII, a dead key's `é`, a
 * Japanese IME's `日本語` — arrives as text on a hidden, focused textarea
 * (keys with Ctrl, Meta or Cmd are `keys.ts`'s). While an IME composes, its
 * preedit is drawn inline at the cursor cell, underlined, and nothing reaches
 * Neovim; the committed text is sent once, when the composition ends. That
 * is the whole rule, and it is kept here as a pure machine so "no double
 * input" is a test (`ime.test.ts`) rather than a hope: Chromium sends an
 * `input` event *and* a `compositionend` for one commit, and only the second
 * is acted on.
 */

export interface ImeState {
  readonly composing: boolean;
  /** The preedit on screen, `""` when there is none. */
  readonly preedit: string;
}

export type ImeEvent =
  | { readonly type: "compositionstart" }
  | { readonly type: "compositionupdate"; readonly data: string }
  | { readonly type: "compositionend"; readonly data: string }
  | {
      readonly type: "input";
      readonly inputType: string;
      readonly data: string | null;
      readonly isComposing: boolean;
    }
  /** The page lost focus or was hidden: a composition in flight is dropped. */
  | { readonly type: "reset" };

export interface ImeStep {
  readonly state: ImeState;
  /** Text to hand Neovim (`nvim_input`, `<` escaped by the caller). */
  readonly commit?: string;
  /** Whether the textarea should be emptied. */
  readonly clear: boolean;
}

export const IDLE: ImeState = { composing: false, preedit: "" };

export function imeStep(state: ImeState, event: ImeEvent): ImeStep {
  switch (event.type) {
    case "compositionstart":
      return { state: { composing: true, preedit: "" }, clear: false };
    case "compositionupdate":
      return { state: { composing: true, preedit: event.data }, clear: false };
    case "compositionend":
      return event.data.length > 0
        ? { state: IDLE, commit: event.data, clear: true }
        : { state: IDLE, clear: true };
    case "input": {
      // The composition's own input events: its compositionend commits.
      if (
        state.composing ||
        event.isComposing ||
        event.inputType === "insertCompositionText" ||
        event.inputType === "insertFromComposition"
      ) {
        return { state, clear: false };
      }
      if (
        (event.inputType === "insertText" ||
          event.inputType === "insertReplacementText" ||
          event.inputType === "insertFromPaste") &&
        event.data !== null &&
        event.data.length > 0
      ) {
        return { state: IDLE, commit: event.data, clear: true };
      }
      // Deletions and the rest of the textarea's own editing mean
      // nothing to Neovim: the keydown already sent `<BS>`.
      return { state: IDLE, clear: true };
    }
    case "reset":
      return { state: IDLE, clear: true };
  }
}
