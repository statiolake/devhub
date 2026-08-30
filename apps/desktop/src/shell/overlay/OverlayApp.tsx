/**
 * The modal layer: a second, transparent page over the whole window.
 *
 * DevHub's App Shell page cannot draw over a workbench — a native
 * `WebContentsView` always paints above the window's own document — so
 * everything modal is drawn here instead, on a view main puts on top for
 * exactly as long as something is being asked. Nothing else lives on this
 * page: no sidebar, no titlebar, no surfaces. It is a sheet of glass.
 *
 * Main owns the set that is open and pushes it here; this page draws it and
 * says when each one is done. That is the whole protocol.
 */

import { useSyncExternalStore } from "react";
import { AppShellProvider } from "../AppShellContext";
import { devhub } from "../client";
import type { OpenModal } from "../../ipc/contract";
import { WorkspacePicker } from "../components/shell/WorkspacePicker";
import { ViewScopedAlert } from "../components/shell/ViewScopedAlert";
import { AgentPickerSheet } from "./AgentPickerSheet";
import { AgentRenameAlert } from "./AgentRenameAlert";
import { CloseConfirmationAlert } from "./CloseConfirmationAlert";

/** Take one modal off screen, with the answer if it asked for one. */
function close(id: string, response?: number): void {
  void devhub().closeModal(id, response);
}

/**
 * The set that is open, subscribed to as this module is evaluated.
 *
 * Not when the layer mounts. Main publishes the set from the page's
 * `did-finish-load`, which is after this module's script has run and before
 * any React effect has: a subscription taken in an effect is taken too late,
 * and the first modal of a session was pushed to nobody at all. The layer went
 * up with nothing drawn on it — the blank stop confirmation in
 * `.spike/agents-09-stop-confirmation.png`, reproduced by opening any modal as
 * the first one after launch.
 *
 * One page serves the shell, Settings and this layer, so this subscription is
 * taken on all three. Main sends the set only to the overlay view, so on the
 * other two it simply never hears anything.
 */
let openModals: readonly OpenModal[] = [];
const subscribers = new Set<() => void>();

devhub().onModals((modals) => {
  openModals = modals;
  for (const notify of subscribers) notify();
});

function subscribeToModals(notify: () => void): () => void {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

function Modal({ modal }: { readonly modal: OpenModal }) {
  const { id, request } = modal;
  switch (request.kind) {
    case "workspace-picker":
      return (
        <WorkspacePicker
          onDismiss={() => {
            close(id);
          }}
        />
      );
    case "agent-picker":
      return (
        <AgentPickerSheet
          workspaceId={request.workspaceId}
          onDismiss={() => {
            close(id);
          }}
        />
      );
    case "agent-rename":
      return (
        <AgentRenameAlert
          agentId={request.agentId}
          onDismiss={() => {
            close(id);
          }}
        />
      );
    case "close-confirmation":
      return (
        <CloseConfirmationAlert
          request={request}
          onDismiss={() => {
            close(id);
          }}
        />
      );
    case "workbench-dialog":
      return (
        <ViewScopedAlert
          request={request}
          onAnswer={(response) => {
            close(id, response);
          }}
        />
      );
  }
}

function ModalLayer() {
  const modals = useSyncExternalStore(subscribeToModals, () => openModals);
  return (
    <>
      {modals.map((modal) => (
        <Modal key={modal.id} modal={modal} />
      ))}
    </>
  );
}

export function OverlayApp() {
  return (
    <AppShellProvider>
      <ModalLayer />
    </AppShellProvider>
  );
}
