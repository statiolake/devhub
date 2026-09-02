#!/usr/bin/env python3
"""What DevHub says it is: `product.json`, and the build it was made from.

VS Code reads everything it knows about its own product out of `product.json` —
its name, its data folders, its gallery, and which build it is. DevHub states
the first three in `apps/desktop/product-overrides.json`, a static file, and the
fourth here, because it is not static: it is whatever commit the repository is
on when the metadata is written, and whatever version `apps/desktop/package.json`
states at the same moment.

Three callers, one rule between them:

    scripts/package-nightly.py    merges this over vscode/product.json to write
                                  the packaged app's product.json
    apps/desktop/scripts/dev.sh   runs this module as a command to write
                                  vscode/product.overrides.json, which
                                  bootstrap-meta.ts merges at runtime when
                                  VSCODE_DEV is set
    scripts/darwin_bundle.py      takes the names out of it to brand the macOS
                                  bundle

`commit` is DevHub's own commit, not the pinned VS Code submodule's. It answers
"which DevHub is this?", and DevHub's tree is what determines the answer: the
submodule pointer is a tracked file in it, so a submodule bump is a DevHub
commit too, and one hash identifies both halves where the submodule's would
identify neither DevHub's own code nor its patches. It is also the hash that has
to match across a connection later: when DevHub ships a remote extension host,
client and server are built from this repository, and VS Code's server
validation compares `product.commit` on both ends. The submodule's hash could
not tell two DevHub builds of the same VS Code apart.

Kept to lowercase hex for that reason — no `-dirty` suffix, no tag. VS Code
treats this value as a hex commit id (it slices it for cache keys and folder
names), so a dev run reports the commit it is on and says nothing about
uncommitted changes. That is what `version` and the date are for.

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
	shipping, and every consumer of `commit` downstream would otherwise get a
	plausible-looking wrong answer.
	"""
	return subprocess.run(
		["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
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
	"""DevHub's product identity plus the build it was made from."""
	return {
		**PRODUCT_OVERRIDES,
		"hostVersion": devhub_version(),
		"commit": devhub_commit(),
		# About shows this beside the commit. Without it the line reads
		# "Date: Unknown" next to a hash that could be any age.
		"date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
	}


def main() -> int:
	if len(sys.argv) != 2:
		print(f"usage: {Path(sys.argv[0]).name} <destination.json>", file=sys.stderr)
		return 2
	Path(sys.argv[1]).write_text(json.dumps(product_metadata(), indent="\t") + "\n")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
