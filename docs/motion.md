# Motion and stability

How anything in DevHub may move on screen, and what must hold still. Every
page follows it: the conversation, the Sidebar, the Orchestrator, the
pickers, the notices, Settings — and the terminal and Neovim surfaces, whose
own design (`docs/pane-motion.md`) is these rules applied to panes.

What the person asked for:

> 全体としてちょっとずつガタガタ感というか不安感があるところがあると思う。たとえばメッセージを送信したあとアニメーションではいるのにその後（追加の要素が入って？）clsみたいにガタついたり。アニメーションの始点と終点がしっかり一致して停止しなきゃいけない。手になじむ道具であるためには不安にならない、例えばワープしないとか驚かないとか、そういう一貫した手触りがすごくだいじ

## The rules

1. **Nothing moves unless the person caused it, or new information arrives
   in a predictable place.** A sent message, an answer growing at the end
   of a transcript, a card that changed lanes because its escalation did:
   these move. A row that a late element pushed, a column that narrowed
   because a scrollbar appeared, the transcript sliding because a button
   left: these do not, ever.
2. **Everything moves once per cause.** One change, one motion. An element
   that lands and then is nudged by something that arrived a frame later
   has moved twice; the second motion is a bug, and its cause is fixed
   where it starts (below), never covered by an animation.
3. **Start and end are real layout positions.** An animation starts where
   the element was _seen_ and ends where the layout _put_ it, to the
   pixel, and then stops. Its last frame is the layout at rest, not a curve
   value; nothing snaps at the end of a motion.
4. **Only transform and opacity animate.** Never `top`, `left`, `width`,
   `height`, `margin`, `padding`, `max-height`, `grid-*`, `flex-*` or
   `font-size`. A change of place or size is laid out at once, at its final
   value, and _shown_ moving with FLIP (below). The three exceptions are
   written beside their rules and in `motionRules.test.ts`: a disclosure's
   own height (`details::details-content`, which moves only what is under
   the person's click), a sidebar row collapsing as it leaves (`row-exit`,
   which ends at zero, where the layout ends too), and the Smart Buttons'
   box settling onto the spot it was dropped near (absolutely placed, so
   its place moves nothing else).
5. **Input is never delayed.** No key, click or scroll waits for a motion.
   Filter results, a typed character, a selection: drawn in the frame they
   happen. A motion is decoration over a layout that is already final.
6. **Reduce Motion is respected.** The motion tokens take every distance
   and scale to nothing (`tokens.css`), so arrivals only fade; glides do
   not run; loops stop. State changes stay visible.

## What may animate

The tokens in `apps/desktop/src/shell/styles/tokens.css` are the only
durations and curves:

| what                                                                | duration                                        | easing            | moves                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| hover, press, focus edge                                            | `--motion-fast` 120 ms                          | `--ease-standard` | colour, `scale()` on press                                            |
| something arriving (an entry, a card, a notice, a line)             | `--motion-base` 180 ms / `--motion-slow` 240 ms | `--ease-enter`    | rises `--motion-rise` (6px), grows from `--motion-scale-in`, fades in |
| a popover                                                           | `--motion-base`                                 | `--ease-enter`    | from `--motion-scale-popover`, half a rise                            |
| a small control popping in (Stop, the way back to the end, a check) | `--motion-slower` 320 ms                        | `--ease-pop`      | from `--motion-scale-pop`                                             |
| something leaving                                                   | `--motion-exit` 140 ms                          | `--ease-exit`     | fades, half a rise, in place                                          |
| a change of place (FLIP glide)                                      | 240 ms (`GLIDE_MS`)                             | `--ease-standard` | `translate()` only                                                    |
| a transcript following an entry that arrived (`followGlide.ts`)     | 167 ms (`FOLLOW_GLIDE_MS`)                      | WinUI's point to point `(0.55, 0.55, 0, 1)` | the transcript's `translateY()` only                  |
| a disclosure opening or closing                                     | `--motion-slow`                                 | `--ease-standard` | its own block size                                                    |
| panes and Neovim windows as their layout changes (`docs/pane-motion.md`) | 167 ms (zoom 250, a key's step 83, a drag 0; a window or tab switch WinUI's slide, 300 ms) | WinUI's point to point `(0.55, 0.55, 0, 1)` (`paneMotion.ts`) | `translate()` of nested clips and content, `opacity` |

Repeating motion (the activity dots, a spinner) is what something is doing
now; it is the only motion with no end, and it stops under Reduce Motion.

A theme change is not a motion: the new colours land in one frame
(`applyPalette` turns transitions off while the variables change).

## Start and end equal the layout

An enter animation is a keyframe _from_ an offset _to_ nothing: it ends on
whatever the layout is when it ends, so content arriving during it is
followed. What is forbidden is an animation whose end is a number computed
before the layout settled.

A change of place uses FLIP, measured against the committed layout:
`apps/desktop/src/shell/glide.ts` (`useGlide`). After a commit each keyed
leaf is measured where the layout put it — in its container's _content_,
so a scroll is not a move, and with its own transform taken off, so a
running glide is not mistaken for the layout. One that was elsewhere is
translated back to where it was _seen_ (its last place plus how far a glide
still running had it) and let go. A change mid-glide therefore starts from
exactly where the element is drawn, and every glide ends on the layout.
Name leaves, never their containers, or a child glides twice. The
Orchestrator board uses it for its cards and lane headings.

Anything positioned from a measurement (the Smart Buttons on the
composer) is placed in the frame the measurement changes in — a
`ResizeObserver` answer is rendered with `flushSync` — or it trails what it
stands on by a frame through every resize.

## Views main moves

The window is several pages, each in its own view, and main lays them out
(`windowLayout.ts`). A view's picture is its page's last frame, drawn for one
size. Moved at its size, a view lands exactly, in the same frame as every
other view; resized where it stands, its old picture stays where it was
until the page catches up. Moved _and_ resized — every content view when the
Sidebar collapses or expands, the Agent half entering or leaving a split,
the Orchestrator's conversation beside its board — the old picture is drawn
at the new place until the page has drawn again: the conversation showed
209px off for one to three frames.

So a change of arrangement moves such a view in two exact steps
(`ShellWindow.staged`): it is resized off the window, its page says when it
has drawn at that size (`settleLayout`, answered by every page's preload),
and it is then moved to its place at that size. Between the two its place
is the content area's empty ground for a few frames — never a picture in the
wrong place — and a page that does not answer within 200 ms is not waited
for. A divider being dragged and the window being resized are followed
frame by frame instead: holding a view back at every step would blank it the
whole way, and a view that fills the content area keeps its origin through a
window resize, so only a split's Agent half moves there, by its share of
each step.

Measured on Xvfb at deviceScaleFactor 2, 60 fps screen captures: the
Sidebar toggled over a conversation drew it 104–209px off for 1–3 frames
each way before; after, no frame shows a view off its place, and the
content area is empty for 2–4 frames. The same holds over a split and the
Orchestrator's board.

## Following new entries

Each entry that arrives in a conversation — a message, a Bash command, a
tool call, an answer, a request — comes in from below, and the transcript
following it is shown moving, not jumping. Two motions, one per cause, each
with a deliberate curve:

- **The entry appears**: `conversation-rise-in`, the arrival every DevHub
  card and notice makes — it fades in from nothing while rising
  `--motion-rise` and growing from `--motion-scale-in`, on `--ease-enter`
  over `--motion-slow` (240 ms). An arrival decelerates: it is fastest when
  it is least visible and settles gently, so the eye lands on it at rest.
  Only entries `useFreshEntries` marks rise in: output arriving, a few at a
  time, never a history loading; and the mark is put on the element once,
  so text streaming into an entry afterwards never starts it again.
- **The transcript follows it** (only while it is following the end): the
  scroll position is set to the end at once — the real `scrollTop`, so the
  person's next scroll, find and "at the bottom" read the true layout — and
  the transcript is drawn translated back down by exactly how far the
  scroll moved, then let go to `none` (FLIP, `followGlide.ts`). The motion
  is a change of place, so it is the one DevHub's panes make
  (`docs/pane-motion.md`): WinUI's point to point curve, 167 ms. It starts
  at speed, so the follow reads as the lines being pushed up by what
  arrived rather than a pause and a scroll, and stops hard on the layout
  with no overshoot. It is shorter than the fade, so the entry is in its
  place while it is still finishing appearing; together the entry slides up
  from under the composer and fades in.

The rules that keep it exact:

- **Interrupted, it starts where it is drawn.** Entries arriving in quick
  succession each start a new glide from the transform the running one has
  at that moment (read off the computed style) plus the new scroll
  distance, and every glide ends on `none`. Nothing jitters, nothing warps,
  and the end is the layout to the pixel.
- **Not following, nothing moves.** A transcript the person has scrolled up
  in is held by scroll anchoring as before; what arrives rises in at the
  end, out of view, and "New output" says so.
- **Streaming is followed by the scroll alone.** An answer growing token by
  token is not an arrival; the end is followed as it was, under any glide
  still running.
- **The glide never lengthens the scroll.** A translated box counts towards
  its scroller's overflow, so the transcript sits in `.conversation-follow`,
  which clips its block overflow (`overflow-y: clip`, not a scroll
  container): what the glide moves past the end is under the composer.
- **A jump is a jump.** The way back to the end, a send from far up, a pane
  shown again: any running glide ends on the layout first, and nothing
  that arrived while the pane was set aside glides when it is shown.
- **Reduce Motion:** the tokens take the rise and scale to nothing, so an
  entry only fades, and the follow is the jump it always was.

## Reserved space for late content

What will appear later has its room already, at its final size:

- **A placeholder is the size of what replaces it.** The "sending" bubble
  carries the empty actions row and the spacing its echo will have, so the
  echo takes its place without moving anything.
- **What comes and goes with a state keeps its room.** The activity line's
  room is kept while no turn runs (`conversation-activity-slot`); the
  composer's footer row keeps a line for the context readout.
- **What floats keeps no room.** The Smart Buttons on the composer and the
  way back to the end float over the transcript's last lines; the
  transcript ends right above the composer. (A reserve for the buttons,
  held at the most they had ever taken, was a gap at the foot of every
  conversation, and was removed.)
- **A row's parts are there from the row's first frame.** An answer's
  Copy row is drawn with its first block of text, empty or not.
- **Images have a size before they are decoded.** A thumbnail is a fixed
  tile with the picture scaled down inside it. Every other picture is drawn
  by `Picture.tsx`: one drawn from its own bytes has its size read off its
  header (`imageSize.ts`: PNG, GIF, JPEG, WebP, BMP, SVG) and is given
  `width` and `height`; one whose size is not known yet — a file an answer
  embeds while it is read, a picture in a line or a table cell, a Markdown
  image from the web — is a box of a fixed shape (4:3, the shape most
  charts a script draws have) from its first frame, with the picture
  scaled down into it. Its one rule: a picture taller than the box deepens
  it, once, at its foot, to at most a square; nothing else ever changes it,
  and a decode changes nothing. Measured with an answer embedding a 4:3
  PNG and a portrait screenshot in a table: what followed them jumped 488
  and 706px in one frame before; after, nothing below them moves.
- **An escalation's composer keeps its quick replies' row** while its
  question has none, so a question with options arriving fills the row
  (each reply rising in, in its place) instead of lifting the composer's
  top edge 32px in one frame; measured, its layout shift went from 0.0027
  to 0.
- **Skippable content is born visible.** `content-visibility: auto` lays a
  new element out at its placeholder size (`contain-intrinsic-size`) for a
  frame; the last chunk and the transcript's last lines are never skipped.
- **A scrollbar never takes room it did not have.** DevHub's scrollbars are
  styled, so never overlays, on the Mac too: every list that can grow
  keeps the bar's gutter (`scrollbar-gutter: stable`; `both-edges` where
  the column is centred).
- **Skeletons equal the content.** A loading state is the height of what
  loads into it, or the place is empty until the content is ready.

## Scroll anchoring

A transcript follows its end while it is at the end, and stays exactly
where it is otherwise (`followScroll.ts`). Scrolled up, the browser's own
`overflow-anchor` keeps the line being read still while things above it
change; following, the end is the anchor and `overflow-anchor` is off. New
output is followed by the scroll, shown as one glide of the whole transcript
when an entry arrived ("Following new entries"); entries never move
relative to one another. Anything
that changes the transcript's length without new output (a reserve, a
status line) must not change it at all — see the reserved-space rules —
because a followed transcript moves by every pixel of it.

## No surprises

- New information arrives where the person expects it: at the end of a
  transcript, at the top of a ranked lane, in the corner for notices.
- Nothing appears from nowhere: what arrives rises and fades in, in its
  final place. Nothing leaves by teleporting others: what leaves fades in
  place, and what was under it closes up once, by a glide where the
  surface has one.
- Coming back to a page does not replay its arrivals (`useNoReplayOnShow`).
- A history loading is drawn as it is, not animated in.

## Guard tests

- `apps/desktop/src/shell/styles/motionRules.test.ts`: no `@keyframes`
  and no `transition` in a DevHub stylesheet moves a layout property,
  outside the three written exceptions. The terminal, Neovim and
  completion stylesheets are held to it too: the Neovim cursor glides by a
  `translate` from where it was seen to its cell (`glideCursor`), never
  across a scroll; a notification line rises and fades in at its full
  height and fades out in place; the completion and tmux menus keep their
  bar's gutter. Panes moving as a layout changes are
  `docs/pane-motion.md`'s, held by `paneMotion.test.ts`,
  `controlMotion.test.ts` and `windowMotion.test.ts`: every transition
  ends on the resting placement exactly.
- `apps/desktop/src/shell/glide.test.tsx`: a glide starts where the
  element was and ends on its place; what is new rises; Reduce Motion moves
  nothing.
- `apps/desktop/src/shell/conversation/picture.test.tsx`: a picture's size
  is read off its header; a picture whose size is known has it on the
  element, and one whose size is not is a box of the same shape before and
  after it arrives, deepened only by a taller picture.
- `apps/desktop/src/main/shell/shellWindow.test.ts` and
  `windowLayout.test.ts`: a view moved and resized by a change of
  arrangement waits off the window at its new size until its page has
  drawn, then lands at that size; a drag is followed at once.
- `apps/desktop/src/shell/agents/orchestratorScreen.test.tsx`: the answer
  composer keeps its quick replies' row while there are none.
- `apps/desktop/src/shell/conversation/followGlide.test.tsx`: following an
  entry that arrived glides from where the transcript was seen to `none`,
  on the point to point curve; an interrupted glide starts from the drawn
  offset plus the new distance; streaming growth, a transcript scrolled up
  and Reduce Motion do not glide.
- `apps/desktop/src/shell/conversation/stability.test.tsx`: the "sending"
  bubble has its echo's structure (so its height), an answer's Copy row is
  there from its first block, the activity line's room is kept, and Copy
  keeps its place when Rewind comes and goes.

Measured in the running app — layout-shift entries and every element's
place frame by frame, plus the screen — sending a message in a GUI
conversation went from a cumulative layout shift of 0.596 to 0.034 (what
remains is the answer growing at the transcript's end), with no entry
above the end moving after it has landed.

## Known, not yet fixed

- **A divider being dragged, and a split's Agent half through a window
  resize,** move a view and resize it at every step, and each step can show
  the view's previous picture at its new place for a frame — off by that
  step's distance, a few pixels. Holding the view back at every step would
  blank it for the whole drag (see "Views main moves").
- **Quick replies that wrap.** An escalation's composer keeps one row of
  room for its question's options; options that need a second row still
  lift its top edge by that row when they arrive.
