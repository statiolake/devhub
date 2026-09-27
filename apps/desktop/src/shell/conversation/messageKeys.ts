/**
 * The keys of every field in a GUI Agent where something is written to send:
 * the composer, a waiting message being changed, a message to a subagent, and
 * an answer typed into a request.
 *
 * One rule for all of them. Return, with Shift or without, is a new line, as
 * it is in any text on the Mac: a message is often several lines, and a stray
 * Return must not send half of one. ⌘Return sends — or saves, or answers:
 * whatever the field's own button does. No other modifier with Return sends.
 *
 * A key pressed while an input method is still composing is the input
 * method's: it neither sends nor reaches the field's own keys, so Return
 * confirms the conversion and nothing else.
 *
 * A field may have keys of its own — the composer's command list and history,
 * Esc giving up an edit. They are asked after the send key, and only about
 * keys the input method has let go.
 */

import { useRef, type KeyboardEvent } from "react";
import { isImeComposing } from "../accessibility/ime";

/** How the send key is written wherever a GUI Agent names it. */
export const SEND_KEY = "⌘Return";

function isSendKey(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" &&
    event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey
  );
}

/** What a field needs to be spread with for these keys to be its keys. */
export interface MessageKeys<T extends HTMLElement> {
  readonly onKeyDown: (event: KeyboardEvent<T>) => void;
  readonly onCompositionStart: () => void;
  readonly onCompositionEnd: () => void;
}

/**
 * The keys for one field, or for several of which one has the keyboard at a
 * time: `send` is what ⌘Return does, and `own` the field's other keys.
 */
export function useMessageKeys<T extends HTMLElement = HTMLTextAreaElement>(
  send: () => void,
  own?: (event: KeyboardEvent<T>) => void,
): MessageKeys<T> {
  const composing = useRef(false);
  return {
    onKeyDown: (event) => {
      if (isImeComposing(event.nativeEvent, composing.current)) return;
      if (isSendKey(event)) {
        event.preventDefault();
        send();
        return;
      }
      own?.(event);
    },
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
    },
  };
}
