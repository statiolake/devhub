// Injected into a page by run.mjs (Runtime.evaluate), as one expression that
// is called with the scenario's watch list. Every animation frame it reads the
// watched elements' geometry and keeps a frame whenever any of it changed.
//
// What is read, per element (each one keyed by its role and its index among
// the role's elements, in document order, so a remount at the same place is
// the same element):
//   r       the bounding box, transforms included, to 0.5 px
//   clip    computed clip-path (and overflow clip for the element itself)
//   radius  computed border-radius
//   op      opacity, the product along the ancestors, to 0.01
//   hash    for a canvas, a digest of its pixels (sampled), when asked
//   bg, fg  computed background and text colour, when asked (a theme switch)
// An element that is not displayed, is invisible, has no area or has no
// opacity is absent from the frame: that is how "not on screen" reads.
//
// An element is "moving" (m) while a declared animation runs on it or on an
// ancestor: a finite Web Animation — the transitions and glides of
// docs/motion.md; an infinite one (a caret's blink, a spinner) is a loop, not
// a motion. A whole frame is in motion while one of `motionMarkers` exists:
// the pane motion of docs/pane-motion.md, which windowMotion.ts runs in
// requestAnimationFrame with pictures of its own.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
(function install(watch) {
  const prior = window.__stability;
  if (prior) prior.stop();
  const roles = watch.roles;
  const markers = watch.motionMarkers ?? [];
  const frames = [];
  const counter = { frames: 0 };
  let last = "";
  let running = true;
  const half = (v) => Math.round(v * 2) / 2;

  function opacityOf(el) {
    let op = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const style = getComputedStyle(e);
      if (style.display === "none") return 0;
      op *= Number(style.opacity);
      if (op === 0) return 0;
    }
    return Math.round(op * 100) / 100;
  }

  function digest(canvas) {
    try {
      const ctx = canvas.getContext("2d", { willReadFrequently: false });
      if (!ctx || canvas.width === 0 || canvas.height === 0) return "empty";
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // FNV-1a over every 7th pixel: cheap enough per frame at 6x, and any
      // drawn glyph or band touches a sampled pixel.
      let h = 0x811c9dc5;
      for (let i = 0; i < data.length; i += 28) {
        h ^= data[i] | (data[i + 1] << 8) | (data[i + 2] << 16);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(16);
    } catch {
      return "unreadable";
    }
  }

  // The targets of the declared animations running now.
  function animated() {
    const targets = new Set();
    for (const a of document.getAnimations()) {
      if (a.playState !== "running") continue;
      const timing = a.effect?.getComputedTiming?.();
      if (timing && timing.iterations === Infinity) continue;
      if (a.effect?.target) targets.add(a.effect.target);
    }
    return targets;
  }

  function moving(el, targets) {
    if (targets.size === 0) return false;
    for (let e = el; e; e = e.parentElement) if (targets.has(e)) return true;
    return false;
  }

  function markerPresent() {
    for (const selector of markers) {
      for (const el of document.querySelectorAll(selector)) {
        if (
          el.getClientRects().length > 0 &&
          getComputedStyle(el).display !== "none"
        )
          return true;
      }
    }
    return false;
  }

  function read(targets) {
    const els = {};
    for (const role of roles) {
      const list = [...document.querySelectorAll(role.selector)].slice(
        0,
        role.max ?? 40,
      );
      let index = 0;
      for (const el of list) {
        const key = `${role.name}#${index++}`;
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden") continue;
        const op = opacityOf(el);
        if (op === 0) continue;
        const entry = {
          r: [half(b.x), half(b.y), half(b.width), half(b.height)],
        };
        if (role.clip !== false)
          entry.clip = style.clipPath === "none" ? "" : style.clipPath;
        if (role.radius !== false)
          entry.radius = style.borderRadius === "0px" ? "" : style.borderRadius;
        if (role.opacity !== false) entry.op = op;
        if (role.colors) {
          entry.bg = style.backgroundColor;
          entry.fg = style.color;
        }
        if (role.text) entry.text = (el.textContent ?? "").slice(0, 120);
        if (role.pixels && el instanceof HTMLCanvasElement)
          entry.hash = digest(el);
        if (moving(el, targets)) entry.m = 1;
        els[key] = entry;
      }
    }
    return els;
  }

  // A loop (a caret's blink, a spinner) held at its start while recording:
  // it is not a change the action made, and the picture check would see
  // every blink as one.
  const held = new Set();
  function holdLoops() {
    for (const a of document.getAnimations()) {
      if (held.has(a) || a.playState !== "running") continue;
      const timing = a.effect?.getComputedTiming?.();
      if (!timing || timing.iterations !== Infinity) continue;
      a.pause();
      a.currentTime = 0;
      held.add(a);
    }
  }
  function release() {
    for (const a of held) {
      try {
        a.play();
      } catch {
        // gone with its element
      }
    }
    held.clear();
  }

  function tick() {
    if (!running) return;
    counter.frames++;
    if (watch.holdLoops !== false) holdLoops();
    const targets = animated();
    const els = read(targets);
    const motion = markerPresent();
    // Where every declared animation is, watched or not (a cursor's glide):
    // the picture check leaves those regions out while they move.
    const anim = [...targets].map((el) => {
      const b = el.getBoundingClientRect();
      return [half(b.x), half(b.y), half(b.width), half(b.height)];
    });
    const text = JSON.stringify(els) + motion + JSON.stringify(anim);
    if (text !== last) {
      last = text;
      frames.push({
        t: performance.timeOrigin + performance.now(),
        n: counter.frames,
        motion,
        anim,
        els,
      });
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.__stability = {
    lastT() {
      return frames.length ? frames[frames.length - 1].t : 0;
    },
    stop() {
      running = false;
      release();
    },
    take() {
      running = false;
      release();
      return { frames, rafs: counter.frames };
    },
  };
  return "recording";
});
