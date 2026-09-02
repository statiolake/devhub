// @vitest-environment jsdom

/**
 * Cloning, from what somebody typed.
 *
 * The field takes the three forms `gh repo clone` takes, and the sheet's whole
 * job before it clones anything is to say which one it understood. So what
 * these check is the pair: the row that does the cloning says which repository
 * it read, and that is the repository handed to git. A preview that agreed with
 * the person and a call that did something else would be worse than none.
 *
 * It is a picker, like every other question DevHub asks — the field, the
 * heading and the pinned row that means "the thing typed above" — so these
 * drive it with the keyboard and the rows rather than with a form's buttons.
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

function mount(login: GitHubLoginWire = SIGNED_IN, initialQuery?: string) {
  const cloneProject = vi.fn().mockResolvedValue(undefined);
  const value = {
    cloneProject,
    cloneParentDirectories: vi.fn().mockResolvedValue(["/projects"]),
    githubLogin: vi.fn().mockResolvedValue(login),
    reportFailure: vi.fn(),
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <CloneProjectSheet initialQuery={initialQuery} onDismiss={vi.fn()} />
    </AppShellContext.Provider>,
  );
  return { cloneProject };
}

function repositoryField() {
  return screen.getByRole("textbox", { name: "Clone Project" });
}

async function type(what: string) {
  fireEvent.change(repositoryField(), { target: { value: what } });
}

/** The pinned row that clones, once what was typed can be read as a repository. */
function cloneRow() {
  return screen.queryByRole("option", { name: /^Clone it/u });
}

async function takeCloneRow(preview: RegExp) {
  const row = await screen.findByRole("option", { name: preview });
  fireEvent.click(row);
}

/** The row names the folder and then says what would land in it. */
async function cloneInto() {
  fireEvent.click(await screen.findByRole("option", { name: /^\/projects/u }));
}

describe("the clone sheet reading what was typed", () => {
  it("takes a bare name as this person's own repository", async () => {
    const { cloneProject } = mount();
    // The login is asked for when the sheet opens, so the row is only right
    // once it has arrived — which is why the sheet says it is waiting rather
    // than guessing an owner in the meantime.
    await type("devhub");
    await takeCloneRow(
      /Clones https:\/\/github\.com\/octocat\/devhub\.git as devhub/u,
    );

    await cloneInto();
    expect(cloneProject).toHaveBeenCalledWith(
      "https://github.com/octocat/devhub.git",
      "/projects",
    );
  });

  it("takes one slash as an owner and a repository on GitHub", async () => {
    const { cloneProject } = mount();
    await type("example/widget");
    await takeCloneRow(
      /Clones https:\/\/github\.com\/example\/widget\.git as widget/u,
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
    await takeCloneRow(
      /Clones git@gitlab\.example:group\/thing\.git as thing/u,
    );

    await cloneInto();
    expect(cloneProject).toHaveBeenCalledWith(
      "git@gitlab.example:group/thing.git",
      "/projects",
    );
  });

  it("keeps what was typed in the picker that asked for this sheet", async () => {
    // Somebody typed a name, found no workspace by it, and took "Clone
    // Project…". They have already said what they want.
    const { cloneProject } = mount(SIGNED_IN, "devhub");

    expect(repositoryField()).toHaveValue("devhub");
    await takeCloneRow(/Clones https:\/\/github\.com\/octocat\/devhub\.git/u);
    await cloneInto();
    expect(cloneProject).toHaveBeenCalledWith(
      "https://github.com/octocat/devhub.git",
      "/projects",
    );
  });

  it("takes Escape back to the repository, with what was typed still there", async () => {
    // Escape is one step back wherever DevHub asks more than one question.
    mount();
    await type("example/widget");
    await takeCloneRow(/Clones https/u);

    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });

    expect(
      await screen.findByRole("textbox", { name: "Clone Project" }),
    ).toHaveValue("example/widget");
  });

  it("offers no way to clone what it cannot read, and says why", async () => {
    // Nobody signed in. The one form that needs an owner DevHub has to go and
    // ask for is the one that can fail here, and it fails in words with
    // something to do about it — not with a row that exists only to refuse.
    mount({ kind: "unknown", reason: "there is no `gh` on DevHub's PATH" });
    await type("devhub");

    await vi.waitFor(() => {
      expect(
        screen.getByText(/there is no `gh` on DevHub's PATH/u),
      ).toBeVisible();
    });
    expect(screen.getByText(/owner\/devhub/u)).toBeVisible();
    expect(cloneRow()).toBeNull();
  });
});
