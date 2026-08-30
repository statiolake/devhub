/**
 * Settings, shaped like a macOS preferences window.
 *
 * A toolbar of sections across the top, and grouped form rows underneath with
 * their labels right-aligned in a shared column. There is no draft banner and
 * no Save button: a preferences window on a Mac does not have a document to
 * save, so a change is applied when you make it, and the only thing that can
 * go wrong — the file changed underneath you — is said once, where it happened.
 *
 * `Cmd+W` closes the window. `Esc` cancels whatever sheet is open.
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
  type SettingsAgentProfileWire,
  type SettingsConfig,
  type SettingsError,
  type SettingsRuntimeWire,
  type SettingsSnapshot,
  type SettingsSocketPreflightWire,
  type SettingsWorkspaceKindWire,
  type SettingsWorkspaceSourceWire,
} from "../ipc/settings";
import { Alert } from "../shell/components/shell/Alert";
import {
  createSettingsClient,
  parseSettingsTransportError,
  type SettingsClient,
} from "./client";
import "../shell/styles/tokens.css";
import "../shell/styles/macos.css";
import "./settings.css";

const SECTIONS = [
  "General",
  "Workspaces",
  "Agents",
  "Runtimes",
  "Appearance",
] as const;

type Section = (typeof SECTIONS)[number];

const clone = (config: SettingsConfig): SettingsConfig =>
  JSON.parse(JSON.stringify(config)) as SettingsConfig;

function errorMessage(error: SettingsError): string {
  switch (error.code) {
    case "external_edit_conflict":
      return "config.toml changed outside Settings. Reload to see the new file.";
    case "invalid_config":
      return "That value is not one DevHub can use. It has not been saved.";
    case "invalid_file":
      return "config.toml could not be read or written.";
    case "runtime_unavailable":
      return "DevHub could not inspect the runtimes.";
    case "permission_denied":
      return "DevHub does not have permission to do that.";
    case "native_unavailable":
      return "The Settings window lost its connection to DevHub.";
    case "native_busy":
      return "Another action is still finishing. Try again in a moment.";
    case "native_timed_out":
      return "That action timed out. It may still be finishing.";
  }
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
  Runtimes: (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="2.6" y="4" width="14.8" height="12" rx="2" />
      <path d="M5.8 8.4 8.2 10.6l-2.4 2.2M10.4 13h4" />
    </svg>
  ),
  Appearance: (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="7.2" />
      <path
        d="M10 2.8a7.2 7.2 0 0 0 0 14.4z"
        fill="currentColor"
        stroke="none"
      />
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
  return (
    <header className="settings-toolbar">
      <nav className="settings-tabs" aria-label="Settings sections">
        {SECTIONS.map((item) => (
          <button
            key={item}
            type="button"
            className={`settings-tab${section === item ? " is-selected" : ""}`}
            aria-current={section === item ? "page" : undefined}
            onClick={() => {
              onSelect(item);
            }}
          >
            <span className="settings-tab-glyph">{SECTION_GLYPHS[item]}</span>
            <span>{item}</span>
          </button>
        ))}
      </nav>
    </header>
  );
}

// -------------------------------------------------------------- form pieces

function Group({
  heading,
  children,
}: {
  readonly heading?: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      {heading ? <h2 className="mac-group-heading">{heading}</h2> : null}
      <div className="mac-group">{children}</div>
    </>
  );
}

function Row({
  label,
  help,
  children,
}: {
  readonly label: string;
  readonly help?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="mac-row">
      <span className="mac-label">{label}</span>
      <div className="mac-row-value">{children}</div>
      {help ? <p className="mac-row-help mac-caption">{help}</p> : null}
    </div>
  );
}

function SwitchRow({
  label,
  help,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly help?: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <div className="mac-row">
      <span className="mac-label">{label}</span>
      <div className="mac-row-value">
        <input
          type="checkbox"
          className="mac-switch"
          aria-label={label}
          checked={checked}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
      </div>
      {help ? <p className="mac-row-help mac-caption">{help}</p> : null}
    </div>
  );
}

/** A list of strings a person can add to, reorder and remove. */
function TokenList({
  label,
  values,
  placeholder,
  onChange,
}: {
  readonly label: string;
  readonly values: readonly string[];
  readonly placeholder?: string;
  readonly onChange: (values: string[]) => void;
}) {
  return (
    <div className="settings-tokens" aria-label={label}>
      {values.map((value, index) => (
        // Two identical arguments are two arguments: position is the identity.
        <div className="settings-token" key={index}>
          <input
            className="mac-field"
            aria-label={`${label} ${String(index + 1)}`}
            value={value}
            placeholder={placeholder}
            onChange={(event) => {
              onChange(
                values.map((item, position) =>
                  position === index ? event.target.value : item,
                ),
              );
            }}
          />
          <button
            type="button"
            className="mac-icon-button"
            aria-label={`Move ${label} ${String(index + 1)} up`}
            disabled={index === 0}
            onClick={() => {
              const next = [...values];
              [next[index - 1], next[index]] = [next[index], next[index - 1]];
              onChange(next);
            }}
          >
            ↑
          </button>
          <button
            type="button"
            className="mac-icon-button"
            aria-label={`Remove ${label} ${String(index + 1)}`}
            onClick={() => {
              onChange(values.filter((_, position) => position !== index));
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="mac-button plain settings-token-add"
        onClick={() => {
          onChange([...values, ""]);
        }}
      >
        + Add
      </button>
    </div>
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

// ---------------------------------------------------------------- sections

function GeneralSection({
  config,
  update,
}: {
  readonly config: SettingsConfig;
  readonly update: (next: SettingsConfig) => void;
}) {
  return (
    <Group>
      <SwitchRow
        label="Import login environment"
        help="Use your login shell's environment when DevHub launches terminals and agents."
        checked={config.general.importLoginEnvironment}
        onChange={(importLoginEnvironment) => {
          update({ ...config, general: { importLoginEnvironment } });
        }}
      />
    </Group>
  );
}

function WorkspacesSection({
  config,
  update,
}: {
  readonly config: SettingsConfig;
  readonly update: (next: SettingsConfig) => void;
}) {
  const replace = (index: number, next: SettingsWorkspaceSourceWire) => {
    update({
      ...config,
      workspaceSources: config.workspaceSources.map((item, position) =>
        position === index ? next : item,
      ),
    });
  };

  return (
    <>
      <p className="settings-intro mac-caption">
        Where the workspace picker looks. A filesystem source walks a folder; a
        command source runs a program that prints one path per line.
      </p>
      {config.workspaceSources.map((source, index) => (
        <div className="settings-card" key={`${source.id}-${String(index)}`}>
          <Group>
            <Row label="Identifier">
              <input
                className="mac-field settings-grow"
                aria-label="Workspace source identifier"
                value={source.id}
                onChange={(event) => {
                  replace(index, { ...source, id: event.target.value });
                }}
              />
              <button
                type="button"
                className="mac-icon-button"
                aria-label={`Remove source ${source.id}`}
                onClick={() => {
                  update({
                    ...config,
                    workspaceSources: config.workspaceSources.filter(
                      (_, position) => position !== index,
                    ),
                  });
                }}
              >
                ✕
              </button>
            </Row>
            <Row label="Kind">
              <select
                className="mac-popup"
                aria-label="Workspace source kind"
                value={source.type}
                onChange={(event) => {
                  replace(
                    index,
                    event.target.value === "command"
                      ? {
                          type: "command",
                          id: source.id,
                          command: [""],
                          timeoutMs: 2000,
                        }
                      : {
                          type: "filesystem",
                          id: source.id,
                          path:
                            source.type === "filesystem" ? source.path : "~",
                          minDepth: 1,
                          maxDepth: 2,
                          kinds: ["directory"],
                          includeHidden: false,
                          excludeNames: [],
                        },
                  );
                }}
              >
                <option value="filesystem">Folder</option>
                <option value="command">Command</option>
              </select>
            </Row>

            {source.type === "filesystem" ? (
              <>
                <Row label="Folder">
                  <input
                    className="mac-field settings-grow"
                    aria-label="Workspace root path"
                    value={source.path}
                    onChange={(event) => {
                      replace(index, { ...source, path: event.target.value });
                    }}
                  />
                </Row>
                <Row label="Depth" help="How far below the folder to look.">
                  <input
                    className="mac-field"
                    type="number"
                    min={0}
                    aria-label="Minimum depth"
                    value={source.minDepth}
                    onChange={(event) => {
                      replace(index, {
                        ...source,
                        minDepth: Number(event.target.value),
                      });
                    }}
                  />
                  <span className="mac-caption">to</span>
                  <input
                    className="mac-field"
                    type="number"
                    min={0}
                    aria-label="Maximum depth"
                    value={source.maxDepth ?? ""}
                    onChange={(event) => {
                      replace(index, {
                        ...source,
                        maxDepth:
                          event.target.value === ""
                            ? null
                            : Number(event.target.value),
                      });
                    }}
                  />
                </Row>
                <Row label="Match">
                  <div className="settings-checks">
                    {(
                      ["directory", "git_repository", "git_worktree"] as const
                    ).map((kind: SettingsWorkspaceKindWire) => (
                      <label key={kind} className="settings-check">
                        <input
                          type="checkbox"
                          checked={source.kinds.includes(kind)}
                          onChange={(event) => {
                            replace(index, {
                              ...source,
                              kinds: event.target.checked
                                ? [...source.kinds, kind]
                                : source.kinds.filter(
                                    (value) => value !== kind,
                                  ),
                            });
                          }}
                        />
                        {kind === "directory"
                          ? "Any folder"
                          : kind === "git_repository"
                            ? "Git repository"
                            : "Git worktree"}
                      </label>
                    ))}
                  </div>
                </Row>
                <SwitchRow
                  label="Include hidden folders"
                  checked={source.includeHidden}
                  onChange={(includeHidden) => {
                    replace(index, { ...source, includeHidden });
                  }}
                />
                <Row label="Skip folders named">
                  <TokenList
                    label="Excluded name"
                    values={source.excludeNames}
                    placeholder="node_modules"
                    onChange={(excludeNames) => {
                      replace(index, { ...source, excludeNames });
                    }}
                  />
                </Row>
              </>
            ) : (
              <>
                <Row label="Command">
                  <TokenList
                    label="Command argument"
                    values={source.command}
                    onChange={(command) => {
                      replace(index, { ...source, command });
                    }}
                  />
                </Row>
                <Row
                  label="Timeout"
                  help="Milliseconds, between 100 and 30000."
                >
                  <input
                    className="mac-field"
                    type="number"
                    min={100}
                    max={30000}
                    aria-label="Command timeout"
                    value={source.timeoutMs}
                    onChange={(event) => {
                      replace(index, {
                        ...source,
                        timeoutMs: Number(event.target.value),
                      });
                    }}
                  />
                </Row>
              </>
            )}
          </Group>
        </div>
      ))}
      <button
        type="button"
        className="mac-button settings-add"
        onClick={() => {
          update({
            ...config,
            workspaceSources: [
              ...config.workspaceSources,
              {
                type: "filesystem",
                id: `source-${String(config.workspaceSources.length + 1)}`,
                path: "~",
                minDepth: 1,
                maxDepth: 2,
                kinds: ["git_repository"],
                includeHidden: false,
                excludeNames: [],
              },
            ],
          });
        }}
      >
        Add Source
      </button>
    </>
  );
}

function AgentsSection({
  config,
  update,
}: {
  readonly config: SettingsConfig;
  readonly update: (next: SettingsConfig) => void;
}) {
  const replace = (index: number, next: SettingsAgentProfileWire) => {
    update({
      ...config,
      agentProfiles: config.agentProfiles.map((item, position) =>
        position === index ? next : item,
      ),
    });
  };

  return (
    <>
      <p className="settings-intro mac-caption">
        The agents you can launch in a workspace. Environment values stay on
        this machine and are never included in a diagnostics summary.
      </p>
      {config.agentProfiles.map((profile, index) => (
        <div className="settings-card" key={`${profile.id}-${String(index)}`}>
          <Group>
            <Row label="Identifier">
              <input
                className="mac-field settings-grow"
                aria-label="Agent profile identifier"
                value={profile.id}
                onChange={(event) => {
                  replace(index, { ...profile, id: event.target.value });
                }}
              />
              <button
                type="button"
                className="mac-icon-button"
                aria-label={`Remove profile ${profile.id}`}
                onClick={() => {
                  update({
                    ...config,
                    agentProfiles: config.agentProfiles.filter(
                      (_, position) => position !== index,
                    ),
                  });
                }}
              >
                ✕
              </button>
            </Row>
            <Row label="Name">
              <input
                className="mac-field settings-grow"
                aria-label="Agent display name"
                value={profile.displayName}
                onChange={(event) => {
                  replace(index, {
                    ...profile,
                    displayName: event.target.value,
                  });
                }}
              />
            </Row>
            <Row label="Runtime">
              <select
                className="mac-popup"
                aria-label="Agent runtime"
                value={profile.kind}
                onChange={(event) => {
                  replace(index, {
                    ...profile,
                    kind: event.target
                      .value as SettingsAgentProfileWire["kind"],
                  });
                }}
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
              </select>
            </Row>
            <Row label="Arguments">
              <TokenList
                label="Agent argument"
                values={profile.args}
                onChange={(args) => {
                  replace(index, { ...profile, args });
                }}
              />
            </Row>
            <Row label="Environment">
              <div className="settings-tokens">
                {Object.entries(profile.env).map(([key, value]) => (
                  <div className="settings-token" key={key}>
                    <input
                      className="mac-field"
                      aria-label="Environment variable name"
                      value={key}
                      onChange={(event) => {
                        const env = { ...profile.env };
                        delete env[key];
                        env[event.target.value] = value;
                        replace(index, { ...profile, env });
                      }}
                    />
                    <input
                      className="mac-field settings-grow"
                      aria-label={`Value of ${key}`}
                      value={value}
                      onChange={(event) => {
                        replace(index, {
                          ...profile,
                          env: { ...profile.env, [key]: event.target.value },
                        });
                      }}
                    />
                    <button
                      type="button"
                      className="mac-icon-button"
                      aria-label={`Remove ${key}`}
                      onClick={() => {
                        const env = { ...profile.env };
                        delete env[key];
                        replace(index, { ...profile, env });
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="mac-button plain settings-token-add"
                  onClick={() => {
                    replace(index, {
                      ...profile,
                      env: { ...profile.env, NEW_VARIABLE: "" },
                    });
                  }}
                >
                  + Add
                </button>
              </div>
            </Row>
          </Group>
        </div>
      ))}
      <button
        type="button"
        className="mac-button settings-add"
        onClick={() => {
          update({
            ...config,
            agentProfiles: [
              ...config.agentProfiles,
              {
                id: `agent-${String(config.agentProfiles.length + 1)}`,
                displayName: "New Agent",
                kind: "codex",
                args: [],
                env: {},
              },
            ],
          });
        }}
      >
        Add Profile
      </button>
    </>
  );
}

function ResolvedValue({
  value,
}: {
  readonly value: SettingsRuntimeWire["resolved"]["shell"];
}) {
  if (value.kind === "unavailable") {
    return <span className="settings-badge warning">Not found</span>;
  }
  return <code className="mac-mono settings-resolved">{value.value}</code>;
}

function RuntimesSection({
  config,
  update,
  runtime,
  diagnostics,
  onRecheck,
  onOpenLogs,
  onCopyDiagnostics,
  socketDraft,
  onSocketDraft,
  onSocketChange,
  effectiveSocket,
  status,
  busy,
}: {
  readonly config: SettingsConfig;
  readonly update: (next: SettingsConfig) => void;
  readonly runtime: SettingsRuntimeWire;
  readonly diagnostics: SettingsSnapshot["diagnostics"];
  readonly onRecheck: () => void;
  readonly onOpenLogs: () => void;
  readonly onCopyDiagnostics: () => void;
  readonly socketDraft: string;
  readonly onSocketDraft: (next: string) => void;
  readonly onSocketChange: () => void;
  readonly effectiveSocket: string;
  readonly status?: string;
  readonly busy: boolean;
}) {
  const fields = [
    ["shell", "Shell"],
    ["git", "Git"],
    ["tmux", "tmux"],
    ["herdr", "Herdr"],
  ] as const;

  return (
    <>
      <p className="settings-intro mac-caption">
        A name is looked up on your PATH; a path is used as given. What DevHub
        found is shown under each one.
      </p>
      <Group>
        {fields.map(([field, label]) => (
          <Row key={field} label={label}>
            <input
              className="mac-field settings-grow"
              aria-label={`${label} command`}
              value={config.runtimes[field]}
              onChange={(event) => {
                update({
                  ...config,
                  runtimes: { ...config.runtimes, [field]: event.target.value },
                });
              }}
            />
            <ResolvedValue value={runtime.resolved[field]} />
          </Row>
        ))}
      </Group>

      <h2 className="mac-group-heading">Terminals</h2>
      <div className="mac-group">
        {/* The one setting that is not just a value in a file: DevHub's live
            sessions are on this socket, so the field holds what is being asked
            for and the button is what actually moves them. */}
        <Row
          label="tmux socket"
          help={
            socketDraft === effectiveSocket
              ? "DevHub keeps its terminal sessions on a socket of its own, so they survive quitting."
              : `DevHub is still using “${effectiveSocket}”. Changing the socket closes the sessions it has there.`
          }
        >
          <input
            className="mac-field settings-grow"
            aria-label="tmux socket name"
            value={socketDraft}
            onChange={(event) => {
              onSocketDraft(event.target.value);
            }}
          />
          <button
            type="button"
            className="mac-button"
            disabled={busy || socketDraft.trim() === effectiveSocket}
            onClick={onSocketChange}
          >
            Change…
          </button>
        </Row>
        <Row label="tmux options">
          <TokenList
            label="tmux option"
            values={config.runtimes.tmuxArgs}
            placeholder="-u"
            onChange={(tmuxArgs) => {
              update({ ...config, runtimes: { ...config.runtimes, tmuxArgs } });
            }}
          />
        </Row>
      </div>

      <h2 className="mac-group-heading">Diagnostics</h2>
      <div className="mac-group">
        <Row label="This session">
          <code className="mac-mono">{diagnostics.sessionId}</code>
        </Row>
        <Row label="Last quit">
          <span>
            {diagnostics.previousExit === "clean"
              ? "Normal"
              : diagnostics.previousExit === "unclean"
                ? "Unexpected"
                : "Unknown"}
          </span>
        </Row>
        <div className="mac-row full settings-actions">
          <button
            type="button"
            className="mac-button"
            onClick={onRecheck}
            disabled={busy}
          >
            Check Again
          </button>
          <button
            type="button"
            className="mac-button"
            onClick={onOpenLogs}
            disabled={busy}
          >
            Show Logs in Finder
          </button>
          <button
            type="button"
            className="mac-button"
            onClick={onCopyDiagnostics}
            disabled={busy}
          >
            Copy Summary
          </button>
          {status ? (
            <span className="mac-caption" role="status" aria-live="polite">
              {status}
            </span>
          ) : null}
        </div>
      </div>
    </>
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
  const set = (patch: Partial<SettingsConfig["appearance"]>) => {
    update({ ...config, appearance: { ...appearance, ...patch } });
  };

  return (
    <>
      <Group heading="Sidebar">
        <Row label="Density">
          <select
            className="mac-popup"
            aria-label="Sidebar density"
            value={appearance.sidebarDensity}
            onChange={(event) => {
              set({ sidebarDensity: event.target.value });
            }}
          >
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
          </select>
        </Row>
      </Group>

      <h2 className="mac-group-heading">Terminal</h2>
      <div className="mac-group">
        <Row label="Font">
          <input
            className="mac-field settings-grow"
            aria-label="Terminal font family"
            value={appearance.terminalFontFamily}
            onChange={(event) => {
              set({ terminalFontFamily: event.target.value });
            }}
          />
        </Row>
        <Row label="Size">
          <input
            className="mac-field"
            type="number"
            min={9}
            max={24}
            aria-label="Terminal font size"
            value={appearance.terminalFontSize}
            onChange={(event) => {
              set({ terminalFontSize: Number(event.target.value) });
            }}
          />
        </Row>
        <Row label="Line height">
          <input
            className="mac-field"
            type="number"
            min={1}
            max={2}
            step={0.05}
            aria-label="Terminal line height"
            value={appearance.terminalLineHeight}
            onChange={(event) => {
              set({ terminalLineHeight: Number(event.target.value) });
            }}
          />
        </Row>
        <Row label="Inset">
          <input
            className="mac-field"
            type="number"
            min={0}
            max={64}
            aria-label="Terminal margin"
            value={appearance.terminalMargin}
            onChange={(event) => {
              set({ terminalMargin: Number(event.target.value) });
            }}
          />
        </Row>
      </div>
    </>
  );
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
   * debounced only so that typing into a field is one write rather than one per
   * keystroke — and a write that fails says so, in place, without discarding
   * what the person typed.
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
              : `config.toml has a problem DevHub could not read: ${snapshot.diagnostic?.code ?? ""}`}
          </span>
          <button type="button" className="mac-button" onClick={reload}>
            Reload
          </button>
        </div>
      ) : null}

      <div className="settings-body">
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
              socketDraft={socketDraft ?? draft.runtimes.tmuxSocketName}
              onSocketDraft={setSocketDraft}
              onSocketChange={askToChangeSocket}
              effectiveSocket={snapshot.config.runtimes.tmuxSocketName}
              status={status}
              busy={busy}
            />
          ) : null}
          {section === "Appearance" ? (
            <AppearanceSection config={draft} update={update} />
          ) : null}
        </div>
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
