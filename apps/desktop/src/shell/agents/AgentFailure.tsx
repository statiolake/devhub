import { useId, useState, type ReactNode } from "react";
import type { AgentFailureStateWire, AgentWire } from "../../ipc/appShell";
import { agentRestart } from "../../model/domain";
import {
  agentFailureSummary,
  agentFailureTitle,
} from "../components/shell/diagnosticLabel";
import { useInitialFocus } from "../picker/initialFocus";
import { useAgents } from "./AgentsContext";
import { devhub } from "./client";

/**
 * A failure about the Agent on screen, over the Agent on screen.
 *
 * **One surface for every failure an Agent has**, a GUI Agent's conversation
 * or a terminal Agent's runtime alike: a sheet in the middle of the pane, over
 * the pane dimmed, so what the Agent said up to the failure stays in view
 * behind it — for a CLI that could not sign in, what it said is the reason.
 * It covers this pane and nothing else: the Sidebar, the workbench and every
 * other Agent stay usable.
 *
 * It says what failed (the title), the code's own sentence and the detail the
 * raising site carried — the CLI's words and the fix — and offers:
 *
 * - **Try again**, where Restart Session can be taken (`agentRestart`, the one
 *   rule the coordinator refuses by): the same `restart_agent` as the
 *   Sidebar's menu. A CLI that stopped itself has nothing running, so nothing
 *   is asked first (`interruptsNothing`).
 * - The way out the failure has (a terminal to sign in in, or the
 *   conversation carried on in a terminal).
 * - **Dismiss**, which puts the sheet away and leaves a banner at the top of
 *   the pane that says the same thing in a line and offers the same actions.
 *
 * How long it stands is one rule, whatever the failure: the sheet is up from
 * the moment a failure appears until the person dismisses it; the failure
 * itself — sheet or banner — is drawn for as long as the Agent's readings say
 * it (the next reading that does not retires it); and a different failure
 * (another code or detail) is a new one, asked about with the sheet again.
 * The caller keys this component by the failure to make that so.
 */
export function AgentFailure({
  agent,
  failure,
}: {
  readonly agent: AgentWire;
  readonly failure: AgentFailureStateWire;
}) {
  const { dispatch, reportFailure } = useAgents();
  const [dismissed, setDismissed] = useState(false);
  const [trying, setTrying] = useState(false);

  const tryAgain =
    agent.controlState.kind === "running" &&
    agentRestart(agent).kind === "available"
      ? () => {
          setTrying(true);
          dispatch({ type: "restart_agent", agentId: agent.id })
            .catch(reportFailure)
            .finally(() => setTrying(false));
        }
      : undefined;
  const ways = wayOut(failure, {
    openTerminal: () =>
      dispatch({
        type: "request_create_agent",
        workspaceId: agent.workspaceId,
        profileId: agent.profileId,
        presentation: "tui",
      }).catch(reportFailure),
    continueInTerminal: () =>
      devhub().conversation.continueInTerminal(agent.id).catch(reportFailure),
  });

  const title = agentFailureTitle(failure.code);
  const actions = (
    <>
      {ways.map((way) => (
        <button
          key={way.label}
          type="button"
          className="mac-button"
          onClick={way.run}
        >
          {way.label}
        </button>
      ))}
      {dismissed ? null : (
        <button
          type="button"
          className="mac-button"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </button>
      )}
      {tryAgain === undefined ? null : (
        <button
          type="button"
          className="mac-button default"
          disabled={trying}
          onClick={tryAgain}
        >
          Try again
        </button>
      )}
    </>
  );

  return dismissed ? (
    <div className="mac agent-failure-banner" role="alert">
      <span className="agent-failure-banner-text">
        <strong>{title}</strong> {agentFailureSummary(failure.code)}
      </span>
      <span className="agent-failure-banner-actions">{actions}</span>
    </div>
  ) : (
    <FailureSheet
      title={title}
      summary={agentFailureSummary(failure.code)}
      detail={failure.detail}
      onDismiss={() => setDismissed(true)}
    >
      {actions}
    </FailureSheet>
  );
}

function FailureSheet({
  title,
  summary,
  detail,
  onDismiss,
  children,
}: {
  readonly title: string;
  readonly summary: string;
  readonly detail: string | undefined;
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}) {
  const headingId = useId();
  const summaryId = useId();
  const sheet = useInitialFocus<HTMLElement>();
  return (
    <div className="mac-scrim mac agent-failure-scrim" role="presentation">
      <section
        ref={sheet}
        tabIndex={-1}
        className="mac-sheet picker agent-failure-sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={summaryId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onDismiss();
          }
        }}
      >
        <header className="picker-header">
          <div className="picker-heading">
            <h2 className="picker-title" id={headingId}>
              {title}
            </h2>
          </div>
          <p className="picker-question mac-caption" id={summaryId}>
            {summary}
          </p>
        </header>
        {detail === undefined || detail.trim().length === 0 ? null : (
          <p className="agent-failure-detail">{withCode(detail)}</p>
        )}
        <footer className="picker-footer">
          <div className="picker-actions">{children}</div>
        </footer>
      </section>
    </div>
  );
}

/** A detail's `code` spans — the commands it names — drawn as code. */
function withCode(detail: string): ReactNode {
  return detail
    .split("`")
    .map((part, index) =>
      index % 2 === 1 ? <code key={index}>{part}</code> : part,
    );
}

interface WayOut {
  readonly label: string;
  readonly run: () => void;
}

/**
 * The way out of a conversation that has stopped (design §6.1): the Agent's
 * own CLI in a terminal. Signed out is a terminal Agent from the same
 * profile, on the same machine, where the CLI's own sign-in runs; a
 * conversation DevHub cannot follow is carried on there, resuming its
 * session. A terminal Agent's failures have none: a terminal is already where
 * it is.
 */
function wayOut(
  failure: AgentFailureStateWire,
  ways: {
    readonly openTerminal: () => void;
    readonly continueInTerminal: () => void;
  },
): readonly WayOut[] {
  switch (failure.code) {
    case "conversation_not_signed_in":
      return [{ label: "Open a terminal to sign in", run: ways.openTerminal }];
    case "conversation_host_lost":
    case "conversation_protocol_mismatch":
    case "conversation_refused":
    case "conversation_failed":
      return [{ label: "Continue in terminal", run: ways.continueInTerminal }];
    default:
      return [];
  }
}
