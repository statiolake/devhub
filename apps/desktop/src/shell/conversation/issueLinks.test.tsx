// @vitest-environment jsdom

/**
 * Issue and pull request references in the conversation as links to GitHub:
 * a bare `#12` in the Agent's Workspace's repository, `owner/repo#12` as
 * written, opened in the default browser.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkspaceRepositoryWire } from "../../ipc/contract";
import { issueRepositoryOf, type IssueRepository } from "./issueLinks";
import {
  draw,
  entry,
  fakeActions,
  installResizeObserver,
} from "./surfaceTestKit";
import { assistant, put, tool, transcriptOf } from "./transcriptFixtures";

beforeAll(installResizeObserver);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WIDGET: IssueRepository = {
  owner: "example",
  repository: "widget",
  titles: new Map([[128, "Tidy the sidebar"]]),
};

function links(): readonly HTMLAnchorElement[] {
  return [
    ...document.querySelectorAll<HTMLAnchorElement>(".conversation-issue-link"),
  ];
}

function said(text: string) {
  return transcriptOf([put(assistant("a1", text))]);
}

describe("a reference in the Agent's prose", () => {
  it("links a bare #12 into the Workspace's repository, and owner/repo#12 as written", () => {
    draw(
      said("Fixed #128 and #7, as other-org/gadget#3 asked.\n"),
      fakeActions(),
      false,
      "",
      WIDGET,
    );
    expect(
      links().map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["#128", "https://github.com/example/widget/issues/128"],
      ["#7", "https://github.com/example/widget/issues/7"],
      ["other-org/gadget#3", "https://github.com/other-org/gadget/issues/3"],
    ]);
    expect(entry("a1")).toHaveTextContent(
      "Fixed #128 and #7, as other-org/gadget#3 asked.",
    );
  });

  it("leaves a bare #12 as text when the Workspace has no GitHub repository", () => {
    draw(said("Fixed #128 and example/widget#9.\n"));
    expect(links().map((link) => link.textContent)).toEqual([
      "example/widget#9",
    ]);
    expect(entry("a1")).toHaveTextContent("Fixed #128 and example/widget#9.");
  });

  it("opens the link in the default browser, and says a failure to", async () => {
    const failure = new Error("The browser could not be opened.");
    const openExternalUrl = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure);
    const actions = fakeActions({ openExternalUrl });
    draw(said("See `#128`.\n"), actions, false, "", WIDGET);
    const [link] = links();
    fireEvent.click(link!);
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/example/widget/issues/128",
    );
    fireEvent.click(link!);
    await act(async () => {
      await Promise.resolve();
    });
    expect(actions.reportFailure).toHaveBeenCalledWith(failure);
  });

  it("names a number DevHub already knows the title of, and only in its repository", () => {
    draw(
      said("#128, example/widget#128, other-org/gadget#128 and #9.\n"),
      fakeActions(),
      false,
      "",
      WIDGET,
    );
    expect(links().map((link) => link.title)).toEqual([
      "#128 Tidy the sidebar",
      "#128 Tidy the sidebar",
      "https://github.com/other-org/gadget/issues/128",
      "https://github.com/example/widget/issues/9",
    ]);
  });

  it("leaves a link the Agent wrote, a heading and a fenced block alone", () => {
    const actions = fakeActions();
    draw(
      said(
        "# 12 Steps\n\nSee https://github.com/example/widget/pull/5#issuecomment-1 and [#6](https://example.com/six).\n\n```sh\ngit log --grep '#7'\n```\n",
      ),
      actions,
      false,
      "",
      WIDGET,
    );
    expect(links()).toHaveLength(0);
    const written = [...entry("a1").querySelectorAll("a")].map((link) =>
      link.getAttribute("href"),
    );
    expect(written).toEqual([
      "https://github.com/example/widget/pull/5#issuecomment-1",
      "https://example.com/six",
    ]);
  });

  it("does not take a line anchor for one", () => {
    draw(
      said("Look at src/a.ts#L12 and #L12.\n"),
      fakeActions(),
      false,
      "",
      WIDGET,
    );
    expect(links()).toHaveLength(0);
  });
});

describe("a reference in a tool call", () => {
  it("links its output's references and leaves the row shut when one is followed", () => {
    const actions = fakeActions();
    draw(
      transcriptOf([
        put(
          tool("t1", "Bash: git log --oneline", {
            output: [
              {
                kind: "text",
                text: "abc1234 Tidy the sidebar (#128)\ndef5678 Merge pull request #9 from x/y",
              },
            ],
          }),
        ),
      ]),
      actions,
      false,
      "",
      WIDGET,
    );
    const found = [
      ...entry("t1").querySelectorAll<HTMLElement>(".conversation-issue-link"),
    ];
    expect(found.map((link) => link.textContent)).toEqual(["#128", "#9"]);
    fireEvent.click(found[0]!);
    expect(actions.openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/example/widget/issues/128",
    );
    expect(entry("t1").querySelector("details")).not.toHaveAttribute("open");
  });
});

describe("issueRepositoryOf", () => {
  const row: WorkspaceRepositoryWire = {
    workspaceId: "w-1",
    issueRepository: { owner: "example", repository: "widget" },
    issue: { number: 128, title: "Tidy", state: "open", url: "u" },
    pullRequest: {
      number: 130,
      title: "Tidy the sidebar",
      url: "u",
      state: "open",
      conversations: { unresolved: 0, uncounted: 0 },
    },
  };

  it("is the Workspace's GitHub repository, with its Issue's and pull request's titles", () => {
    const found = issueRepositoryOf(row);
    expect(found?.owner).toBe("example");
    expect(found?.repository).toBe("widget");
    expect([...(found?.titles ?? [])]).toEqual([
      [128, "Tidy"],
      [130, "Tidy the sidebar"],
    ]);
  });

  it("is nothing for a Workspace with no GitHub repository, or none known", () => {
    expect(
      issueRepositoryOf({ ...row, issueRepository: undefined }),
    ).toBeUndefined();
    expect(issueRepositoryOf(undefined)).toBeUndefined();
  });
});
