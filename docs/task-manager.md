# The Task Manager

`DevHub: Task Manager` in the command palette (`Cmd+Q :`, `open_task_manager`)
opens a window that says what each Workspace, workbench and Agent costs this
Mac, now: memory, CPU and how many processes, in the shape the Sidebar has
rather than as a flat process list. The same command closes it while it is the
window in front, as `Cmd+Q Shift+,` does Settings. It is palette only
(`PALETTE_ONLY_COMMANDS`): it is for the moment the Mac is slow, not for every
day, and no key is spent on it; a person who wants one binds it in
`[keybindings]`.

It exists to answer "why is my Mac slow" with facts — the first thing a
memory-pressure-driven hibernation would need — and to act on the answer:
put a workbench to sleep, stop an Agent, end a runaway process.

## The window

A window of its own, made the way Settings is (`main/shell/taskManagerWindow.ts`,
see [window-and-pages.md](window-and-pages.md)): its own entry
`task-manager.html`, its own preload (`preload/taskManager.ts`) exposing
`window.devhubTaskManager` (`ipc/taskManager.ts`) and the failure contract
every page has, a singleton, `hiddenInset`, the theme's ground as its
background. It wears the palette DevHub wears and follows a change to it
(`applyTaskManagerPalette`), dark and light.

**The header** is the machine: memory used of total (a meter with DevHub's
share laid over its start), the pressure level the kernel reports, swap used,
and DevHub's own total — memory, CPU, processes.

**The table** is a tree, heaviest first at every level by Memory or by CPU
(the segmented control, or a column heading). A Workspace is open down to its
workbench's, terminal's and Agents' processes, and DevHub, tmux and Other are
folded; ↑ ↓ ← → walk and fold it as the Sidebar's tree is walked,
and Escape closes the window. Numbers are right-aligned tabular figures with
their unit; a short track ahead of each memory figure is the row's share of
DevHub's total, in the accent for a row of 15% or more. A row's actions show
under the pointer or with the row selected:

| Row                | Actions                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Workspace          | Show                                                                                      |
| VS Code workbench  | Sleep (local, awake and not on screen), Show; its state: awake, starting, going to sleep, sleeping, not started, restarting, failed |
| Agent              | Stop (the Agent's own stop, with its question in the main window), Show                    |
| a process          | End… (not on DevHub's own processes)                                                       |

**Copy Snapshot** puts the table on the clipboard as text: the header, then
every row indented by depth, heaviest first, each process with its pid
(`taskSnapshotText`). It is what to paste when asking why DevHub is heavy.

## What is attributed to what

`diagnostics/taskTree.ts` joins one reading of each source — a pure function,
tested on a `ps` fixture (`diagnostics/fixtures/ps-darwin.txt`). A process
belongs to the nearest pid DevHub knows (an _anchor_), and then to the
process tree under it; a walk down a subtree stops at another anchor, so the
most specific owner wins.

```text
Workspace
├─ VS Code ─ Renderer, Extension host (and what it started: rust-analyzer,
│            tsserver.js, …), Terminal tab (a tmux client the pty host started)
├─ Terminal ─ every pane of its ws- session, with its tree (zsh, nvim, …)
└─ Agent ─ its session's pane tree (the CLI, or a GUI Agent's host and
           app-server), the clients showing it, its own Terminal (tm-)
DevHub ─ Main, GPU, every utility process, DevHub's own pages
tmux ─ the server, and any pane no Workspace or Agent owns (the anchor session)
Other ─ whatever an Electron process started that none of the above accounts
        for (a git, an ssh), said with what started it
```

- **Which processes are Electron's**: `app.getAppMetrics()`. A utility's name
  is VS Code's where VS Code started it (`UtilityProcess.getAll()`), which is
  how an extension host is known to be a workbench's: it is named
  `extension-host [<window id>]`, and a workbench's window id is its view's id.
  DevHub's own processes are shown without what they started — main starts
  everything — and what they started is attributed by the anchors below it,
  or is Other.
- **A workbench's renderer** is its view's `webContents.getOSProcessId()`.
- **tmux**: one `tmux` client per refresh (`TmuxTerminalRuntime.processPanes`)
  reads every marked pane's `#{pane_pid}` with its markers (context,
  Workspace, Agent), every client's `#{client_pid}` and session, and the
  server's `#{pid}`. Only sessions DevHub marked are named; an Agent's own
  terminal (`tm-<id>`) is matched by its session name.
- **One `ps`** per refresh (`ps -A -o pid=,ppid=,rss=,pcpu=,comm=,args=`) for
  every process's parent, memory and CPU (`diagnostics/processTable.ts`). A
  process is named by its executable, or, for an interpreter or a Node helper,
  by the script it runs (`tsserver.js`).

**Its limits.** Memory is the resident set `ps` reports, summed over a
subtree. That counts a page shared by two processes twice — Electron's
helpers share their frameworks — so DevHub's total reads higher than the
"Memory" column of Activity Monitor, which shows the physical footprint; the
footprint is not available from one cheap call for every process. CPU is
`ps`'s `%cpu`: on macOS a recent average, on Linux the average over the
process's whole life. Only this Mac's processes are seen: a workbench on an
ssh host or in a dev container shows its renderer and nothing of the far
side, and an Agent on another machine shows nothing. A process that left
DevHub's tree (a daemon that reparented itself to launchd) is not seen; nor
are a workbench's webviews, which run in renderers DevHub does not name —
those are under Other as `Renderer`.

## System memory and pressure

`diagnostics/systemMemory.ts`, every parser tested on what the OS prints:

- **macOS**: one `sysctl -n hw.memsize vm.swapusage
  kern.memorystatus_vm_pressure_level` — the size, the swap line, and the level
  the kernel's memory status uses (1 normal, 2 warning, 4 critical: what
  Activity Monitor's pressure graph is coloured by) — and `vm_stat` for what is
  used, counted as Activity Monitor's "Memory Used": app memory (anonymous
  pages less purgeable), wired, and what the compressor occupies.
- **Linux**: `/proc/meminfo` (used is `MemTotal − MemAvailable`) and PSI's
  `/proc/pressure/memory`: `some avg10` ≥ 10% is a warning; `full avg10` ≥ 10%
  or `some avg10` ≥ 40% is critical; no file is unknown.

## What it costs

Main keeps no timer. The page asks for a snapshot while it is visible —
`document.visibilityState`, which a minimised, hidden or covered window loses —
one request at a time, the next two seconds after the last answered. A refresh
is one `ps`, one `tmux`, on macOS one `sysctl` and one `vm_stat`, and
`getAppMetrics`. A window nobody can see costs nothing.

## Ending a process

End… is offered only on a process that is not one of DevHub's own — never
main, the GPU, a utility (an extension host among them), a renderer, the tmux
server or a tmux client. Main asks first, as a sheet on the window, saying
what it is, its pid and its memory. It then checks the pid is a row the last
snapshot offered End on and still runs the command line that row showed — a
pid reused in between is somebody else's process and is left alone — and
sends that one process SIGTERM.

## Sleep

Sleep is the workbench lifecycle's own hibernation
(`main/shell/workbenchLifecycle.ts`): the next plan is asked to put that
workbench to sleep (`LifecycleInput.sleep`), exactly as the minute check and
the awake cap do, refused for the same reasons (it is on screen, it is not
awake, it is closing, it is a far one), and then asked whether it would lose
anything (`readKeepAwake`) before it unloads. Its editors come back when it is
woken.
