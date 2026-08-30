/**
 * Keep the shell from behaving like a document.
 *
 * `user-select: none` alone is not enough in WKWebView: a drag across the
 * chrome still raises a selection there, so the Sidebar's rows and the
 * Activity switcher's labels highlight as though they were body text. The
 * event is the engine-independent place to say no, and cancelling
 * `selectstart` leaves focus, clicks, and keyboard navigation untouched —
 * unlike suppressing the pointer events that precede it.
 */

/**
 * Everything a person has a reason to copy out of DevHub. Mirrors the opt-ins
 * in `tokens.css`, which still carry the cursor and the styling.
 */
const SELECTABLE =
  ".failure-title, .failure-detail, .surface-line, .terminal-surface, input, textarea, [contenteditable]";

/** True when a selection starting at `target` is one the shell allows. */
export function isSelectable(target: EventTarget | null): boolean {
  const element =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  return element?.closest(SELECTABLE) != null;
}

/**
 * Refuse selections outside the copyable regions. Returns a function that
 * removes the listener again.
 */
export function installSelectionGuard(target: Document): () => void {
  const onSelectStart = (event: Event) => {
    if (isSelectable(event.target)) return;
    event.preventDefault();
  };
  target.addEventListener("selectstart", onSelectStart);
  return () => target.removeEventListener("selectstart", onSelectStart);
}
