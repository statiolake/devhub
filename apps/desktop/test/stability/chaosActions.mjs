// The chaos driver's actions (chaos.mjs): what a heavy user does to DevHub,
// each through the input a person's hand gives (CDP keys and the wheel on
// the page, real X clicks and window sizes through xdotool, the `devhub`
// command), at their speed or faster.
//
// An action is { name, hand, weight, gen(rng, tag) → params, run(ctx,
// params) }; hand is what of a person it takes (keys, pointer, both, none),
// so only actions a person could do at once overlap.
// gen draws everything random up front, so a run is its list of
// { name, params }: replayed, it does the same things in the same order
// (chaos.mjs --replay), and the minimiser shrinks that list. run ends where
// the editor can be worked on again (alpha's devhub-nvim window on screen)
// unless its params say otherwise; it never waits for DevHub beyond what a
// person would (a key after a key, 33 ms for a held key).
//
// Neovim is asked through ctx.rpc and ctx.luaAsync, never synchronously: a
// request Neovim queues (it runs none but "fast" ones while a key sequence
// is pending, a `<C-w>` waiting for its second key) must not stop the keys
// of an action alongside that would end the wait.
//
// `expect` (returned by run) is what the action left for the quiet point to
// check against Neovim: a line typed must be in the buffer exactly.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A seeded generator (mulberry32): the same seed, the same run. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

const WORDS = [
  "value",
  "line",
  "export",
  "const",
  "shifted",
  "doubled",
  "input",
  "number",
  "return",
  "valu",
];

/** Keys to the editor's page, `gap` ms apart. */
async function keys(ctx, list, gap = 0) {
  // A person types once the editor has the keyboard; that it gets it, and
  // soon, is checked (ready): keys sent to a page that has not would go
  // where no person's could.
  await ctx.ready();
  for (const key of list) {
    await ctx.press("pane", key);
    if (gap > 0) await sleep(gap);
  }
}

/** Back in Normal mode, nothing open over the editor (a person's Escapes). */
async function escapes(ctx) {
  await keys(ctx, ["Escape", "Escape"], 30);
}

async function onAlpha(ctx) {
  // Real clicks: main sees the view under them take the keyboard, as a
  // person's (a CDP click into a page never shows it).
  await ctx.realClick("sidebar", ".sidebar-row", "alpha");
}

export const ACTIONS = [
  {
    name: "wheel",
    hand: "pointer",
    weight: 10,
    gen: (r) => ({
      notches: r.int(3, 30),
      delta: r.pick([120, -120, 40, -40, 360, -360]),
      gap: r.pick([0, 8, 16, 33, 80]),
    }),
    run: (ctx, p) =>
      ctx.wheel("pane", ".nvim-editor", p.notches, p.delta, p.gap),
  },
  {
    name: "key-scroll",
    hand: "keys",
    weight: 10,
    gen: (r) => ({
      keys: Array.from({ length: r.int(2, 20) }, () =>
        r.pick([
          "C-d",
          "C-u",
          "C-d",
          "C-u",
          "C-f",
          // Not <C-b>: tmux's prefix in this profile, taken from Neovim
          // for tmux as from a person (the key after it is tmux's).
          "C-y",
          "G",
          "g g",
          "n",
          "N",
          "z z",
        ]),
      ),
      gap: r.pick([0, 16, 33, 60]),
    }),
    run: async (ctx, p) => {
      // A search first, so n and N have somewhere to go.
      await ctx.rpc("execute('let @/ = \"value(1\"')");
      for (const k of p.keys) {
        await keys(ctx, k.split(" "));
        if (p.gap) await sleep(p.gap);
      }
    },
  },
  {
    name: "type",
    hand: "keys",
    weight: 8,
    gen: (r, tag) => {
      const words = Array.from({ length: r.int(2, 12) }, () => r.pick(WORDS));
      return {
        text: `${tag} ${words.join(" ")}`,
        open: r.pick(["o", "O"]),
        gap: r.pick([0, 0, 10, 30]),
      };
    },
    run: async (ctx, p) => {
      await escapes(ctx);
      // Into a buffer that takes text (not the tree, not a document): what
      // a person does before typing; the driver asks, it is not checked.
      const editable = async () =>
        (await ctx.rpc("&modifiable && &buftype ==# ''")).trim() === "1";
      if (!(await editable())) await ctx.rpc("execute('wincmd p')");
      if (!(await editable())) return {};
      await keys(ctx, [p.open]);
      for (const ch of p.text) {
        await ctx.press("pane", ch === " " ? "Space" : ch);
        if (p.gap) await sleep(p.gap);
      }
      // blink's menu may be open: Escape closes it and leaves Insert (not
      // <C-e>, which with no menu inserts the character below the cursor).
      await keys(ctx, ["Escape"]);
      return { typed: p.text };
    },
  },
  {
    name: "cmdline",
    hand: "keys",
    weight: 6,
    gen: (r) => ({
      text: r.pick(["ec", "echo 1", "set nu", "h", "e src/"]),
      end: r.pick(["Escape", "Tab Escape", "Enter"]),
    }),
    run: async (ctx, p) => {
      await escapes(ctx);
      await keys(ctx, [":"]);
      await ctx.type("pane", p.text);
      const end = p.end === "Enter" && p.text !== "echo 1" ? "Escape" : p.end;
      await keys(ctx, end.split(" "), 20);
      if (end === "Enter") await keys(ctx, ["Escape"]);
    },
  },
  {
    name: "picker",
    hand: "keys",
    weight: 6,
    gen: (r) => ({
      query: r.pick(["core", "long", "ts", "md", "zz"]).slice(0, r.int(1, 4)),
      live: r.chance(0.4),
      preview: r.int(0, 3),
      down: r.int(0, 6),
      gap: r.pick([0, 20, 60]),
    }),
    run: async (ctx, p) => {
      await escapes(ctx);
      await keys(ctx, ["C-p"]);
      await sleep(p.gap);
      await ctx.type("pane", p.query);
      if (p.live) await keys(ctx, ["C-g", "C-g"], p.gap);
      for (let i = 0; i < p.preview; i++) await keys(ctx, ["F4"], p.gap);
      for (let i = 0; i < p.down; i++) await keys(ctx, ["C-n"], p.gap);
      await keys(ctx, ["Escape", "Escape"], 20);
    },
  },
  {
    name: "tree",
    hand: "both",
    weight: 6,
    gen: (r) => ({
      moves: Array.from({ length: r.int(2, 14) }, () =>
        r.pick(["j", "k", "Enter", "C-d", "C-u", "G", "g g"]),
      ),
      menu: r.chance(0.3),
      click: r.chance(0.4),
      close: r.chance(0.7),
      gap: r.pick([0, 20, 50]),
    }),
    run: async (ctx, p) => {
      await escapes(ctx);
      const open = await ctx.rpc(
        "luaeval('#vim.tbl_filter(function(w) return vim.bo[vim.api.nvim_win_get_buf(w)].filetype == \"NvimTree\" end, vim.api.nvim_list_wins())')",
      );
      if (open.trim() === "0") await keys(ctx, ["F2"]);
      else await ctx.rpc("execute('NvimTreeFocus')");
      for (const m of p.moves) {
        // Enter on the root's line goes up a folder: out of the profile,
        // into the machine's /tmp. A row under it instead.
        if (m === "Enter" && (await ctx.rpc("line('.')")).trim() === "1")
          await keys(ctx, ["j"]);
        await keys(ctx, m.split(" "));
        if (p.gap) await sleep(p.gap);
      }
      if (p.click) {
        const row = await ctx.centre("pane", ".nvim-view-item", undefined);
        if (row) await ctx.clickAt("pane", row[0], row[1]);
      }
      if (p.menu) {
        const row = await ctx.centre("pane", ".nvim-view-item", undefined);
        if (row) {
          const client = await ctx.page("pane");
          for (const type of ["mousePressed", "mouseReleased"])
            await client.send("Input.dispatchMouseEvent", {
              type,
              x: row[0],
              y: row[1],
              button: "right",
              clickCount: 1,
            });
          await sleep(150);
          // A native menu: Escape through X closes it.
          ctx.xKey("Escape");
        }
      }
      if (p.close) await keys(ctx, ["F2"]);
      await ctx.rpc("execute('wincmd p')");
    },
  },
  {
    name: "windows",
    hand: "keys",
    weight: 6,
    gen: (r) => ({
      keys: Array.from({ length: r.int(1, 8) }, () =>
        r.pick([
          "C-w v",
          "C-w s",
          "C-w c",
          "C-w >",
          "C-w <",
          "C-w +",
          "C-w -",
          "C-w =",
          "C-w w",
          "C-w o",
        ]),
      ),
      gap: r.pick([0, 33, 120]),
    }),
    run: async (ctx, p) => {
      await escapes(ctx);
      for (const k of p.keys) {
        await keys(ctx, k.split(" "));
        if (p.gap) await sleep(p.gap);
      }
    },
  },
  {
    name: "live-resize",
    hand: "none",
    weight: 3,
    gen: (r) => ({
      steps: [
        ...Array.from({ length: r.int(1, 5) }, () => [
          -r.int(0, 300),
          -r.int(0, 200),
        ]),
        [0, 0],
      ],
    }),
    run: (ctx, p) => ctx.resizeWindow(p.steps),
  },
  {
    name: "workspace",
    hand: "both",
    weight: 4,
    gen: (r) => ({ times: r.int(1, 4), gap: r.pick([0, 50, 300]) }),
    run: async (ctx, p) => {
      for (let i = 0; i < p.times; i++) {
        await ctx.realClick("sidebar", ".sidebar-row", "beta");
        await sleep(p.gap);
        await onAlpha(ctx);
        await sleep(p.gap);
      }
    },
  },
  {
    name: "sidebar-collapse",
    hand: "both",
    weight: 3,
    gen: (r) => ({ gap: r.pick([0, 100, 400]) }),
    run: async (ctx, p) => {
      const toggle = '[aria-label="Toggle Sidebar"], [title="Toggle Sidebar"]';
      await ctx.realClick("index", toggle);
      await sleep(p.gap);
      await ctx.realClick("index", toggle);
    },
  },
  {
    name: "orchestrator",
    hand: "both",
    weight: 3,
    gen: (r) => ({ tabs: r.int(0, 3), gap: r.pick([50, 200, 500]) }),
    run: async (ctx, p) => {
      await ctx.realClick("sidebar", ".sidebar-row", "Orchestrator");
      await sleep(p.gap);
      for (let i = 0; i < p.tabs; i++) {
        const tab = i % 2 ? "ボード" : "ターミナル";
        await ctx.realClick("agents", "[role=tab]", tab).catch(() => undefined);
        await sleep(p.gap);
      }
      await ctx.realClick("agents", "[role=tab]", "ボード").catch(() => {});
      await sleep(100);
      await ctx.realClick("sidebar", ".sidebar-row", "alpha");
    },
  },
  {
    name: "devhub-open",
    hand: "both",
    weight: 4,
    gen: (r) => ({
      file: r.pick([
        "src/core/core0.ts",
        "src/core/core1.ts",
        "src/long.ts",
        "README.md",
      ]),
      quit: r.chance(0.15),
    }),
    run: async (ctx, p) => {
      if (p.quit) {
        await escapes(ctx);
        await keys(ctx, [":"]);
        await ctx.type("pane", "qa!");
        await keys(ctx, ["Enter"]);
        await sleep(300);
      }
      ctx.cli([p.file]);
      if (p.quit) await ctx.waitNeovim();
    },
  },
  {
    name: "theme",
    hand: "none",
    weight: 2,
    gen: (r) => ({ there: r.pick(["light", "dark"]), back: r.chance(0.7) }),
    run: async (ctx, p) => {
      // As a person sees it: the switch, landed, and maybe back.
      const to = async (mode) => {
        if (ctx.appearance === mode) return;
        await ctx.evalIn(
          "pane",
          "window.__chaosPalette = document.documentElement.style.cssText",
        );
        ctx.setAppearance(mode);
        ctx.appearance = mode;
        await ctx.waitIn(
          "pane",
          "document.documentElement.style.cssText !== window.__chaosPalette",
          20_000,
        );
      };
      await to(p.there);
      if (p.back) await to("dark");
    },
  },
  {
    name: "alt-pointer",
    hand: "both",
    weight: 3,
    gen: (r) => ({
      moves: r.int(1, 6),
      click: r.chance(0.5),
    }),
    run: async (ctx, p) => {
      await escapes(ctx);
      const client = await ctx.page("pane");
      const box = await ctx.centre("pane", ".nvim-editor", undefined);
      if (!box) return;
      await client.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Alt",
        code: "AltLeft",
        windowsVirtualKeyCode: 18,
        modifiers: 1,
      });
      for (let i = 0; i < p.moves; i++)
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: box[0] - 200 + i * 37,
          y: box[1] - 100 + i * 15,
          modifiers: 1,
        });
      if (p.click) {
        for (const type of ["mousePressed", "mouseReleased"])
          await client.send("Input.dispatchMouseEvent", {
            type,
            x: box[0] - 200,
            y: box[1] - 100,
            modifiers: 1,
            button: "left",
            buttons: type === "mousePressed" ? 1 : 0,
            clickCount: 1,
          });
      }
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Alt",
        code: "AltLeft",
        windowsVirtualKeyCode: 18,
      });
      if (p.click) await keys(ctx, ["C-o"]);
    },
  },
  {
    name: "document",
    hand: "none",
    weight: 3,
    gen: (r) => ({
      edits: r.int(1, 6),
      scrolls: Array.from({ length: r.int(1, 5) }, () => r.int(1, 120)),
      close: r.chance(0.8),
    }),
    run: async (ctx, p) => {
      await escapes(ctx);
      const text = (n) =>
        `# Notes ${String(n)}\\n\\n` +
        Array.from(
          { length: 80 },
          (_, i) =>
            `## Part ${String(i)}\\n\\nSome *text* ${String(n)}, \`code\`.\\n`,
        ).join("\\n");
      await ctx.luaAsync(`local gui = require('devhub_gui')
_G.__chaos_doc = _G.__chaos_doc and _G.__chaos_doc:is_open() and _G.__chaos_doc
  or gui.document { text = "${text(0)}", format = 'markdown', split = 'right', title = 'notes.md' }
return 1`);
      for (let i = 0; i < p.edits; i++) {
        await ctx.luaAsync(`_G.__chaos_doc:update("${text(i + 1)}") return 1`);
        await sleep(40);
        const line = p.scrolls[i % p.scrolls.length];
        await ctx.luaAsync(
          `_G.__chaos_doc:scroll_to(${String(line)}) return 1`,
        );
        await sleep(40);
      }
      if (p.close)
        await ctx.luaAsync(
          `_G.__chaos_doc:close() _G.__chaos_doc = nil return 1`,
        );
    },
  },
  {
    name: "terminal-stream",
    // It shows the shell's tmux window: the keys go there meanwhile.
    hand: "both",
    weight: 3,
    gen: (r) => ({
      lines: r.int(20, 300),
      scrolledBack: r.chance(0.7),
      wheel: r.int(0, 6),
    }),
    run: async (ctx, p) => {
      const target = `${ctx.alphaSession()}:0`;
      ctx.app.tmux("select-window", "-t", target);
      ctx.app.tmux("copy-mode", "-q", "-t", target);
      if (p.scrolledBack) {
        ctx.app.tmux("copy-mode", "-t", target);
        ctx.app.tmux("send-keys", "-t", target, "-X", "halfpage-up");
      }
      const writing = ctx.writeTty(target, p.lines);
      if (p.wheel)
        await ctx
          .wheel("pane", ".terminal-surface, .control-pane", p.wheel, -120, 30)
          .catch(() => {});
      await writing;
      ctx.app.tmux("copy-mode", "-q", "-t", target);
      ctx.app.tmux("select-window", "-t", `${ctx.alphaSession()}:1`);
    },
  },
  {
    name: "conversation",
    hand: "both",
    weight: 2,
    gen: (r, tag) => ({ text: `chaos ${tag}`, wheel: r.int(0, 8) }),
    run: async (ctx, p) => {
      await ctx.openFakeAgent();
      await ctx.focusSelector("conversations", ".conversation-composer-input");
      await ctx.type("conversations", p.text);
      await ctx.press("conversations", "D-Enter");
      for (let i = 0; i < p.wheel; i++)
        await ctx
          .wheel(
            "conversations",
            ".conversation-scroll",
            1,
            i % 2 ? 120 : -120,
            40,
          )
          .catch(() => {});
      await sleep(400);
      await onAlpha(ctx);
      return { said: p.text };
    },
  },
  {
    // tmux's prefix from inside Neovim (DevHub lends the terminal the keys,
    // and gives them back once the binding has run): display-panes, the
    // chooser, the key list, a zoom and back; then Escape.
    name: "tmux-prefix",
    hand: "keys",
    weight: 2,
    gen: (r) => ({ key: r.pick(["q", "w", "?", "z"]) }),
    run: async (ctx, p) => {
      await escapes(ctx);
      await keys(ctx, ["C-b", p.key], 80);
      await sleep(400);
      if (p.key === "z") {
        await ctx.press("pane", "C-b");
        await ctx.press("pane", "z");
      } else await ctx.press("pane", "Escape");
      await sleep(300);
    },
  },
  {
    // Pathological: 50 alternating actions in about a second.
    name: "storm",
    hand: "keys",
    weight: 3,
    gen: (r) => ({
      pair: r.pick([
        ["C-d", "C-u"],
        [":", "Escape"],
        ["C-p", "Escape"],
        ["F2", "F2"],
        ["C-w v", "C-w c"],
        ["i", "Escape"],
        ["g g", "G"],
      ]),
      count: 50,
      gap: r.pick([0, 10, 20]),
    }),
    run: async (ctx, p) => {
      for (let i = 0; i < p.count; i++) {
        await keys(ctx, p.pair[i % 2].split(" "));
        if (p.gap) await sleep(p.gap);
      }
      await escapes(ctx);
    },
  },
];

export const BY_NAME = new Map(ACTIONS.map((a) => [a.name, a]));

/** Whether two actions' hands can work at once. */
function free(a, b) {
  if (a === "none" || b === "none") return true;
  if (a === "both" || b === "both") return false;
  return a !== b;
}

/** The actions of a run of `count`, drawn from `seed`: bursts of 1-6, some overlapping. */
export function plan(seed, count, only) {
  const r = rng(seed);
  const pool = ACTIONS.filter((a) => !only || only.includes(a.name));
  const total = pool.reduce((sum, a) => sum + a.weight, 0);
  const draw = () => {
    let x = r.next() * total;
    for (const a of pool) {
      x -= a.weight;
      if (x < 0) return a;
    }
    return pool[pool.length - 1];
  };
  const out = [];
  let burst = 0;
  while (out.length < count) {
    const size = r.int(1, 6);
    for (let i = 0; i < size && out.length < count; i++) {
      const a = draw();
      out.push({
        name: a.name,
        params: a.gen(r, `s${String(seed)}a${String(out.length)}`),
        burst,
        // Run alongside the one before it, not after it: only with another
        // hand (one keyboard, one pointer; a window size, a theme, Lua, a
        // program's output need none), as a person can.
        overlap:
          i > 0 &&
          r.chance(0.25) &&
          free(BY_NAME.get(out[out.length - 1].name).hand, a.hand),
      });
    }
    burst += 1;
  }
  return out;
}
