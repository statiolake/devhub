import type { AgentStatus } from "../../../ipc/appShell";

const STATUS_META: Record<
  AgentStatus,
  { readonly symbol: string; readonly label: string }
> = {
  working: { symbol: "●", label: "Working" },
  waiting: { symbol: "◌", label: "Waiting" },
  idle: { symbol: "○", label: "Idle" },
  error: { symbol: "!", label: "Error" },
};

export interface StatusMarkProps {
  readonly status: AgentStatus;
  readonly compact?: boolean;
}

export function StatusMark({ status, compact = false }: StatusMarkProps) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`status-mark status-mark-${status}${compact ? " status-mark-compact" : ""}`}
      title={meta.label}
      aria-label={meta.label}
      role="img"
    >
      <span aria-hidden="true">{meta.symbol}</span>
      {!compact && <span className="status-mark-label">{meta.label}</span>}
    </span>
  );
}
