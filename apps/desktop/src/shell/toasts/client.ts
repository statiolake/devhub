/**
 * The notices page's bridge. See `ToastsBridge` in `ipc/contract.ts` for what
 * is on it, and `preload/toasts.ts` for what puts it there. It is the smallest
 * bridge DevHub has: a notice is about DevHub, and nothing about DevHub's
 * model is needed to draw one.
 */

import type { ToastsBridge } from "../../ipc/contract";
import { pageBridge } from "../bridge";

export function devhub(): ToastsBridge {
  return pageBridge<ToastsBridge>("toasts");
}
