/**
 * Whether a lightbox is open on this page, told to whoever stacks the page's
 * view.
 *
 * A lightbox is drawn in its own page, over the whole of that page's view
 * (`Lightbox.tsx`). Where nothing else is laid over the view that is the
 * top of the content area already, and nobody needs telling. The one place
 * something is: the Orchestrator's board is in the Agents view, and a GUI
 * orchestrator's conversation is a view of its own laid right of the board,
 * above it — so a picture opened large from the board opened under the
 * conversation. No z-index inside the page can lift it over another view;
 * the window's stacking can (`LayoutState.agentsOverlay`). So the board
 * installs a listener here, and while a lightbox is open on its page main
 * stacks the Agents view over the conversation.
 *
 * A page without a listener (the Conversations page, a test) is told
 * nothing: its lightbox is already over everything its view is under.
 */

type Listener = (open: boolean) => void;

let listener: Listener | undefined;
let open = 0;

/** Listen for lightboxes on this page; returns the way to stop. */
export function listenForLightboxes(next: Listener): () => void {
  listener = next;
  if (open > 0) next(true);
  return () => {
    if (listener !== next) return;
    listener = undefined;
    if (open > 0) next(false);
  };
}

/** A lightbox opened; returns the way to say it closed. */
export function lightboxOpened(): () => void {
  open += 1;
  if (open === 1) listener?.(true);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    open -= 1;
    if (open === 0) listener?.(false);
  };
}
