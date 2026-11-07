/**
 * The Neovim editor page's bridge. See `NeovimBridge` in `ipc/contract.ts`
 * for what is on it, and `preload/neovim.ts` for what puts it there.
 */

import type { NeovimBridge } from "../../ipc/contract";
import { pageBridge } from "../bridge";

export function devhub(): NeovimBridge {
  return pageBridge<NeovimBridge>("neovim");
}
