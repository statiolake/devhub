// @vitest-environment jsdom

/**
 * The SSH rows in the workspace picker, and where taking one goes.
 *
 * They are in the *same* list as the folders the local sources found, because
 * to the person opening one it is the same question — "which workspace should
 * this window open" — and two lists would be two places to look for one
 * answer.
 *
 * Nothing here connects to anything, and that is the property most worth
 * holding on to: the picker asks two questions and hands the answers to main,
 * so a machine that is asleep costs a person nothing until they choose it.
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
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { WorkspacePicker } from "./WorkspacePicker";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

const HOSTS = [
  { alias: "build", hostName: "build.example.com", user: "deploy" },
  { alias: "staging", hostName: "staging.example.com" },
];

function mount(hosts: readonly (typeof HOSTS)[number][] = HOSTS) {
  const openSshWorkspace = vi.fn().mockResolvedValue(undefined);
  const selectWorkspacePicker = vi.fn().mockResolvedValue(undefined);
  const value = {
    pickerCandidates: [],
    pickerBusy: false,
    pickerSourceCount: 1,
    startWorkspacePicker: vi.fn().mockResolvedValue(undefined),
    cancelWorkspacePicker: vi.fn().mockResolvedValue(undefined),
    selectWorkspacePicker,
    chooseWorkspaceFolder: vi.fn(),
    listSshHosts: vi.fn().mockResolvedValue(hosts),
    openSshWorkspace,
    reportFailure: vi.fn(),
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <WorkspacePicker onDismiss={vi.fn()} />
    </AppShellContext.Provider>,
  );
  return { openSshWorkspace, selectWorkspacePicker };
}

describe("the SSH rows in the workspace picker", () => {
  it("offers every machine the SSH config names, and one way to type one", async () => {
    mount();
    expect(await screen.findByText("SSH: build")).toBeInTheDocument();
    expect(screen.getByText("SSH: staging")).toBeInTheDocument();
    expect(screen.getByText("SSH: Connect…")).toBeInTheDocument();
  });

  it("shows what is behind an alias, which is why an alias is readable at all", async () => {
    mount();
    // Six aliases in a list are six words that mean nothing without this. It
    // is shown and never sent: `ssh` resolves the alias, and DevHub resolving
    // it too would be a second answer that can disagree.
    expect(
      await screen.findByText("deploy@build.example.com"),
    ).toBeInTheDocument();
  });

  it("asks for the folder next, on the machine that was chosen", async () => {
    mount();
    fireEvent.click(await screen.findByText("SSH: build"));
    expect(
      await screen.findByText(/Which folder on build\?/u),
    ).toBeInTheDocument();
    // Typed rather than browsed: listing the machine's directories needs the
    // connection this is on the way to making.
    expect(
      screen.getByText("Open this folder as a workspace"),
    ).toBeInTheDocument();
  });

  it("opens the folder on that machine, by the alias and not the hostname", async () => {
    const { openSshWorkspace } = mount();
    fireEvent.click(await screen.findByText("SSH: build"));
    const field = (await screen.findByText("Open on build"))
      .closest("[role=dialog]")!
      .querySelector("input")!;
    fireEvent.change(field, { target: { value: "/srv/api" } });
    fireEvent.click(screen.getByText("Open this folder as a workspace"));
    await waitFor(() => {
      expect(openSshWorkspace).toHaveBeenCalledWith(
        "build",
        "/srv/api",
        undefined,
      );
    });
  });

  it("does not connect to anything while the questions are being asked", async () => {
    const { openSshWorkspace, selectWorkspacePicker } = mount();
    fireEvent.click(await screen.findByText("SSH: staging"));
    expect(openSshWorkspace).not.toHaveBeenCalled();
    expect(selectWorkspacePicker).not.toHaveBeenCalled();
  });

  it("says the config named nothing, rather than hiding the door", async () => {
    // A machine with no SSH config still gets `SSH: Connect…`: not having
    // written a config down is not the same as not having a machine.
    mount([]);
    expect(await screen.findByText("SSH: Connect…")).toBeInTheDocument();
    expect(screen.queryByText("SSH: build")).not.toBeInTheDocument();
  });
});
