/**
 * Drawing a ConversationSurface in a test: fake actions to watch, and a
 * transcript to draw and draw again.
 */

import { render } from "@testing-library/react";
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
    interrupt: vi.fn(() => Promise.resolve()),
    answer: vi.fn(() => Promise.resolve()),
    setSetting: vi.fn(() => Promise.resolve()),
    continueInTerminal: vi.fn(() => Promise.resolve()),
    reportFailure: vi.fn(),
    ...overrides,
  };
}

export function draw(
  transcript: Transcript,
  actions = fakeActions(),
  hidden = false,
) {
  const surface = (next: Transcript, nextHidden: boolean) => (
    <ConversationSurface
      transcript={next}
      actions={actions}
      appearance={undefined}
      hidden={nextHidden}
      label="Agent 1"
    />
  );
  const view = render(surface(transcript, hidden));
  return {
    ...view,
    actions,
    redraw(next: Transcript, nextHidden = false) {
      view.rerender(surface(next, nextHidden));
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
