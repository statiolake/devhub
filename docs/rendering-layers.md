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

## Audit

Lines are at a7ea595f, the commit the audit started from. Status: **fixed**
(with the commit's subject), or **open**.

### A transparent canvas under text

- `painter.ts:599` `const opaque = !box.float` — every float was a canvas
  with alpha: hovers, completion and picker lists, which-key, lazy's and
  mason's windows, and through `paneGrids.ts:427,443` (`float: true`) every
  tmux `display-popup` and the chooser's preview. Bug: their text was set in
  grayscale, thinner and lighter than the window beside it on macOS.
  **Open.**
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
  own shadow's neighbours until the next relayout. **Open.**
- `editor.ts:915` the cursor is at its grid's z + 1, the same z as the
  riders of that window (`LayerViews.tsx:348,505` inline cards, decorations
  `DecorationViews.tsx:345`) and GUI windows (`NeovimApp.tsx:659,685`), all
  siblings in `.nvim-host`. Which one is on top is the order React and the
  editor happened to insert them. Bug: the cursor block over a GUI window's
  iframe, or a line decoration over the cursor, depending on mount order.
  **Open**: needs a declared order for riders (decorations and cards under
  the cursor, GUI windows and views over it) as parts of the window's
  level.
- `neovim.css:181,277,389,501,559,807` and `editor.ts:972` DevHub's own
  overlays (popup 300, preedit 300/401, command-line window 390, command
  line 400, status 500, toasts 600) share one integer space with floats at
  100 + zindex. Bug: a float with zindex ≥ 200 ties or covers `gui.popup`,
  one ≥ 300 the command line, one ≥ 500 the toasts (which-key is 1000).
  Neovim's own compositor puts the message area at zindex 200 and its
  popup menu at 100, so the declared order should be Neovim's. **Open.**
- `ControlTerminalSurface.tsx:557` and `paneGrids.ts:427,443`, `prompt.css`,
  `popup.css`, `chooser.css`, `menu.css`: the control surface's order is a
  set of literals (popup frame 40, prompt 45, popup grid 50, chooser 55,
  chooser preview 60, cursor in a popup 60, numbers 65, menu 70). Bug: a
  `command-prompt` raised while a popup is open (from a shell in the popup)
  is drawn under the popup's grid. **Open**: one table, in one module.

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
  show in the framed floats' cut-away border cells. **Open**: the framed
  floats' cut-out should be their own clip, not the lower layer's absence.
- `editor.ts:551-560` the cursor is hidden (`visibility`) when its row
  scrolls out of the text area, and `riders.ts` cuts riders with a computed
  `clip-path`: both because they are not children of the window's clipping
  element. **Open**: put the cursor and the riders inside the window's
  layer and let `overflow: hidden` clip them.

### Chrome painted into a grid canvas

- `painter.ts:1621, 2004-2051` (`paintSeparators`): the window separator's
  two halves and its line are painted into grid 1's canvas, and grid 1's
  rows are repainted when the separators change. Grid 1 is also shared by
  every window's status line (Neovim's multigrid puts them there). **Open**:
  separators as elements over grid 1.
- The control surface's separators and outlines are elements
  (`ControlTerminalSurface.tsx:459-510`): follows the rule.

### Colour sampling from neighbours

- `chrome.ts:270-339` (`separatorsOf`, called at `painter.ts:1157`): each
  half of a separator takes the commonest own ground of the window beside
  it, read from that window's cells. a7ea595f kept it from following what
  scrolls; a window whose own-ground cells change mid-scroll (right-aligned
  virtual text with a background at its edge) can still flip it. **Open**:
  a window should state its ground and the separator take that.
- `painter.ts:2245-2256` (`bandOf`) reads a float row's neighbours to find
  the float's ground: its own grid, so within the rule.

### Fractional positioning

- `painter.ts:1489` a frame label's top is `cy - textHeight / 2`, and
  `ControlTerminalSurface.tsx:470-506` the hairlines and outlines sit at
  `(x + 0.5) × cell`: on a 16.5 px cell at 2× these are half device pixels,
  which Chromium snaps per edge, so a 2 px outline can come out 3 or 5
  device pixels. **Open**: snap with `Math.round(v × dpr) / dpr`.
- Canvases, scroll offsets (`smoothScroll.ts` `snap`) and slides are on
  whole device pixels.

### A canvas shared, or a blit crossing a rect

- Each window, float and pane has its own canvas; the ghost, the pin and a
  slide copy only from their own canvas, inside its text area. Grid 1 is
  shared by the windows' status lines and separators (above).

## Remaining, in order of impact

1. Opaque leaf canvases for floats and tmux popups.
1. Painter levels: parts stacked by declaration, not DOM order.
1. Declared overlay tiers in Neovim's zindex space (floats vs DevHub's
   command line, popups and toasts).
1. Cursor and riders as parts of their window's level, clipped by it.
1. Separators as elements, from grounds the windows state.
1. `underFrames` replaced by a clip of the framed floats.
1. The control surface's z table; prompt over a popup.
1. Device-pixel snapping of labels, hairlines and outlines.
