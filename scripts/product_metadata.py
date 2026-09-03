#!/usr/bin/env python3
"""What DevHub says it is: `product.json`, and the build it was made from.

VS Code reads everything it knows about its own product out of `product.json` —
its name, its data folders, its gallery, and which build it is. DevHub states
the first three in `apps/desktop/product-overrides.json`, a static file, and the
rest here, because they are not static: they are whatever commits the trees are
on when the metadata is written, and whatever version `apps/desktop/package.json`
states at the same moment.

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

    scripts/product_metadata.py <destination.json>
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DESKTOP_DIR = REPO_ROOT / "apps" / "desktop"

PRODUCT_OVERRIDES_FILE = DESKTOP_DIR / "product-overrides.json"
PRODUCT_OVERRIDES = json.loads(PRODUCT_OVERRIDES_FILE.read_text())


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
	`isEngineValid(..., productService.version, ...)`). Answering "1.131.0" there
	is the truth. `hostVersion` is the other question — which DevHub is this? —
	and the About dialog is the one place both need an answer at once, which is
	what patches/vscode/0002 exists for.
	"""
	return json.loads((DESKTOP_DIR / "package.json").read_text())["version"]


def product_metadata() -> dict[str, str]:
	"""DevHub's product identity plus the build it was made from.

	No `commit`: this is the set a source run gets, and there stating one would
	tell the workbench it is a packaged build. See the module docstring.
	"""
	return {
		**PRODUCT_OVERRIDES,
		"hostVersion": devhub_version(),
		"hostCommit": devhub_commit(),
		# About shows this beside the commit. Without it the line reads
		# "Date: Unknown" next to a hash that could be any age.
		"date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
	}


def packaged_metadata() -> dict[str, str]:
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
