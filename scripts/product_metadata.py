#!/usr/bin/env python3
"""What DevHub says about itself, and which build this is.

`apps/desktop/product.json` holds what DevHub is called, its bundle
identifier, where it keeps its tools on a host, and the version, URL and
sha256 of every binary the app build bundles (`fetch-binaries.mjs`). The app
reads it from `APP_ROOT/product.json` (`src/main/product.ts`): in a checkout that is this file as it is; the
packaged app gets it with two fields only a build can state, written by
`scripts/package-nightly.py` through `packaged_product()`:

    version   DevHub's version (`apps/desktop/package.json`)
    commit    the DevHub commit the bundle was built from

A source run states no commit, and `devhub --version` says so.

    scripts/product_metadata.py            print the packaged product.json
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DESKTOP_DIR = REPO_ROOT / "apps" / "desktop"

PRODUCT_FILE = DESKTOP_DIR / "product.json"
PRODUCT = json.loads(PRODUCT_FILE.read_text())


def head_of(tree: Path) -> str:
	return subprocess.run(
		["git", "-C", str(tree), "rev-parse", "HEAD"],
		check=True,
		capture_output=True,
		text=True,
	).stdout.strip()


def devhub_commit() -> str:
	"""The DevHub commit this build is being made from.

	A checkout with no commits at all is the only way this fails, and it fails
	loudly: a build that cannot say which source it came from is not one worth
	shipping.
	"""
	return head_of(REPO_ROOT)


def devhub_version() -> str:
	"""Which DevHub this is, as `apps/desktop/package.json` states it, once."""
	return json.loads((DESKTOP_DIR / "package.json").read_text())["version"]


def packaged_product() -> dict[str, object]:
	"""The packaged app's product.json: the static file, the version and the commit."""
	return {**PRODUCT, "version": devhub_version(), "commit": devhub_commit()}


def main() -> int:
	json.dump(packaged_product(), sys.stdout, indent="\t")
	sys.stdout.write("\n")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
