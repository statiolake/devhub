// @vitest-environment jsdom

/**
 * The bar DevHub draws, as a person meets it.
 *
 * Three things it owes, and each of them is a way it could be wrong without
 * looking wrong: the name it letters has to be the name main gave the window
 * and not one the page worked out for itself; its one control has to reach the
 * same `toggle_sidebar` the chord reaches, rather than a second path to the
 * same idea; and that control has to report which way the Sidebar currently
 * is, because a toggle that does not is a button you have to press to find out
 * what it does.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppAppearance, AppSnapshot } from "../../../ipc/appShell";
import type { ShellPageBridge } from "../../../ipc/contract";
import { ShellPageProvider } from "../../ShellPageContext";
import { TitleBar } from "./TitleBar";

const SNAPSHOT = {
  schemaVersion: 1,
  revision: 1,
  readiness: "ready",
  selection: { context: { kind: "global" }, presentation: "full" },
  sidebar: { width: 248, collapsed: false },
  workspaces: [],
} as unknown as AppSnapshot;

const APPEARANCE = {
  sequence: 1,
  titleBar: "shown",
} as unknown as AppAppearance;

function mount(collapsed: boolean) {
  let publishTitle: (title: string) => void = () => undefined;
  const onDispatch = vi.fn();

  const client = {
    getSnapshot: async () => SNAPSHOT,
    getAppearance: async () => APPEARANCE,
    getAgentProfiles: async () => ({ sequence: 1, profiles: [] }),
    replay: async () => ({ cursor: 0, events: [], snapshot: SNAPSHOT }),
    dispatch: vi.fn(async () => ({ kind: "updated", snapshot: SNAPSHOT })),
    onSnapshot: () => () => undefined,
    onTheme: () => () => undefined,
    onAppearance: () => () => undefined,
    getWindowTitle: async () => "index.ts — devhub — DevHub",
    onWindowTitle: (listener: (title: string) => void) => {
      publishTitle = listener;
      return () => undefined;
    },
    onAgentProfiles: () => () => undefined,
    onAppCondition: () => () => undefined,
    onNativeError: () => () => undefined,
    onWorkspacePicker: () => () => undefined,
    getRepositoryStatus: async () => ({ sequence: 0, workspaces: [] }),
    onRepositoryStatus: () => () => undefined,
  } as unknown as ShellPageBridge;

  // The bridge is what a page has, so the fake is installed the way the
  // preload installs the real one.
  window.devhub = client;
  render(
    <ShellPageProvider>
      <TitleBar sidebarCollapsed={collapsed} onDispatch={onDispatch} />
    </ShellPageProvider>,
  );

  return {
    onDispatch,
    rename: (title: string) =>
      act(() => {
        publishTitle(title);
      }),
  };
}

const button = () => screen.getByRole("button", { name: "Toggle Sidebar" });
const name = () => document.querySelector(".title-bar-name");

describe("the title bar DevHub draws", () => {
  afterEach(cleanup);

  it("letters the name main gave the window, and follows it", async () => {
    const bar = mount(false);
    // The name main composed, read over the wire. Nothing here builds one: a
    // second composition is a bar that can disagree with Mission Control about
    // what this window is.
    await act(async () => undefined);
    expect(name()).toHaveTextContent("index.ts — devhub — DevHub");

    bar.rename("Reviewing the diff — devhub — DevHub");
    expect(name()).toHaveTextContent("Reviewing the diff — devhub — DevHub");
  });

  it("says nothing at all before the first answer", async () => {
    // Not a placeholder. A bar that says "DevHub" and then says something else
    // reads as a window that changed, and it did not.
    mount(false);
    expect(name()).toHaveTextContent("");
    await act(async () => undefined);
  });

  it("reaches `toggle_sidebar` — the chord's own command — and nothing else", async () => {
    const bar = mount(false);
    await act(async () => undefined);
    act(() => {
      button().click();
    });
    expect(bar.onDispatch.mock.calls).toEqual([[{ type: "toggle_sidebar" }]]);
  });

  it("reports which way the Sidebar is", async () => {
    const expanded = mount(false);
    await act(async () => undefined);
    expect(button()).toHaveAttribute("aria-pressed", "true");
    expect(button()).toHaveAttribute("title", "Toggle Sidebar (Cmd+Q B)");
    expanded.rename("x");
    cleanup();

    mount(true);
    await act(async () => undefined);
    expect(button()).toHaveAttribute("aria-pressed", "false");
  });
});
