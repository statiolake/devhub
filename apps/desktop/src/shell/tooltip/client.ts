/**
 * The tooltip page's bridge. See `TooltipBridge` in `ipc/contract.ts` for what
 * is on it, and `preload/tooltip.ts` for what puts it there. It is the
 * smallest bridge DevHub has — smaller than the notices' — because a tooltip
 * is a sentence somebody else composed and this page only has to draw it.
 */

import type { TooltipBridge } from "../../ipc/contract";
import { pageBridge } from "../bridge";

export function devhub(): TooltipBridge {
  return pageBridge<TooltipBridge>("tooltip");
}
