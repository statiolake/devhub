// @vitest-environment jsdom

/**
 * A toast hides itself, and what it said is kept in the notice center.
 *
 * The clock: `general.notice_seconds` (8 by default, `0` never), stopped while
 * the pointer is on the toast, the keyboard is in it, or its words are
 * selected. The center: every notice that reached the screen, newest first,
 * unread until seen, actions while still in force, opened and closed by
 * `show_notifications` (`Cmd+Q M`), Escape handing the keyboard back.
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError, NoticeRetiredWire } from "../../ipc/appShell";
import type { NoticeSettingsWire } from "../../ipc/contract";
import { ToastsApp } from "./ToastsApp";

class NoLayout {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoLayout as unknown as typeof ResizeObserver;

function failure(code: AppError["code"], summary: string): AppError {
  return {
    code,
    summary,
    module: "state",
    timestampMs: 1,
    runtimeVersion: "test",
    actions: ["retry"],
  };
}

const SAVE = failure("persistence_degraded", "DevHub could not save.");

function mount() {
  let publishError: (error: AppError) => void = () => undefined;
  let publishCondition: (condition: {
    source: string;
    summary?: string;
  }) => void = () => undefined;
  let menuCommand: (command: string) => void = () => undefined;
  let actionStarted: () => void = () => undefined;
  let settings: (settings: NoticeSettingsWire) => void = () => undefined;
  const retired: NoticeRetiredWire[] = [];
  const focusSurface = vi.fn(() => Promise.resolve());

  window.devhub = {
    onNativeError: (listener: (error: AppError) => void) => {
      publishError = listener;
      return () => undefined;
    },
    onAppCondition: (
      listener: (condition: { source: string; summary?: string }) => void,
    ) => {
      publishCondition = listener;
      return () => undefined;
    },
    onActionStarted: (listener: () => void) => {
      actionStarted = listener;
      return () => undefined;
    },
    onMenuCommand: (listener: (command: string) => void) => {
      menuCommand = listener;
      return () => undefined;
    },
    onNoticeSettings: (listener: (s: NoticeSettingsWire) => void) => {
      settings = listener;
      return () => undefined;
    },
    focusSurface,
    reportListening: () => undefined,
    reportNoticeRetired: (wire: NoticeRetiredWire) => {
      retired.push(wire);
      return Promise.resolve();
    },
    reportToastsSize: () => undefined,
    retryApp: () => undefined,
    openSettings: () => Promise.resolve(),
    writeClipboard: () => Promise.resolve(),
  } as unknown as typeof window.devhub;

  render(<ToastsApp />);

  return {
    retired,
    focusSurface,
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
    seconds: (hideAfterSeconds: number) =>
      act(() => settings({ hideAfterSeconds })),
  };
}

const toasts = () => Array.from(document.querySelectorAll(".toast"));
const entries = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".notice-entry"));
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a toast's time on screen", () => {
  it("hides itself after eight seconds, into the center, unread", () => {
    const page = mount();
    page.fail(SAVE);
    wait(7_900);
    expect(toasts()).toHaveLength(1);
    wait(200);
    expect(toasts()).toHaveLength(0);
    // Main's journal hears it left by the clock, not by the person.
    expect(page.retired).toEqual([
      { identity: "app\u0000persistence_degraded", reason: "timeout" },
    ]);
    page.chord("show_notifications");
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toHaveAttribute("data-unread", "true");
    expect(entries()[0]).toHaveTextContent("DevHub could not save.");
  });

  it("waits while the pointer is on it, and runs on when it leaves", () => {
    const page = mount();
    page.fail(SAVE);
    wait(5_000);
    const toast = toasts()[0];
    if (!toast) throw new Error("no toast");
    fireEvent.pointerEnter(toast);
    wait(60_000);
    expect(toasts()).toHaveLength(1);
    fireEvent.pointerLeave(toast);
    // Three seconds were left.
    wait(2_900);
    expect(toasts()).toHaveLength(1);
    wait(200);
    expect(toasts()).toHaveLength(0);
  });

  it("gives at least two seconds once the person moves away", () => {
    const page = mount();
    page.fail(SAVE);
    wait(7_900);
    const toast = toasts()[0];
    if (!toast) throw new Error("no toast");
    fireEvent.pointerEnter(toast);
    fireEvent.pointerLeave(toast);
    wait(1_900);
    expect(toasts()).toHaveLength(1);
    wait(200);
    expect(toasts()).toHaveLength(0);
  });

  it("waits while the keyboard is in it", () => {
    const page = mount();
    page.fail(SAVE);
    const toast = toasts()[0] as HTMLElement;
    act(() => {
      toast.focus();
    });
    wait(60_000);
    expect(toasts()).toHaveLength(1);
    act(() => {
      toast.blur();
    });
    wait(8_000);
    expect(toasts()).toHaveLength(0);
  });

  it("waits while its words are selected", () => {
    const page = mount();
    page.fail(SAVE);
    const summary = document.querySelector(".toast-summary");
    if (!summary) throw new Error("no summary");
    act(() => {
      const range = document.createRange();
      range.selectNodeContents(summary);
      document.getSelection()?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    wait(60_000);
    expect(toasts()).toHaveLength(1);
    act(() => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    wait(8_000);
    expect(toasts()).toHaveLength(0);
  });

  it("stays for ever at 0, and follows the setting when it changes", () => {
    const page = mount();
    page.seconds(0);
    page.fail(SAVE);
    wait(600_000);
    expect(toasts()).toHaveLength(1);
    page.seconds(3);
    wait(3_100);
    expect(toasts()).toHaveLength(0);
  });

  it("does not come straight back when the same failure repeats", () => {
    const page = mount();
    page.fail(SAVE);
    wait(8_100);
    wait(6_000);
    page.fail(SAVE);
    expect(toasts()).toHaveLength(0);
  });

  it("hides a standing condition too; the center says it is ongoing", () => {
    const page = mount();
    page.observe("repository_status", "`gh` is not on the PATH.");
    wait(8_100);
    expect(toasts()).toHaveLength(0);
    page.chord("show_notifications");
    expect(entries()[0]).toHaveTextContent("Ongoing");
    page.observe("repository_status");
    expect(entries()[0]).toHaveTextContent("Resolved");
  });
});

describe("conditions from two sources", () => {
  const MACHINE = "machine:ssh:build-box";

  it("hide on their own clocks, each into the center", () => {
    const page = mount();
    page.observe("repository_status", "`gh` is not on the PATH.");
    wait(4_000);
    page.observe(MACHINE, "DevHub is not getting an answer.");
    wait(4_100);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toHaveTextContent("DevHub is not getting an answer.");
    wait(4_000);
    expect(toasts()).toHaveLength(0);
    expect(page.retired).toEqual([
      { identity: "condition\u0000repository_status", reason: "timeout" },
      { identity: `condition\u0000${MACHINE}`, reason: "timeout" },
    ]);
  });

  it("are Ongoing and Resolved each by its own source", () => {
    const page = mount();
    page.observe("repository_status", "`gh` is not on the PATH.");
    page.observe(MACHINE, "DevHub is not getting an answer.");
    page.chord("show_notifications");
    const states = () =>
      entries().map((entry) =>
        entry.textContent?.includes("Ongoing") ? "Ongoing" : "Resolved",
      );
    expect(states()).toEqual(["Ongoing", "Ongoing"]);

    // Newest first: the machine, then the repository.
    page.observe("repository_status");
    expect(states()).toEqual(["Ongoing", "Resolved"]);
    page.observe(MACHINE);
    expect(states()).toEqual(["Resolved", "Resolved"]);
  });

  it("report a source retracting its own on-screen condition under its key", () => {
    const page = mount();
    page.observe("repository_status", "`gh` is not on the PATH.");
    page.observe(MACHINE, "DevHub is not getting an answer.");
    page.observe("repository_status");
    expect(page.retired).toEqual([
      { identity: "condition\u0000repository_status", reason: "source" },
    ]);
    expect(toasts()).toHaveLength(1);
  });
});

describe("the notice center", () => {
  it("lists what was said newest first, and keeps one put away as read", () => {
    const page = mount();
    page.fail(SAVE);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    page.observe("repository_status", "`gh` is not on the PATH.");
    page.chord("show_notifications");
    const [newest, older] = entries();
    expect(newest).toHaveTextContent("`gh` is not on the PATH.");
    expect(newest).toHaveAttribute("data-unread", "true");
    expect(older).toHaveTextContent("DevHub could not save.");
    expect(older).not.toHaveAttribute("data-unread");
    expect(screen.getByText("1 new")).toBeInTheDocument();
    expect(newest?.querySelector("time")).not.toBeNull();
  });

  it("is read once it has been opened", () => {
    const page = mount();
    page.fail(SAVE);
    page.chord("show_notifications");
    page.chord("show_notifications");
    page.chord("show_notifications");
    expect(entries()[0]).not.toHaveAttribute("data-unread");
  });

  it("offers an entry's actions only while it is still in force", () => {
    const page = mount();
    page.fail(SAVE);
    page.chord("show_notifications");
    expect(screen.getByRole("button", { name: "Try Again" })).toBeVisible();
    page.act();
    expect(screen.queryByRole("button", { name: "Try Again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
  });

  it("takes the keyboard to the newest entry, and the arrows between them", () => {
    const page = mount();
    page.fail(SAVE);
    page.fail(failure("native_unavailable", "Something else."));
    page.chord("show_notifications");
    const [first, second] = entries();
    expect(first).toHaveFocus();
    fireEvent.keyDown(first as HTMLElement, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second as HTMLElement, { key: "ArrowUp" });
    expect(first).toHaveFocus();
  });

  it("removes one entry, or all of them", () => {
    const page = mount();
    page.fail(SAVE);
    page.fail(failure("native_unavailable", "Something else."));
    page.chord("show_notifications");
    expect(entries()).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    expect(entries()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear All" }));
    expect(entries()).toHaveLength(0);
    expect(screen.getByText("No notifications")).toBeInTheDocument();
    // What was on screen went with it.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(toasts()).toHaveLength(0);
  });

  it("closes on Escape and hands the keyboard back", () => {
    const page = mount();
    page.fail(SAVE);
    page.chord("show_notifications");
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeVisible();
    expect(toasts()).toHaveLength(0);
    fireEvent.keyDown(entries()[0] as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(page.focusSurface).toHaveBeenCalledTimes(1);
    // The toast is back, its clock started over.
    expect(toasts()).toHaveLength(1);
  });

  it("closes when the same chord comes again", () => {
    const page = mount();
    page.chord("show_notifications");
    expect(screen.getByText("No notifications")).toBeInTheDocument();
    page.chord("show_notifications");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(page.focusSurface).toHaveBeenCalledTimes(1);
  });
});
