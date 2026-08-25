import {
  activityLabel,
  type Activity,
  type AppIntent,
  type AppSnapshot,
  workspaceForContext,
} from "../../generated/app-shell";
import { disabledReasonLabel } from "./activityPresentation";

export interface TitlebarActivitiesProps {
  readonly snapshot: AppSnapshot;
  readonly onDispatch: (intent: AppIntent) => void;
}

/** The trailing chip names the Navigation Context the Activities resolve against. */
function contextLabel(snapshot: AppSnapshot): string {
  const context = snapshot.selection.context;
  if (context.kind === "global") return "Scratch";
  const workspace = workspaceForContext(snapshot, context);
  if (!workspace) return "";
  if (context.kind === "workspace") return workspace.label;
  const agent = workspace.agents.find(
    (candidate) => candidate.id === context.agentId,
  );
  return agent ? `${agent.displayName} — ${workspace.label}` : workspace.label;
}

export function TitlebarActivities({
  snapshot,
  onDispatch,
}: TitlebarActivitiesProps) {
  const context = contextLabel(snapshot);
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-leading" data-tauri-drag-region />
      <nav className="activity-segments" aria-label="Activities">
        {snapshot.activities.map(({ activity, resolution }) => {
          const selected = snapshot.selection.activity === activity;
          const label = activityLabel(activity);
          const disabled = resolution.kind === "disabled";
          const reason = disabled
            ? ` (${disabledReasonLabel(resolution.reason)})`
            : "";
          return (
            <button
              className="activity-segment"
              key={activity}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              aria-label={`${label}${disabled ? `${reason}, unavailable` : ""}`}
              data-activity={activity satisfies Activity}
              onClick={() => onDispatch({ type: "select_activity", activity })}
            >
              {label}
            </button>
          );
        })}
      </nav>
      <div className="titlebar-trailing" data-tauri-drag-region>
        {context ? (
          <span className="titlebar-context" title={context}>
            {context}
          </span>
        ) : null}
      </div>
    </header>
  );
}
