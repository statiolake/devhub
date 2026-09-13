/**
 * The field a sheet opens on, focused once and kept.
 *
 * Every modal DevHub draws has one thing a person starts typing into — a
 * picker's query field, the review sheet's textarea, the chord sheet itself,
 * which is focusable only so that Escape reaches it — and each of them used to
 * say so with its own mount effect calling `focus()`. One effect per sheet is
 * one place per sheet for the same two things to go wrong, and both of them
 * were measured:
 *
 * - **The element is not there yet.** A mount effect runs once, against
 *   whatever the first render produced. A sheet that draws a spinner until its
 *   text arrives focuses `null` and never asks again, and nothing about that
 *   failure is visible: the sheet is up, it looks ready, and the keys go
 *   nowhere.
 * - **The page did not have the keyboard.** DOM focus and the keyboard are two
 *   different facts in this application — the modal layer is a
 *   `WebContentsView`, and main decides which of the window's contents the keys
 *   reach (`ShellWindow.placeKeyboardIn`). `focus()` in a page that does not
 *   hold them sets `document.activeElement` and nothing else, so the sheet
 *   looks focused and is not. When the keyboard does arrive, Chromium restores
 *   it to whatever `activeElement` says — which is right unless that is the
 *   body, and it is the body exactly in the case above.
 *
 * So the rule is stated against the element rather than against the mount: the
 * field is focused as soon as it *exists*, whichever render that is, and the
 * page getting the keyboard back with nothing inside it focused counts as the
 * same thing happening again.
 *
 * The first of those is assertive — a sheet arriving on top of another one
 * takes the keyboard, which is what makes it a sheet — and everything after it
 * is not. A person who has tabbed to Cancel and come back from another app
 * finds the caret where they left it: the recovery fires only when focus is
 * nowhere, which is the one case where leaving it alone leaves the sheet dead.
 */

import { useEffect, useRef, type RefObject } from "react";

/**
 * A ref whose element takes the focus for as long as the sheet stands.
 *
 * `prepare` runs immediately after each focus, for the callers that also have
 * something to say about the caret — the review sheet puts it at the end of
 * the template, a picker at the end of the query it was opened with. It is
 * called with the element, so it never has to ask whether the ref is filled.
 */
export function useInitialFocus<T extends HTMLElement>(
  prepare?: (element: T) => void,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  /** Whether the element has ever been given the focus. */
  const taken = useRef(false);
  const take = useRef<() => void>(() => undefined);
  take.current = () => {
    const element = ref.current;
    if (!element || document.activeElement === element) return;
    taken.current = true;
    element.focus();
    prepare?.(element);
  };

  // No dependency list: this runs after every render, which is what makes "as
  // soon as it exists" true for a sheet whose field arrives late. It fires at
  // most once — after that the field has been offered the keyboard, and where
  // the focus goes next is the person's business.
  useEffect(() => {
    if (taken.current) return;
    take.current();
  });

  useEffect(() => {
    const recover = () => {
      // Nothing in the page holds the focus, so the keyboard the page was just
      // handed would go to the document. That is the dead sheet.
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      take.current();
    };
    window.addEventListener("focus", recover);
    return () => {
      window.removeEventListener("focus", recover);
    };
  }, []);

  return ref;
}
