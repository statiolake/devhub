import {
  activityLabel,
  type Activity,
  type AppIntent,
  type AppSnapshot,
} from "../../generated/app-shell";

export interface TitlebarActivitiesProps {
  readonly snapshot: AppSnapshot;
  readonly onDispatch: (intent: AppIntent) => void;
}

export function TitlebarActivities({
  snapshot,
  onDispatch,
}: TitlebarActivitiesProps) {
  return (
    <header className="titlebar" data-tauri-drag-region>
      <nav className="activity-nav" aria-label="Activities">
        {snapshot.activities.map(({ activity, resolution }) => {
          const selected = snapshot.selection.activity === activity;
          const label = activityLabel(activity);
          const disabled = resolution.kind === "disabled";
          const reason = disabled
            ? ` (${resolution.reason.replaceAll("-", " ")})`
            : "";
          return (
            <button
              className={`activity-button${selected ? " is-selected" : ""}`}
              key={activity}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              aria-label={`${label}${disabled ? `${reason}, unavailable` : ""}`}
              data-activity={activity satisfies Activity}
              onClick={() => onDispatch({ type: "select_activity", activity })}
            >
              <span className="activity-button-label">{label}</span>
            </button>
          );
        })}
      </nav>
    </header>
  );
}
