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

/**
 * The Sidebar toggle, where a Mac keeps it: the leading end of the toolbar.
 *
 * It is the same command as View ▸ Collapse Sidebar and it sends the same
 * intent, so the two cannot disagree; the model is what either of them changes
 * and what both of them read back.
 */
function SidebarToggle({
  expanded,
  onDispatch,
}: {
  readonly expanded: boolean;
  readonly onDispatch: (intent: AppIntent) => void;
}) {
  const label = expanded ? "Collapse Sidebar" : "Expand Sidebar";
  return (
    <button
      className="titlebar-button sidebar-toggle"
      type="button"
      aria-label={label}
      aria-pressed={expanded}
      title={label}
      onClick={() => {
        onDispatch({ type: "set_sidebar_expanded", expanded: !expanded });
      }}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2" />
        <path d="M6.25 3.25v9.5" />
        {/* The pane, filled while it is open: the icon says which of the two
            states you are in, not only that a Sidebar exists. */}
        {expanded && (
          <path className="sidebar-toggle-pane" d="M3.75 3.25h2.5v9.5h-2.5z" />
        )}
      </svg>
    </button>
  );
}

export function TitlebarActivities({
  snapshot,
  onDispatch,
}: TitlebarActivitiesProps) {
  const expanded = snapshot.sidebar.expanded;
  return (
    <header className="titlebar">
      {/* Collapsed, the Sidebar is narrower than the window buttons are wide,
          so the leading cell is what keeps the toggle clear of them. */}
      <div
        className="titlebar-leading"
        data-clears-window-buttons={expanded ? undefined : "true"}
      >
        <SidebarToggle expanded={expanded} onDispatch={onDispatch} />
      </div>
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
