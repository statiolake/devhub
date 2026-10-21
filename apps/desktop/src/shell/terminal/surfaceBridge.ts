/**
 * The part of a page's bridge a terminal surface reads.
 *
 * Two pages draw terminals — the Agents, and every terminal pane — and a
 * surface must reach neither page's own bridge: a page's graph reaching
 * another page's `client.ts` is a page spelling members its preload never
 * exposed (`preload/pageContracts.test.ts`). Both preloads expose this
 * fragment (`TerminalSurfaceBridge` in `ipc/contract.ts`), so this is what the
 * surface asks for, by its own name.
 */

import type { TerminalSurfaceBridge } from "../../ipc/contract";
import { pageBridge } from "../bridge";

export function surfaceBridge(): TerminalSurfaceBridge {
  return pageBridge<TerminalSurfaceBridge>("terminal surface");
}
