// @vitest-environment jsdom

/**
 * The Agent's questions: the card that asks them, with each option's
 * preview beside the options, and the person's answer drawn afterwards as
 * their own message.
 */

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  entryId,
  requestId,
  type AnswerEntry,
  type Question,
} from "../../model/conversation";
import { draw, entry, installResizeObserver } from "./surfaceTestKit";
import { opened, put, transcriptOf, user } from "./transcriptFixtures";

beforeAll(installResizeObserver);

afterEach(cleanup);

const MOCKUP = [
  "+--------+-----------+",
  "| menu   |  content  |",
  "|        |           |",
  "+--------+-----------+",
  "    indented footer",
].join("\n");

const LAYOUT: Question = {
  id: "Which layout?",
  header: "Layout",
  text: "Which layout?",
  options: [
    { label: "Sidebar", description: "a column", preview: MOCKUP },
    {
      label: "Tabs",
      description: "",
      preview: '```ts\nconst tabs = ["a", "b"];\n```',
    },
    { label: "Neither", description: "", preview: undefined },
  ],
  multiSelect: false,
  allowsOther: true,
};

function asked(questions: readonly Question[]) {
  return transcriptOf([
    opened({
      id: requestId("q1"),
      entry: undefined,
      subject: { kind: "question", questions },
      choices: [],
    }),
  ]);
}

function preview(): HTMLElement {
  return screen.getByRole("region", { name: /^Preview: / });
}

describe("a question whose options carry previews", () => {
  it("shows the options on the left and the first one's preview beside them, in a monospace box that keeps a mockup's columns", () => {
    draw(asked([LAYOUT]));
    const body = document.querySelector(".conversation-question-body")!;
    expect(body).toHaveAttribute("data-previewed");
    const [options, box] = [...body.children];
    expect(options).toHaveClass("conversation-question-options");
    expect(box).toBe(preview());
    expect(preview()).toHaveAccessibleName("Preview: Sidebar");
    expect(preview()).toHaveClass("conversation-question-preview");
    // Every line is there with its spaces, the indented one included.
    const text = preview().textContent!.replaceAll(" ", " ");
    for (const line of MOCKUP.split("\n")) expect(text).toContain(line);
  });

  it("follows the option pointed at, and the one the keyboard is on", () => {
    draw(asked([LAYOUT]));
    const tabs = screen.getByRole("radio", { name: /Tabs/ });
    fireEvent.mouseEnter(tabs.closest("label")!);
    expect(preview()).toHaveAccessibleName("Preview: Tabs");
    expect(preview().querySelector("code")).toHaveTextContent(
      'const tabs = ["a", "b"];',
    );
    fireEvent.mouseLeave(tabs.closest("label")!);
    expect(preview()).toHaveAccessibleName("Preview: Sidebar");
    fireEvent.focus(screen.getByRole("radio", { name: /Neither/ }));
    expect(preview()).toHaveAccessibleName("Preview: Neither");
    expect(preview()).toHaveTextContent("No preview");
  });

  it("stays on the option picked once the pointer and the keyboard have left", () => {
    draw(asked([LAYOUT]));
    const tabs = screen.getByRole("radio", { name: /Tabs/ });
    fireEvent.click(tabs);
    fireEvent.blur(tabs);
    expect(preview()).toHaveAccessibleName("Preview: Tabs");
  });

  it("draws no preview for a multi-select question, as the CLI does not", () => {
    draw(asked([{ ...LAYOUT, multiSelect: true }]));
    expect(
      document.querySelector(".conversation-question-body"),
    ).not.toHaveAttribute("data-previewed");
    expect(screen.queryByRole("region", { name: /^Preview: / })).toBeNull();
  });

  it("draws no preview box for a question none of whose options has one", () => {
    draw(
      asked([
        {
          ...LAYOUT,
          options: LAYOUT.options.map((option) => ({
            ...option,
            preview: undefined,
          })),
        },
      ]),
    );
    expect(screen.queryByRole("region", { name: /^Preview: / })).toBeNull();
  });

  it("still answers with the option picked", async () => {
    const { actions } = draw(asked([LAYOUT]));
    fireEvent.click(screen.getByRole("radio", { name: /Tabs/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(actions.answer).toHaveBeenCalledWith("q1", {
        kind: "answers",
        values: { "Which layout?": "Tabs" },
      }),
    );
  });
});

describe("the person's answer", () => {
  const ANSWER: AnswerEntry = {
    kind: "answer",
    id: entryId("answer:toolu_q"),
    parent: null,
    answers: [
      {
        header: "Database",
        question: "Which database?",
        chosen: ["Postgres"],
        written: undefined,
        notes: "the one we run already",
        secret: false,
      },
      {
        header: "Features",
        question: "Which features?",
        chosen: ["Auth", "Search"],
        written: "and CSV export",
        notes: undefined,
        secret: false,
      },
      {
        header: "Token",
        question: "Your token?",
        chosen: [],
        written: undefined,
        notes: undefined,
        secret: true,
      },
    ],
  };

  it("is the person's bubble, on the right like their messages, with each question over what was chosen or written", () => {
    draw(transcriptOf([put(user("u1", "set it up")), put(ANSWER)]));
    const drawn = entry("answer:toolu_q");
    expect(drawn).toHaveAttribute("data-kind", "answer");
    const bubble = drawn.querySelector(
      ".conversation-user > .conversation-user-text",
    )!;
    expect(bubble).not.toBeNull();
    // The same bubble a message of the person's is drawn in.
    expect(
      entry("u1").querySelector(".conversation-user > .conversation-user-text"),
    ).not.toBeNull();
    const [database, features, token] = [
      ...bubble.querySelectorAll(".conversation-answer"),
    ] as HTMLElement[];
    expect(database).toHaveTextContent("Database");
    expect(database).toHaveTextContent("Which database?");
    expect(within(database!).getByRole("listitem")).toHaveTextContent(
      "Postgres",
    );
    expect(database).toHaveTextContent("Note: the one we run already");
    expect(
      within(features!)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Auth", "Search", "and CSV export"]);
    expect(token).toHaveTextContent("Hidden");
  });

  it("copies as each question and its answer", async () => {
    const { actions } = draw(transcriptOf([put(ANSWER)]));
    fireEvent.click(screen.getByRole("button", { name: "Copy reply" }));
    await waitFor(() =>
      expect(actions.writeClipboard).toHaveBeenCalledWith(
        [
          "Database: Which database?\nPostgres\nNote: the one we run already",
          "Features: Which features?\nAuth\nSearch\nand CSV export",
          "Token: Your token?\n(hidden)",
        ].join("\n\n"),
      ),
    );
  });
});
