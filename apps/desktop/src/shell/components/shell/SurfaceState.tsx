/**
 * What a Surface shows when it is not showing a provider.
 *
 * Every Surface uses these: a Workspace whose root went missing, an Agent that
 * could not be stopped, an Editor whose server would not start. A failure that
 * belongs to a Surface is drawn in that Surface, and drawn the same way in
 * every one of them — a reader who has seen one has seen them all.
 */
/**
 * Every non-provider state is the same shape: one line saying what is
 * happening, and — when something went wrong — the text needed to fix it.
 * Nothing restates the Workspace or the Activity, because the Sidebar and the
 * titlebar already show both.
 */
export function Waiting({ label }: { readonly label: string }) {
  return (
    <div className="surface-state" role="status">
      <span className="surface-spinner" aria-hidden="true" />
      <p className="surface-line">{label}</p>
    </div>
  );
}

export function Failure({
  summary,
  detail,
  actions,
}: {
  readonly summary: string;
  readonly detail?: string;
  readonly actions?: readonly {
    readonly label: string;
    readonly primary?: boolean;
    readonly run: () => void;
  }[];
}) {
  return (
    <div className="surface-state surface-failure" role="alert">
      <p className="failure-title">
        <svg
          className="failure-icon"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="8" cy="8" r="7" />
          <path d="M8 4.6v4.2M8 11.1v.6" />
        </svg>
        {summary}
      </p>
      {detail ? <p className="failure-detail">{detail}</p> : null}
      {actions && actions.length > 0 ? (
        <div className="surface-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              className={action.primary ? "primary-button" : "secondary-button"}
              type="button"
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
