/**
 * "Close this workspace?" and "Stop this agent?", drawn on the modal layer.
 *
 * The question is raised by whatever the person clicked in the App Shell page,
 * answered here, and carried out by main. The sheet adopts the confirmation
 * into this page's own model client, so the retry-on-failure and
 * replaced-confirmation rules are the ones the provider already has rather
 * than a second copy of them living in a component.
 *
 * **Two answers, so two rows.** It was an alert with two buttons, which made a
 * confirmation the one kind of question in DevHub with a keyboard of its own:
 * Return meant "the rightmost button" rather than "the row I am on", and the
 * safe answer was the one furthest from the default. A confirmation is a list
 * with as many rows as there are answers and the safe one first — see
 * `Picker`'s docstring — so Cancel leads, Return takes it, and Escape means
 * what Cancel means.
 *
 * What was going to be closed used to be a table under the message. It is the
 * note under the list now, which is the same place in the sheet and the same
 * sentence: these are facts about the question, not answers to it, and they
 * are the whole reason a person hesitates over this one.
 *
 * A close that fails is not swallowed and not silently retried: the
 * confirmation stays — the provider keeps it, because a failed request has not
 * consumed main's one-shot operation — and the sheet re-asks with the failure
 * written under the list. The picker locks onto the row it took, so re-asking
 * is remounting it, exactly as in `AgentRenameSheet`.
 */

import { useEffect, useState } from "react";
import { useAppShell } from "../useAppShell";
import { Picker } from "../components/shell/Picker";
import type { CloseResourceWire } from "../../ipc/appShell";
import type { ModalRequest } from "../../ipc/contract";

export type CloseConfirmationRequest = Extract<
  ModalRequest,
  { kind: "close-confirmation" }
>;

function closeResourceStatus(resource: CloseResourceWire): string {
  switch (resource.kind) {
    case "clean":
      return "Ready";
    case "busy":
      return `${String(resource.count)} busy`;
    case "unknown":
      switch (resource.diagnostic) {
        case "root_missing":
          return "Could not verify: workspace root is missing";
        case "root_inaccessible":
          return "Could not verify: workspace root is inaccessible";
        case "close_agents_unknown":
          return "Could not verify agents";
        case "close_terminal_unknown":
          return "Could not verify terminal state";
        case "close_editor_unknown":
          return "Could not verify editor state";
        case "close_editor_starting":
          return "Could not verify: the editor is still starting";
        case "close_editor_unresponsive":
          return "Could not verify: the editor is not answering";
        case "close_editor_vetoed":
          return "The editor has unsaved changes";
        case "cleanup_failed":
          return "Could not verify cleanup state";
        case "runtime_unavailable":
          return "Could not verify: runtime unavailable";
      }
  }
}

/** The safe row, and therefore the first one. */
const CANCEL = "devhub:cancel";
/** The row that does the thing being asked about. */
const CONFIRM = "devhub:confirm";

export interface CloseConfirmationSheetProps {
  readonly request: CloseConfirmationRequest;
  readonly onDismiss: () => void;
}

export function CloseConfirmationSheet({
  request,
  onDismiss,
}: CloseConfirmationSheetProps) {
  const {
    state,
    pendingConfirmation,
    confirmPending,
    dismissCloseConfirmation,
    adoptConfirmation,
  } = useAppShell();

  /**
   * Whether this page's model client has taken the confirmation on yet.
   *
   * Adoption is a state change in the provider, so it cannot be visible in the
   * commit that asks for it: on the frame this sheet mounts there is no
   * pending confirmation, and reading that as "somebody answered it" made
   * every confirmation close its own modal the instant it opened — the layer
   * stayed up for a moment with nothing drawn on it and the question was
   * gone (`.spike/agents-09-stop-confirmation.png`).
   */
  const [taken, setTaken] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    adoptConfirmation({
      confirmationId: request.confirmationId,
      purpose: request.purpose,
      agentId: request.agentId,
    });
    setTaken(true);
  }, [adoptConfirmation, request]);

  // The confirmation is gone — answered, or replaced by main — so the modal
  // that exists to ask it is gone too. One rule, wherever it was settled.
  useEffect(() => {
    if (taken && !pendingConfirmation) onDismiss();
  }, [onDismiss, pendingConfirmation, taken]);

  const purpose = pendingConfirmation?.purpose ?? request.purpose;
  const agentId = pendingConfirmation?.agentId ?? request.agentId;
  /**
   * Every Agent there is, or nothing when this page does not know yet.
   *
   * The overlay page is built when the first modal opens, so its projection is
   * still in flight while the sheet mounts. "I have not been told" is not "the
   * Agent is gone", and only the second of those may settle a question.
   */
  const agents =
    state.status === "ready"
      ? state.snapshot.workspaces.flatMap((workspace) => workspace.agents)
      : undefined;
  const agent = agents?.find((candidate) => candidate.id === agentId);
  const agentGone =
    purpose.kind === "agent_stop" && agents !== undefined && !agent;

  // An Agent that exits on its own takes its confirmation with it in main.
  // The question stops being asked the moment its subject is gone.
  useEffect(() => {
    if (agentGone) dismissCloseConfirmation();
  }, [agentGone, dismissCloseConfirmation]);

  if (agentGone) return null;

  const inspection =
    purpose.kind === "workspace_close" ? purpose.inspection : undefined;
  const stoppingAgent = purpose.kind === "agent_stop";
  const allResources: readonly (readonly [string, CloseResourceWire])[] =
    inspection
      ? [
          ["Agents", inspection.agents],
          ["Terminal processes", inspection.terminalProcesses],
          ["Terminal panes", inspection.terminalPanes],
          ["Terminal windows", inspection.terminalWindows],
          ["Unsaved editors", inspection.unsavedEditors],
        ]
      : [];
  const diagnostics = allResources.filter(
    ([, resource]) => resource.kind !== "clean",
  );

  return (
    <Picker
      // Re-asking is remounting: the picker stops listening the moment a row
      // is taken, so a refused close needs a fresh one to be answered again.
      key={attempt}
      title={
        inspection
          ? `Close “${inspection.workspaceLabel}”?`
          : stoppingAgent
            ? // The name is drawn as soon as it is known. Waiting for it would
              // mean drawing nothing at all on the frame the layer goes up.
              agent
              ? `Stop “${agent.displayName}”?`
              : "Stop this Agent?"
            : "Confirm this action?"
      }
      question={
        inspection
          ? "The workspace has resources open. Closing it will close them."
          : stoppingAgent
            ? "This stops the Agent runtime. You can retry if cleanup fails."
            : "This cannot be undone."
      }
      items={[
        {
          id: CANCEL,
          label: "Cancel",
          detail: stoppingAgent
            ? "Leave the Agent running."
            : "Leave the workspace open.",
        },
        {
          id: CONFIRM,
          label: stoppingAgent ? "Stop the Agent" : "Close the workspace",
          detail: stoppingAgent
            ? "The runtime stops. You can retry if cleanup fails."
            : "Everything listed below is closed with it.",
        },
      ]}
      note={
        <>
          {failure ? (
            <span className="picker-note-failure">{failure}</span>
          ) : null}
          {diagnostics.length > 0 ? (
            <ul className="mac-detail-list">
              {diagnostics.map(([label, resource]) => (
                <li key={label}>
                  <span>{label}</span>
                  <span>{closeResourceStatus(resource)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      }
      onChoose={({ id }) => {
        if (id !== CONFIRM) {
          dismissCloseConfirmation();
          return;
        }
        void confirmPending().then((done) => {
          // Done means main consumed the confirmation, and the effect above is
          // what takes the modal off screen. Refused means it is still there
          // and still retryable — so the sheet is asked again, with the reason
          // written under the list rather than dropped.
          if (done) return;
          setFailure(
            stoppingAgent
              ? "The Agent could not be stopped. Try again."
              : "The workspace could not be closed. Try again.",
          );
          setAttempt((count) => count + 1);
        });
      }}
      onCancel={dismissCloseConfirmation}
    />
  );
}
