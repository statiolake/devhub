// Keys typed into a page through CDP's Input domain: the path a person's key
// takes in the renderer (keydown, keypress, keyup on the focused element), so
// the page's own key handling (shell/neovim/keys.ts) turns it into Neovim
// input exactly as it does a real key.
//
// `press(client, "C-p")`, `press(client, "Escape")`, `type(client, "abc")`.
// Modifiers: C- (Control), M- (Alt), S- (Shift), D- (Meta).

const NAMED = {
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  Down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  Right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};
for (let n = 1; n <= 12; n++)
  NAMED[`F${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };

function describeKey(name) {
  let rest = name;
  let modifiers = 0;
  for (;;) {
    const m = /^([CMSD])-(.+)$/.exec(rest);
    if (!m) break;
    modifiers |= { M: 1, C: 2, D: 4, S: 8 }[m[1]];
    rest = m[2];
  }
  if (NAMED[rest]) return { ...NAMED[rest], modifiers };
  const ch = rest;
  const upper = ch.toUpperCase();
  const letter = /^[a-z]$/i.test(ch);
  const digit = /^[0-9]$/.test(ch);
  const code = letter ? `Key${upper}` : digit ? `Digit${ch}` : undefined;
  const keyCode = letter || digit ? upper.charCodeAt(0) : ch.charCodeAt(0);
  // With Control or Alt, a letter types nothing: the page reads the key.
  const text = modifiers & 3 ? undefined : ch;
  return { key: ch, code, keyCode, text, modifiers };
}

export async function press(client, name) {
  const k = describeKey(name);
  const base = {
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
    modifiers: k.modifiers,
  };
  await client.send("Input.dispatchKeyEvent", {
    type: k.text ? "keyDown" : "rawKeyDown",
    ...base,
    ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
  });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** Each character of `text` as its own key. */
export async function type(client, text) {
  for (const ch of text) await press(client, ch === " " ? "Space" : ch);
}
