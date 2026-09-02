// @vitest-environment jsdom

/**
 * Cloning, from what somebody typed.
 *
 * The field takes the three forms `gh repo clone` takes, and the sheet's whole
 * job before it clones anything is to say which one it understood. So what
 * these check is the pair: the line under the field, and the URL that is
 * actually handed to git. A preview that agreed with the person and a call that
 * did something else would be worse than no preview at all.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { CloneProjectSheet } from "./ProjectSheets";
import type { GitHubLoginWire } from "../../client";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

const SIGNED_IN: GitHubLoginWire = { kind: "login", login: "octocat" };

function mount(login: GitHubLoginWire = SIGNED_IN) {
  const cloneProject = vi.fn().mockResolvedValue(undefined);
  const value = {
    cloneProject,
    cloneParentDirectories: vi.fn().mockResolvedValue(["/projects"]),
    githubLogin: vi.fn().mockResolvedValue(login),
    reportFailure: vi.fn(),
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <CloneProjectSheet onDismiss={vi.fn()} />
    </AppShellContext.Provider>,
  );
  return { cloneProject };
}

/** Type it, read the preview, and go on to the folder question. */
async function type(what: string) {
  fireEvent.change(await screen.findByRole("textbox", { name: "Repository" }), {
    target: { value: what },
  });
}

function preview(): string {
  return document.querySelector(".project-destination")?.textContent ?? "";
}

/** The row names the folder and then says what would land in it. */
async function cloneInto() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(await screen.findByRole("option", { name: /^\/projects/u }));
}

describe("the clone sheet reading what was typed", () => {
  it("takes a bare name as this person's own repository", async () => {
    const { cloneProject } = mount();
    // The login is asked for when the sheet opens, so the preview is only
    // right once it has arrived — which is why the sheet says it is waiting
    // rather than guessing an owner in the meantime.
    await type("devhub");
    await vi.waitFor(() => {
      expect(preview()).toBe(
        "Clones https://github.com/octocat/devhub.git as devhub",
      );
    });

    await cloneInto();
    expect(cloneProject).toHaveBeenCalledWith(
      "https://github.com/octocat/devhub.git",
      "/projects",
    );
  });

  it("takes one slash as an owner and a repository on GitHub", async () => {
    const { cloneProject } = mount();
    await type("example/widget");
    expect(preview()).toBe(
      "Clones https://github.com/example/widget.git as widget",
    );

    await cloneInto();
    expect(cloneProject).toHaveBeenCalledWith(
      "https://github.com/example/widget.git",
      "/projects",
    );
  });

  it("hands a URL to git exactly as it was written", async () => {
    const { cloneProject } = mount();
    await type("git@gitlab.example:group/thing.git");
    expect(preview()).toBe(
      "Clones git@gitlab.example:group/thing.git as thing",
    );

    await cloneInto();
    expect(cloneProject).toHaveBeenCalledWith(
      "git@gitlab.example:group/thing.git",
      "/projects",
    );
  });

  it("says why a bare name cannot be read, rather than cloning a guess", async () => {
    // Nobody signed in. The one form that needs an owner DevHub has to go and
    // ask for is the one form that can fail here, and it fails in words with
    // something to do about it — not by cloning somebody else's repository.
    mount({ kind: "unknown", reason: "there is no `gh` on DevHub's PATH" });
    await type("devhub");

    await vi.waitFor(() => {
      expect(preview()).toContain("there is no `gh` on DevHub's PATH");
    });
    expect(preview()).toContain("owner/devhub");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
});
