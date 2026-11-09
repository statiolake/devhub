/**
 * A GUI window's page (`gui.webview`'s `html`) and the keyboard between it and
 * Neovim.
 *
 * Neovim is the modal engine. With `keyboard = "neovim"` (an html page's
 * default) the keys are Neovim's while the window is current and no field
 * in it has them, as in normal mode: the page tells Lua its focusable
 * elements, Lua makes them the buffer's lines, and the cursor line is the
 * focused one — `gui.view`'s model, so `j`/`k`, counts, `/`, `:`, `<C-w>`
 * and the person's maps are Neovim's own, and the page only rings the
 * element Lua names. A field takes the keys in insert mode; `<Esc>`,
 * `<C-[>` and `<C-c>` in it are Neovim's `<Esc>`. With `"content"` the keys
 * are the page's and `<C-w>` gives them back (`docs/neovim-editor.md`, GUI
 * windows).
 *
 * The bridge is `postMessage`, both ways, since the frame is sandboxed:
 *
 * - page → DevHub: `devhubSend` (the page's `devhub.send`), `devhubItems`
 *   (its focusable elements, `{ label, editable }[]`, again whenever they
 *   change), `devhubFocus` (a pointer went down: on which element, if any),
 *   `devhubFocused` (the page moved its focus itself, `<Tab>` in a field),
 *   `devhubDeclare` (the keys of `devhub.keys`), `devhubKey` (a key that is
 *   Neovim's: `<Esc>` out of a field, `<C-w>`), `devhubStray` (a key the
 *   frame got while no field had it, which is Neovim's too).
 * - DevHub → page: `devhubGui` (Lua's `webview:send`), `devhubControl` (Lua's
 *   word on the focus: a `GuiControl`), `devhubCurrent` (the window is
 *   Neovim's current one: the ring shows).
 */

import { escapeInputText, keyToNeovim, type KeyInput } from "./keys";

export type GuiKeyboard = "neovim" | "content";

/** What Lua tells a page about its focus (the `gui_keys` event). */
export interface GuiControl {
  readonly id: number;
  readonly action: "focus" | "activate" | "edit" | "leave" | "key";
  /** The focused element, by its place in the page's list; -1 for none. */
  readonly index: number;
  /** The ring's colour: `Cursor`'s, as `gui.view` rings its focus. */
  readonly ring?: string;
  /** Where `edit` puts the caret. */
  readonly caret?: "keep" | "start" | "end";
  /** Which of the page's own keys was pressed (`key`). */
  readonly lhs?: string;
}

const ACTIONS = new Set(["focus", "activate", "edit", "leave", "key"]);
const CARETS = new Set(["keep", "start", "end"]);

/** A `gui_keys` payload, or undefined for one of the wrong shape. */
export function guiControlOf(payload: unknown): GuiControl | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const { id, action, index, ring, caret, lhs } = p;
  if (typeof id !== "number" || typeof action !== "string") return undefined;
  if (!ACTIONS.has(action)) return undefined;
  return {
    id,
    action: action as GuiControl["action"],
    index: typeof index === "number" ? index : -1,
    ...(typeof ring === "string" && /^#[0-9a-f]{6}$/i.test(ring)
      ? { ring }
      : {}),
    ...(typeof caret === "string" && CARETS.has(caret)
      ? { caret: caret as "keep" | "start" | "end" }
      : {}),
    ...(typeof lhs === "string" ? { lhs } : {}),
  };
}

/** The page's focusable elements, as Lua takes them. */
export function guiItemsOf(
  value: unknown,
): { readonly label: string; readonly editable: boolean }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const i = (item ?? {}) as Record<string, unknown>;
    return {
      label: typeof i["label"] === "string" ? i["label"] : "",
      editable: i["editable"] === true,
    };
  });
}

/**
 * A key the frame got while no field had it, as Neovim's input: the
 * keyboard is Neovim's there, so the key is not lost but sent on.
 */
export function strayKeys(
  value: unknown,
  optionIsMeta: boolean,
): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v["key"] !== "string" || typeof v["code"] !== "string")
    return undefined;
  const input: KeyInput = {
    key: v["key"],
    code: v["code"],
    ctrlKey: v["ctrlKey"] === true,
    altKey: v["altKey"] === true,
    metaKey: v["metaKey"] === true,
    shiftKey: v["shiftKey"] === true,
  };
  const named = keyToNeovim(input, optionIsMeta);
  if (named !== undefined) return named;
  // A printable key: what the editor would have had as text.
  return [...input.key].length === 1 ? escapeInputText(input.key) : undefined;
}

/**
 * Whether the keyboard goes into the frame of the current GUI window: a
 * `"content"` page's always; a `"neovim"` page's only while a field of it
 * has the keys (Lua said `edit`, and not yet `leave`).
 */
export function keysIntoFrame(
  keyboard: GuiKeyboard | undefined,
  editing: boolean,
): boolean {
  return keyboard === "content" || (keyboard === "neovim" && editing);
}

/**
 * The script every html page starts with: `window.devhub` (`send`,
 * `onMessage`, `keys`), the Mac's editing keys, and — for a `"neovim"`
 * page — its focusable elements told to Lua, the ring on the one Lua names,
 * and the keys only a field keeps.
 */
export function guiPrelude(keyboard: GuiKeyboard): string {
  return `(() => {
  const neovimKeys = ${keyboard === "neovim" ? "true" : "false"};
  const post = (message) => parent.postMessage(message, "*");
  const listeners = [];
  const pageKeys = new Map();
  let items = [];
  let focused = -1;
  window.devhub = {
    send: (message) => post({ devhubSend: message }),
    onMessage: (fn) => listeners.push(fn),
    // The page's own keys, mapped by Neovim on the window's buffer:
    // keys({ X: (element) => … }), the element the focused one.
    keys: (map) => {
      pageKeys.clear();
      for (const [lhs, fn] of Object.entries(map || {})) {
        if (typeof fn === "function") pageKeys.set(lhs, fn);
      }
      post({ devhubDeclare: [...pageKeys.keys()] });
    },
  };
  const FOCUSABLE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,'
    + '[contenteditable]:not([contenteditable=false]),[tabindex]:not([tabindex="-1"])';
  // Inputs that are pressed, not typed into.
  const PRESSED = new Set(["button", "submit", "reset", "checkbox", "radio", "file", "image", "color"]);
  const editable = (el) => !!el && (el.isContentEditable || el.tagName === "TEXTAREA"
    || el.tagName === "SELECT" || (el.tagName === "INPUT" && !PRESSED.has(el.type)));
  const usable = (el) => !el.disabled && !el.closest("[inert]")
    && (typeof el.checkVisibility === "function" ? el.checkVisibility() : true);
  const label = (el) => String(el.getAttribute("aria-label")
    || (el.labels && el.labels[0] && el.labels[0].textContent)
    || el.getAttribute("placeholder") || el.innerText || el.textContent
    || (PRESSED.has(el.type) ? el.value : "") || el.title || el.tagName.toLowerCase())
    .replace(/\\s+/g, " ").trim().slice(0, 200);
  const mark = (reveal) => {
    const el = items[focused];
    for (const other of document.querySelectorAll("[data-devhub-focus]")) {
      if (other !== el) other.removeAttribute("data-devhub-focus");
    }
    if (!el) return;
    const moved = !el.hasAttribute("data-devhub-focus");
    if (moved) el.setAttribute("data-devhub-focus", "");
    if ((moved || reveal) && el.scrollIntoView) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  let told = "";
  const scan = () => {
    items = [...document.querySelectorAll(FOCUSABLE)].filter(usable);
    const report = items.map((el) => ({ label: label(el), editable: editable(el) }));
    const text = JSON.stringify(report);
    if (text !== told) {
      told = text;
      post({ devhubItems: report });
    }
    mark(false);
  };
  let pending = 0;
  const rescan = () => {
    if (!pending) pending = setTimeout(() => { pending = 0; scan(); }, 30);
  };
  const control = (c) => {
    if (typeof c.index === "number") focused = c.index;
    const root = document.documentElement;
    if (typeof c.ring === "string" && root.style.getPropertyValue("--devhub-ring") !== c.ring) {
      root.style.setProperty("--devhub-ring", c.ring);
    }
    mark(c.action !== "focus");
    const el = items[focused];
    if (c.action === "activate" && el) {
      el.click();
    } else if (c.action === "edit" && el) {
      el.focus();
      if (c.caret === "start" || c.caret === "end") {
        if (el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(c.caret === "start");
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        } else {
          try {
            const at = c.caret === "start" ? 0 : String(el.value || "").length;
            el.setSelectionRange(at, at);
          } catch {}
        }
      }
    } else if (c.action === "leave") {
      const active = document.activeElement;
      if (active && active !== document.body && active.blur) active.blur();
    } else if (c.action === "key") {
      const fn = pageKeys.get(c.lhs);
      if (fn) fn(el);
    }
  };
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || typeof event.data !== "object") return;
    const data = event.data;
    if ("devhubGui" in data) for (const fn of listeners) fn(data.devhubGui);
    if (neovimKeys && data.devhubControl) control(data.devhubControl);
    if ("devhubCurrent" in data) document.documentElement.classList.toggle("devhub-current", data.devhubCurrent === true);
  });
  if (neovimKeys) {
    new MutationObserver(rescan).observe(document, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["disabled", "hidden", "inert", "tabindex", "contenteditable", "aria-label",
        "placeholder", "href", "type", "style", "class", "open"],
    });
    addEventListener("DOMContentLoaded", scan);
    addEventListener("load", scan);
    addEventListener("focusin", (event) => {
      const index = items.indexOf(event.target);
      if (index >= 0 && index !== focused) post({ devhubFocused: index });
    });
  }
  addEventListener("keydown", (event) => {
    const active = document.activeElement;
    const inField = editable(active);
    if (neovimKeys && inField) {
      // A field keeps every key but the ones that leave insert mode.
      const leave = event.key === "Escape" || (event.ctrlKey && !event.metaKey && !event.altKey
        && (event.key === "[" || event.key === "c" || event.key === "C"));
      if (leave && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        post({ devhubKey: "<Esc>" });
        return;
      }
    } else if (neovimKeys) {
      // No field has it: the key is Neovim's (the frame had the keyboard
      // a moment, after a click).
      if (event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      post({ devhubStray: { key: event.key, code: event.code, ctrlKey: event.ctrlKey,
        altKey: event.altKey, metaKey: event.metaKey, shiftKey: event.shiftKey } });
      return;
    } else if (event.ctrlKey && (event.key === "w" || event.key === "W")) {
      event.preventDefault();
      post({ devhubKey: "<C-w>" });
      return;
    }
    // The Mac's editing keys reach this page as keys (DevHub's menu leaves
    // them to the Neovim editor): answered here, on this page's selection.
    if (event.metaKey && !event.ctrlKey && !event.altKey) {
      const k = event.key.toLowerCase();
      const command = k === "c" ? "copy" : k === "x" ? "cut" : k === "a" ? "selectAll"
        : k === "z" ? (event.shiftKey ? "redo" : "undo") : undefined;
      if (command) {
        event.preventDefault();
        document.execCommand(command);
      }
    }
  }, true);
  addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target.closest(FOCUSABLE) : null;
    const index = target ? items.indexOf(target) : -1;
    post({ devhubFocus: true, index, editable: index >= 0 && editable(target) });
  }, true);
})();`;
}

/** The GUI window's page: the person's HTML, with `devhub` to talk to Lua. */
export function guiDocument(
  html: string,
  colors: { readonly fg: string; readonly bg: string },
  keyboard: GuiKeyboard,
): string {
  // The ring on the element the cursor line is, while the window is
  // current: the cursor's colour, as gui.view rings its focus.
  const style = `:root{--fg:${colors.fg};--bg:${colors.bg};color-scheme:dark light}html,body{color:var(--fg);background:var(--bg)}.devhub-current [data-devhub-focus]{outline:2px solid var(--devhub-ring,currentColor);outline-offset:-2px}`;
  return `<style>${style}</style><script>\n${guiPrelude(keyboard)}\n</script>${html}`;
}
