// @vitest-environment jsdom

/**
 * The Orchestrator board: three lanes, an escalation opened in place with
 * the conversation's renderer, and the person's answer going out through the
 * one door it has (`answerEscalation`).
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../ipc/appShell";
import { EMPTY_BOARD, type OrchestratorBoardWire } from "../../ipc/contract";
import { installHistoryButtons } from "../historyButtons";
import { AgentsContext, type AgentsValue } from "./AgentsContext";
import { forgetOrchestratorMemory } from "./orchestratorMemory";
import {
  escalationBase,
  NAV_MS,
  OrchestratorBoard,
  preview,
  span,
} from "./OrchestratorScreen";

const answerEscalation = vi.fn(() => Promise.resolve());
/** The files an escalation's thread may draw, by absolute path. */
const FILES: Record<string, Uint8Array> = {
  "/w/payments/out/shot.png": new Uint8Array([137, 80, 78, 71]),
  "/abs/flow.svg": new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>',
  ),
};
const resolveEscalationPaths = vi.fn(
  (cwd: string | undefined, paths: readonly string[]) =>
    Promise.resolve(
      paths.map((path) => {
        const absolute = path.startsWith("/") ? path : `${cwd ?? ""}/${path}`;
        return absolute in FILES ? absolute : null;
      }),
    ),
);
const readEscalationEmbed = vi.fn((path: string) =>
  Promise.resolve(
    FILES[path] === undefined
      ? null
      : { mediaType: "", bytes: FILES[path], signature: "1" },
  ),
);
window.devhub = {
  answerEscalation,
  setOrchestratorPaused: vi.fn(() => Promise.resolve()),
  openExternalUrl: vi.fn(() => Promise.resolve()),
  conversation: { resolvePaths: () => Promise.resolve([]) },
  resolveEscalationPaths,
  readEscalationEmbed,
  escalationEmbedSignature: () => Promise.resolve(null),
} as unknown as typeof window.devhub;

afterEach(() => {
  cleanup();
  forgetOrchestratorMemory();
  window.sessionStorage.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

/** Whether the person asked for less motion, as `matchMedia` answers it. */
function motion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion: reduce"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

function boardSection(): HTMLElement {
  return screen.getByRole("region", { name: "Orchestrator board" });
}

/** What of the left pane could size it: its class, style and attributes. */
function paneShape(element: HTMLElement): string {
  return [...element.attributes]
    .map((attribute) => `${attribute.name}=${attribute.value}`)
    .join(" ");
}

const NOW = Date.now();

const BOARD: OrchestratorBoardWire = {
  ...EMPTY_BOARD,
  revision: 1,
  orchestratorAgentId: "orch",
  needsAnswer: [
    {
      id: 1,
      title: "本番マイグレーションの実行承認",
      state: "needs_answer",
      entries: [
        {
          role: "orchestrator",
          markdown:
            "## 背景\n\n列を追加します。\n\n```sql\nALTER TABLE t ADD c int;\n```",
          at: NOW - 120_000,
          options: ["実行する", "保留"],
        },
      ],
      agents: [{ agentId: "a1", name: "payments-migration", status: "idle" }],
      links: ["https://github.com/acme/app/pull/7"],
      createdAt: NOW - 120_000,
      updatedAt: NOW - 120_000,
      stateSince: NOW - 120_000,
    },
  ],
  inProgress: [
    {
      id: 2,
      title: "リトライ方針",
      state: "in_progress",
      entries: [
        { role: "orchestrator", markdown: "A or B?", at: NOW - 600_000 },
        { role: "human", markdown: "A で", at: NOW - 300_000 },
      ],
      agents: [],
      links: [],
      createdAt: NOW - 600_000,
      updatedAt: NOW - 300_000,
      stateSince: NOW - 300_000,
    },
  ],
};

function mount(
  board: OrchestratorBoardWire = BOARD,
  workspaces: readonly unknown[] = [],
) {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  render(
    <AgentsContext.Provider
      value={
        { board, dispatch, reportFailure: vi.fn() } as unknown as AgentsValue
      }
    >
      <OrchestratorBoard snapshot={{ workspaces } as unknown as AppSnapshot} />
    </AgentsContext.Provider>,
  );
  return dispatch;
}

describe("the Orchestrator board", () => {
  it("lays out 要回答 and 対応中, with ages, and no 不明", () => {
    mount();
    const ask = screen.getByRole("region", { name: "要回答" });
    expect(
      within(ask).getByText("本番マイグレーションの実行承認"),
    ).toBeVisible();
    expect(within(ask).getByText("列を追加します。")).toBeVisible();
    const progress = screen.getByRole("region", { name: "対応中" });
    expect(within(progress).getByText("answered 5m ago")).toBeVisible();
    expect(screen.queryByRole("region", { name: "不明" })).toBeNull();
  });

  it("jumps to an escalation's agent as a deliberate move, for Back and Forward", () => {
    motion(true);
    const dispatch = mount();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /payments-migration/u }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "select_context",
      context: { kind: "agent", agentId: "a1" },
      reason: "explicit",
    });
  });

  it("opens an escalation in place, and answers it through the bridge", async () => {
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    expect(
      document.querySelector(
        ".orchestrator-thread pre, .orchestrator-thread code",
      ),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    expect(answerEscalation).toHaveBeenCalledWith(1, "保留");
    await act(async () => {
      await Promise.resolve();
    });
    // Answered: back on the board.
    expect(document.querySelector(".orchestrator-reading")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /リトライ方針/u }));
    const field = screen.getByRole("textbox", { name: "Your answer to #2" });
    fireEvent.change(field, { target: { value: "やはり B で" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(answerEscalation).toHaveBeenLastCalledWith(2, "やはり B で");
  });
});

describe("after an answer", () => {
  const TWO: OrchestratorBoardWire = {
    ...BOARD,
    needsAnswer: [
      ...BOARD.needsAnswer,
      {
        ...BOARD.needsAnswer[0]!,
        id: 3,
        title: "ステージングの再作成",
        entries: [
          { role: "orchestrator", markdown: "作り直してよい?", at: NOW },
        ],
      },
    ],
  };

  async function sent() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("goes back to the board, focusing the next card in 要回答", async () => {
    motion(true);
    mount(TWO);
    const card = screen.getByRole("button", { name: /本番マイグレーション/u });
    card.focus();
    fireEvent.click(card);
    const field = screen.getByRole("textbox", { name: "Your answer to #1" });
    fireEvent.change(field, { target: { value: "実行して" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await sent();
    expect(document.querySelector(".orchestrator-reading")).toBeNull();
    expect(
      screen.getByRole("button", { name: /ステージングの再作成/u }),
    ).toHaveFocus();
  });

  it("with none left, focuses the card just answered", async () => {
    motion(false);
    vi.useFakeTimers();
    mount();
    const card = screen.getByRole("button", { name: /本番マイグレーション/u });
    card.focus();
    fireEvent.click(card);
    const field = screen.getByRole("textbox", { name: "Your answer to #1" });
    fireEvent.change(field, { target: { value: "実行して" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await sent();
    // The same slide as Esc.
    expect(document.querySelector(".orchestrator-stage")).toHaveAttribute(
      "data-nav",
      "pop",
    );
    expect(card).toHaveFocus();
    act(() => {
      vi.advanceTimersByTime(NAV_MS);
    });
    expect(document.querySelector(".orchestrator-reading")).toBeNull();
  });

  it("stays, with the error and the draft, when the send fails", async () => {
    motion(true);
    answerEscalation.mockImplementationOnce(() =>
      Promise.reject(new Error("the orchestrator is gone")),
    );
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    const field = screen.getByRole("textbox", { name: "Your answer to #1" });
    fireEvent.change(field, { target: { value: "実行して" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await sent();
    expect(document.querySelector(".orchestrator-reading")).not.toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "the orchestrator is gone",
    );
    expect(
      screen.getByRole("textbox", { name: "Your answer to #1" }),
    ).toHaveValue("実行して");
  });
});

describe("an escalation's pictures", () => {
  it("draws relative and absolute images — in a table too — and an svg block, from its workspace", async () => {
    mount(
      {
        ...BOARD,
        needsAnswer: [
          {
            ...BOARD.needsAnswer[0]!,
            workspaceId: "w-pay",
            entries: [
              {
                role: "orchestrator",
                markdown: [
                  "![画面](out/shot.png)",
                  "",
                  "| 前 | 後 |",
                  "|---|---|",
                  "| ![前](out/shot.png) | ![図](/abs/flow.svg) |",
                  "",
                  "```svg",
                  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>',
                  "```",
                ].join("\n"),
                at: NOW,
              },
            ],
          },
        ],
      },
      [{ id: "w-pay", root: "/w/payments", agents: [] }],
    );
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    const thread = document.querySelector(".orchestrator-thread")!;
    await waitFor(() => {
      expect(
        within(thread as HTMLElement).getByRole("img", { name: "前" }),
      ).toBeInTheDocument();
    });
    expect(resolveEscalationPaths).toHaveBeenCalledWith("/w/payments", [
      "out/shot.png",
    ]);
    expect(
      within(thread as HTMLElement)
        .getByRole("img", { name: "図" })
        .getAttribute("src"),
    ).toMatch(/^data:image\/svg\+xml;base64,/u);
    await waitFor(() => {
      expect(
        thread.querySelector(
          '.conversation-embed[data-path="out/shot.png"] img',
        ),
      ).not.toBeNull();
    });
    expect(thread.querySelector('figure[data-kind="svg"] img')).not.toBeNull();
  });

  it("takes relative paths from the workspace, else the first agent's, else the orchestrator's folder", () => {
    const one = BOARD.needsAnswer[0]!;
    const workspaces = [
      { id: "w1", root: "/w/one", agents: [] },
      { id: "w2", root: "/w/two", agents: [{ id: "a1" }] },
    ] as unknown as AppSnapshot["workspaces"];
    expect(
      escalationBase({ ...one, workspaceId: "w1" }, workspaces, "/orch"),
    ).toBe("/w/one");
    expect(escalationBase(one, workspaces, "/orch")).toBe("/w/two");
    expect(escalationBase({ ...one, agents: [] }, workspaces, "/orch")).toBe(
      "/orch",
    );
  });
});

describe("the orchestrator's ranking on the board", () => {
  it("marks high, low and quick, with the reason as a quiet line; normal shows nothing", () => {
    mount({
      ...BOARD,
      needsAnswer: [
        {
          ...BOARD.needsAnswer[0]!,
          priority: "high",
          effort: "quick",
          rankNote: "3 つのエージェントが止まっている",
        },
        {
          ...BOARD.needsAnswer[0]!,
          id: 4,
          title: "ログの保存期間",
          priority: "low",
          effort: "normal",
        },
      ],
    });
    const ask = screen.getByRole("region", { name: "要回答" });
    const [first, second] = [
      ...ask.querySelectorAll<HTMLElement>(".orchestrator-card"),
    ];
    expect(within(first!).getByText("優先")).toBeVisible();
    expect(within(first!).getByText("すぐ答えられる")).toBeVisible();
    expect(
      within(first!).getByText("3 つのエージェントが止まっている"),
    ).toBeVisible();
    expect(within(second!).getByText("低")).toBeVisible();
    expect(within(second!).queryByText("すぐ答えられる")).toBeNull();
    const progress = screen.getByRole("region", { name: "対応中" });
    expect(within(progress).queryByText("優先")).toBeNull();
    expect(within(progress).queryByText("低")).toBeNull();
  });
});

describe("待機中", () => {
  it("is a lane of its own: the trigger first, the time and how far off", () => {
    const due = NOW + 3 * 86_400_000 + 60_000;
    const waiting = (id: number, trigger: string, dueAt?: number) => ({
      ...BOARD.inProgress[0]!,
      id,
      title: `待ち ${String(id)}`,
      state: "waiting" as const,
      entries: [
        { role: "orchestrator" as const, markdown: "about", at: NOW - 60_000 },
        {
          role: "orchestrator" as const,
          kind: "wait" as const,
          markdown: trigger,
          at: NOW - 60_000,
          ...(dueAt === undefined ? {} : { dueAt }),
        },
      ],
    });
    mount({
      ...BOARD,
      waiting: [
        waiting(5, "11/10 以降に再開", due),
        waiting(6, "Bob から Slack で返事が来たら"),
      ],
    });
    const lane = screen.getByRole("region", { name: "待機中" });
    const [first, second] = [
      ...lane.querySelectorAll<HTMLElement>(".orchestrator-card"),
    ];
    expect(within(first!).getByText("11/10 以降に再開")).toBeVisible();
    expect(first!.querySelector(".orchestrator-card-due")?.textContent).toMatch(
      /あと 3日$/u,
    );
    expect(
      within(second!).getByText("Bob から Slack で返事が来たら"),
    ).toBeVisible();
    expect(second!.querySelector(".orchestrator-card-due")).toBeNull();
    // Nothing for the person to press here: no 対応中にする.
    expect(within(lane).queryByText("対応中にする")).toBeNull();
    expect(screen.queryByText("対応中にする")).toBeNull();
  });
});

describe("停滞", () => {
  it("marks a stalled 対応中 card quietly, with no tooltip", () => {
    mount({
      ...BOARD,
      inProgress: [
        { ...BOARD.inProgress[0]!, stalledSince: NOW - 60_000 },
        { ...BOARD.inProgress[0]!, id: 3, title: "動いている" },
      ],
    });
    const progress = screen.getByRole("region", { name: "対応中" });
    const [stalled, moving] = [
      ...progress.querySelectorAll<HTMLElement>(".orchestrator-card"),
    ];
    const mark = within(stalled!).getByText("停滞");
    expect(mark).toBeVisible();
    expect(mark).not.toHaveAttribute("title");
    expect(within(moving!).queryByText("停滞")).toBeNull();
  });
});

describe("opening an escalation and going back", () => {
  it("keeps the left pane's width: nothing about the pane changes", () => {
    motion(true);
    mount();
    const before = paneShape(boardSection());
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    expect(document.querySelector(".orchestrator-reading")).not.toBeNull();
    expect(paneShape(boardSection())).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Back to the board" }));
    expect(paneShape(boardSection())).toBe(before);
  });

  it("sizes the pane in one rule, keyed on nothing it shows", () => {
    const css = readFileSync(
      "src/shell/agents/orchestrator.css",
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//gu, "");
    const sizing = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter(([, selector]) =>
        /orchestrator-board(?![\w-])/u.test(selector ?? ""),
      )
      .filter(([, , body]) =>
        /(?:^|[;\s])(?:min-|max-)?width\s*:/u.test(body ?? ""),
      )
      .map(([, selector]) => (selector ?? "").trim());
    expect(sizing).toEqual([".orchestrator-board"]);
  });

  it("slides: the view stays while it goes back, then leaves", () => {
    motion(false);
    vi.useFakeTimers();
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    const stage = document.querySelector(".orchestrator-stage");
    expect(stage).toHaveAttribute("data-nav", "push");
    expect(document.querySelector(".orchestrator-lanes")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Back to the board" }),
      { key: "Escape" },
    );
    expect(stage).toHaveAttribute("data-nav", "pop");
    const leaving = document.querySelector(".orchestrator-reading");
    expect(leaving).toHaveAttribute("aria-hidden", "true");
    expect(leaving).toHaveAttribute("inert");
    act(() => {
      vi.advanceTimersByTime(NAV_MS);
    });
    expect(stage).toHaveAttribute("data-nav", "idle");
    expect(document.querySelector(".orchestrator-reading")).toBeNull();
  });

  it("swaps at once under Reduce Motion", () => {
    motion(true);
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Back to the board" }),
      { key: "Escape" },
    );
    expect(document.querySelector(".orchestrator-stage")).toHaveAttribute(
      "data-nav",
      "idle",
    );
    expect(document.querySelector(".orchestrator-reading")).toBeNull();
    expect(document.querySelector(".orchestrator-lanes")).not.toHaveAttribute(
      "aria-hidden",
    );
  });

  it("focuses the answer on open, and the opened card on return", () => {
    motion(false);
    vi.useFakeTimers();
    mount();
    const card = screen.getByRole("button", { name: /本番マイグレーション/u });
    card.focus();
    fireEvent.click(card);
    const field = screen.getByRole("textbox", { name: "Your answer to #1" });
    expect(field).toHaveFocus();
    // Esc in the empty composer goes back.
    fireEvent.keyDown(field, { key: "Escape" });
    expect(card).toHaveFocus();
    act(() => {
      vi.advanceTimersByTime(NAV_MS);
    });
    expect(card).toHaveFocus();
  });

  it("focuses the thread when nothing is asked, and keeps a draft on Esc", () => {
    motion(true);
    mount();
    fireEvent.click(screen.getByRole("button", { name: /リトライ方針/u }));
    expect(document.querySelector(".orchestrator-thread")).toHaveFocus();
    const field = screen.getByRole("textbox", { name: "Your answer to #2" });
    fireEvent.change(field, { target: { value: "やはり B" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.querySelector(".orchestrator-reading")).not.toBeNull();
  });

  it("takes no focus from outside the board", () => {
    motion(true);
    const outside = document.createElement("input");
    document.body.append(outside);
    mount();
    outside.focus();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    expect(outside).toHaveFocus();
    outside.remove();
  });
});

describe("the mouse's side buttons over the board", () => {
  function press(target: Element, button: number): MouseEvent {
    fireEvent.mouseDown(target, { button });
    const up = new MouseEvent("mouseup", {
      button,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      target.dispatchEvent(up);
    });
    return up;
  }

  it("goes back and forward between the board and an escalation, and leaves the app's history alone", () => {
    motion(true);
    const app = vi.fn();
    const uninstall = installHistoryButtons(document, app);
    try {
      mount();
      // Back on the board itself is the app's.
      press(screen.getByRole("region", { name: "要回答" }), 3);
      expect(app).toHaveBeenCalledWith("back");
      app.mockClear();
      // Forward with nothing gone back from is the app's too.
      press(boardSection(), 4);
      expect(app).toHaveBeenCalledWith("forward");
      app.mockClear();

      fireEvent.click(
        screen.getByRole("button", { name: /本番マイグレーション/u }),
      );
      const back = press(
        document.querySelector(".orchestrator-thread") as Element,
        3,
      );
      expect(back.defaultPrevented).toBe(true);
      expect(document.querySelector(".orchestrator-reading")).toBeNull();
      expect(app).not.toHaveBeenCalled();

      press(screen.getByRole("region", { name: "対応中" }), 4);
      expect(
        screen.getByRole("textbox", { name: "Your answer to #1" }),
      ).toBeVisible();
      expect(app).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });
});

describe("the board's words", () => {
  it("previews what a section says, not its heading", () => {
    expect(preview("## 背景\n\n| a | b |\n本文です。")).toBe("本文です。");
  });

  it("says how long in one short word", () => {
    expect(span(45_000)).toBe("45s");
    expect(span(12 * 60_000)).toBe("12m");
    expect(span(3 * 3_600_000)).toBe("3h");
  });
});

describe("the answer composer", () => {
  function open() {
    motion(true);
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    return screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Your answer to #1",
    });
  }

  it("draws no hint line, only the field, the quick replies and Send", () => {
    open();
    const composer = document.querySelector(".orchestrator-composer")!;
    expect(composer).not.toHaveTextContent(/Markdown|to send|relays/u);
    expect(composer.querySelector(".orchestrator-composer-hint")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Send answer" }),
    ).toBeInTheDocument();
  });

  it("a press on the box's padding or the frame lands in the field, at the end", () => {
    const field = open();
    fireEvent.change(field, { target: { value: "実行して" } });
    for (const selector of [
      ".conversation-composer-box",
      ".orchestrator-composer",
      ".orchestrator-options",
    ]) {
      screen.getByRole("button", { name: "Back to the board" }).focus();
      expect(fireEvent.mouseDown(document.querySelector(selector)!)).toBe(
        false,
      );
      expect(field).toHaveFocus();
      expect(field.selectionStart).toBe(4);
    }
  });

  it("a press on a quick reply does not take the keyboard into the field", () => {
    const field = open();
    const back = screen.getByRole("button", { name: "Back to the board" });
    back.focus();
    const reply = screen.getByRole("button", { name: "保留" });
    expect(fireEvent.mouseDown(reply)).toBe(true);
    expect(field).not.toHaveFocus();
    expect(
      fireEvent.mouseDown(screen.getByRole("button", { name: "Send answer" })),
    ).toBe(true);
    expect(field).not.toHaveFocus();
  });
});

/**
 * The Orchestrator row selected or not, as `AgentsApp` draws it: the left
 * pane unmounts while another place is shown, and mounts again on return.
 */
function mountScreen(
  board: OrchestratorBoardWire = BOARD,
  workspaces: readonly unknown[] = [],
) {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const view = (shown: boolean, now: OrchestratorBoardWire) => (
    <AgentsContext.Provider
      value={
        {
          board: now,
          dispatch,
          reportFailure: vi.fn(),
        } as unknown as AgentsValue
      }
    >
      {shown ? (
        <OrchestratorBoard
          snapshot={{ workspaces } as unknown as AppSnapshot}
        />
      ) : null}
    </AgentsContext.Provider>
  );
  const { rerender } = render(view(true, board));
  return {
    dispatch,
    /** Another place is selected. */
    leave: (now: OrchestratorBoardWire = board) => {
      rerender(view(false, now));
    },
    /** The Orchestrator row again. */
    back: (now: OrchestratorBoardWire = board) => {
      rerender(view(true, now));
    },
  };
}

function thread(): HTMLElement {
  return document.querySelector<HTMLElement>(".orchestrator-thread")!;
}

describe("leaving the Orchestrator screen and coming back", () => {
  // Back (prefix+h), a click on the Sidebar's Orchestrator row and
  // `devhub --tell focus orchestrator` all select the row, and the page
  // draws the pane again: each lands on what was left.
  it.each(["prefix+h", "a Sidebar click", "focus orchestrator"])(
    "via %s, is back on the open escalation, scrolled as it was, with the draft",
    (_path) => {
      motion(false);
      const screenNow = mountScreen();
      fireEvent.click(
        screen.getByRole("button", { name: /本番マイグレーション/u }),
      );
      fireEvent.change(
        screen.getByRole("textbox", { name: "Your answer to #1" }),
        { target: { value: "書きかけ" } },
      );
      thread().scrollTop = 120;
      fireEvent.scroll(thread());
      screenNow.leave();
      expect(document.querySelector(".orchestrator-board")).toBeNull();
      screenNow.back();
      expect(document.querySelector(".orchestrator-reading")).not.toBeNull();
      // Shown where it was, not slid in again.
      const stage = document.querySelector(".orchestrator-stage");
      expect(stage).toHaveAttribute("data-nav", "push");
      expect(stage).toHaveAttribute("data-restored", "true");
      expect(
        screen.getByRole("textbox", { name: "Your answer to #1" }),
      ).toHaveValue("書きかけ");
      expect(thread().scrollTop).toBe(120);
      // And Esc still goes back to the board, as from any reading.
      fireEvent.keyDown(thread(), { key: "Escape" });
      expect(stage).toHaveAttribute("data-nav", "pop");
    },
  );

  it("lands on the board when it was left there", () => {
    motion(true);
    const screenNow = mountScreen();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to the board" }));
    screenNow.leave();
    screenNow.back();
    expect(document.querySelector(".orchestrator-reading")).toBeNull();
  });

  it("reads the newest entry when one came while it was away", () => {
    motion(true);
    const screenNow = mountScreen();
    fireEvent.click(screen.getByRole("button", { name: /リトライ方針/u }));
    thread().scrollTop = 7;
    fireEvent.scroll(thread());
    screenNow.leave();
    const more: OrchestratorBoardWire = {
      ...BOARD,
      inProgress: [
        {
          ...BOARD.inProgress[0]!,
          entries: [
            ...BOARD.inProgress[0]!.entries,
            { role: "orchestrator", markdown: "B も試す?", at: NOW },
          ],
        },
      ],
    };
    screenNow.back(more);
    expect(within(thread()).getByText("B も試す?")).toBeInTheDocument();
    // jsdom lays nothing out: the bottom is 0, and not where it was left.
    expect(thread().scrollTop).toBe(0);
  });

  it("falls back to the board when the escalation was closed meanwhile", () => {
    motion(true);
    const screenNow = mountScreen();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    screenNow.leave();
    const closed: OrchestratorBoardWire = {
      ...BOARD,
      needsAnswer: [],
      closed: [
        {
          ...BOARD.needsAnswer[0]!,
          state: "closed",
          closed: { at: NOW },
        },
      ],
    };
    screenNow.back(closed);
    expect(document.querySelector(".orchestrator-reading")).toBeNull();
    expect(screen.getByRole("region", { name: "要回答" })).toBeVisible();
  });

  it("falls back to the board when the escalation is gone", () => {
    motion(true);
    const screenNow = mountScreen();
    fireEvent.click(screen.getByRole("button", { name: /リトライ方針/u }));
    screenNow.leave();
    screenNow.back({ ...BOARD, inProgress: [] });
    expect(document.querySelector(".orchestrator-reading")).toBeNull();
  });

  it("is back on a closed escalation that was being read from Closed", () => {
    motion(true);
    const done = {
      ...BOARD.inProgress[0]!,
      id: 5,
      title: "終わった件",
      state: "closed" as const,
      closed: { at: NOW },
    };
    const screenNow = mountScreen({ ...BOARD, closed: [done] });
    fireEvent.click(screen.getByRole("button", { name: /^Closed/u }));
    fireEvent.click(screen.getByRole("button", { name: /終わった件/u }));
    screenNow.leave();
    screenNow.back();
    expect(document.querySelector(".orchestrator-reading")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "終わった件" })).toBeVisible();
  });

  it("restores the tab", () => {
    motion(true);
    window.devhub = {
      ...(window.devhub as object),
      listOrchestratorFolder: () =>
        Promise.resolve({ root: "/o", path: "", entries: [] }),
      onOrchestratorFilesChanged: () => () => undefined,
    } as unknown as typeof window.devhub;
    const screenNow = mountScreen();
    fireEvent.click(screen.getByRole("tab", { name: /ファイル/u }));
    screenNow.leave();
    // Not only `sessionStorage`: the page's own memory for the session.
    window.sessionStorage.clear();
    screenNow.back();
    expect(screen.getByRole("tab", { name: /ファイル/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("going to a Workspace from an escalation", () => {
  const WORKSPACES = [
    {
      id: "w-pay",
      label: "payments",
      root: "/w/payments",
      agents: [{ id: "a1" }],
    },
    { id: "w-ops", label: "ops", root: "/w/ops", agents: [] },
  ];

  it("offers each agent's Workspace and the escalation's own, by name with a folder, no tooltip", () => {
    motion(true);
    mountScreen(
      {
        ...BOARD,
        needsAnswer: [{ ...BOARD.needsAnswer[0]!, workspaceId: "w-ops" }],
      },
      WORKSPACES,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    const pay = screen.getByRole("button", { name: "Workspace payments" });
    expect(pay).toHaveTextContent("payments");
    expect(pay.querySelector("svg")).not.toBeNull();
    expect(pay).not.toHaveAttribute("title");
    // Beside the agent it is the Workspace of.
    expect(pay.previousElementSibling).toHaveTextContent("payments-migration");
    expect(
      screen.getByRole("button", { name: "Workspace ops" }),
    ).toBeInTheDocument();
  });

  it("goes there explicitly, and Back comes back to the escalation", () => {
    motion(true);
    const screenNow = mountScreen(BOARD, WORKSPACES);
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Your answer to #1" }),
      { target: { value: "確認中" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Workspace payments" }));
    expect(screenNow.dispatch).toHaveBeenCalledWith({
      type: "select_context",
      context: { kind: "workspace", workspaceId: "w-pay" },
      reason: "explicit",
    });
    // The Workspace is selected; then Back (prefix+h) selects the row again.
    screenNow.leave();
    screenNow.back();
    expect(
      screen.getByRole("textbox", { name: "Your answer to #1" }),
    ).toHaveValue("確認中");
    // The agent chip still shows the agent.
    fireEvent.click(
      screen.getByRole("button", { name: /payments-migration/u }),
    );
    expect(screenNow.dispatch).toHaveBeenLastCalledWith({
      type: "select_context",
      context: { kind: "agent", agentId: "a1" },
      reason: "explicit",
    });
  });
});
