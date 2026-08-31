import type { AgentStatus } from "../../../ipc/appShell";

const STATUS_LABELS: Record<AgentStatus, string> = {
  working: "Working",
  waiting: "Waiting",
  idle: "Idle",
  error: "Error",
  unknown: "Unknown",
};

export function statusLabel(status: AgentStatus): string {
  return STATUS_LABELS[status];
}
