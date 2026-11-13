# Visual stability

The suite that keeps DevHub from visibly shifting or flickering: every
scenario it knows is played on the real app, recorded frame by frame under
CPU throttling, and checked for **intermediate forms** — anything drawn one
way and then another for one action. It is `docs/motion.md`'s rules 2 and 3
("everything moves once per cause"; "start and end are real layout
positions"), measured instead of looked for.

What the person asked for: 「見た目が揺れない」. The faults it was built from were
each found by hand, with a throttled per-frame capture: a framed view's
square corners for the frames before its claim landed (8091a7ba, 556d62aa),
nvim-tree's own cells before its view covered them (0ad97bbc), a picker's
field without its caret (ea99429e). The suite is that capture, made
systematic.

    apps/desktop/test/stability/run.sh                    every scenario, 6x and 1x
    apps/desktop/test/stability/run.sh --only picker,tree --rates 6
    apps/desktop/test/stability/run.sh --hold --port 9913 the prepared app, to work by hand
    scripts/test-local.sh stability                       as a stage (builds first)

## How it runs

- **The app**, from this checkout (`out/`, `dist/`), under its own Xvfb
  (`xvfb-run`, a 1600×1000 screen), with a CDP port, at device scale 1, on
  the profile `stability`: HOME, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and
  `TMUX_TMPDIR` in a throwaway directory, the tmux server
  `devhub-stability` (`app.mjs`, as `scripts/smoke_packaged_app.py` does).
- **A fixed world** (`profile.mjs`): settings with DevHub Dark/Light and the
  terminal font DejaVu Sans Mono 13; two sample Workspaces, `alpha` and
  `beta`, whose files are generated the same on every run (a `many/` folder
  of 80 files to scroll under the tree's sticky header); a conversation
  Agent profile whose CLI is `fixture/fake-claude.mjs` (it streams one
  paragraph per message, never a model).
- **A pinned Neovim config** (`fixture/init.lua`): devhub.nvim, snacks.nvim
  + snacks-ui.devhub, blink.cmp + blink-ui.devhub, nvim-tree.lua +
  nvim-tree-ui.devhub and vscode-2026-theme.nvim, each at the commit
  `plugins.json` names. `fetchPlugins.mjs` clones them once into
  `~/.cache/devhub/stability-plugins/<name>-<commit>` (or
  `$DEVHUB_STABILITY_PLUGINS`). No other test fetches plugins; bump a pin
  there and nowhere else.
- **Actions as a person makes them**: keys through CDP's Input domain into
  the page's own key handling (`keys.mjs`), clicks with the pointer moved
  there first (its hover drawn and settled before the press is recorded),
  `devhub <file>` through the real CLI, a window resize through `xdotool`,
  a theme through the settings file. Setup goes through Neovim's RPC and is
  not recorded.

## What is recorded

For each step (one action), on each page it names (`capture.mjs`):

- **Per animation frame** (`recorder.js`, injected): every watched
  element's bounding box (transforms included), computed `clip-path`,
  `border-radius`, opacity (multiplied up its ancestors), and for a canvas
  a digest of its pixels; colours when a step asks (the theme switch). An
  element with no box, hidden or transparent is *absent*. A frame is kept
  whenever any of it changed.
- **The composited picture**: the page's screencast (PNG), decoded and
  digested per region (`pixels.mjs`). An element's own geometry cannot show
  what is drawn over or under it — a window's bare cells for a few frames
  before its view covers them are two elements with one form each — so the
  picture is checked by the same rule.
- **The CPU throttled** (CDP `Emulation.setCPUThrottlingRate`) at 6x, then
  1x: a slow machine shows the frames between two messages that a fast one
  merges.

The step is over once no page has changed for 600 ms (longer under
throttling), after what it waits for (`waitFor`) has come.

## The invariants

`invariants.mjs`, pure and unit-tested (`invariants.test.mjs`):

- **One change, at most two forms.** Each element's form, frame by frame,
  collapses into runs of equal values; absent is a value. Two runs are the
  element before and after the action: it appeared in its settled form,
  left from its form, or changed once. A third run is an intermediate form
  (`intermediate`: A B C) or a flicker (`flicker`: A B A) — the first
  visible frame differs from the settled one. The same rule holds for each
  picture region (`picture`).
- **doubled**: a role (`single`) on screen twice at once.
- **uncovered**: in some frame, an element outside the one that should hold
  it (`contain`) — content spilling out of its frame while the window is
  resized.
- **pushed**: an element that moved without a declared motion (`anchored`):
  a streamed answer's blocks may grow, never move.

**Declared motion is left out, and only its path.** An element under a
finite Web Animation (or under an ancestor that is) — the transitions,
glides and arrivals of `docs/motion.md` — is not compared while it runs;
neither is a frame while one of the Neovim surface's own motions is on
screen (pane motion's pictures, a scroll's ghost easing out, lines sliding:
`NEOVIM_MOTION`). Where a motion ends is still compared with what was there
before, so an animation that lands off its layout position fails. Loops (a
caret's blink, a spinner: infinite animations) are held at their start
while recording; they are not changes.

A step that resizes the window (`live`) has a new state every frame: only
the per-frame rules (`single`, `contain`) hold there.

**Known faults outside DevHub** are listed on their step (`known`: a
pattern and why), matched against each problem and nothing else: they are
printed every time they show (`KNOWN`), with their artifacts, and do not
fail the run. A problem they do not match fails as ever.

## On a failure

Each failing step writes, under `$DEVHUB_STABILITY_ARTIFACTS` (default
`.spike/stability`) `/<scenario>/<step>-<rate>x/<page>/`: `frames.json`
(every kept frame), `shot-NNN-<ms>.png` (the screencast, ms after the
action) and `violations.txt` (each problem with the forms it took). Diff
two shots to see the frame that should not have been:

    convert a.png b.png -compose difference -composite -threshold 0 -format '%@' info:

`app.log` is the app's own output; `results.json` every step.

## The scenarios

`scenarios.mjs`. Each runs at 6x and at 1x.

| scenario | steps |
| --- | --- |
| `picker` | snacks picker open, preview off, preview on, the window resized with it open (live), query to Normal, close |
| `tree` | nvim-tree open (a split: its pane motion declared), a folder expanded, `<C-d>` under the sticky header, collapsed, closed |
| `blink-insert` | blink-ui's insert menu opening, the selection moving, closing |
| `cmdline` | `:` opening, a character typed (blink-ui's command-line menu), Tab, Escape |
| `float` | a float with a rounded border and a title (B′), closed; two floats whose borders are fused, closed |
| `open-file` | `devhub <file>` into the `devhub-nvim` window, twice |
| `workspace-switch` | the other Workspace selected in the Sidebar, and back |
| `sidebar-collapse` | the Sidebar to its rail and back (Sidebar, window page and editor recorded) |
| `orchestrator` | the Orchestrator's board coming up, and back (the board only: its tabs are being replaced) |
| `conversation` | a message sent, a streamed answer received |
| `theme` | dark to light and back (the editor and the Sidebar recorded) |
| `pointer` | not recorded but timed (`pointer.mjs`): the pointer's answers, from the input event to the first frame that shows them — a click's caret, a click into another window, a tree row's focus and hover, a window border and a pane boundary dragged, a terminal selection and Visual's band dragged, a completion row clicked, the pointer's shapes; each within two frames of the rate (34 ms at 1x), Neovim's wheel from rest reported (`docs/neovim-editor.md`, "The pointer") |

## Where it runs

`DEVHUB_NEOVIM_DELAY_MS=150 apps/desktop/test/stability/run.sh --only pointer`
holds the pointer's answers over a slow link: the Neovim host reaches
Neovim through a socket that holds each chunk half that long each way
(`delayProxy.ts`), and what is at once must still be.

`scripts/test-local.sh stability` (it builds first) and the nightly's
`Test: visual stability (Linux)` (`docs/ci.md`). Not per push: it records
for about three minutes on top of a build, and a few steps fail now and then
on a timing it has caught (below); a per-push job that is red for those
would be a job people learn to ignore.

## Known faults, open faults and flaky steps

Each is a `known` entry on its step, with its reason, printed every time it
shows. Outside DevHub:

- `picker/open` (1x): snacks.nvim flushes the picker's windows before its
  `startinsert` lands, so Neovim draws one frame in Normal mode (its own
  `-- (insert) --`): the query's caret is a block, then a bar.
- `picker/preview-off`, `preview-on` (now and then): snacks-ui.devhub sends
  the frame's new layout from a scheduled `WinResized` handler, after Neovim
  has flushed the preview float's change; for a frame the preview's column is
  empty. (DevHub could also hold a claimed frame whose floats close until Lua
  settles it, as `ClaimAsks` does for floats it has not drawn.)
- `cmdline/open` (6x, now and then): Neovim's `showcmd` shows the typed `:`
  for a frame before the command line opens.
- `open-file/devhub-file-again`: Neovim highlights markdown with treesitter in
  a redraw after the one that shows the file: plain, then coloured.

DevHub's own, diagnosed and open:

- `theme`: the page's palette lands before Neovim's recolour (the theme
  reaches Neovim through its own connection and Neovim redraws after): light
  chrome round a dark editor for a few frames, at 1x too.
- `sidebar-collapse` (6x): the Sidebar's view is resized before its page has
  the projection that says collapsed or expanded (one frame of the wrong
  layout at the new width); and the editor is laid out at the new width
  before Neovim answers the resize (one frame of the last grid, its edge
  filled to the new width).
- `cmdline/close` (6x, now and then): blink-ui's command-line menu is closed
  by a Lua event that comes before the flush with `cmdline_hide`.

Flaky and not excused (it fails the run when it shows):

- `picker/open` at 1x, about one run in four: the list is drawn with one row
  for a frame between its first page and its settled one. The view's items
  are rendered from a `vim.schedule` after the list buffer changes, and one
  such render caught snacks' list mid-rewrite.
- `tree/scroll-sticky` at 6x, two runs in five: the command line's box is
  on screen for one frame during `<C-d>`. The screencast missed that frame,
  so what it held is not known; Neovim's `showcmd` of `^D` flushed mid-key
  (as in `cmdline/open`) is the likely cause, not a confirmed one.

## Adding a scenario

A scenario is a `setup`, `steps` and maybe a `teardown`; a step an `act`, a
`prep` (not recorded), the pages and roles it records, the `spec` it is
held to and its picture `regions`. Watch what the action changes, no more:
every role is read every frame. When a fault is fixed, the step that found
it is its regression test; say so where it is fixed.
