// @vitest-environment jsdom

/**
 * The one rule every sheet's first field follows.
 *
 * Written against the hook rather than against each sheet, because the whole
 * point of it is that there is one of it: a per-sheet mount effect is a
 * per-sheet chance to focus `null` and never ask again, and that is exactly
 * what the prompt-review sheet was reported for.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useInitialFocus } from "./initialFocus";

/** A sheet whose field arrives with the text it is for, a tick after the sheet. */
function LateField({ ready }: { readonly ready: boolean }) {
  const field = useInitialFocus<HTMLTextAreaElement>((element) => {
    element.setSelectionRange(element.value.length, element.value.length);
  });
  return ready ? (
    <textarea ref={field} aria-label="message" defaultValue="hello" />
  ) : (
    <p>Rendering…</p>
  );
}

function TwoFields() {
  const first = useInitialFocus<HTMLInputElement>();
  return (
    <>
      <input ref={first} aria-label="first" />
      <button type="button">elsewhere</button>
    </>
  );
}

afterEach(cleanup);

describe("the field a sheet opens on", () => {
  it("takes the focus on the render where it first exists", () => {
    const { rerender } = render(<LateField ready={false} />);
    expect(document.activeElement).toBe(document.body);

    rerender(<LateField ready={true} />);

    const field = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(field);
    // `prepare` runs with the element, right after the focus: the caret is at
    // the end of what is already there.
    expect(field.selectionStart).toBe("hello".length);
  });

  it("does not chase the focus a person moved inside the sheet", () => {
    render(<TwoFields />);
    const button = screen.getByRole("button");
    button.focus();

    // Coming back from another app with the caret parked on a button: the page
    // has the keyboard, something in it holds the focus, and it is not this
    // hook's business.
    fireEvent.focus(window);

    expect(document.activeElement).toBe(button);
  });

  it("recovers the focus when the page is given the keyboard with nothing in it", () => {
    render(<TwoFields />);
    const field = screen.getByLabelText("first");
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.focus(window);

    expect(document.activeElement).toBe(field);
  });

  it("stops listening once the sheet is gone", () => {
    const { unmount } = render(<TwoFields />);
    const field = screen.getByLabelText("first");
    unmount();

    // The element is off the document; a stray recovery would be focusing a
    // node nothing can see.
    fireEvent.focus(window);

    expect(document.activeElement).not.toBe(field);
  });
});
