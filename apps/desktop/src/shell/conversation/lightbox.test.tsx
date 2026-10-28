// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationActionsProvider } from "./ConversationContext";
import { Markdown } from "./Markdown";
import { fakeActions } from "./surfaceTestKit";

afterEach(cleanup);

function draw(source: string) {
  return render(
    <ConversationActionsProvider value={fakeActions()}>
      <Markdown source={source} streaming={false} />
    </ConversationActionsProvider>,
  );
}

const SVG =
  '```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20"/></svg>\n```\n';

describe("a drawing opened large", () => {
  it("opens on a click on the picture, fitted, and closes on Esc", () => {
    draw(SVG);
    const enlarge = screen.getByRole("button", { name: "Enlarge" });
    enlarge.focus();
    fireEvent.click(screen.getByRole("img", { name: "SVG image" }));
    const dialog = screen.getByRole("dialog", { name: "SVG image" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveFocus();
    // Outside the transcript, over the page.
    expect(dialog.closest(".conversation-markdown")).toBeNull();
    const large = within(dialog).getByRole("img", { name: "SVG image" });
    expect(large.getAttribute("style")).toMatch(/width: min\(/);
    // A click shows it at its own size, and again fits it.
    fireEvent.click(large);
    expect(large.getAttribute("style") ?? "").toBe("");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(enlarge).toHaveFocus();
  });

  it("opens from the header's button, and closes outside or on Close", () => {
    const { container } = draw(SVG);
    fireEvent.click(screen.getByRole("button", { name: "Enlarge" }));
    const backdrop = document.querySelector(".conversation-lightbox")!;
    fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(container).getByRole("button", { name: "Enlarge" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is the same sandboxed frame for a page, large", () => {
    draw("```html\n<h1>Report</h1>\n```\n");
    fireEvent.click(screen.getByRole("button", { name: "Enlarge" }));
    const dialog = screen.getByRole("dialog", { name: "HTML preview" });
    const frame = dialog.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame).toHaveClass("conversation-lightbox-page");
  });

  it("is the slide viewer for a deck, ←/→ still flipping", async () => {
    draw("```marp\n# One\n\n---\n\n# Two\n```\n");
    fireEvent.click(await screen.findByRole("img", { name: "Slide 1 of 2" }));
    const dialog = screen.getByRole("dialog", { name: "Slides, 1 of 2" });
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(
      within(screen.getByRole("dialog")).getByRole("img", {
        name: "Slide 2 of 2",
      }),
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    // The deck in the answer is on the slide the viewer was left on.
    expect(
      screen.getByRole("img", { name: "Slide 2 of 2" }),
    ).toBeInTheDocument();
  });
});
