# DevHub App Shell visual system

## Direction

DevHub is a quiet, dense, precise native macOS workbench for a developer
switching long-lived contexts rapidly. The primary verb is “locate active
context, then switch surface instantly.” The shell is fixed-light and
Zenbones-derived: bone canvas, paper surface, graphite text, pine action,
clay/error, and aluminum structure.

The signature is a stable `Workspace → Agent` sidebar coupled to one titlebar
Activity switcher and one uninterrupted Surface viewport. Activities are fixed
choices, not tabs. Selection never changes context implicitly.

Rejected defaults: dark developer dashboard → fixed-light native workbench;
browser tabs → stable context tree plus Activities; decorative cards/status bar
→ border and surface-shift structure around one Surface.

## Foundations

- Palette: canvas `#f3f1ef`, chrome `#e9e5e2`, paper `#fbfaf9`, graphite
  `#2c363c`, secondary `#6f6864`, pine `#286486`, selection `#cbd9e3`,
  working `#4f6c31`, waiting `#9a6700`, clay/error `#a8334c`, aluminum
  `#d8d4d0`.
- Depth: borders and subtle surface shifts only. No shadows, gradients, or
  glass over content. Native overlay titlebar and navigation/control surfaces
  may use the system material; the Surface remains paper.
- Spacing: strict 4px base grid. Sidebar default is 248px and clamps to
  200–400px. Controls are 40px minimum; icon-only controls are 40–44px.
- Typography: system SF Pro Text/Display. Dense tool scale uses 11px metadata,
  13px rows/controls, 14px body, and 24–34px Surface headings. Weight and
  color establish hierarchy before size.
- Motion: short ease-out transitions for selection/press feedback; loading
  pulse and movement are removed under `prefers-reduced-motion`.

## Component patterns

- Titlebar Activities — native overlay, 56px height, traffic-light leading
  inset, exactly Editor/Agent/Terminal. Disabled choices remain visible and
  use text plus an accessible reason.
- Sidebar row — 40px hit target, separate disclosure button, context row, and
  optional semantic action. Scratch is fixed first; Workspaces retain open
  order; Agents retain creation order. A workspace with zero agents has no
  disclosure placeholder or child row.
- Status mark — symbol + text/VoiceOver label + semantic color; status never
  controls ordering and never relies on color alone.
- Surface viewport — one `Surface` region with loading, empty, unavailable,
  error, closing, and closing-failed states. Provider content will mount into
  this region later; it is not wrapped in decorative cards.
- Sidebar resize — keyboard/pointer separator with `aria-valuemin=200`,
  `aria-valuemax=400`, and Rust-owned committed width. Preview width is the
  only local resize state.

## Accessibility and Mac contract

Use native buttons and links, visible focus rings, VoiceOver labels, keyboard
navigation, text zoom-safe wrapping, UTF-8-safe labels, and forced-colors
fallbacks. Validate reduced motion/transparency and increased contrast. Keep
standard macOS shortcuts native; do not implement Command+Q in JavaScript.
