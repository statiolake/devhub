// @vitest-environment jsdom

/**
 * How long a failure stays on screen.
 *
 * One rule, and it does not depend on what raised the failure: the person
 * dismisses it, the person starts another action, or a different failure
 * replaces it. The tests here are about the half that is easy to get wrong —
 * a failure that keeps being raised. A degraded save is re-raised every time
 * anything is persisted, which is every few seconds while agents are
 * reconciling, and an alert that comes back the instant it is closed is an
 * alert nobody can close.
 *
 * The rule is the page's and the page is this one, but one of its three exits
 * is not something this page can see: it has no model, so "the person started
 * another action" arrives from main, which sees every dispatch a page makes.
 * That is `devhub:action-started`, and here it is a function to call.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AppError } from "../../ipc/appShell";
import { ToastsApp } from "./ToastsApp";

function failure(detail: string): AppError {
  return {
    code: "persistence_degraded",
    summary: "DevHub could not save its state file.",
    module: "state",
    timestampMs: 1,
    runtimeVersion: "test",
    actions: ["retry"],
    detail,
  };
}

/**
 * jsdom has no `ResizeObserver`, and the page measures itself with one.
 *
 * Stubbed rather than guarded in the product: a page that quietly stopped
 * measuring would be a notice view that is never sized and never seen, which
 * is the failure this whole arrangement exists to stop. The stub does nothing,
 * because what these tests assert is the DOM, not the rectangle main is told.
 */
class NoLayout {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoLayout as unknown as typeof ResizeObserver;

function mount() {
  let publish: (error: AppError) => void = () => undefined;
  let action: () => void = () => undefined;
  const raised: AppError[] = [];
  window.devhub = {
    onNativeError: (listener: (error: AppError) => void) => {
      publish = listener;
      return () => undefined;
    },
    onAppCondition: () => () => undefined,
    onActionStarted: (listener: () => void) => {
      action = listener;
      return () => undefined;
    },
    onMenuCommand: () => () => undefined,
    reportNoticeRetired: () => Promise.resolve(),
    reportToastsSize: () => undefined,
    retryApp: () => undefined,
    reportListening: () => undefined,
    openSettings: () => Promise.resolve(),
    raiseFailure: (error: AppError) => {
      raised.push(error);
    },
  } as unknown as typeof window.devhub;
  render(<ToastsApp />);
  return {
    raised,
    raise: (error: AppError) => act(() => publish(error)),
    start: () => act(() => action()),
  };
}

const alert = () => document.querySelector(".toast-stack")?.textContent ?? "";

describe("the failure on screen", () => {
  afterEach(cleanup);

  it("says which file could not be saved and why", () => {
    const { raise } = mount();
    raise(failure("/tmp/state.json: permission was denied (EACCES)"));
    expect(alert()).toContain(
      "/tmp/state.json: permission was denied (EACCES)",
    );
  });

  it("stays dismissed when the same failure is raised again", async () => {
    const { raise } = mount();
    raise(failure("/tmp/state.json: permission was denied (EACCES)"));
    await act(async () => {
      screen.getByRole("button", { name: "Dismiss" }).click();
    });
    expect(alert()).toBe("");

    raise(failure("/tmp/state.json: permission was denied (EACCES)"));
    expect(alert()).toBe("");
  });

  it("shows a failure that is not the dismissed one", async () => {
    const { raise } = mount();
    raise(failure("/tmp/state.json: permission was denied (EACCES)"));
    await act(async () => {
      screen.getByRole("button", { name: "Dismiss" }).click();
    });

    raise({
      code: "native_unavailable",
      summary: "The native app shell is unavailable.",
      module: "app",
      timestampMs: 1,
      runtimeVersion: "test",
      actions: ["retry"],
    });
    expect(alert()).toContain("The native app shell is unavailable.");
  });

  it("keeps a dismissed failure away when it comes back in other words", async () => {
    // The same failure re-worded is the same failure. A save that cannot
    // write has a different reason every time the disk is asked — permission
    // one moment, no space the next — and if the words decided which failure
    // it was, the source would only have to reword itself to put a dismissed
    // alert straight back. It is the code that says what a failure is.
    const { raise } = mount();
    raise(failure("/tmp/state.json: permission was denied (EACCES)"));
    await act(async () => {
      screen.getByRole("button", { name: "Dismiss" }).click();
    });

    raise(failure("/tmp/state.json: the file could not be written (ENOSPC)"));
    expect(alert()).toBe("");
  });

  it("keeps a dismissed close failure away until the next close is asked for", async () => {
    // A close that fails raises the same failure every time it is tried, and
    // the model re-pushes it with no detail to tell one from another. The
    // rule is the same as for every other failure: dismissing it puts it
    // away, and only the person's next action brings it back.
    const closeFailed: AppError = {
      code: "workspace_close_failed",
      summary: "The workspace could not be closed cleanly.",
      module: "app",
      timestampMs: 1,
      runtimeVersion: "test",
      actions: ["retry"],
    };
    const { raise, start } = mount();
    raise(closeFailed);
    expect(alert()).toContain("could not be closed");

    await act(async () => {
      screen.getByRole("button", { name: "Dismiss" }).click();
    });
    expect(alert()).toBe("");

    // A reconcile, a persist, anything that re-raises it: still away.
    raise(closeFailed);
    raise(closeFailed);
    expect(alert()).toBe("");

    start();
    raise(closeFailed);
    expect(alert()).toContain("could not be closed");
  });

  it("shows it again once the user has started another action", async () => {
    const { raise, start } = mount();
    raise(failure("/tmp/state.json: permission was denied (EACCES)"));
    await act(async () => {
      screen.getByRole("button", { name: "Dismiss" }).click();
    });

    start();
    raise(failure("/tmp/state.json: permission was denied (EACCES)"));
    expect(alert()).toContain("permission was denied");
  });
});

/**
 * The rule with two halves: what began here is raised, what arrived is drawn.
 *
 * Both halves used to live in one callback, and which one ran was decided by a
 * prop the overlay page set. That made "a failure arrived" and "a failure
 * happened" the same event on a page that had nowhere to draw one: the overlay
 * received `nativeError`, took itself to be the raiser, handed it back to main,
 * and main published it again. Nothing in the loop was wrong on its own. The
 * fix is not de-duplication; it is that the two halves are two functions, and
 * the delivered one has no way to raise.
 */
describe("a failure delivered to a page", () => {
  afterEach(cleanup);

  it("is never raised back to main", () => {
    const { raise, raised } = mount();
    // Delivery, over and over — the shape the echo had.
    raise(failure("the worktree could not be removed"));
    raise(failure("the worktree could not be removed"));
    raise(failure("the worktree could not be removed"));
    expect(raised).toEqual([]);
  });

  it("is drawn, which is the only thing a delivered failure is for", () => {
    const { raise } = mount();
    raise(failure("the worktree could not be removed"));
    expect(alert()).toContain("the worktree could not be removed");
  });
});
