// @vitest-environment jsdom

/**
 * `devhub:` links in the conversation's Markdown: drawn as chips with the
 * place's live name, a not-found state for one that leads nowhere, a click
 * that goes there inside DevHub as an explicit move — and an http(s) link
 * that still opens in the browser.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkPlaces } from "../../model/devhubLink";
import { ConversationActionsProvider } from "./ConversationContext";
import { DevhubLinksProvider, type DevhubLinks } from "./DevhubLink";
import { Markdown } from "./Markdown";
import { PathLinks, PathLinksProvider } from "./pathLinks";
import { fakeActions } from "./surfaceTestKit";
import {
  linkPlaces,
  navigateLink,
  type LinkNavigationPorts,
} from "../agents/devhubLinks";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const AGENT = "3f2a9c1e-7b4d-4e2a-9c1e-7b4d4e2a9c1e";

const PLACES: LinkPlaces = {
  workspaces: [
    {
      id: "w1",
      label: "login-fix",
      root: "/Users/me/app",
      local: true,
      agents: [{ id: AGENT, displayName: "API fix", status: "waiting" }],
    },
  ],
  tasks: [{ id: 3, title: "列追加の作業", status: "answer" }],
  escalations: [
    { id: 12, taskId: 3, title: "列を追加してよいか", state: "open" },
  ],
  orchestrator: true,
};

function drawn(
  source: string,
  /** `null`: a page with no provider. */
  links: Partial<DevhubLinks> | null = {},
  actions = fakeActions(),
) {
  const value: DevhubLinks | undefined =
    links === null
      ? undefined
      : {
          places: PLACES,
          navigate: vi.fn(() => Promise.resolve()),
          sessionAgent: vi.fn(() => Promise.resolve(null)),
          reportFailure: vi.fn(),
          copyLink: vi.fn(() => Promise.resolve()),
          showContextMenu: vi.fn(() => Promise.resolve(undefined)),
          ...links,
        };
  const paths = new PathLinks(actions.resolvePaths, actions.reportFailure);
  const tree = (
    <ConversationActionsProvider value={actions}>
      <PathLinksProvider value={paths}>
        <Markdown source={source} streaming={false} />
      </PathLinksProvider>
    </ConversationActionsProvider>
  );
  render(
    value === undefined ? (
      tree
    ) : (
      <DevhubLinksProvider value={value}>{tree}</DevhubLinksProvider>
    ),
  );
  return { value, actions };
}

function chips(): readonly HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("button.devhub-link")];
}

describe("a devhub: link in Markdown", () => {
  it("draws each kind as a chip with the place's live name", () => {
    drawn(
      [
        `[the agent](devhub:agent/${AGENT.slice(0, 8)})`,
        "[ws](devhub:workspace/w1)",
        "[test](devhub:file/Users/me/app/src/a%20b.ts:40:2)",
        "[q](devhub:escalation/12)",
        "[o](devhub:orchestrator)",
      ].join(" "),
    );
    expect(
      chips().map((chip) => [chip.dataset["kind"], chip.textContent]),
    ).toEqual([
      ["agent", "AgentAPI fix"],
      ["workspace", "Workspacelogin-fix"],
      ["file", "Filea b.ts:40:2"],
      ["escalation", "Escalation#12列を追加してよいか"],
      ["orchestrator", "OrchestratorOrchestrator"],
    ]);
    // The agent's status mark, as the Sidebar draws it.
    expect(
      chips()[0]!.querySelector(".status-mark")?.getAttribute("data-status"),
    ).toBe("waiting");
    // A chip is a button, not a link a browser could follow.
    expect(document.querySelector("a[href^='devhub:']")).toBeNull();
  });

  it("leaves one that leads nowhere as its text, marked 見つかりません", () => {
    drawn(
      [
        "[gone](devhub:agent/deadbeef)",
        "[bad](devhub:robot/1)",
        "[outside](devhub:file/etc/hosts)",
        "[old](devhub:escalation/99)",
      ].join(" "),
    );
    expect(chips()).toEqual([]);
    const missing = [
      ...document.querySelectorAll<HTMLElement>(".devhub-link.is-missing"),
    ];
    expect(missing.map((one) => one.textContent)).toEqual([
      "gone見つかりません",
      "bad見つかりません",
      "outside見つかりません",
      "old見つかりません",
    ]);
  });

  it("is text, marked, on a page that cannot follow it", () => {
    drawn("[o](devhub:orchestrator)", null);
    expect(chips()).toEqual([]);
    expect(document.querySelector(".devhub-link.is-missing")).toHaveTextContent(
      "o見つかりません",
    );
  });

  it("goes where it leads on a click, and never out of DevHub", () => {
    const { value, actions } = drawn("[f](devhub:file/Users/me/app/x.ts:3)");
    fireEvent.click(chips()[0]!);
    expect(value!.navigate).toHaveBeenCalledWith({
      kind: "file",
      path: "/Users/me/app/x.ts",
      line: 3,
      workspace: PLACES.workspaces[0],
    });
    expect(actions.openExternalUrl).not.toHaveBeenCalled();
  });

  it("draws a session as the agent running it, or not found", async () => {
    const sessionAgent = vi.fn((session: string) =>
      Promise.resolve(session === "s-1" ? AGENT : null),
    );
    drawn("[a](devhub:session/s-1) [b](devhub:session/s-2)", { sessionAgent });
    await act(async () => {
      await Promise.resolve();
    });
    expect(chips().map((chip) => chip.textContent)).toEqual(["AgentAPI fix"]);
    expect(document.querySelector(".devhub-link.is-missing")).toHaveTextContent(
      "b見つかりません",
    );
  });

  it("leaves an http(s) link to open in the browser", () => {
    const { actions } = drawn("[docs](https://example.com/a)");
    fireEvent.click(document.querySelector("a")!);
    expect(actions.openExternalUrl).toHaveBeenCalledWith(
      "https://example.com/a",
    );
  });
});

describe("following a link on the Agents page", () => {
  function ports(): LinkNavigationPorts & {
    readonly dispatch: ReturnType<typeof vi.fn>;
  } {
    return {
      dispatch: vi.fn(() => Promise.resolve(undefined)),
      openLinkedFile: vi.fn(() => Promise.resolve()),
      sessionAgent: vi.fn(() => Promise.resolve(AGENT)),
    };
  }
  const workspace = PLACES.workspaces[0]!;
  const agent = workspace.agents[0]!;

  it("selects an agent, a workspace or the Orchestrator row, explicitly", async () => {
    const to = ports();
    await navigateLink({ kind: "agent", agent, workspace }, to);
    await navigateLink({ kind: "workspace", workspace }, to);
    await navigateLink({ kind: "orchestrator" }, to);
    expect(to.dispatch.mock.calls.map(([intent]) => intent)).toEqual([
      {
        type: "select_context",
        context: { kind: "agent", agentId: AGENT },
        reason: "explicit",
      },
      {
        type: "select_context",
        context: { kind: "workspace", workspaceId: "w1" },
        reason: "explicit",
      },
      {
        type: "select_context",
        context: { kind: "orchestrator" },
        reason: "explicit",
      },
    ]);
  });

  it("opens an escalation's task on the board as one move, one place in Back and Forward", async () => {
    const to = ports();
    await navigateLink(
      {
        kind: "escalation",
        escalation: PLACES.escalations[0]!,
        task: PLACES.tasks[0]!,
      },
      to,
    );
    expect(to.dispatch.mock.calls.map(([intent]) => intent)).toEqual([
      {
        type: "show_orchestrator_view",
        view: { kind: "task", id: 3 },
        reason: "explicit",
      },
    ]);
  });

  it("opens a file through main's routing, in the workspace that holds it", async () => {
    const to = ports();
    await navigateLink(
      { kind: "file", path: "/Users/me/app/x.ts", line: 3, workspace },
      to,
    );
    await navigateLink(
      { kind: "file", path: "/Users/me/app/y.ts", workspace },
      to,
    );
    expect(to.openLinkedFile).toHaveBeenNthCalledWith(
      1,
      "w1",
      "/Users/me/app/x.ts",
      { kind: "line", line: 3, column: 1 },
    );
    expect(to.openLinkedFile).toHaveBeenNthCalledWith(
      2,
      "w1",
      "/Users/me/app/y.ts",
      undefined,
    );
    expect(to.dispatch).not.toHaveBeenCalled();
  });

  it("shows the agent running a session, and resumes nothing", async () => {
    const to = ports();
    await navigateLink({ kind: "session", session: "s-1" }, to);
    expect(to.dispatch).toHaveBeenCalledWith({
      type: "select_context",
      context: { kind: "agent", agentId: AGENT },
      reason: "explicit",
    });
    const none = { ...ports(), sessionAgent: () => Promise.resolve(null) };
    await expect(
      navigateLink({ kind: "session", session: "s-2" }, none),
    ).rejects.toThrow(/見つかりません/u);
    expect(none.dispatch).not.toHaveBeenCalled();
  });

  it("names Scratch as Scratch, from the snapshot", () => {
    const places = linkPlaces(
      {
        scratchWorkspaceId: "w1",
        workspaces: [
          {
            id: "w1",
            label: "2026-11-05",
            root: "/s",
            location: { kind: "local" },
            agents: [],
          },
        ],
      } as never,
      { answer: [], inProgress: [], waiting: [], done: [] } as never,
    );
    expect(places.workspaces[0]?.label).toBe("Scratch");
  });
});
