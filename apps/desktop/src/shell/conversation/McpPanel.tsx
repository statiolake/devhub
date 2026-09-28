/**
 * The MCP panel of a GUI Agent: what `/mcp` opens.
 *
 * Every MCP server the Agent's CLI reports, how it stands and where it is
 * configured, and what can be done about it — the actions its adapter offers
 * (`McpServer.actions`), drawn as they are offered, so one panel serves
 * Claude and Codex alike without asking which it is drawing. The list is the
 * CLI's answer to the status request the panel makes as it opens and that
 * every action it takes makes again when it is done.
 *
 * A sign-in (`Transcript.mcpSignIn`) is the CLI's own `mcp login` running on
 * the Agent's machine: what it prints is drawn as it prints it, with its
 * URLs as links to the default browser, and a line typed under it goes to
 * the command's prompt — which is where the redirect URL is pasted back when
 * the browser cannot reach the command by itself.
 *
 * It is drawn as a sheet the way DevHub's pickers are — the same scrim,
 * heading, list and aside — but it is not a `Picker`: it is not a question
 * with one answer, it stays up while its actions run and their outcomes come
 * back, and its aside takes typing. What fails is said where it happened: a
 * request the CLI refused in the footer (`McpState.failure`), a sign-in that
 * failed in the sign-in, and a call that could not be made at all at the
 * page's root, like every other.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  McpAction,
  McpServer,
  McpSignIn,
  McpState,
} from "../../model/conversation";
import { useInitialFocus } from "../picker/initialFocus";

export interface McpPanelActions {
  /** Ask the CLI how its MCP servers stand. */
  readonly refresh: () => Promise<void>;
  readonly act: (
    action: Exclude<McpAction, "sign-in">,
    server: string,
  ) => Promise<void>;
  readonly signIn: (server: string) => Promise<void>;
  readonly signInInput: (text: string) => Promise<void>;
  readonly cancelSignIn: () => Promise<void>;
  readonly dismissSignIn: () => Promise<void>;
  readonly openExternalUrl: (url: string) => Promise<void>;
  readonly reportFailure: (error: unknown) => void;
}

export interface McpPanelProps {
  /** The Agent's name, for the sentence under the title. */
  readonly label: string;
  readonly mcp: McpState;
  readonly signIn: McpSignIn | undefined;
  readonly actions: McpPanelActions;
  readonly onClose: () => void;
}

const STATUS_WORDS: Readonly<Record<McpServer["status"], string>> = {
  connected: "Connected",
  "needs-sign-in": "Needs sign-in",
  failed: "Failed",
  connecting: "Connecting…",
  disabled: "Disabled",
  unknown: "Unknown",
};

const ACTION_WORDS: Readonly<Record<McpAction, string>> = {
  "sign-in": "Sign In…",
  reconnect: "Reconnect",
  enable: "Enable",
  disable: "Disable",
};

/** How a server's status reads: DevHub's word, and the CLI's when DevHub has none. */
export function statusText(server: McpServer): string {
  return server.status === "unknown"
    ? `${STATUS_WORDS.unknown} (${server.said})`
    : STATUS_WORDS[server.status];
}

export function McpPanel({
  label,
  mcp,
  signIn,
  actions,
  onClose,
}: McpPanelProps) {
  const headingId = useId();
  const questionId = useId();
  const sheet = useInitialFocus<HTMLElement>();
  const { refresh, reportFailure } = actions;
  // Asked as it opens: what the CLI said last may be a turn old.
  useEffect(() => {
    void refresh().catch(reportFailure);
  }, [refresh, reportFailure]);

  const servers = mcp.servers;
  const [selected, setSelected] = useState<string | undefined>(signIn?.server);
  const current =
    servers?.find((server) => server.name === selected) ?? servers?.[0];

  const move = (delta: 1 | -1) => {
    if (servers === undefined || servers.length === 0) return;
    const at = servers.findIndex((server) => server.name === current?.name);
    const next = (at + delta + servers.length) % servers.length;
    setSelected(servers[next]!.name);
  };

  return createPortal(
    <div
      className="mac-scrim mac"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={sheet}
        tabIndex={-1}
        className="mac-sheet picker mcp-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={questionId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          // Typing in the sign-in's field is typing, not moving.
          if (event.target instanceof HTMLInputElement) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            move(event.key === "ArrowDown" ? 1 : -1);
          }
        }}
      >
        <header className="picker-header">
          <div className="picker-heading">
            <h2 className="picker-title" id={headingId}>
              MCP Servers
            </h2>
          </div>
          <p className="picker-question mac-caption" id={questionId}>
            {`${label}'s MCP servers, as its CLI reports them.`}
          </p>
        </header>
        <div className="picker-body has-aside">
          <div className="picker-list">
            {servers === undefined ? (
              <p className="picker-empty mac-caption" role="status">
                Asking the CLI…
              </p>
            ) : servers.length === 0 ? (
              <p className="picker-empty mac-caption" role="status">
                No MCP servers are configured for this Agent.
              </p>
            ) : null}
            <ul
              className="mac-list picker-results"
              role="listbox"
              aria-label="MCP servers"
              hidden={servers === undefined || servers.length === 0}
            >
              {(servers ?? []).map((server) => (
                <li key={server.name}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={server.name === current?.name}
                    className="mac-list-row"
                    tabIndex={-1}
                    onClick={() => setSelected(server.name)}
                  >
                    <span
                      className={`mcp-status-dot mcp-status-${server.status}`}
                      aria-hidden="true"
                    />
                    <span className="mac-list-text">
                      <span className="mac-list-title">{server.name}</span>
                      <span className="mac-list-subtitle mac-caption">
                        {statusText(server)}
                        {server.source === undefined
                          ? ""
                          : ` · ${server.source}`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <aside className="picker-aside">
            {current === undefined ? null : (
              <ServerDetail
                server={current}
                working={mcp.working.some(
                  (each) => each.server === current.name,
                )}
                signIn={signIn?.server === current.name ? signIn : undefined}
                signingInElsewhere={
                  signIn?.phase === "running" && signIn.server !== current.name
                    ? signIn.server
                    : undefined
                }
                actions={actions}
              />
            )}
          </aside>
        </div>
        <footer className="picker-footer">
          {mcp.failure === undefined && mcp.pluginErrors.length === 0 ? null : (
            <div className="picker-note mac-caption" role="status">
              {mcp.failure === undefined ? null : (
                <span className="picker-note-failure">{mcp.failure}</span>
              )}
              {mcp.pluginErrors.map((error) => (
                <span key={error.plugin} className="picker-note-failure">
                  {`Plugin ${error.plugin} did not load: ${error.message}`}
                </span>
              ))}
            </div>
          )}
          <div className="picker-actions">
            <button type="button" className="mac-button" onClick={onClose}>
              Close
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function ServerDetail({
  server,
  working,
  signIn,
  signingInElsewhere,
  actions,
}: {
  readonly server: McpServer;
  readonly working: boolean;
  readonly signIn: McpSignIn | undefined;
  readonly signingInElsewhere: string | undefined;
  readonly actions: McpPanelActions;
}) {
  const { reportFailure } = actions;
  const running = signIn?.phase === "running";
  return (
    <div className="mcp-detail">
      <h3 className="mcp-detail-name">{server.name}</h3>
      <dl className="mcp-detail-facts">
        <dt>Status</dt>
        <dd>
          {statusText(server)}
          {working ? " — working…" : ""}
        </dd>
        <dt>Source</dt>
        <dd>{server.source ?? "Not reported"}</dd>
        {server.error === undefined ? null : (
          <>
            <dt>Reason</dt>
            <dd className="mcp-detail-error">{server.error}</dd>
          </>
        )}
      </dl>
      <div className="mcp-detail-actions">
        {server.actions.map((action) => (
          <button
            key={action}
            type="button"
            className="mac-button"
            disabled={
              working ||
              (action === "sign-in" &&
                (running || signingInElsewhere !== undefined))
            }
            onClick={() => {
              const done =
                action === "sign-in"
                  ? actions.signIn(server.name)
                  : actions.act(action, server.name);
              void done.catch(reportFailure);
            }}
          >
            {ACTION_WORDS[action]}
          </button>
        ))}
      </div>
      {signingInElsewhere === undefined ? null : (
        <p className="mac-caption">
          {`Signing in to ${signingInElsewhere}: one sign-in runs at a time.`}
        </p>
      )}
      {signIn === undefined ? null : (
        <SignInView signIn={signIn} actions={actions} />
      )}
    </div>
  );
}

const URL_PATTERN = /https?:\/\/[^\s"'<>`]+/gu;

/** Text with every URL in it a link that opens in the default browser. */
function Linked({
  text,
  open,
}: {
  readonly text: string;
  readonly open: (url: string) => void;
}) {
  const parts = useMemo(() => {
    const out: { readonly text: string; readonly url: boolean }[] = [];
    let at = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
      const index = match.index;
      if (index > at) out.push({ text: text.slice(at, index), url: false });
      out.push({ text: match[0], url: true });
      at = index + match[0].length;
    }
    if (at < text.length) out.push({ text: text.slice(at), url: false });
    return out;
  }, [text]);
  return (
    <>
      {parts.map((part, index) =>
        part.url ? (
          <a
            key={index}
            href={part.text}
            onClick={(event) => {
              event.preventDefault();
              open(part.text);
            }}
          >
            {part.text}
          </a>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

function SignInView({
  signIn,
  actions,
}: {
  readonly signIn: McpSignIn;
  readonly actions: McpPanelActions;
}) {
  const { reportFailure } = actions;
  const [line, setLine] = useState("");
  const output = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const element = output.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [signIn.output]);
  const running = signIn.phase === "running";
  const { callback } = signIn;
  return (
    <section className="mcp-sign-in" aria-label={`Sign-in to ${signIn.server}`}>
      <h4 className="mcp-sign-in-title">
        {running
          ? `Signing in to ${signIn.server}…`
          : signIn.phase === "succeeded"
            ? `Signed in to ${signIn.server}`
            : `The sign-in to ${signIn.server} failed`}
      </h4>
      <pre ref={output} className="mcp-sign-in-output">
        <Linked
          text={signIn.output}
          open={(url) => {
            void actions.openExternalUrl(url).catch(reportFailure);
          }}
        />
      </pre>
      {callback === undefined ? null : callback.kind === "forwarded" ? (
        <p className="mac-caption">
          {`localhost:${String(callback.port)} on this Mac is forwarded to ${callback.to} while the sign-in runs, so the browser's redirect reaches it.`}
        </p>
      ) : (
        <p className="mac-caption picker-note-failure">
          {`localhost:${String(callback.port)} could not be forwarded: ${callback.why} Paste the address the browser ends on below instead.`}
        </p>
      )}
      {signIn.failure === undefined ? null : (
        <p className="mac-caption picker-note-failure" role="alert">
          {signIn.failure}
        </p>
      )}
      {running ? (
        <form
          className="mcp-sign-in-input"
          onSubmit={(event) => {
            event.preventDefault();
            const typed = line;
            void actions.signInInput(typed).then(() => {
              setLine((now) => (now === typed ? "" : now));
            }, reportFailure);
          }}
        >
          <input
            type="text"
            className="mac-field"
            aria-label="Type at the sign-in's prompt"
            placeholder="Paste the redirect URL here if the command asks for it"
            value={line}
            onChange={(event) => setLine(event.target.value)}
          />
          <button type="submit" className="mac-button">
            Send
          </button>
          <button
            type="button"
            className="mac-button"
            onClick={() => void actions.cancelSignIn().catch(reportFailure)}
          >
            Cancel Sign-In
          </button>
        </form>
      ) : (
        <div className="mcp-detail-actions">
          <button
            type="button"
            className="mac-button"
            onClick={() => void actions.dismissSignIn().catch(reportFailure)}
          >
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
}
