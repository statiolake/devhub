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
stop an Agent, end a runaway process. Its second tab, **Tokens**, answers the
other question a person running many Agents has: who used how many tokens
([Tokens](#tokens)).

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

## Tokens

The second tab (`⌘2`; `⌘1` is Processes, and ← → move along the tab list)
says who used how many tokens, from the Agents' own transcripts — the same
numbers whether DevHub drew the conversation (GUI) or the CLI did (TUI), on
this Mac or an SSH host. `devhub --tell usage --by …` prints the same report
for the Orchestrator and scripts ([CLI](#from-the-command-line)).

### What it shows

- **The range** (a radio group): Claude's current **5-hour window** — the
  default, since that is what limits the person — **Today** (since local
  midnight), Claude's **Weekly window**, the last **7 days**, or a **Custom**
  range (two date-and-time fields). A plan window's start is its reset, as
  the usage readout last had it (`usageLimits.ts`), less its length; with no
  reading yet it is the last 5 hours or 7 days, and the summary says so.
- **The rows** (a radio group): per **Agent** (its name, profile,
  Workspace, machine, role and models; its subagents' usage counted in it and
  broken out under it — the main conversation and each subagent by what it
  was asked to do), per **task** (what its bound Agents used while bound), per
  **Workspace**, per **role** — the Orchestrator, workers (Agents it
  manages), unmanaged Agents, and Outside DevHub — or per **model**. A
  task's, Workspace's or role's row opens to the Agents in it.
- **The view**, in the toolbar: **Without cache** — every token as
  processed: uncached input, cache read, cache write (5-minute and 1-hour
  together), output, and the total — or **Cache-aware** — the input weighted
  by list price (cache reads at the model's read price, writes at 1.25× and
  2× base input) as tokens at base input price, output, the cache hit rate
  (cache reads of all input), and the **estimated cost**. The cost is labelled
  for what it is: an estimate at Anthropic's API list price, which a Claude
  plan is not billed. A model with no pinned price (Codex's) shows its tokens
  and no cost, and the summary says how many tokens that leaves out.

Above the table: the range and where its start came from, a few figures
(total, input, output, requests; or cost, weighted input, output, hit rate),
and one bar of where the input went — uncached, cache read, cache write 5m and
1h — in the reference categorical slots 1–4, validated for both themes, with
its legend giving each part's amount. Each row has a sparkline of its tokens
(its cost in the cache-aware view) over the range, in 24 buckets, its last
bucket marked; its tooltip says when it peaked. Every column heading sorts
(again for the other way); ↑ ↓ walk the rows, → and Enter open one, ← closes it
or goes to its parent, Home and End, and Escape closes the window. **Copy
Table** puts the CLI's table, in the view shown, on the clipboard.

The tab asks for a report while it is shown and the window visible, every
five seconds (`TOKENS_REFRESH_MS`); the Processes tab stops reading `ps`
meanwhile.

### Where the numbers come from

`main/tokenUsage/` reads; `model/token*.ts` is pure and does the rest.

- **Claude**: every session under `<config>/projects/` (the profile's
  `CLAUDE_CONFIG_DIR`, else the machine's, else `~/.claude`): one
  `<session>.jsonl` per session, and one `<session>/subagents/agent-<id>.jsonl`
  per subagent, with `agent-<id>.meta.json` saying what it was asked. Each
  `assistant` line's `message.usage`: `input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens` with its
  `cache_creation` split into `ephemeral_5m_input_tokens` and
  `ephemeral_1h_input_tokens` (no split: five minutes), `speed`, and
  `message.model`.
- **Codex**: every rollout under `<CODEX_HOME>/sessions/` (`~/.codex`):
  `event_msg` lines of type `token_count`, each with the thread's running
  total and the last request's usage, and the model of the latest
  `turn_context`. Codex's input includes its cached input; here input is the
  uncached part, cached input is a cache read, and there are no cache writes.

**Each request once** (`tokenTranscripts.ts`, `tokenIndex.ts`):

- Claude writes one line per content block of a streamed response, each with
  the whole response's usage. A request is its `message.id` (else its
  `requestId`, else the line's `uuid`); its counts are the largest each line
  said, so an early block with a smaller `output_tokens` neither doubles nor
  shortens it.
- A resumed or forked session's file copies the earlier lines, ids and all.
  The id is kept per machine and CLI across files: the first file to say it
  owns it.
- Subagents: an inline `isSidechain` line (older versions) and a subagent's
  own file are both the subagent's, counted in the session that started it.
- `<synthetic>` lines are no request.
- Codex writes a `token_count` again when only the rate limits changed: a
  request is the thread and the running total it brought it to, so a repeat
  is the same key.

**Who a session is.** Each reading writes down the session every Claude and
Codex Agent runs now (asked of its CLI — the GUI conversation, or the TUI's
pane — at most every 30 s per Agent), with its name, profile, Workspace,
machine and role, so its tokens stay its after it is closed and across
restarts. A session no Agent was seen running is named by a task's binding
that recorded it, or by the metadata DevHub kept for it
(`session-meta.json`); none of those is **Outside DevHub**, shown by its
folder (and, grouped by Workspace, in the open Workspace that folder is in).
A task counts what its bound Agents used from `boundAt` to `stoppedAt`: a
request of a session the binding recorded, or of the bound Agent. An Agent
bound to two tasks at once counts toward both, and the tab says the rows then
add up to more than the total. The total is every request once, never the rows
added up.

### Incremental, and cheap to restart

Main keeps no timer. A reading lists each folder's transcripts written to in
the retention (one `find`) and reads each file only from the byte it was read
up to, whole lines only, at most 4 MB of a file and 96 MB of a folder (16 MB on
an SSH host) per reading, the most recently written first — so months of
transcripts are caught up over a few readings, and the summary says so while
they are. A file shorter than its offset was rewritten and is read again from
the start. A line longer than a whole read is passed over. Parsing yields to
the event loop between files.

The index — every file's offset and the requests read out of it — and the
session owners are kept in `token-usage.json` in the user data folder, saved
at most every 30 seconds and at quit, so a restart reads only what was written
since. Requests older than 35 days are let go, and that is as far back as the
Custom range reaches.

**SSH hosts** are read through the host's `Runtime`, the connection DevHub
already has: two small `sh` scripts, one listing (`find` and `stat`, GNU's
spelling or BSD's) and one reading each file from its offset (`tail -c +N |
head -c M`, each after a 0x1E separator, which JSON never contains raw). Only
when a report is asked for, and no more often than once a minute; a host
that cannot be read is said under the summary, and the next reading tries
again.

### Prices

`model/tokenPrices.ts`, pinned in that one place (as of 2026-11-13, Anthropic's
first-party API list prices, US dollars per million tokens):

| Model                 | Input | Output | Cache read | Write 5m | Write 1h |
| --------------------- | ----: | -----: | ---------: | -------: | -------: |
| Fable 5.2             |  8.00 |  40.00 |       0.20 |    10.00 |    16.00 |
| Mythos 5.2            |  8.00 |  40.00 |       0.20 |    10.00 |    16.00 |
| Fable / Mythos 5.1    | 10.00 |  50.00 |       0.25 |    12.50 |    20.00 |
| Fable / Mythos 5      | 10.00 |  50.00 |       1.00 |    12.50 |    20.00 |
| Opus 5.5              |  4.00 |  20.00 |       0.20 |     5.00 |     8.00 |
| Opus 5, 4.8, 4.7, 4.6 |  5.00 |  25.00 |       0.50 |     6.25 |    10.00 |
| Sonnet 5.5            |  2.00 |  10.00 |       0.10 |     2.50 |     4.00 |
| Sonnet 5              |  2.00 |  10.00 |       0.20 |     2.50 |     4.00 |
| Sonnet 4.6            |  3.00 |  15.00 |       0.30 |     3.75 |     6.00 |
| Haiku 5.5             |  0.10 |   0.50 |       0.01 |    0.125 |     0.20 |
| Haiku 4.5             |  1.00 |   5.00 |       0.10 |     1.25 |     2.00 |

Cache reads are not one multiple of input across models — 0.1× on most,
0.05× on Opus 5.5 and Sonnet 5.5, 0.025× on Fable 5.1 and 5.2 — so each model
has its own. Fast mode (`usage.speed: "fast"`) is priced at Opus 5.5's $8 /
$40 and Fable 5.2's $16 / $80. Haiku 5.5's prompts over 100K tokens are priced
at $0.50 / $2.50. A model id is matched without its date, `[1m]` suffix or
provider prefix.

### From the command line

```text
devhub --tell usage --by agent|task|workspace|role|model
                    [--since window|today|week|7d|90m|12h|3d|2026-11-12[T09:00]]
                    [--until DATE] [--cache raw|weighted] [--json]
```

Any of those flags (or `--tokens`) asks for tokens; `usage` alone is still
the plan limits. The default is `--by agent --since window --cache raw`. Text
is the tab's table — subagents (or Agents) indented under their row, the
total last, and in the weighted view the note that the cost is an estimate.
`--json` is the whole report (`TokensJson`: `schema: 1`, the range with ISO
times, the totals, every row with its children and series, the price table,
and each folder read with its problem if it had one). The CLI reads SSH hosts
at once rather than waiting for their minute, and answers within 20 seconds
with what it has read by then.
