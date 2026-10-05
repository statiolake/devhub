/**
 * The mouse's side buttons, on DevHub's own pages: Back and Forward.
 *
 * On macOS a mouse's fourth and fifth buttons reach Chromium as ordinary
 * mouse events with `button` 3 and 4 — Electron's `app-command` is a Windows
 * and Linux event and never fires here — so the page the pointer is over is
 * the only thing that hears them. Over a workbench that is VS Code, which
 * walks its own editor history with them
 * (`workbench.editor.mouseBackForwardToNavigate`); over the Agents and the
 * Sidebar it is this, and it walks the app's history
 * (`model/navigationHistory.ts`). Which history a button means is therefore
 * decided by where the pointer is, which is what a person pressing it means.
 *
 * Answered on `mouseup`, which is where Chromium itself would act on them,
 * and the default is cancelled on `mousedown` and `mouseup` both: left alone,
 * Chromium takes the buttons as the *page's* Back and Forward and would
 * navigate this single-page view away from its own document.
 */

/** `MouseEvent.button` for the side buttons. */
const BACK_BUTTON = 3;
const FORWARD_BUTTON = 4;

export type HistoryDirection = "back" | "forward";

/** What this mouse button means, or nothing. */
export function historyDirectionOfButton(
  button: number,
): HistoryDirection | undefined {
  if (button === BACK_BUTTON) return "back";
  if (button === FORWARD_BUTTON) return "forward";
  return undefined;
}

/**
 * Answer the side buttons on this document. Returns a function that removes
 * the listeners again.
 */
export function installHistoryButtons(
  target: Document,
  navigate: (direction: HistoryDirection) => void,
): () => void {
  const onDown = (event: MouseEvent) => {
    if (historyDirectionOfButton(event.button) === undefined) return;
    event.preventDefault();
  };
  const onUp = (event: MouseEvent) => {
    const direction = historyDirectionOfButton(event.button);
    if (direction === undefined) return;
    event.preventDefault();
    navigate(direction);
  };
  target.addEventListener("mousedown", onDown);
  target.addEventListener("mouseup", onUp);
  return () => {
    target.removeEventListener("mousedown", onDown);
    target.removeEventListener("mouseup", onUp);
  };
}
