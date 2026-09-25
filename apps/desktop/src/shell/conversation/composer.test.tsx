// @vitest-environment jsdom

/**
 * Talking to a GUI Agent: the composer, the header and the keys.
 *
 * Enter sends and Shift+Enter does not; nothing is sent while an input method
 * is composing; text is cleared only once the Agent has it; `/` offers the
 * Agent's own commands; ↑ and ↓ walk what the person said to this Agent; Esc
 * and Ctrl+C stop a running turn and nothing else; the pickers offer the
 * session's own choices and show only what the session says is current; and
 * every call that fails is handed to the page's root.
 */

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMPTY_SESSION,
  entryId,
  pendingId,
  type ConversationEvent,
  type ConversationState,
  type SessionFacts,
  type SlashCommand,
} from "../../model/conversation";
import {
  COMPOSER_PLACEHOLDER,
  REWIND_NOTE,
  composerPlaceholder,
} from "./Composer";
import {
  draw,
  entry,
  fakeActions,
  installResizeObserver,
} from "./surfaceTestKit";
import {
  opened,
  put,
  tool,
  toolRequest,
  transcriptOf,
  user,
} from "./transcriptFixtures";

beforeAll(() => {
  installResizeObserver();
  // jsdom has no native picker to open; this records that one was asked for.
  HTMLSelectElement.prototype.showPicker = vi.fn();
  // Nor any layout to scroll.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

const COMMANDS: readonly SlashCommand[] = [
  {
    name: "review",
    description: "Review the current diff",
    argumentHint: "[path]",
    route: "message",
  },
  {
    name: "compact",
    description: "Summarize the conversation so far",
    argumentHint: undefined,
    route: "message",
  },
  {
    name: "model",
    description: "Choose the model",
    argumentHint: undefined,
    route: "model",
  },
];

const SESSION: SessionFacts = {
  ...EMPTY_SESSION,
  model: {
    current: "large",
    choices: [
      { id: "large", label: "Large" },
      { id: "small", label: "Small" },
    ],
  },
  effort: { current: undefined, choices: [] },
  mode: { current: "ask", choices: [] },
  commands: COMMANDS,
  canRewind: false,
};

const RUNNING: ConversationEvent = {
  type: "state",
  state: { phase: "ready", turn: "running" },
};

function withSession(
  events: readonly ConversationEvent[] = [],
  session: SessionFacts = SESSION,
) {
  return transcriptOf([{ type: "session", session }, ...events]);
}

/** The composer, found whether or not its pane is shown. */
function composer(): HTMLTextAreaElement {
  return screen.getByLabelText("Message to the Agent");
}

function type(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
}

function press(key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(composer(), { key, ...init });
}

describe("sending", () => {
  it("sends on Enter and clears the text once the Agent has it", async () => {
    const { actions } = draw(withSession());
    type("fix the build");
    press("Enter");
    expect(actions.send).toHaveBeenCalledWith("fix the build");
    await waitFor(() => expect(composer()).toHaveValue(""));
  });

  it("starts a new line on Shift+Enter and sends nothing", () => {
    const { actions } = draw(withSession());
    type("first line");
    press("Enter", { shiftKey: true });
    expect(actions.send).not.toHaveBeenCalled();
  });

  it("sends nothing while an input method is composing", () => {
    const { actions } = draw(withSession());
    type("にほんご");
    press("Enter", { isComposing: true });
    press("Enter", { keyCode: 229 });
    fireEvent.compositionStart(composer());
    press("Enter");
    expect(actions.send).not.toHaveBeenCalled();
    fireEvent.compositionEnd(composer());
    press("Enter");
    expect(actions.send).toHaveBeenCalledOnce();
  });

  it("sends nothing that is only whitespace", () => {
    const { actions } = draw(withSession());
    type("   \n ");
    press("Enter");
    expect(actions.send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("keeps the text and reports the failure when the send does not reach the Agent", async () => {
    const lost = new Error("the host did not answer");
    const actions = fakeActions({ send: vi.fn(() => Promise.reject(lost)) });
    draw(withSession(), actions);
    type("do not lose this");
    press("Enter");
    await waitFor(() =>
      expect(actions.reportFailure).toHaveBeenCalledWith(lost),
    );
    expect(composer()).toHaveValue("do not lose this");
  });

  it("keeps what was typed after the send went out", async () => {
    let deliver: () => void = () => {};
    const actions = fakeActions({
      send: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            deliver = resolve;
          }),
      ),
    });
    draw(withSession(), actions);
    type("first");
    press("Enter");
    type("second, typed while the first was on its way");
    deliver();
    await waitFor(() => expect(actions.send).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(composer()).toHaveValue(
      "second, typed while the first was on its way",
    );
  });

  it("sends mid-turn too: the CLI decides what a message during a turn means", () => {
    const { actions } = draw(withSession([RUNNING]));
    type("also check the tests");
    press("Enter");
    expect(actions.send).toHaveBeenCalledWith("also check the tests");
  });
});

describe("when the conversation takes no input", () => {
  const cases: readonly [ConversationState, string][] = [
    [
      {
        phase: "broken",
        failure: { code: "not_signed_in", detail: "" },
      },
      "This conversation takes no more input: the Agent's CLI is not signed in.",
    ],
    [
      {
        phase: "broken",
        failure: { code: "protocol_mismatch", detail: "assistant.content" },
      },
      "This conversation takes no more input: DevHub could not read what the Agent said.",
    ],
  ];
  for (const [state, reason] of cases) {
    it(`says why: ${state.phase}${state.phase === "broken" ? ` (${state.failure.code})` : ""}`, () => {
      draw(withSession([{ type: "state", state }]));
      expect(composer()).toBeDisabled();
      expect(composer()).toHaveAttribute("placeholder", reason);
      expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();
    });
  }

  it("takes input once it is ready, with the usual hint", () => {
    draw(withSession());
    expect(composer()).toBeEnabled();
    expect(composer()).toHaveAttribute("placeholder", COMPOSER_PLACEHOLDER);
  });

  it("takes input while the Agent cannot take it yet, saying it waits", () => {
    for (const state of [
      { phase: "connecting" },
      { phase: "ready", turn: "rewinding" },
    ] as const) {
      cleanup();
      const { actions } = draw(withSession([{ type: "state", state }]));
      expect(composer()).toBeEnabled();
      expect(composer()).toHaveAttribute(
        "placeholder",
        composerPlaceholder(state),
      );
      expect(composerPlaceholder(state)).toMatch(
        /What you send now is sent once/,
      );
      // The settings are the CLI's: they wait for it.
      expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();
      type("later");
      press("Enter");
      expect(actions.send).toHaveBeenCalledWith("later");
    }
  });
});

describe("slash commands", () => {
  it("offers the Agent's own commands after a /, with what each does", () => {
    draw(withSession());
    type("/");
    const list = screen.getByRole("listbox", { name: "Commands" });
    const options = within(list).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "/review[path]Review the current diff",
      "/compactSummarize the conversation so far",
      "/modelChoose the model",
    ]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("narrows the list as the name is typed, and closes once the name is done", () => {
    draw(withSession());
    type("/com");
    expect(
      within(screen.getByRole("listbox")).getAllByRole("option"),
    ).toHaveLength(1);
    type("/compact now");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("completes a message command into the text with Enter or Tab, and sends nothing", () => {
    const { actions } = draw(withSession());
    type("/");
    press("ArrowDown");
    press("Enter");
    expect(composer()).toHaveValue("/compact ");
    expect(actions.send).not.toHaveBeenCalled();
    type("/rev");
    press("Tab");
    expect(composer()).toHaveValue("/review ");
  });

  it("opens the header's picker for a command DevHub handles itself", () => {
    const { actions } = draw(withSession());
    type("/mod");
    press("Enter");
    const picker = screen.getByRole("combobox", { name: "Model" });
    expect(picker).toHaveFocus();
    expect(HTMLSelectElement.prototype.showPicker).toHaveBeenCalled();
    expect(composer()).toHaveValue("");
    expect(actions.send).not.toHaveBeenCalled();
  });

  it("closes the list on Esc without stopping the turn", () => {
    const { actions } = draw(withSession([RUNNING]));
    type("/");
    press("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(actions.interrupt).not.toHaveBeenCalled();
    // A further Esc is the turn's.
    press("Escape");
    expect(actions.interrupt).toHaveBeenCalledOnce();
  });

  it("sends a line that matches no command as it is", () => {
    const { actions } = draw(withSession());
    type("/zzz");
    expect(screen.queryByRole("listbox")).toBeNull();
    press("Enter");
    expect(actions.send).toHaveBeenCalledWith("/zzz");
  });
});

describe("history", () => {
  const said = withSession([
    put(user("u1", "first thing")),
    put(user("u2", "from a template", "injection")),
    put(user("u3", "second thing")),
    put(user("u4", "second thing")),
    put(
      tool("task", "Task", {
        spawns: {
          label: "Explore",
          prompt: "",
          model: undefined,
          state: "completed",
          takesMessages: false,
        },
      }),
    ),
    put(user("sub", "a subagent's prompt", "person", "task")),
  ]);

  it("walks what the person said to this Agent, newest first, on an empty composer", () => {
    draw(said);
    press("ArrowUp");
    expect(composer()).toHaveValue("second thing");
    press("ArrowUp");
    expect(composer()).toHaveValue("first thing");
    press("ArrowUp");
    expect(composer()).toHaveValue("first thing");
    press("ArrowDown");
    expect(composer()).toHaveValue("second thing");
    press("ArrowDown");
    expect(composer()).toHaveValue("");
  });

  it("leaves ↑ to the text once the person has typed something of their own", () => {
    draw(said);
    type("a draft");
    press("ArrowUp");
    expect(composer()).toHaveValue("a draft");
    press("ArrowUp");
    type("second thing, edited");
    press("ArrowUp");
    expect(composer()).toHaveValue("second thing, edited");
  });
});

describe("stopping a turn", () => {
  it("stops a running turn on Esc or Ctrl+C, from the composer or the transcript", () => {
    const { actions } = draw(withSession([RUNNING, put(user("u1", "go"))]));
    press("Escape");
    fireEvent.keyDown(composer(), { key: "c", ctrlKey: true });
    fireEvent.keyDown(document.querySelector(".conversation-scroll")!, {
      key: "Escape",
    });
    expect(actions.interrupt).toHaveBeenCalledTimes(3);
  });

  it("does nothing on those keys when no turn is running, or while composing", () => {
    const { actions, redraw } = draw(withSession());
    press("Escape");
    fireEvent.keyDown(composer(), { key: "c", ctrlKey: true });
    redraw(withSession([RUNNING]));
    press("Escape", { isComposing: true });
    fireEvent.keyDown(composer(), { key: "c", metaKey: true });
    expect(actions.interrupt).not.toHaveBeenCalled();
  });

  it("offers Stop in the header only while a turn runs, and reports a stop that failed", async () => {
    const refused = new Error("no turn to stop");
    const actions = fakeActions({
      interrupt: vi.fn(() => Promise.reject(refused)),
    });
    const { redraw } = draw(withSession(), actions);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    redraw(withSession([RUNNING]));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(actions.reportFailure).toHaveBeenCalledWith(refused),
    );
  });
});

describe("focus", () => {
  it("puts the keyboard in the composer of a shown pane while it connects, since what is typed is held", () => {
    draw(withSession([{ type: "state", state: { phase: "connecting" } }]));
    expect(composer()).toHaveFocus();
  });

  it("puts the keyboard in the composer when the pane is shown", () => {
    const { redraw } = draw(withSession(), fakeActions(), true);
    expect(composer()).not.toHaveFocus();
    redraw(withSession(), false);
    expect(composer()).toHaveFocus();
    screen.getByRole("combobox", { name: "Model" }).focus();
    redraw(withSession(), true);
    redraw(withSession(), false);
    expect(composer()).toHaveFocus();
  });
});

describe("the header", () => {
  it("offers the session's own choices and shows the current one", () => {
    draw(withSession());
    const model = screen.getByRole("combobox", { name: "Model" });
    expect(model).toHaveValue("large");
    expect(
      within(model)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Large", "Small"]);
    // No choices: a fact to read, not a picker.
    expect(screen.queryByRole("combobox", { name: "Permissions" })).toBeNull();
    expect(screen.getByText("Permissions").parentElement).toHaveTextContent(
      "Permissionsask",
    );
    // Nothing current and nothing to choose: not drawn at all.
    expect(screen.queryByText("Effort")).toBeNull();
  });

  it("asks for a change and moves only when the session says it has", async () => {
    const actions = fakeActions();
    const { redraw } = draw(withSession(), actions);
    const model = () => screen.getByRole("combobox", { name: "Model" });
    fireEvent.change(model(), { target: { value: "small" } });
    expect(actions.setSetting).toHaveBeenCalledWith("model", "small");
    // Until the session reports the change, the picker says what is true.
    expect(model()).toHaveValue("large");
    redraw(
      withSession([], {
        ...SESSION,
        model: { ...SESSION.model, current: "small" },
      }),
    );
    expect(model()).toHaveValue("small");
  });

  it("reports a change that failed and stays on the current value", async () => {
    const refused = new Error("unknown model");
    const actions = fakeActions({
      setSetting: vi.fn(() => Promise.reject(refused)),
    });
    draw(withSession(), actions);
    const model = screen.getByRole("combobox", { name: "Model" });
    fireEvent.change(model, { target: { value: "small" } });
    await waitFor(() =>
      expect(actions.reportFailure).toHaveBeenCalledWith(refused),
    );
    expect(model).toHaveValue("large");
  });

  it("keeps a current value the choices do not list as an option", () => {
    draw(
      withSession([], {
        ...SESSION,
        model: { ...SESSION.model, current: "experimental" },
      }),
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
      "experimental",
    );
  });

  it("reads out what the session has used, as far as it was reported", () => {
    draw(
      withSession([
        {
          type: "usage",
          usage: {
            inputTokens: undefined,
            outputTokens: undefined,
            cachedInputTokens: undefined,
            contextTokens: 90_000,
            contextWindow: 200_000,
            costUsd: 1.234,
            rateLimit: { usedPercent: 80.4, resetsAt: undefined },
          },
        },
      ]),
    );
    expect(screen.getByLabelText("Usage")).toHaveTextContent(
      "Context 45% (90k of 200k) · $1.23 · Limit 80%",
    );
  });

  it("has no Continue in terminal of its own: that is the pane's floating button", () => {
    draw(withSession());
    expect(
      screen.queryByRole("button", { name: "Continue in terminal" }),
    ).toBeNull();
  });
});

describe("/resume", () => {
  const resumable = withSession([], {
    ...SESSION,
    commands: [
      ...COMMANDS,
      {
        name: "resume",
        description: "Go on with an earlier session in this Workspace",
        argumentHint: undefined,
        route: "resume",
      },
    ],
  });

  it("typed out whole opens DevHub's session picker and sends nothing", () => {
    const actions = fakeActions();
    draw(resumable, actions);
    fireEvent.change(composer(), { target: { value: "/resume" } });
    fireEvent.keyDown(composer(), { key: "Escape" });
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(actions.openResume).toHaveBeenCalledOnce();
    expect(actions.send).not.toHaveBeenCalled();
    expect(composer()).toHaveValue("");
  });

  it("chosen from the completions opens the picker too", () => {
    const actions = fakeActions();
    draw(resumable, actions);
    fireEvent.change(composer(), { target: { value: "/resu" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(actions.openResume).toHaveBeenCalledOnce();
    expect(actions.send).not.toHaveBeenCalled();
  });
});

describe("requests from the keyboard", () => {
  const waiting = withSession([
    put(tool("t1", "Bash: npm test", { status: "running" })),
    opened(toolRequest("r1", "t1")),
  ]);

  it("names the waiting requests over the composer, and goes to the first one", () => {
    draw(waiting);
    const line = screen.getByRole("button", {
      name: /1 request is waiting for an answer/,
    });
    fireEvent.click(line);
    expect(
      screen.getByRole("group", { name: "The Agent is waiting for an answer" }),
    ).toHaveFocus();
  });

  it("presses a choice with its number", async () => {
    const { actions } = draw(waiting);
    const card = screen.getByRole("group", {
      name: "The Agent is waiting for an answer",
    });
    fireEvent.keyDown(card, { key: "2" });
    await waitFor(() =>
      expect(actions.answer).toHaveBeenCalledWith("r1", {
        kind: "choice",
        choiceId: "always",
        text: undefined,
      }),
    );
  });

  it("opens the text field for a numbered choice that takes text, and types digits there", () => {
    const { actions } = draw(waiting);
    const card = screen.getByRole("group", {
      name: "The Agent is waiting for an answer",
    });
    fireEvent.keyDown(card, { key: "3" });
    const field = screen.getByRole("textbox", { name: "Deny" });
    fireEvent.keyDown(field, { key: "1" });
    expect(actions.answer).not.toHaveBeenCalled();
  });

  it("goes back to the composer on Esc, and does not stop the turn", () => {
    const { actions } = draw(
      withSession([
        RUNNING,
        put(tool("t1", "Bash: npm test", { status: "running" })),
        opened(toolRequest("r1", "t1")),
      ]),
    );
    const card = screen.getByRole("group", {
      name: "The Agent is waiting for an answer",
    });
    card.focus();
    fireEvent.keyDown(card, { key: "Escape" });
    expect(composer()).toHaveFocus();
    expect(actions.interrupt).not.toHaveBeenCalled();
  });

  it("says how many are waiting when there are several", () => {
    draw(
      withSession([
        put(tool("t1", "Bash: a", { status: "running" })),
        opened(toolRequest("r1", "t1")),
        opened(toolRequest("r2", undefined)),
      ]),
    );
    expect(
      screen.getByRole("button", {
        name: /2 requests are waiting for an answer/,
      }),
    ).toBeInTheDocument();
  });
});

describe("rewinding", () => {
  const REWINDS: SessionFacts = { ...SESSION, canRewind: true };
  const TWO = [put(user("u1", "first")), put(user("u2", "second"))];

  function rewindButton(id: string) {
    return within(entry(id)).queryByRole("button", { name: "Rewind to here" });
  }

  it("is offered on each of the person's messages, while the session can take turns back and nothing runs", () => {
    const { redraw } = draw(withSession(TWO, REWINDS));
    expect(rewindButton("u1")).toBeInTheDocument();
    expect(rewindButton("u2")).toBeInTheDocument();

    redraw(withSession(TWO, SESSION));
    expect(rewindButton("u2")).toBeNull();

    redraw(withSession([...TWO, RUNNING], REWINDS));
    expect(rewindButton("u1")).toBeNull();
  });

  it("asks first, saying files are not changed back, and gives up on Cancel", () => {
    const { actions } = draw(withSession(TWO, REWINDS));
    fireEvent.click(rewindButton("u1")!);
    const ask = within(entry("u1")).getByRole("group", {
      name: "Rewind to here",
    });
    expect(ask).toHaveTextContent(REWIND_NOTE);
    expect(REWIND_NOTE).toContain(
      "Files the Agent changed are not changed back",
    );
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(
      within(entry("u1")).queryByRole("group", { name: "Rewind to here" }),
    ).toBeNull();
    expect(actions.rewind).not.toHaveBeenCalled();
  });

  it("puts the message's words back in the composer, ahead of the draft, once it is rewound", async () => {
    const { actions } = draw(withSession(TWO, REWINDS));
    type("a draft");
    fireEvent.click(rewindButton("u1")!);
    fireEvent.click(
      within(entry("u1")).getByRole("button", { name: "Rewind" }),
    );
    expect(actions.rewind).toHaveBeenCalledWith(entryId("u1"));
    await waitFor(() => expect(composer()).toHaveValue("first\n\na draft"));
    expect(composer()).toHaveFocus();
  });

  it("leaves the composer alone when the CLI would not rewind", async () => {
    const actions = fakeActions({
      rewind: vi.fn(() => Promise.resolve("refused" as const)),
    });
    draw(withSession(TWO, REWINDS), actions);
    fireEvent.click(rewindButton("u2")!);
    fireEvent.click(
      within(entry("u2")).getByRole("button", { name: "Rewind" }),
    );
    await waitFor(() => expect(actions.rewind).toHaveBeenCalled());
    await Promise.resolve();
    expect(composer()).toHaveValue("");
    expect(actions.reportFailure).not.toHaveBeenCalled();
  });

  it("hands a refused rewind to the page's root", async () => {
    const refused = new Error(
      "The Agent is in the middle of a turn. Stop it before rewinding.",
    );
    const actions = fakeActions({
      rewind: vi.fn(() => Promise.reject(refused)),
    });
    draw(withSession(TWO, REWINDS), actions);
    fireEvent.click(rewindButton("u2")!);
    fireEvent.click(
      within(entry("u2")).getByRole("button", { name: "Rewind" }),
    );
    await waitFor(() =>
      expect(actions.reportFailure).toHaveBeenCalledWith(refused),
    );
  });
});

describe("messages waiting to be sent", () => {
  const HELD: ConversationEvent = {
    type: "pending",
    pending: [
      {
        id: pendingId("held:1"),
        text: "look at the tests",
        failure: undefined,
      },
      {
        id: pendingId("held:2"),
        text: "and the docs",
        failure: "the host is gone",
      },
    ],
  };
  function waiting() {
    return screen.getByRole("list", { name: "Waiting to be sent" });
  }
  function item(text: string) {
    return within(waiting())
      .getAllByRole("listitem")
      .find((each) => each.textContent?.includes(text))!;
  }

  it("lists each one with what it waits for, or why it was not sent", () => {
    draw(withSession([RUNNING, HELD]));
    expect(item("look at the tests")).toHaveTextContent(
      "Waiting: sent when the Agent is ready for it",
    );
    expect(item("and the docs")).toHaveTextContent(
      "Not sent: the host is gone",
    );
  });

  it("sends one now, or removes it", () => {
    const { actions } = draw(withSession([RUNNING, HELD]));
    fireEvent.click(
      within(item("look at the tests")).getByRole("button", {
        name: "Send now",
      }),
    );
    expect(actions.sendPendingNow).toHaveBeenCalledWith(pendingId("held:1"));
    fireEvent.click(
      within(item("and the docs")).getByRole("button", { name: "Remove" }),
    );
    expect(actions.removePending).toHaveBeenCalledWith(pendingId("held:2"));
  });

  it("is changed in place: Enter saves, Esc gives up and stops no turn", async () => {
    const { actions } = draw(withSession([RUNNING, HELD]));
    fireEvent.click(
      within(item("look at the tests")).getByRole("button", { name: "Edit" }),
    );
    const field = screen.getByLabelText("Waiting message");
    expect(field).toHaveValue("look at the tests");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByLabelText("Waiting message")).toBeNull();
    expect(actions.interrupt).not.toHaveBeenCalled();

    fireEvent.click(
      within(item("look at the tests")).getByRole("button", { name: "Edit" }),
    );
    fireEvent.change(screen.getByLabelText("Waiting message"), {
      target: { value: "look at the unit tests" },
    });
    fireEvent.keyDown(screen.getByLabelText("Waiting message"), {
      key: "Enter",
    });
    expect(actions.editPending).toHaveBeenCalledWith(
      pendingId("held:1"),
      "look at the unit tests",
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Waiting message")).toBeNull(),
    );
  });

  it("cannot be sent now while the Agent cannot take a message", () => {
    draw(
      withSession([{ type: "state", state: { phase: "connecting" } }, HELD]),
    );
    expect(
      within(item("look at the tests")).getByRole("button", {
        name: "Send now",
      }),
    ).toBeDisabled();
  });

  it("hands a failed action to the page's root", async () => {
    const failure = new Error("That message is no longer waiting.");
    const actions = fakeActions({
      removePending: vi.fn(() => Promise.reject(failure)),
    });
    draw(withSession([RUNNING, HELD]), actions);
    fireEvent.click(
      within(item("and the docs")).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() =>
      expect(actions.reportFailure).toHaveBeenCalledWith(failure),
    );
  });
});

describe("a message to a subagent", () => {
  const spawned = (takesMessages: boolean) =>
    withSession([
      RUNNING,
      put(
        tool("task", "spawnAgent: list src/", {
          status: "running",
          spawns: {
            label: "Explorer",
            prompt: "list src/",
            model: undefined,
            state: "running",
            takesMessages,
          },
        }),
      ),
    ]);

  it("is offered in the card of a subagent that takes the person's messages, and goes to it", async () => {
    const { actions } = draw(spawned(true));
    const field = screen.getByLabelText("Message to Explorer");
    fireEvent.change(field, { target: { value: "look in lib/ too" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(actions.instruct).toHaveBeenCalledWith(
      entryId("task"),
      "look in lib/ too",
    );
    expect(actions.send).not.toHaveBeenCalled();
    await waitFor(() => expect(field).toHaveValue(""));
  });

  it("is not offered on one that does not", () => {
    draw(spawned(false));
    expect(screen.queryByLabelText("Message to Explorer")).toBeNull();
  });

  it("hands a failed send to the page's root and keeps the words", async () => {
    const failure = new Error("app-server did not take the message");
    const actions = fakeActions({
      instruct: vi.fn(() => Promise.reject(failure)),
    });
    draw(spawned(true), actions);
    const field = screen.getByLabelText("Message to Explorer");
    fireEvent.change(field, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Explorer" }));
    await waitFor(() =>
      expect(actions.reportFailure).toHaveBeenCalledWith(failure),
    );
    expect(field).toHaveValue("hello");
  });
});
