import { describe, expect, it } from "vitest";
import { LabelAsks, type LabelBox } from "./labelAsks";

const titled = (grid: number, win: number): LabelBox => ({
  grid,
  win,
  float: true,
  lined: true,
  wantsLabels: true,
});
const text = (box: LabelBox) => `border of ${String(box.grid)}`;

describe("a float opening with text in its border", () => {
  it("is asked for once, and its paint waits for the answer", () => {
    const asks = new LabelAsks();
    expect(asks.need([titled(5, 1001)], text)).toEqual({
      ask: [{ win: 1001, text: "border of 5" }],
      waiting: true,
    });
    // Painted again before the answer: not asked twice, still waiting.
    expect(asks.need([titled(5, 1001)], text)).toEqual({
      ask: [],
      waiting: true,
    });
    asks.answer(1001);
    expect(asks.need([titled(5, 1001)], text).waiting).toBe(false);
  });

  it("opens with the others of its panel: the paint waits for every answer", () => {
    const asks = new LabelAsks();
    const panel = [titled(5, 1001), titled(6, 1002)];
    expect(asks.need(panel, text).ask).toHaveLength(2);
    asks.answer(1001);
    expect(asks.need(panel, text).waiting).toBe(true);
    asks.answer(1002);
    expect(asks.need(panel, text).waiting).toBe(false);
  });

  it("is asked again when its border text changes, drawn meanwhile", () => {
    const asks = new LabelAsks();
    asks.need([titled(5, 1001)], text);
    asks.answer(1001);
    const changed = asks.need([titled(5, 1001)], () => "a new title");
    expect(changed).toEqual({
      ask: [{ win: 1001, text: "a new title" }],
      waiting: false,
    });
  });

  it("waits for nothing when its border needs no labels", () => {
    const asks = new LabelAsks();
    const plain: LabelBox = { grid: 5, win: 1001, float: true, lined: true };
    const borderless: LabelBox = { grid: 6, win: 1002, float: true };
    expect(asks.need([plain, borderless], text)).toEqual({
      ask: [],
      waiting: false,
    });
  });

  it("is forgotten once closed, and a late answer does not bring it back", () => {
    const asks = new LabelAsks();
    asks.need([titled(5, 1001)], text);
    expect(asks.need([], text).waiting).toBe(false);
    asks.answer(1001);
    // Open again (the same handle never comes back, but the map stays empty).
    expect(asks.need([titled(5, 1001)], text).waiting).toBe(true);
  });
});
