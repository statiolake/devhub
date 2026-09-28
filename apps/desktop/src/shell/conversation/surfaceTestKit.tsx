/**
 * Drawing a ConversationSurface in a test: fake actions to watch, and a
 * transcript to draw and draw again.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import type { Transcript } from "../../model/conversation";
import type { ConversationActions } from "./ConversationContext";
import { ConversationSurface } from "./ConversationSurface";

/** jsdom lays nothing out, so there is nothing for it to observe. */
export function installResizeObserver(): void {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

export function fakeActions(
  overrides: Partial<ConversationActions> = {},
): ConversationActions {
  return {
    writeClipboard: vi.fn(() => Promise.resolve()),
    openExternalUrl: vi.fn(() => Promise.resolve()),
    send: vi.fn(() => Promise.resolve()),
    startEditingPending: vi.fn(() => Promise.resolve()),
    editPending: vi.fn(() => Promise.resolve()),
    stopEditingPending: vi.fn(() => Promise.resolve()),
    removePending: vi.fn(() => Promise.resolve()),
    sendPendingNow: vi.fn(() => Promise.resolve()),
    instruct: vi.fn(() => Promise.resolve()),
    rewind: vi.fn(() => Promise.resolve("rewound" as const)),
    interrupt: vi.fn(() => Promise.resolve()),
    cancelLimitResume: vi.fn(() => Promise.resolve()),
    stopTask: vi.fn(() => Promise.resolve()),
    answer: vi.fn(() => Promise.resolve()),
    setSetting: vi.fn(() => Promise.resolve()),
    openResume: vi.fn(),
    openMcp: vi.fn(),
    restart: vi.fn(() => Promise.resolve()),
    saveDraft: vi.fn(() => Promise.resolve()),
    reportFailure: vi.fn(),
    ...overrides,
  };
}

/** `draw`'s saved draft before main has said what it is. */
export const NOT_YET = Symbol("not yet");

export function draw(
  transcript: Transcript,
  actions = fakeActions(),
  hidden = false,
  /** What main kept, or `NOT_YET` while the attachment has not answered. */
  savedDraft: string | typeof NOT_YET = "",
) {
  const surface = (
    next: Transcript,
    nextHidden: boolean,
    nextDraft: string | undefined,
  ) => (
    <ConversationSurface
      transcript={next}
      actions={actions}
      appearance={undefined}
      hidden={nextHidden}
      label="Agent 1"
      savedDraft={nextDraft}
    />
  );
  let draft = savedDraft === NOT_YET ? undefined : savedDraft;
  const view = render(surface(transcript, hidden, draft));
  let current = transcript;
  let currentHidden = hidden;
  return {
    ...view,
    actions,
    redraw(next: Transcript, nextHidden = false) {
      current = next;
      currentHidden = nextHidden;
      view.rerender(surface(next, nextHidden, draft));
    },
    /** Main answering the attachment with the saved draft. */
    answerDraft(next: string) {
      draft = next;
      view.rerender(surface(current, currentHidden, draft));
    },
  };
}

export function entry(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-entry-id="${id}"]`,
  );
  if (!element) throw new Error(`no entry ${id} was drawn`);
  return element;
}

/** A setting's picker in the composer's toolbar, by the word it is named with. */
export function settingPicker(name: string): HTMLElement {
  return screen.getByRole("combobox", { name });
}

/** The value a setting's picker shows closed. */
export function settingValue(name: string): string | undefined {
  return (
    settingPicker(name).querySelector(".conversation-setting-value")
      ?.textContent ?? undefined
  );
}

/** Open a setting's picker with the pointer and read its rows' words. */
export function openSetting(name: string): readonly HTMLElement[] {
  fireEvent.click(settingPicker(name));
  return within(screen.getByRole("listbox", { name })).getAllByRole("option");
}
