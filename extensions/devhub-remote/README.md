# DevHub Remote

DevHub's own `ssh-remote` authority resolver. It is built in rather than
installed because a remote window cannot open without it, and a person must not
be able to uninstall the thing their window is waiting on;
`scripts/stage-builtin-extensions.sh` stages it alongside VS Code's own
built-ins.

It does one thing. VS Code opens a `vscode-remote://ssh-remote+<host>/…` window
by asking whichever extension registered that authority where the remote
extension host is, and this extension answers by asking the running DevHub:

```
{"kind":"resolve-remote","machine":"ssh:<host>","attempt":<n>}
```

one line out over DevHub's control socket, one line back, and the connection
closes — the same framing `devhub-bridge` uses for `devhub.installCli`. A
successful answer carries a port and a connection token, and becomes a
`ResolvedAuthority` on `127.0.0.1`; VS Code's connection to the remote goes
through whatever DevHub has already put on that port. When the answer carries
an `extensionHostEnv` — that is where `SSH_AUTH_SOCK` arrives, for a host with
an agent forwarded — it is carried through unchanged.

A failure comes back as a sentence and a flag, and the flag picks the error VS
Code understands: `TemporarilyNotAvailable` when the failure is transient (the
host is asleep, the network is not there, DevHub itself is still starting),
which both of VS Code's retry loops will come back from, and `NotAvailable`
otherwise (an unknown host, an unsupported platform, no remote server published
for that architecture), which VS Code gives up on at once. The sentence is
always the one DevHub sent; the extension adds no vocabulary of its own,
because a person must not be told two different stories about one failure.

`extensionKind` is `ui` — the opposite of `devhub-bridge`'s `workspace` — because
the control socket is on the machine DevHub is running on. The socket path is
derived from the extension's global-storage path, so a scratch DevHub and a real
one can never be confused, and no environment variable has to survive into the
extension host.

## What is deliberately not here

The extension this replaces — a vendored `jeanp413.open-remote-ssh`, removed in
the same change that added this one — carried an SSH
client, an ssh configuration reader, a remote-server installer, a port-forwarding
tree view and a page of settings. DevHub owns every one of those already: one
connection model, one place a host is named, one place a server is published. A
second copy of any of them would be a second answer to a question that has one,
and the two would eventually disagree. `scripts/check.mjs` fails if any of it
reappears here.

## The proposed API

`workspace.registerRemoteAuthorityResolver` is a proposed API, so the manifest
names `resolvers` in `enabledApiProposals` and `scripts/product_metadata.py`
grants it to this extension. Its type declarations are not in `@types/vscode`
either — `tsconfig.json` includes
`vscode/src/vscode-dts/vscode.proposed.resolvers.d.ts` from the submodule, which
means the typecheck needs a provisioned `vscode/` (`scripts/provision-vscode.sh`)
and reads the declarations the workbench it runs in was built from, rather than a
copy that can drift.

## Checks

```sh
pnpm --filter devhub-remote check
```

builds the extension, typechecks it, runs the tests, runs the static checks
above, packages the VSIX and verifies the VSIX is byte-for-byte reproducible.
