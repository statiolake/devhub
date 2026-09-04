/**
 * "Close this workspace?" and "Stop this agent?", drawn on the modal layer.
 *
 * The question is raised by whatever the person clicked in the App Shell page,
 * answered here, and carried out by main. The alert adopts the confirmation
 * into this page's own model client, so the retry-on-failure and
 * replaced-confirmation rules are the ones the provider already has rather
 * than a second copy of them living in a component.
 */

import { useEffect, useState } from "react";
import { useAppShell } from "../useAppShell";
import { Alert } from "../components/shell/Alert";
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

export interface CloseConfirmationAlertProps {
  readonly request: CloseConfirmationRequest;
  readonly onDismiss: () => void;
}

export function CloseConfirmationAlert({
  request,
  onDismiss,
}: CloseConfirmationAlertProps) {
  const {
    state,
    pendingConfirmation,
    confirmationBusy,
    confirmPending,
    dismissCloseConfirmation,
    adoptConfirmation,
  } = useAppShell();

  /**
   * Whether this page's model client has taken the confirmation on yet.
   *
   * Adoption is a state change in the provider, so it cannot be visible in the
   * commit that asks for it: on the frame this alert mounts there is no
   * pending confirmation, and reading that as "somebody answered it" made
   * every confirmation close its own modal the instant it opened — the layer
   * stayed up for a moment with nothing drawn on it and the question was
   * gone (`.spike/agents-09-stop-confirmation.png`).
   */
  const [taken, setTaken] = useState(false);

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
   * still in flight while the alert mounts. "I have not been told" is not "the
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

  return (
    <Alert
      tone="danger"
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
      message={
        inspection
          ? "The workspace has resources open. Closing it will close them."
          : stoppingAgent
            ? "This stops the Agent runtime. You can retry if cleanup fails."
            : undefined
      }
      detail={allResources
        .filter(([, resource]) => resource.kind !== "clean")
        .map(([label, resource]) => [label, closeResourceStatus(resource)])}
      onCancel={dismissCloseConfirmation}
      actions={[
        {
          label: "Cancel",
          disabled: confirmationBusy,
          run: dismissCloseConfirmation,
        },
        {
          label: confirmationBusy
            ? stoppingAgent
              ? "Stopping…"
              : "Closing…"
            : stoppingAgent
              ? "Stop Agent"
              : "Close Workspace",
          isDefault: true,
          destructive: true,
          disabled: confirmationBusy,
          run: () => void confirmPending(),
        },
      ]}
    />
  );
}
