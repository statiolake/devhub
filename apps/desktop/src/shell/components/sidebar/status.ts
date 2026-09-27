import type { AgentStatus } from "../../../ipc/appShell";

const STATUS_LABELS: Record<AgentStatus, string> = {
  working: "Working",
  background: "Background",
  waiting: "Waiting",
  idle: "Idle",
  error: "Error",
  unknown: "Unknown",
};

export function statusLabel(status: AgentStatus): string {
  return STATUS_LABELS[status];
}
