import type { DisabledReasonWire } from "../../generated/app-shell";

/** Product copy for Rust-owned disabled reasons; wire codes never reach UI. */
export const disabledReasonCopy: Readonly<Record<DisabledReasonWire, string>> =
  {
    "global-agent-not-applicable":
      "Select an Agent to open its control surface.",
    "workspace-agent-requires-agent-selection":
      "Select an Agent to open its control surface.",
    "workspace-unavailable": "This workspace is unavailable.",
    "workspace-closing": "This workspace is closing.",
    "workspace-closing-failed":
      "This workspace could not close cleanly. Retry close to continue.",
  };

export function disabledReasonLabel(reason: DisabledReasonWire): string {
  return disabledReasonCopy[reason];
}
