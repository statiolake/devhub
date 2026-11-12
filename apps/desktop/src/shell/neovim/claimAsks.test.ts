import { describe, expect, it } from "vitest";
import { ClaimAsks, nextSettleSeq } from "./claimAsks";
import { claimFloats, type GridBox } from "./redraw";

const float = (grid: number, win: number): GridBox => ({
  grid,
  row: 1,
  col: 7,
  width: 54,
  height: 25,
  z: 50,
  float: true,
  win,
});

describe("floats not drawn until Lua has said whose they are", () => {
  it("never paints a framed view's float with the painter's own frame", () => {
    // As a picker opened in a throttled run: Neovim flushed the frame float
    // and the preview (the plugin forced a redraw), and only then did the
    // plugin make them a framed view; its placement came after, then the
    // `settled` the page asked for.
    const asks = new ClaimAsks();
    const root = float(5, 1006);
    const preview = { ...float(8, 1009), col: 37, width: 24 };
    const editor = float(2, 1000);
    const claims = new Map([
      [1006, 1006],
      [1007, 1006],
      [1008, 1006],
      [1009, 1006],
    ]);
    type Step =
      | { readonly flush: readonly GridBox[] }
      | { readonly placed: ReadonlyMap<number, number> }
      | { readonly settled: "last" };
    const steps: Step[] = [
      { flush: [{ ...editor, float: false }, root] },
      { flush: [{ ...editor, float: false }, root, preview] },
      { placed: claims },
      { settled: "last" },
    ];
    let shown: readonly GridBox[] = [];
    let claimed: ReadonlyMap<number, number> = new Map();
    let seq = 0;
    const painted: (readonly GridBox[])[] = [];
    const paint = () => {
      const laid = claimFloats(shown, claimed);
      const { ask, waiting } = asks.need(laid);
      if (ask.length > 0) {
        seq = nextSettleSeq();
        asks.asking(ask, seq);
      }
      if (!waiting) painted.push(laid);
    };
    for (const step of steps) {
      if ("flush" in step) shown = step.flush;
      else if ("placed" in step) claimed = step.placed;
      else asks.settle(seq);
      paint();
    }
    // Nothing of the picker was drawn before its claim was known...
    expect(painted.length).toBeGreaterThan(0);
    for (const laid of painted) {
      for (const box of laid) {
        if (box.win === undefined || !claims.has(box.win)) continue;
        // ...and once drawn, its floats are bare: no frame of the painter's.
        expect(box.bare).toBe(true);
        expect(box.framedBy).toBe(1006);
      }
    }
    expect(painted[0]?.some((b) => b.win === 1006)).toBe(true);
  });

  it("waits for a new float until its ask is settled, then draws it", () => {
    const asks = new ClaimAsks();
    const hover = float(9, 1020);
    const first = asks.need([hover]);
    expect(first).toEqual({ ask: [1020], waiting: true });
    const seq = nextSettleSeq();
    asks.asking(first.ask, seq);
    // Asked once: still waiting, not asked again.
    expect(asks.need([hover])).toEqual({ ask: [], waiting: true });
    // An earlier settle does not release it.
    expect(asks.settle(seq - 1)).toBe(false);
    expect(asks.need([hover]).waiting).toBe(true);
    expect(asks.settle(seq)).toBe(true);
    // No page claims it: the painter draws it, framed, from now on.
    expect(asks.need([hover])).toEqual({ ask: [], waiting: false });
  });

  it("asks again for a float that opens while an ask is out", () => {
    const asks = new ClaimAsks();
    const a = float(9, 1020);
    const b = float(10, 1021);
    const s1 = nextSettleSeq();
    asks.asking(asks.need([a]).ask, s1);
    const next = asks.need([a, b]);
    expect(next).toEqual({ ask: [1021], waiting: true });
    const s2 = nextSettleSeq();
    asks.asking(next.ask, s2);
    asks.settle(s1);
    // The first is settled, the second still waits on its own ask.
    expect(asks.need([a, b]).waiting).toBe(true);
    asks.settle(s2);
    expect(asks.need([a, b]).waiting).toBe(false);
  });

  it("does not wait for a float a page already claims, nor for windows", () => {
    const asks = new ClaimAsks();
    const claimed = { ...float(5, 1006), bare: true };
    const window = { ...float(2, 1000), float: false };
    expect(asks.need([claimed, window]).waiting).toBe(false);
  });

  it("forgets a float that closed", () => {
    const asks = new ClaimAsks();
    const a = float(9, 1020);
    asks.asking(asks.need([a]).ask, nextSettleSeq());
    expect(asks.need([]).waiting).toBe(false);
    // Opened again (a new float on the same window id): asked again.
    expect(asks.need([a]).ask).toEqual([1020]);
  });
});
