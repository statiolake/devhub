#!/usr/bin/env python3
"""Make VS Code's Electron app bundle say DevHub.

macOS takes an application's name from the *running bundle's* `Info.plist`, not
from anything the process says about itself. `app.setName()` renames what
Electron and JavaScript produce; it cannot reach the menu bar's application
menu, the Dock tile, Mission Control or the window switcher. Those read
`CFBundleName`, and the bundle a source run boots is `vscode/.build/electron`,
which VS Code's own `npm run electron` names after VS Code's product. So an
unbranded source run calls itself "Code - OSS" everywhere macOS does the
naming.

The answer is the one the packaged app already uses: run inside a bundle of
DevHub's own. This module holds that rename so the two paths cannot drift —
`scripts/provision-vscode.sh` calls it to brand the bundle a source run boots,
and `scripts/package-nightly.py` imports it to brand the one it ships. Both
take every name from `apps/desktop/product-overrides.json`, which is the single
place DevHub says what it is called.

As a command it clones VS Code's Electron bundle, brands the clone and ad-hoc
signs it:

    scripts/darwin_bundle.py <destination-directory>

The clone is a copy-on-write clone on APFS, so it costs no disk beyond the
files the rename actually rewrites. macOS on Apple Silicon refuses to launch a
bundle whose signature no longer matches its contents, so the signature is
replaced after the rename rather than left stale.
"""

from __future__ import annotations

import hashlib
import json
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VSCODE_DIR = REPO_ROOT / "vscode"
DESKTOP_DIR = REPO_ROOT / "apps" / "desktop"

PRODUCT_OVERRIDES_FILE = DESKTOP_DIR / "product-overrides.json"
PRODUCT_OVERRIDES = json.loads(PRODUCT_OVERRIDES_FILE.read_text())

APP_NAME = PRODUCT_OVERRIDES["nameShort"]
BUNDLE_IDENTIFIER = PRODUCT_OVERRIDES["darwinBundleIdentifier"]

# The `Code - OSS` names come from VS Code's own Electron staging step
# (`npm run electron`), which renames the prebuilt Electron bundle after its
# product. Ours renames it once more.
BASE_PRODUCT_NAME = "Code - OSS"
BASE_APP = VSCODE_DIR / ".build" / "electron" / f"{BASE_PRODUCT_NAME}.app"


def patch_plist(path: Path, values: dict[str, str]) -> None:
	with path.open("rb") as handle:
		plist = plistlib.load(handle)
	plist.update(values)
	with path.open("wb") as handle:
		plistlib.dump(plist, handle, fmt=plistlib.FMT_XML)


def rebrand(app: Path, main_plist_extra: dict[str, str] | None = None) -> None:
	"""Make the Electron bundle DevHub's.

	Electron locates its helper processes at
	`Contents/Frameworks/<CFBundleName> Helper*.app`, so the helper bundles are
	renamed in the same pass as the plist. Renaming one without the other
	produces an app that dies at startup with "Unable to find helper app".

	`main_plist_extra` is for what only one caller knows — the packaged app's
	version and icon — so that the names themselves stay stated once, here.
	"""
	contents = app / "Contents"

	executable = contents / "MacOS" / BASE_PRODUCT_NAME
	executable.rename(contents / "MacOS" / APP_NAME)

	for helper in sorted((contents / "Frameworks").glob(f"{BASE_PRODUCT_NAME} Helper*.app")):
		suffix = helper.name[len(BASE_PRODUCT_NAME):-len(".app")]  # " Helper (GPU)"
		renamed = helper.with_name(f"{APP_NAME}{suffix}.app")
		helper.rename(renamed)
		binary = renamed / "Contents" / "MacOS"
		(binary / f"{BASE_PRODUCT_NAME}{suffix}").rename(binary / f"{APP_NAME}{suffix}")
		kind = suffix[len(" Helper"):].strip("() ").lower()  # "", "gpu", "renderer"…
		patch_plist(
			renamed / "Contents" / "Info.plist",
			{
				"CFBundleExecutable": f"{APP_NAME}{suffix}",
				"CFBundleName": f"{APP_NAME}{suffix}",
				"CFBundleDisplayName": f"{APP_NAME}{suffix}",
				"CFBundleIdentifier": f"{BUNDLE_IDENTIFIER}.helper" + (f".{kind}" if kind else ""),
			},
		)

	patch_plist(
		contents / "Info.plist",
		{
			"CFBundleExecutable": APP_NAME,
			"CFBundleName": APP_NAME,
			"CFBundleDisplayName": APP_NAME,
			"CFBundleIdentifier": BUNDLE_IDENTIFIER,
			**(main_plist_extra or {}),
		},
	)


def sign(app: Path) -> None:
	"""Replace the signature the rename invalidated.

	Apple Silicon will not launch a bundle whose contents no longer match its
	signature, and every rename above changed contents. Ad-hoc is the weakest
	signature macOS accepts, and the strongest one available without a
	certificate.
	"""
	subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(app)], check=True)
	subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)


# --- the source run's bundle -----------------------------------------------
#
# Everything below is only for the bundle a source run boots. The packaged app
# assembles its own bundle and imports the functions above.


def _stamp_state() -> str:
	"""What the branded clone was made from: the Electron and the names.

	Both belong in the stamp. The Electron is restaged by a VS Code bump, and
	the names change whenever `product-overrides.json` does; a stamp over
	either alone leaves the other's change silently ignored.
	"""
	electron_version = (BASE_APP.parent / "version").read_text().strip()
	overrides = PRODUCT_OVERRIDES_FILE.read_bytes()
	return hashlib.sha256(electron_version.encode() + overrides).hexdigest()


def clone_and_rebrand(destination: Path) -> Path:
	"""Produce `<destination>/<name>.app` from VS Code's Electron bundle.

	Idempotent: a clone already made from this Electron and these names is left
	alone. Anything else is rebuilt from scratch, because a half-renamed bundle
	is not repairable by renaming it again.
	"""
	app = destination / f"{APP_NAME}.app"
	stamp = destination / ".brand.stamp"
	state = _stamp_state()
	if app.is_dir() and stamp.is_file() and stamp.read_text() == state:
		print(f"{app.name} already branded from this Electron and these names")
		return app

	if destination.exists():
		shutil.rmtree(destination)
	destination.mkdir(parents=True)

	# `-c` clones on APFS: the copy shares the originals' blocks until written
	# to, so 295 MB of Electron costs the few files the rename rewrites. `-R`
	# alone is the fallback for a volume without clone support.
	try:
		subprocess.run(["cp", "-Rc", str(BASE_APP), str(app)], check=True)
	except subprocess.CalledProcessError:
		subprocess.run(["cp", "-R", str(BASE_APP), str(app)], check=True)

	rebrand(app)
	sign(app)
	stamp.write_text(state)
	print(f"branded {app.name} from {BASE_APP.name}")
	return app


def main(argv: list[str]) -> int:
	if sys.platform != "darwin":
		print("error: an app bundle is a macOS thing", file=sys.stderr)
		return 1
	if len(argv) != 1:
		print(f"usage: {Path(__file__).name} <destination-directory>", file=sys.stderr)
		return 2
	if not BASE_APP.is_dir():
		print(
			f"error: no Electron at {BASE_APP.relative_to(REPO_ROOT)}"
			" — run scripts/provision-vscode.sh",
			file=sys.stderr,
		)
		return 1
	clone_and_rebrand(Path(argv[0]))
	return 0


if __name__ == "__main__":
	raise SystemExit(main(sys.argv[1:]))
