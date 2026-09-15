/**
 * The `picker` page: everything DevHub stops to ask, on a sheet of glass over
 * the whole window.
 *
 * DevHub's App Shell page cannot draw over a workbench — a native
 * `WebContentsView` always paints above the window's own document — so
 * everything modal is drawn here instead, on a view main puts on top for
 * exactly as long as something is being asked. Nothing else lives on this
 * page: no sidebar, no titlebar, no surfaces.
 *
 * # The contract, said once
 *
 * **Arriving from main**
 * - `devhub:modals-changed` — the set that is open. This is the *only* page
 *   main sends it to, and it is now the only page that subscribes to it:
 *   `onModals` was on the bridge for every page while one `index.html` served
 *   three surfaces, so a page that took the subscription simply never heard
 *   anything. A page per view is what makes that trap unspellable.
 * - the projections the sheets read: `snapshotChanged`, `workspacePicker`,
 *   `agentProfilesChanged`, `agentActionsChanged`, `themeChanged`. A modal is
 *   drawn from the same model the sidebar lists, which is why it is told
 *   rather than asking. Not the appearance and not the repository status: no
 *   sheet reads either, and this page's bridge cannot spell them.
 *
 * **Leaving for main**
 * - `devhub:close-modal`, and the sheets' own invokes: the workspace picker,
 *   the project and Issue flows, the SSH hosts, the agent actions, the
 *   worktree close, the injection review.
 * - `devhub:raise-failure` — what began *here*. This page draws no failure: it
 *   is not told any, because the page that draws them is the `toasts` view.
 *   See `main/shell/publishAudience.ts`.
 *
 * Main owns the set that is open and pushes it here; this page draws it and
 * says when each one is done.
 */

import { useSyncExternalStore } from "react";
import { PickerProvider } from "./PickerContext";
import { devhub } from "./client";
import type { OpenModal } from "../../ipc/contract";
import { WorkspacePicker } from "../components/shell/WorkspacePicker";
import { ViewScopedAlert } from "../components/shell/ViewScopedAlert";
import { AgentPickerSheet } from "./AgentPickerSheet";
import { IssueAssignmentSheet } from "./IssueAssignmentSheet";
import { AgentRenameSheet } from "./AgentRenameSheet";
import { InjectionReviewSheet } from "./InjectionReviewSheet";
import { CloseConfirmationSheet } from "./CloseConfirmationSheet";
import { WorktreeCloseSheet } from "./WorktreeCloseSheet";
import { TabPickerSheet } from "./TabPickerSheet";
import { AgentActionsSheet } from "./AgentActionsSheet";
import { ChordHelpSheet } from "./ChordHelpSheet";

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
 * up with nothing drawn on it — reproduced by opening any modal as the first
 * one after launch.
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
    case "issue-assignment":
      return (
        <IssueAssignmentSheet
          onDismiss={() => {
            close(id);
          }}
        />
      );
    case "agent-rename":
      return (
        <AgentRenameSheet
          agentId={request.agentId}
          onDismiss={() => {
            close(id);
          }}
        />
      );
    case "injection-review":
      return (
        <InjectionReviewSheet
          agentId={request.agentId}
          injectionId={request.injectionId}
          actionName={request.actionName}
          text={request.text}
          onDismiss={() => {
            close(id);
          }}
        />
      );
    case "tab-picker":
      return (
        <TabPickerSheet
          onDismiss={() => {
            close(id);
          }}
        />
      );
    case "agent-actions":
      return (
        <AgentActionsSheet
          agentId={request.agentId}
          onDismiss={() => {
            close(id);
          }}
        />
      );
    case "worktree-close":
      return (
        <WorktreeCloseSheet
          workspaceId={request.workspaceId}
          label={request.label}
          root={request.root}
          branch={request.branch}
          dirty={request.dirty}
          onDismiss={() => {
            close(id);
          }}
        />
      );
    case "chord-help":
      return (
        <ChordHelpSheet
          rows={request.rows}
          onDismiss={() => {
            close(id);
          }}
        />
      );
    case "close-confirmation":
      return (
        <CloseConfirmationSheet
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

export function PickerApp() {
  return (
    // This page draws no alerts, and does not have to say so: every page
    // raises what began in it to main and draws only what main sent it, and
    // main sends `nativeError` to the page that draws failures. Nothing
    // arrives here, so nothing is drawn here.
    <PickerProvider>
      <ModalLayer />
    </PickerProvider>
  );
}
