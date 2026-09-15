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
    last among them) → the Agents → the notices → the questions

`ShellWindow.layout()` is the only thing that reads it, and it is the only
thing that calls `setBounds` or `setVisible` on anything. Nothing else in
DevHub has an opinion about where a view is.

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

Six entries, six preloads, six bridges. There is no `?window=` role and no
runtime question about which page this is: **which page this is, is which file
main loaded.**

| Page | Entry | What it draws | What it may ask for |
|---|---|---|---|
| the window's own page | `index.html` | the title bar, the drag strip, the three states in which there is no child view to show, the seam of a split | the projection, the appearance, the window's name, the workbench area, `openModal`, `closeWorkspace`, `chooseWorkspaceFolder`, `openSettings`, `previewLayout` |
| the Sidebar | `sidebar.html` | the leading column: workspaces and their agents, the rail, the row menu, the drag-reorder, the resize handle | the projection, the appearance, the agent profiles, the repository status, `menuCommand`, `openModal`, `closeWorkspace`, `openExternalUrl`, `previewLayout`, `focusSurface` |
| the Agents | `agents.html` | every running Agent's pane, all mounted, the selected one not hidden | the projection, the appearance, the repository status, the agent actions, the terminal transport, `openModal`, `openExternalUrl`, `writeClipboard` |
| the notices | `toasts.html` | what the application has to say, over whatever is on screen | `nativeError`, `appCondition`, `actionStarted`, `menuCommand`, `reportNoticeRetired`, `reportToastsSize`, `retryApp`, `openSettings` |
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

Each page has a provider of its own holding exactly that contract
(`ShellPageContext`, `SidebarContext`, `AgentsContext`, `PickerContext`), built
from the shared per-projection hooks in `shell/model/pageModel.ts` so that "the
snapshot" means the same subscription and the same revision ordering
everywhere it appears.

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
collapsed rail. `RowTooltip.tsx` draws it in-page instead — and draws none at
all in a view too narrow to read one in, because a tooltip that does not fit is
worse than none. Giving the rail one means giving it a child of the *window*
whose rectangle is its own content, the way the `toasts` view already is.

## What it costs

One main process, one renderer per page (six, of which Settings exists only
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
