# The window, its children, and what each of them may say

DevHub is one window with several web contents in it. This is what owns what.

A Workspace's editor area is its terminal page, with the Neovims in it drawn
over their panes (`docs/neovim-editor.md`). It used to be a VS Code workbench
laid into the window as a view; that went with VS Code
(`docs/without-vscode.md`).

It is written as the answer to five questions that used to have more than one
answer each: where anything is drawn, what each page may ask for, where a
failure goes, where the keyboard is, and what happens when something goes
wrong. Every one of them is now decided in exactly one place.

## One layout owner

`main/shell/windowLayout.ts` is a pure function from the window's size and the
arrangement to a list of children — each with a rectangle, a visibility and a
position in the list. **The list's order is the z-order**, lowest first:

    the window's own page → the Sidebar → every editor area (the one on
    screen last among them) → the Agents → every terminal pane → the notices
    → the questions → the tooltip

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
to nothing on a collapsed rail. A native menu is above every view and is drawn
and keyed the way every Mac menu is.

`ShellWindow.layout()` is the only thing that reads it, and it is the only
thing that calls `setBounds` or `setVisible` on anything. Nothing else in
DevHub has an opinion about where a view is.

**A view is moved and resized in two steps when the arrangement changes.**
A view's picture is its page's last frame, so a view given a new origin and
a new size at once shows its old picture at its new place until its page
draws again — the conversation 209px off as the Sidebar collapsed.
`ShellWindow.layout` resizes such a view off the window first
(`stagingRect`), and moves it to its place at that size once its page has
said it drew there (`settleLayout`, answered in every preload by
`bridge.ts`, or after 200 ms). Which moves those are is
`movesStalePicture`; a drag and a window resize are followed as they go
(`setLayoutState`'s `live`). See [`motion.md`](motion.md).

**A `WebContentsView` inside another `WebContentsView` is not painted.** On
macOS with this Electron a nested view is not composited at all: its renderer
runs at the display's full rate and reports itself visible, and nothing
appears. The same view, at the same rectangle on screen, added to the window's
own `contentView` draws and animates. Nothing automated can show this —
`win.capturePage()` does not include child views either — so it is written
down here rather than guarded by a screenshot test: every view in this
window is a **sibling** in the window's own child list, the Neovims drawn over
a terminal's panes included.

No page measures anything the owner decides. The window's own page used to
leave a hole for the editor, measure it with a `ResizeObserver` and report
it back, which made main's idea of the layout a page's idea of it one frame
late and made every window resize a round trip through a renderer. Now main
computes the rectangle and _tells_ the page (`workbenchAreaChanged`), and the
page draws its own states into the same rectangle the editor is laid into.

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
| a terminal            | `pane.html`          | an Agent's own terminal, on the right; or a Workspace's, as its editor area (`editor = "neovim"`): a terminal surface, and every Neovim DevHub draws in one of its panes | the projection, the appearance, the terminal transport, `neovim` (attach, calls, GUI windows: [neovim-editor.md](neovim-editor.md)), the Neovims over its panes and their keys, `openExternalUrl`, `writeClipboard` |
| the notices           | `toasts.html`        | what the application has to say, over whatever is on screen, and the notice center                                         | `nativeError`, `appCondition`, `actionStarted`, `menuCommand`, `noticeSettings`, `reportListening`, `reportNoticeRetired`, `reportToastsSize`, `retryApp`, `openSettings`, `focusSurface`                                                                                                      |
| the tooltip           | `tooltip.html`       | one box with a row's facts in it, over whatever is on screen; its GitHub pages are links                                   | `tooltipText` in; `tooltipSize`, `tooltipPointer`, `openExternalUrl` (GitHub pages only) and `writeClipboard` (a row's paths) out. **Nothing else** — in particular not the anchor or the side, which are the owner's.                                                                         |
| the questions         | `picker.html`        | every sheet DevHub stops on, over every view                                                                               | `modalsChanged` **(only here)**, the projection, the appearance (for the monospace family alone), the agent profiles and actions, a folder's earlier Agent sessions and their previews, every way of opening a Workspace, the two ends of a reviewed message, the worktree close, `closeModal` |
| Settings              | `settings.html`      | its own window                                                                                                             | `SETTINGS_CHANNELS` in full, plus the failure contract every page has                                                                                                                                                                                                                          |
| Task Manager          | `task-manager.html`  | its own window: what each Workspace and Agent costs (           [task-manager.md](task-manager.md))                        | `TASK_MANAGER_CHANNELS` in full, plus the failure contract every page has                                                                                                                                                                                                                      |

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

**Every page in the window runs after the runtimes, what is on screen
first.** The window and its child views are built early — the controller is
built around the window, and it paints while startup goes on — but no page is
loaded until `ShellWindow.openPage`, which `bootstrapShell` calls once
`startRuntimes` has registered what the pages will ask for. It runs the
window's own page, the sidebar, the terminals' pages and the content view the
layout shows at once, and the rest — the toasts, the tooltip, the picker and a
content view not on screen — once those have loaded, or 1.5 s after at most:
ten renderers loading on the same cores had the terminal the person waits for
paint last. Each of the later ones is told what it draws when its page has
loaded, as it was when they all loaded together. A page asks the moment it
mounts: the Agents page
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

A GUI orchestrator is the one exception: its conversation is the
Conversations page's, laid right of the board and so above the Agents view
(`conversation: "beside-board"`). A picture, page or deck opened large from
the board (`Lightbox.tsx`) is drawn in the Agents page over its whole view,
and would open under that conversation, which no z-index inside a page can
lift it over. So while one is open the board tells main
(`previewLayout({ agentsOverlay })`, `shell/conversation/lightboxLayer.ts`)
and the Agents view is moved to just under the layers, as the floating
Sidebar is; the page is transparent where it draws nothing, so the
conversation shows through its scrim. A reload of the page ends it. The
Conversations page needs nothing of the kind: no view is laid over it.

**The Orchestrator row is also a Workspace's row**, in the Sidebar, the way
Scratch's row is Scratch's Workspace's: the orchestrator's folder is not
drawn as an ordinary row (`sidebarWorkspaces` hands it out as `orchestrator`,
apart from `scratch` and `rows`), and its Agents other than the orchestrator
are the row's children, with the Workspaces the orchestrator manages
(`managed`, by `Workspace.managed`), grouped by lane
(`docs/orchestrator.md`, "The orchestrator's work in the Sidebar"). A child selected is an ordinary Agent selection — its pane, full
or beside the root's editor. The root's editor is the board's **ターミナル**
tab, laid over the board's body beside the orchestrator's pane
(`LayoutState.boardTerminal`, `boardTerminalRect`): the Workspace's own
terminal page, the one its editor area would be. The row's right-click
**Show Editor** and `Cmd+Q E` show that tab, so the person stays on the
Orchestrator screen; the row offers no way to the Workspace selected on its
own.

## A close asks once, then acts

Closing a Workspace asks every question it has before it does anything, and
then asks nothing. What it would lose — busy Agents and running terminals — is
one confirmation on the picker (`close-confirmation`); a dirty worktree is the
three-way sheet before it, because whether the folder survives decides whether
there is anything left to close. When the close removes a worktree, the
confirmation carries that disposition and the sheet says so in a "Worktree"
row. A Neovim's unsaved buffers are its own to ask about (`:qa` in it).

Once the person has chosen to close, the close carries the answer out. Every
step has a deadline, and a step that fails reaches the person down the one
failure path below.

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
row as drawn — the Orchestrator row's Workspace, the Workspaces the
orchestrator opened, Scratch, each Workspace followed by its Agents
(`sidebarOrder`), the same list `Cmd+Q N` and `]` walk — which is the next Workspace's row, because its
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
- **A `devhub:agent` link to a closed Agent** reopens it the same way, and
  the reopened Agent's new id is kept beside the old one (`agent_aliases`)
  so the link still leads to it. See `docs/orchestrator.md` (Links).
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
failed — and it is a child of the shell window, so a notice is drawn _over_
every other view, which the window's own page could never do.

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

The palette is DevHub's own answer. `[appearance] theme`
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

**devhub.nvim** wears this very table (`:colorscheme devhub`), applied the
same way, in a Neovim DevHub does not draw: it reads the file synchronously
from its `plugin/`, before the first redraw, and follows `User DevhubTheme` and
the file. In a Neovim DevHub draws it gives the colours DevHub applies, so
neither order shows a frame of other colours. A host's panes have no file, so
there it wears nothing; a Neovim DevHub draws there is dressed by DevHub.
See its README.

Three scopes survive underneath this, and they are about _subject_ rather than
about routing: an Agent's own failure is drawn over that Agent's pane, a
Workspace's over its surface, and the failure that stopped a page from starting
fills that page, because there is nothing behind it to draw instead.

## The keyboard

`ShellWindow.placeKeyboardIn` is the only `webContents.focus()` call in DevHub,
and `keyboardChild(layoutInput())` is the only answer to "where do the keys
go". Focus is a function of the same state the layout is a function of — all
of it, not only the arrangement: `layout()` places the keyboard again whenever
that answer changes, so an editor that was chosen before it existed (a
folder just opened, one on another machine) gets the keys
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

Measured in a split, with the Agent selected and the window key: the editor
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
somebody in it was the editor reporting its own folder back as a second
`open_folder`.

Where a DevHub change lost the focus, the change puts it back itself. Notices
never take the keys (`ToastsView.place`); the notice center does only when
asked for (Show Notifications), and hands them back with `focusSurface` when
it closes.

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

## Chords are answered in main

`keyboard.ts` installs `before-input-event` on every WebContents DevHub owns,
through `app.on("web-contents-created")`. That is the only place a chord can
work: it sits in front of every surface, and a completed chord is
`preventDefault`ed there so its keys never reach the surface underneath.

So after the prefix the keyboard has to be in a WebContents, and while a chord
is armed DevHub keeps it in one: it stays where the prefix was typed, and any
move DevHub would make meanwhile (the view that had it being replaced, or one
chosen before it existed arriving) goes to the window's own page instead,
which is never swapped; the move it stood for is made when the chord ends
(`ShellWindow.chordArmedChanged`). A key in no WebContents goes to the menu
bar; there is no second road for chords through menu accelerators.

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
selected Agent (full or beside its editor), or — with a Workspace's row
selected beside an Agent — the Agent that Workspace pairs with
(`pairedAgentId`, the one `Cmd+Q Cmd+J` goes to). The editor alone shows no
Agent, so it shows no terminal: the paired Agent's keeps running hidden, its
`open` untouched, and is back when that Agent is. Switching Agents shows each
one's own terminal, if it has one open; the one left behind keeps running,
detached and hidden, and its view (with its scrollback) stays. A Workspace
with no Agents has no terminal.

**`Cmd+Q V`** (`toggle_terminal`) starts the view's Agent's terminal the
first time, with the keyboard in it, and after that hides and shows the pane
without touching the session. On a Workspace with no Agent it says so (a
`terminal_needs_agent` notice) rather than doing nothing; on the editor
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
`terminalStacked`). With the editor alone there is no terminal. One child
per Agent terminal (`terminal`) is stacked above the Agents and below every
layer — the one on screen at its rectangle, every other hidden. The divider
between Agent and terminal is the strip no view covers, drawn on the window's
own page from `terminalSeam` on the editor area main pushes (upright, or
level when `stacked`), exactly as the editor/Agent seam is; dragging it
previews (`previewLayout({ terminalShare })`) and commits
`resize_agent_terminal` (with `stacked: true` for the split's).

**The keyboard.** `LayoutState.keyboard` can name the terminal;
`keyboardChild` gives it the keys only while it is drawn. The model keeps
whether the terminal has the keyboard (`AppModel.paneFocus`): a chord moves
it, a click into a view reports it (`ShellWindow.onContentFocused`), and any
selection takes it back to the content. `Cmd+Q O` walks the panes on screen —
Agent → terminal with a full Agent, editor → Agent → terminal in a split,
nothing to walk with the editor alone — and wraps. On the Orchestrator row
it goes between the screen's two halves, the orchestrator's conversation
and its board (or the board's Terminal tab while that is shown); see
`docs/orchestrator.md`. `Cmd+Q X` with the terminal in front closes it
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
is open, visible (open, and its Agent on screen — never with the editor
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
right): `Cmd+[` / `Cmd+]` still work unprefixed on DevHub's own pages, and as
chords they already belong to the Agent cycle.

The stroke is the character `:`, not a physical key, so it is Shift+; on a US
layout and the unshifted key beside L on a JIS one (`chordKeys.ts`).

Main builds the rows (`model/commandPalette.ts`) when it opens the sheet:
`forward_prefix` and the palette itself are left out, and a command is listed
only if `resolveChord` would give it something to do against the current
snapshot — an Agent's commands are not offered with a workspace selected, Back
is not offered with nowhere to go back to. Commands run from the palette are
remembered in memory (eight, most recent first) and lead the list.

It is the ordinary picker on the modal layer, so it draws over the window as
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
Claiming these keys for the application would take them from Neovim and the
terminal. The rule is one line: they mean a zoom **only on the Agents page**, and
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
bar draws Back and Forward beside the Sidebar button. What the person asked
for: links and escalations should be in it, and going back from an escalation
should feel as it does in a browser.

**An entry is a place**: the selection (`AppModel.selection`) — a Workspace,
an Agent, or the two side by side, with the presentation it was shown in —
and, on the Orchestrator row, what the row's pane shows: the board, an
escalation read over the board, or the Terminal tab
(`model/orchestratorView.ts`). Opening an escalation is going somewhere, as
following a link is, so it is an entry of its own, and Back from it is the
board it was opened from.

**History is per window**, as a browser's is per tab. DevHub has one main
window; Settings and the Task Manager are windows of their own with no places
in them, and are not in it. It is per session: the state file says where the
window opens, and Back starts there.

**A place enters it when the person goes there on purpose, or does something
there** — not when the selection only passes over it:

| What happened                                                                                                                                                                                                                                                                                                                                                                                    | Recorded?             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| going there on purpose: a click on a `devhub:` link's chip (in a conversation, an escalation's thread, the board), a click on a Sidebar row, `Cmd+Q F`'s picker, the Go to picker (`Cmd+Q G`), `Cmd+Q 0`–`9`, a command chosen in the palette, `Cmd+Q Shift+J` and `Cmd+Q Shift+O` (both ways), a new Agent, `devhub --tell focus`, Enter or a click on a not-running editor's placeholder | yes, at once          |
| on the Orchestrator pane: an escalation opened (a card clicked, Enter on the board, a `devhub:escalation` link), a file sent to the Terminal tab (a path in a task or an escalation, a `devhub:file` link, `devhub <file>` in the orchestrator's folder)                                                                                                                                         | yes, at once          |
| a key typed into the place (not a chord's strokes, not a modifier alone, not Back or Forward's own keys), a press or a scroll in it                                                                                                                                                                                                                                                             | yes, at the first one |
| `Cmd+Q N`/`P` (stepping past places), the Sidebar walked from the keyboard (its Return included), a selection repaired after a close or an exit, a command line that does not take focus, an Agent finishing                                                                                                                                                                                  | no                    |
| a tab chosen on the Orchestrator pane, an escalation that left the board while it was read                                                                                                                                                                                                                                                                                                        | written over the entry on screen, as `replaceState` does |
| Back and Forward themselves (the arrows, keys, side buttons, swipes)                                                                                                                                                                                                                                                                                                                              | no                    |

"In it" means its views: the Agents' page (a GUI conversation, a TUI's
terminal, the board) and a terminal pane (`pane.html`, the Neovim editor's
too) — `isDestinationSurface` in `historyKeys.ts`. The Sidebar is choosing
where to go, not being somewhere, and the window's own page holds the arrows,
so neither counts; nor do the modals, the notices, the tooltip, Settings or a
Web Inspector. Main sees it all without the pages' help: keys in the chord
layer's `before-input-event` (`ChordHost.interacted`), presses and scrolls in
each contents' `input-event` (`isPointerInteraction`). `AppModel.interactionIsNew`
is asked first, so a thousand keystrokes dispatch one `note_interaction`. From
a place with no entry, Back goes to the cursor's own entry — the last place
recorded — and Forward is what it was: passing on cuts nothing off.

`Cmd+Q N`/`P` stay out on purpose: stepping through five Agents to reach the
sixth is walking past five places, and five entries would make Back a walk
through them again. A digit names its place, as a link does, so it is in.

Going there on purpose is said by the move itself, never inferred: a
selection or a folder open that carries `reason: "explicit"`
(`NavigationReason` in `model/intents.ts`). The Sidebar tells a click from
Return by the click's `detail` (`useSelectRow`); the palette runs its command
with the reason (`runCommand(…, "explicit")`), so the same command from its
chord is still stepping.

### The rules, a browser's

`model/navigationHistory.ts`:

- **A new navigation after Back cuts Forward off.**
- **Back and Forward do not record themselves.**
- **The same place twice in a row is one entry**: the row you are on clicked
  again, the escalation open opened again. The two halves of one split are one
  place (swapping the keyboard between them updates the entry).
- **A place that has gone is skipped**, not removed and not refused: a closed
  Agent or Workspace, an escalation deleted from the board (main tells the
  model which still exist: `AppModel.setOrchestratorViewExists`). That is a
  closed tab's answer rather than a 404's — the person's position never jumps
  under them, and each arrow is enabled only when there is somewhere it would
  go, answered by the same rule the move obeys. An escalation that was
  _closed_ is still on the board (完了) and is still a place.
- **Only the newest 100 entries are kept.**

### Back restores the place as it was

What an entry names is its identity; how the place looked is kept **per
entry**, as a browser keeps scroll and form state per entry
(`NavigationHistory.currentId`, the snapshot's `historyEntry`):

- **the page and the view**: the Orchestrator pane is put back on the entry's
  board, tree, escalation or file, on its tab;
- **the selection on it**: which escalation was open, or none;
- **the board's scroll and its folded lanes** (`useEntryState` in
  `shell/agents/orchestratorHistory.ts`): written under the entry while it is
  on screen, put back when Back or Forward returns to it; a new entry starts
  from the board as it is;
- **an escalation's thread and a file's scroll** are kept per escalation and
  per file (`orchestratorMemory.ts`), which is the same thing for them;
- **a conversation's transcript and a terminal** keep their own: every
  Agent's pane stays mounted while another is shown, so it is where it was
  left. A terminal's scrollback is tmux's.

### The Orchestrator pane and the model

The model holds the history; the pane draws first. A card clicked opens in
the frame of the click and _then_ tells the model
(`show_orchestrator_view`, `reason: "explicit"`, `drawn: true`), so no input
waits for a round trip. The other way, the pane follows the snapshot's
`orchestratorView.seq`, which moves only when the model moved the pane — Back,
Forward, a `devhub:escalation` link — so what the pane said never comes back to
it as an order. A `devhub:escalation` link is one intent: the Orchestrator row
selected with the escalation open, one entry, so Back from it is where the
link was clicked.

**An escalation's own ‹ (and Esc, and an answer sent) means "up to the
board".** When Back leads to exactly that board — it was opened from it — it
_is_ Back: Forward opens it again and no board is in the history twice. When
the escalation came from elsewhere — a link in an Agent's conversation, or the
pane was left on it — it is a navigation to the board, recorded, so Back from
the board returns to the escalation and Back again to the Agent. That is the
navigation-stack meaning the ‹ already draws (an iOS back button, Gmail's
"back to inbox"), and it never leaves the person somewhere the control did not
name (`AppModel.leaveOrchestratorView`). A file's ‹ is the same, to the tree.

### What is not a place

- **The lightbox** (a picture, a page or a deck opened large) is over the
  place, not a place: Esc closes it, and Back or Forward leave the place it is
  over, taking it with them.
- **tmux windows and panes** are the terminal's own arrangement inside one
  place, with their own last-window keys; they are not in DevHub's history.
- **Settings and the Task Manager** are windows, not pages of this one.

### Keys, buttons, gestures and motion

- `Cmd+[`/`Cmd+]` on macOS — the Mac's own Back and Forward (Finder, Safari,
  Xcode) — answered on DevHub's own pages (`main/shell/historyKeys.ts`);
  `Super+[`/`Super+]` elsewhere, the same binding.
- `Alt+Left`/`Alt+Right` off macOS, the platform's own: answered by main on
  the pages with no terminal (the window's page, the Sidebar, the
  Conversations), and by the Agents page itself outside its terminals
  (`installHistoryKeys`), because in a terminal they are the shell's word
  motion. Not on macOS, where `Alt+Left` is a text motion.
- `Cmd+Q H`/`Cmd+Q L`, the chords, from anywhere.
- The mouse's buttons 4 and 5 (`shell/historyButtons.ts`; `app-command` on
  Linux and Windows), the trackpad's three-finger swipe on macOS (`swipe`, when
  the system is set to it), and the title bar's arrows. Over the board they are
  the window's Back and Forward too, which walk the pane's views — there is no
  second, board-local history any more.
- Keys and gestures raised in main are declined while a question is up; the
  window-level gestures are decided by where the keyboard is
  (`ShellWindow.focusTarget`). With the title bar hidden there are no arrows,
  and everything else still works.

**Motion**: on the Orchestrator pane the move is the stack's own slide
(`orchestrator.css`, [`motion.md`](motion.md)), run by direction: opening and
Forward onto an escalation push it in from the trailing edge; Back and the ‹
pop it off to the trailing edge; Back _onto_ an escalation (the board was
reached from it) pushes it in from the leading edge, and Forward onto the
board pops it off to the leading edge (`data-arrived`). Transform and opacity
only, the same 220 ms, nothing under Reduce Motion. A move between Agents and
Workspaces is main swapping views, which are not animated
([`motion.md`](motion.md), "Views main moves").

## Attention is the Dock

There is no ring drawn around the window. A DOM overlay in the window's own
page is behind every child view, which is to say hidden exactly when there
is something to say — so an unread Agent is announced by the _window_: a Dock
badge (on Linux, the launcher's count where the desktop shows one), and only
that. The Dock does not bounce and the window does not flash, in front or
not: the person found a bounce for every finished turn too noisy. See
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

On Linux a window also carries Electron's menu bar, which GTK paints in its
own theme's colours whatever DevHub's appearance is (a white bar over a Dark
window; `nativeTheme.themeSource` does not reach it). So the main, Settings
and Task Manager windows hide it until Alt is pressed (`autoHideMenuBar`,
`main/shell/menuBar.ts`): the keyboard still reaches every menu, and every
command in it is in the command palette as well. macOS has no bar in the
window, and nothing is set there.

## What it costs

One main process and one renderer per page (Settings and the Task Manager
exist only while they are open, a terminal pane once per terminal, and a
Neovim's page once per Neovim on screen).

Time to the first editor, measured on an isolated instance from the process's
own start to the first editor's `did-finish-load`, six runs each, before
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
