# The window, its children, and what each of them may say

DevHub is one window with several web contents in it. This is what owns what.

It is written as the answer to five questions that used to have more than one
answer each: where anything is drawn, what each page may ask for, where a
failure goes, where the keyboard is, and what happens when something goes
wrong. Every one of them is now decided in exactly one place.

## One layout owner

`main/shell/windowLayout.ts` is a pure function from the window's size and the
arrangement to a list of children — each with a rectangle, a visibility and a
position in the list. **The list's order is the z-order**, lowest first:

    the window's own page → the Sidebar → every workbench (the one on screen
    last among them) → whatever those workbenches attached to themselves →
    the Agents → the notices → the questions → the tooltip

The tooltip is on top of everything, the questions included. Not because it
may stand over a modal — it may not: a question coming up takes the tooltip
down, and that is the window's own rule rather than the pointer's, because a
question opened from the keyboard leaves the pointer exactly where it was. It
is last because it hides nothing — the view is the size of the box it draws
and is out of the child list altogether when there is no tooltip up, so there
is nothing for it to be underneath.

It does take a click, which it used not to. The box draws a row's facts, three
of which name pages on GitHub, and it draws those as the same links the row
draws; so it has to be something the pointer can enter. That the box stays up
while the pointer is in it is arbitrated in **main** (`tooltipView.ts`), not in
either page: the row and the box are different views, the Sidebar's leave is
identical whether the pointer went into the tooltip or off to the editor, and
the tooltip page never hears of the row. The Sidebar sends a *request*
(`releaseTooltip`), main holds the box for a short grace, and the tooltip
page's own report of where its pointer is decides. Everything that is not
about the pointer — a scroll, a resize, the window losing focus, a modal
opening — still takes it down at once.

`ShellWindow.layout()` is the only thing that reads it, and it is the only
thing that calls `setBounds` or `setVisible` on anything. Nothing else in
DevHub has an opinion about where a view is.

**A `WebContentsView` inside another `WebContentsView` is not painted.** On
macOS with this Electron a nested view is not composited at all: its renderer
runs at the display's full rate and reports itself visible, and nothing
appears. The same view, at the same rectangle on screen, added to the window's
own `contentView` draws and animates. Nothing automated can show this —
`win.capturePage()` does not include child views either — so it is written
down here rather than guarded by a screenshot test, and the tests that stand
in for it are about the *shape*: what a workbench attaches ends up in the
window's child list and never in the workbench's own.

So every view in this window is a **sibling**, including the ones a workbench
opens for itself — VS Code's integrated Browser
(`workbench.action.browser.open`) is the one that exists today. It is a child
kind of its own, `attached`, ordered immediately after the workbench it
belongs to and below everything the shell draws over the content area.

`WorkbenchView.contentView` is what makes that possible without a second
owner of the layout. VS Code believes it is the window's content view; it is a
container that registers what it is given with `ShellWindow` and wraps that
view so the two things VS Code says about it become *wishes*:

- the rectangle its renderer measured, which is in the **workbench's own
  document** — the only frame a renderer can measure in. `windowLayout()`
  translates it by that workbench's rectangle and clips it to it, so the
  browser follows the Sidebar, the split and the window's size with no round
  trip through any page, and can never draw over the Sidebar or an Agent's
  pane;
- whether VS Code wants it drawn, which is half the answer. It is drawn when
  that wish is true *and* its workbench is the one on screen, so selecting
  another Workspace takes it away and coming back brings it back where it was.

The workbench going away takes everything it attached out of the window with
it; nothing else would.

No page measures anything the owner decides. The window's own page used to
leave a hole for the workbench, measure it with a `ResizeObserver` and report
it back, which made main's idea of the layout a page's idea of it one frame
late and made every window resize a round trip through a renderer. Now main
computes the rectangle and *tells* the page (`workbenchAreaChanged`), and the
page draws its own states into the same rectangle the workbench is laid into.

**A page's own box is not the window.** `window.innerWidth` inside a
`WebContentsView` is that view's width, and it is stale for a while after main
moves it — measured on an isolated instance, the Sidebar's view was narrowed
from 249px to 76px and went on answering 249 for seconds. Nothing in DevHub
reads it; where anything is, is `windowLayout.ts`. Every child page's header
says so, because the next page is the one that will not know.

## The pages, and what each of them may say

Seven entries, seven preloads, seven bridges. There is no `?window=` role and
no runtime question about which page this is: **which page this is, is which
file main loaded.**

| Page | Entry | What it draws | What it may ask for |
|---|---|---|---|
| the window's own page | `index.html` | the title bar, the drag strip, the three states in which there is no child view to show, the seam of a split | the projection, the appearance, the window's name, the workbench area, `openModal`, `closeWorkspace`, `chooseWorkspaceFolder`, `openSettings`, `previewLayout` |
| the Sidebar | `sidebar.html` | the leading column: workspaces and their agents, the rail, the row menu, the drag-reorder, the resize handle | the projection, the appearance, the agent profiles, the repository status, its own rectangle, `menuCommand`, `openModal`, `closeWorkspace`, `openExternalUrl`, `previewLayout`, `focusSurface`, `showTooltip`, `hideTooltip`, `releaseTooltip` |
| the Agents | `agents.html` | every running Agent's pane, all mounted, the selected one not hidden | the projection, the appearance, the repository status, the agent actions, the terminal transport, `openModal`, `openExternalUrl`, `writeClipboard` |
| the notices | `toasts.html` | what the application has to say, over whatever is on screen | `nativeError`, `appCondition`, `actionStarted`, `menuCommand`, `reportListening`, `reportNoticeRetired`, `reportToastsSize`, `retryApp`, `openSettings` |
| the tooltip | `tooltip.html` | one box with a row's facts in it, over whatever is on screen; the facts that name a page are links | `tooltipText` in; `tooltipSize`, `tooltipPointer` and `openExternalUrl` out. **Nothing else** — in particular not the anchor or the side, which are the owner's. |
| the questions | `picker.html` | every sheet DevHub stops on, over every workbench | `modalsChanged` **(only here)**, the projection, the agent profiles and actions, every way of opening a Workspace, the two ends of a reviewed message, the worktree close, `closeModal` |
| Settings | `settings.html` | its own window | `SETTINGS_CHANNELS` in full, plus the failure contract every page has |

Every one of them also has `raiseFailure` and `onTheme`, which is what "a
DevHub page" means.

**The preload is the enforcement.** `ipc/contract.ts` states each page's bridge
as an interface; `preload/<page>.ts` builds exactly that object and exposes it;
`scripts/build-preloads.mjs` bundles each one on its own, because a sandboxed
preload is one CommonJS file with no module resolver behind it and cannot
`require` a shared chunk. A member a page does not own is not refused at
runtime — it is *absent*, which TypeScript can say and a running page cannot
work around.

That is not tidiness. `devhub:modals-changed` is sent to the picker view
directly rather than through `send()`, so `onModals` on any other bridge was a
listener on a channel nobody was ever going to write to: spellable, silent, and
indistinguishable from a bug in the modal layer. Now it is unspellable
anywhere else, and confirmed so on a running instance.

**Every page in the window runs at one moment, after the runtimes.** The
window and its child views are built early — the controller is built around
the window, and it paints while startup goes on — but no page is loaded until
`ShellWindow.openPage`, which `bootstrapShell` calls once `startRuntimes` has
registered what the pages will ask for, and which runs the window's own page
and every child's together. A page asks the moment it mounts: the Agents page
attaches every running Agent's terminal, and an attach that arrives before the
terminal handlers exist is refused by Electron ("No handler registered for
'devhub:terminal:attach'"), which the pane draws as "The terminal session is
not connected." Only the window's own page used to wait; the Agents page ran
from its view's constructor, so an Agent restored at launch came back
disconnected — and, having no attachment, sent none of its geometry to tmux.
What main has to say before any page exists (a settings file that will not
parse) is held until the notices page says it is listening
(`reportListening`), not until some page asks for the snapshot: the pages start
together, so another page's request says nothing about whether the notices page
can draw yet.

**An Agent pane that comes on screen disconnected reconnects once, on its
own.** Being shown is a request to use it, so `TerminalSurface` retries the
attach on the hidden-to-shown transition when the pane is disconnected — one
activation, one try. If that try fails, the pane is what it was: the error and
Retry, and nothing tries again until the person presses Retry or the pane is
shown again. There is no timer and no counter; the rule is the transition. A
pane mounted on screen needs none of it, because its mount's own attach is that
try.

Each page has a provider of its own holding exactly that contract
(`ShellPageContext`, `SidebarContext`, `AgentsContext`, `PickerContext`), built
from the shared per-projection hooks in `shell/model/pageModel.ts` so that "the
snapshot" means the same subscription and the same revision ordering
everywhere it appears.

## A close asks once, then acts

Closing a Workspace asks every question it has before it does anything, and
then asks nothing. What it would lose — busy Agents, running terminals, and
the workbench's unsaved editors, by the names their tabs show — is one
confirmation on the picker (`close-confirmation`); a dirty worktree is the
three-way sheet before it, because whether the folder survives decides whether
there is anything left to close. A workbench whose unsaved editors could not be
read is said to be so on that sheet and is never read as clean. When the close
removes a worktree, the confirmation carries that disposition and the sheet says
so in a "Worktree" row: a clean worktree with unsaved editors stops only here.

Once the person has chosen to close, the close carries the answer out:
`closeEditor` discards the workbench's unsaved work (the request
`patches/vscode/0004-devhub-reads-and-discards-unsaved-editors.patch` adds),
and only then unloads it. Unloading first made VS Code raise its own "do you
want to save?" as a second question in the middle of an answered close, and the
close sat at "closing" until its deadline with that dialog stranded over it.
Every request a close makes to a workbench has a deadline, and a step that
fails reaches the person down the one failure path below.

## Failures go one way

A failure is an event, not a description, and a page that is told one and has
nowhere to put it can only hand it back — which is what made it go round main
and the page forever.

    something fails
      → the page it began on raises it, once (`raiseFailure`)
      → main journals it (`publishError`)
      → main publishes it to the page that *draws* failures

The page-side half of the rule is the other half: **what arrived is drawn and
never raised again; what began here is raised and never drawn here.**

`main/shell/publishAudience.ts` is the only thing that decides who is told.
App-scoped failures go to the `toasts` view — a page with no model, no
snapshot and nothing else that could fail while it is telling you something
failed — and it is a child of the shell window, so a notice is drawn *over* a
workbench, which the window's own page could never do.

The Settings window is the one exception, and it is about being seen rather
than about routing: a failure that began there is drawn there, because a report
about the window the person is looking at, drawn on a window they are not, is a
report nobody reads.

## The palette is a third audience

There are three kinds of thing main says, not two. A *projection* describes the
model and goes to every page that draws from it. A *failure* is an event and
goes to the one page that draws failures. A *palette* is neither: it is how
everything in the window is painted, and it goes to every page DevHub draws
chrome on — which is all seven.

That last one used to go out on the projection audience, which coincided with
"every page that draws chrome" until the `toasts` page arrived: it has `onTheme`
on its bridge, no model behind it, and had therefore never been recoloured at
runtime. Nobody noticed, because a stale palette is only visible after a theme
change. The tooltip would have been the second page with the same silent gap —
the Sidebar *is* in the projection audience, so the tooltip it used to draw
recoloured correctly, and one on its own page would not have. `chromeAudience`
states the rule instead of it being a coincidence, and the test on it is that
every page with `onTheme` is in it.

Three scopes survive underneath this, and they are about *subject* rather than
about routing: an Agent's own failure is drawn over that Agent's pane, a
Workspace's over its surface, and the failure that stopped a page from starting
fills that page, because there is nothing behind it to draw instead.

## The keyboard

`ShellWindow.placeKeyboardIn` is the only `webContents.focus()` call in DevHub,
and `keyboardChild(layoutInput())` is the only answer to "where do the keys
go". Focus is a function of the same state the layout is a function of.

`placeKeyboardIn` declines while any other window is in front — another app,
the Settings window, an undocked Web Inspector — because seven callers reach it
that are not a person asking DevHub to come forward. The one place DevHub comes
to the front is `raise`, called only from paths that carry a person's intent.

`focusHome.ts` is gone, all 125 lines of it. It existed because the Sidebar's
DOM and an Agent's DOM were in one document, so a click on a row left the
keyboard on that row while the Agent was what was on screen. Two views cannot
have that problem.

Measured in a split, with the Agent selected and the window key: the workbench
answers `document.hasFocus()` with `false` and the Agents view with `true` —
exactly one view at a time, in both directions. No view-level blur is needed.

Selecting a row in the Sidebar is the one thing that means two different things,
and which it means is on the event. **A pointer selection hands the keyboard
over**: somebody clicked a row — expanded or on the rail — and what they want
next is the thing they clicked, so the Sidebar asks for the surface and
`keyboardChild` answers with the editor or with the Agent's terminal. **A
keyboard selection stays**: somebody is standing in the Sidebar after
`Cmd+Q S`, and Return there chooses a row without leaving the list, because the
next ↓ has to still be a ↓. It is read off the activation — a click raised by a
pointer carries a `detail` of at least one, and a focused button activated from
the keyboard carries zero — rather than kept as a flag one handler sets and
another clears. Both go through `focusSurface`, the same door Escape uses, and
the ask is sent after the selection has been applied, because which child the
keys belong to is a function of the selection.

Where the keys go *inside* a workbench is the workbench's own business, with
one exception. `Cmd+Q J` landing on the editor — the toggle that went Agent →
editor — focuses that workbench's integrated terminal
(`workbench.action.terminal.focus`, which creates one when there is none),
because somebody leaving an Agent *for* the editor is going to the editor's
shell. Every other way of choosing the same workbench — a sidebar click,
`Cmd+Q N/P`, a digit, the pickers — leaves it wherever it was last typed into.

The intent rides on the selection (`focus: "terminal"` on the `select-context`
effect in `chords.ts`) and is run at the other end: `ShellWindow` arms
`focusTerminalOnArrival` and spends it inside `focusSurface`, once the keyboard
has actually been placed. It cannot be run where it is asked for — the
selection changes the model, the arrangement comes back up from the page, and
the keyboard is placed after that, so a command sent at the asking would focus
a terminal in a view the keys are not going to. It is not a timer either: it is
the one keyboard-placed moment, spent once. A workbench that is starting,
restarting or gone has no view to arm against and the intent is dropped — the
selection still happens — because a terminal in a window that is not there is
nothing to focus.

## Chords are answered in main

`keyboard.ts` installs `before-input-event` on every WebContents DevHub owns,
through `app.on("web-contents-created")`. That is the only place a chord can
work: it sits in front of every surface and is the only key event seen *before*
the IME, so a half-eaten chord never becomes preedit.

Because the handler is per WebContents and installed for all of them, arming a
chord in one view and completing it in another is one chord, and the split into
six chrome children cost it nothing. `focus_agent_pane`, `focus_sidebar` and
`dismiss_alert` used to be routed *to the page* because what they acted on was
drawn there; two of them are now plain "focus that view" calls in main, and
`dismiss_alert` is delivered to the page that has the notices.

## Two keys that are not chords

`Cmd+-`, `Cmd+Shift+-` and `Cmd+Shift+0` zoom the Agent panes' text: one pixel
smaller, one pixel larger, and back to the size the settings name. They are
answered in the same place chords are and for the same reason — main is in
front of every surface — but they are not chords, so they are not in the chord
table and not in the Chord Help sheet, which lists what `Cmd+Q` leads to.

They are decided **per web contents**, the way the Mac's editing keys are
(`main/shell/editingCommands.ts`, and `main/shell/terminalZoom.ts` beside it).
A VS Code workbench binds the same chord to zooming the window, so claiming
these keys for the application would take that away from every editor DevHub
hosts. The rule is one line: they mean a zoom **only on the Agents page**, and
everywhere else they are not touched. A modal is not an exception to that, it
is an instance of it — a question that is up holds the keyboard, so the
keystroke arrives from the picker's view and matches nothing. Main asks its own
picker once more before acting, because whether a question is up is main's fact
and not one to infer from a URL, and a key it declines is left alone rather
than swallowed.

**Matched by the physical key**, which is the opposite of the rule for a
chord's second stroke, and both rules have the same cause. `model/chordKeys.ts`
matches the character because `code` names positions by the US layout and a JIS
keyboard moves the bracket and quote keys. `Minus` and `Digit0` do not move —
and the character does: Shift and the key printed `-` is `_` on a US keyboard
and `=` on a JIS one. What the person means is the key they are looking at, so
the key is what is matched.

Plain `Cmd+0` is deliberately unbound, and an unbound chord over a terminal is
one the terminal gets.

**The size is one number, and it lives in main.** The zoom is an *offset* in
whole pixels from `[appearance] terminal_font_size`, kept in DevHub's own state
file (`terminal.zoom_offset`, schema version 9) because `settings.toml` is the
person's file and DevHub does not write it. Editing the setting therefore moves
the zoomed text with it, and reset is `offset = 0` — there is no copy of the
base anywhere to go stale. `model/terminalZoom.ts` holds the arithmetic and the
range, which is the range a terminal font size already had everywhere else
(9–24): a zoom that could leave it would be a second opinion about what sizes
exist, arriving at the pages as a projection the wire has to refuse.

No page changed for any of this. The offset is added to the setting in
`AppController.appearance()` and the pages are told the sum, on the
`terminalFontSize` they already draw — so zooming is the same event as editing
the setting, down to the re-fit and the tmux resize the changed geometry
causes, and there is one zoom for the terminal surface rather than one per
Agent because there is one appearance.

## Attention is the Dock

There is no ring drawn around the window. A DOM overlay in the window's own
page is behind every workbench view, which is to say hidden exactly when there
is something to say — so an unread Agent is announced by the *window*: a Dock
badge, and a critical bounce while DevHub is not in front. See
`main/shell/windowAttention.ts`.

## Drag regions belong to the window's own page

A drag region is not a CSS hit test. Electron collects its rectangles from
layout and hands them to macOS, which takes the mouse before any page sees it —
and it collects them from the **window's own** web contents. Whether a region
declared inside a `WebContentsView` composes into the same handle is not
something this codebase can decide, and it cannot be measured either: synthetic
input is injected into the renderer, which is after the hit test the question is
about.

So it does not depend on it. With `title_bar = shown` the handle is
`.title-bar`; with `hidden` it is `.window-drag-strip`. Both are on the window's
own page, which is the `BrowserWindow`'s own contents and is under every child,
and in both chromes the owner leaves the band above the Sidebar's column
uncovered (`sidebarRect`). The Sidebar declares no drag region in either, which
also retires the opt-out list every new control had to remember and the
"a scrollbar inside a drag rectangle moves the window" gotcha.

The same reasoning retires `title=` in the Sidebar: a native tooltip raised
inside a view may be clipped by it, and the row that most needs one is on the
collapsed rail. `RowTooltip.tsx` drew it in-page next — which made the clipping
decidable, and the answer was that it is clipped, because the rail's view is
40px wide with a title bar and 76px without. That version refused to draw one
below a readable width at all, so the rail had no hover and an expanded row's
sentence wrapped into a ribbon: one cause, two complaints.

So the tooltip is a child of the *window* whose rectangle is its own content,
the way the `toasts` view already is. `RowTooltip.tsx` is a sender now. It
keeps the three things only it can know — that the pointer has to *rest*
(300ms; the keyboard does not, because a row reached with the arrows was
chosen), that there is one tooltip for the whole tree, and what it says — and
sends an anchor in the *window's* coordinates. That conversion is one addition:
the row's box, plus the rectangle main tells the view it occupies
(`sidebarAreaChanged`). Never `window.screenX`, and never the view's own box,
which is stale for a while after main moves it.

Where it then goes is `windowLayout.ts`'s `tooltipRect`: the side the row
prefers, flipped to the other side of the anchor when that one has no room, and
clamped to the window last. It flips rather than narrows — one rectangle with
one width, because narrowing to fit is how the ribbon happened.

## What it costs

One main process, one renderer per page (seven, of which Settings exists only
while it is open), and one per workbench — though several workbench views can
share a renderer, which Chromium's same-site grouping decides.

Time to the first editor, measured on an isolated instance from the process's
own start to the first workbench's `did-finish-load`, six runs each, before
stage 0 and after stage 4:

| | median | runs |
|---|---|---|
| before | 0.977s | 1.542 (cold), 0.955, 0.996, 0.977, 0.973, 0.980 |
| after | 0.970s | 1.065 (cold), 0.960, 0.949, 0.977, 0.966, 0.975 |

Unchanged, to the precision the measurement has. The first paint does not
depend on a page round trip: every child view is created in `ShellWindow`'s
constructor with its page already loading, the owner computes every rectangle
from the initial projection, and no page is asked for a number before it is
drawn.
