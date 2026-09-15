/**
 * The window's own page's bridge.
 *
 * One line, because there is nothing left to wrap. What this page may ask main
 * for is `ShellPageBridge` in `ipc/contract.ts`, and what actually answers it
 * is `preload/shell.ts` — the page cannot spell a member that is not on the
 * object that preload exposed, so the contract needs no second statement here.
 */

import type { ShellPageBridge } from "../ipc/contract";
import { pageBridge } from "./bridge";

export function devhub(): ShellPageBridge {
  return pageBridge<ShellPageBridge>("App Shell");
}
