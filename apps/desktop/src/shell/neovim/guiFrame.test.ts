// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  guiControlOf,
  guiDocument,
  guiItemsOf,
  guiPrelude,
  keysIntoFrame,
  strayKeys,
  type GuiKeyboard,
} from "./guiFrame";

/** A page in a frame: what it posts to DevHub, and a way to talk to it. */
function page(body: string, keyboard: GuiKeyboard = "neovim") {
  // Its own frame, so each page has its own globals.
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const window = frame.contentWindow as Window & typeof globalThis;
  const posted: Record<string, unknown>[] = [];
  const parent = {
    postMessage: (message: Record<string, unknown>) => posted.push(message),
  };
  Object.defineProperty(window, "parent", { value: parent });
  window.eval(guiPrelude(keyboard));
  window.document.body.innerHTML = body;
  window.dispatchEvent(new window.Event("load"));
  const tell = (data: unknown) => {
    const event = new window.MessageEvent("message", { data });
    Object.defineProperty(event, "source", { value: parent });
    window.dispatchEvent(event);
  };
  const key = (target: Element, init: KeyboardEventInit) => {
    const event = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  };
  const $ = (selector: string) => {
    const el = window.document.querySelector(selector);
    if (!el) throw new Error(selector);
    return el as HTMLElement;
  };
  return { window, posted, tell, key, $ };
}

const of = (posted: Record<string, unknown>[], name: string) =>
  posted.filter((m) => name in m).map((m) => m[name]);

describe("a GUI page's focusable elements", () => {
  it("are told to Lua in document order, a field marked editable", () => {
    const p = page(
      '<button>gg</button><input placeholder="Filter"><a href="#x">link</a>' +
        '<input type="checkbox" aria-label="done"><button disabled>off</button>' +
        "<textarea></textarea><div tabindex=0>box</div>",
    );
    expect(of(p.posted, "devhubItems").at(-1)).toEqual([
      { label: "gg", editable: false },
      { label: "Filter", editable: true },
      { label: "link", editable: false },
      { label: "done", editable: false },
      { label: "textarea", editable: true },
      { label: "box", editable: false },
    ]);
  });

  it("are told again when they change, and only then", async () => {
    const p = page("<button>a</button>");
    const before = of(p.posted, "devhubItems").length;
    p.$("button").after(p.window.document.createElement("button"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(of(p.posted, "devhubItems").length).toBe(before + 1);
    p.$("button").setAttribute("class", "same-items");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(of(p.posted, "devhubItems").length).toBe(before + 1);
  });
});

describe("Lua's word on the focus", () => {
  it("rings the element the cursor line names, and presses it", () => {
    const p = page("<button id=a>a</button><button id=b>b</button>");
    let pressed = "";
    p.$("#b").onclick = () => {
      pressed = "b";
    };
    p.tell({ devhubControl: { id: 1, action: "focus", index: 1 } });
    expect(p.$("#b").hasAttribute("data-devhub-focus")).toBe(true);
    expect(p.$("#a").hasAttribute("data-devhub-focus")).toBe(false);
    p.tell({ devhubControl: { id: 1, action: "activate", index: 1 } });
    expect(pressed).toBe("b");
  });

  it("enters a field with the caret where it was asked, and leaves it", () => {
    const p = page("<button>a</button><input id=f value=hello>");
    const field = p.$("#f") as HTMLInputElement;
    p.tell({
      devhubControl: { id: 1, action: "edit", index: 1, caret: "end" },
    });
    expect(p.window.document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(5);
    p.tell({
      devhubControl: { id: 1, action: "edit", index: 1, caret: "start" },
    });
    expect(field.selectionStart).toBe(0);
    p.tell({ devhubControl: { id: 1, action: "leave", index: 1 } });
    expect(p.window.document.activeElement).toBe(p.window.document.body);
  });

  it("runs the page's own keys on the focused element", () => {
    const p = page("<button id=a>a</button>");
    p.window.eval("devhub.keys({ X: (el) => { window.gotKey = el.id } })");
    expect(of(p.posted, "devhubDeclare")).toEqual([["X"]]);
    p.tell({ devhubControl: { id: 1, action: "key", index: 0, lhs: "X" } });
    const got = (p.window as unknown as { gotKey?: string }).gotKey;
    expect(got).toBe("a");
  });
});

describe("the keys in a GUI page", () => {
  it("in a field are the field's, but <Esc>, <C-[> and <C-c> are Neovim's <Esc>", () => {
    const p = page("<input id=f>");
    const field = p.$("#f");
    field.focus();
    expect(p.key(field, { key: "j", code: "KeyJ" }).defaultPrevented).toBe(
      false,
    );
    expect(of(p.posted, "devhubStray")).toEqual([]);
    for (const init of [
      { key: "Escape", code: "Escape" },
      { key: "[", code: "BracketLeft", ctrlKey: true },
      { key: "c", code: "KeyC", ctrlKey: true },
    ]) {
      expect(p.key(field, init).defaultPrevented).toBe(true);
    }
    expect(of(p.posted, "devhubKey")).toEqual(["<Esc>", "<Esc>", "<Esc>"]);
  });

  it("outside a field are Neovim's, sent on", () => {
    const p = page("<button id=b>b</button>");
    const button = p.$("#b");
    button.focus();
    expect(
      p.key(button, { key: ":", code: "Semicolon", shiftKey: true })
        .defaultPrevented,
    ).toBe(true);
    expect(of(p.posted, "devhubStray")).toEqual([
      {
        key: ":",
        code: "Semicolon",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: true,
      },
    ]);
  });

  it("of a content page are its own, but <C-w>", () => {
    const p = page("<button id=b>b</button>", "content");
    const button = p.$("#b");
    expect(p.key(button, { key: "j", code: "KeyJ" }).defaultPrevented).toBe(
      false,
    );
    expect(
      p.key(button, { key: "w", code: "KeyW", ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    expect(of(p.posted, "devhubKey")).toEqual(["<C-w>"]);
    expect(of(p.posted, "devhubItems")).toEqual([]);
  });

  it("a click says which element, and whether it is a field", () => {
    const p = page("<button id=b><span id=s>b</span></button><input id=f>");
    p.$("#s").dispatchEvent(
      new p.window.Event("pointerdown", { bubbles: true }),
    );
    p.$("#f").dispatchEvent(
      new p.window.Event("pointerdown", { bubbles: true }),
    );
    expect(p.posted.filter((m) => "devhubFocus" in m)).toEqual([
      { devhubFocus: true, index: 0, editable: false },
      { devhubFocus: true, index: 1, editable: true },
    ]);
  });
});

describe("the bridge's checks", () => {
  it("takes a control of the right shape only", () => {
    expect(
      guiControlOf({
        id: 2,
        action: "edit",
        index: 3,
        caret: "end",
        ring: "#aabbcc",
      }),
    ).toEqual({
      id: 2,
      action: "edit",
      index: 3,
      caret: "end",
      ring: "#aabbcc",
    });
    expect(guiControlOf({ id: 2, action: "explode" })).toBeUndefined();
    expect(guiControlOf({ action: "focus" })).toBeUndefined();
    expect(guiControlOf({ id: 1, action: "focus", ring: "red;x" })).toEqual({
      id: 1,
      action: "focus",
      index: -1,
    });
  });

  it("takes items as labels and editability", () => {
    expect(
      guiItemsOf([{ label: "a", editable: true }, null, { label: 3 }]),
    ).toEqual([
      { label: "a", editable: true },
      { label: "", editable: false },
      { label: "", editable: false },
    ]);
    expect(guiItemsOf("x")).toBeUndefined();
  });

  it("sends a stray key as the editor would", () => {
    const k = {
      code: "KeyJ",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
    };
    expect(strayKeys({ ...k, key: "j" }, false)).toBe("j");
    expect(
      strayKeys({ ...k, key: "<", code: "Comma", shiftKey: true }, false),
    ).toBe("<lt>");
    expect(
      strayKeys({ ...k, key: "w", code: "KeyW", ctrlKey: true }, false),
    ).toBe("<C-w>");
    expect(strayKeys({ ...k, key: "Escape", code: "Escape" }, false)).toBe(
      "<Esc>",
    );
    expect(
      strayKeys({ ...k, key: "Shift", code: "ShiftLeft" }, false),
    ).toBeUndefined();
  });

  it("puts the keys in the frame for a content page, or a field entered", () => {
    expect(keysIntoFrame("content", false)).toBe(true);
    expect(keysIntoFrame("neovim", false)).toBe(false);
    expect(keysIntoFrame("neovim", true)).toBe(true);
    expect(keysIntoFrame(undefined, true)).toBe(false);
  });

  it("starts the page with the prelude", () => {
    const doc = guiDocument("<p>hi</p>", { fg: "#fff", bg: "#000" }, "neovim");
    expect(doc.endsWith("<p>hi</p>")).toBe(true);
    expect(doc).toContain("--fg:#fff");
    expect(doc).toContain("const neovimKeys = true");
  });
});
