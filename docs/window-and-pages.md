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

The pointer can enter it, because it draws links: the facts that name pages on
GitHub (the repository, the Issue, the pull request) are links in the box, and
a click on one goes to the browser through the tooltip page's
`openExternalUrl` — only for an `https://github.com/` page
(`shell/githubPage.ts`, checked when the line is composed and again before it
is followed). A box that went the moment the pointer crossed into it could
never be clicked, so it stays up while the pointer is in it — arbitrated in **main**
(`tooltipView.ts`), not in either page: the row and the box are different views, the Sidebar's leave is
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

Ten entries, ten preloads, ten bridges. There is no `?window=` role and
no runtime question about which page this is: **which page this is, is which
file main loaded.** (An Agent terminal's page is loaded once per terminal;
the fragment, `pane.html#<id>`, names which terminal — an instance, not a
role.)

| Page                  | Entry                | What it draws                                                                                                              | What it may ask for                                                                                                                                                                                                                                                                            |
| --------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the window's own page | `index.html`         | the title bar, the drag strip, the three states in which there is no child view to show, the seam of a split               | the projection, the appearance, the window's name, the workbench area, `openModal`, `closeWorkspace`, `chooseWorkspaceFolder`, `openSettings`, `previewLayout`                                                                                                                                 |
| the Sidebar           | `sidebar.html`       | the leading column: workspaces and their agents, the rail, the row menu, the drag-reorder, the resize handle               | the projection, the appearance, the agent profiles, the repository status, its own rectangle, `menuCommand`, `openModal`, `closeWorkspace`, `openExternalUrl`, `previewLayout`, `focusSurface`, `showContextMenu`, `showTooltip`, `hideTooltip`, `releaseTooltip`                              |
| the Agents            | `agents.html`        | every running terminal Agent's pane, all mounted, the selected one not hidden, and the Orchestrator's board                | the projection, the appearance, the repository status, the agent actions, the terminal transport, the conversation transport (`conversation`), `openModal`, `openExternalUrl`, `writeClipboard`                                                                                                |
| the Conversations     | `conversations.html` | every running GUI Agent's conversation, the same way, in the Agents' rectangle (right of the board for a GUI Orchestrator) | as the Agents (the same preload)                                                                                                                                                                                                                                                               |
| a terminal            | `pane.html`          | an Agent's own terminal, on the right; or a Workspace's, as its editor area (`editor = "neovim"`): a terminal surface only | the projection, the appearance, the terminal transport, `openExternalUrl`, `writeClipboard`                                                                                                                                                                                                    |
| a Neovim              | `neovim.html`        | a Neovim drawn from its UI protocol exactly over its terminal pane (`general.editor = "neovim"`)                           | the projection, the appearance, `neovim` (attach, calls, GUI windows), `openExternalUrl` — [neovim-editor.md](neovim-editor.md)                                                                                                                                                                |
| the notices           | `toasts.html`        | what the application has to say, over whatever is on screen, and the notice center                                         | `nativeError`, `appCondition`, `actionStarted`, `menuCommand`, `noticeSettings`, `reportListening`, `reportNoticeRetired`, `reportToastsSize`, `retryApp`, `openSettings`, `focusSurface`                                                                                                      |
| the tooltip           | `tooltip.html`       | one box with a row's facts in it, over whatever is on screen; its GitHub pages are links                                   | `tooltipText` in; `tooltipSize`, `tooltipPointer`, `openExternalUrl` (GitHub pages only) and `writeClipboard` (a row's paths) out. **Nothing else** — in particular not the anchor or the side, which are the owner's.                                                                         |
| the questions         | `picker.html`        | every sheet DevHub stops on, over every workbench                                                                          | `modalsChanged` **(only here)**, the projection, the appearance (for the monospace family alone), the agent profiles and actions, a folder's earlier Agent sessions and their previews, every way of opening a Workspace, the two ends of a reviewed message, the worktree close, `closeModal` |
| Settings              | `settings.html`      | its own window                                                                                                             | `SETTINGS_CHANNELS` in full, plus the failure contract every page has                                                                                                                                                                                                                          |
| Task Manager          | `task-manager.html`  | its own window: what each Workspace, workbench and Agent costs ([task-manager.md](task-manager.md))                        | `TASK_MANAGER_CHANNELS` in full, plus the failure contract every page has                                                                                                                                                                                                                      |

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

**The Orchestrator row is the Agents page too.** Selecting it lays the
Agents view over the whole content area, as a full Agent does, and the page
draws the board in the left part of its own rectangle beside the orchestrator
agent's pane from the same pool — so it adds no view, no z-order and no
keyboard rule. See [`orchestrator.md`](orchestrator.md).

**The Orchestrator row is also a Workspace's row**, in the Sidebar, the way
Scratch's row is Scratch's Workspace's: the orchestrator's folder is not
drawn as an ordinary row (`sidebarWorkspaces` hands it out as `orchestrator`,
apart from `scratch` and `rows`), and its Agents other than the orchestrator
are the row's children, drawn by the same `AgentTree` every Workspace's
Agents are. A child selected is an ordinary Agent selection — its pane, full
or beside the root's workbench. The root's workbench itself is that Workspace
selected, and the content area is its workbench as for Scratch; the
Orchestrator row stays highlighted, and its right-click **Show Editor** is
the way there from the Sidebar (the Files tab's エディタで開く is the other).

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
same. So are the Orchestrator row's: that row is its Workspace's row (the
orchestrator's folder, `docs/orchestrator.md`), so closing its last helper
lands on the row itself — the board, not the orchestrator agent drawn as a
pane. A Workspace is held by the Sidebar, so closing one lands on the next
row as drawn — the Orchestrator row's Workspace, Scratch, each Workspace
followed by its Agents, the same list `Cmd+Q N` and `]` walk — which is the next Workspace's row, because its
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

## What was closed comes back: `Cmd+Q Shift+T`

`Cmd+Q Shift+T` (`reopen_closed`, "Reopen Closed Agent or Workspace" in the
command palette) is the browser's Reopen Closed Tab: it brings back the most
recently closed Agent or Workspace, and pressed again it goes further back.
`Recently Closed…` (palette only, `open_recently_closed`) is the same list as
a picker, for the one that is not on top. The rules are in
`model/recentlyClosed.ts`; main keeps the stack (`AppController`, region
"recently closed").

- **The stack** is newest first and holds 20. It is written to `state.json`
  as `recently_closed` with the rest of the state, so it survives a restart;
  a file from before it loads as the empty stack, and an entry that does not
  read is left out rather than refusing the file. A Workspace closed again
  replaces its older entry; every closed Agent is an entry of its own. With
  nothing on it the chord is a no-op.
- **What is remembered.** Only a person's close: an Agent stopped from its
  row, `Cmd+Q X` or its sheet, and a Workspace closed any way it can be. Not
  an Agent whose CLI ended by itself, not the Agent a Continue in
  Terminal/GUI replaced (its session goes on in the new one; the coordinator
  marks that stop `replaced`), not a worktree its close deleted (there is no
  folder to come back to), and never Scratch. A Workspace entry is its place —
  the machine (this Mac or an ssh host) and the canonical folder — and the dev
  container its editor was attached to, with the Agents running in it. An
  Agent entry is its Workspace's place, its profile, its name and whether a
  person gave it (`Agent.named`), GUI or terminal, and the session id its CLI
  named (Claude's session, Codex's thread). The session is asked for while
  the CLI is still running — the GUI conversation knows it, a terminal
  Agent's is read from its processes — for at most 3 s; one that cannot be
  told is still closed, it is only not resumable.
- **Reopening an Agent is resuming it.** It is started again in its
  Workspace — opened again first if it was closed too — from the same
  profile and presentation, resuming its session through the same
  `create_agent` … `resume` path the agent picker's past sessions take, and
  renamed if a person had named it. An Agent with no session, of a CLI DevHub
  cannot resume, whose profile is no longer configured, or whose Claude
  session file is gone is **not** started afresh: a notice
  (`closed_not_reopened`) says why and the entry is dropped, so the next
  press goes further back.
- **Reopening a Workspace** opens its folder again on its machine, attaches
  its editor to its dev container again, and starts again every one of its
  Agents that can be resumed; the ones that cannot are named in the notice.
  If the folder is open already it is focused instead, and its Agents are put
  back on the stack to be brought back one press at a time. A folder that is
  gone is said, and the entry dropped.
- **A failure before anything was opened** — the machine did not answer —
  puts the entry back where it was, and the notice says another press tries
  again. Once something has been opened, a failure is said and the entry is
  gone.

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

## The notices hide themselves into the notice center

A toast stays up for `general.notice_seconds` (default 8, Settings > General >
Notifications; `0` never hides one) and then hides itself
(`shell/toasts/autoHide.ts`). The clock stops while the pointer is on the
toast, while the keyboard is in it, and while words in it are selected; when
the person moves away it runs on from where it stopped, with at least two
seconds left. Both kinds hide: a failure, and a standing condition (a `gh`
missing, a machine not answering) — a condition has been said once it has
been seen, and keeping it in the corner for as long as it holds is what made
the corner noisy. Hiding is not dismissing, but it is put away the same way:
the lifetime rule remembers it, so a repeat does not bring it straight back,
and main's journal hears it left with reason `timeout`.

What reached the screen is kept in the **notice center**
(`model/noticeCenter.ts`, `shell/toasts/NoticeCenter.tsx`): the last 100, in
memory, newest first, each with its time, its kind (Error, or a condition that
is Ongoing or Resolved), its words selectable and copyable, and its actions
while it is still in force — a failure until the person's next action or a
newer failure, a condition until its source retracts it. An entry is unread
until the person has seen it: the pointer or the keyboard on its toast, the
toast's ×, or opening the center. The toast's × keeps the entry, read; the
center's own × (or Delete) and Clear All remove entries, and the toast with
them.

It is drawn by the notices page itself, in place of the stack: that page
already holds every notice and is already a layer over the whole window, so
the center is the stack grown into a list, measured and placed by the same
rule, with no copy of the notices in another page. `Cmd+Q M` (Show
Notifications, also in the palette) sends `show_notifications` to that page
and gives its view the keyboard — not under a question, which holds the
keyboard; the page opens the center, or closes it if it is open. Arrows move
between entries; Escape, the chord again, or a click elsewhere closes it, and
Escape hands the keyboard back with `focusSurface`. There is no unread count
outside the center: the Sidebar and the title bar are other pages with no
notices in them, and a badge there would be a second copy of this state.

## The palette is a third audience

There are three kinds of thing main says, not two. A _projection_ describes the
model and goes to every page that draws from it. A _failure_ is an event and
goes to the one page that draws failures. A _palette_ is neither: it is how
everything in the window is painted, and it goes to every page DevHub draws
chrome on — which is all ten (every terminal pane among them, and the
Settings and Task Manager windows, which are told by their own windows'
`apply…Palette`).

That last one used to go out on the projection audience, which coincided with
"every page that draws chrome" until the `toasts` page arrived: it has `onTheme`
on its bridge, no model behind it, and had therefore never been recoloured at
runtime. Nobody noticed, because a stale palette is only visible after a theme
change. The tooltip would have been the second page with the same silent gap —
the Sidebar _is_ in the projection audience, so the tooltip it used to draw
recoloured correctly, and one on its own page would not have. `chromeAudience`
states the rule instead of it being a coincidence, and the test on it is that
every page with `onTheme` is in it.

The palette is DevHub's own answer, not a workbench's. `[appearance] theme`
selects a colour theme — one name, or `light:<name>,dark:<name>` as Ghostty
spells it — among DevHub's built-in themes and the file's own
`[themes.<name>]` tables, and the appearance the process is in
(`appearance.mode`, the OS under `auto`) picks the half
(`main/shell/shellTheme.ts`). A theme is a terminal palette: sixteen ANSI
colours, the background and foreground, the cursor, the selection. The
shell's anchors, its accent, the terminals' colours and the Neovims DevHub
draws are all derived from it (`model/themes/theme.ts`); see
[themes.md](themes.md) for the themes, the settings and the derivation. A
name no theme has is said once (`color_theme_unavailable`) and DevHub's own
theme for that half is worn instead.

A VS Code workbench is told nothing: with `editor = "vscode"` it wears the
theme its own `settings.json` names, as any VS Code does. (DevHub used to read
VS Code themes from the installed extensions and Open VSX, tell every
workbench to wear the same one through its memory configuration, and hand a
starting workbench the theme on its window configuration. All of that is
gone.) The shell's pages are served with the palette in their `<head>`
(`shellPageProtocol.ts`), and the window and the Settings window are created
with its ground as their background, so the first frame is already in it.

### Theme: Preview…

The command palette's **Theme: Preview…** (`preview_color_theme`, palette
only) and Settings' Preview Themes… open a picker of every theme that can be
worn (`themePreview.ts`), the one worn now first. The row under the cursor is
worn at once — `ShellTheme.wearTemporarily(name, "preview")`, which is the
same change as any other: the window and its pages, the terminals, the
Neovims DevHub draws, and the programs in the terminals through the
publication below. Return keeps it
for the session; Escape puts back what was worn before the picker opened.
Nothing is written: the settings still name what they named, and the next
time they are applied — a save, Reload in Settings (even when the file did not
change), a restart — `ShellTheme.configure` drops the temporary theme. While
one is worn, the published theme says `temporary: true`.

### Terminal programs

DevHub tells the programs in its own terminals — the Workspaces' `ws-` tmux
sessions, Scratch, the Agents' sessions, the managed Neovim — which theme it
wears, so that an fzf, a prompt or a Neovim DevHub does not draw can follow
it. The value is `model/publishedTheme.ts`'s and its delivery
`main/shell/themePublication.ts`'s; it is the theme worn now (a temporary one
included) with the palette DevHub's own terminals are given under it.

**Environment**, for every new pane. Stated in each DevHub tmux server's
_global_ environment: a new server is started with it (so Scratch's very first
pane has it), a server an earlier DevHub left running is told on bring-up, and
every running server is told again with `set-environment -g` when the theme
changes. Panes already running keep the environment they started with.

| Variable                  | Value                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `DEVHUB_THEME`            | the theme's name, as `[appearance] theme` says it (`Nord`, `DevHub Dark`)                  |
| `DEVHUB_THEME_KIND`       | `dark` or `light`, by the theme's background                                               |
| `DEVHUB_THEME_BACKGROUND` | `dark` or `light`: what a program that knows only two should take                          |
| `DEVHUB_THEME_COLORS`     | `bg=#rrggbb fg=… cursor=… cursor_text=… selection=… [selection_fg=…] color0=… … color15=…` |
| `DEVHUB_FZF_COLORS`       | a ready `fzf --color=` value: `fg:…,bg:…,hl:…,fg+:…,bg+:…,…`                               |
| `DEVHUB_THEME_FILE`       | the file below (on this Mac only; a host's panes get the rest)                             |

**The file**, for programs already running: `$XDG_STATE_HOME/devhub/theme.json`
(`~/.local/state/devhub/theme.json` when `XDG_STATE_HOME` is unset;
`devhub-<profile>/` for another profile). Written before the first terminal
starts — synchronously, so a Neovim colouring its first frame from it never
finds it missing — and again a moment after every change (one write per pause
while the preview moves), always whole: written beside and renamed into place,
so a watcher (`fs_event`, `inotify`, kqueue) sees only complete files. Its
object, `version: 1`:

```json
{
  "version": 1,
  "name": "Nord",
  "kind": "dark",
  "background": "dark",
  "temporary": false,
  "colors": {
    "background": "#2e3440",
    "foreground": "#d8dee9",
    "cursor": "…",
    "cursorText": "…",
    "selectionBackground": "…",
    "selectionForeground": "…",
    "ansi": ["#3b4252", "… sixteen …"]
  },
  "neovim": {
    "background": "dark",
    "highlights": { "Normal": { "fg": "#d8dee9", "bg": "#2e3440" }, "…": {} },
    "terminal": ["#3b4252", "… sixteen …"]
  },
  "fzf": "fg:#d8dee9,bg:#2e3440,…"
}
```

Every colour is `#rrggbb`.

**The Neovims DevHub draws** — the managed one, and each terminal's `nvim`
once DevHub's UI is attached to it — are told over their msgpack-rpc socket
as they are started, adopted or attached and whenever the theme changes:
`g:devhub_theme` (the name), `g:devhub_theme_kind`,
`g:devhub_theme_background`, `g:devhub_theme_info` (the whole object above),
the `DEVHUB_*` variables in its environment, and then `User DevhubTheme` fires
with the object as its `data`. Then DevHub's colorscheme (`neovim` in the
object) is applied as `devhub`, unless the person's config chose another
colorscheme; see [themes.md](themes.md), "Neovim". A handler that throws is
logged and changes nothing else.

**devhub.nvim** is a Neovim colorscheme built on exactly this
(`:colorscheme devhub`) for a Neovim DevHub does not draw: it reads the file
synchronously from its `plugin/`, before the first redraw, and follows `User
DevhubTheme`. See its README.

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
`z`, `o`, `Cmd+J`, `Shift+J`, `Shift+O` — goes through one door, `AppController.arrive`: the
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
Scratch on the way out, or the editor it came from on the way back — and
`Cmd+Q Shift+O` coming back from the Orchestrator screen to an editor focus
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

**Inside a workbench the keyboard lands where VS Code leaves it.** Main puts
the keys in a workbench's contents; where they land in it is whatever element
had the focus there last, as in VS Code. There is no safety net that moves a
focus left on `<body>`: where a DevHub change lost the focus, the change puts
it back itself (DevHub Vim's `:q` in a comment widget focuses the widget's
editor before the widget folds or goes, docs/vim.md). Notices never take the keys (`ToastsView.place`); the notice
center does only when asked for (Show Notifications), and hands them back
with `focusSurface` when it closes.

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

**A workbench has no secondary side bar.** DevHub already docks its own
panes beside the editor, and a second VS Code side bar there competed with
them — one more thing that came and went at the side, Chat opening in it by
default and maximizing it when VS Code thought it should. So in DevHub that part is never shown, and
everything it would hold is in the primary side bar: Chat, an extension's
`secondarySidebar` view containers, and anything a person had moved there
before.

It is decided in the workbench, in two halves. The patch
(`patches/vscode/0012-no-secondary-side-bar.patch`) makes the layout never
show or maximize the part (a layout saved with it open, or maximized, comes
back without it), gives a view container registered for it the primary side
bar as its default location — so it lands there, and "Reset Location" puts it
back there — and takes out what would show it or move something into it: its
toggles in the title bar's layout control, the Appearance menu and Customize
Layout, `Cmd+Alt+B`, its Command Palette entries (focus, maximize,
next/previous view, the panel's move to it), "Move To ▸ Secondary Side Bar" on
an activity bar icon and "New Secondary Side Bar Entry" in Move Focused View.
The overlay's `devhubNoAuxiliaryBar.contribution.ts` moves to the primary side
bar any view container that is in the secondary one anyway — a saved custom
location, a command or extension moving a view there — saved the way a
person's move is, and makes `workbench.action.toggleAuxiliaryBar` and
`workbench.action.focusAuxiliaryBar`, which a keybinding or an extension may
still run, toggle and focus the primary side bar.

## Chords are answered in main

`keyboard.ts` installs `before-input-event` on every WebContents DevHub owns,
through `app.on("web-contents-created")`. That is the only place a chord can
work: it sits in front of every surface, and a completed chord is
`preventDefault`ed there so its keys never reach the surface underneath.

So after the prefix the keyboard has to be in a WebContents, and while a chord
is armed DevHub keeps it in one: it stays where the prefix was typed, and any
move DevHub would make meanwhile (the workbench that had it being replaced —
waking, restarting, crashed — or a workbench chosen before it existed
arriving) goes to the window's own page instead, which is never swapped; the
move it stood for is made when the chord ends (`ShellWindow.chordArmedChanged`).
A key in no WebContents goes to the menu bar, which is often the workbench's;
there is no second road for chords through menu accelerators. A workbench menu
item that falls back to an empty window because no workbench has the keyboard
(New Text File, New Window — `OpenContext.MENU`) opens nothing, rather than
Scratch (`devhubWindowsMainService.ts`).

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
`dismiss_alert` (with `show_notifications`) is delivered to the page that has
the notices.

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
first if it is not there, so a discarded or closed editor finds them when it
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
default key — when it already has a gesture elsewhere or is rare:
`focus_sidebar`, `open_log`, `open_recently_closed`, `preview_color_theme`,
`open_task_manager` and `install_cli` (**DevHub: Install 'devhub' command in
PATH**, the launcher from `main/cli/install.ts`, whichever editor the Workspace
has) are today (`PALETTE_ONLY_COMMANDS`).
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

## The window's title

The window's name says what is being worked on, for anyone — or any time
tracker — reading window titles: the element, the Workspace, then DevHub
(`ipc/windowTitles.ts` is the rule, `main/shell/shellTitle.ts` collects its
facts). The Workspace part carries the Issue its branch names, the one the
Sidebar's row shows, right after the Workspace's name:

| The Workspace is on                         | Title                                           |
| ------------------------------------------- | ----------------------------------------------- |
| a branch whose Issue is known               | `reconciler.ts — widget #123 — DevHub`          |
| an Issue that lives in another repository   | `reconciler.ts — widget acme/plan#123 — DevHub` |
| a pull request's branch that names no Issue | `reconciler.ts — widget PR #130 — DevHub`       |
| neither                                     | `reconciler.ts — widget — DevHub`               |
| (an Agent selected)                         | `Reading the reconciler — widget #123 — DevHub` |
| (nothing open in the Editor)                | `widget #123 — DevHub`                          |

- **`#N` is always an Issue, `PR #N` always a pull request.** GitHub numbers
  both in one sequence and writes both `#N`, so the pull request carries the
  `PR ` prefix to stay unambiguous. A branch with both shows the Issue.
- **`owner/repo#N`** only when the Issue (or pull request) is not in the
  Workspace's own repository (`origin`): an upstream's Issue in a fork, or one
  whose URL names another repository — the case the row's tooltip says as
  _Issue in `owner/name`_. Otherwise the number is bare.
- **No Issue known, no number:** a branch that names none, an Issue still
  being read (_Reading #N_) or unavailable, and a Workspace that is not a
  GitHub repository are titled exactly as before.
- It is read off the same projection as the row
  (`WorkspaceRepositoryWire`), and the title is recomposed whenever that
  projection is published, so switching branches renames the window as soon
  as the row changes. The Orchestrator screen names an escalation's Workspace
  the same way ([orchestrator.md](orchestrator.md)).

## Back and Forward

The window keeps a browser's history of the places it has shown, and the title
bar draws Back and Forward beside the Sidebar button.

**An entry is the selection** (`AppModel.selection`): a Workspace, an Agent,
or the two side by side, with the presentation it was shown in. That is the
shell's whole notion of "where you are", so there is no second record of
pages to drift from it.

**A place enters it once somebody does something there**, not when the
selection passes over it — so Back skips what `Cmd+Q N`/`P` only flicked past:

| What happened while the place was shown                                                                                                                                                                                                                                                                                                                                               | Recorded?             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| a key typed into it (not a chord's strokes, not a modifier alone, not `Cmd+[`/`Cmd+]`)                                                                                                                                                                                                                                                                                                | yes, at the first one |
| a press of the left, middle or right button, or a scroll, in it (a drag starts with a press)                                                                                                                                                                                                                                                                                          | yes, at the first one |
| arriving on purpose: a new Agent (`AppModel.addAgent`), an explicitly opened Workspace (`Cmd+Q F`'s picker …), a click on a Sidebar row (a Workspace, an Agent, Scratch, the Orchestrator), `Cmd+Q Shift+O` (to the Orchestrator and back), a click on a `devhub:` link's chip (`model/devhubLink.ts`), `devhub --tell focus`, Enter or a click on a not-running editor's placeholder | yes, at once          |
| `Cmd+Q N`/`P`, `Cmd+Q 0`–`9`, the tab picker, the Sidebar walked from the keyboard (its Return included), `Cmd+Q Shift+J`, a selection repaired after a close, a command line that does not take focus                                                                                                                                                                                | no                    |
| Back and Forward themselves (the arrows, keys, side buttons, swipes)                                                                                                                                                                                                                                                                                                                  | no                    |

"In it" means its views: a workbench (and what it hosts), the Agents' page (a
GUI conversation or a TUI's xterm) and a terminal pane (`pane.html`) and the Neovim
editor (`neovim.html`) — `isDestinationSurface` in
`historyKeys.ts`. The Sidebar is choosing where to go, not being somewhere, and
the window's own page holds the title bar's arrows, so neither counts; nor do
the modals, the notices, the tooltip, Settings or a Web Inspector. Main sees
it all without the pages' help: keys in the chord layer's
`before-input-event` (`ChordHost.interacted`, after the chords and the history
keys have had theirs), presses and scrolls in each contents' `input-event`
(`isPointerInteraction`; a move is one field read and nothing more). The entry
is the selection at that moment, deduplicated against the cursor's entry
(`AppModel.interactionIsNew` is asked first, so a thousand keystrokes dispatch
one `note_interaction`). From a place with no entry, Back goes to the cursor's
own entry — the last place recorded — and Forward is what it was: passing on
cuts nothing off; doing something there does.

Arriving on purpose is said by the move itself, never inferred from the
input: a selection or a folder open that carries `reason: "explicit"`
(`NavigationReason` in `model/intents.ts`) is recorded by the model the moment
it is made, by the same rule an interaction is — the place the cursor already
names adds nothing, so clicking the row you are on is not a second entry. The
Sidebar tells a click from Return by the click's `detail` (`useSelectRow`), the
picker's open says it in `openFolder` (not for a folder opened _for_ an Agent:
the Agent is the place), and `focus` from the command line says it in its port.
There are no tabs or pane headers to click: a press in either half of a split
is already an interaction there.

The rest of the rules are `model/navigationHistory.ts`'s, and they are a
browser's: going back and then doing something somewhere new cuts Forward
off; Back and Forward do not record themselves; the same place twice in a row
is one entry; the two
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
keeps the three things only it can know — when (as soon as the pointer is on
a row, `HOVER_DELAY_MS` being nothing now, and as soon as the keyboard
reaches one), that there is one tooltip for the whole tree, and what it says — and
sends an anchor in the _window's_ coordinates. That conversion is one addition:
the row's box, plus the rectangle main tells the view it occupies
(`sidebarAreaChanged`). Never `window.screenX`, and never the view's own box,
which is stale for a while after main moves it.

Where it then goes is `windowLayout.ts`'s `tooltipRect`: the side the row
prefers, flipped to the other side of the anchor when that one has no room, and
clamped to the window last. It flips rather than narrows — one rectangle with
one width, because narrowing to fit is how the ribbon happened.

The view is exactly the box's size, and never a fraction of a pixel less: a
view smaller than its box is a document that overflows, and that overflow is a
scrollbar in the hover. So the page measures the box's border box on every
change — a `ResizeObserver` on it, a `MutationObserver` on what is in it (the
copy button's check, new words), and once its fonts are ready — and rounds
**up** to a device pixel (`tooltipSize.ts`); main scales that by the page's
zoom and rounds up again (`TooltipView.setSize`). Nothing in the box may
overflow it: every line wraps, the qualifier included (held on one line, a long
worktree path ran past the box's edge, which was the scrollbar the hover
showed). Main also tells the page the room the window has (`tooltipRoom`, sent
as `TooltipContentWire.room`); the box wraps to that width and stops at that
height — what is past it cut at the box's edge under a fade, never a
scrollbar — so `tooltipRect`'s clamp never has to cut a box short. The page's
`html` and `body` are `overflow: hidden` as the backstop for rounding, not as
what keeps content in.

What has a hover is a whole row, and the usage limits — nothing smaller:

- **A Workspace row** — on the rail as in the expanded column: its name, with
  where it is beside it as a subdued qualifier (_· SSH: host_, _· dev container:
  name_) rather than lines of their own; the repository (a link to it on
  GitHub); then **one** path line — the folder written with `~`, and for a
  worktree what it was cut from on the same line, subdued and with `~` too
  (_~/src/widget-tooltips (worktree of ~/src/widget)_) — each path with a quiet
  copy button **inline right after it**, in the text like a character: sized
  in `em`, it follows the path's last character (held to it with `nowrap`, so a
  wrap never leaves it alone at the start of a line) and wraps with the words,
  the worktree's inside the bracket (`qualifierCopyAfter`). It copies the
  absolute path through main (`writeClipboard`) and shows a check for a
  second; the branch; the Issue
  (number and title as a link to it, Projects behind their own mark, and
  _Issue in `owner/name`_ when it is numbered in another repository); the pull
  request (a link to it) with its conversations and CI; _Reading #N_ while the
  Issue is being read; _Unavailable: …_ when it could not be; and _Retry close:
  …_ with why the last close stopped. One line per fact. What × would do is
  not described: its accessible name says it.
- **An Agent row** — its leading text behind its status mark, what a named
  Agent is doing, _Retry stop: …_ with why once a stop failed, and its prompt
  cache (warm or cold, time left, hit rate, the auto-compact due; see
  [agent-gui.md](agent-gui.md)).
- **The usage limits** — every window per CLI as a bar, its reset (_Resets in
  2h 10m · 16:40_), when it was read (_Updated_ / _Not refreshed_), and notes.

What has none: every mark, glyph and button inside a row — the Issue and pull
request marks, the unavailable and dev-container marks, the reading spinner,
the status marks, +, × and stop — and the controls outside rows (Assign issue,
the picker). The pointer on anything inside a row is the pointer on the row,
and raises the row's tooltip. New Agent's reason for being off or needing
attention is in its accessible name (_Create agent in widget, unavailable: no
enabled agent profiles_ / _…, agent profiles need attention_) and on no hover.
The folder glyph at a Workspace row's start is an inert mark under the select
button's hit area, not a link; a click on it selects the row, and the
repository is followed from the row's tooltip.

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

One main process, one renderer per page (nine, of which Settings and Task Manager exist only
while they are open, and the terminal pane once per terminal), and one per workbench — though several workbench views can
share a renderer, which Chromium's same-site grouping decides.

A workbench is a renderer, an extension host and its language servers and
watchers, so one per Workspace adds up. DevHub keeps them the way Chrome and
Edge keep tabs: **frozen** when not on screen — every one of its processes
stopped with SIGSTOP, so it touches no memory and macOS compresses and swaps
its pages first, and continued with SIGCONT instantly, its state intact, its
connections still open — and **discarded** (closed) only after it has been
frozen a long while. Restarting a workbench is what used to hurt: a CPU spike,
seconds of waiting, and every server an extension hosted (vscode-review-relay's
loopback API, say) gone with it. Freezing costs none of that.

### States and transitions

Each folder's workbench is in one phase at a time (`WorkbenchPhase` in
`workbenchPlan.ts`):

| Phase                                     | What it is                                                           |
| ----------------------------------------- | -------------------------------------------------------------------- |
| _absent_                                  | not started in this run: its placeholder until it is asked for       |
| _starting_ (cause start, restart or wake) | an open in flight, or a view whose page has not loaded               |
| _running_                                 | its view loaded; _settled_ once it has finished starting             |
| _frozen_                                  | every process of it stopped (SIGSTOP)                                |
| _discarding_                              | thawed, being unloaded                                               |
| _discarded_                               | closed (frozen long, or stopped); its placeholder shows its frame    |
| _restart-waiting_, _gave-up_, _parked_    | failed: backing off, given up on, unavailable until Retry or Locate… |

```text
absent     ─ asked (Enter, Start) / requested ───────────────▶ starting
starting   ─ loaded ──────────────────────────────────────────▶ running
running    ─ hidden 3 s, settled, nothing keeps it (fresh probe) ▶ frozen
           ─ stopped (Cmd+Q Shift+E) ─────────────────────────▶ discarding ─▶ discarded
frozen     ─ shown / asked / requested / held / a connection ─▶ running
           ─ frozen workbench_discard_minutes / stopped ──────▶ discarding ─▶ discarded
discarded  ─ asked (Enter, Start) / requested ───────────────▶ starting (wake)
```

### The planner and its driver

What every workbench should be doing is decided by one pure function,
`decide` (`workbenchPlan.ts`), from facts and nothing else; it reads no clock
and keeps nothing. The facts per workbench (`WorkbenchFacts`): its phase,
local or not, shown, asked for (an ask, or a DevHub request waiting on it),
held (DevHub talking to it, thaw only), closing, asked to freeze (Sleep) or to
stop (`Cmd+Q Shift+E`), when it was last shown and
when it was hidden, settled, the renderer's last answer about what a freeze
would interrupt (`Probe`), when its sockets last carried traffic, when a
connection last arrived for it, and whether its renderer process also draws
another workbench. `WorkbenchLifecycle` (`workbenchLifecycle.ts`) holds the
facts, turns events into them — an open settled, a view loaded or died, a
probe answered, traffic, a connection, an unload finished — and, on every
`plan`, asks `decide`, moves each phase to match its answer (so a second plan
asks nothing twice) and hands the effects to the one executor,
`AppController.reconcileWorkbenches`: open, probe, freeze, thaw, discard,
dispose, report giving up or a stop that did not happen, and the placeholder
for each slot. The executor
runs a plan on every projection change, every event and every action that
completes, and at `nextDeadline` (a probe due again, traffic or a grace
running out, a discard due, a backoff over) — one timer, no others.

The rules (tested on fact fixtures in `workbenchPlan.test.ts`, races
included):

- **Nothing starts until it is asked for.** Not at launch, not in the
  background, not by opening or selecting a Workspace (`Cmd+Q F`, a folder
  from the command line, VS Code's own open, `devhub --tell workspace open`,
  a click on its row): its editor area is the placeholder ("Editor not
  running — press Enter to start", and a Start button) until Enter or the
  button asks for it (`wakeEditor`, an `asked` ask), or a DevHub request that
  needs it running waits on it — a file routed to it (`devhub <file>`,
  `devhub -`, `--wait`, a conversation's file link), Scratch's empty window,
  a dev container reopened or rebuilt. Asked, it starts at once, however many
  others are starting.
- **Shown, asked for or requested keeps it.** The shown workbench is never
  frozen, and a frozen one that is shown, asked for, requested, held or
  closing is thawed at once.
- **A person can stop one.** `Cmd+Q Shift+E` (`stop_editor`; `Cmd+Q E`,
  `focus_editor`, is taken) stops the selected Workspace's workbench — the
  Workspace's row or one of its Agents — whether it is on screen, hidden or
  frozen: the plan is asked (`LifecycleInput.stop`) and discards it, closing
  it exactly as a long frozen one is closed (below: thawed, unsaved editors
  backed up by hot exit, the same last-moment checks), and the slot goes back
  to the placeholder, with the frame it left; Enter starts it again (a
  wake). It is not stopped while it is starting, while its Workspace closes,
  while a DevHub request or hold needs it, or when it is SSH or a dev
  container (`stopRefusal`), nor when the unload is called off (unsaved
  editors with `files.hotExit` off, a veto): each of those is said, as a
  notice (`editor_not_stopped`), and it keeps running.
- **Settled.** A started workbench is probed every second until it has
  settled: its window has reached VS Code's last lifecycle phase
  (Eventually), its installed extensions are registered, and its renderer's
  and window utilities' CPU (from `app.getAppMetrics()`) has stayed under
  10 % for three seconds. Until then it is not frozen.
- **Freeze aggressively.** A running local workbench that is not on screen is
  frozen as soon as it has settled and nothing keeps it awake. The keep-awake
  reasons are one table, `AWAKE_RULES`: shown, asked for, held by DevHub,
  closing, not local, still starting, sharing its renderer (hard — a person's
  Sleep does not override them); hidden less than 3 s ago
  (`FREEZE_GRACE_MS`), network traffic on its sockets in the last 30 s, a
  connection that arrived in the last 30 s, and busy (soft). Busy is
  what the renderer says when it is probed: a debug session, a running task,
  an integrated terminal with a program in front of its shell. A DevHub
  terminal is tmux and never counts — it runs under the shared pty host,
  which is never stopped. **The grace after hiding:** a workbench that has
  just stopped being shown is neither probed nor frozen until 3 s after it
  was hidden — the planner's deadline, not a timer of its own — and a freeze
  always follows a probe taken after that grace (and since its last thaw).
  VS Code reports a terminal busy only about 2 s after its command starts
  (`ChildProcessMonitor`: a 1 s debounce after input, then `ps`), and a
  frozen workbench is never probed again, so without the grace a command
  started just before switching away was frozen while it ran — an
  output-heavy one then stalls on the pty's flow control. Shown again within
  the grace, nothing was asked and nothing happens. A workbench started
  hidden (a request for it) and never shown has no grace: it freezes once it
  has settled, on the probe that settled it. A probe answered after the person
  came back freezes nothing: the decision is made from the facts as they are
  when the answer lands. A busy one is probed again every 15 s.
- **A hidden workbench gives back its TextMate worker.** The worker's
  Oniguruma heap is a WebAssembly memory that grows to what the largest file
  it tokenized needed (70 MB resident after ~460 KB of TypeScript) and never
  shrinks. The renderer ends the worker when it answers the probe of a hidden
  workbench (once per hiding, so before the freeze), and every 30 s while its
  page stays hidden if the worker has sent nothing for 30 s (freezing off, or
  something keeping it awake); never while the page is shown
  (`devhubActivity/browser/hiddenTokenizerWorker.ts`,
  `patches/vscode/0015-textmate-worker-can-be-released.patch`). Models keep
  their tokens; each binds to a new worker, which tokenizes it from scratch,
  when it next needs one — an edit, an editor opening it, lines it is asked
  for — and one the old worker had not finished binds again as soon as the
  page is shown. The main thread's own Oniguruma heap (~40 MB after large
  files) stays: `vscode-oniguruma` loads its WebAssembly once per page and
  every grammar holds scanners in it.
- **Discard after a while.** Frozen for `general.workbench_discard_minutes`
  (default 60, `0` never), it is thawed and closed as VS Code unloads every
  window on Cmd+Q (`UnloadReason.QUIT`: unsaved editors backed up by hot exit,
  storage written, extensions deactivated) and its view destroyed. Asked at
  the last moment before the unload (`mayDiscard`): shown, asked for or held
  meanwhile calls it off, and so do unsaved editors with `files.hotExit` off.
  Started again, it opens through the ordinary open path, whose
  `registerFolderBackup` hands it the same backup folder, so VS Code restores
  its editors, layout and unsaved changes.
- **Freezing can be turned off.** `general.workbench_freeze = false` (default
  `true`; Settings → Editors, "Freeze hidden editors") is a fact of the plan
  (`PlanFacts.freeze`): nothing is frozen — not on hiding, not on the Task
  Manager's Sleep, which is then not offered — so nothing is discarded either,
  since a discard follows a freeze, and a workbench frozen when it turns off
  is thawed by the next plan (`why: freezing is off`). The probes until a
  start has settled, and a person's stop, go on as before. It applies live:
  an accepted setting plans at once.

**Everything that talks to a workbench goes through the lifecycle**
(`AppController.holdWorkbench`): a file routed to it, a reattach, Scratch's
empty window, a container's file, a close asking about unsaved work. The
request is a fact of the plan that follows at once — a frozen workbench is
thawed then and there, before the request's first message — and with `start`
a discarded or not yet started one is started and waited for (the one start
that is not Enter: what DevHub was asked to show in it needs it); nothing freezes
it while the request stands. A close's questions (`thaw`) never start a
workbench just to ask it.

### Freezing, thawing, and a connection

The processes of a workbench (`freezeTargets.ts`): its renderer
(`webContents.getOSProcessId()`), the utility processes VS Code started for
its window alone — named `<name> [<window id>]` in `UtilityProcess.getAll()`:
its extension host(s) and its file watcher — and everything under them. Never
Electron's other processes (main, GPU, network, VS Code's shared process and
pty host, DevHub's pages), never anything under the pty host (the integrated
terminals' shells and the tmux clients DevHub's terminal tabs are), never tmux
wherever it turns up. `WorkbenchFreezer` (`workbenchProcesses.ts`) stops the
renderer and the window's utilities at once, from what main knows, then the
rest of the tree once one `ps` has answered (a thaw meanwhile wins). Thawing
is synchronous and in reverse: the language servers and extension hosts
first, the renderer last, so the renderer resumes to an extension host that
already answers. Every frozen workbench is thawed when DevHub quits (a
stopped process ends on nothing but SIGKILL), and on Node's `exit`.

**Only what is exclusively the workbench's is ever stopped.** Before it
stops anything, main lists what must not be (`foreignPids`): main itself and
its parent; every Electron process that is neither a renderer nor a utility
process (`app.getAppMetrics()` type other than `Tab`/`Utility`: the GPU
process above all, which draws every page of the window); and the process of
every other WebContents in DevHub (`webContents.getAllWebContents()`): the
shell, the Sidebar, the Agents page, the toasts, the picker, every terminal
pane, every other workbench, every view the workbench attached. Chromium,
not DevHub, decides which contents share a renderer process, so this is
asked of the contents as they are, not assumed from their URLs. A foreign pid
is never stopped and never walked into, even when main named it as the
workbench's own (`freezeTargets`' `foreign`); a workbench whose renderer is
foreign is not frozen at all, and the planner keeps one whose renderer also
hosts anything else awake (`sharedRenderers`, from every live WebContents,
not only the workbench views). A SIGSTOP on a shared process would stop the
page in it with the workbench — the whole window, for the GPU process or the
shell — and nothing would continue it.

**Nothing stays stopped that the lifecycle does not know to be frozen.**
Each plan is told which folders the freezer holds stopped
(`LifecycleInput.stopped`); one whose phase is no longer `frozen` — it
failed while frozen, its view went, it is no longer wanted — is thawed in that
plan, before any dispose or open (`thawed: its processes were stopped while
<phase>` in the log). A freeze of a folder the freezer still holds continues
what the earlier one stopped first, so no record is dropped with its
processes still stopped. Each completed freeze says what it stopped:
`[devhub] workbench '<folder>' frozen: stopped <pids> (renderer <pid>,
utilities <pids>)`.

**A hangup ends freezing for the run.** Stopped processes in DevHub's
process group are what the kernel's orphaned-process-group rule hangs up
(`processGroupAnchor.ts`), and the SIGHUP ends every renderer, the GPU and
network processes and the extension hosts while main, which answers SIGHUP
itself (`quitTrace.ts`), stays up behind a window whose pages are gone. A
freeze needs the anchor holding, and none happens once main has taken a
SIGHUP in this run (`hungUpAt`): one hangup means the anchor did not hold on
this machine, and another freeze would do it again.

A stopped process cannot `accept()`, but the kernel still completes the
handshake of a TCP connection to its listening socket and queues it. So while
anything is frozen, `WorkbenchSensors` reads every listen queue twice a second,
one reading for all frozen pids (`listenQueues.ts`): on macOS `netstat -Lan -p
tcp` (`qlen`), joined on the local address with the owners `lsof` read when
the workbench was frozen (a stopped process opens no socket, so they hold); on
Linux `/proc/net/tcp{,6}`'s backlog joined on the inode with
`/proc/<pid>/fd`. A connection waiting thaws the workbench in the next plan,
with no delay of its own — the latency is the poll, 0.25 s on average and
0.5 s at worst, plus one `netstat` — and keeps it up for a 30 s grace, so a
CLI like vscode-review-relay's just works. Only TCP; a Unix-domain socket
does not thaw a workbench.

Traffic is sampled every 10 s while a local workbench runs
(`socketTraffic.ts`): on macOS `nettop -P -L 1 -x -n -J bytes_in,bytes_out`,
traffic being a per-process total that moved between two readings; on Linux
`ss -Htinp`'s `lastsnd`/`lastrcv`. Socket traffic on the workbench's tree in
the last 30 s keeps it from being frozen, so a workbench whose ports are
talking does not churn between frozen and thawed.

A frozen renderer is not a hung one. A workbench view holds Electron's
`unresponsive` back from VS Code while frozen and for 10 s after a thaw
(`ResponsivenessGate` in `workbenchView.ts`), so the "window is not
responding" dialog and its sampling profiler never start for one; the patch
`0014-rpc-protocol-ignores-a-stopped-clock.patch` makes VS Code's
renderer↔extension-host responsiveness check (`RPCProtocol`) start its
countdown again when its own check ran long after it was due — its process
was stopped — rather than declare the other side unresponsive across the
freeze.

**Remote workbenches are excluded from freezing and discarding for now.** An
SSH or dev container workbench's extension host is on the far machine, and
stopping the local renderer alone would stall its connection's heartbeat. They
start when asked for, like any other, and stay up: `Cmd+Q Shift+E` does not
stop one.

### Placeholders, the Task Manager, the log

The placeholder (`Discarded` in `SurfaceState.tsx`) is the whole editor area
of a workbench that is not running — not started yet, stopped, or discarded:
the frame it left (none for one never started), grey under a quiet scrim of
`--canvas`, one centred line — "Editor not running — press Enter to start" —
and a Start button under it. It fades in on `--motion-slow` /
`--ease-standard` (none under reduced motion). The button takes DOM focus
when it appears and whenever the page gets the keyboard back (main puts the
keys in the window's page while no workbench stands in the slot); Enter, the
button or a click anywhere on the area calls `wakeEditor` (an ask, `asked`),
and every other key does nothing — DevHub's `Cmd+Q` chords still work, since
main takes them before any page. Started, it shows the "Starting VS Code…"
spinner (over the dim frame, if there is one) until the view has loaded, and
the keyboard goes into the workbench when it arrives. A frozen workbench needs no
placeholder: it is thawed the moment it is shown, and its view still holds its
last frame.

What the slot shows is the phase (`placeholderOf`), sent to the page whenever
it changes (`editorPlaceholder`), so it cannot outlive its state: "Restarting
the editor…" while restart-waiting or reopening after a failure, the "not
running" line (and the frame) while not started yet or discarded, and
"Starting VS Code…" while starting (the view `hidden` in the arrangement, a
split keeping its Agent); the frame lives in memory only. Only a change is sent, so
the page, once it listens, asks for every placeholder standing
(`replayEditorPlaceholders`, `WorkbenchLifecycle.standing`). A workbench that
dies unasked is opened again after a backoff that doubles from 250 ms
(`editorSupervisor.ts`), and after five failures in a row it is given up on
and its Workspace made unavailable (Retry or Locate… bring the placeholder
back, and Enter starts it); one that dies while discarding is simply
discarded.

The Task Manager shows each workbench's phase (running, starting, frozen,
discarding, discarded, not started, restarting, failed), and its Sleep is a
freeze now (`LifecycleInput.freeze`): past the soft reasons — the grace
after hiding included — never past the hard ones. Every transition, every ask, every probe that keeps a hidden one
up (said once per reason) and every discard called off is a line
`[devhub] workbench '<folder>' …` in main's log
(`<userData>/logs/devhub-main.log`, `DevHub: Open Log`).

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
