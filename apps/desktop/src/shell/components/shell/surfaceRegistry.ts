/**
 * Where the terminal and agent Surfaces plug into the viewport.
 *
 * The viewport decides *which* Surface is on screen; it does not know how one
 * draws itself. A terminal is an xterm.js view over a PTY in the main process,
 * an agent is an xterm.js view over an Agent runtime channel, and both of those
 * are owned elsewhere — so they register a renderer here and the viewport calls
 * it.
 *
 * There is deliberately no default renderer. A Surface whose renderer has not
 * been registered draws a failure saying so, because a placeholder that looks
 * like an empty terminal is indistinguishable from a terminal that started and
 * printed nothing, and only one of those is a bug worth finding.
 */

import type { ComponentType } from "react";
import type { AppAppearance } from "../../../ipc/appShell";

/** Everything a pooled Surface renderer is given, and all it is given. */
export interface SurfaceRendererProps {
  /** The semantic key main resolved for this Surface, e.g. `agent:<id>`. */
  readonly surfaceKey: string;
  /** The label the Sidebar shows for the same subject. */
  readonly surfaceLabel: string;
  /** Terminal typography and palette, once main has projected them. */
  readonly appearance: AppAppearance | undefined;
  /**
   * False while the Surface is parked off screen. It stays mounted — that is
   * the point of the pool — so a renderer that measures itself must wait for
   * this rather than for its first mount.
   */
  readonly visible: boolean;
}

export type SurfaceRenderer = ComponentType<SurfaceRendererProps>;

const renderers = new Map<"terminal" | "agent", SurfaceRenderer>();

export function registerSurfaceRenderer(
  kind: "terminal" | "agent",
  renderer: SurfaceRenderer,
): void {
  renderers.set(kind, renderer);
}

export function surfaceRenderer(
  kind: "terminal" | "agent",
): SurfaceRenderer | undefined {
  return renderers.get(kind);
}
