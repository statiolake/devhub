// @vitest-environment jsdom

/**
 * `useGlide`: what changes place starts where it was and ends where the
 * layout put it, and what is new rises in — measured, not assumed, so the
 * layout here is stated per element.
 */

import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGlide } from "./glide";

/** Where each item is laid out, by its key: what the test says the layout is. */
const layout = new Map<string, number>();
const animations: { key: string; frames: Keyframe[] }[] = [];

beforeEach(() => {
  layout.clear();
  animations.length = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const top = layout.get(this.dataset["key"] ?? "") ?? 0;
      return new DOMRect(0, top, 100, 20);
    },
  );
  HTMLElement.prototype.animate = function (
    this: HTMLElement,
    frames: Keyframe[],
  ) {
    animations.push({ key: this.dataset["key"] ?? "", frames });
    return { cancel() {}, onfinish: null } as unknown as Animation;
  } as HTMLElement["animate"];
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Board({ items }: { readonly items: readonly string[] }) {
  const container = useRef<HTMLDivElement>(null);
  useGlide(container, "[data-key]", (each) => each.dataset["key"], items);
  return (
    <div ref={container}>
      {items.map((key) => (
        <div key={key} data-key={key} />
      ))}
    </div>
  );
}

function place(items: readonly string[]): void {
  items.forEach((key, index) => layout.set(key, index * 20));
}

describe("useGlide", () => {
  it("draws the first layout as it is", () => {
    place(["a", "b"]);
    render(<Board items={["a", "b"]} />);
    expect(animations).toEqual([]);
  });

  it("starts what moved from where it was, and ends on its place", () => {
    place(["a", "b"]);
    const view = render(<Board items={["a", "b"]} />);
    place(["b", "a"]);
    view.rerender(<Board items={["b", "a"]} />);
    const a = animations.find((each) => each.key === "a")!;
    const b = animations.find((each) => each.key === "b")!;
    // a was at 0 and is laid out at 20: it starts 20px up.
    expect(a.frames).toEqual([
      { transform: "translate(0px, -20px)" },
      { transform: "none" },
    ]);
    expect(b.frames[0]).toEqual({ transform: "translate(0px, 20px)" });
    expect(b.frames.at(-1)).toEqual({ transform: "none" });
  });

  it("raises what is new, and leaves what did not move alone", () => {
    place(["a"]);
    const view = render(<Board items={["a"]} />);
    place(["a", "c"]);
    view.rerender(<Board items={["a", "c"]} />);
    expect(animations.map((each) => each.key)).toEqual(["c"]);
    expect(animations[0]!.frames.at(-1)).toEqual({
      opacity: 1,
      transform: "none",
    });
  });

  it("moves nothing under Reduce Motion", () => {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
    })) as unknown as typeof window.matchMedia;
    place(["a", "b"]);
    const view = render(<Board items={["a", "b"]} />);
    place(["b", "a", "c"]);
    view.rerender(<Board items={["b", "a", "c"]} />);
    expect(animations).toEqual([]);
  });
});
