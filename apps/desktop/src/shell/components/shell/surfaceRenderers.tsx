/**
 * The two DOM Surfaces, plugged into the viewport's registry.
 *
 * The viewport decides which Surface is on screen and hands each one the same
 * four things; what a terminal and an Agent do with them is their own business,
 * and neither knows the other exists. This file is the only place the three
 * meet, which is why it is the only place that has to know that an Agent's
 * surface key carries its identity and a terminal's does not.
 */

import { TerminalSurface } from "../../terminal/TerminalSurface";
import { AgentSurfaceView } from "../../agent/AgentSurfaceView";
import {
  registerSurfaceRenderer,
  type SurfaceRendererProps,
} from "./surfaceRegistry";

function Terminal({
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

function Agent({
  surfaceKey,
  surfaceLabel,
  appearance,
  visible,
}: SurfaceRendererProps) {
  const agentId = surfaceKey.startsWith("agent:")
    ? surfaceKey.slice("agent:".length)
    : surfaceKey;
  return (
    <AgentSurfaceView
      agentId={agentId}
      agentLabel={surfaceLabel}
      hidden={!visible}
      fontFamily={appearance?.terminalFontFamily}
      fontSize={appearance?.terminalFontSize}
    />
  );
}

/** Called once, from the page's entry point, before anything renders. */
export function installSurfaceRenderers(): void {
  registerSurfaceRenderer("terminal", Terminal);
  registerSurfaceRenderer("agent", Agent);
}
