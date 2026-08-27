# DevHub App Shell visual system

## Direction

DevHub is a quiet, dense, precise native macOS workbench for a developer
switching long-lived contexts rapidly. The primary verb is “locate active
context, then switch surface instantly.” The shell follows the viewer's
system appearance and its material hierarchy: a translucent navigation pane
running the full height of the window, and an opaque provider Surface beside
it under one compact titlebar band.

The signature is a stable `Workspace → Agent` sidebar coupled to one titlebar
Activity switcher and one uninterrupted Surface viewport. Activities are fixed
choices, not tabs. Selection never changes context implicitly. The Sidebar is
a peer of the content column rather than something the titlebar sits above, so
the window buttons rest on the navigation pane and the titlebar band belongs to
the content it labels.

Rejected defaults: dark developer dashboard → system-adaptive native workbench;
browser tabs → stable context tree plus Activities; decorative cards/status bar
→ quiet panes and surface-shift structure around one Surface.

## Foundations

- Palette: `--canvas`, `--chrome`, `--surface`, and all label/state roles use
  `light-dark()` with `AccentColor` where supported. The fallback stays quiet
  and system-adjacent: graphite text, green working, orange waiting, and red
  error. A selected source-list row takes a neutral fill and a semibold label;
  the accent shows on the row's glyph alone, never as the fill.
- Depth: one native system material layer sits behind transparent chrome. The
  Sidebar and titlebar may reveal it; the provider Surface stays opaque.
  Panes are separated by hairlines rather than shadows, with no CSS
  `backdrop-filter` or glass-on-glass stack. Reduced Transparency, and a window
  that could not take the material, paint solid chrome instead.
- Spacing: strict 4px base grid.
  Sidebar default is 248px and clamps to 200–400px. Source rows and native
  controls use a compact 28px rhythm; focus rings and semantic labels preserve
  keyboard and VoiceOver usability.
- Typography: system SF Pro Text/Display. Dense tool scale uses 11px metadata,
  13px rows/controls, 14px body, and 24–34px Surface headings. Weight and
  color establish hierarchy before size.
- Motion: short ease-out transitions for selection/press feedback; loading
  pulse and movement are removed under `prefers-reduced-motion`.

## Component patterns

- Titlebar Activities — native overlay, one compact 38px band spanning the
  content column only, exactly Editor/Agent/Terminal. The window buttons are
  centred on that band over the Sidebar's own matching strip, which reserves
  their leading inset. The band names nothing: the Sidebar's selected row is
  the only place the current context is stated. Disabled choices remain
  visible and
  use text plus an accessible reason.
- Sidebar row — 28px compact source-list rhythm, separate disclosure button,
  context row, and optional semantic action. Scratch is fixed first; Workspaces
  retain open order; Agents retain creation order. A workspace with zero agents
  has no disclosure placeholder or child row.
- Status mark — symbol + text/VoiceOver label + semantic color; status never
  controls ordering and never relies on color alone.
- Surface viewport — one `Surface` region with loading, empty, unavailable,
  error, closing, and closing-failed states. Provider content mounts into one
  opaque square-cornered viewport, which native Editor children — siblings of
  the shell WebView, not descendants — can match without any clipping.
- Sidebar resize — keyboard/pointer separator with `aria-valuemin=200`,
  `aria-valuemax=400`, and Rust-owned committed width. Preview width is the
  only local resize state.

## Accessibility and Mac contract

Use native buttons and links, visible focus rings, VoiceOver labels, keyboard
navigation, text zoom-safe wrapping, UTF-8-safe labels, and forced-colors
fallbacks. Validate reduced motion/transparency and increased contrast. Keep
standard macOS shortcuts native; do not implement Command+Q in JavaScript.
