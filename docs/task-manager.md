# The Task Manager

`DevHub: Task Manager` in the command palette (`Cmd+Q :`, `open_task_manager`)
opens a window that says what each Workspace and Agent costs this
Mac, now: memory, CPU and how many processes, in the shape the Sidebar has
rather than as a flat process list. The same command closes it while it is the
window in front, as `Cmd+Q Shift+,` does Settings. It is palette only
(`PALETTE_ONLY_COMMANDS`): it is for the moment the Mac is slow, not for every
day, and no key is spent on it; a person who wants one binds it in
`[keybindings]`.

It exists to answer "why is my Mac slow" with facts, and to act on the answer:
stop an Agent, end a runaway process.

## The window

A window of its own, made the way Settings is (`main/shell/taskManagerWindow.ts`,
see [window-and-pages.md](window-and-pages.md)): its own entry
`task-manager.html`, its own preload (`preload/taskManager.ts`) exposing
`window.devhubTaskManager` (`ipc/taskManager.ts`) and the failure contract
every page has, a singleton, `hiddenInset`, the theme's ground as its
background. It wears the palette DevHub wears and follows a change to it
(`applyTaskManagerPalette`), dark and light.

**The header** is the machine: memory used of total, broken down the way
Activity Monitor does — one bar of App, Wired, Compressed and Cached files,
what is left being Free, each with its size, and what the compressor holds
beside what it occupies — the pressure level the kernel reports, swap used of
total, and DevHub's own total: footprint, in RAM, CPU, processes.

**The table** is a tree, heaviest first at every level by Footprint, In RAM
or CPU (the segmented control, or a column heading). A Workspace is open down to its
terminal's and Agents' processes, and DevHub, tmux and Other are
folded; ↑ ↓ ← → walk and fold it as the Sidebar's tree is walked,
and Escape closes the window. Numbers are right-aligned tabular figures with
their unit. Each row has two memory figures, each summed over its subtree:

- **Footprint**: what it costs wherever its pages are — in RAM, compressed
  (whether the compressor keeps them in RAM or has swapped them out), or
  swapped. The number to compare rows by.
- **In RAM**: what of it is resident now.

A short track ahead of the footprint is the row's share of DevHub's total
footprint; the part in RAM is solid and the rest faint, so a row whose pages
were compressed or swapped out keeps its length and loses its fill. A row of 15% or more is in the accent. A row's actions show
under the pointer or with the row selected:

| Row       | Actions                                                                 |
| --------- | ----------------------------------------------------------------------- |
| Workspace | Show                                                                    |
| Agent     | Stop (the Agent's own stop, with its question in the main window), Show |
| a process | End… (not on DevHub's own processes)                                    |

**Copy Snapshot** puts the table on the clipboard as text, with the real
names: the header with the breakdown and what the two memory columns are
read from, then every row indented by depth, heaviest first, footprint and in
RAM, each process with its pid (`taskSnapshotText`). It is what to paste when asking why DevHub is heavy.

## What is attributed to what

`diagnostics/taskTree.ts` joins one reading of each source — a pure function,
tested on `ps` fixtures (`diagnostics/fixtures/ps-*-darwin.txt`). A process
belongs to the nearest pid DevHub knows (an _anchor_), and then to the
process tree under it; a walk down a subtree stops at another anchor, so the
most specific owner wins.

```text
Workspace
├─ Terminal ─ every pane of its ws- session, with its tree (zsh, nvim, …),
│             and the clients showing it
└─ Agent ─ its session's pane tree (the CLI, or a GUI Agent's host and
           app-server), the clients showing it, its own Terminal (tm-), and
           a GUI Agent's Journal stream
DevHub ─ Main, GPU, every utility process, DevHub's own pages, a journal
         stream no Agent here owns (a far Agent's)
tmux ─ the server, and any pane no Workspace or Agent owns (the anchor session)
Other ─ whatever an Electron process started that none of the above accounts
        for (a git, an ssh), said with what started it
```

- **Which processes are Electron's**: `app.getAppMetrics()`. A row says a
  utility's name as words (`Terminal host (pty)`).
  DevHub's own processes are shown without what they started — main starts
  everything — and what they started is attributed by the anchors below it,
  or is Other.
- **tmux**: one `tmux` client per refresh (`TmuxTerminalRuntime.processPanes`)
  reads every marked pane's `#{pane_pid}` with its markers (context,
  Workspace, Agent), every client's `#{client_pid}` and session, and the
  server's `#{pid}`. Only sessions DevHub marked are named; an Agent's own
  terminal (`tm-<id>`) is matched by its session name.
- **A GUI Agent's journal** is followed by a shell main starts (`sh -c …
devhub-agent-stream <dir> <offset>`, `hostLink.ts`) with a `tail -f`, its
  watchdog's `cat` and a `sleep 1` under it. It is the Agent's whose host
  (`devhub-agent-host <dir> …`) runs in its pane, as `Journal stream`.
- **Two `ps` runs** per refresh, joined by pid (`diagnostics/processTable.ts`):
  `ps -A -o pid=,ppid=,rss=,pcpu=,state=,comm=` and `ps -A -o pid=,args=`.
  Each text column is the last of its run, the one place `ps` prints it whole:
  macOS cuts a `comm` that is not last to a few characters, and no split of
  the two side by side can tell where the executable ends when a process's
  argv is not its executable. A process is named by its executable's name
  (`DevHub Helper (Plugin)`, `rust-analyzer`), what it calls itself where the
  executable is named for its version (the Claude CLI's `versions/2.1.0` is
  `claude`), and, for an interpreter or a Node helper, what it runs: the
  script (`tsserver.js`), the package of a script whose own name says nothing
  (`…/node_modules/@modelcontextprotocol/server-github/dist/index.js`), or
  what a package runner was asked for (`npm exec @playwright/mcp`).
- **Left out**: a zombie, a process macOS prints as `(name)` because it is
  ending, and every process the reading itself started (the `ps` runs,
  `devhub-footprint`, `sysctl`, `vm_stat`, its `tmux` client).

**Memory**, per process (`TaskSnapshotWire.memoryMetric` says which):

- **macOS**: the footprint is the **physical footprint**, what Activity
  Monitor's "Memory" column shows (`proc_pid_rusage`'s `ri_phys_footprint`):
  compressed and swapped-out pages included, the frameworks a process shares
  with others not. In RAM is the resident set (`ri_resident_size`), never more
  than the footprint. `devhub-footprint` (`main/native/footprint.c`, built
  into `out/native` by `build:native`) prints both for every process in one
  run. Footprint less compressed would be the closer "in RAM", but what a
  process has in the compressor is readable only through its task port
  (`TASK_VM_INFO`), which another process gets only with an entitlement; and
  `top -l 1 -stats pid,mem,cmprs`, which has one, is a far heavier fork every
  two seconds. The resident set also counts the clean file-backed pages a
  process maps (its executable, its frameworks), which is why it is capped.
- **Linux**: `/proc/<pid>/status` for each of DevHub's processes: the
  footprint is `VmRSS + VmSwap`, in RAM `VmRSS`. Linux keeps no per-process
  figure for what zswap holds, and `VmRSS` counts a page shared by two
  processes once in each.
- **Neither readable** (a build without `devhub-footprint`): both are `ps`'s
  resident set.

The resident set alone misleads exactly when memory is short: under swap a
language server whose pages were compressed shows a few MB in RAM and
hundreds in its footprint.

**CPU** is `ps`'s `%cpu`: on macOS a recent average, on Linux the average over the
process's whole life. Only this Mac's processes are seen: what a Workspace or
an Agent on another machine runs there shows nothing. A process that left
DevHub's tree (a daemon that reparented itself to launchd) is not seen.

## System memory and pressure

`diagnostics/systemMemory.ts`, every parser tested on what the OS prints:

- **macOS**: one `sysctl -n hw.memsize vm.swapusage
kern.memorystatus_vm_pressure_level` — the size, the swap line, and the level
  the kernel's memory status uses (1 normal, 2 warning, 4 critical: what
  Activity Monitor's pressure graph is coloured by) — and `vm_stat`, each count
  times its page size:

  | Part         | From `vm_stat`                      | What it is                                        |
  | ------------ | ----------------------------------- | ------------------------------------------------- |
  | App          | Anonymous pages − Pages purgeable   | processes' own memory (older macOS: Pages active) |
  | Wired        | Pages wired down                    | the kernel's, never compressed or paged out       |
  | Compressed   | Pages occupied by compressor        | the RAM the compressor uses                       |
  | (holds)      | Pages stored in compressor          | what that RAM holds, uncompressed                 |
  | Cached files | File-backed pages + Pages purgeable | given back the moment something needs it          |
  | Free         | the total less the four above       | not used for anything                             |

  "Used" is App + Wired + Compressed, Activity Monitor's "Memory Used".

- **Linux**: `/proc/meminfo`. Used is `MemTotal − MemAvailable`; App is
  `AnonPages`, Wired the kernel's own (`SUnreclaim + KernelStack +
PageTables`), Compressed zswap's pool (`Zswap`, holding `Zswapped`), Cached
  files `Buffers + Cached + SReclaimable`, Free `MemFree`. Pressure is PSI's
  `/proc/pressure/memory`: `some avg10` ≥ 10% is a warning; `full avg10` ≥ 10%
  or `some avg10` ≥ 40% is critical; no file is unknown.

## What it costs

Main keeps no timer. The page asks for a snapshot while it is visible —
`document.visibilityState`, which a minimised, hidden or covered window loses —
one request at a time, the next two seconds after the last answered. A refresh
is two `ps`, one `tmux`, on macOS one `devhub-footprint`, one `sysctl` and
one `vm_stat`, on Linux a read of `/proc/meminfo` and of each DevHub
process's `/proc/<pid>/status`, and `getAppMetrics`. A window nobody can see costs nothing.

## Ending a process

End… is offered only on a process that is not one of DevHub's own — never
main, the GPU, a utility, a renderer, the tmux
server or a tmux client. Main asks first, as a sheet on the window, saying
what it is, its pid and its memory. It then checks the pid is a row the last
snapshot offered End on and still runs the command line that row showed — a
pid reused in between is somebody else's process and is left alone — and
sends that one process SIGTERM.
