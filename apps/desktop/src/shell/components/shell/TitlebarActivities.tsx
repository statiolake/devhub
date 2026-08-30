import {
  activityLabel,
  type Activity,
  type AppIntent,
  type AppSnapshot,
} from "../../../ipc/appShell";
import { disabledReasonLabel } from "./activityPresentation";

export interface TitlebarActivitiesProps {
  readonly snapshot: AppSnapshot;
  readonly onDispatch: (intent: AppIntent) => void;
}

export function TitlebarActivities({
  snapshot,
  onDispatch,
}: TitlebarActivitiesProps) {
  return (
    <header className="titlebar">
      <div className="titlebar-leading" />
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
              // A control that cannot be used has to say why where a pointer
              // is, not only where a screen reader is.
              title={
                disabled ? disabledReasonLabel(resolution.reason) : undefined
              }
              data-activity={activity satisfies Activity}
              onClick={() => onDispatch({ type: "select_activity", activity })}
            >
              {label}
            </button>
          );
        })}
      </nav>
      {/* Balances the leading cell so the Activities stay centred; the
          Sidebar already names the context they resolve against. */}
      <div className="titlebar-trailing" />
    </header>
  );
}
