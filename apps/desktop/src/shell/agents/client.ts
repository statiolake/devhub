/**
 * The Agents page's bridge. See `AgentsBridge` in `ipc/contract.ts` for what
 * is on it, and `preload/agents.ts` for what puts it there.
 */

import type { AgentsBridge } from "../../ipc/contract";
import { pageBridge } from "../bridge";

export function devhub(): AgentsBridge {
  return pageBridge<AgentsBridge>("agents");
}
