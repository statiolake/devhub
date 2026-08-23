import { useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  SETTINGS_SCHEMA_VERSION,
  type SettingsAgentProfileWire,
  type SettingsConfig,
  type SettingsError,
  type SettingsRuntimeWire,
  type SettingsSnapshot,
  type SettingsWorkspaceKindWire,
  type SettingsWorkspaceSourceWire,
} from "../generated/settings";
import {
  createTauriSettingsClient,
  parseSettingsTransportError,
  type SettingsClient,
} from "./client";
import "./settings.css";

const defaultSettingsClient = createTauriSettingsClient();

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
      return "Terminal runtime inspection is not available yet.";
    case "permission_denied":
      return "DevHub does not have permission to complete that native action.";
    case "native_unavailable":
      return "The native Settings window is unavailable.";
  }
}

function ResolvedValue({
  value,
}: {
  value: SettingsRuntimeWire["resolved"]["shell"];
}) {
  if (value.kind === "unavailable")
    return <span className="settings-muted">Unavailable</span>;
  return <code className="settings-code">{value.value}</code>;
}

function SettingsHeader({
  dirty,
  busy,
  onSave,
  onRevert,
  onReload,
  inert,
}: {
  dirty: boolean;
  busy: boolean;
  onSave: () => void;
  onRevert: () => void;
  onReload: () => void;
  inert?: boolean;
}) {
  return (
    <header className="settings-header" inert={inert ? true : undefined}>
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
  label: string;
  help?: string;
  children: React.ReactNode;
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

function ArgvEditor({
  label,
  addButtonLabel,
  values,
  onChange,
}: {
  label: string;
  addButtonLabel?: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const addLabel = addButtonLabel ?? `Add ${label.toLowerCase()} argument`;
  const updateAt = (index: number, value: string) =>
    onChange(
      values.map((item, itemIndex) => (itemIndex === index ? value : item)),
    );
  const removeAt = (index: number) =>
    onChange(values.filter((_, itemIndex) => itemIndex !== index));
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
        <div className="settings-argv-row" key={index}>
          <input
            aria-label={`${label} argument ${index + 1}`}
            value={value}
            onChange={(event) => updateAt(index, event.target.value)}
          />
          <button
            type="button"
            className="settings-icon-button"
            aria-label={`Move ${label} argument ${index + 1} up`}
            onClick={() => move(index, -1)}
            disabled={index === 0}
          >
            ↑
          </button>
          <button
            type="button"
            className="settings-icon-button"
            aria-label={`Move ${label} argument ${index + 1} down`}
            onClick={() => move(index, 1)}
            disabled={index === values.length - 1}
          >
            ↓
          </button>
          <button
            type="button"
            className="settings-icon-button"
            aria-label={`Remove ${label} argument ${index + 1}`}
            onClick={() => removeAt(index)}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="settings-button quiet"
        onClick={() => onChange([...values, ""])}
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
  config: SettingsConfig;
  update: (next: SettingsConfig) => void;
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
          onChange={(event) =>
            update({
              ...config,
              general: {
                ...config.general,
                importLoginEnvironment: event.target.checked,
              },
            })
          }
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
  source: SettingsWorkspaceSourceWire;
  onChange: (next: SettingsWorkspaceSourceWire) => void;
  onRemove: () => void;
}) {
  return (
    <div className="settings-source-row">
      <div className="settings-source-heading">
        <input
          aria-label="Workspace source id"
          value={source.id}
          onChange={(event) => onChange({ ...source, id: event.target.value })}
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
            help="Stored as a user-selected source path; native discovery validates and canonicalizes roots."
          >
            <input
              aria-label="Workspace root path"
              value={source.path}
              onChange={(event) =>
                onChange({ ...source, path: event.target.value })
              }
            />
          </Field>
          <div className="settings-inline-fields">
            <Field label="Minimum depth">
              <input
                type="number"
                min={0}
                value={source.minDepth}
                onChange={(event) =>
                  onChange({ ...source, minDepth: Number(event.target.value) })
                }
              />
            </Field>
            <Field label="Maximum depth">
              <input
                type="number"
                min={0}
                value={source.maxDepth ?? ""}
                onChange={(event) =>
                  onChange({
                    ...source,
                    maxDepth:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  })
                }
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
                    onChange={(event) =>
                      onChange({
                        ...source,
                        kinds: event.target.checked
                          ? [...source.kinds, kind]
                          : source.kinds.filter((value) => value !== kind),
                      })
                    }
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
              onChange={(event) =>
                onChange({ ...source, includeHidden: event.target.checked })
              }
            />
            Include hidden directories
          </label>
          <ArgvEditor
            label="Excluded names"
            values={source.excludeNames}
            onChange={(excludeNames) => onChange({ ...source, excludeNames })}
          />
        </>
      ) : (
        <>
          <ArgvEditor
            label="Command"
            values={source.command}
            onChange={(command) => onChange({ ...source, command })}
          />
          <Field label="Timeout (ms)">
            <input
              type="number"
              min={100}
              max={30000}
              value={source.timeoutMs}
              onChange={(event) =>
                onChange({ ...source, timeoutMs: Number(event.target.value) })
              }
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
  config: SettingsConfig;
  update: (next: SettingsConfig) => void;
}) {
  return (
    <SectionFrame
      title="Workspaces"
      description="Configure trusted filesystem and command sources for workspace discovery."
    >
      <div className="settings-list">
        {config.workspaceSources.map((source, index) => (
          <WorkspaceSourceEditor
            key={`${source.id}-${index}`}
            source={source}
            onChange={(next) =>
              update({
                ...config,
                workspaceSources: config.workspaceSources.map(
                  (item, itemIndex) => (itemIndex === index ? next : item),
                ),
              })
            }
            onRemove={() =>
              update({
                ...config,
                workspaceSources: config.workspaceSources.filter(
                  (_, itemIndex) => itemIndex !== index,
                ),
              })
            }
          />
        ))}
      </div>
      <button
        type="button"
        className="settings-button quiet"
        onClick={() =>
          update({
            ...config,
            workspaceSources: [
              ...config.workspaceSources,
              {
                type: "filesystem",
                id: `source-${config.workspaceSources.length + 1}`,
                path: "",
                minDepth: 0,
                maxDepth: null,
                kinds: ["directory"],
                includeHidden: false,
                excludeNames: [],
              },
            ],
          })
        }
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
  profile: SettingsAgentProfileWire;
  onChange: (next: SettingsAgentProfileWire) => void;
  onRemove: () => void;
}) {
  const envEntries = Object.entries(profile.env);
  return (
    <div className="settings-source-row">
      <div className="settings-source-heading">
        <input
          aria-label="Agent profile id"
          value={profile.id}
          onChange={(event) => onChange({ ...profile, id: event.target.value })}
        />
        <select
          aria-label="Agent profile kind"
          value={profile.kind}
          onChange={(event) =>
            onChange({
              ...profile,
              kind: event.target.value as SettingsAgentProfileWire["kind"],
            })
          }
        >
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
      </div>
      <Field label="Display name">
        <input
          aria-label="Agent display name"
          value={profile.displayName}
          onChange={(event) =>
            onChange({ ...profile, displayName: event.target.value })
          }
        />
      </Field>
      <ArgvEditor
        label="Arguments"
        addButtonLabel="Add argument"
        values={profile.args}
        onChange={(args) => onChange({ ...profile, args })}
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
              onChange={(event) =>
                onChange({
                  ...profile,
                  env: { ...profile.env, [key]: event.target.value },
                })
              }
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
          onClick={() =>
            onChange({ ...profile, env: { ...profile.env, NEW_VARIABLE: "" } })
          }
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
  config: SettingsConfig;
  update: (next: SettingsConfig) => void;
}) {
  return (
    <SectionFrame
      title="Agents"
      description="Manage Codex and Claude profiles. Environment values are editable locally and never included in diagnostics."
    >
      <div className="settings-list">
        {config.agentProfiles.map((profile, index) => (
          <AgentEditor
            key={`${profile.id}-${index}`}
            profile={profile}
            onChange={(next) =>
              update({
                ...config,
                agentProfiles: config.agentProfiles.map((item, itemIndex) =>
                  itemIndex === index ? next : item,
                ),
              })
            }
            onRemove={() =>
              update({
                ...config,
                agentProfiles: config.agentProfiles.filter(
                  (_, itemIndex) => itemIndex !== index,
                ),
              })
            }
          />
        ))}
      </div>
      <button
        type="button"
        className="settings-button quiet"
        onClick={() =>
          update({
            ...config,
            agentProfiles: [
              ...config.agentProfiles,
              {
                id: `agent-${config.agentProfiles.length + 1}`,
                displayName: "New agent",
                kind: "codex",
                args: [],
                env: {},
              },
            ],
          })
        }
      >
        Add agent profile
      </button>
    </SectionFrame>
  );
}

function RuntimeValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-runtime-value">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function RuntimesSection({
  config,
  update,
  runtime,
  onRecheck,
  onOpenLogs,
  onApplySocketChange,
  socketTriggerRef,
  busy,
}: {
  config: SettingsConfig;
  update: (next: SettingsConfig) => void;
  runtime: SettingsRuntimeWire;
  onRecheck: () => void;
  onOpenLogs: () => void;
  onApplySocketChange: (socket: SettingsRuntimeWire["socketChange"]) => void;
  socketTriggerRef: React.RefObject<HTMLButtonElement | null>;
  busy: boolean;
}) {
  const fields = ["shell", "git", "tmux", "herdr"] as const;
  return (
    <SectionFrame
      title="Runtimes"
      description="Configured values are user intent; resolved and effective values come from native runtime state."
    >
      <div className="settings-runtime-grid">
        {fields.map((field) => (
          <Field key={field} label={field}>
            <input
              aria-label={`${field} configured runtime`}
              value={config.runtimes[field]}
              onChange={(event) =>
                update({
                  ...config,
                  runtimes: { ...config.runtimes, [field]: event.target.value },
                })
              }
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
            ? "Native adapters reported current health."
            : "Runtime inspection is unavailable until TerminalRuntime is connected."}
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
      </div>
      <div className="settings-runtime-callout">
        <div className="settings-callout-heading">
          <strong>tmux socket</strong>
          <span className="settings-badge">{runtime.socketChange.state}</span>
        </div>
        <div className="settings-runtime-values">
          <RuntimeValue
            label="Configured"
            value={runtime.socketChange.configuredSocketName}
          />
          <RuntimeValue
            label="Effective"
            value={runtime.socketChange.effectiveSocketName}
          />
          <RuntimeValue
            label="Target"
            value={runtime.socketChange.requestedSocketName ?? "—"}
          />
          <RuntimeValue
            label="Preflight"
            value={runtime.socketChange.targetPreflight}
          />
        </div>
        <p>
          {runtime.socketChange.adapterAvailable
            ? "Target inspection is available; confirmation is required before session recreation."
            : "Apply is unavailable: TerminalRuntime inspection and session recreation are not connected yet."}
        </p>
        <div className="settings-runtime-values">
          <RuntimeValue
            label="Scratch sessions"
            value={String(runtime.socketChange.scratchSessionCount)}
          />
          <RuntimeValue
            label="Workspace sessions"
            value={String(runtime.socketChange.workspaceSessionCount)}
          />
          <RuntimeValue
            label="Target"
            value={runtime.socketChange.requestedSocketName ?? "—"}
          />
          <RuntimeValue
            label="Preflight"
            value={runtime.socketChange.targetPreflight}
          />
        </div>
        <button
          type="button"
          className="settings-button quiet"
          ref={socketTriggerRef}
          onClick={() => onApplySocketChange(runtime.socketChange)}
          disabled={!runtime.socketChange.adapterAvailable || busy}
        >
          Apply socket change
        </button>
      </div>
      <Field
        label="tmux socket name"
        help="Changing this is restart-required and never mutates Agents or Editors."
      >
        <input
          aria-label="tmux socket name"
          value={config.runtimes.tmuxSocketName}
          onChange={(event) =>
            update({
              ...config,
              runtimes: {
                ...config.runtimes,
                tmuxSocketName: event.target.value,
              },
            })
          }
        />
      </Field>
      <ArgvEditor
        label="tmux arguments"
        values={config.runtimes.tmuxArgs}
        onChange={(tmuxArgs) =>
          update({ ...config, runtimes: { ...config.runtimes, tmuxArgs } })
        }
      />
    </SectionFrame>
  );
}

function AppearanceSection({
  config,
  update,
}: {
  config: SettingsConfig;
  update: (next: SettingsConfig) => void;
}) {
  const appearance = config.appearance;
  return (
    <SectionFrame
      title="Appearance"
      description="Adjust the quiet density and typography used by DevHub surfaces."
    >
      <Field label="Color scheme">
        <select
          aria-label="Color scheme"
          value={appearance.colorScheme}
          disabled
          onChange={(event) =>
            update({
              ...config,
              appearance: { ...appearance, colorScheme: event.target.value },
            })
          }
        >
          <option value="light">Light</option>
        </select>
      </Field>
      <Field label="Terminal font family">
        <input
          aria-label="Terminal font family"
          value={appearance.terminalFontFamily}
          onChange={(event) =>
            update({
              ...config,
              appearance: {
                ...appearance,
                terminalFontFamily: event.target.value,
              },
            })
          }
        />
      </Field>
      <div className="settings-inline-fields">
        <Field label="Font size">
          <input
            type="number"
            min={9}
            max={24}
            value={appearance.terminalFontSize}
            onChange={(event) =>
              update({
                ...config,
                appearance: {
                  ...appearance,
                  terminalFontSize: Number(event.target.value),
                },
              })
            }
          />
        </Field>
        <Field label="Line height">
          <input
            type="number"
            min={1}
            max={2}
            step={0.05}
            value={appearance.terminalLineHeight}
            onChange={(event) =>
              update({
                ...config,
                appearance: {
                  ...appearance,
                  terminalLineHeight: Number(event.target.value),
                },
              })
            }
          />
        </Field>
      </div>
      <Field label="Sidebar density">
        <select
          aria-label="Sidebar density"
          value={appearance.sidebarDensity}
          onChange={(event) =>
            update({
              ...config,
              appearance: { ...appearance, sidebarDensity: event.target.value },
            })
          }
        >
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </Field>
      <p className="settings-inline-note">
        Saved appearance changes apply to the main shell where supported.
        Terminal typography affects terminal surfaces, not this Settings window.
      </p>
    </SectionFrame>
  );
}

function SectionFrame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
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

export function SettingsApp({
  client = defaultSettingsClient,
}: {
  client?: SettingsClient;
}) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [draft, setDraft] = useState<SettingsConfig>();
  const [section, setSection] = useState<Section>("General");
  const [error, setError] = useState<SettingsError>();
  const [busy, setBusy] = useState(false);
  const [socketConfirmation, setSocketConfirmation] =
    useState<SettingsRuntimeWire["socketChange"]>();
  const socketTriggerRef = useRef<HTMLButtonElement>(null);
  const socketCancelRef = useRef<HTMLButtonElement>(null);
  const socketWasOpen = useRef(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const mountGeneration = useRef(0);
  const lastSequence = useRef(0);
  const setDirtyState = (value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  };

  useEffect(() => {
    const generation = mountGeneration.current + 1;
    mountGeneration.current = generation;
    lastSequence.current = 0;
    let disposed = false;
    let unsubscribe: UnlistenFn | undefined;
    let receivedEventSequence: number | undefined;
    const active = () => !disposed && mountGeneration.current === generation;
    const applyExternalSnapshot = (next: SettingsSnapshot) => {
      if (!active()) return;
      if (next.sequence < lastSequence.current) return;
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
    const loadInitialSnapshot = () => {
      void client
        .getSnapshot()
        .then((next) => {
          if (!active()) return;
          // A watcher event may have arrived while the snapshot request was
          // in flight. Keep the newer revision instead of regressing it.
          if (
            receivedEventSequence !== undefined &&
            next.sequence < receivedEventSequence
          )
            return;
          lastSequence.current = next.sequence;
          setSnapshot(next);
          setDraft(cloneConfig(next.config));
          setDirtyState(false);
          setError(undefined);
        })
        .catch((value: unknown) => {
          if (active()) setError(parseSettingsTransportError(value));
        });
    };
    // Register the event subscription before the first snapshot query so an
    // external edit cannot land in the gap between those two operations.
    void client
      .subscribe(applyExternalSnapshot)
      .then((remove) => {
        if (!active()) {
          remove();
          return;
        }
        unsubscribe = remove;
        loadInitialSnapshot();
      })
      .catch((value: unknown) => {
        if (active()) {
          setError(parseSettingsTransportError(value));
          loadInitialSnapshot();
        }
      });
    return () => {
      disposed = true;
      mountGeneration.current += 1;
      unsubscribe?.();
    };
  }, [client]);

  const update = (next: SettingsConfig) => {
    setDraft(next);
    setDirtyState(true);
  };
  const save = () => {
    if (!snapshot || !draft) return;
    const generation = mountGeneration.current;
    setBusy(true);
    void client
      .save({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        revision: snapshot.revision,
        config: draft,
      })
      .then((next) => {
        if (mountGeneration.current !== generation) return;
        if (next.sequence < lastSequence.current) return;
        lastSequence.current = next.sequence;
        setSnapshot(next);
        setDraft(cloneConfig(next.config));
        setDirtyState(false);
        setError(undefined);
      })
      .catch((value: unknown) => {
        if (mountGeneration.current === generation)
          setError(parseSettingsTransportError(value));
      })
      .finally(() => {
        if (mountGeneration.current === generation) setBusy(false);
      });
  };
  const reload = () => {
    const generation = mountGeneration.current;
    setBusy(true);
    void client
      .reload()
      .then((next) => {
        if (mountGeneration.current !== generation) return;
        if (next.sequence < lastSequence.current) return;
        lastSequence.current = next.sequence;
        setSnapshot(next);
        setDraft(cloneConfig(next.config));
        setDirtyState(false);
        setError(undefined);
      })
      .catch((value: unknown) => {
        if (mountGeneration.current === generation)
          setError(parseSettingsTransportError(value));
      })
      .finally(() => {
        if (mountGeneration.current === generation) setBusy(false);
      });
  };
  const recheck = () => {
    const generation = mountGeneration.current;
    setBusy(true);
    void client
      .recheck()
      .then((next) => {
        if (
          mountGeneration.current === generation &&
          next.sequence >= lastSequence.current
        ) {
          lastSequence.current = next.sequence;
          setSnapshot(next);
        }
      })
      .catch((value: unknown) => {
        if (mountGeneration.current === generation)
          setError(parseSettingsTransportError(value));
      })
      .finally(() => {
        if (mountGeneration.current === generation) setBusy(false);
      });
  };
  const confirmSocketChange = () => {
    if (!snapshot) return;
    const generation = mountGeneration.current;
    setBusy(true);
    void client
      .applySocketChange({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        revision: snapshot.revision,
        confirmed: true,
      })
      .then((next) => {
        if (mountGeneration.current !== generation) return;
        if (next.sequence < lastSequence.current) return;
        lastSequence.current = next.sequence;
        setSnapshot(next);
        setSocketConfirmation(undefined);
        setError(undefined);
      })
      .catch((value: unknown) => {
        if (mountGeneration.current === generation)
          setError(parseSettingsTransportError(value));
      })
      .finally(() => {
        if (mountGeneration.current === generation) setBusy(false);
      });
  };

  useEffect(() => {
    if (socketConfirmation) {
      socketCancelRef.current?.focus();
    } else if (socketWasOpen.current) {
      socketTriggerRef.current?.focus();
    }
    socketWasOpen.current = Boolean(socketConfirmation);
  }, [socketConfirmation]);

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
        inert={Boolean(socketConfirmation)}
      />
      <div
        className="settings-notices"
        inert={socketConfirmation ? true : undefined}
      >
        {error ? <SettingsErrorBanner error={error} onReload={reload} /> : null}
        {snapshot.diagnostic ? (
          <div className="settings-diagnostic" role="status">
            External file check: {snapshot.diagnostic.code}
            {snapshot.diagnostic.path ? ` (${snapshot.diagnostic.path})` : ""}
            {snapshot.diagnostic.line
              ? ` line ${snapshot.diagnostic.line}`
              : ""}
            {snapshot.diagnostic.column
              ? `, column ${snapshot.diagnostic.column}`
              : ""}
          </div>
        ) : null}
      </div>
      {socketConfirmation ? (
        <div className="settings-sheet-backdrop">
          <section
            className="settings-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="socket-confirmation-heading"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setSocketConfirmation(undefined);
              }
            }}
          >
            <h2 id="socket-confirmation-heading">Apply tmux socket change?</h2>
            <p>
              Target{" "}
              <code className="settings-code">
                {socketConfirmation.requestedSocketName ?? "—"}
              </code>{" "}
              ({socketConfirmation.targetPreflight}) will be reconciled before
              recreation. Scratch sessions:{" "}
              {socketConfirmation.scratchSessionCount}; Workspace sessions:{" "}
              {socketConfirmation.workspaceSessionCount}. Agents and Editors are
              not changed.
            </p>
            <div className="settings-sheet-actions">
              <button
                type="button"
                className="settings-button quiet"
                ref={socketCancelRef}
                onClick={() => setSocketConfirmation(undefined)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="settings-button primary"
                onClick={confirmSocketChange}
                disabled={busy}
              >
                {busy ? "Applying…" : "Confirm"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      <div
        className="settings-body"
        inert={socketConfirmation ? true : undefined}
      >
        <nav className="settings-sidebar" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item}
              type="button"
              className={section === item ? "active" : ""}
              aria-current={section === item ? "page" : undefined}
              onClick={() => setSection(item)}
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
              onRecheck={recheck}
              onApplySocketChange={setSocketConfirmation}
              socketTriggerRef={socketTriggerRef}
              onOpenLogs={() => {
                void client
                  .openLogFolder()
                  .catch((value: unknown) =>
                    setError(parseSettingsTransportError(value)),
                  );
              }}
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

function SettingsErrorBanner({
  error,
  onReload,
}: {
  error: SettingsError;
  onReload?: () => void;
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
