/**
 * Settings, shaped like a macOS preferences window.
 *
 * A toolbar of sections across the title bar, and one screen under it. There is
 * no draft banner and no Save button: a preferences window on a Mac does not
 * have a document to save, so a change is applied when you make it, and the
 * only thing that can go wrong — the file changed underneath you — is said once,
 * at the top, where it happened.
 *
 * What is a screen and what is a sheet:
 *
 * - Every value is edited on a screen, in place. Values do not deserve a modal.
 * - The one thing in this window that is a decision rather than a value — moving
 *   DevHub's terminal sessions to another tmux socket — is a sheet, because it
 *   is a question with consequences and an answer, and the person has to be
 *   able to say no. It is the only one.
 *
 * Keyboard: the section toolbar is a tab list, so the arrows move between
 * sections; a collection's list is a list box, so the arrows move between
 * entries; everything else is reached with Tab. **No shortcut is claimed here.**
 * Accelerators live in the menu bar and nowhere else (`main/shell/menu.ts`), so
 * Close Settings is File ▸ Close Settings and nothing on this page competes for
 * a key with whatever is focused.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  SETTINGS_SCHEMA_VERSION,
  type SettingsConfig,
  type SettingsError,
  type SettingsScopeKeyWire,
  type SettingsSnapshot,
  type SettingsSocketPreflightWire,
} from "../ipc/settings";
import { Alert } from "../shell/components/shell/Alert";
import {
  createSettingsClient,
  parseSettingsTransportError,
  type SettingsClient,
} from "./client";
import { errorMessage, fileDiagnosticMessage } from "./errorMessage";
import {
  AdvancedSection,
  ActionsSection,
  AgentsSection,
  GeneralSection,
  KeyboardSection,
  TerminalSection,
  WorkspacesSection,
} from "./sections";
import "../shell/styles/tokens.css";
import "../shell/styles/macos.css";
import "./settings.css";

/**
 * The sections, in the order they are shown.
 *
 * Ordered the way a Mac orders panes: what applies to the whole app first, the
 * two collections next (in the order they appear in the sidebar), the surface
 * after them, and Advanced last.
 */
const SECTIONS = [
  "General",
  "Workspaces",
  "Agents",
  "Actions",
  "Keyboard",
  "Terminal",
  "Advanced",
] as const;

type Section = (typeof SECTIONS)[number];

/**
 * Which part of the configuration each screen owns, for "reset this screen".
 *
 * One table, so no screen gets to decide for itself what resetting it means —
 * and so a new screen is a row here rather than a method somewhere. The socket
 * is on the Terminal screen but lives under `runtimes`, which is Advanced's:
 * that is deliberate, because resetting a font must not move DevHub's terminal
 * sessions to another socket underneath it.
 */
const SECTION_SCOPE: Readonly<
  Record<Section, readonly SettingsScopeKeyWire[]>
> = {
  General: ["general"],
  Workspaces: ["workspaceSources"],
  Agents: ["agentProfiles"],
  Actions: ["agentActions"],
  Keyboard: ["keybindings"],
  Terminal: ["appearance"],
  Advanced: ["runtimes"],
};

const clone = (config: SettingsConfig): SettingsConfig =>
  JSON.parse(JSON.stringify(config)) as SettingsConfig;

// ------------------------------------------------------------------ toolbar

const SECTION_GLYPHS: Readonly<Record<Section, ReactNode>> = {
  General: (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.4v2.2M10 15.4v2.2M2.4 10h2.2M15.4 10h2.2M4.6 4.6l1.6 1.6M13.8 13.8l1.6 1.6M15.4 4.6l-1.6 1.6M6.2 13.8l-1.6 1.6" />
    </svg>
  ),
  Workspaces: (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M2.4 5.6a1.4 1.4 0 0 1 1.4-1.4h3.7l1.8 2h6.7a1.4 1.4 0 0 1 1.4 1.4v7a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4z" />
    </svg>
  ),
  Agents: (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="3.4" y="5.6" width="13.2" height="10" rx="2.4" />
      <circle cx="7.6" cy="10.6" r="1" />
      <circle cx="12.4" cy="10.6" r="1" />
      <path d="M10 2.6v3" />
    </svg>
  ),
  Actions: (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M10.8 2.4 4.2 11.4h4.2l-1.2 6.2 6.6-9h-4.2z" />
    </svg>
  ),
  Keyboard: (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="2.2" y="5.4" width="15.6" height="9.2" rx="1.8" />
      <path d="M5.4 8.4h.01M8 8.4h.01M10.6 8.4h.01M13.2 8.4h.01M6.6 11.6h6.8" />
    </svg>
  ),
  Terminal: (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="2.6" y="4" width="14.8" height="12" rx="2" />
      <path d="M5.8 8.4 8.2 10.6l-2.4 2.2M10.4 13h4" />
    </svg>
  ),
  Advanced: (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M3 6.2h14M3 13.8h14" />
      <circle cx="7.6" cy="6.2" r="2" />
      <circle cx="12.8" cy="13.8" r="2" />
    </svg>
  ),
};

function Toolbar({
  section,
  onSelect,
}: {
  readonly section: Section;
  readonly onSelect: (next: Section) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);

  // Roving tabindex plus arrows, which is what a tab list is on a Mac: Tab gets
  // you to the toolbar, the arrows choose within it.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const at = SECTIONS.indexOf(section);
    const last = SECTIONS.length - 1;
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? Math.min(at + 1, last)
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? Math.max(at - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onSelect(SECTIONS[next]);
    strip.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <header className="settings-toolbar">
      <div
        className="settings-tabs"
        role="tablist"
        aria-label="Settings sections"
        ref={strip}
        onKeyDown={onKeyDown}
      >
        {SECTIONS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            id={`settings-tab-${item}`}
            aria-controls="settings-panel"
            aria-selected={section === item}
            tabIndex={section === item ? 0 : -1}
            className={`settings-tab${section === item ? " is-selected" : ""}`}
            onClick={() => {
              onSelect(item);
            }}
          >
            <span className="settings-tab-glyph">{SECTION_GLYPHS[item]}</span>
            <span>{item}</span>
          </button>
        ))}
      </div>
    </header>
  );
}

/**
 * The question a socket change has to ask, in the words of the situation.
 *
 * Four situations, four answers, and the title always says what will happen to
 * the sessions — that is the consequence, and it is the only thing the person
 * is actually deciding about.
 */
function socketQuestion(preflight: SettingsSocketPreflightWire): {
  readonly title: string;
  readonly message: string;
  readonly confirm: string;
  readonly destructive: boolean;
} {
  const name = preflight.requestedSocketName;
  switch (preflight.state) {
    case "target_absent":
      return {
        title: `Move DevHub's terminals to “${name}”?`,
        message:
          "No tmux server is running there yet. Your current DevHub sessions will be closed and recreated on the new socket, so what is running in them will stop.",
        confirm: "Move",
        destructive: true,
      };
    case "target_devhub_empty":
      return {
        title: `Move DevHub's terminals to “${name}”?`,
        message:
          "A DevHub tmux server is already there with no sessions. Your current sessions will be closed and recreated on it, so what is running in them will stop.",
        confirm: "Move",
        destructive: true,
      };
    case "marked_sessions":
      return {
        title: `Adopt the DevHub sessions on “${name}”?`,
        message: `That socket already has ${String(preflight.ownedSessionCount)} DevHub ${preflight.ownedSessionCount === 1 ? "session" : "sessions"} from another run. DevHub will take them over, and the sessions on the current socket will be closed.`,
        confirm: "Adopt",
        destructive: true,
      };
    case "wrong_marker":
      return {
        title: `“${name}” belongs to another tmux server.`,
        message: `There ${preflight.unknownSessionCount === 1 ? "is" : "are"} ${String(preflight.unknownSessionCount)} ${preflight.unknownSessionCount === 1 ? "session" : "sessions"} there that DevHub did not create. DevHub will not touch them. Choose a socket name of its own.`,
        confirm: "Move Anyway",
        destructive: true,
      };
    case "not_checked":
      return {
        title: `Move DevHub's terminals to “${name}”?`,
        message:
          "DevHub could not see what is on that socket. Moving will close your current sessions and try to recreate them there.",
        confirm: "Move",
        destructive: true,
      };
  }
}

// -------------------------------------------------------------------- app

export function SettingsApp({ client }: { readonly client?: SettingsClient }) {
  const transportRef = useRef<SettingsClient>(null);
  transportRef.current ??= client ?? createSettingsClient();
  const transport = transportRef.current;

  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [draft, setDraft] = useState<SettingsConfig>();
  const [section, setSection] = useState<Section>("General");
  const [error, setError] = useState<SettingsError>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  // The socket is asked for, not typed into effect: `socketDraft` is the
  // request, the snapshot is what DevHub is actually on, and the sheet is the
  // only thing that closes the gap between them.
  const [socketDraft, setSocketDraft] = useState<string>();
  const [socketSheet, setSocketSheet] = useState<SettingsSocketPreflightWire>();
  const generation = useRef(0);
  const lastSequence = useRef(0);
  const saveTimer = useRef<number | undefined>(undefined);

  const adopt = useCallback((next: SettingsSnapshot) => {
    if (next.sequence < lastSequence.current) return;
    lastSequence.current = next.sequence;
    setSnapshot(next);
    setDraft(clone(next.config));
    setSocketDraft(next.config.runtimes.tmuxSocketName);
    setError(undefined);
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    const live = () => generation.current === current;
    const unsubscribe = transport.subscribe((next) => {
      if (live()) adopt(next);
    });
    void transport.getSnapshot().then(
      (next) => {
        if (live()) adopt(next);
      },
      (value: unknown) => {
        if (live()) setError(parseSettingsTransportError(value));
      },
    );
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [adopt, transport]);

  /**
   * A change is applied, not staged.
   *
   * A preferences window has no document, so it has no Save. The write is
   * debounced only so that a burst of changes is one write rather than one per
   * change — and a write that fails says so, in place, without discarding what
   * the person typed.
   */
  const update = (next: SettingsConfig) => {
    setDraft(next);
    if (!snapshot) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const current = generation.current;
      setBusy(true);
      void transport
        .save({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          revision: snapshot.revision,
          config: next,
        })
        .then(
          (saved) => {
            if (generation.current !== current) return;
            if (saved.sequence >= lastSequence.current) {
              lastSequence.current = saved.sequence;
              setSnapshot(saved);
            }
            setError(undefined);
          },
          (value: unknown) => {
            if (generation.current === current) {
              setError(parseSettingsTransportError(value));
            }
          },
        )
        .finally(() => {
          if (generation.current === current) setBusy(false);
        });
    }, 400);
  };

  /**
   * Put the screen that is showing back to DevHub's defaults.
   *
   * Not an `update()` with defaults in it: the defaults are the model's, and
   * this page holds a wire snapshot rather than a `Config`. So the page says
   * which keys and gets a whole snapshot back.
   */
  const resetSection = () => {
    if (!snapshot) return;
    const current = generation.current;
    setBusy(true);
    // A pending debounce would land after this and put back exactly what was
    // just removed.
    window.clearTimeout(saveTimer.current);
    void transport
      .resetScope({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        revision: snapshot.revision,
        keys: SECTION_SCOPE[section],
      })
      .then(
        (next) => {
          if (generation.current === current) adopt(next);
        },
        (value: unknown) => {
          if (generation.current === current) {
            setError(parseSettingsTransportError(value));
          }
        },
      )
      .finally(() => {
        if (generation.current === current) setBusy(false);
      });
  };

  const reload = () => {
    const current = generation.current;
    setBusy(true);
    void transport
      .reload()
      .then(
        (next) => {
          if (generation.current === current) adopt(next);
        },
        (value: unknown) => {
          if (generation.current === current) {
            setError(parseSettingsTransportError(value));
          }
        },
      )
      .finally(() => {
        if (generation.current === current) setBusy(false);
      });
  };

  const recheck = () => {
    const current = generation.current;
    setBusy(true);
    void transport
      .recheck()
      .then(
        (next) => {
          if (
            generation.current === current &&
            next.sequence >= lastSequence.current
          ) {
            lastSequence.current = next.sequence;
            setSnapshot(next);
          }
        },
        (value: unknown) => {
          if (generation.current === current) {
            setError(parseSettingsTransportError(value));
          }
        },
      )
      .finally(() => {
        if (generation.current === current) setBusy(false);
      });
  };

  const askToChangeSocket = () => {
    const requested = socketDraft?.trim();
    if (!requested) return;
    const current = generation.current;
    setBusy(true);
    void transport
      .socketPreflight(requested)
      .then(
        (preflight) => {
          if (generation.current === current) setSocketSheet(preflight);
        },
        (value: unknown) => {
          if (generation.current === current) {
            setError(parseSettingsTransportError(value));
          }
        },
      )
      .finally(() => {
        if (generation.current === current) setBusy(false);
      });
  };

  const applySocketChange = (requested: string) => {
    const current = generation.current;
    setSocketSheet(undefined);
    setBusy(true);
    void transport
      .socketApply(requested)
      .then(
        (next) => {
          if (generation.current === current) adopt(next);
        },
        (value: unknown) => {
          if (generation.current === current) {
            setError(parseSettingsTransportError(value));
          }
        },
      )
      .finally(() => {
        if (generation.current === current) setBusy(false);
      });
  };

  if (!snapshot || !draft) {
    return (
      <main className="mac settings-loading" aria-live="polite">
        {error ? (
          <p className="mac-message">{errorMessage(error)}</p>
        ) : (
          <span className="mac-spinner" aria-label="Loading settings" />
        )}
      </main>
    );
  }

  return (
    <main className="mac settings-window">
      <Toolbar section={section} onSelect={setSection} />

      {error || snapshot.diagnostic ? (
        <div className="settings-notice" role="alert">
          <span>
            {error
              ? errorMessage(error)
              : snapshot.diagnostic
                ? fileDiagnosticMessage(snapshot.diagnostic)
                : ""}
          </span>
          <button type="button" className="mac-button" onClick={reload}>
            Reload
          </button>
        </div>
      ) : null}

      <div
        className="settings-body"
        role="tabpanel"
        id="settings-panel"
        aria-labelledby={`settings-tab-${section}`}
      >
        {section === "General" ? (
          <GeneralSection
            config={draft}
            update={update}
            onReset={resetSection}
            runtime={snapshot.runtime}
          />
        ) : null}
        {section === "Workspaces" ? (
          <WorkspacesSection
            config={draft}
            update={update}
            onReset={resetSection}
          />
        ) : null}
        {section === "Agents" ? (
          <AgentsSection
            config={draft}
            update={update}
            onReset={resetSection}
          />
        ) : null}
        {section === "Actions" ? (
          <ActionsSection
            config={draft}
            update={update}
            onReset={resetSection}
          />
        ) : null}
        {section === "Keyboard" ? (
          <KeyboardSection
            config={draft}
            update={update}
            onReset={resetSection}
          />
        ) : null}
        {section === "Terminal" ? (
          <TerminalSection
            config={draft}
            update={update}
            onReset={resetSection}
            socketDraft={socketDraft ?? draft.runtimes.tmuxSocketName}
            onSocketDraft={setSocketDraft}
            onSocketChange={askToChangeSocket}
            effectiveSocket={snapshot.config.runtimes.tmuxSocketName}
            busy={busy}
          />
        ) : null}
        {section === "Advanced" ? (
          <AdvancedSection
            config={draft}
            update={update}
            onReset={resetSection}
            runtime={snapshot.runtime}
            diagnostics={snapshot.diagnostics}
            onRecheck={recheck}
            onOpenLogs={() => {
              setStatus("Opening…");
              void transport.openLogFolder().then(
                () => {
                  setStatus(undefined);
                },
                (value: unknown) => {
                  setError(parseSettingsTransportError(value));
                  setStatus(undefined);
                },
              );
            }}
            onCopyDiagnostics={() => {
              void transport.copyDiagnostics().then(
                () => {
                  setStatus("Copied.");
                },
                (value: unknown) => {
                  setError(parseSettingsTransportError(value));
                  setStatus(undefined);
                },
              );
            }}
            status={status}
            busy={busy}
          />
        ) : null}
      </div>

      {socketSheet ? (
        <SocketChangeAlert
          preflight={socketSheet}
          onCancel={() => {
            setSocketSheet(undefined);
          }}
          onConfirm={() => {
            applySocketChange(socketSheet.requestedSocketName);
          }}
        />
      ) : null}
    </main>
  );
}

function SocketChangeAlert({
  preflight,
  onCancel,
  onConfirm,
}: {
  readonly preflight: SettingsSocketPreflightWire;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const question = socketQuestion(preflight);
  return (
    <Alert
      title={question.title}
      message={question.message}
      tone="danger"
      detail={[
        ["DevHub sessions there", String(preflight.ownedSessionCount)],
        ["Other sessions there", String(preflight.unknownSessionCount)],
      ]}
      onCancel={onCancel}
      actions={[
        { label: "Cancel", run: onCancel },
        {
          label: question.confirm,
          destructive: question.destructive,
          isDefault: true,
          run: onConfirm,
        },
      ]}
    />
  );
}
