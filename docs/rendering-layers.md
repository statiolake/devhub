# Rendering layers

How the Neovim editor (`apps/desktop/src/shell/neovim/`) and the
control-mode terminal (`shell/terminal/control/`) put pixels on the screen,
the rule they are held to, and where the code still breaks it. Read with
`docs/neovim-editor.md` ("The page") and `docs/terminal-mode.md` ("The
surface"). The app stays on Electron: the browser's compositor is the
layer system.

## Why a rule

Many rendering bugs had one shape: a feature worked out for itself where it
draws, how far it may draw and what it stacks over, and when that
computation was off by one something else broke:

- borders garbled while a window scrolled (a scroll blit crossing the
  separator's cells);
- the Neovim overlay hidden under tmux prompts (one view cleared to make
  room for another);
- the glyph under the cursor a pixel off (page text, not the row's painter);
- a transparent canvas turning subpixel antialiasing off;
- a separator's colour borrowed from the highlights scrolling past beside it
  (a7ea595f);
- an overlay stuck small after a resize (3fe9146e).

## The rule (target model)

1. **Every surface is a layer, an element of its own**: each Neovim window,
   tmux pane, float, popup, prompt, menu, tab strip, separator and border.
   It clips with `overflow: hidden`, scrolls by `transform`, and has an
   explicit z-order.
2. **Cell text is drawn only into its leaf's own canvas**, which is opaque
   wherever text sits on an opaque ground, and every leaf is sized and
   placed on whole device pixels.
3. **Chrome is never painted into a cell canvas** — separators, borders,
   outlines, badges, tabs — so a scroll or a grid redraw cannot touch it.
4. **Overlays stack by declared z-order** (prompts, menus, popups, pickers,
   notifications). Nothing hides or clears another layer to make room.
5. **A layer's colours come from its own data**, never from sampling its
   neighbours.

What follows the rule in code:

- `GridPainter.level(z)` (`painter.ts`): one stacking element per
  `GridBox.z` (grid 1 at 0, windows at 1, a float at 100 + its zindex, a
  tmux popup at 50, the chooser's preview at 60). Inside a level its parts
  stack by `PART_Z` — a panel's shadow, a framed float's ring and lines, the
  grid (its canvas, or a window's scroll port holding canvas over ghost),
  what rides its text (inline images, cards, decorations), what lies over
  a grid (a pinned winbar, a slide), the cursor, what covers its cells (GUI
  windows, views), the frame's labels — never by which element was
  appended last.
- `GridPainter.over(grid, part)`: what the page lays over a grid — riders,
  the cursor, covers — is in a clip of that grid's own in its level
  (`overflow: hidden` at the grid's text area: a window's without its
  winbar, a float's without its border; a cover's, the whole grid). React
  renders into it by a portal; its content keeps the editor's coordinates
  (the clip's inner element is moved back by the clip's place).
- Bands (`neovim.css`, `--nvim-band-*`): the editor is stacked in bands,
  each one stacking context, so nothing in one is drawn over a band above
  it, whatever its own z-index. `.nvim-host` is a band of the surface,
  under the toasts and the status. A guard test (`bands.test.ts`) holds
  the order and fails on a numeric z-index in `neovim.css`. Inside the
  host, bottom to top:
  - **editor** (`.nvim-editor`, made by `NeovimEditor`): Neovim's
    composition — the levels, and what the page lays over a grid by its z
    (riders, the cursor, GUI windows and views, in its
    clip). A float's 100 + zindex orders it among the grids and nothing
    else: which-key at 1000 is still under every band above.
  - **popup**: `gui.popup` (hovers, LSP floats). Asked for by a key and
    closed by the next cursor move, so a float must not hide what was just
    asked to be read.
  - **cmdwin**: the frame round the command-line window.
  - **cmdline**: the command line's box and its echo band. What is being
    typed is never under a float (Neovim's own message area is over its
    floats at the default zindex too).
  - **menu**: the completion menu (`ext_popupmenu`), over the command line
    it completes.
  - **preedit**: the IME's composition, at the cursor or in the command
    line: the text going in is over everything that could cover it.
- Panes and boundaries (`chrome.ts` `boundariesOf`, `painter.ts`
  `placePanes`): Neovim keeps a cell column between windows side by side,
  and a TUI can only draw a `│` in it; a GUI shows panes with an edge
  between them (VS Code's editor groups, Zed's panes). Each window's pane
  is an element under its grid (`PART_Z.pane`) in the window's own ground
  as its highlights state it (`Normal`, `NormalNC` when not current, through
  `winhighlight`), reaching exactly half into the column on each side —
  not some pixels of padding — so the edges of windows split across and
  down line up whatever their neighbours. The boundary is one hairline
  element on the shared edge (`PART_Z.boundary`), in `WinSeparator`'s
  colour, worked out from the windows' places and sizes. Grid 1's cells in
  the column are not drawn. A status line row is the horizontal bar: a
  boundary ending on it meets its `┴` (grid 1 draws it on the same
  pixels), and a status line drawn as a line beside a boundary runs into
  it (a stub element).
- `gridBlends` (`painter.ts`): a leaf canvas has alpha only while one of its
  cells blends (`winblend`); every other grid, floats and tmux popups
  included, is opaque.

## Audit

Lines are at a7ea595f, the commit the audit started from. Status: **fixed**
(with the commit's subject), or **open**.

### A transparent canvas under text

- `painter.ts:599` `const opaque = !box.float` — every float was a canvas
  with alpha: hovers, completion and picker lists, which-key, lazy's and
  mason's windows, and through `paneGrids.ts:427,443` (`float: true`) every
  tmux `display-popup` and the chooser's preview. Bug: their text was set in
  grayscale, thinner and lighter than the window beside it on macOS.
  **Fixed** ("Leaf canvases: opaque unless a cell blends"): alpha only for a
  grid with a `winblend` cell (`gridBlends`); checked in the app with a
  probe of `getContextAttributes().alpha` per canvas (floats and the popup
  `false`; `winblend=40` set live gives `true`, unset gives `false` again).
- `painter.ts:795-806, 930` the scroll ghost and the winbar pin are canvases
  with alpha. They hold copies of an opaque canvas's pixels, already
  rasterised, so no text is set on them: no bug, kept.

### Manual z-ordering by DOM-order accident

- `painter.ts:1426-1427, 1506-1508` a panel's shadow and frames were
  `prepend`ed to sit under the canvases of the same z, and its labels
  re-`append`ed whenever they were no longer the last child; `831, 881, 934,
1818` the ghost, the scroll port, the winbar pin and a slide each took the
  canvas's z and relied on being inserted before or after it. Bug: a canvas
  made after a cluster (a float that started or stopped blending, a grid
  re-created by a resize) could land over its frame's labels or under its
  own shadow's neighbours until the next relayout. **Fixed** ("Neovim
  painter: each stacking order is a level, its parts stack by declaration"):
  levels and `PART_Z`; a guard test fails on `prepend` or
  `lastElementChild` in `painter.ts`.
- `editor.ts:915` the cursor is at its grid's z + 1, the same z as the
  riders of that window (`LayerViews.tsx:348,505` inline cards, decorations
  `DecorationViews.tsx:345`) and GUI windows (`NeovimApp.tsx:659,685`), all
  siblings in `.nvim-host`. Which one is on top is the order React and the
  editor happened to insert them. Bug: the cursor block over a GUI window's
  iframe, or a line decoration over the cursor, depending on mount order.
  **Fixed** ("Neovim editor: the cursor stacks over riders and under GUI
  windows, by declaration"): `ABOVE_GRID` puts riders at the grid's z + 1,
  the cursor at + 2 and what covers the cells (GUI windows, views) at + 3.
  Since replaced by parts of the grid's level (`PART_Z`), in the grid's own
  clip (below): a float at zindex 50's cursor (+ 2) no longer ties a float
  at 52.
- `neovim.css:181,277,389,501,559,807` and `editor.ts:972` DevHub's own
  overlays (popup 300, preedit 300/401, command-line window 390, command
  line 400, status 500, toasts 600) share one integer space with floats at
  100 + zindex. Bug: a float with zindex ≥ 200 ties or covers `gui.popup`,
  one ≥ 300 the command line, one ≥ 500 the toasts (which-key is 1000).
  **Fixed** ("Neovim editor: DevHub's own stacks in bands over Neovim's
  floats"): the bands above; checked in the app with which-key (zindex 1000) up while a toast is shown.
- `ControlTerminalSurface.tsx:557` and `paneGrids.ts:427,443`, `prompt.css`,
  `popup.css`, `chooser.css`, `menu.css`: the control surface's order is a
  set of literals (popup frame 40, prompt 45, popup grid 50, chooser 55,
  chooser preview 60, cursor in a popup 60, numbers 65, menu 70). Bug: a
  `command-prompt` raised while a popup is open (from a shell in the popup)
  is drawn under the popup's grid. **Fixed** ("Control surface: one
  stacking table, in tmux's order"): `control/stacking.ts` `CONTROL_Z`,
  as CSS custom properties on the surface (`--control-z-*`) and as the
  painter's levels: the panes and what is on them, a pane's modes (the
  chooser and its preview, `display-panes`), a popup (frame, grid, its
  cursor), a menu, then the prompt — tmux's status line, which no popup or
  menu covers — and its completion menu. A guard test holds the order and
  fails on a numeric z-index in the surface's CSS.

### Hide-to-make-room

- `ControlTerminalSurface.tsx:359-400` (`holes`, `drawHoles`) and main's
  `ShellWindow.placeOverlays`: while a prompt, menu, popup or chooser is
  open, the terminal page is raised over the Neovim views and cuts holes in
  its own ground where they are. The Neovim is a separate WebContentsView,
  which the page's CSS cannot stack, so this is the only way across two
  views; it is the remedy for the overlay hidden under tmux prompts and is
  checked frame by frame (`terminal-mode.md`, "Over a Neovim"). **Kept**
  until the Neovim is drawn in the terminal's page.
- `painter.ts:583-588` (`underFrames`): a borderless float wholly behind
  framed ones (a picker's root box) is not drawn, because its ground would
  show in the framed floats' cut-away border cells. **Fixed** ("Neovim
  editor: a panel's box is clipped by its frames, not hidden"): a
  borderless float inside the rectangle the framed floats over it span is
  their panel's box (`frameCuts`); it is drawn, its canvas and its ground
  in the shadow clipped (`cutClip`) to its cells under no frame and, under
  the frames, to their shapes inside their lines, so the half cell outside
  a line shows what is under the panel. A float past that rectangle (a
  backdrop) is not cut. Clicks follow the clip. Checked in the app with a
  snacks picker in its `default` layout over its backdrop: the open half
  cell is the backdrop's tint round the rounded corners, as before; a box
  with a cell under no frame (a shorter preview) is now drawn there
  rather than not at all.
- `editor.ts:551-560` the cursor is hidden (`visibility`) when its row
  scrolls out of the text area, and `riders.ts` cuts riders with a computed
  `clip-path`: both because they are not children of the window's clipping
  element. **Fixed** ("Neovim editor: the cursor and riders are clipped by
  their grid's own element"): `GridPainter.over`; a guard test fails on a
  `cursor.style.visibility`, a rider's own cut or a `zIndex: box.z` in the
  views. Checked in the app at 2x: a card half past its window's bottom
  edge, at rest and mid-scroll, is cut at the edge; the cursor in a
  bordered float is in a clip of the float's three text rows.

### Chrome painted into a grid canvas

- `painter.ts:1621, 2004-2051` (`paintSeparators`): the window separator's
  two halves and its line are painted into grid 1's canvas, and grid 1's
  rows are repainted when the separators change. Grid 1 is also shared by
  every window's status line (Neovim's multigrid puts them there). The
  stub that joins a status line to the separator read grid 1's cells
  beside the column, which under a window are stale: a split closed
  earlier left a `─` there, drawn as a tick across the separator (seen in
  the app after `:only | vsplit`). **Fixed** ("Neovim editor: windows are
  panes with a boundary between them"): panes and boundaries (above).
- The control surface's separators and outlines are elements
  (`ControlTerminalSurface.tsx:459-510`): follows the rule. Since "Control
  surface: tmux's panes reach half into its borders, the boundary centred
  on the edge" the panes are panes as the Neovim editor's windows are:
  each pane's ground (`GridPainter.placeGrounds`) reaches exactly half
  into tmux's one-cell border beside it, so panes split across and down
  line up; the hairline (1 px) and the active and synchronized panes'
  outlines (2 px, dashed for the synced) are centred on the shared edge,
  computed from tmux's layout; tmux's border cells are not drawn. A
  zoomed pane has no boundary. A Neovim overlay on a pane was the pane's
  cells only (`overlayRect`), so where Neovim's ground differs from the
  terminal's a strip of the terminal's showed between the overlay and the
  boundary (half a cell less half the line). **Fixed** ("Neovim over a
  tmux pane: its view reaches the boundary"): the page reports each
  shown pane's reach (`paneReach`: to the near edge of the line beside
  it, the outline's where one runs along that side), `overlayRect` puts
  the view out to it on whole pixels and says how much of the view is
  past the cells (`inset`, the `devhub:neovim:inset` message), and the
  Neovim page draws its grid inside that, its ground in it; the holes
  cut while the page is raised reach as far. The lines are on whole CSS
  pixels (`boundaryLine`, a half pixel off the middle at most) so a view
  on whole pixels meets them exactly. Checked in the app at 2x with
  Neovim's ground set apart from the terminal's: the overlay meets the
  active pane's outline and the hairline with no pixel between, beside
  and under it, on the left and the right of the window. Left: a side
  that is a neighbour's outline for part of its length and a hairline
  for the rest stops at the outline, a pixel short of the hairline.

### Colour sampling from neighbours

- `chrome.ts:270-339` (`separatorsOf`, called at `painter.ts:1157`): each
  half of a separator takes the commonest own ground of the window beside
  it, read from that window's cells. a7ea595f kept it from following what
  scrolls; a window whose own-ground cells change mid-scroll (right-aligned
  virtual text with a background at its edge) can still flip it. **Fixed**
  (with the above): a pane's ground is its window's `Normal`/`NormalNC`
  as asked of Neovim (`THEME_LUA`'s `grounds`, `windowGround`);
  `separatorsOf` and a7ea595f's `isOwnGround` are gone.
- `painter.ts:2245-2256` (`bandOf`) reads a float row's neighbours to find
  the float's ground: its own grid, so within the rule.

### Fractional positioning

- `painter.ts:1489` a frame label's top is `cy - textHeight / 2`, and
  `ControlTerminalSurface.tsx:470-506` the hairlines and outlines sit at
  `(x + 0.5) × cell`: on a 16.5 px cell at 2× these are half device pixels,
  which Chromium snaps per edge, so a 2 px outline can come out 3 or 5
  device pixels. **Fixed** (with the control surface's panes above): the
  label's left and top, the hairlines' and outlines' edges and the panes'
  grounds are snapped with `Math.round(v × dpr) / dpr`; since the overlay
  reaches the boundary, the hairlines and outlines across are on whole
  CSS pixels (`boundaryLine`).
- Canvases, scroll offsets (`smoothScroll.ts` `snap`) and slides are on
  whole device pixels.

### A canvas shared, or a blit crossing a rect

- Each window, float and pane has its own canvas; the ghost, the pin and a
  slide copy only from their own canvas, inside its text area. Grid 1 is
  shared by the windows' status lines and separators (above).

## Remaining, in order of impact

1. ~~Declared overlay tiers~~ fixed: bands.
2. ~~Cursor and riders inside their window's layer~~ fixed: their grid's
   clip.
3. ~~Separators as elements~~ fixed: panes and boundaries.
4. ~~`underFrames` replaced by a clip of the framed floats~~ fixed:
   `frameCuts`, `cutClip`.
5. ~~The control surface's z table~~ fixed: `CONTROL_Z`.
6. ~~Device-pixel snapping of labels, hairlines and outlines~~ fixed.
7. ~~A Neovim overlay on a tmux pane reaching the pane's boundary, its
   grid inset by half a cell~~ fixed: `paneReach`, `inset`.

Seen while checking the above, not layering bugs but on the same path:

- After the app is restarted, an editor whose Neovim kept running comes
  back with its windows' sizes changed (a split's upper window one row
  tall): the UI attaches at another size first and Neovim spreads the
  difference. And a Neovim page reloaded (DevTools) stays blank: it does
  not attach again.
- Pixel scrolling in a `:vsplit` (italics and CJK at the window's edge,
  fractional deltas with momentum) was checked frame by frame against a
  reference made of still frames, with software and with GPU
  compositing: nothing drawn past a window's rectangle, the boundary
  column and the status row unchanged in every frame. The artefacts seen
  on macOS at the separator were the grid-1 painting fixed above (a
  stale cell drawn as a tick, the halves recoloured by what scrolled);
  a garbled last row was not reproduced here.
