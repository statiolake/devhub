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
 *   able to say no. It is the only one, and it is a picker, because every
 *   question in DevHub is (see `Picker`'s docstring): two answers, two rows,
 *   the one that changes nothing first.
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
import { useAlertLifetime } from "../shell/alertLifetime";
import { Picker } from "../shell/components/shell/Picker";
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

/**
 * What makes two refusals the same refusal.
 *
 * Everything the window would print: a save that keeps being refused for the
 * same reason about the same field is one refusal being re-raised, and one
 * about a different field is news. `errorMessage` is what a person reads, so
 * what it distinguishes is what "the same" has to mean.
 */
function settingsErrorIdentity(error: SettingsError): string {
  const diagnostic = error.diagnostic;
  return [
    error.code,
    diagnostic?.code ?? "",
    diagnostic?.path ?? "",
    diagnostic?.line ?? "",
    diagnostic?.column ?? "",
  ].join("\u0000");
}

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
  /** What the socket change costs, on the row that costs it. */
  readonly consequence: string;
} {
  const name = preflight.requestedSocketName;
  const restarted =
    "Your current sessions are closed and recreated there, so what is running in them stops.";
  switch (preflight.state) {
    case "target_absent":
      return {
        title: `Move DevHub's terminals to “${name}”?`,
        message: "No tmux server is running there yet.",
        confirm: "Move the terminals",
        consequence: restarted,
      };
    case "target_devhub_empty":
      return {
        title: `Move DevHub's terminals to “${name}”?`,
        message: "A DevHub tmux server is already there with no sessions.",
        confirm: "Move the terminals",
        consequence: restarted,
      };
    case "marked_sessions":
      return {
        title: `Adopt the DevHub sessions on “${name}”?`,
        message: `That socket already has ${String(preflight.ownedSessionCount)} DevHub ${preflight.ownedSessionCount === 1 ? "session" : "sessions"} from another run.`,
        confirm: "Adopt them",
        consequence:
          "DevHub takes them over, and the sessions on the current socket are closed.",
      };
    case "wrong_marker":
      return {
        title: `“${name}” belongs to another tmux server.`,
        message: `There ${preflight.unknownSessionCount === 1 ? "is" : "are"} ${String(preflight.unknownSessionCount)} ${preflight.unknownSessionCount === 1 ? "session" : "sessions"} there that DevHub did not create. Choose a socket name of its own.`,
        confirm: "Move there anyway",
        consequence:
          "DevHub will not touch the sessions it did not create. Your current sessions are closed and recreated there.",
      };
    case "not_checked":
      return {
        title: `Move DevHub's terminals to “${name}”?`,
        message: "DevHub could not see what is on that socket.",
        confirm: "Move the terminals",
        consequence:
          "Your current sessions are closed, and DevHub tries to recreate them there.",
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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  // The socket is asked for, not typed into effect: `socketDraft` is the
  // request, the snapshot is what DevHub is actually on, and the sheet is the
  // only thing that closes the gap between them.
  const [socketDraft, setSocketDraft] = useState<string>();
  const [socketSheet, setSocketSheet] = useState<SettingsSocketPreflightWire>();

  /**
   * The refusal on screen, under the rule every DevHub window uses.
   *
   * It used to be a plain `useState` that any arriving snapshot could wipe, so
   * a push caused by something else entirely erased the refusal the person was
   * reading. Now the only three things that retire it are the ones in
   * `useAlertLifetime`: dismissed, superseded by a *different* refusal, or the
   * person started another action.
   */
  const {
    alert: error,
    raise: raiseError,
    clear: clearError,
    dismiss: dismissError,
  } = useAlertLifetime<SettingsError>(settingsErrorIdentity);

  const generation = useRef(0);
  const lastSequence = useRef(0);
  const saveTimer = useRef<number | undefined>(undefined);
  /**
   * Whether this window is holding changes DevHub has not taken.
   *
   * Counted rather than flagged, because a save is asynchronous: it captures
   * the count it is saving and settles the edits only if the person has not
   * typed since. Otherwise a save landing mid-sentence would declare the
   * window clean and let the next push overwrite the rest of the word.
   */
  const edits = useRef(0);
  const settledEdits = useRef(0);

  /**
   * The person started something.
   *
   * The two things that always go with an action, in one place: the refusal on
   * screen is retired (that is the App Shell's rule, and it is this window's
   * too), and a debounced save still waiting to fire is cancelled, because
   * every action here either supersedes that save or is answered by a snapshot
   * the save would land behind.
   */
  const act = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    clearError();
  }, [clearError]);

  /**
   * Take an answer only if it is still the one being waited for.
   *
   * The single staleness rule this window has. It used to be nineteen
   * hand-written `generation.current === current` guards in three spellings,
   * which is the shape `focusHome.ts` warns about: a rule enforced call site by
   * call site is a rule the next call site forgets.
   *
   * It owns all three of them: the window generation, the wait, and — through
   * `act()` — the debounce timer. A refused request becomes the alert here and
   * nowhere else. Resolves `undefined` when there is no answer to take, either
   * because the window moved on or because the request was refused; an answer
   * is wrapped so that a request answering with nothing (`Promise<void>`) is
   * still distinguishable from no answer at all.
   */
  const latest = useCallback(
    async <T,>(
      work: Promise<T>,
    ): Promise<{ readonly value: T } | undefined> => {
      const mine = generation.current;
      setBusy(true);
      try {
        const value = await work;
        return generation.current === mine ? { value } : undefined;
      } catch (value: unknown) {
        if (generation.current === mine) {
          raiseError(parseSettingsTransportError(value));
        }
        return undefined;
      } finally {
        if (generation.current === mine) setBusy(false);
      }
    },
    [raiseError],
  );

  /**
   * The one rule for what an arriving snapshot changes.
   *
   * A snapshot newer than the last one taken becomes what DevHub is on. It
   * becomes what is *shown* as well — unless the person is part-way through an
   * edit, in which case the fields they are typing in are theirs until the
   * edit is saved or reset. A push is DevHub saying what it has; it is never
   * DevHub taking the keyboard away.
   */
  const adopt = useCallback((next: SettingsSnapshot) => {
    if (next.sequence < lastSequence.current) return;
    lastSequence.current = next.sequence;
    setSnapshot(next);
    if (edits.current !== settledEdits.current) return;
    setDraft(clone(next.config));
    setSocketDraft(next.config.runtimes.tmuxSocketName);
  }, []);

  /** DevHub has taken everything typed up to `count`. */
  const settle = useCallback((count: number) => {
    settledEdits.current = count;
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    const live = () => generation.current === current;
    const unsubscribe = transport.subscribe((next) => {
      if (live()) adopt(next);
    });
    void latestSnapshot();
    async function latestSnapshot() {
      const answer = await latest(transport.getSnapshot());
      if (answer) adopt(answer.value);
    }
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [adopt, latest, transport]);

  /**
   * A change is applied, not staged.
   *
   * A preferences window has no document, so it has no Save. The write is
   * debounced only so that a burst of changes is one write rather than one per
   * change — and a write that fails says so, in place, without discarding what
   * the person typed.
   */
  const update = (next: SettingsConfig) => {
    edits.current += 1;
    setDraft(next);
    if (!snapshot) return;
    act();
    saveTimer.current = window.setTimeout(() => {
      const saving = edits.current;
      void (async () => {
        const answer = await latest(
          transport.save({
            schemaVersion: SETTINGS_SCHEMA_VERSION,
            revision: snapshot.revision,
            config: next,
          }),
        );
        if (!answer) return;
        // Only what was actually sent is settled: anything typed while the
        // save was in flight is still the person's.
        settle(saving);
        adopt(answer.value);
      })();
    }, 400);
  };

  /**
   * The socket name is typed like any other field, and is an edit like any
   * other: a push that arrived while it was being typed must not take the
   * keyboard away here either.
   */
  const editSocketDraft = (next: string) => {
    edits.current += 1;
    setSocketDraft(next);
  };

  /** Edits the person has explicitly asked DevHub to replace. */
  const discardEdits = () => {
    settle(edits.current);
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
    act();
    void (async () => {
      const answer = await latest(
        transport.resetScope({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          revision: snapshot.revision,
          keys: SECTION_SCOPE[section],
        }),
      );
      if (!answer) return;
      discardEdits();
      adopt(answer.value);
    })();
  };

  const reload = () => {
    act();
    void (async () => {
      const answer = await latest(transport.reload());
      if (!answer) return;
      discardEdits();
      adopt(answer.value);
    })();
  };

  const recheck = () => {
    act();
    void (async () => {
      const answer = await latest(transport.recheck());
      if (answer) adopt(answer.value);
    })();
  };

  const askToChangeSocket = () => {
    const requested = socketDraft?.trim();
    if (!requested) return;
    act();
    void (async () => {
      const answer = await latest(transport.socketPreflight(requested));
      if (answer) setSocketSheet(answer.value);
    })();
  };

  const applySocketChange = (requested: string) => {
    setSocketSheet(undefined);
    act();
    void (async () => {
      const answer = await latest(transport.socketApply(requested));
      if (!answer) return;
      discardEdits();
      adopt(answer.value);
    })();
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
          {/* A refusal is the person's to put away — the third of the three
              gestures that retire one, and the only one that works when the
              same refusal keeps being raised. The file diagnostic beside it is
              not a refusal but a fact about the file, so it goes when the file
              is read again and not before. */}
          {error ? (
            <button type="button" className="mac-button" onClick={dismissError}>
              Dismiss
            </button>
          ) : null}
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
            onSocketDraft={editSocketDraft}
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
              act();
              setStatus("Opening…");
              void latest(transport.openLogFolder()).finally(() => {
                setStatus(undefined);
              });
            }}
            onCopyDiagnostics={() => {
              act();
              void latest(transport.copyDiagnostics()).then((answer) => {
                setStatus(answer ? "Copied." : undefined);
              });
            }}
            status={status}
            busy={busy}
          />
        ) : null}
      </div>

      {socketSheet ? (
        <SocketChangeSheet
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

/** The safe row, and therefore the first one. */
const KEEP_SOCKET = "devhub:keep-socket";
const CHANGE_SOCKET = "devhub:change-socket";

/**
 * The one question this window asks, asked the way DevHub asks questions.
 *
 * It was an alert with two buttons and the destructive one under Return. A
 * confirmation is a list with as many rows as there are answers and the safe
 * one first, so "Keep the current socket" leads and is what Return takes, and
 * the consequence is written on the row that causes it rather than in a
 * paragraph above both of them.
 */
function SocketChangeSheet({
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
    <Picker
      title={question.title}
      question={question.message}
      items={[
        {
          id: KEEP_SOCKET,
          label: "Keep the current socket",
          detail: "DevHub stays on the socket it is on. Nothing is closed.",
        },
        {
          id: CHANGE_SOCKET,
          label: question.confirm,
          detail: question.consequence,
        },
      ]}
      note={
        <ul className="mac-detail-list">
          <li>
            <span>DevHub sessions there</span>
            <span>{String(preflight.ownedSessionCount)}</span>
          </li>
          <li>
            <span>Other sessions there</span>
            <span>{String(preflight.unknownSessionCount)}</span>
          </li>
        </ul>
      }
      onChoose={({ id }) => {
        if (id === CHANGE_SOCKET) onConfirm();
        else onCancel();
      }}
      onCancel={onCancel}
    />
  );
}
