/**
 * Where the keyboard belongs when DevHub is in front: the main area.
 *
 * DevHub is a piece of chrome wrapped around somebody else's application. The
 * Sidebar is for choosing what to look at; the thing you chose is what you
 * type into. So the keyboard's home is the main area, and every other place it
 * can land is somewhere it is only ever passing through.
 *
 * Main already answers this for the *window* — `ShellWindow.focusSurface`
 * decides which web contents the keyboard goes to, and that is the only place
 * that decides it. But when the answer is "the App Shell page", the page still
 * has to say where inside itself, and nothing did: a click on a Sidebar row
 * left DOM focus on that row's button, so the next keystroke went to a tree
 * item instead of the Agent that was on screen. This is the page's half of the
 * same rule, and it is one function for the same reason main's is.
 *
 * Two things deliberately keep the keyboard:
 *
 * - **Keyboard navigation.** Arrowing through the Sidebar and pressing Return
 *   is someone working *in* the tree; yanking focus out from under them would
 *   make the tree unusable by the people who most need it. A click raised by a
 *   key carries `detail === 0`, which is how the two are told apart.
 * - **Anything that takes typing.** A field, a menu that is open and being
 *   navigated: those asked for the keyboard, so they have not got it by
 *   accident.
 *
 * Nothing here touches window focus. Whether DevHub should be frontmost is a
 * different question with different answers, and main owns it.
 */

/** Things inside the chrome that have a real claim on the keyboard. */
const KEEPS_THE_KEYBOARD =
  "input, textarea, select, [contenteditable], [role='menu'], [role='menuitem'], [role='dialog'], .row-menu";

/**
 * The main area's own focusable thing, when the page is drawing one.
 *
 * Only an Agent's pane: a workbench is a native view main focuses directly, so
 * when one is on screen there is nothing in this document to move focus to —
 * and taking focus off the chrome is then the whole of the job.
 */
function mainSurfaceElement(root: Document): HTMLElement | null {
  const pane = root.querySelector(".agent-pane:not([hidden])");
  const entry = pane?.querySelector(".surface-pool-entry:not([hidden])");
  return (
    // xterm listens on its own helper textarea; the host element around it is
    // the fallback for the moment before the emulator has built one.
    entry?.querySelector<HTMLElement>(".xterm-helper-textarea") ??
    entry?.querySelector<HTMLElement>(".terminal-surface") ??
    null
  );
}

/**
 * Put the keyboard back in the main area.
 *
 * With an Agent on screen that is its pane. With a workbench on screen there is
 * nothing in this document to focus, so whatever in the chrome is holding the
 * keyboard gives it up instead — main has already pointed the window at the
 * workbench's contents, and the only thing standing in the way is a focused
 * element in the page above it.
 */
export function focusMainSurface(root: Document = document): void {
  const surface = mainSurfaceElement(root);
  if (surface) {
    surface.focus();
    return;
  }
  const active = root.activeElement;
  if (active instanceof HTMLElement && active !== root.body) {
    active.blur();
  }
}

/** True when this click was raised by a key rather than by a pointer. */
function fromKeyboard(event: MouseEvent): boolean {
  return event.detail === 0;
}

/**
 * Keep the keyboard at home for as long as the page is up.
 *
 * Installed once, on the whole document, rather than as a focus call on every
 * control that can be clicked. A rule enforced control by control is a rule
 * the next control forgets, and this one has already been forgotten once.
 */
export function installFocusHome(target: Document): () => void {
  const onClick = (event: MouseEvent) => {
    if (fromKeyboard(event)) return;
    const element =
      event.target instanceof Element
        ? event.target
        : event.target instanceof Node
          ? event.target.parentElement
          : null;
    if (element?.closest(KEEPS_THE_KEYBOARD)) return;
    // After the click has finished being handled: the row's own handler runs
    // first and may move the selection, and the pane that ends up on screen is
    // the one the keyboard should land in.
    queueMicrotask(() => {
      focusMainSurface(target);
    });
  };

  /**
   * Coming back to DevHub puts the keyboard home, wherever it was left.
   *
   * Command-Tab restores focus to whatever held it when the app was last in
   * front, which after a click in the Sidebar is a tree item — so returning to
   * DevHub and typing went to the Sidebar. This fires only for this page's own
   * contents, so a Settings window or an open Web Inspector, which are other
   * contents entirely, are never taken from.
   */
  const view = target.defaultView;
  const onWindowFocus = () => {
    focusMainSurface(target);
  };

  target.addEventListener("click", onClick);
  view?.addEventListener("focus", onWindowFocus);
  return () => {
    target.removeEventListener("click", onClick);
    view?.removeEventListener("focus", onWindowFocus);
  };
}
