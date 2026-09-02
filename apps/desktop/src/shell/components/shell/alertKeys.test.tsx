// @vitest-environment jsdom

/**
 * Where an alert listens for the keys it answers.
 *
 * On itself, and this is a rule rather than a detail. Escape and Tab used to be
 * a listener on `document`, which works perfectly for an alert standing alone
 * and fails the moment one sheet hands over to another: the handover happens
 * while the key that caused it is still travelling up to `document`, so the
 * arriving alert registered in time to catch the very Escape that summoned it
 * and cancelled itself. Escape out of the clone folder list closed the whole
 * sheet instead of going back to the repository.
 *
 * jsdom's flush ordering is not the browser's, so that sequence cannot be
 * reproduced here. What can be checked is the property that made it possible —
 * and that is the better thing to hold on to anyway: a sheet answers the keys
 * pressed inside it, and nothing else.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alert } from "./Alert";

afterEach(cleanup);

function mount() {
  const onCancel = vi.fn();
  render(
    <Alert
      tone="plain"
      title="Clone Project"
      actions={[{ label: "Continue", isDefault: true, run: vi.fn() }]}
      onCancel={onCancel}
    />,
  );
  return { onCancel };
}

describe("an alert's keys", () => {
  it("registers no keyboard listener on the document", () => {
    const listen = vi.spyOn(document, "addEventListener");
    mount();
    expect(
      listen.mock.calls.filter(([type]) => type === "keydown"),
    ).toHaveLength(0);
    listen.mockRestore();
  });

  it("cancels on Escape pressed inside it", () => {
    const { onCancel } = mount();
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("does not answer an Escape pressed somewhere else", () => {
    // Somewhere else is another sheet — the one this alert is replacing, whose
    // Escape is what put this alert on screen. Answering it would cancel a
    // question the person has only just been asked.
    const { onCancel } = mount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
