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
    the Agents → every terminal pane → the notices → the questions → the
    tooltip

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
the tooltip page never hears of the row. The Sidebar sends a _request_
(`releaseTooltip`), main holds the box for a short grace, and the tooltip
page's own report of where its pointer is decides. Everything that is not
about the pointer — a scroll, a resize, the window losing focus, a modal
opening — still takes it down at once.

A context menu is not in the list at all. A row's right-click menu is a
**native** menu (`main/shell/contextMenu.ts`): the Sidebar sends the items' ids
and labels and the click's point in its own coordinates (`showContextMenu`),
main adds where it laid the Sidebar and pops a `Menu` up over the window, and
the page runs whichever item's id comes back, the way its own buttons do. It
used to be a DOM box in the Sidebar's page, clipped by the Sidebar's view —
to nothing on a collapsed rail. A native menu is above every view, is drawn and
keyed the way every Mac menu is, and is what the workbench's context menus
already are; so the window has one kind of context menu.

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
in for it are about the _shape_: what a workbench attaches ends up in the
window's child list and never in the workbench's own.

So every view in this window is a **sibling**, including the ones a workbench
opens for itself — VS Code's integrated Browser
(`workbench.action.browser.open`) is the one that exists today. It is a child
kind of its own, `attached`, ordered immediately after the workbench it
belongs to and below everything the shell draws over the content area.

`WorkbenchView.contentView` is what makes that possible without a second
owner of the layout. VS Code believes it is the window's content view; it is a
container that registers what it is given with `ShellWindow` and wraps that
view so the two things VS Code says about it become _wishes_:

- the rectangle its renderer measured, which is in the **workbench's own
  document** — the only frame a renderer can measure in. `windowLayout()`
  translates it by that workbench's rectangle and clips it to it, so the
  browser follows the Sidebar, the split and the window's size with no round
  trip through any page, and can never draw over the Sidebar or an Agent's
  pane;
- whether VS Code wants it drawn, which is half the answer. It is drawn when
  that wish is true _and_ its workbench is the one on screen, so selecting
  another Workspace takes it away and coming back brings it back where it was.

The workbench going away takes everything it attached out of the window with
it; nothing else would.

No page measures anything the owner decides. The window's own page used to
leave a hole for the workbench, measure it with a `ResizeObserver` and report
it back, which made main's idea of the layout a page's idea of it one frame
late and made every window resize a round trip through a renderer. Now main
computes the rectangle and _tells_ the page (`workbenchAreaChanged`), and the
page draws its own states into the same rectangle the workbench is laid into.

**A page's own box is not the window.** `window.innerWidth` inside a
`WebContentsView` is that view's width, and it is stale for a while after main
moves it — measured on an isolated instance, the Sidebar's view was narrowed
from 249px to 76px and went on answering 249 for seconds. Nothing in DevHub
reads it; where anything is, is `windowLayout.ts`. Every child page's header
says so, because the next page is the one that will not know.

## The pages, and what each of them may say

Eight entries, eight preloads, eight bridges. There is no `?window=` role and
no runtime question about which page this is: **which page this is, is which
file main loaded.** (An Agent terminal's page is loaded once per terminal;
the fragment, `pane.html#<id>`, names which terminal — an instance, not a
role.)

| Page                  | Entry           | What it draws                                                                                                   | What it may ask for                                                                                                                                                                                                                                                                            |
| --------------------- | --------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the window's own page | `index.html`    | the title bar, the drag strip, the three states in which there is no child view to show, the seam of a split    | the projection, the appearance, the window's name, the workbench area, `openModal`, `closeWorkspace`, `chooseWorkspaceFolder`, `openSettings`, `previewLayout`                                                                                                                                 |
| the Sidebar           | `sidebar.html`  | the leading column: workspaces and their agents, the rail, the row menu, the drag-reorder, the resize handle    | the projection, the appearance, the agent profiles, the repository status, its own rectangle, `menuCommand`, `openModal`, `closeWorkspace`, `openExternalUrl`, `previewLayout`, `focusSurface`, `showContextMenu`, `showTooltip`, `hideTooltip`, `releaseTooltip`                              |
| the Agents            | `agents.html`   | every running Agent's pane, all mounted, the selected one not hidden: a terminal, or a GUI Agent's conversation | the projection, the appearance, the repository status, the agent actions, the terminal transport, the conversation transport (`conversation`), `openModal`, `openExternalUrl`, `writeClipboard`                                                                                                |
| an Agent's terminal   | `pane.html`     | an Agent's own terminal, on the right: a terminal surface and nothing else, no header                           | the projection, the appearance, the terminal transport, `openExternalUrl`, `writeClipboard`                                                                                                                                                                                                    |
| the notices           | `toasts.html`   | what the application has to say, over whatever is on screen                                                     | `nativeError`, `appCondition`, `actionStarted`, `menuCommand`, `reportListening`, `reportNoticeRetired`, `reportToastsSize`, `retryApp`, `openSettings`                                                                                                                                        |
| the tooltip           | `tooltip.html`  | one box with a row's facts in it, over whatever is on screen; the facts that name a page are links              | `tooltipText` in; `tooltipSize`, `tooltipPointer` and `openExternalUrl` out. **Nothing else** — in particular not the anchor or the side, which are the owner's.                                                                                                                               |
| the questions         | `picker.html`   | every sheet DevHub stops on, over every workbench                                                               | `modalsChanged` **(only here)**, the projection, the appearance (for the monospace family alone), the agent profiles and actions, a folder's earlier Agent sessions and their previews, every way of opening a Workspace, the two ends of a reviewed message, the worktree close, `closeModal` |
| Settings              | `settings.html` | its own window                                                                                                  | `SETTINGS_CHANNELS` in full, plus the failure contract every page has                                                                                                                                                                                                                          |

Every one of them also has `raiseFailure` and `onTheme`, which is what "a
DevHub page" means.

The conversation transport is the GUI Agent's counterpart of the terminal
transport. A GUI pane attaches once, gets the transcript main holds, and then
folds every numbered event after it with the same `applyEvent` main uses.
Everything it sends (messages, answers, interrupts, settings, "continue in
terminal") goes back through the same bridge member. See
[`agent-gui.md`](agent-gui.md).

**The preload is the enforcement.** `ipc/contract.ts` states each page's bridge
as an interface; `preload/<page>.ts` builds exactly that object and exposes it;
`scripts/build-preloads.mjs` bundles each one on its own, because a sandboxed
preload is one CommonJS file with no module resolver behind it and cannot
`require` a shared chunk. A member a page does not own is not refused at
runtime — it is _absent_, which TypeScript can say and a running page cannot
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

**A close lands on the next row of what held it, and on the previous one
when there is no next.** An Agent is held by its Workspace, so closing one
never leaves that Workspace: it lands on the Agent under it, on the Agent
above it when it was the Workspace's last, and on the Workspace's own row
when it was the only one — the row stays, and it is the one row above. The
last row on screen is only another last Agent, and Scratch's Agents are the
same. A Workspace is held by the Sidebar, so closing one lands on the next
row as drawn — Scratch first, each Workspace followed by its Agents, the same
list `Cmd+Q N` and `]` walk — which is the next Workspace's row, because its
own Agents are removed first by the Agent rule; when it was drawn last, the
row above it. The rule is one method, `AppModel.repairSelection`, handed the
rows of what held the removed row and run by every removal: an Agent stopped
from its row, from `Cmd+Q X` or from the confirmation sheet, an Agent that
exited on its own, a Workspace closed any way it can be. A close that asks
moves nothing until it is answered; Cancel leaves the selection where it was.

Closing an Agent used to land on the next row of the whole Sidebar, which
after a Workspace's last Agent was the next Workspace: stopping an Agent took
you out of the folder you were working in.

The Workspace order is not the model's to work out: the Sidebar groups
worktrees under their repository, which is git's answer, and the model does
not know git (`AppSnapshot.workspaceOrder`). So the coordinator is handed the
drawn order (`DrawnOrder`), read by the projection's own function
(`drawnWorkspaceOrder` in `model/wire.ts`) with main's repository status —
the same order every page and chord reads. The model used to choose on its
own, from the order folders happened to be opened in, and a Workspace's
successor was its neighbour in opening order, which could be anywhere on
screen.

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
failed — and it is a child of the shell window, so a notice is drawn _over_ a
workbench, which the window's own page could never do.

The Settings window is the one exception, and it is about being seen rather
than about routing: a failure that began there is drawn there, because a report
about the window the person is looking at, drawn on a window they are not, is a
report nobody reads.

## The palette is a third audience

There are three kinds of thing main says, not two. A _projection_ describes the
model and goes to every page that draws from it. A _failure_ is an event and
goes to the one page that draws failures. A _palette_ is neither: it is how
everything in the window is painted, and it goes to every page DevHub draws
chrome on — which is all eight (every terminal pane among them).

That last one used to go out on the projection audience, which coincided with
"every page that draws chrome" until the `toasts` page arrived: it has `onTheme`
on its bridge, no model behind it, and had therefore never been recoloured at
runtime. Nobody noticed, because a stale palette is only visible after a theme
change. The tooltip would have been the second page with the same silent gap —
the Sidebar _is_ in the projection audience, so the tooltip it used to draw
recoloured correctly, and one on its own page would not have. `chromeAudience`
states the rule instead of it being a coincidence, and the test on it is that
every page with `onTheme` is in it.

An Agent pane's colours are not the palette. The splash that recolours the
chrome carries nothing about a terminal, so with `[appearance] terminal_theme =
"vscode"` — the default — main reads the theme's terminal colours out of
Scratch's workbench (its `--vscode-terminal-*` custom properties, which already
hold the registry's defaults) each time Scratch reports a splash, keeps the last
answer in `terminal-colors.json` beside `state.json`, and sends it on the
appearance projection like an edited setting (`main/shell/terminalColors.ts`).
Palettes named under `[appearance.terminal_theme.light]` / `.dark` win outright.

Three scopes survive underneath this, and they are about _subject_ rather than
about routing: an Agent's own failure is drawn over that Agent's pane, a
Workspace's over its surface, and the failure that stopped a page from starting
fills that page, because there is nothing behind it to draw instead.

## The keyboard

`ShellWindow.placeKeyboardIn` is the only `webContents.focus()` call in DevHub,
and `keyboardChild(layoutInput())` is the only answer to "where do the keys
go". Focus is a function of the same state the layout is a function of — all
of it, not only the arrangement: `layout()` places the keyboard again whenever
that answer changes, so a workbench that was chosen before it existed (a
folder just opened, one on another machine, one being rebuilt) gets the keys
when it arrives rather than leaving them on the window's own page, where they
went while there was nothing else.

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
`focus_sidebar` (the command palette; it was `Cmd+Q S`, which is unbound now),
and Return there
chooses a row without leaving the list, because the
next ↓ has to still be a ↓. It is read off the activation — a click raised by a
pointer carries a `detail` of at least one, and a focused button activated from
the keyboard carries zero — rather than kept as a flag one handler sets and
another clears. Both go through `focusSurface`, the same door Escape uses, and
the ask is sent after the selection has been applied, because which child the
keys belong to is a function of the selection.

**A move made from the keyboard lands the keyboard in what it chose.** Every
chord that goes somewhere — a digit, `N`/`P`, `n`/`p`, `]`/`[`, `}`/`{`, `e`,
`z`, `o`, `Cmd+J`, `Shift+J` — goes through one door, `AppController.arrive`: the
move is made, and the keyboard is placed on the new selection, out of the
Sidebar too if that is where the chord was typed. A chord typed in the Sidebar
is not the Sidebar's own Return, and the Sidebar keeping the keys after one
used to leave them on a row that was no longer selected while the screen had
moved on. The arrival is placed even when the move changed nothing (`Cmd+Q 0`
from the Sidebar with Scratch already selected is still somebody asking to be
in Scratch). An answer to a question is the same kind of move: a row chosen in
Go to, and every way of opening a folder (`openFolder`), land in what was
chosen rather than back in the Sidebar the question was asked from.

A close typed from the keyboard (`X`, `Shift+W`) is a move too, and it lands
where the close repairs the selection to. The keyboard leaves the Sidebar
when the chord is typed rather than when the close lands, because a close is
not over in one call: one that asks is answered on the sheet, which already
put the keys on the surface, and one that does not ask used to leave them on
a row that had gone, so the same close ended in two places depending on
whether it had asked.

Opening a folder is choosing it, new or not — the model's `open_folder`
selects the Workspace it adds exactly as it selects one that was already open.
It did not use to: a new folder was added and left unselected, and what put
somebody in it was its workbench reporting its own folder back as a second
`open_folder`, which found the Workspace and selected it. When a workbench
DevHub builds stopped reporting itself, `Cmd+Q F` stopped arriving anywhere.

Where the keys go _inside_ a workbench is the workbench's own business, with
one exception: **a toggle that lands on an editor lands in its editor group.**
`Cmd+Q Cmd+J` going Agent → editor and `Cmd+Q Shift+J` arriving at an editor —
Scratch on the way out, or the editor it came from on the way back — focus
that workbench's active editor group (`workbench.action.focusActiveEditorGroup`),
not its integrated terminal, so the keyboard is in the text and not just on the
view. Every other way of choosing the same workbench — a sidebar click, `Cmd+Q
N/P`, a digit, the pickers — leaves it wherever it was last typed into.

The intent is `Landing` in `chords.ts`, carried by the effect (`focus:
"editor"`) and spent by the placement that ends the move:
`focusSurface("editor")`, which forwards the command to the workbench the
keyboard has just been put in, when it is one. Nothing is kept between the
asking and the landing, because the move, the arrangement it publishes and
the placement are one synchronous call in main. (It used to be armed on one
side and spent on the other, from when the arrangement came back up from a
page a round trip later; `Shift+J`, whose destination only the model knows,
could not have been armed for at all.) A landing on an Agent means nothing —
an Agent is a terminal already — and one on a workbench that is starting,
restarting or gone, behind a question, or while DevHub is not in front is
simply not had: the move still happens.

**`]` and `[` step from the tab you are on.** Every tab stands on its own row
of the tab order — the list `N`/`P` walk and a Workspace's close lands by,
built by one function (`tabOrder` in `ipc/appShell.ts`, found in by
`tabPosition`) — and
`]` (`[`) walks forward (back) from there to the first Agent, wrapping. From
an Agent that is the next Agent; from an editor, Scratch or a Workspace with
no Agents it is the first Agent under that row, so alpha's editor `]` is
alpha's first Agent and `[` the last Agent above alpha. An editor used to
step from its `Cmd+J` partner (`pairedAgentId`) instead, which skipped the
Workspace's own first Agents whenever the partner was further down; before
that it stepped from nowhere, which is Scratch's first Agent.

**A workbench back from being away opens tidy.** When a workbench comes back
on screen after `devhub.workbench.tidyAfterAwayMinutes` (default 10; `0` is
off) — another Workspace or an Agent was shown in its place — it hides its
panel (the terminal with it), primary side bar and secondary side bar
(`devhub.workbench.tidyParts`, all three by default) and puts the keyboard in
its active editor group, so it opens as a big, clean editor; with no editor
open the parts are hidden all the same. **DevHub: Tidy Editor Layout** in the
command palette is the same tidy at any time.

"Away" is DevHub's own answer, so main measures it, from the layout:
`workbenchAbsence.ts` notes when each workbench left the screen (stopped
being `onScreenEditor`) and, on the `layout()` pass that brings it back,
sends it `_devhub.workbench.returned` with `{ awayMs }` over
`vscode:runAction`; the overlay's `devhubTidy.contribution.ts` compares that
with the setting. It is not the renderer's `document.visibilityState` nor its
window focus, because those answer a different question: DevHub in the
background, minimized or behind another app is not the workbench being away,
and neither is the Agent of a split holding the keyboard — the editor stayed
in front of the person the whole time, and is never tidied for it, however
long. A workbench's first showing is not a return.

## Chords are answered in main

`keyboard.ts` installs `before-input-event` on every WebContents DevHub owns,
through `app.on("web-contents-created")`. That is the only place a chord can
work: it sits in front of every surface, and a completed chord is
`preventDefault`ed there so its keys never reach the surface underneath.

It is not in front of an input method. On macOS Chromium hands a key to the
input method first (`interpretKeyEvents:`), and a key the input method takes
comes back as a process key that is never raised as `before-input-event` — with
Japanese input on, the second stroke of a chord would become preedit and DevHub
would never see it. The prefix is Command-modified, which input methods leave
alone, so it always arrives; what DevHub does with that moment is take the
input method out of the way. While a chord is armed the input source is an
ASCII-capable one, and when the chord is over — run, cancelled, timed out, the
table changed, or DevHub left for another application — the source that was
there before is selected again, unless the person has switched to another one
in the meantime (`chordInputSource.ts`).

The switch is done by `devhub-input-source`, a small C program on Carbon's Text
Input Sources API (`main/native/inputSource.c`), compiled by the desktop build
into `out/native` and shipped there inside the bundle. It is started once and
kept, and each switch is a line on its stdin. It needs no accessibility
permission. If it cannot be started or stops, that is said once as
`input_source_unavailable`, and chords go on working for anyone whose input
source is already ASCII-capable.

The switch is not instant: `TISSelectInputSource` took 2–27 ms, median about
15 ms, measured on an Apple Silicon Mac (the pipe to the helper adds hundredths
of a millisecond). A second key pressed within that window after the prefix
still goes to the input method, and the chord then stays armed until the next key. That is accepted
— the gap between releasing Cmd+Q and the next key is several times longer —
and there is no guessing the key back from its physical position. Nor is a key
that arrives with no character (`Process`, `Dead`) read from its position: it
completes nothing and cancels the chord.

Because the handler is per WebContents and installed for all of them, arming a
chord in one view and completing it in another is one chord, and the split into
six chrome children cost it nothing. `focus_agent_pane`, `focus_sidebar` and
`dismiss_alert` used to be routed _to the page_ because what they acted on was
drawn there; two of them are now plain "focus that view" calls in main, and
`dismiss_alert` is delivered to the page that has the notices.

## An Agent's terminal, with its Agent

Every Agent has **one terminal of its own** (`model/agentTerminal.ts`): a tmux
session (`tm-<agent id>`, marker context `terminal`) on the Workspace's machine
— the same server, socket and config as every other DevHub session — started
in the Workspace's folder, which is the Agent's worktree when the Workspace is
one. DevHub draws it as one pane beside its Agent — right of a full Agent,
under the Agent of a split — and never tiles terminals: it is a whole tmux, so a person who wants a second
shell splits inside it with tmux's own keys.

**Whose terminal is on screen.** The terminal and its Agent are a set: a
terminal is on screen only while its Agent is. The view's Agent's: the
selected Agent (full or beside its workbench), or — with a Workspace's row
selected beside an Agent — the Agent that Workspace pairs with
(`pairedAgentId`, the one `Cmd+Q Cmd+J` goes to). The workbench alone shows no
Agent, so it shows no terminal: the paired Agent's keeps running hidden, its
`open` untouched, and is back when that Agent is. Switching Agents shows each
one's own terminal, if it has one open; the one left behind keeps running,
detached and hidden, and its view (with its scrollback) stays. A Workspace
with no Agents has no terminal.

**`Cmd+Q V`** (`toggle_terminal`) starts the view's Agent's terminal the
first time, with the keyboard in it, and after that hides and shows the pane
without touching the session. On a Workspace with no Agent it says so (a
`terminal_needs_agent` notice) rather than doing nothing; on the workbench
alone it says to switch to the Agent (`Cmd+Q Cmd+J`) or split (`Cmd+Q Z`)
(`terminal_needs_agent_view`) and changes nothing. `Cmd+Q S` and the
bare arrows after the prefix are unbound (they were the pane tree's split
below and directional focus); `focus_sidebar` stays palette only.

**What the model keeps** (`AppModel`): per Agent, the terminal while its
session is up — its id and whether it is `open` — and, apart from it, two
shares: of the content width beside a full Agent, and of the split's right
half's height under its Agent, kept apart so sizing one never moves the
other, and so a terminal closed and opened again comes back at its size. All
are persisted on the Agent's record (`terminal`, `terminal_share`,
`terminal_stacked_share`; no schema bump — absent is no terminal and the
default share). A file written by 3de5ad4, which kept a tree of panes per
Workspace (`pane_layout`, `pane_terminals`), is read without refusal: the
first terminal it names goes to the Workspace's last Agent (or its only one),
shown, at the width it had if it sat right of the content; the rest are
dropped and their sessions swept.

**Layout.** `windowLayout.ts` places the terminal where its Agent is
(`terminalPlacement`, over `terminalExtent`). With a full Agent it takes its
share of the content area on the right and the Agent gets what is left
(`contentRect`). In a split the editor keeps the whole left half, exactly as
without a terminal, and the right half is a column: the Agent on top, the
terminal at the bottom taking its share of the height (`placeTerminalBelow`,
`terminalStacked`). With the workbench alone there is no terminal. One child
per Agent terminal (`terminal`) is stacked above the Agents and below every
layer — the one on screen at its rectangle, every other hidden. The divider
between Agent and terminal is the strip no view covers, drawn on the window's
own page from `terminalSeam` on the workbench area main pushes (upright, or
level when `stacked`), exactly as the workbench/Agent seam is; dragging it
previews (`previewLayout({ terminalShare })`) and commits
`resize_agent_terminal` (with `stacked: true` for the split's).

**The keyboard.** `LayoutState.keyboard` can name the terminal;
`keyboardChild` gives it the keys only while it is drawn. The model keeps
whether the terminal has the keyboard (`AppModel.paneFocus`): a chord moves
it, a click into a view reports it (`ShellWindow.onContentFocused`), and any
selection takes it back to the content. `Cmd+Q O` walks the panes on screen —
Agent → terminal with a full Agent, editor → Agent → terminal in a split,
nothing to walk with the workbench alone — and wraps. `Cmd+Q X` with the terminal in front closes it
(and its session).

**Ending.** A terminal's pane goes when its session does: the shell exited, or
the session was killed. The terminal-activity round that already lists every
pane on the machine once a second says which `tm-` sessions are there
(`parsePaneActivity`'s `terminals`), and a terminal it did not see goes —
unless the model learned of it after the round began. The same round closes a
`tm-` session whose Agent has gone (stopped, or ended by itself). Closing a
Workspace closes its Agents' terminals with it, and a busy one (not at its
shell's prompt) is counted in the close sheet's processes. The startup sweep
accounts for a `tm-` session by its Agent's terminal.

**Stopping an Agent with its terminal open** always asks (even an idle one):
_Move the terminal to the editor_ or _Stop, and close the terminal_. Moving
`move-window`s every window of the `tm-` session into the Workspace's own
`ws-` session — the one every editor DevHub terminal tab attaches to, made
first if it is not there, so a hibernated or closed editor finds them when it
next attaches — with every process running on; the emptied `tm-` session
ends, then the Agent stops (`confirm_stop_agent` with `moveTerminal`, the
`stop_agent` effect's `moveTerminal`). A move that fails stops nothing.

**For an Agent** (`devhub --tell terminal …`): always the asker's own
terminal, named by its pane's `DEVHUB_ORIGIN`, never by a flag. `terminal open
[--command C] [--focus]` starts it or shows it (idempotent; `--command` is
typed only when this call starts it) and prints the handle — the tmux
executable, the server's socket, the session and the active pane (`%N`) — so
the Agent drives it with plain `tmux -S <socket> send-keys -t %N -l …` and
reads it with `capture-pane -p`. `terminal status` (or `show`) says whether it
is open, visible (open, and its Agent on screen — never with the workbench
alone) and focused and lists every tmux pane in the session with
where it is in its window (`top-left`, `bottom-right`, … from
`#{pane_left}`/`#{pane_top}`), so "the bottom-right pane" of a terminal the
person split is a lookup. `terminal close` closes it. `terminal panes` lists
the panes of the asker's Workspace's editor terminals (its `ws-` session:
session, window, `%N`, command, the foreground command line from `ps` — `ssh
prod` —, cwd, title, active), and `terminal bring %N [--focus]` `join-pane`s
one into the asker's terminal, still running: into a fresh terminal in place
of its new shell, or as a split of the open one. Only that Workspace's `ws-`
panes can be brought (never an `ag-` or another Agent's `tm-` pane); a
window it leaves empty closes, and with its last window the `ws-` session —
whose tmux clients exit 0, so the editor's tab just closes, and the next tab
opened makes the session again. The bundled `/devhub` skill says when and
how.

## Every command, by name: `Cmd+Q :`

The command palette is the command registry (`model/commands.ts`) drawn as a
picker. Every command there has an id, a label, a category (`Navigate`, `View`,
`Workspace`, `Agent`, `DevHub`) and what it `needs`; the palette lists each as
`Category: Label` with the chords actually in effect at its right end, so a
rebound key reads as the person's own. A command may be palette only — no
default key — when it already has a gesture elsewhere; none is today.
`navigate_back` and `navigate_forward` are `Cmd+Q H` / `Cmd+Q L` (Vim's left and
right): `Cmd+[` / `Cmd+]` still work unprefixed on DevHub's own pages, but over a
workbench the brackets belong to VS Code, and as chords they already belong to
the Agent cycle.

The stroke is the character `:`, not a physical key, so it is Shift+; on a US
layout and the unshifted key beside L on a JIS one (`chordKeys.ts`).

Main builds the rows (`model/commandPalette.ts`) when it opens the sheet:
`forward_prefix` and the palette itself are left out, and a command is listed
only if `resolveChord` would give it something to do against the current
snapshot — an Agent's commands are not offered with a workspace selected, Back
is not offered with nowhere to go back to. Commands run from the palette are
remembered in memory (eight, most recent first) and lead the list.

It is the ordinary picker on the modal layer, so it draws over a workbench as
every other sheet does: typing filters with the shared scorer
(`model/fuzzy.ts`, matching the title and the id), the arrows and Ctrl-N /
Ctrl-P move, Return runs and Escape closes. The sheet closes with the chosen
row's index as its response (`PickerView.choose`), and main then runs the
command through `runCommand` in `keyboard.ts` — the same path a completed chord
takes — so the palette and the keys cannot disagree about what a command does.

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

**The size is one number, and it lives in main.** The zoom is an _offset_ in
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

## Back and Forward

The window keeps a browser's history of the places it has shown, and the title
bar draws Back and Forward beside the Sidebar button.

**An entry is the selection** (`AppModel.selection`): a Workspace, an Agent,
or the two side by side, with the presentation it was shown in. That is the
shell's whole notion of "where you are", so there is no second record of
pages to drift from it. It is recorded in one place — `AppModel.bumpRevision`
— so every way the selection moves is recorded without having to remember to
be: a click, a chord, a new Agent, the selection repaired after a close. The
rules are `model/navigationHistory.ts`'s, and they are a browser's: going back
and then somewhere new cuts Forward off; Back and Forward do not record
themselves (the cursor moves first, so the move arrives at the entry it
already points to); the same place twice in a row is one entry; the two
halves of one split are one place (swapping the keyboard between them updates
the entry); a closed Agent or Workspace is _skipped_, not removed; and only the
newest 100 entries are kept. Each arrow is disabled when there is nowhere it
would go, answered by the same rule the move obeys. History is per session:
the state file says where the window opens, and Back starts there.

**Two histories, and the editor's wins over an editor.** A VS Code workbench
has its own Back and Forward over cursor positions
(`workbench.action.navigateBack`/`navigateForward`). Every input is therefore
decided by the surface it lands on, the way the zoom keys are:

| Input                                       | Over DevHub's own pages (window, Sidebar, Agents)      | Over a workbench                                   |
| ------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| `Cmd+[` / `Cmd+]`                           | app history (`main/shell/historyKeys.ts`)              | untouched — VS Code's Outdent/Indent Line          |
| `Ctrl+-` / `Ctrl+Shift+-`                   | untouched (a terminal's control character)             | untouched — VS Code's own Back/Forward             |
| mouse buttons 4/5 (`MouseEvent.button` 3/4) | app history (`shell/historyButtons.ts`)                | VS Code's own, by its `mouseBackForwardToNavigate` |
| `app-command` `browser-backward`/`-forward` | app history (Windows/Linux only; never fires on macOS) | untouched                                          |
| trackpad `swipe` left/right                 | app history                                            | untouched                                          |
| the title bar's arrows                      | **always app history**                                 | **always app history**                             |

`Cmd+[`/`Cmd+]` are the Mac's own Back and Forward (Finder, Safari, Xcode),
free on every DevHub page, and the workbench is left with its bindings intact.
The arrows always walk the app's history: they are the shell's chrome, above
every surface, and an arrow whose meaning changed with which pane last had the
keyboard could not be predicted by looking at it. Keys and gestures raised in
main are declined while a question is up, as the zoom is; the window-level
gestures, which say nothing about where the pointer was, are decided by where
the keyboard is (`ShellWindow.focusTarget`). With the title bar hidden
(`appearance.title_bar = "hidden"`) there are no arrows, and the keys and the
mouse still work.

## Attention is the Dock

There is no ring drawn around the window. A DOM overlay in the window's own
page is behind every workbench view, which is to say hidden exactly when there
is something to say — so an unread Agent is announced by the _window_: a Dock
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

So the tooltip is a child of the _window_ whose rectangle is its own content,
the way the `toasts` view already is. `RowTooltip.tsx` is a sender now. It
keeps the three things only it can know — that the pointer has to _rest_
(300ms; the keyboard does not, because a row reached with the arrows was
chosen), that there is one tooltip for the whole tree, and what it says — and
sends an anchor in the _window's_ coordinates. That conversion is one addition:
the row's box, plus the rectangle main tells the view it occupies
(`sidebarAreaChanged`). Never `window.screenX`, and never the view's own box,
which is stale for a while after main moves it.

Where it then goes is `windowLayout.ts`'s `tooltipRect`: the side the row
prefers, flipped to the other side of the anchor when that one has no room, and
clamped to the window last. It flips rather than narrows — one rectangle with
one width, because narrowing to fit is how the ribbon happened.

## The title bar is one number, and it is main's

The bar is as tall as a plain titled macOS window's: **32pt** on macOS 26,
measured off an `NSWindow` with `.titled` (it was 28pt before Tahoe; the lights
there are 14pt frames, 9pt from the top and 9pt from the leading edge). It is
`TITLE_BAR_HEIGHT` in `windowLayout.ts`, and it is said there only.

Two things follow from it, and neither is a number of its own:

- **The traffic lights.** The window is `hiddenInset`, which on its own leaves
  them at Electron's fixed (12, 11) — centred in a 36pt band that the page's
  bar did not match. `shellWindowOptions` passes `trafficLightPosition()`
  instead, which is the inset that puts a light's middle on the bar's middle
  line, used for `x` as well because that is where a plain window keeps them.
  Change the height and the lights follow.
- **The pages.** `tokens.css` reads `--titlebar-height` and
  `--traffic-light-span` and declares neither. `shellPageProtocol.ts` writes
  them into every page's `<head>` as the page is served (`chromeVariables`),
  palette or not, and refuses a page it cannot write into — a page without
  them would draw a bar of no height.

The band is the same in both chromes: with `shown` it is the bar, with `hidden`
the Sidebar's view starts under it and `.window-drag-strip` fills it. Full
screen changes nothing here; macOS hides the lights and the bar stays drawn.

## What it costs

One main process, one renderer per page (eight, of which Settings exists only
while it is open, and the terminal pane once per terminal), and one per workbench — though several workbench views can
share a renderer, which Chromium's same-site grouping decides.

A workbench is a renderer, an extension host and its language servers and
watchers, so one per Workspace adds up. Each folder's workbench is in one
lifecycle phase at a time, owned by `workbenchLifecycle.ts` and nothing else:
_absent_, _opening_ (an open in flight or a view not yet loaded; cause start,
restart or wake), _awake_, _hibernating_, _asleep_, _held_ (asleep, selected
by a passing `Cmd+Q N`/`P`), _restart-waiting_ (failed, backing off), _gave-up_
and _parked_ (given up on and unavailable until Retry or Locate…). Events —
an open settled, a view loaded or died, an unload finished, a pass, a key —
move the phase; `AppController.reconcileWorkbenches`, the one executor, asks
its `plan` (phases + projection + selection + window) on every projection
change, every event, the lifecycle's own deadlines and the minute check, and
carries out the effects: open, dispose, hibernate, report giving up, and the
placeholder for each slot. Revealing never opens: `syncEditorView` waits for
an open already in flight and asks the arrangement again.

**A workbench away longer than `general.workbench_hibernate_minutes`
(default 10; `0` is off) is closed** on the minute check, measured by the
same `workbenchAbsence.ts` as the tidy above (a split is on screen; a
workbench never shown is away from launch). **Past
`general.workbench_awake_max`** (default 3; `0` is no cap) — awake or opening,
Scratch, SSH and dev container ones never counted or closed — the least
recently shown awake ones are closed at once, on the switch that went over:
never the shown one, one opening or waking, one closing, or one that has just
refused (asked again on the minute check); a folder that would start past the
cap, not selected, starts asleep. Passing through never wakes, so stepping
through any number of Workspaces moves nothing; only a wake (1 s on it, or a
key) raises the count, and each puts at most one other to sleep. Before
closing, main asks the workbench what that would lose (`vscode:devhubKeepAwake`,
answered by the overlay's `devhubHibernate.contribution.ts`): a process in one
of its own terminals (a task, or a shell with children; DevHub's terminal is
tmux and never counts), a debug session, and unsaved editors only with
`files.hotExit` off. Any answer, or none, keeps it up, and the cap tries the
next one. Otherwise its frame is captured (`capturePage`) and it is unloaded
as VS Code unloads every window on Cmd+Q (`UnloadReason.QUIT`: the backup
tracker backs up unsaved editors instead of asking, storage is written,
extensions deactivate), and its view destroyed. Asleep, selecting it wakes it
through the ordinary open path, whose `registerFolderBackup` hands it the same
backup folder, so VS Code restores its editors, layout and unsaved changes.
`Cmd+Q N`/`P` landing on it holds it `WAKE_DELAY_MS` (1 s) first, in case it is
only passed through; leaving cancels, and any key but a modifier wakes it at
once. Nothing else is touched: the row, its Agents, their tmux sessions, GUI
conversations and repository status. A woken workbench is a new view, so it
is not tidied on its return.

What the slot shows is the phase (`placeholderOf`), sent to the page whenever
it changes (`editorPlaceholder`), so it cannot outlive its state: "Restarting
the editor…" while restart-waiting or reopening after a failure, the captured
frame grey and dim with "休止中" while asleep or held and "起動中…" while
waking (the view `hidden` in the arrangement, a split keeping its Agent); the
frame lives in memory only. A workbench that dies unasked is opened again
after a backoff that doubles from 250 ms (`editorSupervisor.ts`), and after
five failures in a row it is given up on and its Workspace made unavailable;
one that dies while hibernating is simply asleep. Every transition and every
skipped hibernation or wake is a line `[devhub] workbench '<folder>' …` in
main's log (`<userData>/logs/devhub-main.log`, `DevHub: Open Log`).

Time to the first editor, measured on an isolated instance from the process's
own start to the first workbench's `did-finish-load`, six runs each, before
stage 0 and after stage 4:

|        | median | runs                                            |
| ------ | ------ | ----------------------------------------------- |
| before | 0.977s | 1.542 (cold), 0.955, 0.996, 0.977, 0.973, 0.980 |
| after  | 0.970s | 1.065 (cold), 0.960, 0.949, 0.977, 0.966, 0.975 |

Unchanged, to the precision the measurement has. The first paint does not
depend on a page round trip: every child view is created in `ShellWindow`'s
constructor with its page already loading, the owner computes every rectangle
from the initial projection, and no page is asked for a number before it is
drawn.
