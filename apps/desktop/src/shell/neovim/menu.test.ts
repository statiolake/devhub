import { describe, expect, it } from "vitest";
import {
  menuPoint,
  menuWire,
  parseMenuRequest,
  vimKeysToAccelerator,
} from "./menu";

describe("an item's keys", () => {
  it.each([
    ["a", "A"],
    ["R", "Shift+R"],
    ["<CR>", "Return"],
    ["<Tab>", "Tab"],
    ["<BS>", "Backspace"],
    ["<C-v>", "Ctrl+V"],
    ["<C-x>", "Ctrl+X"],
    ["<C-]>", "Ctrl+]"],
    ["<S-F10>", "Shift+F10"],
    ["<M-S-a>", "Alt+Shift+A"],
    ["-", "-"],
    ["W", "Shift+W"],
  ])("%s shows as the accelerator %s", (keys, accelerator) => {
    expect(vimKeysToAccelerator(keys)).toBe(accelerator);
  });

  it.each(["gy", "bt", "<2-LeftMouse>", "]c", "<Nope>"])(
    "%s is no accelerator",
    (keys) => {
      expect(vimKeysToAccelerator(keys)).toBeUndefined();
    },
  );
});

describe("the menu Lua asks for", () => {
  const payload = {
    id: 7,
    win: 1001,
    line: 3,
    view: 2,
    screen: { row: 4, col: 2 },
    items: [
      { id: "1", label: "Open", enabled: true, keys: "<CR>" },
      { id: "2", label: "Paste", enabled: false, keys: "p" },
      { separator: true },
      {
        label: "Copy",
        enabled: true,
        submenu: [
          { id: "3", label: "Copy Relative Path", enabled: true, keys: "Y" },
        ],
      },
      { id: "4", label: "Toggle Bookmark", enabled: true, keys: "m" },
      { id: "5", label: "Run", enabled: true, keys: "gy" },
      { label: "no id" },
      "junk",
    ],
  };

  it("is read, the wrong parts dropped", () => {
    const request = parseMenuRequest(payload);
    expect(request).toMatchObject({ id: 7, win: 1001, line: 3, view: 2 });
    expect(request?.at).toBeUndefined();
    expect(request?.items).toHaveLength(6);
    expect(parseMenuRequest({ items: [] })).toBeUndefined();
    expect(parseMenuRequest(null)).toBeUndefined();
  });

  it("goes to main with separators, greyed items, keys and a submenu", () => {
    const request = parseMenuRequest(payload);
    expect(menuWire(request?.items ?? [])).toEqual([
      { id: "1", label: "Open", accelerator: "Return" },
      { id: "2", label: "Paste", enabled: false, accelerator: "P" },
      {
        id: "submenu:3",
        label: "Copy",
        separatorBefore: true,
        submenu: [
          { id: "3", label: "Copy Relative Path", accelerator: "Shift+Y" },
        ],
      },
      { id: "4", label: "Toggle Bookmark", accelerator: "M" },
      // A sequence no menu can show: after the label, as VS Code does.
      { id: "5", label: "Run [gy]" },
    ]);
  });

  it("never starts with a separator", () => {
    expect(
      menuWire([
        { enabled: true, separator: true },
        { id: "1", label: "A", enabled: true },
      ]),
    ).toEqual([{ id: "1", label: "A" }]);
  });

  it("opens at the pointer, else under the row, else under the cell", () => {
    const row = { left: 100, bottom: 60 } as DOMRect;
    const screen = { left: 10, top: 20, cell: { width: 8, height: 16 } };
    const keyed = parseMenuRequest(payload);
    if (!keyed) throw new Error("no request");
    expect(
      menuPoint({ ...keyed, at: { x: 5, y: 6 } }, () => row, screen),
    ).toEqual({ x: 5, y: 6 });
    const asked: unknown[] = [];
    expect(
      menuPoint(
        keyed,
        (...args) => {
          asked.push(args);
          return row;
        },
        screen,
      ),
    ).toEqual({ x: 108, y: 60 });
    expect(asked).toEqual([[2, 1001, 3]]);
    expect(menuPoint(keyed, () => undefined, screen)).toEqual({
      x: 18,
      y: 84,
    });
  });
});
