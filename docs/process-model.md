# DevHub's processes: what runs where, and what keeps the keys waiting

When DevHub's main process is busy, everything answers late: every key of
every surface passes main's thread, a terminal's bytes are read and sent by
main, a Neovim's redraws are decoded by main, and a GUI Agent's transcript is
parsed and folded there. The goal is that **main does windows, views, menus
and the least routing it can**, the real work runs in other processes, and
the hot data paths — keys, terminal bytes, Neovim redraws, Agent transcripts
— do not go through main.

This file is the map (what runs where today), the measurements that order
the work, the target, and the phases: which are done and what they changed,
and which come next.

## What runs where today

| Process                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **main** (Electron's browser process, VS Code's main in it) | the window, its child views, menus, focus (`shell/`); the chord layer, a `before-input-event` handler on every web contents (`shell/keyboard.ts`); the terminal ledger: which marked session a surface attaches to, the attach permits and who owns which client, told only when a client starts or ends (`terminal/service.ts`, `surfaces.ts`, `attachments.ts`); tmux control and polling: the agent round and the terminal activity round (`terminal/tmux.ts`, `shell/agentWiring.ts`); every Neovim's msgpack-RPC socket, its redraws decoded and relayed (`editor/neovimRpc.ts`, `neovimUi.ts`, `neovimEditors.ts`); a proxy per GUI Agent's conversation (`agent/conversation/handle.ts`, `agentEngine/client.ts`): the facts the engine pushes, the requests, the host of an Agent on another machine; `state.json` (`shell/saveCoalescer.ts`); the Orchestrator (invariant, events, timers, GitHub polling); repository status (git), usage readers, Task Manager sampling, the `devhub` CLI's control socket, voice |
| **process host** (utility process, new)                     | starts every bounded command main runs — tmux, git, ssh, the GUI Agents' host scripts — and reports how each ended (`main/processHost/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **pty host** (utility process, new)                         | every terminal surface's tmux client (node-pty), its output coalesced and framed, its acks, input and resizes, directly with the page over the page's `MessagePort` (`main/ptyHost/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **conversation engine** (utility process, new)              | every GUI Agent's `AgentConversation`: the journal followed (an Agent on this machine), the protocol adapter, the fold, the held messages, the usage-limit and cache keepers; the Agents page's snapshot and events over a `MessagePort` (`main/agentEngine/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| DevHub's pages (one renderer each)                          | the window's own page, the Sidebar, **the Agents page (every Agent's pane: terminal Agents' xterms and GUI Agents' conversations, all in one renderer)**, an Agent's terminal pane, one Neovim page per Workspace, notices, questions, tooltip; Settings and Task Manager windows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| VS Code                                                     | a renderer per workbench, its extension host, file watcher, shared process, pty host, language servers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| outside Electron                                            | DevHub's tmux server (every terminal and every Agent's session), the GUI Agents' hosts and CLIs, Neovim (`nvim --headless --listen`, kept by tmux)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### The data paths

- **A key.** The OS delivers it to the browser process's UI thread — main's
  thread, which is also Node's — where `before-input-event` runs DevHub's
  chord router synchronously, and only then is it forwarded to the renderer.
  A key waits for main whatever surface it is for. Note that this is true of
  Chromium's input routing itself, not only of DevHub's handler: removing
  the handler saves a JS call per key, not the hop.
- **A key in a terminal.** page → its port → the pty host → the tmux
  client's pty → tmux → the program; its echo: tmux → the client's pty →
  the pty host reads, coalesces 5 ms → the port → page → xterm, and the page
  acks each frame on the same port. Main is on none of it (until phase 5 it
  was on it three times: the input `invoke`, the read and `send`, the ack
  `invoke`). Attaching and detaching are still a request to main, which
  resolves the session and keeps who owns which client.
- **Neovim.** page → `send(neovim:call)` → main → socket → nvim; a redraw:
  nvim → socket → main decodes msgpack in JS → `send(neovim:redraw)`
  (structured clone) → page.
- **A GUI Agent.** CLI → `out` (the journal) → `tail` → the conversation
  engine reads lines → adapter (JSON decode, protocol) → fold
  (`TranscriptFold`, twice: the adapter's and the conversation's, each a
  map lookup and a write per event) → events, batched → the Agents page
  over its port → folded a third time there → React. Main is told the
  conversation's facts (status, activity, session, MCP servers) when they
  change. DevHub's replies and the person's words: page → main (`invoke`) →
  engine → `sh` host script → the FIFO. (An Agent on another machine: its
  journal and writes go through main's runtime, as before.)
- **State.** every model change asks for a save; a save serialises the
  whole model and fsyncs on main.

## How it was measured

Linux, Xvfb, a source run of the worktree build (Electron 43.7.7, tmux 3.7c
built from the repository, Neovim 0.12.6, `LANG=C.UTF-8`, a profile of its
own), 4 cores. Every scenario ran with:

- **main's event-loop delay**, from a `perf_hooks.monitorEventLoopDelay`
  histogram (10 ms resolution; the numbers are the delay _beyond_ the 10 ms
  tick) installed through main's inspector (`--inspect`), and the lines
  `diagnostics/eventLoopLag.ts` wrote (over 150 ms);
- **main's thread CPU**, from `/proc/<pid>/task/<pid>/stat` (JS and
  Chromium's UI work together), and the busiest processes;
- **input-to-paint**: 40 keys sent with CDP `Input.dispatchKeyEvent` into an
  idle shell Agent's terminal (Agents page) and 40 into Scratch's Neovim in
  Insert mode, each timed from the dispatch to the animation frame after the
  page received its echo (a terminal: `shell/perfProbe.ts`, compiled in only
  with `DEVHUB_PERF_PROBE=1`; Neovim: a wrapper on `window.neovimEditor.redraw`);
- **a CPU profile of main** (CDP `Profiler`, 250 µs) over the same window.

The workload: 8 Workspaces (clones of this repository) plus Scratch, 5
terminal Agents (`bash`) attached, Neovim as the editor.

| Scenario       | What ran                                                                                                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a idle         | nothing                                                                                                                                                                                                                                                                                   |
| b terminals    | 4 Agents' terminals streaming: two `yes \| head -c 200M` loops, a 60 MB `cat` loop, a build-log loop                                                                                                                                                                                      |
| c replay       | 2 GUI Claude Agents started on a stand-in CLI that answers the control requests and replays a scrubbed capture (`claude-session.capture.ndjson`) with fresh ids plus 16 background subagents per pass: 40 000 lines at once, then 300 lines/s, through the real host, journal and adapter |
| c steady       | the same two, 20 s later, at 300 lines/s each                                                                                                                                                                                                                                             |
| d orchestrator | the Orchestrator running (a shell agent; GitHub polling idle: no projects)                                                                                                                                                                                                                |
| e git churn    | files rewritten in all 8 Workspaces every 300 ms                                                                                                                                                                                                                                          |
| f all          | b + c + d + e at once                                                                                                                                                                                                                                                                     |

## What the measurements said (before)

| scenario | lag p50 / p99 / max (ms) | main thread CPU | terminal key→paint p50 / p99 (ms) | Neovim key→paint p50 / p99 (ms) | busiest (CPU %)                         |
| -------- | ------------------------ | --------------- | --------------------------------- | ------------------------------- | --------------------------------------- |
| a idle   | 0.2 / 5.6 / 13           | 11%             | 8.7 / 16                          | 10.5 / 20                       | main 23                                 |
| b terms  | 0.2 / 13.7 / 131         | 19%             | 20 / 51                           | 19.5 / 38.5                     | tmux server 84, Agents page 46, main 31 |
| c replay | 0.4 / 31 / 120           | 39%             | **283 / 1231**                    | 18.5 / 48.5                     | **Agents page 123**, main 54            |
| c steady | 0.3 / 17.7 / 250         | 25%             | **1090 / 1589**                   | 10.8 / 35.4                     | **Agents page 132**, main 38            |

(In that first run d and e still had c's two Agents streaming — the Agents
page at 135% and the terminal keys at 1.6 s and 3.8 s — so they are not
listed; the later runs stop the Agents first.)

What the profiles and the process table showed, largest first:

1. **The Agents page renderer, not main, was what made typing slow.** With
   two GUI Agents streaming, the terminal Agent's keys took 0.3–1.6 s to
   paint, while Neovim's (its own renderer) stayed at 10–20 ms and main's
   loop stayed under 35 ms at p99. Every Agent's pane is mounted in the one
   Agents page, so the hidden conversations were redrawn by React every
   frame in the renderer that also draws the terminals. Its profile was 70%
   React and GC. (A run with an unrealistically large transcript took that
   renderer to 4.7 GB.)
2. **`spawn` was the largest single item on main's thread, in every
   scenario.** 2.5% of all of main's time idle (most of its JS), 10–23% with
   GUI Agents: tmux for the agent and activity rounds several times a
   second, `sh` for every line DevHub writes to a GUI Agent's host, path
   resolution for the conversation's links. Measured directly, one `spawn`
   held main's thread **8.3 ms** at p50 (a fork of a process with ~400 MB
   mapped); the same call in a small Node process takes 2.1 ms. (On macOS
   libuv can use `posix_spawn`, so the cost there is likely smaller; it is
   still synchronous work on main's thread, and the child's pipes and the
   5 ms cancellation poll per command were main's too.)
3. **One IPC message per conversation event**: `_send` was 4–8% of main
   during a replay.
4. **The conversation engine itself**: the adapter and the fold (folded
   twice in main and once more in the page), 10–15% of main during a
   replay. `applyEvent` copies the entries array and searches it from the
   end for each event, so its cost grows with the transcript — with a very
   long transcript (hundreds of thousands of lines) main went to 99% with
   `indexOfEntry` alone 48%.
5. **Terminal output is bounded by tmux, not by main.** Four terminals
   streaming at full speed put the tmux server at 85% and main at 19–31%:
   tmux redraws the client's screen rather than passing every byte on.
6. **Idle main is 11% of a core with almost no JS** (1–3% of it is JS):
   Chromium's own UI-thread work for the window and its views.
7. **Neovim** stayed at 10–25 ms key→paint throughout: its relay through
   main is not a hotspot at these loads.
8. Git watching and the Orchestrator added almost nothing (d and e within a
   few points of idle).
9. A side finding: a descriptor of main's that is not close-on-exec leaks
   into what main starts — the tmux server and the process-group anchors
   (`shell/processGroupAnchor.ts`) held the `--remote-debugging-port`
   listening socket, so the next DevHub could not bind it while they lived.
   Fixed in phase 5a, for every descriptor, not only this one.

The blocked-loop lines that remain (150–300 ms, about once a minute under
load, during "agent round", "snapshot publish", "state save") did not show
as long JavaScript tasks in the profiles (the longest JS tasks were 30–60 ms
of GC): they are native work on the UI thread or scheduling on a machine
whose four cores were saturated by tmux and the streams.

## The target

```text
            keys (UI thread)      windows, views, menus, focus, chord router
   OS ───▶ ┌──────────────────┐   small routing tables, no per-byte work
           │       main       │◀── facts (status, counts) at human rates
           └──────────────────┘
               │ MessagePorts handed out once
   ┌───────────┼──────────────────────┬──────────────────────┐
   ▼           ▼                      ▼                      ▼
 pages ◀──▶ agent engine          pty host              background
 (direct    (adapters, journals,  (node-pty, tmux       services (pollers:
  ports)     fold, writes)         clients, Neovim       git, GitHub, usage,
                                    sockets)              orchestrator, task
                                                          manager; state.json)
                         process host: every child process
```

- **Main** keeps the window, its views and their layout, menus, focus, the
  model's arrangement, and the chord router. It hands each page a
  `MessagePort` to the process that serves it and then stays out of the
  stream.
- **Agent engine** (utility process, done in phase 4): `AgentConversation`, the adapters, the
  journals and the writes. Pages attach to it directly; main gets the facts
  its rounds use (status, activity, requests, session) when they change.
- **Pty host** (utility process): the tmux clients' ptys, the frames and
  acks, directly with the pages; the Neovim sockets and their decoding,
  with the Neovim pages, keeping `neovim.*` as the page sees it.
- **Background services** (utility process): the pollers and the saves.
- **Process host** (done): every short child process.

## Phases, by measured impact

### Done

| Phase | What                                                                                        | Commit     |
| ----- | ------------------------------------------------------------------------------------------- | ---------- |
| 0     | A probe for terminal input-to-paint, compiled out of ordinary builds (`shell/perfProbe.ts`) | `c81f7ccf` |
| 1     | A hidden GUI Agent's pane folds but does not draw (finding 1)                               | `95d740fe` |
| 2     | The process host: every `runBounded` child starts in a utility process (finding 2)          | `ea17b90c` |
| 3     | Conversation events go to the page as one batch per turn of main's loop (finding 3)         | `05a2cf10` |
| 4a    | The fold costs the same per event however long the transcript (`TranscriptFold`, finding 4) | `b485855a` |
| 4b    | The conversation engine: every GUI Agent's conversation in a utility process (finding 4)    | `3ca4cc42` |
| 4c    | The Agents page does not render a conversation again when only the page around it changed   | `8130666e` |
| 5a    | Children start with nothing of their parent's open but stdio (finding 9)                    | `188b316b` |
| 5b    | The pty host: every terminal surface's tmux client in a utility process, pages over ports   | `f529a3b7` |

**Phase 1.** `useConversation` keeps folding every event of a hidden pane
(so a bad event is still refused where it arrives) and publishes nothing;
being shown draws what the fold holds, in the same render.

**Phase 2.** `runBounded` starts its child through a `ChildRunner`. The child
handling (pipes, caps, the process group, stdin errors) is
`terminal/childRun.ts`, the same code wherever it runs; in main it runs in
`main/processHost/entry.ts`, a utility process main starts once Electron is
ready and lets go of on quit. Deadlines, cancellation and which failure wins
stay in `runBounded`, which ends a run with `kill`. Tests, the CLI and
terminal bundles, and main before ready start children in-process as
before. A host that exits fails what it held and is started again; one that
exits three times in a minute is given up on, and commands start in main.
Not yet moved: the long-lived streams (`runtime/byteStream.ts`: the
journals' `tail`, `ssh -T`) and node-pty's tmux clients, which are phase 5's.

**Phase 3.** `devhub:conversation:events` carries a
`ConversationEventBatch`; the preload hands each event to its attachment in
order, so the page's fold is unchanged.

**Phase 4a.** `applyEvent` copied the entries array for every event that
touched it and found the entry by scanning, so each event cost O(n) in the
transcript's length. `TranscriptFold` owns its array between snapshots and
changes it in place, with an id → index map beside it; a snapshot makes the
array the snapshot's for good, so a copy happens once per snapshot (the
page: once per frame it draws; a hidden pane: never), not once per event. It
checks an event before changing anything, so one that does not fold leaves
it as it was. Measured in isolation, a delta at 200 000 entries went from
1.6 ms to 0.1 µs (`model/transcriptFold.test.ts` holds the cost per event
at 200 000 entries to that at 2 000). The adapter's fold and the
conversation's both stay: the conversation's observers (an edit's rewind,
the held message, the usage-limit and cache keepers) look at the transcript
after each event of a step, and DevHub's own events fold only there.

**Phase 4b.** `main/agentEngine/`: `engine.ts` runs each Agent's
`AgentConversation` as it ran in main; `entry.ts` is the utility process;
`client.ts` is main's side, and `protocol.ts` the typed messages of all
three (main, engine, page). Main holds a `ConversationHandle` per
conversation (`agent/conversation/handle.ts`): `facts()` — the round's
observation, the session, the MCP servers — pushed by the engine when they
change (once per turn of its loop at most); every other call a message; the
transcript (`snapshot()`, for `agent read`) a request. The Agents page gets a
`MessagePort` to the engine from main on its first attach
(`CONVERSATION_CHANNELS.port`) and takes the snapshot and the batched
events from there; drafts, held insertions and every request stay main's.
For an Agent on this machine the engine follows the journal and writes to
the host itself, asking main only where the host is and what its CLI is;
for one on another machine main keeps the host and forwards its lines.
Failures cross with their class (`HostLinkFailure` with its code and offset,
the named conversation failures). An engine that dies fails its calls as
`ConversationStopped`, every conversation reads as unknown with the reason,
a new engine starts at once and replays them from their journals, and the
page attaches again; after three exits in a minute it is given up on and the
conversations run in main, as they also do with
`DEVHUB_CONVERSATIONS_IN_MAIN=1` and in tests (`localHandle`).

**Phase 4c.** Found while measuring 4b with a long transcript: the Agents
page renders every pane for each app snapshot, and the conversation's
element was new each time, so React rendered a long transcript again for
every snapshot, hidden or not. `ConversationPane` keeps the element while
its props are the same.

**Phase 5a.** On Linux libuv forks and execs without closing what the
parent has open, and Node marks only what it inherited close-on-exec, so
every descriptor Electron opens afterwards without the flag (Chromium's
shared memory and snapshot files, a utility process's channel, main's
`--remote-debugging-port` listener) went to every child and to theirs.
Measured before: the tmux server, started by a `tmux` command from the
process host, held three of the host's; the process-group anchor, started
from main, held some sixty of main's, the debugging listener among them.
`devhub-exec-clean` (`native/execClean.c`) marks everything above 2
close-on-exec and execs the program in place (same pid, group, pipes, exit
status); `terminal/cleanSpawn.ts` routes `childRun` (the process host's and
main's bounded commands), the byte streams (`tail`, `ssh -T`) and the
whisper server through it on Linux once the program is found, so a missing
program is still `spawn`'s `ENOENT`. The anchor closes everything above 2
itself. node-pty already did this for its PTYs; macOS's `posix_spawn` with
`POSIX_SPAWN_CLOEXEC_DEFAULT` already inherits nothing. Measured after: the
tmux server and both anchor processes hold only their own descriptors, and
the debugging port is main's alone. The tests read `/proc/<child>/fd`
(`cleanSpawn.test.ts`, `processGroupAnchor.test.ts`, and in `test:pty` a
probe run as Electron, whose own non-close-on-exec descriptors a plain
child inherits and a PTY or a bounded command does not). Other
`child_process` callers in main (the GitHub CLI, usage readers, the login
shell probe, the workspace picker) are short-lived and still start
directly.

**Phase 5b.** `main/ptyHost/`: `host.ts` runs each client as main ran it
(`PtyAttachment`, the coalescer, the ack window, the input ledger, now
shared), `entry.ts` is the utility process with the submodule's node-pty,
`client.ts` is main's side, `protocol.ts` the messages of all three. A page
gets a `MessagePort` to the host on its first attach there
(`TERMINAL_CHANNELS.port`, one per page per host); frames go out on it and
input, resizes and acks come back on it, each answered with the same
`TerminalResult` as before, and the host checks every request against the
page whose port it came in on. Main keeps what it decided before: the
marked session a surface attaches to, the permits, and the ledger of who
owns which client (`AttachmentManager.attachVia`), and is told only that a
client started or ended (an end of its own still reaches
`onEndedByItself`). What to run comes from the machine
(`Runtime.ptyPlan`): the tmux client on this machine, the `ssh -tt` client
for a host, its mux session slot given back when the host says the client
ended. `preload/terminal.ts` is the only code that knows where a client is;
`DevhubTerminalApi` is unchanged, so the shell, the Agents page, the panes
and the Neovim surface's terminal windows are untouched. A host that dies
takes its clients with it (tmux keeps the sessions), the pages are told
(`TERMINAL_CHANNELS.restarted`), and each surface gets a `host_restarted`
error in its own frame sequence, shows "Reconnecting…" and attaches again,
to a new host; an attach in flight is refused with the same code and
retried the same way. Three exits in a minute and clients start in main
again, as `DEVHUB_TERMINALS_IN_MAIN=1` does from the start. Measured by
killing it: five terminals were on a new host three seconds later (the
surface waits 250 ms), their seven sessions intact, keys at 8.5 ms p50;
after the third kill the clients were main's children and typing was the
same. The tmux control commands were already the process host's (phase 2);
their rounds' scheduling stays in main with the other rounds (phase 7).
**Not moved: the Neovim RPC sockets and their decoding** (`editor/neovimRpc.ts`,
`neovimUi.ts`), which are still relayed through main; they are the next
step of this phase (below).

### After phase 5

Same machine, two runs of each on the same day: "before" is origin/main
before phase 5 (`d9877de9`), "after" with 5a and 5b. Main's process CPU is
all its threads, from the process table.

| scenario    | main thread CPU        | main JS busy                  | main process CPU    | pty host | lag p99 / max (ms)                            | terminal key→paint p50 / p99 (ms)                      | Neovim key→paint p50 / p99 (ms)                     |
| ----------- | ---------------------- | ----------------------------- | ------------------- | -------- | --------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| a idle      | 11%, 10% → **11%, 9%** | 1.3%, 1.2% → **1.0%, 0.9%**   | 25, 22 → 25, 21     | <5%      | 1.1 / 6.1, 1.6 / 6.8 → 1.1 / 20.6, 1 / 3.3    | 9.4 / 22.1, 9 / 19.2 → 9.3 / 20.6, 8.7 / 29.5          | 9.7 / 22.7, 10 / 22.9 → 9.6 / 15.6, 9.9 / 18        |
| b terminals | 20%, 17% → **8%, 7%**  | 10.1%, 8.7% → **1.6%, 1.4%**  | 35, 31 → **18, 16** | 13%      | 5 / 172, 5 / 141 → 4.3 / 114, 3.8 / 91        | 25.6 / 87.4, 24.7 / 135.9 → 30.1 / 157.2, 30.3 / 117.3 | 23.1 / 67.4, 22.4 / 38.4 → 20 / 29.3, 22.2 / 40.1   |
| f all       | 19%, 17% → **10%, 9%** | 12.2%, 10.8% → **4.1%, 3.5%** | 32, 30 → **19, 18** | 11–13%   | 11.1 / 173, 7.1 / 122 → 8.8 / 143, 6.4 / 16.7 | 31.2 / 199.7, 23.1 / 60 → 26.3 / 103.2, 27.3 / 113.2   | 21.6 / 59.6, 15.5 / 54.8 → 23.9 / 61.1, 17.1 / 45.6 |

- Main's JavaScript with four terminals streaming: **9–10% → 1.5%** busy;
  `attachments.js`, `service.js`, `_send` and `sendReply` (about 7% of main
  between them) are gone from its profile, and what is left is the model's
  rounds. Main's thread **17–20% → 7–8%**, the whole process 31–35% → 16–18%.
- The pty host itself runs at 11–13% of a core for the same four streams.
- Terminal key→paint did not get faster, and with four terminals streaming
  its p50 is about 5 ms higher (25 → 30 ms); p99 is within the runs'
  spread. The keys there wait for what the streams keep busy — the tmux
  server at 80–87%, the Agents page renderer at 45–57%, on four cores that
  the streams saturate — and a key now wakes one more process than it did
  (the pty host, where main was already awake). Idle it is the same 9 ms.
- The tmux server, not DevHub, is still the bound on terminal output (finding 5).

### After phase 4

Same machine and workload as above, a run of each on the same day. "before"
is origin/main before phase 4 (`66b3b983`), "fold only" phase 4a with the
conversations kept in main (`DEVHUB_CONVERSATIONS_IN_MAIN=1`), "after" 4a +
4b, "+4c" the long transcript with 4c as well. **long** is one GUI Agent on
the stand-in CLI at 6 000 lines/s for 150 s (a transcript of a few hundred
thousand lines), hidden, while the terminal Agent is typed into.

| scenario | main thread CPU     | main JS busy             | lag p99 / max (ms)                     | terminal key→paint p50 / p99 (ms)                              | Neovim key→paint p50 / p99 (ms) | conversation engine |
| -------- | ------------------- | ------------------------ | -------------------------------------- | -------------------------------------------------------------- | ------------------------------- | ------------------- |
| a idle   | 9% → 9% → **9%**    | 1.0% → 1.0% → **1.0%**   | 0.9 / 2.6 → 1 / 9.4 → **1 / 3.5**      | 8.8 / 22.1 → 8.5 / 14.7 → **8.6 / 19.2**                       | 10.6 / 22 → **10.6 / 18.1**     | —                   |
| c replay | 24% → 22% → **13%** | 13.1% → 10.9% → **3.3%** | 3.7 / 128 → 2.8 / 6 → **3.2 / 14.2**   | 8.4 / 20.6 → 8.5 / 27.2 → **8.5 / 23.4**                       | 10.4 / 20.6 → **10.8 / 12.5**   | 21%                 |
| c steady | 30% → 22% → **13%** | 20.1% → 10.7% → **3.3%** | 4.1 / 110 → 4 / 157 → **2.2 / 113**    | 9.1 / 22.5 → 8.4 / 21.1 → **8.4 / 14.2**                       | 10.7 / 20.8 → **10.6 / 19.1**   | 19%                 |
| long     | 87% → 21% → **11%** | 88.2% → 12.5% → **2.6%** | 130 / 170 → 4.5 / 220 → **3.8 / 143**  | 2569 / 3985 → 4801 / 6248 → 4570 / 7732 → **322 / 1133** (+4c) | 16.9 / 143 → **9.8 / 25.9**     | 26%                 |
| f all    | 27% → 23% → **12%** | 27.1% → 18.3% → **6.0%** | 10.5 / 206 → 13 / 40.5 → **7.1 / 166** | 47.7 / 232 → 40.1 / 748 → **22.8 / 387**                       | 20.9 / 29.1 → **20.4 / 62.8**   | —                   |

- Main's JavaScript under GUI Agents: 13–20% busy → **3%** (c), 27% → **6%**
  (f). The conversation code is gone from main's profile; what is left on
  it is the model's rounds and `_send` (under 1%).
- With a long transcript main went from 87% (`indexOfEntry` 43%,
  `replaceAt` 14%, `putEntry` 9%) to **11%**, and its loop's p99 from
  130 ms to **4 ms**.
- The terminal Agent's keys with a long transcript were not main's: the
  Agents page renderer was at 115–120% in every run, rendering the hidden
  conversation for each app snapshot. With main out of the way more events
  reached it and the keys got slower (4.6 s) until 4c (**0.3 s** p50). The
  renderer is still at ~100% there: phase 6.
- The engine itself runs at 20–30% of a core with two Agents replaying or
  one streaming at 6 000 lines/s; its largest items are the adapter's MCP
  bookkeeping (`publishMcp`, `mcpWorking`, ~5% each of what main spent in
  the long run before), JSON decoding and the folds.

### After

Before (origin/main) → after phases 1–3, same machine and workload. d, e and
f have no before column: in the first run d and e still had c's Agents
streaming (the terminal keys took 1.6 s and 3.8 s there), and f did not
complete.

| scenario       | main thread CPU | main JS busy      | lag p99 / max (ms)             | terminal key→paint p50 / p99 (ms) | Neovim key→paint p50 / p99 (ms) | busiest renderer |
| -------------- | --------------- | ----------------- | ------------------------------ | --------------------------------- | ------------------------------- | ---------------- |
| a idle         | 11% → **10%**   | 2.8% → **1.2%**   | 5.6 / 12.9 → **1.4 / 120.4**   | 8.7 / 15.9 → **8.8 / 20.3**       | 10.5 / 20.1 → **10.4 / 14.1**   | <5% → **<5%**    |
| b terminals    | 19% → **18%**   | 12.3% → **10.6%** | 13.7 / 131.2 → **4.9 / 116.8** | 20.3 / 50.8 → **23.6 / 51.4**     | 19.5 / 38.5 → **16.7 / 31.6**   | 46% → **45%**    |
| c replay       | 39% → **32%**   | 34.2% → **22.5%** | 31.2 / 119.5 → **5.7 / 111.6** | 282.6 / 1231.3 → **11.9 / 29.8**  | 18.5 / 48.5 → **10.3 / 22.8**   | 123% → **9%**    |
| c steady       | 25% → **16%**   | 15.0% → **6.2%**  | 17.7 / 249.7 → **4.1 / 127**   | 1089.7 / 1589.1 → **8.6 / 28.3**  | 10.8 / 35.4 → **10.5 / 22.9**   | 132% → **5%**    |
| d orchestrator | **10%**         | **1.6%**          | **1 / 123.6**                  | **8.4 / 18**                      | **10.6 / 12.1**                 | **<5%**          |
| e git churn    | **10%**         | **1.1%**          | **1.2 / 8**                    | **8.5 / 10.5**                    | **10.6 / 23.3**                 | **<5%**          |
| f all          | **16%**         | **8.9%**          | **9.6 / 213.3**                | **34.6 / 608.8**                  | **14.6 / 41.6**                 | **59%**          |

- Typing in a terminal Agent while GUI Agents stream: **1.1 s → 9 ms** at
  p50 (c steady), **1.2 s → 30 ms** at p99 during a replay.
- Main's JavaScript during a replay: 34% → 22% busy; `spawn` is gone from
  every profile and `_send` went from 7–8% to under 1%.
- What is left on main under GUI Agents is the conversation engine itself
  (adapter and fold, ~15% during a replay): phase 4.
- f (everything at once) still has terminal keys at 600 ms p99: four
  terminals streaming into hidden xterms keep the same Agents page at
  ~60%, and tmux at 70–85%. Phase 6 (and the hidden-terminal half of
  phase 1, below) is that.

### Next

4. **Done** (phase 4 above). Left of it: the engine's own cost under a fast
   stream (the Claude adapter compares its MCP state as JSON for each event
   it emits and rebuilds `working` from every server), and a remote Agent's
   journal, which still passes main's runtime until phase 5 gives SSH and
   containers a home outside main too.
5. **Done for terminals** (phase 5 above). Left of it: **the Neovim sockets**
   and their msgpack decoding, still in main (`editor/neovimRpc.ts`,
   `neovimUi.ts`, `neovimEditors.ts`), to move to the pty host keeping the
   page's `neovim.*` bridge as it is; and the long-lived streams
   (`runtime/byteStream.ts`: a remote Agent's journal `tail`, `ssh -T`), with
   SSH and containers given a home outside main. The other `child_process`
   callers in main could go through `cleanSpawn` too.
6. **The Agents page split**: terminal Agents and GUI conversations in
   different renderers, so a visible conversation's rendering cannot hold a
   terminal's keys either (phase 1 covers only hidden ones). Before it, the
   same rule as phase 1 for hidden terminals: a hidden Agent's xterm
   parsing and drawing a stream nobody sees is what is left in f.
7. **Background services**: the agent and activity rounds' scheduling,
   repository status, usage readers, Task Manager sampling, the
   Orchestrator's invariant and GitHub polling, and `state.json`'s
   serialisation, moved together because they share the model's facts. At
   the measured loads they are small (d, e), so they come after 4–6.
8. **Chords in the pages' preloads** (capture-phase `keydown`) instead of
   `before-input-event`, with main's handler kept for VS Code's workbench
   views only. Measured impact is the smallest of all: a key reaches the
   renderer through main's UI thread regardless (Chromium's input routing),
   so this saves one JS call per key, not the wait. It would also have to
   keep the chord semantics that rely on seeing the key before any page
   does — one queue across views, the prefix swallowed before an editor
   sees it — and the input-source switch, which the page cannot do. Last.
