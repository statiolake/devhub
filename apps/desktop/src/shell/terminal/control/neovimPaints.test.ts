import { describe, expect, it } from "vitest";
import { UnpaintedNeovims } from "./neovimPaints";

/** What happened, in order: "place" or the key of a Neovim drawn. */
const setup = () => {
  const log: string[] = [];
  const neovims = new UnpaintedNeovims();
  const handle = (key: string) => ({
    resumePaint: () => {
      log.push(key);
    },
  });
  const place = () => {
    log.push("place");
  };
  neovims.add("a", handle("a"));
  neovims.add("b", handle("b"));
  return { log, neovims, place };
};

describe("the Neovims a committed layout resized", () => {
  it("keep their old picture through the frame a motion starts in", () => {
    const { log, neovims, place } = setup();
    expect(neovims.painted(true, place)).toBe(false);
    expect(log).toEqual([]);
    expect(neovims.has("a")).toBe(true);
  });

  it("are placed at their new size, then draw, in the first frame that has moved", () => {
    const { log, neovims, place } = setup();
    neovims.painted(true, place);
    neovims.ticked(place);
    expect(log).toEqual(["place", "a", "b"]);
    expect(neovims.has("a")).toBe(false);
    // Later frames of the motion draw nothing again.
    neovims.ticked(place);
    expect(log).toEqual(["place", "a", "b"]);
  });

  it("draw in the frame that places the layout when nothing moves", () => {
    const { log, neovims, place } = setup();
    expect(neovims.painted(false, place)).toBe(true);
    expect(log).toEqual(["place", "a", "b"]);
  });

  it("draw where they are when the page goes away", () => {
    const { log, neovims } = setup();
    neovims.resume();
    expect(log).toEqual(["a", "b"]);
    expect(neovims.size).toBe(0);
  });
});
