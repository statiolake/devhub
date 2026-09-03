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

The clone gets one thing the packaged bundle does not: a launcher, so that
macOS can open it. See `install_dev_launcher`.
"""

from __future__ import annotations

import hashlib
import plistlib
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

from product_metadata import PRODUCT_OVERRIDES, PRODUCT_OVERRIDES_FILE, devhub_version

REPO_ROOT = Path(__file__).resolve().parent.parent
VSCODE_DIR = REPO_ROOT / "vscode"
DESKTOP_DIR = REPO_ROOT / "apps" / "desktop"

APP_NAME = PRODUCT_OVERRIDES["nameShort"]
BUNDLE_IDENTIFIER = PRODUCT_OVERRIDES["darwinBundleIdentifier"]

# Rendered from assets/icon-master.svg by scripts/package-icon.sh and committed;
# that script says why it is committed rather than built here.
ICON_FILE = REPO_ROOT / "distribution" / f"{APP_NAME}.icns"

# The `Code - OSS` names come from VS Code's own Electron staging step
# (`npm run electron`), which renames the prebuilt Electron bundle after its
# product. Ours renames it once more.
BASE_PRODUCT_NAME = "Code - OSS"
BASE_APP = VSCODE_DIR / ".build" / "electron" / f"{BASE_PRODUCT_NAME}.app"

# What "About DevHub" says about who made it. The macOS About panel reads this
# key straight from the running bundle, and Electron's own bundle arrives with
# Microsoft's — so an unbranded DevHub credits Microsoft alone for a product
# they did not make, and drops the DevHub half entirely.
#
# Both halves stay. Naming Code - OSS is not politeness: the MIT licence
# requires the notice to travel with the copies (the full texts ride along in
# `Contents/Resources/licenses`, written by package-nightly.py), and a user
# reading this panel should be able to tell what DevHub is built out of.
COPYRIGHT = (
	"Copyright (C) 2026 DevHub contributors. "
	"Based on Code - OSS, Copyright (C) Microsoft Corporation. "
	"MIT licensed."
)


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

	The icon is part of the rename for the same reason the name is. A bundle that
	says DevHub in the menu bar and shows Electron's default icon in the Dock is
	branded in one place and not the other, and that is exactly the drift this
	function exists to prevent — it is how a source run came to sit in the Dock
	as a bare Electron tile while the packaged app had DevHub's icon. Both
	callers want the same icon, so neither is asked for it.

	The copyright is part of the rename for the same reason: "About DevHub" is
	branding, and a source run and a nightly must not answer it differently.

	So is the version. `CFBundleShortVersionString` is the number the macOS
	About panel puts under the name, and left alone it is Electron's — a source
	run called itself "Version 42.7.0" while the nightly beside it said "0.1.0",
	and neither agreed with the workbench's own About dialog. Both callers want
	the same answer, so neither is asked for it.

	`main_plist_extra` is for what only one caller knows — *which* build this
	is, as opposed to which version — so that everything both callers share
	stays stated once, here.
	"""
	contents = app / "Contents"

	if not ICON_FILE.exists():
		raise FileNotFoundError(f"missing {ICON_FILE}; produce it with: scripts/package-icon.sh")
	shutil.copyfile(ICON_FILE, contents / "Resources" / ICON_FILE.name)

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
			"CFBundleIconFile": ICON_FILE.name,
			"NSHumanReadableCopyright": COPYRIGHT,
			"CFBundleShortVersionString": devhub_version(),
			**(main_plist_extra or {}),
		},
	)


def sign(app: Path) -> None:
	"""Replace the signature the rename invalidated, under a stable identity.

	Apple Silicon will not launch a bundle whose contents no longer match its
	signature, and every rename above changed contents. Ad-hoc is the weakest
	signature macOS accepts, and the strongest one available without a
	certificate.

	An ad-hoc signature's *designated requirement* is the code directory hash,
	so it changes with every build. A macOS keychain ACL records the requirement
	of whoever stored an item, which makes each rebuild of DevHub a stranger to
	the item the previous one wrote: reading it needs the user's consent, and
	Electron asks through a synchronous Security.framework call on the main
	thread. Until that dialog is answered the main thread never returns, so
	Electron never pumps libuv again — every timer, every socket and the control
	socket with them go silent, and the app stands there answering nothing.

	Naming the requirement after the bundle identifier pins the identity to
	something every build shares, so one grant covers all of them. `--deep`
	cannot carry it: the nested helpers have identifiers of their own, and a
	requirement naming this one would contradict them. So the tree is signed
	first and the outer bundle re-signed with the requirement afterwards.
	"""
	subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(app)], check=True)
	subprocess.run(
		[
			"codesign",
			"--force",
			"--sign",
			"-",
			"-r",
			f'=designated => identifier "{BUNDLE_IDENTIFIER}"',
			str(app),
		],
		check=True,
	)
	subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)


# --- the source run's bundle -----------------------------------------------
#
# Everything below is only for the bundle a source run boots. The packaged app
# assembles its own bundle and imports the functions above.


# The clone's `CFBundleExecutable`, sitting beside the real Electron rather than
# replacing it: `dev.sh` still runs `Contents/MacOS/DevHub` directly, and would
# call itself forever if that name were the one taken over.
DEV_LAUNCHER_NAME = f"{APP_NAME} Launcher"

# `{root}` and `{dev_sh}` are this checkout, written in when the clone is made.
DEV_LAUNCHER_SOURCE = """#!/bin/sh
# Generated by scripts/darwin_bundle.py. Editing it is pointless: the clone is
# rebuilt from scratch whenever anything it was made from changes.
#
# Launch Services starts an application by running its bundle's executable with
# no arguments. This bundle's real executable is Electron, and Electron with no
# application to run exits immediately — so opening the clone from the Dock,
# from Finder or with `open -b` produced a process that was gone before anyone
# could see it, and a `devhub` that waited thirty seconds for a window that was
# never coming.
#
# A source run's application is the checkout this clone was branded from, and
# the script below is the one that knows how to run it. Everything about how
# DevHub starts — the Electron's arguments, the data directories, the staged
# built-ins, the environment — stays there and is not repeated here.
set -eu

# `open` hands its own environment to the application it starts, and one
# variable in it decides whether Electron is Electron at all. The `devhub` CLI
# is this same Electron run as Node, with ELECTRON_RUN_AS_NODE=1 to make it so;
# a bare `devhub` that finds DevHub missing starts it with `open`, and the
# variable travelled. DevHub then booted as a Node process, could not find
# `Menu` on the electron module, and died — which looked from the outside
# exactly like the bug this launcher exists to fix, an app that starts and is
# instantly gone. Whoever is asking, the application this bundle names is an
# Electron application.
unset ELECTRON_RUN_AS_NODE

LOG="$HOME/Library/Logs/DevHub/source-run.log"
mkdir -p "$(dirname "$LOG")"
# Opened from the Dock there is no terminal to print to, and a start-up that
# fails silently is a start-up nobody can diagnose. Everything from here on —
# this script's own failures, dev.sh's, and then Electron's — lands in the log.
exec >>"$LOG" 2>&1
echo "--- $(date '+%Y-%m-%dT%H:%M:%S') opening {root} ---"
exec {dev_sh} "$@"
"""


def install_dev_launcher(app: Path) -> None:
	"""Make the clone something macOS can open, not just something dev.sh can run.

	The clone has always been a bundle only in the sense the menu bar cares
	about: it carried DevHub's names, and a source run reached the Electron
	inside it by path. Nothing could *open* it. Launch Services runs a bundle's
	executable with no arguments, which for a bare Electron means exiting at
	once, so `open -b net.statiolake.devhub` on a development machine started nothing
	and reported success — and since the dev clone is the bundle Launch Services
	resolves that identifier to here, a bare `devhub` inherited the same silence
	and spent its thirty-second timeout on it.

	So `CFBundleExecutable` points at a launcher that hands over to the
	checkout's `dev.sh`. The launcher is added rather than substituted: the real
	Electron keeps its name, because `dev.sh` runs it by that name and a
	launcher standing in that spot would exec itself until the stack ran out.

	The checkout's path is written into the launcher. That is not a guess about
	the machine but a fact about this bundle: the clone is a build product of a
	checkout, it lives inside one, and it is rebuilt whenever that changes —
	which is why `REPO_ROOT` is one of the things the stamp is taken over.
	"""
	launcher = app / "Contents" / "MacOS" / DEV_LAUNCHER_NAME
	launcher.write_text(
		DEV_LAUNCHER_SOURCE.format(
			root=shlex.quote(str(REPO_ROOT)),
			dev_sh=shlex.quote(str(DESKTOP_DIR / "scripts" / "dev.sh")),
		)
	)
	launcher.chmod(0o755)
	patch_plist(app / "Contents" / "Info.plist", {"CFBundleExecutable": DEV_LAUNCHER_NAME})


def _stamp_state() -> str:
	"""What the branded clone was made from: the Electron, DevHub's version, the names, the icon, the checkout, and this file.

	All of them belong in the stamp. The Electron is restaged by a VS Code bump,
	DevHub's version is now written into the plist and so a bumped version with
	a kept clone is a bundle claiming the version before it, the names change
	whenever `product-overrides.json` does, the icon changes
	whenever `scripts/package-icon.sh` is re-run, the checkout's path is written
	into the launcher and so a clone carried to a new path is a clone pointing
	at a checkout that is no longer there, and this file holds how a bundle is
	renamed, launched and signed — a change to any one of them is exactly as
	much a reason to rebuild as a change to any other.

	Leaving this file out is how a fix to `sign()` came to land with no effect:
	the stamp still matched, so the clone from before the fix was kept, and it
	kept the signature the fix existed to replace. The bundle then went on
	asking the keychain for consent it had already been given under a name it no
	longer used.

	Hashing the file rather than tracking a scheme version means nobody has to
	remember to bump anything, at the cost of rebranding after edits that change
	nothing observable. That is the cheap side of the trade: the clone is an
	APFS copy-on-write and costs almost no disk or time, while a stamp that
	misses a real change costs an afternoon of not believing your own build.
	"""
	electron_version = (BASE_APP.parent / "version").read_text().strip()
	overrides = PRODUCT_OVERRIDES_FILE.read_bytes()
	icon = ICON_FILE.read_bytes()
	checkout = str(REPO_ROOT).encode()
	recipe = Path(__file__).read_bytes()
	return hashlib.sha256(
		electron_version.encode()
		+ devhub_version().encode()
		+ overrides
		+ icon
		+ checkout
		+ recipe
	).hexdigest()


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
	install_dev_launcher(app)
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
