// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationActionsProvider } from "./ConversationContext";
import type { ConversationActions } from "./ConversationContext";
import { Markdown } from "./Markdown";
import { TABLE_MENU } from "./Table";
import { toCsv, toTsv } from "./tableCopy";
import { fakeActions } from "./surfaceTestKit";

afterEach(cleanup);

function draw(source: string, actions: ConversationActions = fakeActions()) {
  render(
    <ConversationActionsProvider value={actions}>
      <Markdown source={source} streaming={false} />
    </ConversationActionsProvider>,
  );
  return actions;
}

const TABLE = [
  "| Name | Note |",
  "| --- | --- |",
  '| `cfg` | says "hi", twice |',
  "| [b](https://example.com) | plain |",
  "",
].join("\n");

describe("a table in an answer", () => {
  it("copies as CSV, read off the drawn cells", async () => {
    const actions = draw(TABLE);
    fireEvent.click(screen.getByRole("button", { name: "Copy as CSV" }));
    await waitFor(() => expect(actions.writeClipboard).toHaveBeenCalled());
    expect(actions.writeClipboard).toHaveBeenCalledWith(
      'Name,Note\r\ncfg,"says ""hi"", twice"\r\nb,plain',
    );
  });

  it("offers CSV and TSV on a right-click", async () => {
    const actions = draw(
      TABLE,
      fakeActions({ showContextMenu: vi.fn().mockResolvedValue("copy-tsv") }),
    );
    fireEvent.contextMenu(screen.getByText("plain"), {
      clientX: 3,
      clientY: 4,
    });
    await waitFor(() => expect(actions.writeClipboard).toHaveBeenCalled());
    expect(actions.showContextMenu).toHaveBeenCalledWith({
      items: TABLE_MENU.map(({ id, label }) => ({ id, label })),
      at: { x: 3, y: 4 },
    });
    expect(actions.writeClipboard).toHaveBeenCalledWith(
      'Name\tNote\ncfg\tsays "hi", twice\nb\tplain',
    );
  });

  it("writes fields the way spreadsheets read them", () => {
    expect(toCsv([["a", "b,c", "line\nbreak", " pad"]])).toBe(
      'a,"b,c","line\nbreak"," pad"',
    );
    expect(toTsv([["a\tb", "c\nd"]])).toBe("a b\tc d");
  });
});
