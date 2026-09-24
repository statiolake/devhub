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
  type ConversationEvent,
  type ConversationState,
  type SessionFacts,
  type SlashCommand,
} from "../../model/conversation";
import { UserFacingFailure } from "../failure";
import { COMPOSER_PLACEHOLDER } from "./Composer";
import {
  CONTINUE_IN_TERMINAL_REFUSAL,
  refuseContinueInTerminal,
} from "./continueInTerminal";
import { draw, fakeActions, installResizeObserver } from "./surfaceTestKit";
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
    [{ phase: "connecting" }, "Connecting to the Agent…"],
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
  it("puts the keyboard in the composer once a shown pane's conversation can take input", () => {
    const connecting = withSession([
      { type: "state", state: { phase: "connecting" } },
    ]);
    const { redraw } = draw(connecting);
    // Disabled while connecting: nothing can have the keyboard yet.
    expect(composer()).toBeDisabled();
    expect(composer()).not.toHaveFocus();
    redraw(withSession());
    expect(composer()).toHaveFocus();
  });

  it("puts the keyboard in the composer when the pane is shown", () => {
    const { redraw } = draw(withSession(), fakeActions(), true);
    expect(composer()).not.toHaveFocus();
    redraw(withSession(), false);
    expect(composer()).toHaveFocus();
    screen.getByRole("button", { name: "Continue in terminal" }).focus();
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

  it("refuses Continue in terminal with the reason, through the page's root", async () => {
    const actions = fakeActions({
      continueInTerminal: refuseContinueInTerminal,
    });
    draw(withSession(), actions);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue in terminal" }),
    );
    await waitFor(() => expect(actions.reportFailure).toHaveBeenCalledOnce());
    const failure = vi.mocked(actions.reportFailure).mock.calls[0]![0];
    expect(failure).toBeInstanceOf(UserFacingFailure);
    expect((failure as Error).message).toBe(CONTINUE_IN_TERMINAL_REFUSAL);
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
