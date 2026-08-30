/**
 * The five screens.
 *
 * Grouped by what a person is doing, the way a Mac's panes are — not by which
 * TOML table a value happens to live in. That is the whole of the information
 * architecture, and it is why "Runtimes" is gone: it held the four executables,
 * the tmux socket and the diagnostics, three unrelated errands under one word,
 * while everything else about the terminal sat in "Appearance". Anyone looking
 * for something about their terminal had to know which of the two to open.
 *
 *   General    what DevHub does for the whole app
 *   Workspaces where the workspace picker looks       (a collection)
 *   Agents     what can be launched in a workspace    (a collection)
 *   Terminal   how DevHub's terminals look and where they live
 *   Advanced   the programs DevHub runs, and diagnostics
 *
 * The two collections are list–detail, the rest are forms. Nothing here opens a
 * second screen: the one thing in the window that is a decision rather than a
 * value — moving the tmux socket — is a sheet, because it is a question with an
 * answer, and every value is applied where it is typed.
 */

import { useState } from "react";
import type {
  SettingsAgentProfileWire,
  SettingsConfig,
  SettingsRuntimeWire,
  SettingsSnapshot,
  SettingsWorkspaceSourceWire,
} from "../ipc/settings";
import { FONT_FAMILY_RULE, isValidFontFamily } from "../model/fontFamily";
import { Collection } from "./Collection";
import {
  Group,
  NumberField,
  Popup,
  Row,
  SwitchRow,
  TextField,
  TokenList,
  WideRow,
} from "./controls";
import {
  argumentProblem,
  choiceOf,
  displayNameProblem,
  environmentNameProblem,
  excludeNameProblem,
  idProblem,
  kindsOf,
  MATCH_CHOICES,
  runtimeProblem,
  socketProblem,
  workspacePathProblem,
  type MatchChoice,
} from "./rules";

type Update = (next: SettingsConfig) => void;

// ----------------------------------------------------------------- general

export function GeneralSection({
  config,
  update,
}: {
  readonly config: SettingsConfig;
  readonly update: Update;
}) {
  return (
    <Form>
      <Group heading="Environment">
        <SwitchRow
          label="Login shell"
          help="Use your login shell's environment when DevHub launches terminals and agents."
          checked={config.general.importLoginEnvironment}
          onChange={(importLoginEnvironment) => {
            update({ ...config, general: { importLoginEnvironment } });
          }}
        />
      </Group>

      <Group heading="Sidebar">
        <Row label="Density" help="How much room a workspace row takes.">
          <Popup
            label="Sidebar density"
            value={config.appearance.sidebarDensity}
            options={[
              ["compact", "Compact"],
              ["comfortable", "Comfortable"],
            ]}
            onChange={(sidebarDensity) => {
              update({
                ...config,
                appearance: { ...config.appearance, sidebarDensity },
              });
            }}
          />
        </Row>
      </Group>
    </Form>
  );
}

// -------------------------------------------------------------- workspaces

/** The first `source-n` nobody is using, so a new entry is never a duplicate. */
function freeId(prefix: string, taken: readonly string[]): string {
  for (let n = 1; ; n += 1) {
    const candidate = `${prefix}-${String(n)}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

function FolderGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M1.8 4.4a1.1 1.1 0 0 1 1.1-1.1h2.9l1.4 1.6h5.1a1.1 1.1 0 0 1 1.1 1.1v5.6a1.1 1.1 0 0 1-1.1 1.1H2.9a1.1 1.1 0 0 1-1.1-1.1z" />
    </svg>
  );
}

function CommandGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" />
      <path d="M4.6 6.4 6.6 8.4l-2 2M8.6 10.6h3" />
    </svg>
  );
}

function AgentGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2.6" y="4.6" width="10.8" height="8" rx="2" />
      <circle cx="5.9" cy="8.6" r="0.85" />
      <circle cx="10.1" cy="8.6" r="0.85" />
      <path d="M8 2.2v2.4" />
    </svg>
  );
}

export function WorkspacesSection({
  config,
  update,
}: {
  readonly config: SettingsConfig;
  readonly update: Update;
}) {
  const sources = config.workspaceSources;
  const [wanted, setWanted] = useState(0);
  const selected =
    sources.length === 0 ? undefined : Math.min(wanted, sources.length - 1);
  const source = selected === undefined ? undefined : sources[selected];

  const replace = (next: SettingsWorkspaceSourceWire) => {
    update({
      ...config,
      workspaceSources: sources.map((item, position) =>
        position === selected ? next : item,
      ),
    });
  };

  const otherIds = sources
    .filter((_, position) => position !== selected)
    .map((item) => item.id);

  return (
    <Collection
      label="Workspace sources"
      entries={sources.map((item) => ({
        key: item.id,
        title: item.id,
        note: item.type === "filesystem" ? item.path : item.command.join(" "),
        glyph: item.type === "filesystem" ? <FolderGlyph /> : <CommandGlyph />,
      }))}
      selected={selected}
      onSelect={setWanted}
      addLabel="Add Source"
      onAdd={() => {
        setWanted(sources.length);
        update({
          ...config,
          workspaceSources: [
            ...sources,
            {
              type: "filesystem",
              id: freeId(
                "source",
                sources.map((item) => item.id),
              ),
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
      removeLabel="Remove Source"
      onRemove={() => {
        update({
          ...config,
          workspaceSources: sources.filter(
            (_, position) => position !== selected,
          ),
        });
      }}
      empty={{
        title: "No workspace sources",
        message:
          "A source is where the workspace picker looks. A folder source walks a folder; a command source runs a program that prints one path per line.",
      }}
    >
      {source ? (
        <>
          <Group heading="Source">
            <Row label="Identifier">
              <TextField
                label="Workspace source identifier"
                value={source.id}
                mono
                validate={(next) =>
                  otherIds.includes(next)
                    ? "Another source already has that identifier."
                    : idProblem(next)
                }
                onCommit={(id) => {
                  replace({ ...source, id });
                }}
              />
            </Row>
            <Row label="Kind">
              <Popup
                label="Workspace source kind"
                value={source.type}
                options={[
                  ["filesystem", "Folder"],
                  ["command", "Command"],
                ]}
                onChange={(type) => {
                  replace(
                    type === "command"
                      ? {
                          type: "command",
                          id: source.id,
                          // One empty argument, not none. A command source with
                          // no command at all is a config the loader refuses,
                          // so switching the popup used to be a change that
                          // could not be saved: the file kept the folder source
                          // while the window showed a command form. One blank
                          // argument is what the loader calls a command source,
                          // and it is a row visibly waiting to be typed into.
                          command: [""],
                          timeoutMs: 2000,
                        }
                      : {
                          type: "filesystem",
                          id: source.id,
                          path: "~",
                          minDepth: 1,
                          maxDepth: 2,
                          kinds: ["git_repository"],
                          includeHidden: false,
                          excludeNames: [],
                        },
                  );
                }}
              />
            </Row>
          </Group>

          {source.type === "filesystem" ? (
            <>
              <Group heading="Where to look">
                <Row label="Folder">
                  <TextField
                    label="Workspace root path"
                    value={source.path}
                    mono
                    placeholder="~/dev"
                    validate={workspacePathProblem}
                    onCommit={(path) => {
                      replace({ ...source, path });
                    }}
                  />
                </Row>
                <DepthRow
                  minDepth={source.minDepth}
                  maxDepth={source.maxDepth}
                  onChange={(minDepth, maxDepth) => {
                    replace({ ...source, minDepth, maxDepth });
                  }}
                />
                <Row label="Match">
                  <Popup<MatchChoice>
                    label="What to match"
                    value={choiceOf(source.kinds)}
                    options={MATCH_CHOICES}
                    onChange={(choice) => {
                      replace({ ...source, kinds: kindsOf(choice) });
                    }}
                  />
                </Row>
                <SwitchRow
                  label="Hidden folders"
                  help="Also offer folders whose name starts with a dot."
                  checked={source.includeHidden}
                  onChange={(includeHidden) => {
                    replace({ ...source, includeHidden });
                  }}
                />
              </Group>

              <Group heading="Ignore">
                <WideRow>
                  <TokenList
                    label="Skipped name"
                    addLabel="Add Name"
                    values={source.excludeNames}
                    placeholder="node_modules"
                    validate={excludeNameProblem}
                    onChange={(excludeNames) => {
                      replace({ ...source, excludeNames });
                    }}
                  />
                </WideRow>
              </Group>
            </>
          ) : (
            <>
              <Group
                heading="Command"
                note="The program is run with these arguments and nothing else — no shell, so quoting and globs are yours to expand."
              >
                <WideRow>
                  <TokenList
                    label="Argument"
                    addLabel="Add Argument"
                    values={source.command}
                    placeholder="ghq"
                    validate={argumentProblem}
                    onChange={(command) => {
                      replace({ ...source, command });
                    }}
                  />
                </WideRow>
              </Group>
              <Group heading="Limits">
                <Row
                  label="Timeout"
                  help="How long DevHub waits for the program to finish."
                >
                  <NumberField
                    label="Command timeout"
                    value={source.timeoutMs}
                    min={100}
                    max={30000}
                    unit="ms"
                    onCommit={(timeoutMs) => {
                      replace({ ...source, timeoutMs });
                    }}
                  />
                </Row>
              </Group>
            </>
          )}
        </>
      ) : null}
    </Collection>
  );
}

/**
 * How far below the folder to look.
 *
 * One row, because it is one decision: a maximum below the minimum is not a
 * narrower search, it is a config the loader refuses. Leaving the maximum empty
 * means "exactly the minimum", which is what the file means when the key is
 * absent, so the empty field says the same thing the absent key does.
 */
function DepthRow({
  minDepth,
  maxDepth,
  onChange,
}: {
  readonly minDepth: number;
  readonly maxDepth: number | null;
  readonly onChange: (minDepth: number, maxDepth: number | null) => void;
}) {
  return (
    <Row
      label="Depth"
      help="How many levels below the folder a workspace may be found."
    >
      <NumberField
        label="Minimum depth"
        value={minDepth}
        min={0}
        max={16}
        onCommit={(next) => {
          onChange(
            next,
            maxDepth !== null && maxDepth < next ? next : maxDepth,
          );
        }}
      />
      <span className="mac-caption">to</span>
      <TextField
        label="Maximum depth"
        value={maxDepth === null ? "" : String(maxDepth)}
        narrow
        placeholder={String(minDepth)}
        validate={(next) => {
          if (next.trim().length === 0) return undefined;
          const parsed = Number(next.trim());
          return Number.isInteger(parsed) && parsed >= minDepth && parsed <= 16
            ? undefined
            : `A maximum depth is empty — the same as the minimum — or a whole number between ${String(minDepth)} and 16.`;
        }}
        onCommit={(next) => {
          onChange(
            minDepth,
            next.trim().length === 0 ? null : Number(next.trim()),
          );
        }}
      />
    </Row>
  );
}

// ------------------------------------------------------------------ agents

export function AgentsSection({
  config,
  update,
}: {
  readonly config: SettingsConfig;
  readonly update: Update;
}) {
  const profiles = config.agentProfiles;
  const [wanted, setWanted] = useState(0);
  const selected =
    profiles.length === 0 ? undefined : Math.min(wanted, profiles.length - 1);
  const profile = selected === undefined ? undefined : profiles[selected];

  const replace = (next: SettingsAgentProfileWire) => {
    update({
      ...config,
      agentProfiles: profiles.map((item, position) =>
        position === selected ? next : item,
      ),
    });
  };

  const otherIds = profiles
    .filter((_, position) => position !== selected)
    .map((item) => item.id);

  return (
    <Collection
      label="Agent profiles"
      entries={profiles.map((item) => ({
        key: item.id,
        title: item.displayName,
        note: item.id,
        glyph: <AgentGlyph />,
      }))}
      selected={selected}
      onSelect={setWanted}
      addLabel="Add Profile"
      onAdd={() => {
        setWanted(profiles.length);
        update({
          ...config,
          agentProfiles: [
            ...profiles,
            {
              id: freeId(
                "agent",
                profiles.map((item) => item.id),
              ),
              displayName: "New Agent",
              kind: "codex",
              args: [],
              env: {},
            },
          ],
        });
      }}
      removeLabel="Remove Profile"
      onRemove={() => {
        update({
          ...config,
          agentProfiles: profiles.filter(
            (_, position) => position !== selected,
          ),
        });
      }}
      empty={{
        title: "No agent profiles",
        message:
          "A profile is an agent you can launch in a workspace: which program it is, and what it is started with.",
      }}
    >
      {profile ? (
        <>
          <Group heading="Profile">
            <Row label="Name" help="What the sidebar calls it.">
              <TextField
                label="Agent display name"
                value={profile.displayName}
                validate={displayNameProblem}
                onCommit={(displayName) => {
                  replace({ ...profile, displayName });
                }}
              />
            </Row>
            <Row label="Identifier" help="What config.toml calls it.">
              <TextField
                label="Agent profile identifier"
                value={profile.id}
                mono
                validate={(next) =>
                  otherIds.includes(next)
                    ? "Another profile already has that identifier."
                    : idProblem(next)
                }
                onCommit={(id) => {
                  replace({ ...profile, id });
                }}
              />
            </Row>
            <Row label="Runtime">
              <Popup
                label="Agent runtime"
                value={profile.kind}
                options={[
                  ["codex", "Codex"],
                  ["claude", "Claude"],
                ]}
                onChange={(kind) => {
                  replace({ ...profile, kind });
                }}
              />
            </Row>
          </Group>

          <Group heading="Arguments">
            <WideRow>
              <TokenList
                label="Argument"
                addLabel="Add Argument"
                values={profile.args}
                placeholder="--model"
                validate={argumentProblem}
                onChange={(args) => {
                  replace({ ...profile, args });
                }}
              />
            </WideRow>
          </Group>

          <Group
            heading="Environment"
            note="These values stay on this machine: Copy Summary in Advanced never includes them."
          >
            <WideRow>
              <EnvironmentList
                env={profile.env}
                onChange={(env) => {
                  replace({ ...profile, env });
                }}
              />
            </WideRow>
          </Group>
        </>
      ) : null}
    </Collection>
  );
}

/**
 * A variable name nobody is using. Underscores, not dashes: an environment
 * name is not an identifier, and `VAR-1` would be refused on sight.
 */
function freeEnvName(taken: readonly string[]): string {
  for (let n = 1; ; n += 1) {
    const candidate = `VARIABLE_${String(n)}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/**
 * The environment a profile adds, as ordered pairs.
 *
 * The wire shape is a map, but a map has no order and the rows on screen do, so
 * the edit is done over the entries and turned back into a map at the end. A
 * rename therefore stays where it was rather than jumping to the bottom, which
 * is what deleting and re-adding the key would do.
 */
function EnvironmentList({
  env,
  onChange,
}: {
  readonly env: Record<string, string>;
  readonly onChange: (next: Record<string, string>) => void;
}) {
  const entries = Object.entries(env);
  const commit = (next: (readonly [string, string])[]) => {
    onChange(Object.fromEntries(next));
  };

  return (
    <div className="sf-tokens" aria-label="Environment">
      {entries.map(([key, value], index) => (
        <div className="sf-token sf-token-pair" key={index}>
          <TextField
            label={`Environment variable ${String(index + 1)} name`}
            value={key}
            mono
            validate={(next) =>
              entries.some(
                ([other], position) => position !== index && other === next,
              )
                ? "That variable is already set above."
                : environmentNameProblem(next)
            }
            onCommit={(name) => {
              commit(
                entries.map((entry, position) =>
                  position === index ? ([name, value] as const) : entry,
                ),
              );
            }}
          />
          <TextField
            label={`Value of ${key}`}
            value={value}
            mono
            validate={argumentProblem}
            onCommit={(next) => {
              commit(
                entries.map((entry, position) =>
                  position === index ? ([key, next] as const) : entry,
                ),
              );
            }}
          />
          <button
            type="button"
            className="mac-icon-button"
            aria-label={`Remove ${key}`}
            onClick={() => {
              commit(entries.filter((_, position) => position !== index));
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" className="sf-glyph">
              <path d="M4 8h8" />
            </svg>
          </button>
        </div>
      ))}
      {entries.length === 0 ? (
        <p className="sf-note mac-caption">None.</p>
      ) : null}
      <button
        type="button"
        className="mac-button plain sf-token-add"
        onClick={() => {
          commit([...entries, [freeEnvName(Object.keys(env)), ""]]);
        }}
      >
        Add Variable
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- terminal

export function TerminalSection({
  config,
  update,
  socketDraft,
  onSocketDraft,
  onSocketChange,
  effectiveSocket,
  busy,
}: {
  readonly config: SettingsConfig;
  readonly update: Update;
  readonly socketDraft: string;
  readonly onSocketDraft: (next: string) => void;
  readonly onSocketChange: () => void;
  readonly effectiveSocket: string;
  readonly busy: boolean;
}) {
  const appearance = config.appearance;
  const set = (patch: Partial<SettingsConfig["appearance"]>) => {
    update({ ...config, appearance: { ...appearance, ...patch } });
  };
  const args = config.runtimes.tmuxArgs;
  const setArgs = (option: "-u" | "-2", on: boolean) => {
    update({
      ...config,
      runtimes: {
        ...config.runtimes,
        tmuxArgs: on
          ? [...args.filter((item) => item !== option), option]
          : args.filter((item) => item !== option),
      },
    });
  };
  const asked = socketDraft.trim();
  const moved = asked.length > 0 && asked !== effectiveSocket;

  return (
    <Form>
      <Group heading="Text">
        <Row label="Font">
          <TextField
            label="Terminal font family"
            value={appearance.terminalFontFamily}
            placeholder="ui-monospace"
            mono
            validate={(next) =>
              isValidFontFamily(next) ? undefined : FONT_FAMILY_RULE
            }
            onCommit={(terminalFontFamily) => {
              set({ terminalFontFamily });
            }}
          />
        </Row>
        <Row label="Size">
          <NumberField
            label="Terminal font size"
            value={appearance.terminalFontSize}
            min={9}
            max={24}
            unit="pt"
            onCommit={(terminalFontSize) => {
              set({ terminalFontSize });
            }}
          />
        </Row>
        <Row label="Line height">
          <NumberField
            label="Terminal line height"
            value={appearance.terminalLineHeight}
            min={1}
            max={2}
            unit="×"
            onCommit={(terminalLineHeight) => {
              set({ terminalLineHeight });
            }}
          />
        </Row>
        <Row label="Inset" help="Space between the text and the pane's edge.">
          <NumberField
            label="Terminal margin"
            value={appearance.terminalMargin}
            min={0}
            max={64}
            unit="px"
            onCommit={(terminalMargin) => {
              set({ terminalMargin });
            }}
          />
        </Row>
      </Group>

      {/*
        The one setting in this window that is a decision rather than a value.
        Everything above applies where it is typed; DevHub's live sessions are
        on this socket, so moving to another one moves them — the field holds
        what is being asked for, and the button (with the ellipsis a Mac uses to
        say "this will ask first") is what actually moves them.
      */}
      <Group
        heading="tmux"
        note="DevHub keeps its terminal sessions on a socket of its own, so they survive quitting. Everything else on this screen applies as you change it; the socket asks first, because changing it closes the sessions DevHub has there."
      >
        <Row
          label="Socket"
          help={
            moved
              ? `Not applied — DevHub is still using “${effectiveSocket}”.`
              : undefined
          }
        >
          <TextField
            label="tmux socket name"
            value={socketDraft}
            mono
            validate={socketProblem}
            onCommit={onSocketDraft}
            trailing={
              <button
                type="button"
                className="mac-button"
                disabled={busy || !moved || socketProblem(asked) !== undefined}
                onClick={onSocketChange}
              >
                Change…
              </button>
            }
          />
        </Row>
        <Row label="Options">
          <div className="sf-checks">
            <label className="sf-check">
              <input
                type="checkbox"
                checked={args.includes("-u")}
                onChange={(event) => {
                  setArgs("-u", event.target.checked);
                }}
              />
              Force UTF-8 <code className="mac-mono">-u</code>
            </label>
            <label className="sf-check">
              <input
                type="checkbox"
                checked={args.includes("-2")}
                onChange={(event) => {
                  setArgs("-2", event.target.checked);
                }}
              />
              Force 256 colours <code className="mac-mono">-2</code>
            </label>
          </div>
        </Row>
      </Group>
    </Form>
  );
}

// ---------------------------------------------------------------- advanced

function ResolvedValue({
  value,
}: {
  readonly value: SettingsRuntimeWire["resolved"]["shell"];
}) {
  if (value.kind === "unavailable") {
    return <span className="sf-badge warning">Not found</span>;
  }
  return <code className="mac-mono sf-resolved">{value.value}</code>;
}

export function AdvancedSection({
  config,
  update,
  runtime,
  diagnostics,
  onRecheck,
  onOpenLogs,
  onCopyDiagnostics,
  status,
  busy,
}: {
  readonly config: SettingsConfig;
  readonly update: Update;
  readonly runtime: SettingsRuntimeWire;
  readonly diagnostics: SettingsSnapshot["diagnostics"];
  readonly onRecheck: () => void;
  readonly onOpenLogs: () => void;
  readonly onCopyDiagnostics: () => void;
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
    <Form>
      <Group
        heading="Programs"
        note="A bare name is looked up on your PATH; a path is used as given. What DevHub found is shown under each one."
      >
        {fields.map(([field, label]) => (
          <Row
            key={field}
            label={label}
            help={<ResolvedValue value={runtime.resolved[field]} />}
          >
            <TextField
              label={`${label} command`}
              value={config.runtimes[field]}
              mono
              validate={runtimeProblem}
              onCommit={(next) => {
                update({
                  ...config,
                  runtimes: { ...config.runtimes, [field]: next },
                });
              }}
            />
          </Row>
        ))}
      </Group>

      <Group heading="Diagnostics">
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
        <Row>
          <div className="sf-actions">
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
        </Row>
      </Group>
    </Form>
  );
}

// ------------------------------------------------------------------ shared

/** A screen that is a form: one centred column, scrolling on its own. */
function Form({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="sf-form">
      <div className="sf-column">{children}</div>
    </div>
  );
}
