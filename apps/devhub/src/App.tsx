import { ShellProvider } from "./shell/ShellProvider";
import { createTauriShellClient, type ShellClient } from "./shell/client";
import type { ShellSnapshot } from "./shell/model";
import { useShell } from "./shell/useShell";

const defaultClient = createTauriShellClient();
const ACTIVITIES = ["Editor", "Agent", "Terminal"] as const;

export interface AppProps {
  readonly shellClient?: ShellClient;
  /** Short alias kept for injected harnesses and component tests. */
  readonly client?: ShellClient;
}

/** R1.1 is a native shell; domain surfaces arrive in later waves. */
export function App({ shellClient, client }: AppProps) {
  const effectiveClient = shellClient ?? client ?? defaultClient;

  return (
    <ShellProvider client={effectiveClient}>
      <Workbench />
    </ShellProvider>
  );
}

// Descriptive alias for callers embedding the production shell directly.
export const ShellApp = App;

function Workbench() {
  const { state, retry } = useShell();

  return (
    <main className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="wordmark" data-tauri-drag-region>
          <span className="wordmark-glyph" aria-hidden="true">
            D
          </span>
          <span>DevHub</span>
        </div>
        <nav className="activity-nav" aria-label="Activities">
          {ACTIVITIES.map((activity) => (
            <button
              className="activity-button"
              disabled
              key={activity}
              type="button"
            >
              {activity}
            </button>
          ))}
        </nav>
      </header>

      <div className="workbench">
        <aside className="sidebar" aria-label="Workspace navigation">
          <p className="eyebrow">Global</p>
          <button
            className="context-button"
            disabled
            type="button"
            aria-label="Scratch"
          >
            <span className="context-glyph" aria-hidden="true">
              ⌁
            </span>
            <span>Scratch</span>
          </button>
        </aside>

        <section
          className="surface"
          aria-busy={state.status === "loading"}
          aria-live="polite"
          data-readiness={
            state.status === "ready" ? state.snapshot.readiness : undefined
          }
        >
          {state.status === "loading" && <LoadingSurface />}
          {state.status === "error" && (
            <ErrorSurface message={state.message} onRetry={retry} />
          )}
          {state.status === "ready" && (
            <ReadySurface snapshot={state.snapshot} />
          )}
        </section>
      </div>
    </main>
  );
}

function LoadingSurface() {
  return (
    <div className="state-surface">
      <span className="state-mark state-mark-loading" aria-hidden="true">
        D
      </span>
      <p className="eyebrow">Connecting</p>
      <h1>Waking the local shell</h1>
      <p className="lede">
        Reading the immutable snapshot from the native host.
      </p>
    </div>
  );
}

function ErrorSurface({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="state-surface">
      <span className="state-mark state-mark-error" aria-hidden="true">
        !
      </span>
      <p className="eyebrow eyebrow-error">Connection error</p>
      <h1>The shell is unavailable</h1>
      <p className="lede">{message}</p>
      <button className="primary-button" type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function ReadySurface({ snapshot }: { readonly snapshot: ShellSnapshot }) {
  return (
    <div
      className="ready-surface"
      data-platform={snapshot.platform}
      data-schema-version={snapshot.schemaVersion}
      data-window-label={snapshot.windowLabel}
    >
      <p className="eyebrow">{snapshot.productName}</p>
      <h1>{snapshot.productName} is ready.</h1>
      <p className="lede">
        The native shell is connected. This surface is intentionally quiet until
        its domain contracts are introduced.
      </p>
    </div>
  );
}
