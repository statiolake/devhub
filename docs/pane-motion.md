# Pane motion

How DevHub's panes move when their layout changes: tmux's panes on the
control surface (`shell/terminal/control/`) and Neovim's windows in the
editor (`shell/neovim/`). It is built: variant A, with the person's
changes (below, "As built"). Read it with `docs/motion.md` (the rules for
the whole app, of which this is the panes' part),
`docs/rendering-layers.md` ("Panes and boundaries"),
`docs/terminal-mode.md` ("The surface") and `docs/neovim-editor.md`
("The page").

What the person asked for:

> 分割したときにhyprlandみたいに自然なアニメーションがあってもよさそうだし、アニメーションの始点と終点がしっかり一致して停止しなきゃいけない。手になじむ道具であるためには不安にならない、ワープしないとか驚かないとか、そういう一貫した手触りがすごくだいじ

They added that they find Windows' window motion more pleasant than
macOS'. Windows 11 is the main reference here, with Hyprland second.

## As built

The person chose variant A (below) and changed four things:

> 基本はAを取りつつ…

- **Content follows its anchor.** 「コンテンツがどこにアンカーがあってどこが固定されてるのかを意識して、それが移動するようなレイアウトが発生したら一緒にアニメしたほうが良い」.
  A pane's content is not only glued to its top-left corner: where the
  same lines are in the old and the new picture says where it moves.
- **Zoom recedes the others** (variant B's counter-motion), without
  stretching anything.
- **A window or tab switch slides**, in the windows' order, like virtual
  desktops: WinUI's horizontal slide, not a fade.
- **A resize drag is immediate.** 「マウスに対する応答性が必要」.

What each change does now:

| Change | tmux (control surface) | Neovim editor | Time, curve |
| --- | --- | --- | --- |
| Split right / below (the new pane after) | The split pane's far edge travels to the new boundary, the new pane is uncovered in place. Its content follows its anchor: a shell kept at the foot of a shorter pane (tmux keeps the cursor line) rises with the edge, and the rows that leave the grid scroll out under it | The same; a window that scrolled to keep its cursor line in view moves its lines by the rows its `topline` moved | 167 ms, point to point |
| Split left / above (the new pane before) | The kept pane's near edge travels away and its text travels with it: to the right after a split to the left. Split above: a shell kept at the foot stays put while the top edge comes down over its first rows | The same | 167 ms |
| Close | The neighbours grow over the gone pane's last picture; one whose left or top edge moves carries its text; one that gains rows at the top (tmux brings history back) moves its text down with the edge | The same, the gone window's status line with it | 167 ms |
| Equalize, swap, move, maximize | Every edge that moved, one clock | The same (`<C-w>=`, `<C-w>\|`, `<C-w>_`) | 167 ms |
| Resize by key, one step (up to 5 cells) | The edges that moved | The same | 83 ms |
| Resize steps less than 250 ms apart (a held key) | At once | At once | 0 |
| Resize drag | At once, each committed cell under the pointer (a boundary can be dragged now: `resize-pane` per cell; the commit does not wait for the pictures) | At once (the sash drag) | 0 |
| Zoom | The zoomed pane grows over the others from its own rectangle (its final grid, clipped); the others slide away from it, 30% of its edge's travel, and fade out under it | (no zoom in Neovim) | 250 ms, point to point |
| Unzoom | The zoomed pane shrinks to its rectangle; the others come back from 30% away, fading in, under it | | 250 ms |
| Window switch / tab switch | The next window (by index) slides in from the right over the last, which slides 150 px on and fades; the previous one from the left | The same for a tab (`gt`, `gT`, `:tabnext`), by the tabs' order | in 300 ms on (0.1, 0.9, 0.2, 1); out 150 ms on (0.7, 0, 1, 0.5) |
| First attach, surface resize, Reduce Motion | At once | At once | 0 |
| A window with a Neovim drawn over one of its panes | At once (below) | (its own windows move, in its page) | 0 |

### How the anchors are found

- **tmux.** A committed layout is held, with the messages after it,
  until every resized or new pane's picture at its new size has come
  (`waitingFor`: the engine reads a resized pane again a round trip
  after `%layout-change`; at most 100 ms; a drag waits for nothing). So a
  pane's clip and its new content start in the same frame. Then the old
  and the new grid's rows are compared as text (`rowShift`): each row
  that is not blank and appears once in each picture votes for how many
  rows it moved, over the columns both have; the shift most rows agree
  on wins, the smaller on a tie, 0 when nothing matches (the content
  stays glued to the pane's top). The new grid starts drawn where that
  puts the old lines (`anchorOf`) and moves to its resting place with the
  clip, on the same clock. The rows of the old picture that the new grid
  does not hold (scrolled off the top of a shorter pane) are a copy of
  the old canvas, cut once to those rows, under the new grid in the
  pane's content (`leaving`): they leave under the moving edge rather
  than vanish at the first frame. tmux's scroll position and history
  size are not needed: what is on the two screens says it.
- **Neovim.** One flush is one commit (`win_pos`, the grids' new sizes
  and rows together). A window in both layouts moves its content by the
  rows its `topline` moved between the two `win_viewport`s
  (`viewportShift`): Neovim scrolled it to keep the cursor line in view,
  so the cursor line stays where it was on screen and goes with the
  edge. Its leaving rows are its old picture's, as on tmux.
- Horizontally, content is glued to its pane's left edge: neither tmux
  nor Neovim shifts a row sideways when a pane is resized.

The end is exact: a track whose time is up answers its resting place
itself, and the resting path draws the frame after the last.

### What moves together

- **One group per pane** (`GridPainter.motionGroup`, made at a
  transition's start, let go at its end): two nested clips the surface's
  size, each moved by a transform, cut the pane's rectangle; the inner
  clip's box is the pane's ground; the content inside holds the grid's
  parts (ground, canvas or scroll port, riders, cursor, covers, slides)
  in the surface's pixels, moved by a transform. At rest the parts are in
  their level, as before. Per frame only `transform` and `opacity` are
  written.
- **Boundaries** are hidden at the start; each moving pane draws lines on
  its own edges (a 1 px element stretched by `scale`): the hairline, and
  on tmux the active pane's 2 px outline. The shared boundaries are
  placed again by the resting path.
- **Status lines** (Neovim, `laststatus=2`): the row of grid 1 under each
  window is copied into a strip at its clip's foot, from its content's
  left; a gone window keeps its old one. The new grid 1 is under the
  groups, which cover it wherever a window is.
- **The cursor** is in its pane's content: on tmux it is moved into the
  active pane's group while panes move; on Neovim it is already in its
  grid's clip.
- **Clicks hit what is drawn**: on tmux a press is mapped through the
  visual rectangles of the panes in the committed layout, topmost first,
  to the cell of its grid drawn under the pointer (`paneUnder`).
- **A layout that moves nothing** (tmux's notice of the active pane, a
  rename) leaves a running transition to reach the layout it was going
  to.

### Choices, and why

- **Zoom: slide and fade, no scale.** Scaling a canvas resamples its
  glyphs off the device pixels: at 2× the text shimmers and thins, and a
  scaled pane's edge would no longer meet the hairlines. The growing pane
  covers most of the others within the first half of the 250 ms anyway;
  what shows is their outer part moving away and fading, which reads as
  receding without touching a glyph.
- **The switch: WinUI's horizontal slide, overlapped.** WinUI's
  `SlideNavigationTransitionInfo` (`FromRight`/`FromLeft`,
  `microsoft-ui-xaml` `dxaml/phone/lib/ThemeTransitions.cpp`) moves the
  page going away 150 px on (0.7, 0, 1, 0.5) in 150 ms, hides it, then
  brings the new one 200 px on (0.1, 0.9, 0.2, 1) in 300 ms: 450 ms in
  all, the new page invisible for the first 150. Here they run at once:
  the arriving window is drawn opaque over the leaving one from the
  first frame, so what is typed shows at once where it stays and no text
  is drawn twice. The curves, offsets and durations are WinUI's. The
  entrance curve is front-loaded (90% in about 70 ms) and creeps for
  its last few pixels; that is Windows' own feel for pages.
- **Neovim tabs slide too.** A tab is the same thing as a tmux window: an
  ordered sibling page. A tab switch is one flush like any layout change,
  so the gone windows' pictures and status lines leave and the new tab's
  windows arrive, by the tabs' order. Grid 1 (the tab's background, the
  command line) does not move; DevHub's tab strip changes at once.
- **Key resizes: 83 ms for a single step, at once when they repeat.** A
  single step is 90% done in about 40 ms and the key is never held, so it
  costs no responsiveness; steps less than 250 ms apart (a held key, a
  repeat binding) are placed at once, so a stream of them never trails.
- **Not moved, documented:** a tmux window with a Neovim drawn over one
  of its panes is placed at once (that Neovim is a view of its own, which
  this page cannot move; a cut is better than a Neovim that jumps while
  its pane glides). Neovim floats anchored to a window (`relative='win'`)
  are placed where Neovim puts them, at their final place, not with
  their window's visual origin.

### Reflow, not animated

Asked as a stretch: when a width change rewraps text (Neovim with
`wrap`, a shell's output tmux rewraps), move each logical line's block
from its old rows to its new ones. Not shipped, because it cannot be done
within the rules:
- The moving blocks would be pieces of the final grid in separate
  layers. A canvas can be shown in one place only, so each block would be
  a copy of its rows. A copy is frozen: what the program draws during
  the 167 ms (a key typed into the pane, the shell's redraw after
  SIGWINCH) would not show until the copies are dropped, which breaks
  "what is typed shows where it stays". Copying every frame instead is a
  repaint per frame, not transform and opacity.
- Neither side says where a logical line's rows are cheaply: tmux's
  line-joining is not in the frames the page gets (`VtFrame` rows carry no
  wrap flag; it would be a protocol change), and `win_viewport` gives
  `topline`/`botline`, not the wrapped rows of each line in between;
  asking Neovim would delay the first frame by a round trip.
- What is done instead: the shift most rows agree on (`rowShift`) moves
  the content as a whole, so unwrapped lines follow and a rewrapped
  block lands in its final wrap with the rest.

### Checked

- `paneMotion.test.ts`: the curve; a transition's end is its resting
  place itself whatever the last tick; edges on device pixels; never past
  the end; an interruption starts where it is drawn; `rowShift`; a
  prompt kept at the foot rises with its edge and stays in its clip;
  content travels with a split to the left; zoom and unzoom; the switch.
- `controlMotion.test.ts` (jsdom): a split frame by frame through
  `applyMotion`: the last frame before the end draws the resting
  rectangles (`restPlace`, which the resting path places) to the device
  pixel, with no content offset left; only transforms are written; a
  click maps to the cell drawn; a shell's anchor and its leaving rows;
  what a commit waits for; what a change is.
- `windowMotion.test.ts`: a window's rest is its pane's (`placePanes`)
  with its status line; a split ends on its rests; `topline` moves the
  text.
- In the app (Xvfb, 2×, the person's settings, tmux.conf and Neovim
  config): each change run with motion and again with Reduce Motion
  emulated; the resting DOM after the motion (every pane's ground,
  canvas and boundary, as rectangles) equals the one placed at once, for
  split right, left, below and above, zoom, unzoom and close on tmux, and
  vsplit, split, close, `<C-w>=` and a tab switch in Neovim; every frame
  after the last moving one is that resting frame. Recordings at real and
  quarter speed: splits in four directions, close, zoom, unzoom, window
  switch both ways, a boundary drag (tmux and Neovim), typing during a
  split, a split undone 60 ms in.

## The rules

1. **tmux and Neovim own the layout.** The layout at rest is exactly the
   rectangles they reported. Motion only fills the time between the
   rectangles on screen and the rectangles they just committed. It never
   predicts a layout and never shows one they did not report.
2. **Endpoints are exact.** A transition starts from what is on screen
   and ends on the committed rectangles to the device pixel. Its last
   frame is drawn by the same code that places panes at rest, not from a
   curve value.
3. **Input is never held.** A key typed during a transition goes to tmux
   or Neovim at once. Both already have the new layout, and the panes on
   screen draw their content at its final size, so the key shows up where
   it will stay.
4. **Content never stretches or reflows mid-motion.** Each pane's grid is
   drawn at its final size and revealed through a moving clip (below).
5. **Nothing warps.** A new layout during a transition starts a new
   transition from the current visual state.
6. **Short and decisive.** 83 to 250 ms, one curve that brakes hard and
   does not overshoot. With reduced motion, nothing moves.

## References and the values taken from them

**Windows 11 / WinUI** (Microsoft Learn: "Motion in Windows 11",
"Timing and easing"; Fluent 2 tokens in `microsoft/fluentui`):

| Purpose | Curve | Duration |
| --- | --- | --- |
| Existing elements, point to point | `cubic-bezier(0.55, 0.55, 0, 1)` | 167, 250, 333 ms |
| Direct entrance ("fast out, slow in") | `cubic-bezier(0, 0, 0, 1)` | 167, 250, 333 ms |
| Direct exit (always with a fade-out) | `cubic-bezier(0, 0, 0, 1)` | 167 ms |
| Gentle exit | `cubic-bezier(1, 0, 1, 1)` | 167 ms |
| Bare minimum: fade in and out | linear | 83 ms |
| `ControlFasterAnimationDuration` / `ControlFast…` / `ControlNormal…` | | 83 / 167 / 250 ms |

Microsoft's guide names its "Connected" principle with a window going
from floating to snapped to maximized that "always feels like the same
window". It describes motion as "fast, direct, and context-appropriate".
The point-to-point curve sets that feel. It leaves at moderate speed
(initial slope about 1, nearly linear), travels, then brakes to rest. At
167 ms it is half way at 47 ms, 90% at 77 ms and 99% at 129 ms. Nothing
crawls at the end and nothing bounces. That firm stop is what the
person asked for ("しっかり停止").

**Hyprland** (`example/hyprland.conf` in v0.50; speeds are in
decisecond units, 1 = 100 ms):
`windows 4.79 easeOutQuint (0.23, 1, 0.32, 1)`, `windowsIn 4.1 popin
87%`, `windowsOut 1.49 linear popin 87%`, `workspaces 1.94 almostLinear
(0.5, 0.5, 0.75, 1) fade`, `border 5.39`. The `windows` move reaches 90%
at 173 ms and 99% at 305 ms, then creeps for another 175 ms. That tail
is what feels slow and makes it hard to tell when the move has finished.
Current `main` moved `windows` to a spring (`easy`: mass 1, stiffness
238.12, damping 24.21). That is damping ratio 0.78, which overshoots by
about 1.9% and is within half a pixel of an 800 px move only after about
550 ms. It passes its endpoint, so it breaks rule 2. While a window
resizes, Hyprland also scales the client's last buffer until the client
commits a new one. That is the stretched text this design rules out.

What is taken from each:
- From Hyprland: the existing windows move, a new one appears in its
  place, and one clock drives everything.
- From Windows: the curve, the durations, and the short exits.

**DevHub's own motion**, which pane motion must sit beside:
- `dd`/`p`/`o` slide: 60 ms, `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Cursor glide: 70 ms.
- Scroll ease onto `topline`: 90 ms, ease-out cubic.
- Cursor blink edges: 120 ms.

The pane durations below are longer only where the distance is a pane's
width.

## The model

A **transition** is one clock (`t0`, from the first frame drawn after
the commit) and one curve shared by every pane in the window or tab.
Each pane has one of three roles, matched by identity (tmux pane id
`%N`, Neovim window handle):

- **keep**: in both layouts. Its rectangle and its content origin
  interpolate from where they are on screen to the committed values.
- **new**: only in the new layout. It sits at its final rectangle from
  the first frame, under the keep panes, and is uncovered as they move
  off it. It does not slide or scale.
- **gone**: only in the old layout. Its last picture (the canvas it
  already has, kept, not copied) stays at its last visual rectangle
  under the keep panes, which cover it as they grow. It is dropped when
  the transition ends.

Stacking during a transition: keep, then new, then gone, from top to
bottom. At rest no pane overlaps another, so this order only matters in
motion.

**What is interpolated.** Each pane's four edges, not its x and width,
plus its content origin, all linear in the eased progress `p`, and each
snapped to device pixels (`Math.round(v × dpr) / dpr`) every frame.
Two panes that share an edge in both layouts share it in every frame:
same start, same end, same `p`, same rounding. That leaves no seam and
no overlap. On a pane's side that turns from inner to window edge (or
back), its boundary's opacity follows `p`, so it never pops.

**Content is glued to the pane's top-left corner.** A row starts at the
pane's left edge and the grid's first row is at its top. So a pane
whose left or top edge moves carries its text with it: the right pane
after a close slides left, because its text really moves there. Its
right and bottom edges only reveal or hide.

## Each transition (the design)

Durations are for the recommended variant (A). What was built differs
where the person asked ("As built", above): zoom, the switch and the
drag.

| Change | Event | What moves | Duration |
| --- | --- | --- | --- |
| Split side by side (`:vsplit`, `split-window -h`) | Neovim: `win_pos` + `grid_resize` in one flush. tmux: `%layout-change` | The split pane's far edge travels to the new boundary; the new pane is uncovered in place | 167 ms |
| Split stacked (`:split`, `split-window -v`) | same | as above, down instead of across; panes whose rectangle is unchanged do not move at all | 167 ms |
| Close (`:close`, `:q`, `kill-pane`, exit) | Neovim: `win_close` / `grid_destroy`. tmux: `%layout-change` | Neighbours that take the space grow over the gone pane's last picture; a neighbour whose left/top edge moves carries its text | 167 ms |
| Resize by key (`<C-w>< > + -`, `resize-pane`) | same as split | The edges that moved, by a cell or a few | 83 ms |
| Resize drag (a boundary) | each committed step | The boundary goes to tmux's or Neovim's committed cell boundary, never to the pointer. Each step retargets from the current visual position | 83 ms per step |
| Equalize (`<C-w>=`, `select-layout`) | same | Every edge that moved, on one clock | 167 ms |
| Zoom (`resize-pane -Z`) | `%layout-change` with the zoomed flag | The zoomed pane grows to the window over the others, which stay in place under it and are dropped at the end | 250 ms |
| Unzoom | same | The other panes are back in place under the zoomed pane, which shrinks to its rectangle and uncovers them | 250 ms |
| Neovim maximize (`<C-w>\|`, `<C-w>_`) | resize | As a resize: every edge that moved | 167 ms |
| Swap, move, rotate (`bind m` = `move-pane`/`swap-pane`, `<C-w>x`, `<C-w>r`, `<C-w>HJKL`) | layout | The panes travel to each other's places, the active one on top; where they part, the surface's ground shows for the moment | 167 ms |
| Window switch (tmux) / tab switch (Neovim) | `%session-window-changed`; `tabline_update` and a new set of windows | Nothing moves. The new window is drawn at its final layout over the old one and fades in (opacity only). The window strip's pill or the tab strip's current tab moves on the same clock | 83 ms, linear |
| First attach, surface resize, a pane hosting a Neovim overlay (below), reduced motion | | Nothing: the layout is placed at once | 0 |

Why each value:
- **167 ms for structural changes**: WinUI's `ControlFast` and the
  shortest point-to-point duration. 90% of the way is done at 77 ms, so
  even fast typing sees the new layout essentially at once, while the
  eye can still follow where the space went.
- **250 ms for zoom**: `ControlNormal`. The travel is the whole window,
  about twice a split's. It is Windows' maximize and restore, which the
  person singled out.
- **83 ms for resize steps and the drag follow**: `ControlFasterAnimationDuration`.
  Steps are a cell or a few. At 83 ms each step is mostly done before the
  next one arrives (a drag at speed commits about every 16–30 ms), so
  the boundary trails the pointer by about the round trip and no more.
  When the hand stops, the boundary lands on the last committed cell
  within 83 ms.
- **83 ms linear for window and tab switches**: Windows' "bare minimum"
  fade. A switch is a jump in place, not a move, so nothing travels.
  Hyprland's `workspaces` default is also a fade (194 ms); we use the
  shorter one because the switch is frequent and the doubled text of a
  fade lasts about five frames at 83 ms.
- **No separate exit curve**: a gone pane does not animate itself. It is
  covered. So "direct exit" and "gentle exit" do not apply.

## Content: the final grid, clipped

Each pane's canvas is resized and drawn at its final grid size once, when
the layout commits. That is exactly what happens today without motion.
- Neovim sends the new `grid_resize` and rows in the same flush.
- On tmux, the engine resizes at `%layout-change` and the program's own
  redraw follows after SIGWINCH.

During the transition the pane's clip is wider or narrower than that
canvas. Where the clip is larger, the pane's ground shows (its
`placeGrounds`/`placePanes` ground). Where it is smaller, the canvas is
cut.

This was chosen over the other two treatments, as seen in the mocks:
- **Scaling a snapshot** (Hyprland's behaviour) stretches glyphs, which
  is the cheap look. It also has to swap the snapshot for the live grid
  at the end, a visible change at the moment the motion should be
  settling. Anything typed meanwhile is hidden until that swap, which
  feels like a delay even though input was not held.
- **Crossfading** old and new doubles the text mid-transition. It also
  needs a copy of every pane and two canvases per pane to composite.
- **Clipping the final grid** keeps every glyph crisp on the device
  pixels it will keep. It needs no copy: gone panes keep their own
  canvas. What is typed appears where it stays. The last frame is the
  resting frame with no swap.

The only content change is at the first frame: the grid has its new
size. That is tmux's or Neovim's change, not the motion's, and it happens
just the same with motion off. A tmux program that has not redrawn yet
shows the engine's reflow of its old screen until it does, as today.

## Endpoints

- The start is the visual state: the rectangles and origins the last
  drawn frame used, kept in the transition, never read back from the
  DOM.
- The end is the committed layout, placed by the code that places panes
  at rest. When `now ≥ t0 + duration`, the transition is dropped and that
  path runs. The curve's value at the last rAF tick (often `t` = 0.97)
  is never what is left on screen.
- The curves are monotone within [0, 1], with no overshoot. Springs are
  ruled out: they pass the endpoint and have no fixed end time.
- Device-pixel snapping is per edge, from the same values the resting
  path rounds. The first and last frames are pixel-identical to the
  layouts at rest.
- Checked by a test, the way the slide and scroll are: drive the
  transition with a fake clock to its end and compare every pane's
  placed rectangle with the static placement of the committed layout.
  It must be equal, not approximately equal.

## Interruption

A layout committed during a transition starts a new transition:
- from each pane's current visual rectangle and origin;
- to the new committed one;
- with a new `t0` and the new change's duration.

Roles are worked out again. A pane gone in the previous transition and
back in this one (a split undone within 70 ms) is a keep pane from its
last picture's place. Position is continuous. Velocity is not carried
over: the point-to-point curve starts at moderate speed, so a reversal
reads as a turn, not a jolt. This is what makes the resize drag smooth:
each committed step retargets from wherever the boundary is.

Neovim can send one command's layout over several flushes, for example
a split whose autocommand opens another window. Each flush retargets.
There is no waiting to see whether more is coming, because that would
delay the first frame.

## Input during a transition

- **Keys** go out at once: the keyboard path is untouched. Neovim's or
  tmux's answer paints into the final-size canvas, which is on screen.
- **The cursor** is in its grid's clip (`GridPainter.over`), so it moves
  with its pane's content. It does not glide across a layout change: the
  active pane changes at the commit, as the cursor's row already does
  for a scroll.
- **An IME preedit** is drawn by the painter at the cursor in the
  grid's coordinates, so it rides the same way and stays on the cells it
  will take.
- **The mouse** hits what is drawn. A press is mapped through the
  visual rectangle and the glued content origin of the keep or new pane
  under the pointer to that pane's cell, clamped to its committed grid.
  A gone pane's picture takes no clicks. A boundary drag that starts
  mid-transition starts from the boundary as drawn. Because the content
  is glued and the final grid is what is drawn, the cell under the
  pointer is the cell tmux or Neovim will act on.

## Reduced motion

`prefers-reduced-motion: reduce` (macOS: Accessibility, Display, Reduce
motion) gives every transition a duration of 0. The layout is placed at
once, with no fade, like the line slide and the cursor glide today. It
is read on every commit, and a change during a transition ends that
transition at once.

## Performance budget and the layer model

Per frame a transition only writes `transform` and `opacity`:
- no `left`/`top`/`width`/`height`;
- no canvas resize or repaint;
- no `getBoundingClientRect`.

The canvas is drawn once at the commit, as it is today. Everything else
is the compositor's work: moving layers it already has. Main-thread
cost is a few transform writes per pane per frame, well under 1 ms for
a dozen panes. That leaves the frame to the painter's own flushes,
including the tmux pane redrawing after SIGWINCH, which arrives during
the transition. Durations are in milliseconds from `requestAnimationFrame`
timestamps, so a 120 Hz ProMotion display gets twice the frames and the
same timing, and a dropped frame shortens nothing.

A clip whose four edges move cannot be done with one element's
`transform` without scaling its content. It is done with two nested,
fixed-size, `overflow: hidden` boxes, each the surface's size, set once
per surface resize:

```
pane motion group                   one per window or pane, in its level
└ clip TL  translate(L, T)          cuts left and top
  └ clip BR  translate(R − L − S, B − T − S)   cuts right and bottom (S = surface size)
    ├ ground                        the pane's ground (placeGrounds / placePanes)
    ├ edge lines                    the pane's boundaries, while in motion
    └ content  translate(origin − clip)   the grid level parts: canvas or scroll port,
                                    riders, cursor and covers clips (GridPainter.over)
```

Every translate is linear in `p`, so all of them follow the same curve.
At rest all are identity, and the static placement is what places the
parts, so the resting DOM is what it is today. Rejected alternatives:
- `clip-path: inset()` changes force a repaint of the layer in Chromium.
- Scaling the outer box and counter-scaling the inner needs the
  counter-scale recomputed every frame anyway, and invites rounding
  shimmer on text.

What this asks of the layer model, which follows from
`docs/rendering-layers.md`'s rule:

- **One group per window or pane.** Today a window's parts (`PART_Z.pane`
  ground, grid, riders, cursor, covers, `boundary`) are siblings in its
  level. Motion needs them under one element that can be transformed,
  with `PART_Z` keeping their order inside it. The tmux surface's panes
  need the same group around their ground, grid and outline.
- **Boundaries ride their panes while in motion.** At rest a boundary
  is one hairline on the shared edge (`boundariesOf`). In motion the
  shared edge may not exist, as when a split's new boundary travels with
  the pane's edge. So during a transition, each pane draws the boundary
  segments it touches as lines centred on its own edges, in its group.
  Two panes on one edge draw the same opaque line on the same pixels,
  which looks like one line. A new pane's lines are under the keep
  panes until uncovered. At the end the shared boundaries are placed
  again, pixel for pixel the same. The active pane's outline (2 px,
  centred) is drawn by the active pane, over the others.
- **The status line moves with its window.** Neovim's multigrid draws
  every window's status line on grid 1, which does not move. In motion,
  a window's status line row must be part of that window's group: a
  strip of grid 1 drawn into the window's group, or the window's own
  canvas row. Otherwise the bars stay behind while the windows move.
  With `laststatus=3` there is one status line, which stays on grid 1.
  The winbar is in the window's grid already.
- **Floats** anchored to a window (`relative='win'`, `bufpos`) are placed
  from that window's visual origin during a transition, as riders are
  placed from its scroll. Editor-relative floats (`relative='editor'`,
  the command line, popups) stay where Neovim puts them.
- **Neovim drawn over a tmux pane** is a separate `WebContentsView`, placed
  by main from `reportTerminalPanes`. The page's compositor cannot move
  it, and `setBounds` every frame would be a relayout across processes.
  Until that Neovim is drawn in the terminal's page (rendering-layers,
  "Hide-to-make-room"), a tmux layout change in a window with such a pane
  is placed at once. That keeps the overlay and its pane together. A
  cut is better than a Neovim that jumps while its pane glides.
- **Bands are untouched.** The command line, popup, menu and preedit
  bands are over the editor band and do not move with panes.

## Mocks

Made for this design, with Japanese notes. One page runs three variants
side by side on the same layout changes. Its controls are 1/4 and 1/10
speed, an interruption (the reverse change 70 ms later), keys typed
right after the change, and the committed rectangles drawn over the
motion.

- **A, Windows 11** (chosen): point to point, 167 ms (zoom 250, drag
  83, switch 83 ms linear fade), final grid clipped.
- **B, Hyprland's defaults as they are**: easeOutQuint 479 ms, new panes
  popping in from 87% over 410 ms, gone ones 149 ms linear, snapshots
  scaled.
- **C, a short crossfade**: DevHub's slide curve at 120 ms, old and new
  crossfaded. For the drag and the switch, C is no motion, which is
  today's behaviour.

The recordings were made with a fake clock frame by frame at 60 fps.
They show:
- B's stretched text and its late swap, with the typed `ls -la` hidden
  until the swap;
- C's doubled text;
- A's panes stopping on the committed rectangles with 0.00 px
  difference;
- every variant taking the interruption from where it was.

## Recommendation

Variant A.
- One curve: `cubic-bezier(0.55, 0.55, 0, 1)`.
- Durations: 167 ms for splits, closes, swaps and equalize, 250 ms for
  zoom, 83 ms per step while resizing, an 83 ms linear fade for window
  and tab switches.
- The final grid clipped, content glued to the top-left, keep panes
  over new and gone.
- Transforms only, retargeting from the visual state, 0 ms under reduced
  motion.

Before it is built:
1. A group per window or pane.
2. Boundaries and status lines that ride their window in motion.
3. The endpoint test above.

Then to be checked on the person's Mac at 2× and 120 Hz, against
`:vsplit`, `<C-w>=` with four windows, `resize-pane -Z` with a busy
pane, and a boundary drag.
