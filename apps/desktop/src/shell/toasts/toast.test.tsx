// @vitest-environment jsdom

/**
 * Where the application says what is wrong with the application.
 *
 * One place: the toast stack, on a page of its own. Not the foot of the
 * Sidebar, which is a list of what is open and not an error area — a `gh` that
 * is not on the PATH is not a property of the workspace rows it was drawn
 * under. The tests here are the three things that made the old note the wrong
 * shape as well as the wrong place: a condition that keeps failing must not
 * pile up, a condition its source retracts must go, and one the person put
 * away must stay away.
 *
 * The page has no model, so this mounts no provider and no client. Its whole
 * contract is a handful of pushes and a handful of sends, which is what the
 * stub below is: `ToastsApp`'s header lists it in full.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "../../ipc/appShell";
import { ToastsApp } from "./ToastsApp";

const GH_MISSING = "`gh` is not on the PATH DevHub was given.";

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
  const sizes: string[] = [];
  let publishError: (error: AppError) => void = () => undefined;
  let publishCondition: (condition: {
    source: string;
    summary?: string;
  }) => void = () => undefined;
  let menuCommand: (command: string) => void = () => undefined;
  let actionStarted: () => void = () => undefined;
  /** What was already being listened for, each time the page said it listens. */
  const listening: string[][] = [];
  const heard = new Set<string>();

  window.devhub = {
    onNativeError: (listener: (error: AppError) => void) => {
      publishError = listener;
      heard.add("nativeError");
      return () => undefined;
    },
    onAppCondition: (
      listener: (condition: { source: string; summary?: string }) => void,
    ) => {
      publishCondition = listener;
      heard.add("appCondition");
      return () => undefined;
    },
    reportListening: () => {
      listening.push([...heard].sort());
    },
    onActionStarted: (listener: () => void) => {
      actionStarted = listener;
      return () => undefined;
    },
    onMenuCommand: (listener: (command: string) => void) => {
      menuCommand = listener;
      return () => undefined;
    },
    reportNoticeRetired: () => Promise.resolve(),
    reportToastsSize: (size: { width: number; height: number }) => {
      sizes.push(`${String(size.width)}x${String(size.height)}`);
    },
    retryApp: () => undefined,
    openSettings: () => Promise.resolve(),
  } as unknown as typeof window.devhub;

  render(<ToastsApp />);

  return {
    /** Every size this page has told main its notices take up. */
    sizes,
    listening,
    /**
     * A look at the repositories that did or did not finish.
     *
     * The watcher's diagnostic is an app-scoped condition like any other now:
     * main publishes it from the source, so to this page it arrives on
     * `appCondition` and is not a projection it has to read.
     */
    look: (_sequence: number, diagnostic?: string) =>
      act(() => {
        publishCondition({
          source: "repository_status",
          ...(diagnostic === undefined ? {} : { summary: diagnostic }),
        });
      }),
    fail: (error: AppError) =>
      act(() => {
        publishError(error);
      }),
    observe: (source: string, summary?: string) =>
      act(() => {
        publishCondition({
          source,
          ...(summary === undefined ? {} : { summary }),
        });
      }),
    act: () => act(() => actionStarted()),
    chord: (command: string) => act(() => menuCommand(command)),
  };
}

const toasts = () => Array.from(document.querySelectorAll(".toast"));
const said = () => toasts().map((toast) => toast.textContent ?? "");

/**
 * Every toast node added or removed while this was watching.
 *
 * `takeRecords()` and not the callback: a `MutationObserver` delivers its
 * records in a microtask, and a synchronous test that disconnects first would
 * read an empty list and call it proof. That is a test that passes because it
 * saw nothing rather than because nothing happened, which is the one kind of
 * green worth less than red.
 */
function watchToastChurn() {
  const seen: string[] = [];
  const take = (records: readonly MutationRecord[]) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement && node.querySelector(".toast-summary"))
          seen.push("added");
      }
      for (const node of record.removedNodes) {
        if (node instanceof HTMLElement && node.querySelector(".toast-summary"))
          seen.push("removed");
      }
    }
  };
  const watcher = new MutationObserver(take);
  watcher.observe(document.body, { childList: true, subtree: true });
  return {
    churn: seen,
    stop: () => {
      take(watcher.takeRecords());
      watcher.disconnect();
      return seen;
    },
  };
}

describe("the page coming up", () => {
  afterEach(cleanup);

  // Main holds what went wrong before any page existed — a settings file that
  // will not parse — until there is somebody to tell. The somebody is this
  // page, and only once it is listening: a failure sent a moment earlier is
  // sent to a page with no listener and is gone. So the page says so, once,
  // after its listeners are in place, rather than main guessing from some
  // other page having asked for the snapshot.
  it("says it is listening once, after it can draw what main sends", () => {
    const page = mount();
    expect(page.listening).toEqual([["appCondition", "nativeError"]]);
  });
});

describe("a condition about the whole application", () => {
  afterEach(cleanup);

  it("is a toast on the page whose whole job is toasts", () => {
    const { look } = mount();
    look(1, GH_MISSING);

    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent(GH_MISSING);
    // Nothing else is on this page: no sidebar to be written at the foot of,
    // and no surface to be banded across the top of.
    expect(document.querySelector(".sidebar")).toBeNull();
    expect(document.querySelectorAll(".toast-stack")).toHaveLength(1);
  });

  it("does not pile up when look after look fails the same way", () => {
    const { look } = mount();
    look(1, GH_MISSING);
    look(2, GH_MISSING);
    look(3, GH_MISSING);
    expect(said()).toEqual([expect.stringContaining(GH_MISSING)]);
  });

  it("goes when a later look succeeds, and comes back if it fails again", () => {
    const { look } = mount();
    look(1, GH_MISSING);
    expect(toasts()).toHaveLength(1);

    // The one thing besides the person that retires a condition: the source
    // that raised it saying it no longer holds.
    look(2);
    expect(toasts()).toHaveLength(0);

    look(3, GH_MISSING);
    expect(toasts()).toHaveLength(1);
  });

  it("stays away once the person has put it away", async () => {
    const { look } = mount();
    look(1, GH_MISSING);
    await act(async () => {
      screen.getByRole("button", { name: "Dismiss" }).click();
    });
    expect(toasts()).toHaveLength(0);

    look(2, GH_MISSING);
    expect(toasts()).toHaveLength(0);
  });

  it("comes back as news once it has ended and started again", async () => {
    const { look } = mount();
    look(1, GH_MISSING);
    await act(async () => {
      screen.getByRole("button", { name: "Dismiss" }).click();
    });

    look(2);
    look(3, GH_MISSING);
    expect(toasts()).toHaveLength(1);
  });

  it("closes on Escape when the keyboard is on it", () => {
    const { look } = mount();
    look(1, GH_MISSING);
    const toast = screen.getByRole("status");
    act(() => {
      toast.focus();
      toast.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(toasts()).toHaveLength(0);
  });
});

describe("a failure and a condition at once", () => {
  afterEach(cleanup);

  const failure: AppError = {
    code: "persistence_degraded",
    summary: "DevHub could not save its state file.",
    module: "state",
    timestampMs: 1,
    runtimeVersion: "test",
    actions: ["retry"],
    detail: "state.json: permission was denied (EACCES)",
  };

  it("are two toasts, newest last", () => {
    const { look, fail } = mount();
    look(1, GH_MISSING);
    fail(failure);
    expect(said()).toEqual([
      expect.stringContaining(GH_MISSING),
      expect.stringContaining("could not save its state file"),
    ]);
  });

  it("give `Cmd+Q D` the newest of the two, and then the other", () => {
    const { look, fail, chord } = mount();
    look(1, GH_MISSING);
    fail(failure);

    chord("dismiss_alert");
    expect(said()).toEqual([expect.stringContaining(GH_MISSING)]);

    chord("dismiss_alert");
    expect(toasts()).toHaveLength(0);
  });
});

/**
 * The flicker, as a test: a condition that holds and a source that keeps
 * describing it differently.
 *
 * This is what the owner saw — a sentence blinking five to ten times a second
 * on a machine after a sleep — and every part of it is ordinary. A reconcile
 * round republishes while the condition holds, and the words it publishes
 * carry the failing side's own detail, which moves: `main/terminal/tmux.ts`
 * names the subcommand and the budget it gave up after, so "did not answer
 * within 2 s" becomes "within 4 s" becomes a different subcommand entirely.
 *
 * If any of that reached the notice's identity, each publish would be a
 * different notice, the stack keys by identity, and React would take one node
 * out and put another in — at the publish rate. So the assertion is not about
 * what the toast says: it is that the *same DOM element* is still there after
 * fifty publishes, and that nothing was added or removed on the way.
 */
describe("a condition that holds while its words move", () => {
  afterEach(cleanup);

  it("is one node that never leaves, however often the sentence changes", () => {
    const { observe } = mount();
    observe("machine:ssh:build-box", "DevHub is not getting an answer.");

    const first = screen.getByRole("status");
    const seen = watchToastChurn();

    for (let round = 1; round <= 50; round += 1) {
      observe(
        "machine:ssh:build-box",
        `DevHub is not getting an answer. tmux \`list-panes\` did not answer within ${String(round)} s`,
      );
    }
    expect(seen.stop()).toEqual([]);
    expect(toasts()).toHaveLength(1);
    // Element identity, not text: a node that was replaced by an identical one
    // is exactly the bug, and it reads the same to `toHaveTextContent`.
    expect(screen.getByRole("status")).toBe(first);
  });

  it("is one node for a failure whose detail moves, too", () => {
    const { fail } = mount();
    const raise = (detail: string): AppError => ({
      code: "native_unavailable",
      summary: "The native app shell is unavailable.",
      module: "terminal",
      timestampMs: 1,
      runtimeVersion: "test",
      actions: ["retry", "open_settings"],
      detail,
    });
    fail(raise("tmux `list-panes` did not answer within 1 s"));

    const first = screen.getByRole("alert");
    const seen = watchToastChurn();

    for (let round = 1; round <= 50; round += 1) {
      fail(
        raise(
          `tmux \`display-message\` did not answer within ${String(round)} s`,
        ),
      );
    }
    expect(seen.stop()).toEqual([]);
    expect(toasts()).toHaveLength(1);
    expect(screen.getByRole("alert")).toBe(first);
  });
});

/**
 * The publisher's rate, made to stop mattering.
 *
 * The audit that went with this found no single 5–10 Hz publisher and several
 * that could become one: `syncEditorViews` publishes one failure per folder on
 * every projection change, and a projection change happens at the local
 * reconcile cadence of 300 ms, so two open workspaces is already ten publishes
 * a second; the editor restart backoff starts at 250 ms and resets its counter
 * whenever the workbench manages to load, so it can sit at four a second
 * indefinitely; and a `ResizeObserver` that reports a rejected `setContentRect`
 * publishes at whatever rate the layout is churning at, which after a wake is
 * frame rate. None of them is wrong to say what it says as often as it says it.
 *
 * So the test is not about any of them. It hammers the seam they all arrive
 * at, at twenty a second, with the detail alternating the way a real one does,
 * and asks for the only two things that matter on screen: one node, and the
 * same node.
 */
describe("a publisher hammering the seam", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  const HAMMER_HZ = 20;
  const PERIOD_MS = 1000 / HAMMER_HZ;

  it("moves one condition node and no other, for three seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { observe } = mount();
    observe("machine:ssh:build-box", "DevHub is not getting an answer.");

    const first = screen.getByRole("status");
    const seen = watchToastChurn();
    for (let publish = 1; publish <= HAMMER_HZ * 3; publish += 1) {
      vi.setSystemTime(publish * PERIOD_MS);
      observe(
        "machine:ssh:build-box",
        publish % 2 === 0
          ? "DevHub is not getting an answer. tmux `list-panes` did not answer within 2 s"
          : "DevHub is not getting an answer. tmux `display-message` did not answer within 4 s",
      );
    }
    expect(seen.stop()).toEqual([]);
    expect(toasts()).toHaveLength(1);
    expect(screen.getByRole("status")).toBe(first);
  });

  it("moves one failure node and no other, for three seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { fail } = mount();
    const raise = (detail: string): AppError => ({
      code: "native_unavailable",
      summary: "The native app shell is unavailable.",
      module: "editor",
      timestampMs: 1,
      runtimeVersion: "test",
      actions: ["retry", "open_settings"],
      detail,
    });
    fail(raise("the workbench view could not be opened"));

    const first = screen.getByRole("alert");
    const seen = watchToastChurn();
    for (let publish = 1; publish <= HAMMER_HZ * 3; publish += 1) {
      vi.setSystemTime(publish * PERIOD_MS);
      fail(
        raise(
          publish % 2 === 0
            ? "the workbench view could not be opened"
            : `the workbench stopped unexpectedly (attempt ${String(publish)})`,
        ),
      );
    }
    expect(seen.stop()).toEqual([]);
    expect(toasts()).toHaveLength(1);
    expect(screen.getByRole("alert")).toBe(first);
  });

  it("keeps two codes taking turns down to one node apiece", () => {
    // The case a stable identity cannot help with, and the reason the rule is
    // at the seam rather than in the key. Two codes are two identities and two
    // toasts, so swapping them twenty times a second is a real remove and add
    // whatever the stack keys by. Held to one raise each by the episode.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { fail } = mount();
    const raise = (code: AppError["code"]): AppError => ({
      code,
      summary: "Something is wrong.",
      module: "editor",
      timestampMs: 1,
      runtimeVersion: "test",
      actions: ["retry"],
    });
    fail(raise("native_unavailable"));

    const seen = watchToastChurn();
    for (let publish = 1; publish <= HAMMER_HZ * 3; publish += 1) {
      vi.setSystemTime(publish * PERIOD_MS);
      fail(
        raise(publish % 2 === 0 ? "native_unavailable" : "editor_unavailable"),
      );
    }
    const churn = seen.stop();

    // The second code's one and only raise: the failure channel holds one
    // slot, so the newcomer took the first one's place — one node out, one in,
    // once, instead of sixty times.
    expect(churn.filter((what) => what === "removed")).toHaveLength(1);
    expect(churn.filter((what) => what === "added")).toHaveLength(1);
    expect(toasts()).toHaveLength(1);
  });

  it("still has news for the person once they have acted on it", async () => {
    // The other half of the same rule, and the half a throttle gets wrong: a
    // notice the person has put away is a slot that is empty again, so the
    // next failure — inside the quiet window or not — is theirs to see.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { fail } = mount();
    const error: AppError = {
      code: "native_unavailable",
      summary: "The native app shell is unavailable.",
      module: "editor",
      timestampMs: 1,
      runtimeVersion: "test",
      actions: ["retry"],
    };
    fail(error);
    expect(toasts()).toHaveLength(1);

    await act(async () => {
      screen.getByRole("button", { name: "Dismiss" }).click();
    });
    vi.setSystemTime(PERIOD_MS);
    fail(error);
    // Dismissed stays dismissed — that is `alertLifetime`, not the episode.
    expect(toasts()).toHaveLength(0);
  });
});

/**
 * The size the view is given, and the one report that must never be missed.
 *
 * This page's view is exactly as big as its stack, because a native view takes
 * every click inside its bounds whether or not anything is painted there. The
 * corollary is the dangerous case: a stack that empties and does not say so
 * leaves an invisible rectangle over the editor's corner for the rest of the
 * session, taking clicks for nothing. It is not something anybody would see.
 *
 * jsdom computes no layout, so the measured element is given a size of its own
 * here — what is being pinned is that the report follows the notices, not what
 * a browser would have measured.
 */
describe("how much room the page says it needs", () => {
  afterEach(cleanup);

  it("says nothing before anything has been said", () => {
    // Not "reports zero": main starts with this layer out of the window, so a
    // page that opened by saying it needs no room would be telling main what
    // main already has. What is worth saying is a change.
    const { sizes } = mount();
    expect(sizes).toEqual([]);
  });

  it("is the stack's size while there is a notice, and nothing again after", () => {
    const { look, sizes } = mount();
    Element.prototype.getBoundingClientRect = function boxed(this: Element) {
      return this.classList.contains("toast-stack")
        ? ({ width: 320, height: 96 } as DOMRect)
        : ({ width: 0, height: 0 } as DOMRect);
    };
    look(1, GH_MISSING);
    expect(sizes.at(-1)).toBe("320x96");
    look(2);
    expect(sizes.at(-1)).toBe("0x0");
  });
});
