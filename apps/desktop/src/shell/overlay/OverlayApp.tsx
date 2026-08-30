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

import { useEffect, useState } from "react";
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
  const [modals, setModals] = useState<readonly OpenModal[]>([]);
  useEffect(() => devhub().onModals(setModals), []);
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
