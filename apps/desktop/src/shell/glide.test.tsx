// @vitest-environment jsdom

/**
 * `useGlide`: what changes place starts where it was and ends where the
 * layout put it, and what is new rises in — measured, not assumed, so the
 * layout here is stated per element.
 */

import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GLIDE_MS, useGlide } from "./glide";

/** Where each item is laid out, by its key: what the test says the layout is. */
const layout = new Map<string, number>();
const animations: {
  key: string;
  frames: Keyframe[];
  options?: KeyframeAnimationOptions;
}[] = [];

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
    options?: KeyframeAnimationOptions,
  ) {
    animations.push({ key: this.dataset["key"] ?? "", frames, options });
    return {
      cancel() {},
      onfinish: null,
      currentTime: 0,
      addEventListener() {},
    } as unknown as Animation;
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

function Caused({
  items,
  cause,
}: {
  readonly items: readonly string[];
  readonly cause: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  useGlide(container, "[data-key]", (each) => each.dataset["key"], items, {
    cause,
    dimBeyond: 30,
  });
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

  it("lets what arrives in only once the rows making room for it have moved", () => {
    place(["a", "b"]);
    const view = render(<Board items={["a", "b"]} />);
    // c arrives above b, which glides down out of its slot: c is not drawn
    // (opacity 0, held through the delay) until b has gone.
    place(["a", "c", "b"]);
    view.rerender(<Board items={["a", "c", "b"]} />);
    const c = animations.find((each) => each.key === "c")!;
    expect(c.frames[0]).toMatchObject({ opacity: 0 });
    expect(c.options).toMatchObject({ delay: GLIDE_MS, fill: "backwards" });
    // Arriving where nothing moves, it rises in at once.
    animations.length = 0;
    place(["a", "c", "b", "d"]);
    view.rerender(<Board items={["a", "c", "b", "d"]} />);
    expect(animations.map((each) => each.key)).toEqual(["d"]);
    expect(animations[0]!.options).toMatchObject({ delay: 0 });
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

  it("moves things only when its cause changed, and measures every commit", () => {
    place(["a", "b", "c"]);
    const view = render(<Caused items={["a", "b", "c"]} cause="one" />);
    place(["c", "a", "b"]);
    view.rerender(<Caused items={["c", "a", "b"]} cause="one" />);
    expect(animations).toEqual([]);
    // The next glide starts from the commit before, not from the first.
    place(["a", "b", "c"]);
    view.rerender(<Caused items={["a", "b", "c"]} cause="two" />);
    const c = animations.find((each) => each.key === "c")!;
    // c went 40px down: past `dimBeyond`, so it dips on the way.
    expect(c.frames).toEqual([
      { transform: "translate(0px, -40px)", opacity: 1 },
      { opacity: 0.3, offset: 0.4 },
      { transform: "none", opacity: 1 },
    ]);
    // a moved one row: a plain glide.
    expect(animations.find((each) => each.key === "a")!.frames).toEqual([
      { transform: "translate(0px, 20px)" },
      { transform: "none" },
    ]);
  });

  it("moves nothing on the first cause after not being ready", () => {
    place(["a", "b"]);
    const view = render(<Caused items={["a", "b"]} cause="" />);
    place(["b", "a"]);
    view.rerender(<Caused items={["b", "a"]} cause="ready" />);
    expect(animations).toEqual([]);
  });
});
