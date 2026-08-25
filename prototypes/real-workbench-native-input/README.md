# THROWAWAY: real Workbench native input gate

This directory is the F0.2/F0.3 cross-gate harness. It is a throwaway
feasibility artifact, not production code. It answers a narrow question: can
one authenticated, pinned OpenVSCode 1.109.5 folder Workbench run as a real
child WKWebView while the host preserves native key/IME routing?

The honest boundary is important: the real Workbench child, Workbench UI,
public extension state, exact double-Command-Q routing, and Japanese IME are
proven. The native Command-P/Shift-P/S/Z/C/V posts are proven to reach the
host monitor; edit-result/clipboard assertions for C/V/Z are **NOT PROVEN** in
this environment. No result below treats a post log as an editor mutation.

## Inputs and boundary

- OpenVSCode source is unchanged and outside this directory at
  `/private/tmp/openvscode-darwin-arm64-feasibility/source`.
- The authenticated server artifact is
  `/private/tmp/openvscode-darwin-arm64-feasibility/vscode-reh-web-darwin-arm64`.
  The runner uses tag `openvscode-server-v1.109.5`, commit
  `4ffe2270acdf711bbefecc3e8c79f4b3631640e5`, and a generated token file with
  mode `600` under a throwaway `/private/tmp` runtime root.
- The child URL is loopback-authenticated and opens exactly one folder
  workspace. The child is created with one stable data-store identifier and a
  shared WebKit data root; background throttling is disabled.
- `[patch.crates-io]` selects the already-audited WRY 0.55.1 host patch from
  `../native-key-router/vendor`. The patch changes only child
  `performKeyEquivalent`: exact Command-Q returns `NO`; other Command keys
  delegate to WKWebView. This harness does not edit that vendor tree.
- The extension uses only public `vscode.workspace`, `vscode.window`, and
  `vscode.commands` APIs. It opens the fixture, focuses the editor through
  `workbench.action.focusActiveEditorGroup`, reports document text/dirty/save
  state over an authenticated loopback Bridge, and registers one public Q
  command. The bridge never evaluates Workbench JavaScript and never inspects
  a DOM.
- Native automation is finite `CGEventPostToPid`; the first exact unmodified
  Command-Q is consumed and armed for 1,000 ms, while the second constructs
  one AppKit `NSEvent` for the child. Ordinary events are returned unchanged.
  IME source selection/restoration runs on the TIS main-thread handoff and
  roman keys are posted natively.

There is no `eval`, `dispatchEvent`, `KeyboardEvent`, injected page observer,
OpenVSCode source change, or production integration in this directory.

## Run

Run on the visible logged-in reference Mac with the pinned artifact present:

```sh
cd ~/path/to/devhub/prototypes/real-workbench-native-input

cargo fmt -- --check
cargo check --offline
cargo test --offline
scripts/native-workbench-smoke.sh normal
scripts/native-workbench-smoke.sh ime
```

The smoke runner builds the public-API VSIX, installs it into an isolated
server extension directory, starts the authenticated loopback server, warms
one Workbench, starts the real child host, captures Workbench UI checkpoints,
then stops the host/server/bridge. It has finite waits and kills detached
process groups on timeout. The final `lsof -nP -iTCP:<port> -sTCP:LISTEN`
check must report `listener_zero=true`.

The generated logs and screenshots under `evidence/native-workbench-*` are
ignored because ports, timestamps, and runtime paths are ephemeral. Keep a
sanitized retained run only when a ledger needs it; never retain a connection
token.

## Evidence interpretation

The normal screenshots show the actual Workbench Quick Open and Command
Palette overlays, Explorer, Monaco fixture, and Workbench chrome. The Bridge
NDJSON is produced by the extension's public API calls, not by the host
reading page state. The Q assertion requires all three of:

1. first Q logged `workbench_received=false` and was consumed;
2. exactly one native AppKit forward logged `synthetic_js=false`;
3. exactly one public `devhub.realNativeInput.q` command result arrived.

The IME assertion requires public document text `にほんご`, a dirty state while
composition is being committed, a final public save with `dirty=false`, a
TIS main-thread selection log, and `restored_match=true` for the original
input source. A transient macOS IMK mach-port warning is environmental and
does not replace the public document/source evidence.

See [RESULTS.md](RESULTS.md) for the run matrix and explicit unresolved
items. `evidence/contract-tests.txt` records the static negative-boundary
checks.
