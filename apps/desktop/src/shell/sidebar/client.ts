/**
 * The Sidebar page's bridge. See `SidebarBridge` in `ipc/contract.ts` for what
 * is on it, and `preload/sidebar.ts` for what puts it there.
 */

import type { SidebarBridge } from "../../ipc/contract";
import { pageBridge } from "../bridge";

export function devhub(): SidebarBridge {
  return pageBridge<SidebarBridge>("sidebar");
}
