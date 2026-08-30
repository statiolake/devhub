/**
 * The Settings window.
 *
 * One draft, five sections, and one file. The draft is local until Save, Save
 * carries the revision the draft was made from, and an external edit that lands
 * while a draft is open is reported rather than merged — the window will not
 * guess which of the two the person meant.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  SETTINGS_SCHEMA_VERSION,
  type SettingsAgentProfileWire,
  type SettingsConfig,
  type SettingsError,
  type SettingsRuntimeWire,
  type SettingsSnapshot,
  type SettingsWorkspaceKindWire,
  type SettingsWorkspaceSourceWire,
} from "../ipc/settings";
import {
  createSettingsClient,
  parseSettingsTransportError,
  type SettingsClient,
} from "./client";
import { isImeComposing } from "../shell/accessibility/ime";
import "./settings.css";

const SETTINGS_SECTIONS = [
  "General",
  "Workspaces",
  "Agents",
  "Runtimes",
  "Appearance",
] as const;

type Section = (typeof SETTINGS_SECTIONS)[number];

const cloneConfig = (config: SettingsConfig): SettingsConfig =>
  JSON.parse(JSON.stringify(config)) as SettingsConfig;

function errorMessage(error: SettingsError): string {
  switch (error.code) {
    case "external_edit_conflict":
      return "The configuration changed outside Settings. Reload the current file, then reapply your draft before saving.";
    case "invalid_config":
      return "Some values are invalid. Review the highlighted fields before saving.";
    case "invalid_file":
      return "The configuration file could not be read or written.";
    case "runtime_unavailable":
      return "Runtime inspection is not available.";
    case "permission_denied":
      return "DevHub does not have permission to complete that action.";
    case "native_unavailable":
      return "The native Settings window is unavailable.";
    case "native_busy":
      return "Another diagnostics action is still in progress. Try again when it finishes.";
    case "native_timed_out":
      return "The diagnostics action timed out. It may still be finishing; try again shortly.";
  }
}

function ResolvedValue({
  value,
}: {
  readonly value: SettingsRuntimeWire["resolved"]["shell"];
}) {
  if (value.kind === "unavailable") {
    return <span className="settings-muted">Unavailable</span>;
  }
  return <code className="settings-code">{value.value}</code>;
}

function SettingsHeader({
  dirty,
  busy,
  onSave,
  onRevert,
  onReload,
}: {
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly onSave: () => void;
  readonly onRevert: () => void;
  readonly onReload: () => void;
}) {
  return (
    <header className="settings-header">
      <div>
        <h1>Settings</h1>
      </div>
      <div className="settings-header-actions">
        <span className={dirty ? "settings-dirty" : "settings-saved"}>
          {dirty ? "Unsaved changes" : "Saved"}
        </span>
        <button
          type="button"
          className="settings-button quiet"
          onClick={onReload}
          disabled={busy}
          title="Reload the current file and discard this local draft"
        >
          Reload (discard draft)
        </button>
        <button
          type="button"
          className="settings-button quiet"
          onClick={onRevert}
          disabled={!dirty || busy}
        >
          Revert
        </button>
        <button
          type="button"
          className="settings-button primary"
          onClick={onSave}
          disabled={!dirty || busy}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </header>
  );
}

function Field({
  label,
  help,
  children,
}: {
  readonly label: string;
  readonly help?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="settings-field">
      <div className="settings-field-label">
        <span>{label}</span>
        {help ? <span className="settings-help">{help}</span> : null}
      </div>
      {children}
    </label>
  );
}

function SectionFrame({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      className="settings-section"
      aria-labelledby={`settings-${title.toLowerCase()}`}
    >
      <div className="settings-section-heading">
        <h2 id={`settings-${title.toLowerCase()}`}>{title}</h2>
        <p>{description}</p>
      </div>
      {children}
    </section>
  );
}

function ArgvEditor({
  label,
  addButtonLabel,
  values,
  onChange,
}: {
  readonly label: string;
  readonly addButtonLabel?: string;
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
}) {
  const addLabel = addButtonLabel ?? `Add ${label.toLowerCase()} argument`;
  const updateAt = (index: number, value: string) => {
    onChange(
      values.map((item, itemIndex) => (itemIndex === index ? value : item)),
    );
  };
  const removeAt = (index: number) => {
    onChange(values.filter((_, itemIndex) => itemIndex !== index));
  };
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= values.length) return;
    const next = [...values];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return (
    <div className="settings-argv" aria-label={`${label} argv editor`}>
      <div className="settings-subheading">{label}</div>
      {values.map((value, index) => (
        // The list is positional: two identical arguments are two arguments,
        // so the index is the identity here.
        <div className="settings-argv-row" key={index}>
          <input
            aria-label={`${label} argument ${String(index + 1)}`}
            value={value}
            onChange={(event) => {
              updateAt(index, event.target.value);
            }}
          />
          <button
            type="button"
            className="settings-icon-button"
            aria-label={`Move ${label} argument ${String(index + 1)} up`}
            onClick={() => {
              move(index, -1);
            }}
            disabled={index === 0}
          >
            ↑
          </button>
          <button
            type="button"
            className="settings-icon-button"
            aria-label={`Move ${label} argument ${String(index + 1)} down`}
            onClick={() => {
              move(index, 1);
            }}
            disabled={index === values.length - 1}
          >
            ↓
          </button>
          <button
            type="button"
            className="settings-icon-button"
            aria-label={`Remove ${label} argument ${String(index + 1)}`}
            onClick={() => {
              removeAt(index);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="settings-button quiet"
        onClick={() => {
          onChange([...values, ""]);
        }}
      >
        {addLabel}
      </button>
    </div>
  );
}

function GeneralSection({
  config,
  update,
}: {
  readonly config: SettingsConfig;
  readonly update: (next: SettingsConfig) => void;
}) {
  return (
    <SectionFrame
      title="General"
      description="Choose how DevHub starts and reads your local environment."
    >
      <label className="settings-check-row">
        <input
          aria-label="Import login environment"
          type="checkbox"
          checked={config.general.importLoginEnvironment}
          onChange={(event) => {
            update({
              ...config,
              general: {
                ...config.general,
                importLoginEnvironment: event.target.checked,
              },
            });
          }}
        />
        <span>
          <strong>Import login environment</strong>
          <small>
            Use the login shell environment when launching runtime processes.
          </small>
        </span>
      </label>
    </SectionFrame>
  );
}

function WorkspaceSourceEditor({
  source,
  onChange,
  onRemove,
}: {
  readonly source: SettingsWorkspaceSourceWire;
  readonly onChange: (next: SettingsWorkspaceSourceWire) => void;
  readonly onRemove: () => void;
}) {
  return (
    <div className="settings-source-row">
      <div className="settings-source-heading">
        <input
          aria-label="Workspace source id"
          value={source.id}
          onChange={(event) => {
            onChange({ ...source, id: event.target.value });
          }}
        />
        <select
          aria-label="Workspace source type"
          value={source.type}
          onChange={(event) => {
            if (event.target.value === "command") {
              onChange({
                type: "command",
                id: source.id,
                command: ["devhub", "workspaces"],
                timeoutMs: 5000,
              });
            } else {
              onChange({
                type: "filesystem",
                id: source.id,
                path: source.type === "filesystem" ? source.path : "",
                minDepth: 0,
                maxDepth: null,
                kinds: ["directory"],
                includeHidden: false,
                excludeNames: [],
              });
            }
          }}
        >
          <option value="filesystem">Filesystem</option>
          <option value="command">Command</option>
        </select>
      </div>
      {source.type === "filesystem" ? (
        <>
          <Field
            label="Root path"
            help="Stored as the source path you chose; discovery validates and canonicalises the roots it finds under it."
          >
            <input
              aria-label="Workspace root path"
              value={source.path}
              onChange={(event) => {
                onChange({ ...source, path: event.target.value });
              }}
            />
          </Field>
          <div className="settings-inline-fields">
            <Field label="Minimum depth">
              <input
                type="number"
                min={0}
                value={source.minDepth}
                onChange={(event) => {
                  onChange({ ...source, minDepth: Number(event.target.value) });
                }}
              />
            </Field>
            <Field label="Maximum depth">
              <input
                type="number"
                min={0}
                value={source.maxDepth ?? ""}
                onChange={(event) => {
                  onChange({
                    ...source,
                    maxDepth:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  });
                }}
              />
            </Field>
          </div>
          <div className="settings-kind-list" aria-label="Workspace kinds">
            {(["directory", "git_repository", "git_worktree"] as const).map(
              (kind: SettingsWorkspaceKindWire) => (
                <label key={kind}>
                  <input
                    type="checkbox"
                    checked={source.kinds.includes(kind)}
                    onChange={(event) => {
                      onChange({
                        ...source,
                        kinds: event.target.checked
                          ? [...source.kinds, kind]
                          : source.kinds.filter((value) => value !== kind),
                      });
                    }}
                  />
                  {kind.replaceAll("_", " ")}
                </label>
              ),
            )}
          </div>
          <label className="settings-check-row compact">
            <input
              type="checkbox"
              checked={source.includeHidden}
              onChange={(event) => {
                onChange({ ...source, includeHidden: event.target.checked });
              }}
            />
            Include hidden directories
          </label>
          <ArgvEditor
            label="Excluded names"
            values={source.excludeNames}
            onChange={(excludeNames) => {
              onChange({ ...source, excludeNames });
            }}
          />
        </>
      ) : (
        <>
          <ArgvEditor
            label="Command"
            values={source.command}
            onChange={(command) => {
              onChange({ ...source, command });
            }}
          />
          <Field label="Timeout (ms)">
            <input
              type="number"
              min={100}
              max={30000}
              value={source.timeoutMs}
              onChange={(event) => {
                onChange({ ...source, timeoutMs: Number(event.target.value) });
              }}
            />
          </Field>
        </>
      )}
      <button
        type="button"
        className="settings-button quiet"
        onClick={onRemove}
      >
        Remove source
      </button>
    </div>
  );
}

function WorkspacesSection({
  config,
  update,
}: {
  readonly config: SettingsConfig;
  readonly update: (next: SettingsConfig) => void;
}) {
  return (
    <SectionFrame
      title="Workspaces"
      description="Configure the filesystem and command sources the workspace picker searches."
    >
      <div className="settings-list">
        {config.workspaceSources.map((source, index) => (
          <WorkspaceSourceEditor
            key={`${source.id}-${String(index)}`}
            source={source}
            onChange={(next) => {
              update({
                ...config,
                workspaceSources: config.workspaceSources.map(
                  (item, itemIndex) => (itemIndex === index ? next : item),
                ),
              });
            }}
            onRemove={() => {
              update({
                ...config,
                workspaceSources: config.workspaceSources.filter(
                  (_, itemIndex) => itemIndex !== index,
                ),
              });
            }}
          />
        ))}
      </div>
      <button
        type="button"
        className="settings-button quiet"
        onClick={() => {
          update({
            ...config,
            workspaceSources: [
              ...config.workspaceSources,
              {
                type: "filesystem",
                id: `source-${String(config.workspaceSources.length + 1)}`,
                path: "",
                minDepth: 0,
                maxDepth: null,
                kinds: ["directory"],
                includeHidden: false,
                excludeNames: [],
              },
            ],
          });
        }}
      >
        Add workspace source
      </button>
    </SectionFrame>
  );
}

function AgentEditor({
  profile,
  onChange,
  onRemove,
}: {
  readonly profile: SettingsAgentProfileWire;
  readonly onChange: (next: SettingsAgentProfileWire) => void;
  readonly onRemove: () => void;
}) {
  const envEntries = Object.entries(profile.env);
  return (
    <div className="settings-source-row">
      <div className="settings-source-heading">
        <input
          aria-label="Agent profile id"
          value={profile.id}
          onChange={(event) => {
            onChange({ ...profile, id: event.target.value });
          }}
        />
        <select
          aria-label="Agent profile kind"
          value={profile.kind}
          onChange={(event) => {
            onChange({
              ...profile,
              kind: event.target.value as SettingsAgentProfileWire["kind"],
            });
          }}
        >
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
      </div>
      <Field label="Display name">
        <input
          aria-label="Agent display name"
          value={profile.displayName}
          onChange={(event) => {
            onChange({ ...profile, displayName: event.target.value });
          }}
        />
      </Field>
      <ArgvEditor
        label="Arguments"
        addButtonLabel="Add argument"
        values={profile.args}
        onChange={(args) => {
          onChange({ ...profile, args });
        }}
      />
      <div className="settings-env" aria-label="Agent environment variables">
        <div className="settings-subheading">Environment</div>
        {envEntries.map(([key, value]) => (
          <div className="settings-env-row" key={key}>
            <input
              aria-label="Environment key"
              value={key}
              onChange={(event) => {
                const next = { ...profile.env };
                delete next[key];
                next[event.target.value] = value;
                onChange({ ...profile, env: next });
              }}
            />
            <input
              aria-label="Environment value"
              value={value}
              onChange={(event) => {
                onChange({
                  ...profile,
                  env: { ...profile.env, [key]: event.target.value },
                });
              }}
            />
            <button
              type="button"
              className="settings-icon-button"
              aria-label={`Remove ${key}`}
              onClick={() => {
                const next = { ...profile.env };
                delete next[key];
                onChange({ ...profile, env: next });
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="settings-button quiet"
          onClick={() => {
            onChange({ ...profile, env: { ...profile.env, NEW_VARIABLE: "" } });
          }}
        >
          Add variable
        </button>
      </div>
      <button
        type="button"
        className="settings-button quiet"
        onClick={onRemove}
      >
        Remove profile
      </button>
    </div>
  );
}

function AgentsSection({
  config,
  update,
}: {
  readonly config: SettingsConfig;
  readonly update: (next: SettingsConfig) => void;
}) {
  return (
    <SectionFrame
      title="Agents"
      description="Manage Codex and Claude profiles. Environment values are editable locally and never included in diagnostics."
    >
      <div className="settings-list">
        {config.agentProfiles.map((profile, index) => (
          <AgentEditor
            key={`${profile.id}-${String(index)}`}
            profile={profile}
            onChange={(next) => {
              update({
                ...config,
                agentProfiles: config.agentProfiles.map((item, itemIndex) =>
                  itemIndex === index ? next : item,
                ),
              });
            }}
            onRemove={() => {
              update({
                ...config,
                agentProfiles: config.agentProfiles.filter(
                  (_, itemIndex) => itemIndex !== index,
                ),
              });
            }}
          />
        ))}
      </div>
      <button
        type="button"
        className="settings-button quiet"
        onClick={() => {
          update({
            ...config,
            agentProfiles: [
              ...config.agentProfiles,
              {
                id: `agent-${String(config.agentProfiles.length + 1)}`,
                displayName: "New agent",
                kind: "codex",
                args: [],
                env: {},
              },
            ],
          });
        }}
      >
        Add agent profile
      </button>
    </SectionFrame>
  );
}

function RuntimesSection({
  config,
  update,
  runtime,
  diagnostics,
  onRecheck,
  onOpenLogs,
  onCopyDiagnostics,
  actionStatus,
  busy,
}: {
  readonly config: SettingsConfig;
  readonly update: (next: SettingsConfig) => void;
  readonly runtime: SettingsRuntimeWire;
  readonly diagnostics: SettingsSnapshot["diagnostics"];
  readonly onRecheck: () => void;
  readonly onOpenLogs: () => void;
  readonly onCopyDiagnostics: () => void;
  readonly actionStatus?: string;
  readonly busy: boolean;
}) {
  const fields = ["shell", "git", "tmux", "herdr"] as const;
  return (
    <SectionFrame
      title="Runtimes"
      description="Configured values are your intent; resolved and effective values come from what DevHub actually found."
    >
      <div className="settings-runtime-grid">
        {fields.map((field) => (
          <Field key={field} label={field}>
            <input
              aria-label={`${field} configured runtime`}
              value={config.runtimes[field]}
              onChange={(event) => {
                update({
                  ...config,
                  runtimes: { ...config.runtimes, [field]: event.target.value },
                });
              }}
            />
            <div className="settings-runtime-detail">
              <span>Resolved</span>
              <ResolvedValue value={runtime.resolved[field]} />
              <span>Effective</span>
              <code>{runtime.effective[field]}</code>
              <span>Health</span>
              <span className="settings-badge">{runtime.health[field]}</span>
            </div>
          </Field>
        ))}
      </div>
      <div className="settings-runtime-callout">
        <div className="settings-callout-heading">
          <strong>Runtime inspection</strong>
          {runtime.restartRequired ? (
            <span className="settings-badge warning">Restart required</span>
          ) : null}
        </div>
        <p>
          {runtime.health.inspectionAvailable
            ? "DevHub resolved each configured runtime against your PATH."
            : "Runtime inspection is unavailable."}
        </p>
        <button
          type="button"
          className="settings-button quiet"
          onClick={onRecheck}
          disabled={busy}
        >
          Recheck runtime
        </button>
        <button
          type="button"
          className="settings-button quiet"
          onClick={onOpenLogs}
          disabled={busy}
        >
          Open log folder
        </button>
        <button
          type="button"
          className="settings-button quiet"
          onClick={onCopyDiagnostics}
          disabled={busy}
        >
          Copy diagnostics
        </button>
        <p className="settings-diagnostics-summary">
          Session {diagnostics.sessionId}; previous exit{" "}
          {diagnostics.previousExit}.
        </p>
        {actionStatus ? (
          <p
            className="settings-action-status"
            role="status"
            aria-live="polite"
          >
            {actionStatus}
          </p>
        ) : null}
      </div>
    </SectionFrame>
  );
}

function AppearanceSection({
  config,
  update,
}: {
  readonly config: SettingsConfig;
  readonly update: (next: SettingsConfig) => void;
}) {
  const appearance = config.appearance;
  return (
    <SectionFrame
      title="Appearance"
      description="Adjust the quiet density and typography DevHub's surfaces use."
    >
      <Field label="Color scheme">
        <select
          aria-label="Color scheme"
          value={appearance.colorScheme}
          disabled
          onChange={(event) => {
            update({
              ...config,
              appearance: { ...appearance, colorScheme: event.target.value },
            });
          }}
        >
          <option value="light">Light</option>
        </select>
      </Field>
      <Field label="Terminal font family">
        <input
          aria-label="Terminal font family"
          value={appearance.terminalFontFamily}
          onChange={(event) => {
            update({
              ...config,
              appearance: {
                ...appearance,
                terminalFontFamily: event.target.value,
              },
            });
          }}
        />
      </Field>
      <div className="settings-inline-fields">
        <Field label="Font size">
          <input
            type="number"
            min={9}
            max={24}
            value={appearance.terminalFontSize}
            onChange={(event) => {
              update({
                ...config,
                appearance: {
                  ...appearance,
                  terminalFontSize: Number(event.target.value),
                },
              });
            }}
          />
        </Field>
        <Field label="Line height">
          <input
            type="number"
            min={1}
            max={2}
            step={0.05}
            value={appearance.terminalLineHeight}
            onChange={(event) => {
              update({
                ...config,
                appearance: {
                  ...appearance,
                  terminalLineHeight: Number(event.target.value),
                },
              });
            }}
          />
        </Field>
        <Field label="Terminal margin">
          <input
            type="number"
            min={0}
            max={64}
            step={1}
            value={appearance.terminalMargin}
            onChange={(event) => {
              update({
                ...config,
                appearance: {
                  ...appearance,
                  terminalMargin: Number(event.target.value),
                },
              });
            }}
          />
        </Field>
      </div>
      <Field label="Sidebar density">
        <select
          aria-label="Sidebar density"
          value={appearance.sidebarDensity}
          onChange={(event) => {
            update({
              ...config,
              appearance: { ...appearance, sidebarDensity: event.target.value },
            });
          }}
        >
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </Field>
      <p className="settings-inline-note">
        Saved appearance changes apply to the main shell. Terminal typography
        affects terminal surfaces, not this Settings window.
      </p>
    </SectionFrame>
  );
}

function SettingsErrorBanner({
  error,
  onReload,
}: {
  readonly error: SettingsError;
  readonly onReload?: () => void;
}) {
  return (
    <div className="settings-error" role="alert">
      <span>{errorMessage(error)}</span>
      {onReload && error.code === "external_edit_conflict" ? (
        <button
          type="button"
          className="settings-button quiet"
          onClick={onReload}
        >
          Reload current file (discard draft)
        </button>
      ) : null}
    </div>
  );
}

export function SettingsApp({ client }: { readonly client?: SettingsClient }) {
  const transportRef = useRef<SettingsClient>(null);
  transportRef.current ??= client ?? createSettingsClient();
  const transport = transportRef.current;

  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [draft, setDraft] = useState<SettingsConfig>();
  const [section, setSection] = useState<Section>("General");
  const [error, setError] = useState<SettingsError>();
  const [busy, setBusy] = useState(false);
  const [actionStatus, setActionStatus] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const mountGeneration = useRef(0);
  const lastSequence = useRef(0);

  const setDirtyState = (value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  };

  // The Settings window keeps its conventional singleton close shortcut
  // locally, so it stays usable without a focus-ambiguous native Close item.
  useEffect(() => {
    const closeOnCommandW = (event: KeyboardEvent) => {
      if (
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key.toLowerCase() !== "w" ||
        isImeComposing(event)
      ) {
        return;
      }
      event.preventDefault();
      void transport.close();
    };
    window.addEventListener("keydown", closeOnCommandW);
    return () => {
      window.removeEventListener("keydown", closeOnCommandW);
    };
  }, [transport]);

  useEffect(() => {
    const generation = mountGeneration.current + 1;
    mountGeneration.current = generation;
    lastSequence.current = 0;
    let disposed = false;
    let receivedEventSequence: number | undefined;
    const active = () => !disposed && mountGeneration.current === generation;

    const applyExternalSnapshot = (next: SettingsSnapshot) => {
      if (!active() || next.sequence < lastSequence.current) return;
      const preserveDraft = dirtyRef.current;
      receivedEventSequence = next.sequence;
      lastSequence.current = next.sequence;
      setSnapshot(next);
      if (preserveDraft) {
        setError({
          code: "external_edit_conflict",
          currentRevision: next.revision,
        });
      } else {
        setDraft(cloneConfig(next.config));
        setDirtyState(false);
        setError(undefined);
      }
    };

    // Subscribe before the first query so an external edit cannot land in the
    // gap between the two.
    const unsubscribe = transport.subscribe(applyExternalSnapshot);
    void transport
      .getSnapshot()
      .then((next) => {
        if (!active()) return;
        // A watcher event may have arrived while this was in flight. Keep the
        // newer revision instead of regressing it.
        if (
          receivedEventSequence !== undefined &&
          next.sequence < receivedEventSequence
        ) {
          return;
        }
        lastSequence.current = next.sequence;
        setSnapshot(next);
        setDraft(cloneConfig(next.config));
        setDirtyState(false);
        setError(undefined);
      })
      .catch((value: unknown) => {
        if (active()) setError(parseSettingsTransportError(value));
      });

    return () => {
      disposed = true;
      mountGeneration.current += 1;
      unsubscribe();
    };
  }, [transport]);

  const adopt = (next: SettingsSnapshot, generation: number) => {
    if (mountGeneration.current !== generation) return;
    if (next.sequence < lastSequence.current) return;
    lastSequence.current = next.sequence;
    setSnapshot(next);
    setDraft(cloneConfig(next.config));
    setDirtyState(false);
    setError(undefined);
  };

  const run = (work: () => Promise<SettingsSnapshot>, adoptDraft: boolean) => {
    const generation = mountGeneration.current;
    setBusy(true);
    void work()
      .then((next) => {
        if (adoptDraft) {
          adopt(next, generation);
          return;
        }
        if (
          mountGeneration.current === generation &&
          next.sequence >= lastSequence.current
        ) {
          lastSequence.current = next.sequence;
          setSnapshot(next);
        }
      })
      .catch((value: unknown) => {
        if (mountGeneration.current === generation) {
          setError(parseSettingsTransportError(value));
        }
      })
      .finally(() => {
        if (mountGeneration.current === generation) setBusy(false);
      });
  };

  const update = (next: SettingsConfig) => {
    setDraft(next);
    setDirtyState(true);
  };

  const save = () => {
    if (!snapshot || !draft) return;
    run(
      () =>
        transport.save({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          revision: snapshot.revision,
          config: draft,
        }),
      true,
    );
  };

  const reload = () => {
    run(() => transport.reload(), true);
  };

  const recheck = () => {
    run(() => transport.recheck(), false);
  };

  if (!snapshot || !draft) {
    return (
      <main className="settings-loading" aria-live="polite">
        {error ? <SettingsErrorBanner error={error} /> : "Loading Settings…"}
      </main>
    );
  }

  return (
    <main className="settings-window">
      <SettingsHeader
        dirty={dirty}
        busy={busy}
        onSave={save}
        onRevert={() => {
          setDraft(cloneConfig(snapshot.config));
          setDirtyState(false);
          setError(undefined);
        }}
        onReload={reload}
      />
      <div className="settings-notices">
        {error ? <SettingsErrorBanner error={error} onReload={reload} /> : null}
        {snapshot.diagnostic ? (
          <div className="settings-diagnostic" role="status">
            External file check: {snapshot.diagnostic.code}
            {snapshot.diagnostic.path ? ` (${snapshot.diagnostic.path})` : ""}
            {snapshot.diagnostic.line
              ? ` line ${String(snapshot.diagnostic.line)}`
              : ""}
            {snapshot.diagnostic.column
              ? `, column ${String(snapshot.diagnostic.column)}`
              : ""}
          </div>
        ) : null}
      </div>
      <div className="settings-body">
        <nav className="settings-sidebar" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item}
              type="button"
              className={section === item ? "active" : ""}
              aria-current={section === item ? "page" : undefined}
              onClick={() => {
                setSection(item);
              }}
            >
              {item}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section === "General" ? (
            <GeneralSection config={draft} update={update} />
          ) : null}
          {section === "Workspaces" ? (
            <WorkspacesSection config={draft} update={update} />
          ) : null}
          {section === "Agents" ? (
            <AgentsSection config={draft} update={update} />
          ) : null}
          {section === "Runtimes" ? (
            <RuntimesSection
              config={draft}
              update={update}
              runtime={snapshot.runtime}
              diagnostics={snapshot.diagnostics}
              onRecheck={recheck}
              onOpenLogs={() => {
                setActionStatus("Opening the local diagnostics folder…");
                void transport
                  .openLogFolder()
                  .then(() => {
                    setActionStatus("Diagnostics folder opened.");
                  })
                  .catch((value: unknown) => {
                    const parsed = parseSettingsTransportError(value);
                    setError(parsed);
                    setActionStatus(errorMessage(parsed));
                  });
              }}
              onCopyDiagnostics={() => {
                setActionStatus("Copying a redacted diagnostics summary…");
                void transport
                  .copyDiagnostics()
                  .then(() => {
                    setActionStatus("Redacted diagnostics summary copied.");
                  })
                  .catch((value: unknown) => {
                    const parsed = parseSettingsTransportError(value);
                    setError(parsed);
                    setActionStatus(errorMessage(parsed));
                  });
              }}
              actionStatus={actionStatus}
              busy={busy}
            />
          ) : null}
          {section === "Appearance" ? (
            <AppearanceSection config={draft} update={update} />
          ) : null}
        </div>
      </div>
    </main>
  );
}
