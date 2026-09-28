// @vitest-environment jsdom

/**
 * An MCP server's elicitation, on the request card: accepted by submitting
 * its form — a plain confirmation when it has no fields — or declined or
 * cancelled with the adapter's choices.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { requestId, type RequestChoice } from "../../model/conversation";
import type { FormField } from "../../model/elicitationForm";
import { draw, installResizeObserver } from "./surfaceTestKit";
import { opened, transcriptOf } from "./transcriptFixtures";

beforeAll(installResizeObserver);

afterEach(cleanup);

const CHOICES: readonly RequestChoice[] = [
  { id: "decline", label: "Decline", tone: "deny", takesText: false },
  { id: "cancel", label: "Cancel", tone: "neutral", takesText: false },
];

function elicitation(
  fields: readonly FormField[],
  url?: string,
  choices: readonly RequestChoice[] = CHOICES,
) {
  return transcriptOf([
    opened({
      id: requestId("e1"),
      entry: undefined,
      subject: {
        kind: "elicitation",
        server: "desktop",
        message: 'Allow Computer Use to use "Notes"?',
        url,
        fields,
      },
      choices,
    }),
  ]);
}

function card(): HTMLElement {
  return screen.getByRole("group", {
    name: "The Agent is waiting for an answer",
  });
}

const TITLE: FormField = {
  key: "title",
  label: "Title",
  description: "A line for the list",
  required: true,
  input: {
    kind: "text",
    format: undefined,
    minLength: undefined,
    maxLength: undefined,
    default: undefined,
  },
};

const COUNT: FormField = {
  key: "count",
  label: "Count",
  description: undefined,
  required: false,
  input: {
    kind: "number",
    integer: true,
    minimum: 1,
    maximum: undefined,
    default: undefined,
  },
};

describe("an elicitation with no fields", () => {
  it("is a confirmation: Accept, Decline and Cancel, numbered in that order, and no schema", () => {
    draw(elicitation([]));
    const buttons = [...card().querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "1Accept",
      "2Decline",
      "3Cancel",
    ]);
    expect(card()).toHaveTextContent('Allow Computer Use to use "Notes"?');
    expect(card().querySelector(".conversation-json")).toBeNull();
  });

  it("accepts with nothing filled in", async () => {
    const { actions } = draw(elicitation([]));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(actions.answer).toHaveBeenCalledWith("e1", {
        kind: "answers",
        values: {},
      }),
    );
  });

  it("accepts from the keyboard with 1", async () => {
    const { actions } = draw(elicitation([]));
    fireEvent.keyDown(card(), { key: "1" });
    await waitFor(() =>
      expect(actions.answer).toHaveBeenCalledWith("e1", {
        kind: "answers",
        values: {},
      }),
    );
  });

  it.each(["Decline", "Cancel"])(
    "answers %s with that choice",
    async (label) => {
      const { actions } = draw(elicitation([]));
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() =>
        expect(actions.answer).toHaveBeenCalledWith("e1", {
          kind: "choice",
          choiceId: label.toLowerCase(),
          text: undefined,
        }),
      );
    },
  );
});

describe("a confirmation that offers to remember its acceptance", () => {
  const REMEMBERING: readonly RequestChoice[] = [
    {
      id: "remember:session",
      label: "Accept for this session",
      tone: "allow",
      takesText: false,
    },
    {
      id: "remember:always",
      label: "Always accept",
      tone: "allow",
      takesText: false,
    },
    ...CHOICES,
  ];

  it("offers each way of remembering after Accept and before Decline", () => {
    draw(elicitation([], undefined, REMEMBERING));
    expect(
      [...card().querySelectorAll("button")].map(
        (button) => button.textContent,
      ),
    ).toEqual([
      "1Accept",
      "2Accept for this session",
      "3Always accept",
      "4Decline",
      "5Cancel",
    ]);
  });

  it("answers a way of remembering with that choice", async () => {
    const { actions } = draw(elicitation([], undefined, REMEMBERING));
    fireEvent.keyDown(card(), { key: "3" });
    await waitFor(() =>
      expect(actions.answer).toHaveBeenCalledWith("e1", {
        kind: "choice",
        choiceId: "remember:always",
        text: undefined,
      }),
    );
  });
});

describe("an elicitation with fields", () => {
  it("draws a control for each field and does not accept until what is required is there", async () => {
    const { actions } = draw(elicitation([TITLE, COUNT]));
    const title = screen.getByRole("textbox", { name: "Title *" });
    expect(title).toHaveAccessibleDescription("A line for the list");
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByText("Required")).toBeInTheDocument();
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(actions.answer).not.toHaveBeenCalled();

    fireEvent.change(title, { target: { value: "Groceries" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Count" }), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByText("At least 1")).toBeInTheDocument();
    expect(actions.answer).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("spinbutton", { name: "Count" }), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(actions.answer).toHaveBeenCalledWith("e1", {
        kind: "answers",
        values: { title: "Groceries", count: "3" },
      }),
    );
  });

  it("fills a yes/no and a choice", async () => {
    const { actions } = draw(
      elicitation([
        {
          key: "notify",
          label: "Notify",
          description: undefined,
          required: false,
          input: { kind: "boolean", default: undefined },
        },
        {
          key: "list",
          label: "List",
          description: undefined,
          required: true,
          input: {
            kind: "choice",
            multiple: false,
            options: [
              { value: "home", label: "Home" },
              { value: "work", label: "Work" },
            ],
            minItems: undefined,
            maxItems: undefined,
            default: [],
          },
        },
      ]),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Notify" }));
    fireEvent.click(screen.getByRole("radio", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(actions.answer).toHaveBeenCalledWith("e1", {
        kind: "answers",
        values: { notify: "true", list: "work" },
      }),
    );
  });
});

describe("a URL elicitation", () => {
  it("shows the page to visit and opens it outside DevHub", () => {
    const { actions } = draw(
      elicitation([], "https://tracker.example.com/auth"),
    );
    fireEvent.click(
      screen.getByRole("link", { name: "https://tracker.example.com/auth" }),
    );
    expect(actions.openExternalUrl).toHaveBeenCalledWith(
      "https://tracker.example.com/auth",
    );
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
  });
});
