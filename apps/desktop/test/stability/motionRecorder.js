// Injected into a page beside recorder.js for a step in motion (a scroll, a
// stream): every frame, *after* the frame's own work (a task queued from the
// frame's animation callback, so the sample is what that frame drew), what the
// page's Neovim editors drew and where the things anchored to their text are.
//
// Per Neovim window grid (from the editor itself, `window.neovimEditors`):
//   top     the screen y of its canvas (its scroll transform included)
//   painted the rows it has scrolled as painted (`GridPainter.paintedRows`)
//   origin  top - painted * cell height: where its text's first row would be
//           — a position of the *text*, so anything anchored to the text keeps
//           the same distance from it, however the window scrolls
//   off     the smooth scroll's display offset; ghost: the old view shown
//   port    the scroll port's box, and the boxes covering it (canvas, ghost)
// Per anchored element (`watch.anchors`, selectors): its box and the window
// grid it is over.
// Per scroller (`watch.scrollers`, selectors, a conversation's transcript):
// its scrollTop and its children's boxes in content coordinates.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
(function install(watch) {
  const prior = window.__motion;
  if (prior) prior.stop();
  const samples = [];
  let running = true;
  const half = (v) => Math.round(v * 2) / 2;
  const box = (el) => {
    const b = el.getBoundingClientRect();
    return [half(b.x), half(b.y), half(b.width), half(b.height)];
  };
  const shown = (el) =>
    el.isConnected &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).display !== "none" &&
    getComputedStyle(el).visibility !== "hidden";

  let editorAnchors = {};
  function editors() {
    editorAnchors = {};
    const out = [];
    for (const [key, ed] of Object.entries(window.neovimEditors ?? {})) {
      const painter = ed.painter;
      if (!painter || !ed.state) continue;
      const cell = painter.cell();
      const grids = [];
      const floats = {};
      for (const [grid, entry] of painter.canvases ?? []) {
        const w = ed.state.windows.get(grid);
        const place = w?.placement;
        if (!place || w.hidden || !shown(entry.canvas)) continue;
        if (place.kind === "float") {
          // A float at a buffer position (a hover): anchored to its text.
          if (painter.atBufpos?.(place.win))
            floats[`bufpos-float:${place.win}`] = box(entry.canvas);
          continue;
        }
        if (place.kind !== "window") continue;
        const b = box(entry.canvas);
        const painted = painter.paintedRows(grid);
        const view = painter.scrollView(grid);
        const port = entry.canvas.parentElement?.classList.contains(
          "nvim-scroll-port",
        )
          ? entry.canvas.parentElement
          : undefined;
        const ghost = port?.querySelector(".nvim-scroll-ghost");
        grids.push({
          grid,
          win: place.win,
          top: b[1],
          left: b[0],
          width: b[2],
          painted,
          origin: half(b[1] - painted * cell.height),
          topline: w.viewport?.topline,
          off: view ? half(view.off) : 0,
          ghost: ghost && shown(ghost) ? box(ghost) : undefined,
          canvas: b,
          port: port && shown(port) ? box(port) : undefined,
        });
      }
      Object.assign(editorAnchors, floats);
      out.push({ key, ch: cell.height, grids });
    }
    return out;
  }

  function anchors() {
    const out = {};
    for (const a of watch.anchors ?? []) {
      let i = 0;
      for (const el of document.querySelectorAll(a.selector)) {
        if (!shown(el)) continue;
        out[`${a.name}#${i++}`] = box(el);
      }
    }
    return out;
  }

  function scrollers() {
    const out = {};
    for (const s of watch.scrollers ?? []) {
      const el = document.querySelector(s.selector);
      if (!el || !shown(el)) continue;
      const base = el.getBoundingClientRect().top - el.scrollTop;
      const kids = [...el.querySelectorAll(s.items)].slice(0, 30).map((k) => {
        const b = k.getBoundingClientRect();
        return [half(b.top - base), half(b.height)];
      });
      out[s.name] = {
        scrollTop: half(el.scrollTop),
        box: box(el),
        items: kids,
      };
    }
    return out;
  }

  let last = "";
  function sample() {
    if (!running) return;
    const s = {
      editors: editors(),
      anchors: anchors(),
      scrollers: scrollers(),
    };
    const text = JSON.stringify(s);
    if (text !== last) {
      last = text;
      samples.push({ t: performance.timeOrigin + performance.now(), ...s });
    }
  }
  function tick() {
    if (!running) return;
    // After the frame's own callbacks (the editor's paint among them).
    setTimeout(sample, 0);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.__motion = {
    stop() {
      running = false;
    },
    take() {
      running = false;
      return samples;
    },
  };
  return "motion";
});
