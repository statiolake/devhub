# Debugging an extension in DevHub, and the one crash that is not ours

Pressing F5 in an extension repository opens an **Extension Development Host**:
a separate VS Code window with its own extension host, opened and closed by the
debug session. It is not a DevHub Workspace and never gets a Sidebar row — see
the comment at the top of `apps/desktop/src/main/services/devhubWindowsMainService.ts`
for why, and `browserWindowShim.ts` for the one place that decides which of the
two kinds of window is being built.

This file is about the thing that looks like DevHub's fault and is not.

## `crashed with code 6` when a debug session restarts

Stopping a debug session, or starting a second one while the first dev-host
window is still open, can put this in the log:

```
Extension host with pid <n> exited with code: 6, signal: unknown.
[UtilityProcess id: <n>, type: extensionHost, pid: <n>]: crashed with code 6 and reason 'crashed'
```

It is an abort inside Electron's bundled Node, not a window DevHub mishandled.
With `--enable-logging` the assertion is in the log above the exit:

```
node::inspector::Agent::ToggleNetworkTracking(Isolate *, Local<Function>)
  at ../../third_party/electron_node/src/inspector_agent.cc:1023
Assertion failed: "Unreachable code reached" ": " "Cannot toggle network tracking, please report this."
Received signal 6
```

Read the native frames from the bottom of that stack up and the whole of it is
Node's own inspector:

```
NetworkAgent::enable  →  NetworkInspector::Enable  →  Agent::EnableNetworkTracking
  →  Agent::ToggleNetworkTracking  →  node::Assert  →  abort(3)  →  exit code 6
```

`js-debug` attaches to the dev host's extension-host utility process and turns
on the CDP `Network` domain; Node's inspector agent reaches a branch it calls
unreachable and aborts. The JavaScript stack alongside it is the *bootstrap* of
the process being attached to — `node:internal/streams/*`, `requireBuiltin`,
`runEmbedderPreload`, `prepareMainThreadExecution` — so this happens while the
new extension host is starting under the debugger, not while anything is being
torn down.

Nothing in that stack is DevHub's, and no window is involved. The message
"please report this" is Node's own, addressed to Node.

### Why it is worth writing down

Because the same window, in the same build, produces three different endings
depending only on what the *debugger* did, and two of them are healthy:

| what happened | extension host exit | log |
| --- | --- | --- |
| debug session stopped | 15, reason `killed` | `crashed with code 15 and reason 'killed'` |
| dev-host window closed (Command-W) during a session | 0 | nothing |
| second session started on a dev host already open | 6, reason `crashed` | the assertion above |

DevHub's window handling is identical in all three. "Crashed" in the first row
is upstream's wording for a deliberate `SIGTERM`, and is not a fault either.

If you are chasing a real DevHub bug in this area, the tell is a *window*
symptom — a dev host that never appears, one that outlives its session, a
workbench that is routed into instead of the dev host — not an exit code from
the utility process.
