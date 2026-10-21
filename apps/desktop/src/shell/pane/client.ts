/**
 * A terminal pane's bridge. See `PaneBridge` in `ipc/contract.ts` for what is
 * on it, and `preload/pane.ts` for what puts it there.
 */

import type { PaneBridge } from "../../ipc/contract";
import { pageBridge } from "../bridge";

export function devhub(): PaneBridge {
  return pageBridge<PaneBridge>("pane");
}
