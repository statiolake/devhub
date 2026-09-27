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
import { readFileSync } from "node:fs";
import { claudeLines, claudeTranscript } from "./adapterFixtures";
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

describe("a claude -p question with multi-line box-drawing previews, from asked to answered", () => {
  // Relative to the package, where vitest runs.
  const LINES = claudeLines(
    readFileSync(
      "src/main/agent/conversation/fixtures/claude-question-previews.handwritten.ndjson",
      "utf8",
    ),
  );
  const ASKING = LINES.findIndex(({ line }) => line.includes("can_use_tool"));
  const PENDING = claudeTranscript(LINES.slice(0, ASKING + 1));
  const ANSWERED = claudeTranscript(LINES);
  const [LAYOUT_ASKED, SAVING_ASKED] = (
    JSON.parse(LINES[ASKING]!.line) as {
      request: {
        input: {
          questions: {
            question: string;
            options: { label: string; preview?: string }[];
          }[];
        };
      };
    }
  ).request.input.questions;

  /** A preview box's text as its lines, the kept indentation read back as spaces. */
  function linesOf(box: HTMLElement): string {
    return box.querySelector("p")!.textContent!.replaceAll("\u00a0", " ");
  }

  it("shows the first question's previews beside its options, every line whole, and none for the second", () => {
    draw(PENDING);
    const [layout, saving] = [
      ...document.querySelectorAll<HTMLElement>(".conversation-question"),
    ];
    expect(layout).toHaveTextContent(LAYOUT_ASKED!.question);
    expect(saving).toHaveTextContent(SAVING_ASKED!.question);
    expect(
      saving!.querySelector(".conversation-question-body"),
    ).not.toHaveAttribute("data-previewed");
    expect(within(saving!).queryByRole("region")).toBeNull();
    // One paragraph, the preview's lines as they were written, in order.
    expect(linesOf(preview())).toBe(LAYOUT_ASKED!.options[0]!.preview);
    fireEvent.mouseEnter(
      within(layout!).getByRole("radio", { name: /タブ/ }).closest("label")!,
    );
    expect(preview()).toHaveAccessibleName("Preview: タブ");
    expect(linesOf(preview())).toBe(LAYOUT_ASKED!.options[1]!.preview);
  });

  it("draws a preview monospace, its lines never wrapped, so the boxes stay in line", () => {
    // jsdom applies no stylesheet, so the rules are read where they are written.
    const css = readFileSync("src/shell/conversation/conversation.css", "utf8");
    const box = /\n\.conversation-question-preview \{([^}]*)\}/.exec(css);
    expect(box?.[1]).toMatch(/font-family:\s*var\(--font-mono\)/);
    const lines =
      /\.conversation-question-preview \.conversation-markdown :is\(p, li, td, th\) \{([^}]*)\}/.exec(
        css,
      );
    expect(lines?.[1]).toMatch(/white-space:\s*pre;/);
  });

  it("keeps, once answered, the answer as the person's bubble and the call's record of what was asked and chosen, the chosen preview with it", () => {
    draw(ANSWERED);
    expect(document.querySelector(".conversation-question")).toBeNull();
    const bubble = entry("answer:toolu_q1");
    expect(
      [...bubble.querySelectorAll(".conversation-answer-given li")].map(
        (item) => item.textContent,
      ),
    ).toEqual(["タブ", "自動"]);

    const call = entry("tool:toolu_q1");
    const readable = call.querySelector<HTMLElement>(".conversation-readable")!;
    // Outside the call's fold, cut by the one Clip.
    expect(readable.closest("details")).toBeNull();
    expect(readable.querySelector(".conversation-clip-box")).not.toBeNull();
    const [layout, saving] = [
      ...readable.querySelectorAll<HTMLElement>(".conversation-asked-question"),
    ];
    expect(layout).toHaveTextContent(LAYOUT_ASKED!.question);
    expect(
      within(layout!)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["タブ"]);
    const shown = within(layout!).getByRole("region");
    expect(shown).toHaveAccessibleName("Preview: タブ");
    expect(shown).toHaveClass("conversation-question-preview");
    expect(linesOf(shown)).toBe(LAYOUT_ASKED!.options[1]!.preview);
    // Only the option chosen: the others' previews are not kept on view.
    expect(within(readable).getAllByRole("region")).toHaveLength(1);
    expect(saving).toHaveTextContent(SAVING_ASKED!.question);
    expect(within(saving!).getByRole("listitem")).toHaveTextContent("自動");
    expect(within(saving!).queryByRole("region")).toBeNull();
  });
});
