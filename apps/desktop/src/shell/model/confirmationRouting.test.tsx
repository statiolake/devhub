// @vitest-environment jsdom

/**
 * What every page does with the answer a dispatch comes back with.
 *
 * An intent has an outcome, and two of the three kinds are not optional: a
 * `confirmation_required` is a question nobody has been asked yet, and a
 * rejection is a failure nobody has been told about. Dropping either is
 * silent, which is the worst way for it to be wrong — the row's Stop button
 * did exactly that for a busy Agent, and the tmux session simply stayed up.
 *
 * So the rule is stated here for every page that can dispatch, in one file
 * rather than four near-copies: **a question is put where it can be seen, and
 * a failure is handed to main.** Three pages draw no modals, so their
 * confirmation goes to main, which puts it on the `picker` view; the `picker`
 * page is the one place in DevHub where a question can be both seen and
 * answered, so it holds its own.
 *
 * A page that is added to DevHub and forgets this is a page whose buttons
 * quietly do nothing. The list below is the list of pages that can dispatch.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { AppOutcome, AppSnapshot } from "../../ipc/appShell";
import { ShellPageProvider, useShellPage } from "../ShellPageContext";
import { SidebarProvider, useSidebar } from "../sidebar/SidebarContext";
import { AgentsProvider, useAgents } from "../agents/AgentsContext";
import { PickerProvider, usePicker } from "../picker/PickerContext";

const AGENT_ID = "5d7fd0e2-2a0e-4a2b-9f3e-9a1a0a0b1c2d";
const CONFIRMATION_ID = "0d2f8f8e-1f37-4a1f-9b3d-1b0a5a5c6d7e";

const SNAPSHOT = {
  schemaVersion: 1,
  revision: 1,
  readiness: "ready",
  editorHost: { status: "ready", host: "local" },
  layout: { kind: "unavailable" },
  selection: { context: { kind: "global" }, presentation: "full" },
  sidebar: { width: 240, collapsed: false },
  splitRatio: 0.55,
  workspaces: [],
} as unknown as AppSnapshot;

const CONFIRMATION_REQUIRED = {
  kind: "confirmation_required",
  confirmationId: CONFIRMATION_ID,
  purpose: { kind: "agent_stop", agentId: AGENT_ID },
  snapshot: SNAPSHOT,
} as unknown as AppOutcome;

/** Everything a page's model client subscribes to, answering with nothing. */
function bridge(dispatch: () => Promise<AppOutcome>) {
  return {
    getSnapshot: async () => SNAPSHOT,
    replay: async () => ({ cursor: 0, events: [], snapshot: SNAPSHOT }),
    onSnapshot: () => () => undefined,
    dispatch,
    getAppearance: async () => ({ sequence: 1 }),
    onAppearance: () => () => undefined,
    getWindowTitle: async () => "DevHub",
    onWindowTitle: () => () => undefined,
    getRepositoryStatus: async () => ({ sequence: 0, workspaces: [] }),
    onRepositoryStatus: () => () => undefined,
    getAgentProfiles: async () => ({
      sequence: 1,
      availability: "available",
      profiles: [],
    }),
    onAgentProfiles: () => () => undefined,
    onAgentActions: () => () => undefined,
    onWorkspacePicker: () => () => undefined,
    onTheme: () => () => undefined,
    onMenuCommand: () => () => undefined,
    onSidebarArea: () => () => undefined,
    onModals: () => () => undefined,
    showTooltip: () => undefined,
    hideTooltip: () => undefined,
    closeWorkspace: async () => undefined,
    openExternalUrl: async () => undefined,
    previewLayout: async () => undefined,
    focusSurface: async () => undefined,
    openSettings: async () => undefined,
    chooseWorkspaceFolder: async () => undefined,
    writeClipboard: async () => undefined,
    closeModal: async () => undefined,
  };
}

/**
 * Raise one intent through the page's own context and draw nothing.
 *
 * The button that raises it is not the subject — which function the page hands
 * its controls is. Every page is asked through its own `dispatch`, because
 * that is the member every control in it reaches for.
 */
function Raise({ dispatch }: { dispatch: () => unknown }) {
  void dispatch();
  return null;
}

interface Page {
  readonly name: string;
  readonly Provider: (props: { children: ReactNode }) => ReactNode;
  readonly Raise: () => ReactNode;
  /** Where this page's confirmation is supposed to end up. */
  readonly holdsItsOwn: boolean;
}

const PAGES: readonly Page[] = [
  {
    name: "the window's own page",
    Provider: ShellPageProvider,
    Raise: () => <Raise dispatch={useShellPage().dispatch} />,
    holdsItsOwn: false,
  },
  {
    name: "the Sidebar",
    Provider: SidebarProvider,
    Raise: () => <Raise dispatch={useSidebar().dispatch} />,
    holdsItsOwn: false,
  },
  {
    name: "the Agents",
    Provider: AgentsProvider,
    Raise: () => <Raise dispatch={useAgents().dispatch} />,
    holdsItsOwn: false,
  },
  {
    name: "the questions",
    Provider: PickerProvider,
    Raise: () => {
      const { dispatch, pendingConfirmation } = usePicker();
      return (
        <>
          <Raise dispatch={dispatch} />
          {pendingConfirmation ? (
            <span>held {pendingConfirmation.confirmationId}</span>
          ) : null}
        </>
      );
    },
    holdsItsOwn: true,
  },
];

afterEach(cleanup);

describe("a question a dispatch came back with", () => {
  for (const page of PAGES) {
    it(`is not dropped by ${page.name}`, async () => {
      const openModal = vi.fn(async () => "modal-1");
      window.devhub = {
        ...bridge(async () => CONFIRMATION_REQUIRED),
        openModal,
      } as never;
      const { Provider, Raise: Trigger } = page;
      render(
        <Provider>
          <Trigger />
        </Provider>,
      );

      if (page.holdsItsOwn) {
        // The sheet is drawn here, so the question stays here. Handing it to
        // main would be this page asking main to ask this page.
        await waitFor(() => {
          expect(
            screen.getByText(`held ${CONFIRMATION_ID}`),
          ).toBeInTheDocument();
        });
        expect(openModal).not.toHaveBeenCalled();
        return;
      }
      // This page draws no modals, so the question goes to main, which puts it
      // on the `picker` view — the one page that can both show and answer it.
      await waitFor(() => {
        expect(openModal).toHaveBeenCalledWith({
          kind: "close-confirmation",
          confirmationId: CONFIRMATION_ID,
          purpose: { kind: "agent_stop", agentId: AGENT_ID },
        });
      });
    });
  }
});

describe("a dispatch that failed", () => {
  for (const page of PAGES) {
    it(`is raised by ${page.name} rather than swallowed`, async () => {
      const raiseFailure = vi.fn();
      window.devhub = {
        ...bridge(() => Promise.reject(new Error("main refused it"))),
        openModal: async () => "modal-1",
        raiseFailure,
      } as never;
      const { Provider, Raise: Trigger } = page;
      render(
        <Provider>
          <Trigger />
        </Provider>,
      );

      // Where it is *drawn* is main's decision (`publishAudience.ts`). What a
      // page owes is that the failure leaves it at all.
      await waitFor(() => {
        expect(raiseFailure).toHaveBeenCalled();
      });
    });
  }
});
