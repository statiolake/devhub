// @vitest-environment jsdom

/**
 * Talking to a GUI Agent: the composer, the header and the keys.
 *
 * ⌘Return sends and Return (with Shift or without) is a new line, in every
 * field where something is written to send; nothing is sent while an input
 * method is composing; text is cleared only once the Agent has it; `/` offers the
 * Agent's own commands; ↑ and ↓ walk what the person said to this Agent; Esc
 * and Ctrl+C stop a running turn and nothing else; the pickers offer the
 * session's own choices and show only what the session says is current; and
 * every call that fails is handed to the page's root.
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
  DRAFT_PAUSE_MS,
  REWIND_NOTE,
  composerPlaceholder,
} from "./Composer";
import {
  draw,
  entry,
  fakeActions,
  installResizeObserver,
  NOT_YET,
  openSetting,
  settingPicker,
  settingValue,
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
  // Nor any layout to scroll.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

const COMMANDS: readonly SlashCommand[] = [
  {
    trigger: "/",
    name: "review",
    description: "Review the current diff",
    argumentHint: "[path]",
    route: "message",
  },
  {
    trigger: "/",
    name: "compact",
    description: "Summarize the conversation so far",
    argumentHint: undefined,
    route: "message",
  },
  {
    trigger: "/",
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

/** The modifiers of the send key, ⌘Return. */
const SEND = { metaKey: true } as const;

describe("skill names", () => {
  const backdrop = () =>
    document.querySelector(".conversation-composer-backdrop");

  it("tints a known command under the field without touching its value", () => {
    draw(withSession());
    type("/review src");
    expect(composer()).toHaveValue("/review src");
    expect(backdrop()?.textContent).toBe("/review src​");
    expect(
      [
        ...document.querySelectorAll(".conversation-composer-backdrop mark"),
      ].map((mark) => mark.textContent),
    ).toEqual(["/review"]);
    expect(backdrop()).toHaveAttribute("aria-hidden", "true");
  });

  it("draws no backdrop for an unknown name", () => {
    draw(withSession());
    type("/foo bar");
    expect(backdrop()).toBeNull();
  });

  it("tints the person's sent message the same way", () => {
    draw(withSession([put(user("u1", "/review the diff, /foo"))]));
    const text = document.querySelector(".conversation-user-text");
    expect(
      [...(text?.querySelectorAll(".conversation-skill") ?? [])].map(
        (span) => span.textContent,
      ),
    ).toEqual(["/review"]);
    expect(text?.textContent).toBe("/review the diff, /foo");
  });
});

describe("sending", () => {
  it("sends on ⌘Return and clears the text once the Agent has it", async () => {
    const { actions } = draw(withSession());
    type("fix the build");
    press("Enter", SEND);
    expect(actions.send).toHaveBeenCalledWith("fix the build", []);
    await waitFor(() => expect(composer()).toHaveValue(""));
  });

  it("leaves Return and Shift+Return to the field, as a new line, and sends nothing", () => {
    const { actions } = draw(withSession());
    type("first line");
    for (const init of [{}, { shiftKey: true }]) {
      // Not taken: the textarea's own Return puts the new line in.
      expect(fireEvent.keyDown(composer(), { key: "Enter", ...init })).toBe(
        true,
      );
    }
    expect(actions.send).not.toHaveBeenCalled();
  });

  it("sends on no other modifier with Return", () => {
    const { actions } = draw(withSession());
    type("not yet");
    press("Enter", { ctrlKey: true });
    press("Enter", { altKey: true });
    press("Enter", { metaKey: true, shiftKey: true });
    expect(actions.send).not.toHaveBeenCalled();
  });

  it("sends nothing while an input method is composing", () => {
    const { actions } = draw(withSession());
    type("にほんご");
    press("Enter", { ...SEND, isComposing: true });
    press("Enter", { ...SEND, keyCode: 229 });
    fireEvent.compositionStart(composer());
    press("Enter", SEND);
    expect(actions.send).not.toHaveBeenCalled();
    fireEvent.compositionEnd(composer());
    press("Enter", SEND);
    expect(actions.send).toHaveBeenCalledOnce();
  });

  it("says the send key where it says what the keys do", () => {
    draw(withSession());
    expect(COMPOSER_PLACEHOLDER).toMatch(/⌘Return to send/);
    expect(COMPOSER_PLACEHOLDER).not.toMatch(/Shift\+Enter/);
    expect(
      document.querySelector(".conversation-empty-hint"),
    ).toHaveTextContent("⌘Return sends, Return starts a new line");
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute(
      "title",
      "Send (⌘Return)",
    );
  });

  it("sends nothing that is only whitespace", () => {
    const { actions } = draw(withSession());
    type("   \n ");
    press("Enter", SEND);
    expect(actions.send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("keeps the text and reports the failure when the send does not reach the Agent", async () => {
    const lost = new Error("the host did not answer");
    const actions = fakeActions({ send: vi.fn(() => Promise.reject(lost)) });
    draw(withSession(), actions);
    type("do not lose this");
    press("Enter", SEND);
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
    press("Enter", SEND);
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
    press("Enter", SEND);
    expect(actions.send).toHaveBeenCalledWith("also check the tests", []);
  });
});

describe("when the conversation takes no input", () => {
  const cases: readonly [ConversationState, string][] = [
    [
      {
        phase: "broken",
        failure: { code: "not_signed_in", detail: "" },
      },
      "This conversation takes no more input until the Agent's CLI is signed in again and restarted.",
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
      press("Enter", SEND);
      expect(actions.send).toHaveBeenCalledWith("later", []);
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

  it("says the highlighted command's whole description under the list, and keeps it in view as the arrows move", () => {
    draw(withSession());
    type("/");
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();
    press("ArrowDown");
    const options = within(
      screen.getByRole("listbox", { name: "Commands" }),
    ).getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAccessibleDescription(
      "Summarize the conversation so far",
    );
    expect(options[0]).not.toHaveAccessibleDescription();
    expect(scrolled.mock.contexts.at(-1)).toBe(options[1]);
    expect(scrolled).toHaveBeenLastCalledWith({ block: "nearest" });
  });

  it("draws every command on one line, cutting only the description (and a long hint) with an ellipsis", () => {
    draw(withSession());
    type("/");
    const option = within(screen.getByRole("listbox")).getAllByRole(
      "option",
    )[0]!;
    // Drawn as DevHub's other lists are.
    expect(option).toHaveClass("mac-list-row");
    // jsdom applies no stylesheet, so the rules are read where they are written.
    const css = readFileSync("src/shell/conversation/conversation.css", "utf8");
    const rule = (selector: string) =>
      new RegExp(`\\n${selector.replaceAll(".", "\\.")} \\{([^}]*)\\}`).exec(
        css,
      )?.[1] ?? "";
    expect(rule(".conversation-completion")).toMatch(/white-space:\s*nowrap/);
    const name = rule(".conversation-completion-name");
    expect(name).toMatch(/flex:\s*none/);
    expect(name).toMatch(/white-space:\s*nowrap/);
    for (const cut of [
      ".conversation-completion-hint",
      ".conversation-completion-description",
    ]) {
      const each = rule(cut);
      expect(each, cut).toMatch(/white-space:\s*nowrap/);
      expect(each, cut).toMatch(/overflow:\s*hidden/);
      expect(each, cut).toMatch(/text-overflow:\s*ellipsis/);
      expect(each, cut).toMatch(/min-width:\s*0/);
    }
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

  it("picks with Return while the list is open, not while an input method is composing, and ⌘Return sends what is typed", () => {
    const { actions } = draw(withSession());
    type("/rev");
    press("Enter", { isComposing: true });
    expect(composer()).toHaveValue("/rev");
    press("Enter", SEND);
    expect(actions.send).toHaveBeenCalledWith("/rev", []);
  });

  it("opens the header's picker for a command DevHub handles itself", () => {
    const { actions } = draw(withSession());
    type("/mod");
    press("Enter");
    const picker = settingPicker("Model");
    expect(picker).toHaveFocus();
    expect(picker).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox", { name: "Model" })).toBeVisible();
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
    press("Enter", SEND);
    expect(actions.send).toHaveBeenCalledWith("/zzz", []);
  });
});

describe("skills", () => {
  const SKILLS: readonly SlashCommand[] = [
    ...COMMANDS,
    {
      trigger: "$",
      name: "release-notes",
      description: "Write release notes",
      argumentHint: undefined,
      route: "message",
    },
    {
      trigger: "$",
      name: "skill-creator",
      description: "Create a skill",
      argumentHint: undefined,
      route: "message",
    },
  ];
  const withSkills = () => withSession([], { ...SESSION, commands: SKILLS });

  it("offers the Agent's skills after a $, anywhere in the message, and only its commands after a /", () => {
    draw(withSkills());
    type("$");
    expect(
      within(screen.getByRole("listbox", { name: "Skills" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "$release-notesWrite release notes",
      "$skill-creatorCreate a skill",
    ]);
    type("please use $sk");
    expect(
      within(screen.getByRole("listbox", { name: "Skills" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["$skill-creatorCreate a skill"]);
    type("/");
    expect(
      within(screen.getByRole("listbox", { name: "Commands" }))
        .getAllByRole("option")
        .map((option) => option.textContent?.slice(0, 1)),
    ).toEqual(["/", "/", "/"]);
    // Not in the middle of a word, and not once the name is done.
    type("a$re");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("use $release-notes now");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("completes the skill in place of what was typed after the $, keeping the words before it, and sends nothing", () => {
    const { actions } = draw(withSkills());
    type("please use $rel");
    press("Enter");
    expect(composer()).toHaveValue("please use $release-notes ");
    expect(actions.send).not.toHaveBeenCalled();
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
  it("stops a running turn on Esc or Ctrl+C, from the composer, the transcript, or with the keyboard nowhere", () => {
    const { actions } = draw(withSession([RUNNING, put(user("u1", "go"))]));
    press("Escape");
    fireEvent.keyDown(composer(), { key: "c", ctrlKey: true });
    fireEvent.keyDown(document.querySelector(".conversation-scroll")!, {
      key: "Escape",
    });
    // A click on the transcript's words leaves the keyboard on the body.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(actions.interrupt).toHaveBeenCalledTimes(4);
  });

  it("leaves those keys alone while the pane is not the one shown, or when they are typed outside it", () => {
    const { actions, redraw } = draw(
      withSession([RUNNING, put(user("u1", "go"))]),
    );
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    fireEvent.keyDown(elsewhere, { key: "Escape" });
    redraw(withSession([RUNNING, put(user("u1", "go"))]), true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    elsewhere.remove();
    expect(actions.interrupt).not.toHaveBeenCalled();
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
    expect(settingValue("Model")).toBe("Large");
    expect(openSetting("Model").map((row) => row.textContent)).toEqual([
      "Large",
      "Small",
    ]);
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
    fireEvent.click(openSetting("Model")[1]!);
    expect(actions.setSetting).toHaveBeenCalledWith("model", "small");
    expect(screen.queryByRole("listbox")).toBeNull();
    // Until the session reports the change, the picker says what is true.
    expect(settingValue("Model")).toBe("Large");
    redraw(
      withSession([], {
        ...SESSION,
        model: { ...SESSION.model, current: "small" },
      }),
    );
    expect(settingValue("Model")).toBe("Small");
  });

  it("reports a change that failed and stays on the current value", async () => {
    const refused = new Error("unknown model");
    const actions = fakeActions({
      setSetting: vi.fn(() => Promise.reject(refused)),
    });
    draw(withSession(), actions);
    fireEvent.click(openSetting("Model")[1]!);
    await waitFor(() =>
      expect(actions.reportFailure).toHaveBeenCalledWith(refused),
    );
    expect(settingValue("Model")).toBe("Large");
  });

  it("keeps a current value the choices do not list as a row, checked", () => {
    draw(
      withSession([], {
        ...SESSION,
        model: { ...SESSION.model, current: "experimental" },
      }),
    );
    expect(settingValue("Model")).toBe("experimental");
    expect(
      openSetting("Model").map((row) => [
        row.textContent,
        row.getAttribute("aria-checked"),
      ]),
    ).toEqual([
      ["experimental", "true"],
      ["Large", "false"],
      ["Small", "false"],
    ]);
  });

  it("says under the composer how full the context is, and nothing else the session used", () => {
    draw(
      withSession([
        {
          type: "usage",
          usage: {
            inputTokens: 10,
            outputTokens: 930,
            cachedInputTokens: undefined,
            contextTokens: 170_000,
            contextWindow: 200_000,
            costUsd: 1.234,
            rateLimits: [
              {
                window: "5-hour",
                durationMinutes: 300,
                usedPercent: 20,
                resetsAt: undefined,
              },
            ],
          },
        },
      ]),
    );
    const context = screen.getByRole("status", {
      name: "Context 85% · 170k of 200k",
    });
    expect(context).toHaveTextContent("Context 85% · 170k of 200k");
    // Near the end of the window: coloured, by the rule every meter uses.
    expect(context).toHaveAttribute("data-level", "near");
    expect(context.closest(".conversation-composer")?.contains(context)).toBe(
      true,
    );
    // Money and the rate limits are not the conversation's to draw.
    expect(document.body).not.toHaveTextContent("$1.23");
    expect(document.body).not.toHaveTextContent("5-hour");
    expect(document.querySelector(".conversation-header")).toBeNull();
  });

  it("draws no context readout until the CLI has said how full it is", () => {
    draw(withSession());
    expect(document.querySelector(".conversation-context")).toBeNull();
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
        trigger: "/",
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
    fireEvent.keyDown(composer(), { key: "Enter", ...SEND });
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

describe("/mcp", () => {
  it("typed out whole opens DevHub's MCP panel and sends nothing", () => {
    const actions = fakeActions();
    draw(
      withSession([], {
        ...SESSION,
        commands: [
          ...COMMANDS,
          {
            trigger: "/",
            name: "mcp",
            description: "MCP servers",
            argumentHint: undefined,
            route: "mcp",
          },
        ],
      }),
      actions,
    );
    fireEvent.change(composer(), { target: { value: "/mcp" } });
    fireEvent.keyDown(composer(), { key: "Escape" });
    fireEvent.keyDown(composer(), { key: "Enter", ...SEND });
    expect(actions.openMcp).toHaveBeenCalledOnce();
    expect(actions.send).not.toHaveBeenCalled();
  });
});

describe("/restart", () => {
  const restartable = withSession([], {
    ...SESSION,
    commands: [
      ...COMMANDS,
      {
        trigger: "/",
        name: "restart",
        description:
          "Restart the session: start the CLI again, reconnecting its MCP servers",
        argumentHint: undefined,
        route: "restart",
      },
    ],
  });

  it("typed out whole restarts the session through DevHub and sends nothing", () => {
    const actions = fakeActions();
    draw(restartable, actions);
    fireEvent.change(composer(), { target: { value: "/restart" } });
    fireEvent.keyDown(composer(), { key: "Escape" });
    fireEvent.keyDown(composer(), { key: "Enter", ...SEND });
    expect(actions.restart).toHaveBeenCalledOnce();
    expect(actions.send).not.toHaveBeenCalled();
    expect(composer()).toHaveValue("");
  });

  it("says why when the restart is refused", async () => {
    const refused = new Error("not now");
    const actions = fakeActions({
      restart: vi.fn(() => Promise.reject(refused)),
    });
    draw(restartable, actions);
    fireEvent.change(composer(), { target: { value: "/restart" } });
    fireEvent.keyDown(composer(), { key: "Escape" });
    fireEvent.keyDown(composer(), { key: "Enter", ...SEND });
    await waitFor(() =>
      expect(actions.reportFailure).toHaveBeenCalledWith(refused),
    );
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
        images: [],
        failure: undefined,
        editing: false,
      },
      {
        id: pendingId("held:2"),
        text: "and the docs",
        images: [],
        failure: "the host is gone",
        editing: false,
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

  it("is held in main while it is changed in place: ⌘Return saves, Esc gives up and stops no turn", async () => {
    const { actions } = draw(withSession([RUNNING, HELD]));
    const edit = () =>
      fireEvent.click(
        within(item("look at the tests")).getByRole("button", {
          name: "Edit",
        }),
      );
    edit();
    expect(actions.startEditingPending).toHaveBeenCalledWith(
      pendingId("held:1"),
    );
    const field = await screen.findByLabelText("Waiting message");
    expect(field).toHaveValue("look at the tests");
    expect(field).toHaveFocus();
    const end = "look at the tests".length;
    expect((field as HTMLTextAreaElement).selectionStart).toBe(end);
    expect((field as HTMLTextAreaElement).selectionEnd).toBe(end);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByLabelText("Waiting message")).toBeNull();
    expect(actions.stopEditingPending).toHaveBeenCalledWith(
      pendingId("held:1"),
    );
    expect(actions.interrupt).not.toHaveBeenCalled();

    edit();
    fireEvent.change(await screen.findByLabelText("Waiting message"), {
      target: { value: "look at the unit tests" },
    });
    fireEvent.keyDown(screen.getByLabelText("Waiting message"), {
      key: "Enter",
      ...SEND,
    });
    expect(actions.editPending).toHaveBeenCalledWith(
      pendingId("held:1"),
      "look at the unit tests",
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Waiting message")).toBeNull(),
    );
    expect(actions.stopEditingPending).toHaveBeenCalledTimes(1);
  });

  it("is changed under the composer's keys: Return is a new line, and nothing is saved while an input method is composing", async () => {
    const { actions } = draw(withSession([RUNNING, HELD]));
    fireEvent.click(
      within(item("look at the tests")).getByRole("button", { name: "Edit" }),
    );
    const field = await screen.findByLabelText("Waiting message");
    for (const init of [{}, { shiftKey: true }]) {
      expect(fireEvent.keyDown(field, { key: "Enter", ...init })).toBe(true);
    }
    fireEvent.keyDown(field, { key: "Enter", ...SEND, isComposing: true });
    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: "Enter", ...SEND });
    expect(actions.editPending).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: "Enter", ...SEND });
    expect(actions.editPending).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "title",
      "Save (⌘Return)",
    );
  });

  it("is changed in a field that grows with its text from three lines, as the composer's does", async () => {
    draw(withSession([RUNNING, HELD]));
    fireEvent.click(
      within(item("look at the tests")).getByRole("button", { name: "Edit" }),
    );
    const field = await screen.findByLabelText("Waiting message");
    expect(field).toHaveAttribute("rows", "3");
    // jsdom applies no stylesheet, so the rule is read where it is written.
    const css = readFileSync("src/shell/conversation/conversation.css", "utf8");
    const rule = (selector: string) =>
      new RegExp(`\\n${selector.replaceAll(".", "\\.")} \\{([^}]*)\\}`).exec(
        css,
      )?.[1] ?? "";
    const pending = rule(".conversation-pending-input");
    expect(pending).toMatch(/field-sizing:\s*content/);
    expect(pending).toMatch(/min-height:\s*calc\(3lh/);
    expect(pending).toMatch(/resize:\s*none/);
    // No taller than the composer's field may grow.
    const composer = rule(".conversation-composer-input");
    expect(pending).toMatch(/max-height:\s*40vh/);
    expect(composer).toMatch(/max-height:\s*40vh/);
  });

  it("lets main go of an edit left open when the composer goes away", async () => {
    const { actions, unmount } = draw(withSession([RUNNING, HELD]));
    fireEvent.click(
      within(item("look at the tests")).getByRole("button", { name: "Edit" }),
    );
    await screen.findByLabelText("Waiting message");
    unmount();
    expect(actions.stopEditingPending).toHaveBeenCalledWith(
      pendingId("held:1"),
    );
  });

  it("opens no editor when main would not hold the message, and says why", async () => {
    const gone = new Error("That message is no longer waiting.");
    const actions = fakeActions({
      startEditingPending: vi.fn(() => Promise.reject(gone)),
    });
    draw(withSession([RUNNING, HELD]), actions);
    fireEvent.click(
      within(item("look at the tests")).getByRole("button", { name: "Edit" }),
    );
    await waitFor(() =>
      expect(actions.reportFailure).toHaveBeenCalledWith(gone),
    );
    expect(screen.queryByLabelText("Waiting message")).toBeNull();
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
    fireEvent.keyDown(field, { key: "Enter", ...SEND });
    expect(actions.instruct).toHaveBeenCalledWith(
      entryId("task"),
      "look in lib/ too",
    );
    expect(actions.send).not.toHaveBeenCalled();
    await waitFor(() => expect(field).toHaveValue(""));
  });

  it("is written under the composer's keys: Return is a new line, ⌘Return sends", () => {
    const { actions } = draw(spawned(true));
    const field = screen.getByLabelText("Message to Explorer");
    fireEvent.change(field, { target: { value: "look in lib/ too" } });
    expect(fireEvent.keyDown(field, { key: "Enter" })).toBe(true);
    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: "Enter", ...SEND });
    expect(actions.instruct).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: "Enter", ...SEND });
    expect(actions.instruct).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Send to Explorer" }),
    ).toHaveAttribute("title", "Send to this subagent (⌘Return)");
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

describe("an answer typed into a request", () => {
  const DENYING = withSession([
    put(tool("t1", "Bash: rm -rf build", { status: "running" })),
    opened(toolRequest("r1", "t1")),
  ]);
  const ASKING = withSession([
    opened({
      id: "q1" as never,
      entry: undefined,
      subject: {
        kind: "question",
        questions: [
          {
            id: "targets",
            header: "Targets",
            text: "Where should it run?",
            options: [{ label: "macOS", description: "", preview: undefined }],
            multiSelect: true,
            allowsOther: true,
          },
        ],
      },
      choices: [],
    }),
  ]);

  it("is written under the composer's keys in a choice that takes text: Return is a new line, ⌘Return answers", async () => {
    const { actions } = draw(DENYING);
    fireEvent.click(screen.getByRole("button", { name: "Deny…" }));
    const field = screen.getByRole("textbox", { name: "Deny" });
    fireEvent.change(field, { target: { value: "use the clean script" } });
    expect(fireEvent.keyDown(field, { key: "Enter" })).toBe(true);
    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: "Enter", ...SEND });
    expect(actions.answer).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: "Enter", ...SEND });
    await waitFor(() =>
      expect(actions.answer).toHaveBeenCalledWith("r1", {
        kind: "choice",
        choiceId: "deny",
        text: "use the clean script",
      }),
    );
  });

  it("is written under the composer's keys in a question's Other: Return is a new line, ⌘Return answers", async () => {
    const { actions } = draw(ASKING);
    const field = screen.getByRole("textbox", { name: "Targets: other" });
    expect(field.tagName).toBe("TEXTAREA");
    fireEvent.change(field, { target: { value: "FreeBSD" } });
    expect(fireEvent.keyDown(field, { key: "Enter" })).toBe(true);
    fireEvent.keyDown(field, { key: "Enter", ...SEND, isComposing: true });
    expect(actions.answer).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter", ...SEND });
    await waitFor(() =>
      expect(actions.answer).toHaveBeenCalledWith("q1", {
        kind: "answers",
        values: { targets: ["FreeBSD"] },
      }),
    );
  });
});

describe("images", () => {
  const png = (name: string) =>
    new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
  const box = () =>
    document.querySelector<HTMLElement>(".conversation-composer-box")!;

  it("pasted are attached as thumbnails, each removable, and go with the words", async () => {
    const { actions } = draw(withSession());
    fireEvent.paste(composer(), {
      clipboardData: { files: [png("one.png"), png("two.png")] },
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole("list", { name: "Attached images" })
          .querySelectorAll("img").length,
      ).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove one.png" }));
    expect(screen.queryByRole("button", { name: "Remove one.png" })).toBeNull();
    type("what is this?");
    press("Enter", SEND);
    expect(actions.send).toHaveBeenCalledWith("what is this?", [
      {
        mediaType: "image/png",
        source: { kind: "data", base64: "iVBORw==" },
        label: "two.png",
      },
    ]);
    await waitFor(() =>
      expect(
        screen.queryByRole("list", { name: "Attached images" }),
      ).toBeNull(),
    );
  });

  it("dropped on the box are attached, and can be sent without words", async () => {
    const { actions } = draw(withSession());
    fireEvent.drop(box(), {
      dataTransfer: { files: [png("drop.png")], types: ["Files"] },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove drop.png" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    press("Enter", SEND);
    expect(actions.send).toHaveBeenCalledWith("", [
      expect.objectContaining({ label: "drop.png" }),
    ]);
  });

  it("refuses a file that is not an image a model takes, at the page's root, naming it", async () => {
    const { actions } = draw(withSession());
    fireEvent.paste(composer(), {
      clipboardData: {
        files: [new File(["x"], "notes.pdf", { type: "application/pdf" })],
      },
    });
    await waitFor(() => expect(actions.reportFailure).toHaveBeenCalledOnce());
    expect(
      (vi.mocked(actions.reportFailure).mock.calls[0]![0] as Error).message,
    ).toBe(
      "notes.pdf cannot be attached: the Agent takes PNG, JPEG, GIF or WebP images.",
    );
    expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull();
  });

  it("leaves text pasted as text", () => {
    draw(withSession());
    const event = fireEvent.paste(composer(), {
      clipboardData: { files: [], getData: () => "hello" },
    });
    expect(event).toBe(true);
  });
});

describe("the unsent draft", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let a resolved call's `then` run. */
  async function settle() {
    await act(async () => {});
  }

  it("is reported once typing pauses, not on every keystroke", () => {
    const { actions } = draw(withSession());
    type("fix");
    act(() => vi.advanceTimersByTime(DRAFT_PAUSE_MS - 1));
    type("fix the");
    act(() => vi.advanceTimersByTime(DRAFT_PAUSE_MS - 1));
    type("fix the build");
    expect(actions.saveDraft).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(DRAFT_PAUSE_MS));
    expect(actions.saveDraft).toHaveBeenCalledTimes(1);
    expect(actions.saveDraft).toHaveBeenCalledWith("fix the build");
  });

  it("is reported at once when the page is unloaded, the composer loses the keyboard, or it goes away", () => {
    const { actions, unmount } = draw(withSession());
    type("one");
    fireEvent(window, new Event("pagehide"));
    expect(actions.saveDraft).toHaveBeenLastCalledWith("one");
    type("two");
    fireEvent(window, new Event("beforeunload"));
    expect(actions.saveDraft).toHaveBeenLastCalledWith("two");
    type("three");
    fireEvent.blur(composer());
    expect(actions.saveDraft).toHaveBeenLastCalledWith("three");
    type("four");
    unmount();
    expect(actions.saveDraft).toHaveBeenLastCalledWith("four");
    expect(actions.saveDraft).toHaveBeenCalledTimes(4);
    // Nothing is said twice: the pause that was pending has nothing new.
    act(() => vi.advanceTimersByTime(DRAFT_PAUSE_MS * 2));
    expect(actions.saveDraft).toHaveBeenCalledTimes(4);
  });

  it("comes back into the composer when main says what it kept, ahead of anything typed since", () => {
    const actions = fakeActions();
    const { answerDraft } = draw(withSession(), actions, false, NOT_YET);
    type("and the docs");
    // Until main has said, an empty or new composer must not replace its copy.
    act(() => vi.advanceTimersByTime(DRAFT_PAUSE_MS * 2));
    fireEvent(window, new Event("pagehide"));
    expect(actions.saveDraft).not.toHaveBeenCalled();
    answerDraft("look at the tests");
    expect(composer()).toHaveValue("look at the tests\n\nand the docs");
    act(() => vi.advanceTimersByTime(DRAFT_PAUSE_MS));
    expect(actions.saveDraft).toHaveBeenCalledWith(
      "look at the tests\n\nand the docs",
    );
  });

  it("restored as it was is not reported again", () => {
    const { actions } = draw(withSession(), fakeActions(), false, "kept");
    expect(composer()).toHaveValue("kept");
    act(() => vi.advanceTimersByTime(DRAFT_PAUSE_MS * 2));
    fireEvent(window, new Event("pagehide"));
    expect(actions.saveDraft).not.toHaveBeenCalled();
  });

  it("is cleared at once by sending it, and by emptying the field", async () => {
    const { actions } = draw(withSession(), fakeActions(), false, "kept");
    press("Enter", SEND);
    expect(actions.send).toHaveBeenCalledWith("kept", []);
    await settle();
    expect(composer()).toHaveValue("");
    expect(actions.saveDraft).toHaveBeenCalledTimes(1);
    expect(actions.saveDraft).toHaveBeenLastCalledWith("");

    type("second thoughts");
    act(() => vi.advanceTimersByTime(DRAFT_PAUSE_MS));
    type("");
    act(() => vi.advanceTimersByTime(DRAFT_PAUSE_MS));
    expect(actions.saveDraft).toHaveBeenLastCalledWith("");
  });

  it("carries the words of a waiting message being changed, ahead of the field's", async () => {
    const HELD: ConversationEvent = {
      type: "pending",
      pending: [
        {
          id: pendingId("held:1"),
          text: "look at the tests",
          images: [],
          failure: undefined,
          editing: false,
        },
      ],
    };
    const { actions } = draw(withSession([RUNNING, HELD]));
    type("and the docs");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await settle();
    fireEvent.change(screen.getByLabelText("Waiting message"), {
      target: { value: "look at the unit tests" },
    });
    act(() => vi.advanceTimersByTime(DRAFT_PAUSE_MS));
    expect(actions.saveDraft).toHaveBeenLastCalledWith(
      "look at the unit tests\n\nand the docs",
    );
    // Given up, the change is no longer part of it.
    fireEvent.keyDown(screen.getByLabelText("Waiting message"), {
      key: "Escape",
    });
    act(() => vi.advanceTimersByTime(DRAFT_PAUSE_MS));
    expect(actions.saveDraft).toHaveBeenLastCalledWith("and the docs");
  });

  it("hands a report that failed to the page's root", async () => {
    const refused = new Error("drafts.json: disk full");
    const actions = fakeActions({
      saveDraft: vi.fn(() => Promise.reject(refused)),
    });
    draw(withSession(), actions);
    type("words");
    act(() => vi.advanceTimersByTime(DRAFT_PAUSE_MS));
    await settle();
    expect(actions.reportFailure).toHaveBeenCalledWith(refused);
  });
});
