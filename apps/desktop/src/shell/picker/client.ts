/**
 * The questions page's bridge. See `PickerBridge` in `ipc/contract.ts` for
 * what is on it, and `preload/picker.ts` for what puts it there. It is the one
 * bridge in DevHub with `onModals` on it.
 */

import type { PickerBridge } from "../../ipc/contract";
import { pageBridge } from "../bridge";

export function devhub(): PickerBridge {
  return pageBridge<PickerBridge>("picker");
}
