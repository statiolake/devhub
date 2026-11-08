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

| Process                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **main** (Electron's browser process, VS Code's main in it) | the window, its child views, menus, focus (`shell/`); the chord layer, a `before-input-event` handler on every web contents (`shell/keyboard.ts`); the terminal service: one node-pty tmux client per attached terminal surface, output coalesced and sent as frames, every input, resize and ack an `invoke` (`terminal/service.ts`, `attachments.ts`); tmux control and polling: the agent round and the terminal activity round (`terminal/tmux.ts`, `shell/agentWiring.ts`); every Neovim's msgpack-RPC socket, its redraws decoded and relayed (`editor/neovimRpc.ts`, `neovimUi.ts`, `neovimEditors.ts`); every GUI Agent's conversation — the journal followed with `tail`, the protocol adapter, the fold, the events to the page (`agent/conversation/`, `shell/conversationIpc.ts`); `state.json` (`shell/saveCoalescer.ts`); the Orchestrator (invariant, events, timers, GitHub polling); repository status (git), usage readers, Task Manager sampling, the `devhub` CLI's control socket, voice |
| **process host** (utility process, new)                     | starts every bounded command main runs — tmux, git, ssh, the GUI Agents' host scripts — and reports how each ended (`main/processHost/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| DevHub's pages (one renderer each)                          | the window's own page, the Sidebar, **the Agents page (every Agent's pane: terminal Agents' xterms and GUI Agents' conversations, all in one renderer)**, an Agent's terminal pane, one Neovim page per Workspace, notices, questions, tooltip; Settings and Task Manager windows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| VS Code                                                     | a renderer per workbench, its extension host, file watcher, shared process, pty host, language servers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| outside Electron                                            | DevHub's tmux server (every terminal and every Agent's session), the GUI Agents' hosts and CLIs, Neovim (`nvim --headless --listen`, kept by tmux)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### The data paths

- **A key.** The OS delivers it to the browser process's UI thread — main's
  thread, which is also Node's — where `before-input-event` runs DevHub's
  chord router synchronously, and only then is it forwarded to the renderer.
  A key waits for main whatever surface it is for. Note that this is true of
  Chromium's input routing itself, not only of DevHub's handler: removing
  the handler saves a JS call per key, not the hop.
- **A key in a terminal.** page → `invoke(terminal:input)` → main → the tmux
  client's pty → tmux → the program; its echo: tmux → the client's pty →
  main reads, coalesces 5 ms → `send(frame)` → page → xterm, and the page
  acks each frame with another `invoke`. Main is on the path three times.
- **Neovim.** page → `send(neovim:call)` → main → socket → nvim; a redraw:
  nvim → socket → main decodes msgpack in JS → `send(neovim:redraw)`
  (structured clone) → page.
- **A GUI Agent.** CLI → `out` (the journal) → `tail` → main reads lines →
  adapter (JSON decode, protocol) → fold (`applyEvent`, twice: the adapter's
  copy and the conversation's) → events → the Agents page → folded a third
  time there → React. DevHub's replies and the person's words: main →
  `sh` host script (a spawn per write) → the FIFO.
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
   Worth a look for main's other sockets (the control socket).

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
- **Agent engine** (utility process): `AgentConversation`, the adapters, the
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

4. **The agent engine in a utility process** (findings 3–4; the largest
   item left on main under GUI Agents: 25–40% of main's time during a
   replay is the adapter, the fold and their sends). The seam is
   `AgentConversation` itself: its host (`ConversationHost`) is already an
   async interface, and `ConversationRegistry` is the one place main makes
   them. Main keeps a proxy with the same methods; the synchronous readers
   (`reading()` in the agent round, `session`, `mcp.servers` for sign-in)
   read facts the engine pushes when they change, and the readers of
   entries (`agent read`, the attach snapshot, rewind targets) become
   requests. The Agents page attaches to the engine over a `MessagePort`
   main hands it, so a transcript never passes main. The journal's `tail`
   and the host writes run in the engine for a local Agent and through main's
   runtime for SSH and containers until phase 5 gives those a home too.
   Separately, `applyEvent` should stop copying and scanning the whole
   entries array per event (an id→index map kept beside it); that helps the
   engine and the page alike.
5. **The pty host** (findings 2 and 5). node-pty's tmux clients, the frames,
   acks and input, with a `MessagePort` per page; the tmux control commands
   and their rounds; the Neovim sockets and msgpack decoding, keeping the
   page's `neovim.*` bridge as it is (the GUI APIs being built on it are not
   touched). Starting the tmux server and its clients outside main also keeps
   main's descriptors out of them (finding 9).
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
