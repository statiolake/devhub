# DevHub App Shell visual system

## Direction

DevHub is a quiet, dense, precise native macOS workbench for a developer
switching long-lived contexts rapidly. The primary verb is “locate active
context, then switch surface instantly.” The shell follows the viewer's
system appearance and Tahoe's material hierarchy: a canvas around two calm
islands, a translucent navigation island, and an opaque provider Surface.

The signature is a stable `Workspace → Agent` sidebar coupled to one titlebar
Activity switcher and one uninterrupted Surface viewport. Activities are fixed
choices, not tabs. Selection never changes context implicitly. The Sidebar and
Surface are sibling islands with one deliberate 8px breathing space between
them; the native Editor child is clipped to the same Surface radius.

Rejected defaults: dark developer dashboard → system-adaptive native workbench;
browser tabs → stable context tree plus Activities; decorative cards/status bar
→ quiet islands and surface-shift structure around one Surface.

## Foundations

- Palette: `--canvas`, `--chrome`, `--surface`, and all label/state roles use
  `light-dark()` with `AccentColor` where supported. The fallback stays quiet
  and system-adjacent: graphite text, system accent selection, green working,
  orange waiting, and red error.
- Depth: one native system material layer sits behind transparent chrome. The
  Sidebar island may reveal it; the workbench canvas and provider Surface stay
  opaque. Islands use a low-opacity ring and one subtle shadow, with no CSS
  `backdrop-filter` or glass-on-glass stack. Reduced Transparency paints solid
  islands.
- Spacing: strict 4px base grid. The workbench uses an 8px inset and gap.
  Sidebar default is 248px and clamps to 200–400px. Source rows and native
  controls use a compact 28px rhythm; focus rings and semantic labels preserve
  keyboard and VoiceOver usability.
- Typography: system SF Pro Text/Display. Dense tool scale uses 11px metadata,
  13px rows/controls, 14px body, and 24–34px Surface headings. Weight and
  color establish hierarchy before size.
- Motion: short ease-out transitions for selection/press feedback; loading
  pulse and movement are removed under `prefers-reduced-motion`.

## Component patterns

- Titlebar Activities — native overlay, 52px height, traffic-light leading
  inset, exactly Editor/Agent/Terminal. Disabled choices remain visible and
  use text plus an accessible reason.
- Sidebar row — 28px compact source-list rhythm, separate disclosure button,
  context row, and optional semantic action. Scratch is fixed first; Workspaces
  retain open order; Agents retain creation order. A workspace with zero agents
  has no disclosure placeholder or child row.
- Status mark — symbol + text/VoiceOver label + semantic color; status never
  controls ordering and never relies on color alone.
- Surface viewport — one `Surface` region with loading, empty, unavailable,
  error, closing, and closing-failed states. Provider content mounts into one
  opaque 12px-radius content island; native Editor children receive the same
  CALayer mask because they are siblings of the shell WebView.
- Sidebar resize — keyboard/pointer separator with `aria-valuemin=200`,
  `aria-valuemax=400`, and Rust-owned committed width. Preview width is the
  only local resize state.

## Accessibility and Mac contract

Use native buttons and links, visible focus rings, VoiceOver labels, keyboard
navigation, text zoom-safe wrapping, UTF-8-safe labels, and forced-colors
fallbacks. Validate reduced motion/transparency and increased contrast. Keep
standard macOS shortcuts native; do not implement Command+Q in JavaScript.
