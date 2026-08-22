import type { AgentStatus } from "../../generated/app-shell";

const STATUS_LABELS: Record<AgentStatus, string> = {
  working: "Working",
  waiting: "Waiting",
  idle: "Idle",
  error: "Error",
};

export function statusLabel(status: AgentStatus): string {
  return STATUS_LABELS[status];
}
