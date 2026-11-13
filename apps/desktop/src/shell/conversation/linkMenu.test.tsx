// @vitest-environment jsdom

/**
 * A link's right-click menu, wherever the conversation's renderer draws one:
 * a `devhub:` chip (Open, Copy Link, Copy Markdown Link), a file path (Open,
 * Copy Path, Copy Link), a URL (Open in Browser, Copy Link), a picture
 * (Open, Copy Image, Save Image…) — and the same from the keyboard:
 * Shift+F10 or the menu key on the focused link, ⌘C for its link.
 */

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkPlaces } from "../../model/devhubLink";
import { ConversationActionsProvider } from "./ConversationContext";
import { DevhubLinksProvider, type DevhubLinks } from "./DevhubLink";
import { ImageStrip } from "./EntryParts";
import { fileDevhubLink, isMenuKey } from "./linkMenu";
import { Markdown } from "./Markdown";
import { PathLinks, PathLinksProvider } from "./pathLinks";
import { fakeActions } from "./surfaceTestKit";
import { AgentCwdProvider } from "./ConversationContext";

afterEach(() => {
  cleanup();
});

const PLACES: LinkPlaces = {
  workspaces: [],
  tasks: [{ id: 3, title: "列追加の作業", status: "answer" }],
  escalations: [],
  orchestrator: true,
};

function drawn(source: string, choose?: string) {
  const actions = fakeActions({
    showContextMenu: vi.fn(() => Promise.resolve(choose)),
    resolvePaths: vi.fn((cwd: string | undefined, paths: readonly string[]) =>
      Promise.resolve(
        paths.map((path) =>
          `${cwd ?? ""}/${path}` === "/w/app/src/a.ts"
            ? "/w/app/src/a.ts"
            : null,
        ),
      ),
    ),
  });
  const links: DevhubLinks = {
    places: PLACES,
    navigate: vi.fn(() => Promise.resolve()),
    sessionAgent: vi.fn(() => Promise.resolve(null)),
    reportFailure: vi.fn(),
    copyLink: vi.fn(() => Promise.resolve()),
    showContextMenu: vi.fn(() => Promise.resolve(choose)),
  };
  render(
    <DevhubLinksProvider value={links}>
      <ConversationActionsProvider value={actions}>
        <PathLinksProvider
          value={new PathLinks(actions.resolvePaths, actions.reportFailure)}
        >
          <AgentCwdProvider value="/w/app">
            <Markdown source={source} streaming={false} />
          </AgentCwdProvider>
        </PathLinksProvider>
      </ConversationActionsProvider>
    </DevhubLinksProvider>,
  );
  return { actions, links };
}

function labels(show: unknown): readonly string[] {
  const calls = (
    show as { mock: { calls: [{ items: { label: string }[] }][] } }
  ).mock.calls;
  return calls.at(-1)![0].items.map((item) => item.label);
}

describe("a link's menu", () => {
  it("on a devhub: chip: Open, Copy Link, Copy Markdown Link — copied by main", async () => {
    const { links } = drawn("[t](devhub:task/3)", "copy-markdown-link");
    const chip = document.querySelector<HTMLElement>("button.devhub-link")!;
    fireEvent.contextMenu(chip, { clientX: 5, clientY: 6 });
    await waitFor(() => {
      expect(links.copyLink).toHaveBeenCalledWith("devhub:task/3", true);
    });
    expect(labels(links.showContextMenu)).toEqual([
      "Open",
      "Copy Link",
      "Copy Markdown Link",
    ]);
  });

  it("on a file path: Open, Copy Path, Copy Link", async () => {
    const { actions } = drawn("see `src/a.ts:12`", "copy-path");
    const link = await screen.findByTitle(
      "Open /w/app/src/a.ts:12 in the editor",
    );
    fireEvent.contextMenu(link, { clientX: 1, clientY: 1 });
    await waitFor(() => {
      expect(actions.copyText).toHaveBeenCalledWith("/w/app/src/a.ts");
    });
    expect(labels(actions.showContextMenu)).toEqual([
      "Open",
      "Copy Path",
      "Copy Link",
    ]);
  });

  it("on a Markdown link to a file: the file main finds, as a devhub:file link", async () => {
    const { actions } = drawn("[a](src/a.ts#L12)", "copy-link");
    fireEvent.contextMenu(screen.getByText("a"), { clientX: 1, clientY: 1 });
    await waitFor(() => {
      expect(actions.copyText).toHaveBeenCalledWith(
        "devhub:file/w/app/src/a.ts:12",
      );
    });
  });

  it("on a URL: Open in Browser, Copy Link", async () => {
    const { actions } = drawn(
      "[PR](https://github.com/acme/app/pull/1)",
      "open",
    );
    fireEvent.contextMenu(screen.getByText("PR"), { clientX: 1, clientY: 1 });
    await waitFor(() => {
      expect(actions.openExternalUrl).toHaveBeenCalledWith(
        "https://github.com/acme/app/pull/1",
      );
    });
    expect(labels(actions.showContextMenu)).toEqual([
      "Open in Browser",
      "Copy Link",
    ]);
  });

  it("leaves a right-click on selected text to the page", () => {
    const { actions } = drawn("[PR](https://example.com/)");
    const link = screen.getByText("PR");
    const range = document.createRange();
    range.selectNodeContents(link);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.contextMenu(link);
    expect(actions.showContextMenu).not.toHaveBeenCalled();
    window.getSelection()!.removeAllRanges();
  });
});

describe("from the keyboard", () => {
  it("opens the menu under the focused link with Shift+F10 or the menu key", () => {
    const { actions } = drawn("[PR](https://example.com/)");
    const link = screen.getByText("PR");
    fireEvent.keyDown(link, { key: "F10", shiftKey: true });
    fireEvent.keyDown(link, { key: "ContextMenu" });
    expect(actions.showContextMenu).toHaveBeenCalledTimes(2);
    expect(isMenuKey({ key: "F10", shiftKey: false })).toBe(false);
  });

  it("copies the focused link's link with ⌘C when nothing is selected", async () => {
    const { links } = drawn("[t](devhub:task/3)");
    const chip = document.querySelector<HTMLElement>("button.devhub-link")!;
    fireEvent.keyDown(chip, { key: "c", metaKey: true });
    await waitFor(() => {
      expect(links.copyLink).toHaveBeenCalledWith("devhub:task/3", false);
    });
  });
});

describe("a picture's menu", () => {
  it("is Open, Copy Image, Save Image… on its thumbnail; Open shows it large", async () => {
    const actions = fakeActions({
      showContextMenu: vi.fn(() => Promise.resolve("open")),
    });
    render(
      <ConversationActionsProvider value={actions}>
        <ImageStrip
          images={[
            {
              mediaType: "image/png",
              label: "shot.png",
              source: { kind: "data", base64: "iVBORw0KGgo=" },
            },
          ]}
          captions={["staging"]}
        />
      </ConversationActionsProvider>,
    );
    const thumbnail = document.querySelector<HTMLElement>(
      ".conversation-image > summary",
    )!;
    expect(thumbnail).toHaveTextContent("staging");
    fireEvent.contextMenu(thumbnail, { clientX: 2, clientY: 3 });
    expect(
      await screen.findByRole("dialog", { name: "staging" }),
    ).toBeVisible();
    expect(labels(actions.showContextMenu)).toEqual([
      "Open",
      "Copy Image",
      "Save Image…",
    ]);
  });
});

describe("a file's devhub: link", () => {
  it("carries its line, and its column past the first", () => {
    expect(fileDevhubLink("/w/a b.ts", undefined)).toBe(
      "devhub:file/w/a%20b.ts",
    );
    expect(
      fileDevhubLink("/w/a.ts", { kind: "line", line: 12, column: 1 }),
    ).toBe("devhub:file/w/a.ts:12");
    expect(
      fileDevhubLink("/w/a.ts", { kind: "line", line: 12, column: 4 }),
    ).toBe("devhub:file/w/a.ts:12:4");
    expect(fileDevhubLink("/w/a.ts", { kind: "lines", from: 3, to: 9 })).toBe(
      "devhub:file/w/a.ts:3",
    );
  });
});
