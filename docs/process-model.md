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

| Process                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **main** (Electron's browser process, VS Code's main in it) | the window, its child views, menus, focus (`shell/`); the chord layer, a `before-input-event` handler on every web contents (`shell/keyboard.ts`); the terminal ledger: which marked session a surface attaches to, the attach permits and who owns which client, told only when a client starts or ends (`terminal/service.ts`, `surfaces.ts`, `attachments.ts`); tmux control and polling: the agent round and the terminal activity round (`terminal/tmux.ts`, `shell/agentWiring.ts`); every managed Neovim's lifecycle connection (`editor/managedNeovim.ts`: start, adopt, file jumps, theme) and the Neovim editors' attaches, ports and clipboard (`editor/neovimEditors.ts`); a proxy per GUI Agent's conversation (`agent/conversation/handle.ts`, `agentEngine/client.ts`): the facts the engine pushes, the requests, the host of an Agent on another machine; `state.json` (`shell/saveCoalescer.ts`); the Orchestrator (invariant, events, timers, GitHub polling); repository status (git), usage readers, Task Manager sampling, the `devhub` CLI's control socket, voice |
| **process host** (utility process, new)                     | starts every child main runs: each bounded command — tmux, git, ssh, the GUI Agents' host scripts — and each long-lived stream (a remote Agent's journal over `ssh -T`), its bytes sent to the process that reads them over a port of their own (`main/processHost/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **pty host** (utility process, new)                         | every terminal surface's tmux client (node-pty), its output coalesced and framed, its acks, input and resizes, directly with the page over the page's `MessagePort` (`main/ptyHost/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Neovim host** (utility process, new)                      | every Neovim editor's UI: its own connection to the Neovim's socket, the msgpack decoding, the attach, the GUI windows, each redraw sent to the page over the page's `MessagePort` and the page's calls back on it (`main/neovimHost/`, `editor/neovimUiSessions.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **conversation engine** (utility process, new)              | every GUI Agent's `AgentConversation`: the journal followed (an Agent on this machine), the protocol adapter, the fold, the held messages, the usage-limit and cache keepers; the Agents page's snapshot and events over a `MessagePort` (`main/agentEngine/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| DevHub's pages (one renderer each)                          | the window's own page, the Sidebar, **the Agents page (the terminal Agents' xterms and the Orchestrator's board) and the Conversations page (the GUI Agents' conversations), laid in the same place, two renderers**, an Agent's terminal pane, one Neovim page per Workspace, notices, questions, tooltip; Settings and Task Manager windows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| VS Code                                                     | a renderer per workbench, its extension host, file watcher, shared process, pty host, language servers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| outside Electron                                            | DevHub's tmux server (every terminal and every Agent's session), the GUI Agents' hosts and CLIs, Neovim (`nvim --headless --listen`, kept by tmux)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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
  resolves the session and keeps who owns which client. A surface that is
  hidden acks its frames as they come and does not hand them to xterm
  (phase 6), and once it has missed more than it keeps it lets its client
  go until it is shown (phase 6d).
- **Neovim.** page → its port → the Neovim host → socket → nvim; a redraw:
  nvim → socket → the Neovim host decodes msgpack → its port (structured
  clone) → page. Main is on none of it (until phase 5c it decoded every
  redraw); it answers the attach, keeps its own connection per server for
  the lifecycle and the file jumps, and answers Neovim's clipboard.
- **A GUI Agent.** CLI → `out` (the journal) → `tail` → the conversation
  engine reads lines → adapter (JSON decode, protocol) → fold
  (`TranscriptFold`, twice: the adapter's and the conversation's, each a
  map lookup and a write per event) → events, batched → the
  Conversations page over its port → folded a third time there → React
  (until phase 6 that was the Agents page, the terminal Agents' renderer). Main is told the
  conversation's facts (status, activity, session, MCP servers) when they
  change. DevHub's replies and the person's words: page → main (`invoke`) →
  engine → `sh` host script → the FIFO.
- **A GUI Agent on another machine.** CLI → `out` → `tail` → `sshd` →
  `ssh -T` (a child of the process host) → the process host reads its
  stdout → the stream's port → the conversation engine splits the lines
  (`HostLink`, as for an Agent here) → the same adapter and fold. Main
  composed the `ssh -T` (its runtime of that host: the login environment,
  the master's session slot) and is told how it ended, which is where a
  refusal is decided, but none of its bytes. Its writes are still main's
  (`ssh` commands, through the process host). Until phase 5d main read the
  stream, split it and sent the lines on to the engine.
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
   ┌───────────┼──────────────────────┬────────────────┬─────────────────────┐
   ▼           ▼                      ▼                ▼                     ▼
 pages ◀──▶ agent engine          pty host        Neovim host           background
 (direct    (adapters, journals,  (node-pty,      (the UIs' sockets,    services (pollers:
  ports)     fold, writes)         tmux clients)   msgpack, redraws)     git, GitHub, usage,
                                                                         orchestrator, task
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
- **Pty host** (utility process, done in phase 5b): the tmux clients' ptys,
  the frames and acks, directly with the pages.
- **Neovim host** (utility process, done in phase 5c): the Neovim editors'
  UI sockets and their decoding, with the Neovim pages, keeping `neovim.*`
  as the page sees it.
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
| 5c    | The Neovim host: every Neovim editor's UI connection in a utility process, pages over ports | `b4015c4f` |
| 5d    | SSH hosts' commands reach the process host at all (an environment it can clone)             | `273547ea` |
| 5d    | Byte streams in the process host; a remote Agent's journal read by the engine, over a port  | `f8793ba3` |
| 6a    | A hidden terminal surface acks its frames and does not draw them                            | `a02af7d9` |
| 6b    | The GUI Agents' conversations in a renderer of their own (the Conversations page)           | `61914f30` |
| 6c    | Inserting into a long list does not restyle all of it (`.picker > * + *`)                   | `e4b05e6d` |
| 6c    | A conversation's frame costs what changed, not the transcript's length                      | `ad5f834f` |
| 6d    | A hidden terminal surface lets its client go once it has missed more than it keeps          | `111d60da` |
| 6e    | A streaming conversation's frame wakes only the file links and tool calls that changed      | `ad05b7e1` |
| 7a    | Main says a rectangle and the window's name only when they move, to the page that draws it  | `505a2384` |

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
The Neovim RPC sockets were the next step: phase 5c.

**Phase 5c.** `main/neovimHost/`, a utility process of its own beside the
pty host rather than in it: the two share no code but the restart policy,
and apart each is its own failure domain (a decoding bug or a huge redraw
does not take the terminals with it, nor stall their 5 ms coalescing on the
same thread), its own core under load (four terminals streaming and a
Neovim scrolling at once), and its own fallback switch
(`DEVHUB_NEOVIM_IN_MAIN=1`); the pty host keeps node-pty only. The UI gets
a connection of its own to the Neovim's socket: main's `ManagedNeovims`
keeps the one it had per server (its closing is still Neovim having
exited; the file jumps and the theme go on it), and its `connection()` now
answers the socket on this Mac to connect to (on an SSH host the forward's,
`NeovimSockets.reach`) and which server that is. `editor/neovimUiSessions.ts`
is the UI's side as `NeovimEditors` ran it — the connection, `NeovimUi`, the
GUI windows told again to a page that attaches again — and runs in the host
(`host.ts`) or, with no host, in main; `client.ts` is main's side (the
process, a `MessagePort` per page per host on `NEOVIM_CHANNELS.port`, the
restart policy), `protocol.ts` main's messages with the host and
`ipc/neovim.ts` the page's. A page's calls are checked against the
Workspaces it attached. Neovim's clipboard (`g:clipboard`'s `rpcrequest` and
`rpcnotify`) is answered by main, which the host asks: a utility process has
no clipboard. `preload/neovim.ts` is the only code that knows where a UI is;
`DevhubNeovimApi` is unchanged. A host that ends takes the UIs' connections
with it (the Neovims are tmux's); the pages are told
(`NEOVIM_CHANNELS.restarted`, then `ended` with `reconnect`), and attach
again by themselves, to a new host; an attach in flight goes to the next
host. Three ends in a minute and the UIs run in main, over IPC, as before.
Measured by killing it (`kill -9`): the page was drawing from a new host
about 1.1 s later (the page's first reconnect waits 0.8 s), keys, requests
and the clipboard both ways working; after the third kill in a minute the
UI was main's and the same checks passed. An SSH-forwarded Neovim takes the
same path (a second connection through the same `ssh -O forward` socket) but
was not run against a real host here.

**Phase 5d.** Two things, the first found while setting up the second.
Every command for an SSH host had failed since phase 2 — opening a
Workspace there said "[object Object] could not be cloned": a host's
commands defaulted to main's own `process.env`, which in Electron's
browser process is a host object a utility process's `postMessage` cannot
clone (it can in plain Node, so no test saw it). `SshRuntime` now copies
it once, and the process host's client posts every environment as a plain
object. (Copying `process.env` per command instead was 2.6% of main with
two remote Agents streaming: reading it whole is slow too.)

Then the long-lived streams (`runtime/byteStream.ts`). Their child is now
`terminal/streamRun.ts`, the same code wherever it runs, as `childRun.ts`
is for the bounded commands; `openByteStream` keeps what an ending means
(the refusal, the session slot released, the cancellation) and starts the
child through the installed `StreamRunner`: in main, the process host
(`setStreamRunner`, `main.ts`). A `StreamRequest` can name a sink (`to`):
one end of a `MessagePort`, which goes to the process host with the
stream, so the bytes go from the child's pipe straight to whoever holds
the other end; without one they come back to main as before, for a reader
in main. A remote Agent's journal is the stream that matters: the
conversation engine now follows it itself, with the same `HostLink` an
Agent on this machine has, on main's runtime of that machine at one remove
(`agentEngine/brokeredRuntime.ts`): a stream is a `stream-open` main
answers with the port and starts with its runtime (`ssh -T` composed,
login environment, session slot) in the process host, and then a
`stream-end` with how it ended; the end of the journal of a host that is
over is an `exec` main runs and answers as data. Main splits no lines and
forwards none (until now `#follow` did, in `agentEngine/client.ts`;
deleted). Its writes stay main's.

Why the process host and not a host of its own, or the pty host: what is
moved is exactly what the process host already does — start a child
through `cleanSpawn`, hold its pipes and its process group, send back
what it printed — for a child that lives longer; the target already says
"process host: every child process". Its thread does little per chunk
(read, copy, post): two remote journals at 1 MB/s each took it from 17–20%
of a core to 21–26% (below); the pty host's thread is the terminals' 5 ms
coalescing and their keys, which a 40 000-line burst should not share; and
a separate host would be a fourth restart policy and switch for the same
children. What a stream shares with the commands is a failure domain, and
the recovery is the same for both: a process host that ends fails what it
held — a command fails, a stream's `ended` rejects (`failed`), the engine
sees its port close — the next one starts a new host, and the
conversation, `lost`, is followed again from its offset by the next round's
`reattach`. Three ends in a minute and streams start in main again, with
the commands; `DEVHUB_BYTESTREAMS_IN_MAIN=1` starts them in main from the
start (the bytes then pass main's thread on their way to the port, but
are still split by the engine). With the conversations in main
(`DEVHUB_CONVERSATIONS_IN_MAIN=1`, or the engine given up on) the journal
is read in main and its stream still runs in the process host, its bytes
coming back to main.

Not moved: the dev-container relay (`container.ts`'s `spawnRelay`, a
`docker exec -i` whose stdio is piped to a socket of VS Code's in main),
which is the editor's remote traffic for a container on a host, not a
stream DevHub reads, and the whisper server, which is started once.

**Phase 6a.** A terminal surface that has been on screen and is hidden
again (`TerminalSurface`, the Agents page's pool) keeps its client and
acks each frame the moment it arrives, so tmux is never held back, and
does not hand it to xterm. It keeps what arrived while that is under
128 KiB and writes it, in order, when it is shown: the exact stream, one
small parse. Past that it keeps nothing, and being shown attaches a new
client — quietly: the pane goes on showing what it last drew rather than
"Connecting…", and keys typed meanwhile go to the new client — which tmux
draws from nothing, the modes and the cursor with the screen, so nothing
skipped can be missing from it.

The plan was to re-attach on every reveal. Two things measured changed it.
xterm has no scrollback to lose here: tmux enters the alternate screen on
its client terminal (`smcup`, `?1049h` is the first thing an attach
sends), so the history is tmux's and a re-attach costs xterm nothing
(with a user's `smcup@` override the hidden stretch would be missing from
xterm's scrollback, and is in tmux's). But a TUI that animates in the
background — an Agent's spinner — would have cost a new client and a
redraw on every switch to it; under the bound it costs a few kilobytes
parsed. Keeping the parse and throttling it was not tried: the parse of a
stream nobody sees was the cost.

Replacing a client that is still streaming exposed a race older than this:
its frames in flight, and its end, arrived on the same channel as the next
attachment's. The page's decoder failed on them ("terminal frame sequence
is not contiguous"), and the preload marked the new channel ended on the
old client's last frame, so the new attach went silent and timed out
(`Retry` after a failure never met it: a failed client has nothing in
flight). Frames from the pty host now say whose they are; the preload
drops a detached attachment's and the decoder passes over them.

Not done here: telling the pty host to stop reading a hidden client. Done
another way in phase 6d, below.

**Phase 6d.** Past the 128 KiB a hidden surface keeps, the client it has is
no use to it: coming back attaches a new one either way. Until then it went
on streaming — the pty host read and framed it, the Agents page received
and acknowledged every frame — for nothing: 13–14% of the Agents renderer
and 16–17% of the pty host with four hidden Agents streaming. The surface
now detaches that client the moment it has missed more than it keeps, and
passes over what it still had on the way, its end included (on main's own
path the end can arrive before the detach is answered, and would have said
the session disconnected).

The plan was a hidden mode in the pty host: stop forwarding, keep or count
the backlog there, reveal by asking it. Measured, the client was worth
nothing past the bound and something under it, which is the rule 6a
already had in the page; letting it go needs no new message, nothing in
main's fallback path and no change to the backpressure timer, and it
saves the pty host's reading too, not only the page's. It does not touch
tmux, whose work (70–87% here) is parsing the panes' output with or without
a client. The program in the pane is never held back — there is no client
to hold it — and nothing is lost: tmux keeps the screen and the history,
and the client attached on reveal is drawn from them. A Workspace terminal
let go reads as not in view (`session_attached`) for the activity marks,
which is only so while its Workspace is not on screen either.

**Phase 6b.** Every Agent's pane was mounted in the one Agents page, so a
GUI Agent's conversation being drawn held the terminal Agents' keys:
phase 1 kept hidden conversations from drawing, but nothing kept a
visible one from taking the renderer, and a long transcript is seconds of
React per frame. Measured below (v): with a GUI Agent streaming on screen
the renderer was at 101–121%, and switching to a terminal Agent and typing
did not echo within 10 s.

The GUI Agents' panes are now a page of their own, `conversations.html`
(`ConversationsApp`), in a Conversations view main lays exactly where the
Agents view is (`shellWindow.ts`); the Agents page draws the terminal
Agents and the Orchestrator's board. An Agent's pane, its failure and its
Smart Buttons are in one page or the other by its presentation
(`AgentPane`'s `presentation`). `LayoutState.conversation` says which view
has the Agent on screen — `whole`, or `beside-board` for a GUI
Orchestrator, its conversation right of the board the Agents view goes on
drawing (`orchestratorBoardWidth` says the board's CSS width) — and the
keyboard goes to that view (`keyboardChild`); keys the person put on the
board stay there. The conversation IPC sends attachments, events, words
and the engine's port to the Conversations page and answers either page's
requests (a terminal Agent carried on in the GUI asks from the Agents
page); dictation and the microphone are both pages'; the lists of pages
by URL (history, zoom, the Task Manager, recovery) name it. The page has
the Agents page's preload. It costs a renderer: 38 MB PSS idle.

Why the split and not the alternatives the plan named: the fold is not
what costs (one hidden GUI Agent at 6 000 lines/s kept the Agents page's
thread 9% busy, the terminal at 9 / 20 ms); drawing is, and only a visible
conversation draws. Moving the fold to a worker would not touch that.
Virtualizing the transcript would cut it, but not isolate it: the next
expensive thing a conversation draws (a diagram, a long diff) would be on
the terminals' thread again. Two renderers make "a conversation cannot
hold a terminal's keys" true by construction. Virtualizing is still worth
doing, for the conversation's own sake: its renderer is at 116–121% with
a long transcript streaming, and its composer's keys wait for that.

**Phase 6c.** The plan was to virtualize the transcript — draw what is on
view and some around it, as VS Code's and Zed's chats do. It was not done:
measured first, the cost was not the number of entries in the document but
four things each frame did with all of them, and each could be made to cost
what changed instead. With a GUI Agent streaming on screen (the stand-in
CLI: a 40 000-line burst, then 300 lines/s, 3 400–4 100 top-level entries
and 65 000–80 000 elements at the times measured) a frame took, largest
first:

1. **Style and layout for every entry, each time one was added.** Inserting
   one child into the transcript restyled all of its children (Chrome's
   trace: 3 400–4 100 elements recalculated, 25–45 ms, and 2 200 of 3 500
   layout objects dirtied), because of the transcript's own sibling rules
   (`.conversation-entry + .conversation-entry`, the spacing) — and every
   page's `.picker > * + *`, which on its own made inserting into any long
   list restyle all of it (22 ms → 1 ms for 2 000 plain paragraphs; fixed,
   and a test keeps such rules out). The top-level entries are now in
   chunks of 50 (`entryChunks.tsx`) inside a container of their own, so an
   entry is added at the end of the last chunk and a chunk at the end of
   the container, never before a sibling: under 1 ms. A chunk keeps its
   entries (named by its first, the starts remembered across draws, only
   the last one cut by size), so an entry is never moved and drawn anew
   with its folds closed. The spacing across a chunk's edge is the same
   rule with the kind before taken from the chunk (`data-after`).
2. **Every tool call drawn again, every frame.** Every `ToolView` read the
   subagent layout from a context whose value was a new object each frame
   (a subagent entry changes as it runs), and the page's two app-level
   contexts (`useAgents`, the `devhub:` links) were new on every app
   snapshot — with the transcript below them, React looked through all of
   its fibers for readers each time (`propagateContextChanges`, 5–7%) and
   redrew thousands of tool calls (their DOM's props compared: another
   10%). They are now stores handed down in a context that does not change
   (`publishedValue.tsx`): what draws in the same pass reads the new value,
   and once committed only readers whose part of it changed draw again — a
   tool call its place (`useSubagentPlace`), its children and requests
   (`EntryTreeContext`). The layout is also memoized.
3. **Blink's own observer of every `content-visibility: auto` element.**
   With per-entry `content-visibility`, the page worked out where 3 400
   elements were every frame (`IntersectionObserverController`, 21% of the
   thread once the rest was gone). The chunks are what is skipped now; the
   entries of a chunk on view are drawn as they are.
4. **Following the end and marking what arrived** read the whole
   transcript's layout (`scrollTop = scrollHeight`, 18% before, 7% after
   the others) and walked every entry (`useFreshEntries`); the latter now
   reads the transcript's own mutations.

Why not virtualize after all: with the transcript whole in the document,
find (`transcriptSearch.ts` reads the drawn words), a drag selection across
messages, Cmd+A and copy, the browser's scroll anchoring and
`content-visibility`'s remembered sizes all hold by construction, and each
of those would have needed its own replacement over a window of entries
(find over a model of text the page does not draw, a selection pinned
across unmounts, anchoring by estimated heights). Drawing a window would
still bound what a pathological transcript costs in memory; with the costs
above gone it is not what the keys wait for.

**Phase 6e.** After 6c the Conversations renderer was still at 80–110%
with a conversation streaming on screen (the stand-in, as in 6c), its
main thread at 66–81%. The plan named four suspects; profiled (CPU
profiles of an unminified build, Chrome traces), none of them was it:
the Markdown parse is already a settled prefix and a re-parsed tail
(`markdownBlocks.ts`, about 1% of the thread), a code block is coloured
only once its fence has closed and the colouring is kept (nothing in the
profile), the following of the end is the frame's own style and layout
read early (not a second one), and the store updates are already drawn
at most once an animation frame. What was:

1. **Every file link woke for every answer, and for every turn's end.**
   One `PathLinks` per conversation had one set of listeners: each answer
   from main called every word that could be a path, and a turn's end
   forgot every word that named nothing — each of those drew again as
   "not asked", asked again, and drew again when the answer came. In a
   long transcript that is thousands of `PathLink`s drawn twice per turn:
   with the stand-in (a turn every 1.5 s) 18% of the thread in passive
   effects and 15% in the synchronous draws that followed. A word's
   readers now subscribe to that word, a turn's end asks again about the
   words that named nothing while they stay plain text
   (`askAgainAbsent`), and only a word whose answer changed is woken.
2. **Every tool call was told of every commit.** The entry tree's store
   (6c) called all its readers on each commit, and each looked its part
   up to find that nothing had moved (3–4%). `EntryTreeStore` compares the
   tree it publishes with the last (`changedParts`: the parents whose
   children or requests are new arrays, and the two the plan moved
   between) and tells only those parts' readers.
3. **The rewind targets were a new set every frame**, in a context over
   every message, so React looked through the whole transcript for its
   readers each time (`propagateContextChanges`, 4%). The set is kept
   while it holds the same messages.

Tried and not kept, each measured against the build without it on the
same running conversation, interleaved:

- **Drawing in the animation frame** (`flushSync` in the
  `requestAnimationFrame` that publishes, instead of React's scheduler
  task after it, which leaves the picture for the next frame): the text
  appeared no sooner (event→paint p50 25–27 ms either way), and the
  composer's keys were later (p50 17–34 ms against 7–18): a draw inside
  the frame holds the input that arrives while it runs.
- **Pacing the draws by their cost** (resting twice what the last draw
  took): half the commits, but the thread was at 53–61% against 57–63%
  and the text's p99 went from 61–81 to 128–172 ms. What the thread
  spends is not per commit.

Left: Chrome's style update costs 2–4 ms a frame with ten or so elements
to recalculate (`Document::updateStyle` well beyond its `recalcStyle`),
not explained by any group of the page's rules switched off live
(`:has()`, sibling combinators, `content-visibility`, containers,
counters, animations); and the process's other threads (raster,
compositor) at 15–25% while it draws 30 frames a second.

**Phase 7a.** Main ran `publishLayoutState` and `refreshWindowTitle` on
every projection and sent their results to all six pages each time: with
one GUI Agent streaming, 2.5–3.2 snapshots a second and, with each, a
workbench rectangle, a Sidebar rectangle and the window's name, unchanged
in all but the name and wanted by one page each. The workbench's
rectangle now goes to the window's own page and the Sidebar's to the
Sidebar, each only when it moved (compared as JSON), and the name to the
window's page only when it moved. A page that starts asks: `onWorkbenchArea`
and `onSidebarArea` hear the rectangle as it stands, asked of main
(`getWorkbenchArea`, `getSidebarArea`) as they start listening, then each
push (`onCurrent` in the preload; main answers in order with what it
pushes, so an answer is never older than a push before it). `getSnapshot`
no longer republishes the layout to every page as a way of reaching the
one that started. A snapshot that says what the last one said, its
revision aside, is not sent again.

Found on the way: a window resize was no projection, so the rectangles
were said only once the model next moved — the window's page drew its
states and the split's seam against the old size until then (with an
Agent streaming that was a third of a second; idle, indefinitely). They
are said on `resize` now.

Not done: sending the snapshot as a diff. It changes for real 2.5–3 times
a second here (the Agent's prompt-cache numbers and activity line), it is
6 KB, and a page holds it whole and lets React keep what did not change;
a patch protocol would be a second way for a page's model to be wrong
(the revision and replay rules over patches) to save main well under 0.5%
of its thread.

### After phase 6e

**v long** as in 6c (a GUI Agent on screen, the stand-in at a 40 000-line
burst then 300 lines/s, 16 subagents at a time), at 20 s and 60 s: the
Conversations renderer's process CPU and its main thread's over 8 s, then
over 6 s each conversation event's arrival in the page to the animation
frame after the commit that drew it (the oldest event of each commit), then
20 composer keys. Two runs of each; "before" is `65138812` with the same
probes (`perfProbe`). The machine was shared with another session's
DevHub throughout, which is the spread between runs.

| since start | process CPU      | main thread         | text event→paint p50 / p90 / p99 (ms)                     | commits/s       | composer key→paint p50 / p90 / p99 (ms)                 |
| ----------- | ---------------- | ------------------- | --------------------------------------------------------- | --------------- | ------------------------------------------------------- |
| 20 s        | 91, 91 → 79, 65  | 80, 66 → **52, 54** | 27 / 92 / 123, 27 / 50 / 77 → 26 / 39 / 73, 26 / 48 / 75  | 25, 30 → 32, 33 | 14 / 52 / 96, 9 / 36 / 53 → 12 / 23 / 50, 18 / 30 / 57  |
| 60 s        | 110, 95 → 86, 77 | 81, 73 → **54, 62** | 26 / 86 / 123, 27 / 70 / 112 → 26 / 44 / 78, 26 / 54 / 97 | 24, 26 → 33, 31 | 12 / 51 / 54, 17 / 70 / 79 → 14 / 41 / 45, 13 / 55 / 55 |

- The renderer's main thread: **66–81% → 52–62%**, while it draws more
  often (24–30 → 31–33 commits a second) — the frames are cheaper and
  there are more of them, which is where some of the process's CPU went
  back (raster and compositor).
- Text appears no later at p50 (26 ms) and sooner at the tail: p90
  50–92 → 39–54 ms, p99 77–123 → 73–97 ms.
- The composer's keys are where they were, a little better at the tail.

**Main's pushes** with one GUI Agent streaming on screen, each page's
messages from main over 10 s, twice:

| page              | before (per second)                                                    | after (per second)              |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------- |
| each of six       | 10.0–12.8: snapshot, workbench area, Sidebar area, title, 2.5–3.2 each | 2.4–3.0: the snapshot           |
| the window's page | the same                                                               | 3.3–4.8: and the title, 0.9–1.8 |

- Messages to the pages: **60–77 → 15–19 a second**; the bytes are the
  snapshot's and stayed (15–20 KiB/s a page).
- The title moves for real here (it names the Agent's activity).
- Main's JavaScript: 2.4–2.7% → 3.6% busy over those windows, which is
  noise between them (`drain` 1.1–1.2% → 1.3–1.5%); what the change took
  off it is about 0.2% (the area and title sends).
- Checked live: every page reloaded (the window's, the Sidebar, Agents,
  Conversations, the picker, a Neovim page, toasts, the tooltip) draws
  what it drew before — the window's page its workbench rectangle, the
  Sidebar a row's tooltip — the same as before the change (the Agents
  page's terminals and a Neovim page's grids come back when shown, on
  both builds); a resize with nothing else happening moves the window's
  page's rectangle, and a reload after it gets the new one.

### After phase 6d

**b hidden**: four terminal Agents streaming (b terms), none of them on
screen, the typing Agent shown; process CPU over two 10 s windows, then 40
keys typed into the shown Agent. Two runs each; "before" is phase 6c.

| run | Agents renderer   | pty host          | tmux server     | terminal key→paint p50 / p99 (ms) |
| --- | ----------------- | ----------------- | --------------- | --------------------------------- |
| 1   | 13, 13 → **0, 0** | 17, 17 → **0, 0** | 84, 83 → 76, 82 | 21.7 / 55.1 → 22.1 / 68.7         |
| 2   | 13, 14 → **0, 1** | 16, 17 → **0, 0** | 83, 70 → 87, 85 | 28.9 / 51.8 → 18.4 / 40.3         |

- What hidden terminals cost DevHub went to nothing: the Agents renderer
  **13–14% → 0–1%**, the pty host **16–17% → 0%**.
- tmux is the same, and so is what bounds the shown terminal's keys
  (finding 5): the four streams' panes are parsed by tmux whoever reads
  them.
- Checked live: the four hidden streamers have no clients
  (`list-clients`); one shown mid-stream is drawn at once without
  "Connecting…", and Ctrl+C and a command typed into it reach it.

### After phase 6c

**v long**: a GUI Agent on screen, on the stand-in CLI (a 40 000-line
burst, then 300 lines/s with 16 subagents running at a time), measured 20 s
and 60 s after it started: the Conversations renderer's process CPU over
8 s, then 20 keys typed into its composer 120 ms apart, each timed from the
dispatch to the animation frame after its `input` event, and the share of
that time in long tasks. Same machine, two runs of each; "before" is
origin/main (`8d9cd20e`).

| since start | entries drawn | Conversations renderer | composer key→paint p50 / p90 / p99 (ms)                             | long tasks             |
| ----------- | ------------- | ---------------------- | ------------------------------------------------------------------- | ---------------------- |
| 20 s        | 3 200–3 370   | 121, 122 → 79, 95      | 156 / 221 / 238, 153 / 194 / 284 → **12 / 60 / 61, 12 / 52 / 54**   | 78, 77 → **1.6, 3.4**  |
| 60 s        | 3 920–4 130   | 125, 117 → 93, 98      | 188 / 220 / 476, 192 / 259 / 261 → **10 / 28 / 56, 16 / 105 / 123** | 81, 83 → **6.7, 10.4** |

- The composer's keys: **150–190 ms → 10–16 ms** at p50, p99 from
  240–480 ms to 55–125 ms.
- The renderer is still busy (80–98%): it draws every frame the
  conversation changes, 6.5 frames a second before and 15.5 with the
  chunks and the stores (from a trace), and what a frame costs no longer
  grows with the transcript. The keys go between frames.
- In between, the chunks alone (no stores, entries still each
  `content-visibility`) left the keys where they were, 137–206 ms: the
  frames' style and layout went (the forced layout of following the end
  from 18% of the thread to 7%), but React's redrawing of every tool call
  and Blink's observer took the time they left.
- Checked live on 2 700–4 000 entries: the spacing at all 64 chunk edges is
  the spacing inside a chunk; find counts every match (266 of 266, as the
  text holds) and brings the current one on screen; a selection from the
  last entry of one chunk into the next copies both; scrolled up while it
  streamed, the entry under the top edge stayed where it was while
  12 000 px arrived below, and Latest follows again.

### After phase 6

Same machine and workload, two runs of each on the same day. "before" is
origin/main before phase 6 (`0b30a5a7`), "6a" with the hidden terminals,
"6b" with the split as well. c's two GUI Agents (a 40 000-line burst,
then 300 lines/s) are hidden throughout; f is b + c + the git churn.
"Agents" and "Conversations" are those renderers' process CPU.

| scenario | Agents renderer          | Conversations renderer | terminal key→paint p50 / p99 (ms)                        | tmux server |
| -------- | ------------------------ | ---------------------- | -------------------------------------------------------- | ----------- |
| b terms  | 56, 40 → 15, 15 → 15, 17 | —                      | 28 / 145, 30 / 128 → 27 / 75, 22 / 64 → 23 / 41, 33 / 74 | 66–90       |
| c steady | 44, 24 → 29, 26 → <5, <5 | 30, 27                 | 15 / 104, 10 / 44 → 9 / 29, 9 / 36 → 8 / 27, 10 / 24     | <5          |
| f all    | 46, 49 → 33, 29 → 15, 15 | (not in the top 8)     | 56 / 168, 28 / 103 → 28 / 82, 24 / 90 → 22 / 46, 25 / 48 | 62–84       |

**v**: a GUI Agent on screen streaming, then ten times: show it for 2 s,
switch to a terminal Agent (`devhub --tell focus`) and type a key at once,
timed from the switch and from the key to the echo's paint. Before is
origin/main and 6a alike (6a does not touch it), after is 6b.

| GUI Agent streaming       | renderer(s) while it is on screen           | switch → echo p50 (max)                                | key → echo p50 (max) |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------ | -------------------- |
| 40 000 burst, 300 lines/s | Agents 121% → Agents 0%, Conversations 116% | none within 10 s (10 of 10) → **157 ms (240)**         | → **28 ms (48)**     |
| 6 000 lines/s             | Agents 101% → Agents 0%, Conversations 119% | 9 of 10 not within 10 s, one 13.3 s → **195 ms (323)** | → **40 ms (81)**     |

(Switching between two terminal Agents is 89 ms switch → echo, 23 ms key
→ echo: most of a switch is the `devhub` command's round trip.)

- Typing into a terminal Agent with four hidden Agents streaming: p99
  **128–145 → 41–74 ms**; the Agents renderer **40–56% → 15%**. The p50
  stays at 22–33 ms: what bounds it is the tmux server at 66–90% and four
  cores saturated by the streams, as in phase 5 (finding 5).
- Hidden GUI Agents' folds moved with them: 24–44% of the Agents renderer
  → the Conversations renderer's 27–30%, the terminal Agents' at <5%.
- A conversation on screen no longer delays the terminal Agents at all:
  switching from one streaming and typing went from more than 10 s to
  under 200 ms.

### After phase 5d

**r stream**: two GUI Claude Agents on an SSH host (`ssh:bsh`: OpenSSH
9.6 on 127.0.0.1, its own user and home, the stand-in CLI of c replay
there), each started at once with a 40 000-line burst and then 3 000
lines/s (about 1 MB/s of journal each), the Agents page not showing them.
"burst" is the 20 s from their start, "steady" the 20 s after. "before" is
origin/main with the SSH fix only (`273547ea`), "after" phase 5d, "in
main" phase 5d with `DEVHUB_BYTESTREAMS_IN_MAIN=1`. Main's process CPU is
all its threads.

| scenario | main thread CPU                       | main JS busy                         | main process CPU     | lag p99 / max (ms)                         | conversation engine | process host    |
| -------- | ------------------------------------- | ------------------------------------ | -------------------- | ------------------------------------------ | ------------------- | --------------- |
| r idle   | 7%, 7% → 10%, 8% (in main 7%)         | 0.3%, 0.3% → 0.4%, 0.3% (0.3%)       | 19, 20 → 24, 19 (19) | 1.4 / 24, 1 / 27 → 2.1 / 56, 3.3 / 29      | —                   | <5%             |
| r burst  | 21%, 21% → **16%, 15%** (in main 19%) | 10.2%, 10.7% → **6.8%, 6.1%** (9.0%) | 35, 35 → 31, 27 (34) | 3.8 / 28, 4.5 / 39 → 6.9 / 182, 4.3 / 41   | 48–52% → 21–27%     | 18–19% → 21–25% |
| r steady | 18%, 21% → **15%, 15%** (in main 18%) | 8.4%, 9.6% → **6.1%, 6.1%** (7.3%)   | 30, 35 → 29, 29 (32) | 3.8 / 122, 4.2 / 127 → 4.1 / 179, 4.4 / 56 | 33–43% → 23–27%     | 17–20% → 22–26% |

- Main's JavaScript with two remote Agents streaming: **8.4–10.7% → 6.1–6.8%**
  busy, its thread **18–21% → 15–16%**. `#follow`, `HostLink.lines`, the
  stream's `readable` and most of `postMessage` (2.7% → 1.1%) are gone
  from its profile. What is left is the remote machine's commands, which
  main still composes and schedules — the rounds' `tmux` over `ssh`, the
  writes — `ssh.js` and `command.js` at about 2% each, and Chromium's
  UI thread itself (idle is 7–10%).
- The conversation engine got cheaper too, **33–52% → 21–27%**: it takes
  bytes off a port where it took arrays of line objects structured-cloned
  through main.
- In main (`DEVHUB_BYTESTREAMS_IN_MAIN=1`) sits between: main reads the
  pipes and posts the chunks, the engine still splits them.
- Killed with `kill -9` while both streamed: the streams were on a new
  process host within a second (the conversations' next round) and the
  transcripts went on growing; after the third kill in a minute the `ssh -T`
  streams were main's children and went on the same way. Killing the
  conversation engine instead: main cancelled its streams, and the new
  engine opened new ones as it replayed. With the conversations in main
  (`DEVHUB_CONVERSATIONS_IN_MAIN=1`) the streams ran in the process host
  with their bytes coming back to main, and came back the same way after a
  kill.

### After phase 5c

**n scroll**: Scratch's Neovim (0.12.6, no config, a 260 000-line
TypeScript file, the page 1192×840: ~150×48 cells) scrolled as fast as a
held key: a second RPC client on its socket runs `<C-f>`, sets the title to
the wall clock in ms and `redraw`s, as a notification, 60 or 120 times a
second for 20 s. The page times each stamped redraw from that stamp to the
animation frame after it applied it (**redraw→paint**: Neovim → socket →
decode → IPC or port → page → frame). "before" is origin/main
(`34105717`), "after" phase 5c, "in main" phase 5c with
`DEVHUB_NEOVIM_IN_MAIN=1`. Same machine, same day.

| scenario | main thread CPU                     | main JS busy                          | Neovim host | redraw→paint p50 / p99 (ms)                                   | page renderer   |
| -------- | ----------------------------------- | ------------------------------------- | ----------- | ------------------------------------------------------------- | --------------- |
| n 60/s   | 23%, 23% → **7%, 8%** (in main 23%) | 14.2%, 14.8% → **0.2%, 0.2%** (14.5%) | 18%         | 12.8 / 21.9, 13.3 / 22.3 → 11.8 / 20.7, 11.9 / 21 (12.3 / 23) | 62–64% → 55–60% |
| n 120/s  | 33% → **7–9%** (in main 35%)        | 26.3% → **0.2%** (27.7%)              | 32–40%      | 14.6 / 30 → 14.6 / 32.9, 14.3 / 26.1, 18 / 51.6 (15.2 / 35.7) | 67% → 65–84%    |

- Main's JavaScript while a Neovim scrolls: **14–26% → 0.2%** busy;
  `decodeUTF8`, `msgpack.js`, `neovimRpc.js` and `_send` are gone from its
  profile. Main's thread 23–33% → 7–9%, which is what it is idle.
- The host itself is 18% of a core at 60 redraws a second and 32–40% at 120.
- Redraw→paint is the same: 12 ms p50, 21–23 ms p99 at 60/s. At 120/s one
  of three runs was slower (18 / 52 ms; Neovim and the page were busier in
  it too, and it got 2 310 of 2 400 redraws sent); the other two matched
  before. What bounds it is the page (55–84% of a core drawing) and Neovim
  itself (30–70%), not the relay.

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
   it emits and rebuilds `working` from every server).
5. **Done** (phases 5b, 5c and 5d above). Left of it: a remote Agent's
   writes (an `ssh` command each, scheduled by main), the dev-container
   relay, and the other `child_process` callers in main (the GitHub CLI,
   usage readers, the login shell probe), which could go through
   `cleanSpawn` and the process host too.
6. **Done** (phases 6a–6e above). Left of it: a window of entries for a
   transcript too long to keep in memory (not what the keys wait for any
   more, and what it would cost find, selection and anchoring is in 6c);
   the Conversations renderer's main thread at 52–62% while a fast
   stand-in streams on screen, a good part of it Chrome's style update
   with almost nothing to recalculate (6e).
7. **Background services**: the agent and activity rounds' scheduling,
   repository status, usage readers, Task Manager sampling, the
   Orchestrator's invariant and GitHub polling, and `state.json`'s
   serialisation, moved together because they share the model's facts.
   **Measured after phase 6d and not moved**: with a, b, c and f run again
   (profiles of main, 250 µs), main's thread is at its idle 8–11% in every
   scenario and its JavaScript 0.8% busy idle, 2.3% in c steady and 2.6% in
   f all. Of that, the agent round's `reconcile` and what it sets off —
   projecting the snapshot and sending it to the pages
   (`projectionChanged`, `send`), the layout (`publishLayoutState`), the
   save (`persist`, `saveStateLocked`) — is 1.3–1.4%; the tmux rounds
   0.2%; git, GitHub, usage and the Orchestrator do not reach 0.1% each. A
   host of their own would move about 1.5% of a thread that is not what
   anything waits for, with the Orchestrator's delivery, `needs_action`,
   its invariants and the `devhub --tell` answers to keep identical across
   a process boundary. Not worth that until a measured load says
   otherwise.

   Found on the way, and done as phase 7a: main sent every page a
   workbench rectangle, a Sidebar rectangle and the window's name with
   every snapshot, unchanged and unread by all but one page each.

8. **Chords in the pages' preloads** (capture-phase `keydown`) instead of
   `before-input-event`, with main's handler kept for VS Code's workbench
   views only. Measured impact is the smallest of all: a key reaches the
   renderer through main's UI thread regardless (Chromium's input routing),
   so this saves one JS call per key, not the wait. It would also have to
   keep the chord semantics that rely on seeing the key before any page
   does — one queue across views, the prefix swallowed before an editor
   sees it — and the input-source switch, which the page cannot do. Last.
