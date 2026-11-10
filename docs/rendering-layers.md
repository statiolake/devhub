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
  room for another, while the Neovim was a view of its own);
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
  stack by `PART_Z` — a panel's shadow, a float's frame (its padding's
  ground and its 1px rounded line: an element, never painted into a
  canvas, as rule 3 has it), the
  grid (its canvas, or a window's scroll port holding canvas over ghost),
  what rides its text (inline images, cards, decorations), what lies over
  a grid (a pinned winbar, a slide), the cursor, what covers its cells (GUI
  windows, views), the title and footer cells on a frame's line — never
  by which element was appended last. A Neovim float's canvas is its cells
  as Neovim sent them; DevHub adds only the frame and the panel's fusion
  ("Floating surfaces" in `docs/neovim-editor.md`): richer UI is a native
  DevHub surface in a band of its own (below), not a decoration of
  Neovim's grid.
- `GridPainter.over(grid, part)`: what the page lays over a grid — riders,
  the cursor, covers — is in a clip of that grid's own in its level (and
  `shadow`, under the grid and not cut by it: a page's line and shadow
  round a bare float it frames itself, a framed view's)
  (`overflow: hidden` at the grid's text area: a window's without its
  winbar, a float's without its border; a cover's, the whole grid). React
  renders into it by a portal; its content keeps the editor's coordinates
  (the clip's inner element is moved back by the clip's place).
- Bands (`neovim.css`, `--nvim-band-*`): the editor is stacked in bands,
  each one stacking context, so nothing in one is drawn over a band above
  it, whatever its own z-index. `.nvim-host` is a band of the surface,
  under the status. A guard test (`bands.test.ts`) holds
  the order and fails on a numeric z-index in `neovim.css`. Inside the
  host, bottom to top:
  - **editor** (`.nvim-editor`, made by `NeovimEditor`): Neovim's
    composition — the levels, and what the page lays over a grid by its z
    (riders, the cursor, GUI windows and views, in its
    clip). A float's 100 + zindex orders it among the grids and nothing
    else: which-key at 1000 is still under every band above.
    The notifications (`gui.notify`, `Toasts`) are a level of this band at
    `AMBIENT_Z` (100 + 45, fidget's zindex): over the windows, under every
    float at Neovim's default zindex or above. A notification is ambient
    status; it yields to what the person is working in — a picker, a
    hover, a plugin's window — as fidget's own window does, rather than
    being drawn over a picker's rows as a band over the floats would.
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
- Panes and boundaries (`chrome.ts` `boundariesOf`, `paneRect`,
  `rowBleed`; `painter.ts` `placePanes`; tmux's in
  `ControlTerminalSurface.tsx`): Neovim keeps a cell between windows (a
  column side by side, a row stacked when there is no status line) and
  tmux one between panes, and a TUI can only draw a `│` or `─` in it; a
  GUI shows two regions meeting at an edge (VS Code's editor groups, Zed's
  panes). The rule, for both:
  - **A region is what the person reads as one thing.** A tmux pane; a
    Neovim window together with its status line when `laststatus` is 1 or
    2 (the status line is the window's footer, as an editor group's tab
    bar is its header). So stacked windows with their own status lines
    meet at the status line, which divides them as the person's
    colorscheme draws it (a band, or a line with `stl:`), with no
    hairline added; side by side, the line between them runs down beside
    the status lines' row too. With `laststatus` 0 or 3 there is no
    window status line, and stacked windows meet at a hairline across
    the separator row, as side by side ones do. The tab line, a global
    status line and the command line are no region's: the lines stop at
    them.
  - **Each region's ground goes on to the line.** The gap cell is split
    exactly in half, on device pixels, so edges split across and down
    line up. On its side each region continues as itself: a window's
    canvas reaches into the half column (`Bleed`) and each of its rows
    goes on in the ground of its edge cell — its `Normal` or `NormalNC`
    (through `winhighlight`), a sign column's, a current line's, a diff
    line's, a winbar's — so a sidebar in its own ground, a current line
    or a status line's label meets the line with no strip of another
    colour. Above and below a window (the half row of a separator row),
    its pane element is in the window's own ground (`windowGround`); a
    window's text scrolls along its rows, not across them. Grid 1's gap
    cells are not drawn as cells: one a line runs down (beside the status
    lines) is grounded half and half by the cells either side of it. A
    tmux pane's rows go on the same way (`setGridReach`), its ground is
    the pane's default background, and a Neovim in a tmux pane reaches
    into the pane's half border cells on every side (`setReach`): grid 1
    continues its first and last rows up and down and its edge cells
    sideways, its windows on that edge their rows, and the tab strip its
    ground (`neovim.css`, `--nvim-reach-*`).
  - **One hairline on the shared edge.** One element per line,
    `PART_Z.boundary` over the windows' level (tmux's
    `CONTROL_Z.borders`), traced over the gap cells (`borders`, shared by
    both): lines join at a T (one ends on the other's middle) and cross
    at a +, so no junction has a gap. Neovim's is in `WinSeparator`'s ink
    on the pixels grid 1 draws a `│` or `─` on (one CSS pixel at the
    usual sizes, on whole device pixels), so a status line drawn as a
    line meets it (a stub to the hairline), and a line that ends on the
    status line's junction (`┴`) ends on that line. A line on grid 1's
    edge runs on to the editor's reach, to meet tmux's line. tmux's is
    one CSS pixel on whole device pixels, centred on the gap cell; the
    active pane's (and synchronized panes') outline is that stretch of it
    recoloured and two pixels thick, so it too sits where the regions
    meet.
  - Everything from the regions' places, sizes and highlights, never from
    what is drawn in the gaps; nothing a window scrolls or redraws
    touches the lines. While panes move each draws the lines on its own
    edges (`docs/pane-motion.md`); the shared ones are placed again at
    rest.
- One page, one layer model: a Neovim DevHub draws in a tmux pane is in
  the terminal's own page (`shell/pane/PaneNeovims.tsx`), not a view of
  its own over it. The control surface puts it in the panes' level
  (`CONTROL_Z.panes`), in a group of its own the shape of a pane's motion
  group (`placeNeovims`). Its clips cut its pane's ground, which is in
  Neovim's colour. So it stacks as the pane it is: over the panes' grounds
  and under the hairlines and outlines (`CONTROL_Z.borders`), the chooser,
  `display-panes`, a popup, a menu and the prompt. Inside it, its own
  editor stacks as above: its levels at Neovim's z, notifications at
  `AMBIENT_Z` under the floats, and its bands (popup, cmdwin, cmdline,
  menu, preedit) over its editor and inside its pane. Several Neovims, in
  one window or across windows and surfaces, are each their own such
  group, element, painter and UI.
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
  fails on a numeric z-index in the surface's CSS. Checked on screen since
  ("Control surface: a popup or a prompt a shell asks for is DevHub's"):
  a prompt raised from a popup's shell is drawn over the popup and typed
  into while the popup stays open. Before, it could not be raised at all:
  a `display-popup` or `command-prompt` asked from a shell was drawn by
  tmux for the control client, that is for nobody (`terminal-mode.md`,
  "Asked from a shell").

### Hide-to-make-room

- `ControlTerminalSurface.tsx:359-400` (`holes`, `drawHoles`) and main's
  `ShellWindow.placeOverlays`: while a prompt, menu, popup or chooser is
  open, the terminal page was raised over the Neovim views and cut holes
  in its own ground where they were. The Neovim was a separate
  WebContentsView, which the page's CSS cannot stack, so this was the only
  way across two views. **Fixed** ("Neovim over a tmux pane: drawn in the
  terminal's page, moving with its pane"): the Neovim is in the page, in
  its pane's place in the stacking table (above, "One page, one layer
  model"). The holes, the raise, the backdrop and the overlay views are
  gone.
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
  boundary (half a cell less half the line). **Fixed** first with a reach
  for the view (`paneReach`, `inset`), which left one case: a side that
  was a neighbour's outline for part of its length and a hairline for the
  rest stopped at the outline, a pixel short of the hairline. **Fixed**
  since by drawing the Neovim in the page: its pane's ground is the clip
  of its group, placed exactly as every pane's ground is (`restPlace`, to
  the middle of tmux's border cell), in Neovim's colour, and the hairlines
  and outlines are drawn over it as over any pane. `paneReach`, `inset`
  and the view are gone. Checked in the app at 2x with Neovim's `Normal`
  set apart from the terminal's (`#ffe0e0` on white), the Neovim pane
  beside a pane split across. Its ground meets the 1px hairline along the
  upper neighbour and the 2px active outline along the lower one with no
  pixel between, on the same side.

### Colour sampling from neighbours

- `chrome.ts:270-339` (`separatorsOf`, called at `painter.ts:1157`): each
  half of a separator takes the commonest own ground of the window beside
  it, read from that window's cells. a7ea595f kept it from following what
  scrolls; a window whose own-ground cells change mid-scroll (right-aligned
  virtual text with a background at its edge) can still flip it. **Fixed**
  (with the above): a pane's ground is its window's `Normal`/`NormalNC`
  as asked of Neovim (`THEME_LUA`'s `grounds`, `windowGround`);
  `separatorsOf` and a7ea595f's `isOwnGround` are gone.
- `painter.ts` (`floatGround`) reads a float's edge cells for the ground
  of its padding: its own grid, so within the rule. (`bandOf`, which read a
  row's neighbours to round a selected row, is gone with the decoration:
  a float's rows are its cells.)

### Fractional positioning

- `painter.ts` a frame label's top is `cy - textHeight / 2`, and
  `ControlTerminalSurface.tsx:470-506` the hairlines and outlines sit at
  `(x + 0.5) × cell`: on a 16.5 px cell at 2× these are half device pixels,
  which Chromium snaps per edge, so a 2 px outline can come out 3 or 5
  device pixels. **Fixed** (with the control surface's panes above): the
  label's left and top, the hairlines' and outlines' edges and the panes'
  grounds are snapped with `Math.round(v × dpr) / dpr`; the hairlines and
  outlines across are on whole CSS pixels (`boundaryLine`).
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
   grid inset by half a cell~~ fixed: drawn in the terminal's page, its
   pane's ground in its colour.
8. ~~The Neovim over a tmux pane a view of its own, the page raised over it
   with holes~~ fixed: one page, one layer model.

Seen while checking the above, not layering bugs but on the same path:

- After the app is restarted, an editor whose Neovim kept running comes
  back with its windows' sizes changed (a split's upper window one row
  tall): the UI attaches at another size first and Neovim spreads the
  difference. **Fixed** ("Neovim editor: windows keep their sizes through
  a reattach"): two attaches at another size did it — the priming attach
  at half the size (its sizes are now kept and put back), and a page that
  attached before its view was on its pane (it now waits until the
  terminal surface has put its element on its pane, `placed`). Checked in the app: a split at 32 and 8 rows through three
  restarts, 32 and 8 each time (31 and 8 became 17 and 22 before).
- A Neovim page reloaded (DevTools) stays blank: it does not attach
  again. **Fixed** ("Neovim editor: a reloaded page attaches again"): it
  did attach, but the host's redraws went to the port its old document
  had; a page that loads again now lets its UI and its port go, is told
  where it is again, and attaches with a new port. Checked in the app:
  two reloads, the split drawn again at its sizes each time.
- Pixel scrolling in a `:vsplit` (italics and CJK at the window's edge,
  fractional deltas with momentum) was checked frame by frame against a
  reference made of still frames, with software and with GPU
  compositing: nothing drawn past a window's rectangle, the boundary
  column and the status row unchanged in every frame. The artefacts seen
  on macOS at the separator were the grid-1 painting fixed above (a
  stale cell drawn as a tick, the halves recoloured by what scrolled);
  a garbled last row was not reproduced here.
