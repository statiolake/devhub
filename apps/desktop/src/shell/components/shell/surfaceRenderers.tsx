/**
 * The DOM Surfaces, plugged into the viewport's registry.
 *
 * There is one renderer behind both kinds, and that is the point. A terminal
 * and an Agent are both a tmux session attached over a PTY, so both are drawn
 * by `TerminalSurface` and the only thing that differs is the surface key —
 * `global-terminal`, `workspace-terminal:<uuid>`, `agent:<uuid>` — which main
 * resolves to a session. The Agent used to have a renderer of its own because
 * it had a runtime of its own, rendering a screen the provider had already
 * drawn; retiring that runtime removed the reason for the second view, and with
 * it the second scrollback model, the second input path and the second set of
 * ways for those to disagree with the terminal's.
 *
 * The registry keeps two entries rather than one because the *viewport* still
 * distinguishes them — an Agent row and a terminal row are different things in
 * the Sidebar — and this file is where that distinction is allowed to end.
 */

import { TerminalSurface } from "../../terminal/TerminalSurface";
import {
  registerSurfaceRenderer,
  type SurfaceRendererProps,
} from "./surfaceRegistry";

function Session({
  surfaceKey,
  surfaceLabel,
  appearance,
  visible,
}: SurfaceRendererProps) {
  return (
    <TerminalSurface
      surfaceKey={surfaceKey}
      surfaceLabel={surfaceLabel}
      appearance={appearance}
      hidden={!visible}
      // The Sidebar and the titlebar already name what is on screen; a second
      // title inside the surface would say it a third time.
      hideTitle
    />
  );
}

/** Called once, from the page's entry point, before anything renders. */
export function installSurfaceRenderers(): void {
  registerSurfaceRenderer("terminal", Session);
  registerSurfaceRenderer("agent", Session);
}
