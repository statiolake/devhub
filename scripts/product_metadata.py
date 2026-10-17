#!/usr/bin/env python3
"""What DevHub says it is: `product.json`, and the build it was made from.

VS Code reads everything it knows about its own product out of `product.json` —
its name, its data folders, its gallery, and which build it is. DevHub states
the first three in `apps/desktop/product-overrides.json`, a static file, and the
rest here: the commits the trees are on when the metadata is written, the
version `apps/desktop/package.json` states at the same moment, and the table of
which extensions may use which proposed APIs — that last one is static, but it
is the one piece of DevHub's identity that needs its reasoning written beside
it, and JSON has nowhere to put it.

Three callers, one rule between them:

    scripts/package-nightly.py    merges `packaged_metadata()` over
                                  vscode/product.json to write the packaged
                                  app's product.json
    apps/desktop/scripts/dev.sh   runs this module as a command to write
                                  vscode/product.overrides.json, which
                                  bootstrap-meta.ts merges at runtime when
                                  VSCODE_DEV is set
    scripts/darwin_bundle.py      takes the names out of it to brand the macOS
                                  bundle

`commit` is not DevHub's commit, and a source run must not have one at all.
VS Code does not treat that field as documentation: it is how the workbench
decides which of the two layouts it is running in. `src/vs/amdX.ts` computes
`isBuilt = Boolean(product.commit)` and resolves every AMD dependency out of
`node_modules.asar` when it is set — and a source tree has no such archive, so
syntax highlighting and the terminal disappear with `ERR_FILE_NOT_FOUND` the
moment a source run states one. `agentHost/node/appNodeModules.ts` reads it the
same way. So the field means "this is a packaged build", and only
`packaged_metadata()` sets it, to the commit of the VS Code the build was made
from — which is what upstream's own builds put there.

Which DevHub a build is, is a different question, and it gets its own field:
`hostCommit`, beside `hostVersion`. DevHub's tree is what answers it — the
submodule pointer is a tracked file in it, so a submodule bump is a DevHub
commit too, and one hash identifies both halves where the submodule's would
identify neither DevHub's own code nor its patches. Both are set on every
build, packaged or source, because both are true of a source run as well.

Kept to lowercase hex — no `-dirty` suffix, no tag. VS Code slices `commit`
for cache keys and folder names, and About prints `hostCommit` beside it, so a
run reports the commits it is on and says nothing about uncommitted changes.
That is what `version` and the date are for.

Which remote extension host a build connects to is a third question, and it
gets two more fields, stated on every build: `serverCommit`, the VS Code
commit, and `serverIdentity`, `reh_identity()` — a hash of that commit,
DevHub's patches, the build scripts and the static metadata the server carries.A packaged build's `commit` says the first again, but a
source run has no `commit` and still opens remote windows — SSH hosts and dev
containers — so it needs another place to say it. Together they name the
directory the server is installed under on the far machine,
`~/.devhub-server/bin/<serverCommit>-<serverIdentity>`, and they are what
DevHub checks the servers it carries against (scripts/build_reh.py writes the
same two beside each one). The server only compares a client's commit with its
own when the client states one, so a source run's workbench is accepted by a
server built from its checkout. Only DevHub's main process reads either field;
to VS Code they are unknown keys.

    scripts/product_metadata.py <destination.json>
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DESKTOP_DIR = REPO_ROOT / "apps" / "desktop"

PRODUCT_OVERRIDES_FILE = DESKTOP_DIR / "product-overrides.json"
PRODUCT_OVERRIDES = json.loads(PRODUCT_OVERRIDES_FILE.read_text())

VSCODE_DIR = REPO_ROOT / "vscode"

# Which extensions may use which unfinished APIs.
#
# A proposal is off unless product.json names the extension against it, and an
# extension that asks for one it was not granted does not fail visibly: the
# extension host logs "CANNOT use API proposal: <name>." and the feature that
# needed it is simply absent. So this table is the whole of what makes an
# extension work, and a missing entry looks like a broken extension.
#
# Upstream keeps the same table in the product.json of its *official builds* —
# which is not the one in the vscode repository, so it cannot be read from
# `https://raw.githubusercontent.com/microsoft/vscode/<tag>/product.json`. The
# two places it can be read from are VSCodium's `product.json` and, the one
# used here, the `enabledApiProposals` array in the installed extension's own
# `package.json`. That array is the extension's statement of what it needs, so
# it is the authority.
#
# To update after bumping an extension: read `enabledApiProposals` out of the
# new version's `package.json` and reconcile it with the list below. Every name
# must exist in the pinned submodule as
# `vscode/src/vscode-dts/vscode.proposed.<name>.d.ts`, or the workbench warns
# at startup about an unknown proposal; `product_metadata_test.py` fails on
# names that do not. A proposal the submodule dropped is not substitutable —
# leave it out and expect that part of the extension to stay dark until the
# submodule catches up.
EXTENSION_ENABLED_API_PROPOSALS: dict[str, list[str]] = {
	"vscode.mermaid-markdown-features": ["chatOutputRenderer", "chatParticipantPrivate"],
	# GitHub Pull Requests, Open VSX 0.162.0.
	"GitHub.vscode-pull-request-github": [
		"activeComment",
		"chatContextProvider",
		"chatParticipantAdditions",
		"chatParticipantPrivate",
		"chatSessionsProvider",
		"codeActionRanges",
		"codiconDecoration",
		"commentReactor",
		"commentReveal",
		"commentThreadApplicability",
		"commentingRangeHint",
		"commentsDraftState",
		"contribAccessibilityHelpContent",
		"contribCommentEditorActionsMenu",
		"contribCommentPeekContext",
		"contribCommentThreadAdditionalMenu",
		"contribCommentsViewThreadMenus",
		"contribEditorContentMenu",
		"contribShareMenu",
		"diffCommand",
		"languageModelToolResultAudience",
		"markdownAlertSyntax",
		"quickDiffProvider",
		"remoteCodingAgents",
		"shareProvider",
		"tabInputMultiDiff",
		"tokenInformation",
		"treeItemMarkdownLabel",
		"treeViewMarkdownMessage",
	],
	# DevHub's own `ssh-remote` resolver, extensions/devhub-remote. `resolvers`
	# is what lets it answer `onResolveRemoteAuthority:ssh-remote` at all, so
	# without this entry an SSH Workspace opens a workbench that never
	# connects — the extension host only logs
	# `CANNOT use API proposal: resolvers.` and nothing resolves the authority.
	# There is no `contribViewsRemote` here: that was for the vendored
	# extension's `sshHosts` tree view, and DevHub's own Sidebar is the host
	# list.
	# `tunnels` and `portsAttributes` are its port forwarding: `openTunnel` for a
	# definition's `forwardPorts`, and its `portsAttributes` applied to the
	# ports VS Code forwards by itself (`src/ports.ts`).
	"devhub.devhub-remote": ["resolvers", "tunnels", "portsAttributes"],
	# DevHub's own Copilot, extensions/devhub-copilot: completions and Next Edit
	# Suggestions from the Copilot language server, no chat.
	# `inlineCompletionsAdditions` is what lets an InlineCompletionItem carry
	# `isInlineEdit` and `showInlineEditMenu`, and so be drawn by the editor's
	# own inline edit UI (gutter indicator, side-by-side, word replacement,
	# jump). Without the grant the extension host drops those fields without a
	# word (`extHostLanguageFeatures.ts`, `InlineCompletionAdapter`), every next
	# edit becomes ghost text, and ghost text that does not continue at the
	# cursor is never shown. Nothing else in the editor gates that UI: not the
	# extension id, not `isBuiltin`, not `chat.disableAIFeatures`.
	# `devhubStatusBarHover` is DevHub's own proposal
	# (patches/vscode/0009-devhub-status-bar-hover.patch): a status bar item's
	# rich hover, drawn by the workbench from the widgets of its Copilot
	# dashboard, which `chat.disableAIFeatures` hides. The extension's status
	# item uses it for its dashboard.
	"devhub.devhub-copilot": ["inlineCompletionsAdditions", "devhubStatusBarHover"],
}


def proposal_declaration_file(proposal: str) -> Path:
	"""Where the VS Code DevHub builds declares a proposed API, if it has it at all."""
	return VSCODE_DIR / "src" / "vscode-dts" / f"vscode.proposed.{proposal}.d.ts"


def proposal_is_declared(proposal: str, patches_dir: Path | None = None) -> bool:
	"""Whether the pinned VS Code, or one of DevHub's patches to it, declares a proposal.

	A checkout's submodule is the pinned commit until provisioning applies
	`patches/vscode/`, so a proposal a patch adds is found in the patch.
	"""
	if proposal_declaration_file(proposal).is_file():
		return True
	added = f"+++ b/src/vscode-dts/vscode.proposed.{proposal}.d.ts\n"
	patches = sorted((patches_dir or PATCHES_DIR).glob("*.patch"))
	return any(added in patch.read_text(encoding="utf-8") for patch in patches)


def devhub_commit() -> str:
	"""The DevHub commit this build is being made from.

	A checkout with no commits at all is the only way this fails, and it fails
	loudly: a build that cannot say which source it came from is not one worth
	shipping, and every consumer of the hash downstream would otherwise get a
	plausible-looking wrong answer.
	"""
	return head_of(REPO_ROOT)


def vscode_commit() -> str:
	"""The commit of the VS Code this build is being made from.

	This is what `commit` means to VS Code — upstream's own builds put the hash
	of the vscode repository there — and DevHub keeps that meaning rather than
	borrowing the field for its own identity. `hostCommit` answers the DevHub
	question instead.
	"""
	return head_of(REPO_ROOT / "vscode")


# What else, beyond the VS Code commit, DevHub's patches, the build scripts and
# the static product metadata (all hashed by `reh_identity` below), decides
# what is in a remote extension host DevHub builds. Bump it for a change to the
# server made outside those files, so far machines install the new one instead
# of keeping the server they have.
#
# The build scripts' bytes (`REH_BUILD_SCRIPTS`) are hashed rather than left to
# this number, so a fix to them is a new identity even when nobody remembers to
# bump it: a prebuilt server the nightly published (scripts/reh_release.py) is
# never reused after the script that made it changed. The cost is that an edit
# to a comment there is a new identity too, and far machines install a server
# that is the same as the one they had; that is the safe direction to be wrong.
#
# 2: the whole server is built in Linux containers, as upstream builds it,
# instead of gulp on the Mac with Linux natives swapped in afterwards.
REH_REVISION = 2

PATCHES_DIR = REPO_ROOT / "patches" / "vscode"

# The scripts that make the server: build_reh.py (the images, what it deletes
# and checks, how it packs) and the steps it runs in the tree.
REH_BUILD_SCRIPTS = (
	REPO_ROOT / "scripts" / "build_reh.py",
	REPO_ROOT / "scripts" / "reh_in_container.sh",
)


def reh_static_metadata() -> dict[str, object]:
	"""The part of the product metadata a server is built with that is the same
	on every run: the overrides and the API proposal table. The rest — the
	date, DevHub's commit and version, the identity itself — says which build it
	is and changes nothing the server does."""
	return {
		"overrides": PRODUCT_OVERRIDES,
		"extensionEnabledApiProposals": EXTENSION_ENABLED_API_PROPOSALS,
	}


def reh_identity(
	commit: str | None = None,
	patches_dir: Path = PATCHES_DIR,
	revision: int = REH_REVISION,
	build_scripts: tuple[Path, ...] = REH_BUILD_SCRIPTS,
	metadata: dict[str, object] | None = None,
) -> str:
	"""Which build of the remote extension host this checkout makes.

	Twelve hex characters of a hash over the VS Code commit, every patch in
	`patches/vscode/` (name and bytes), the static product metadata the
	server carries (`reh_static_metadata()`), the build scripts
	(`REH_BUILD_SCRIPTS`, name and bytes) and `REH_REVISION`. The far machine
	keeps its server under `bin/<commit>-<identity>`, and both the app
	(`serverIdentity`) and every server built for it (its statement) say this
	value — so DevHub can tell a server built from its own patches from one
	built before they moved, which the commit alone could not: a patch to the
	server does not move the submodule. It is computed from the inputs rather
	than from the built tarballs so that rebuilding the same inputs — every
	nightly — names the same directory, and machines are not handed a fresh
	copy of an identical server every day.
	"""
	digest = hashlib.sha256()
	digest.update(f"revision {revision}\n".encode())
	digest.update(f"commit {commit or vscode_commit()}\n".encode())
	for patch in sorted(patches_dir.glob("*.patch")):
		digest.update(f"patch {patch.name}\n".encode())
		digest.update(patch.read_bytes())
	stated = reh_static_metadata() if metadata is None else metadata
	digest.update(f"metadata {json.dumps(stated, sort_keys=True)}\n".encode())
	for script in build_scripts:
		digest.update(f"script {script.name}\n".encode())
		digest.update(script.read_bytes())
	return digest.hexdigest()[:12]


def nls_metadata_hash(nls_metadata_dir: Path, commit: str) -> str:
	"""`nlsMetadataHash` for the bundled VS Code tree in `nls_metadata_dir`.

	VS Code caches a language pack translated into the build's own message
	table under `<userData>/clp/<pack>/<nlsMetadataHash ?? commit>`
	(`src/vs/base/node/nls.ts`). The compiled code looks a message up by its
	*index* in `nls.messages.json`, and `nls.keys.json` says which key each
	index is for this build only. `commit` is the submodule's, the same for
	every DevHub build whose patches add, drop or move a `localize` call, so a
	table cached by an earlier build would be read against this build's
	indices and every message after the first difference would show its
	neighbour's translation. Upstream's packaging stamps this hash into
	product.json (`build/gulpfile.vscode.ts`, and `gulpfile.reh.ts` for the
	servers, which DevHub builds through it); DevHub writes the desktop
	product.json itself, so it stamps it here.

	The same bytes as upstream's `computeNLSMetadataHash`
	(`build/lib/nlsMetadata.ts`): sha256 of commit, NUL, nls.keys.json, NUL,
	nls.messages.json, in hex.
	"""
	digest = hashlib.sha256()
	digest.update(commit.encode())
	digest.update(b"\0")
	digest.update((nls_metadata_dir / "nls.keys.json").read_bytes())
	digest.update(b"\0")
	digest.update((nls_metadata_dir / "nls.messages.json").read_bytes())
	return digest.hexdigest()


def head_of(tree: Path) -> str:
	return subprocess.run(
		["git", "-C", str(tree), "rev-parse", "HEAD"],
		check=True,
		capture_output=True,
		text=True,
	).stdout.strip()


def devhub_version() -> str:
	"""Which DevHub this is, in the form a person reads.

	`apps/desktop/package.json` is where it is stated, once, and every consumer
	reads it from there: the bundle's `CFBundleShortVersionString`, and
	`hostVersion` below.

	It is deliberately *not* `product.json`'s `version`. That field is the
	version of the VS Code inside DevHub, and it is not decoration: it is what
	every `engines.vscode` range in every extension is validated against
	(`extensionManagementService.ts` and `extensionGalleryService.ts` both call
	`isEngineValid(..., productService.version, ...)`). Answering "1.136.1" there
	is the truth. `hostVersion` is the other question — which DevHub is this? —
	and the About dialog is the one place both need an answer at once, which is
	what patches/vscode/0002 exists for.
	"""
	return json.loads((DESKTOP_DIR / "package.json").read_text())["version"]


def product_metadata() -> dict[str, object]:
	"""DevHub's product identity plus the build it was made from.

	No `commit`: this is the set a source run gets, and there stating one would
	tell the workbench it is a packaged build. See the module docstring.
	"""
	return {
		**PRODUCT_OVERRIDES,
		"extensionEnabledApiProposals": EXTENSION_ENABLED_API_PROPOSALS,
		"hostVersion": devhub_version(),
		"hostCommit": devhub_commit(),
		# The remote extension host this build installs and connects to — see
		# the module docstring. On a source run too, which is the point.
		"serverCommit": vscode_commit(),
		"serverIdentity": reh_identity(),
		# About shows this beside the commit. Without it the line reads
		# "Date: Unknown" next to a hash that could be any age.
		"date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
	}


def packaged_metadata() -> dict[str, object]:
	"""The same, for a build that really is packaged.

	`commit` is the switch that sends the workbench to `node_modules.asar`, and
	the packaged app is the one layout where that archive exists.
	"""
	return {**product_metadata(), "commit": vscode_commit()}


def main() -> int:
	if len(sys.argv) != 2:
		print(f"usage: {Path(sys.argv[0]).name} <destination.json>", file=sys.stderr)
		return 2
	Path(sys.argv[1]).write_text(json.dumps(product_metadata(), indent="\t") + "\n")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
