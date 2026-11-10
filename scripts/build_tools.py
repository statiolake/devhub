#!/usr/bin/env python3
"""Build one architecture's DevHub tools: the binaries no upstream distributes.

DevHub carries two kinds of binary (docs/bundled-binaries.md). Neovim, Node,
ripgrep and fd come from their own upstream releases, which publish exactly
what DevHub needs: static or self-contained builds for every architecture,
with checksums. tmux and bash have no such release. A static, musl-linked
tmux with its own terminfo database, and a static bash with every upstream
patch applied, are things DevHub has to build. So it builds them here,
`build_tmux.py` and `build_bash.py` once each, and publishes all of one
architecture's in one tarball on one release:

    tools-<toolsVersion>/
        devhub-tools-<toolsVersion>-darwin-arm64.tar.gz
        devhub-tools-<toolsVersion>-linux-x64.tar.gz
        devhub-tools-<toolsVersion>-linux-arm64.tar.gz
        SHA256SUMS

`toolsVersion` is the release's own version, independent of DevHub's and of
the tools': `apps/desktop/product.json` pins it, together with each asset's
sha256 and the tmux and bash versions the release holds. A new pin of either
tool, or a change to how either is built, is a new `toolsVersion`. A release
never moves: an app built against `tools-1` keeps finding `tools-1`.

The tarball holds each tool's own tarball unchanged, exactly as the tool's
build script writes it, plus `tools.json`, which names them:

    devhub-tools-<os>-<arch>/
        tools.json        {"toolsVersion", "platform", "tools": {tool: {version, file, sha256}}}
        devhub-tmux-<os>-<arch>-<version>.tar.gz
        devhub-bash-<os>-<arch>-<version>.tar.gz

The app build (`apps/desktop/scripts/fetch-binaries.mjs`) unpacks this
machine's tools into `out/tmux` and `out/bash`. It keeps the Linux tarballs
compressed in `out/host-tools`, and DevHub sends those to an SSH host as they
are.

There is no cross-build. Each architecture builds on a runner of its own
(`.github/workflows/tools.yml`), because each tool's build runs the binary it
made.

    scripts/build_tools.py [--out-dir dist]     this machine's tarball
    scripts/build_tools.py --print-version      the pinned toolsVersion
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tarfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_bash  # noqa: E402
import build_tmux  # noqa: E402
from build_tmux import REPO_ROOT, TARGETS, host_target  # noqa: E402
from product_metadata import PRODUCT  # noqa: E402

# The tools in the release and the version each one's build script pins.
# `product.json` states the same versions (`tmuxVersion`, `bashVersion`). The
# app build checks a release's `tools.json` against them, and
# `build_tools_test.py` checks the two statements agree.
TOOLS = {
	"tmux": build_tmux.TMUX.version,
	"bash": build_bash.VERSION,
}


def tools_version() -> str:
	return str(PRODUCT["toolsVersion"])


def release_tag(version: str) -> str:
	return f"tools-{version}"


def tarball_name(version: str, target: str) -> str:
	return f"devhub-tools-{version}-{target}.tar.gz"


def top_level_dir(target: str) -> str:
	return f"devhub-tools-{target}"


def sha256_of(path: Path) -> str:
	return hashlib.sha256(path.read_bytes()).hexdigest()


def pack(version: str, target: str, built: dict[str, Path], out_dir: Path) -> Path:
	"""One tarball: `tools.json` and each tool's tarball, under one directory."""
	top = top_level_dir(target)
	manifest = {
		"toolsVersion": version,
		"platform": target,
		"tools": {
			tool: {"version": TOOLS[tool], "file": path.name, "sha256": sha256_of(path)}
			for tool, path in built.items()
		},
	}
	out_dir.mkdir(parents=True, exist_ok=True)
	tarball = out_dir / tarball_name(version, target)
	manifest_path = out_dir / f"{top}.tools.json"
	manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
	with tarfile.open(tarball, "w:gz") as archive:
		archive.add(manifest_path, arcname=f"{top}/tools.json")
		for path in built.values():
			archive.add(path, arcname=f"{top}/{path.name}")
	manifest_path.unlink()
	check_layout(tarball, target)
	return tarball


def check_layout(tarball: Path, target: str) -> dict:
	"""Read the tarball back: one directory, `tools.json`, every tool it names.

	The app build checks the same things when it unpacks the tarball; this
	check means a broken tarball never gets published.
	"""
	top = top_level_dir(target)
	with tarfile.open(tarball) as archive:
		names = set(archive.getnames())
		roots = {name.split("/", 1)[0] for name in names}
		if roots != {top}:
			raise SystemExit(f"{tarball.name} must hold exactly {top}/, not {sorted(roots)}")
		member = archive.extractfile(f"{top}/tools.json")
		if member is None:
			raise SystemExit(f"{tarball.name} has no {top}/tools.json")
		manifest = json.load(member)
		if set(manifest["tools"]) != set(TOOLS):
			raise SystemExit(f"{tarball.name} holds {sorted(manifest['tools'])}, not {sorted(TOOLS)}")
		for tool, entry in manifest["tools"].items():
			inner = archive.extractfile(f"{top}/{entry['file']}")
			if inner is None:
				raise SystemExit(f"{tarball.name} names {entry['file']} and does not hold it")
			if hashlib.sha256(inner.read()).hexdigest() != entry["sha256"]:
				raise SystemExit(f"{tarball.name}: {entry['file']} is not the sha256 tools.json states")
			if entry["version"] != TOOLS[tool]:
				raise SystemExit(f"{tarball.name}: {tool} {entry['version']}, not {TOOLS[tool]}")
	return manifest


def build(target: str, out_dir: Path, work: Path) -> Path:
	built = {
		"tmux": build_tmux.build(target, work / "tmux", work / "tmux-build" / target),
		"bash": build_bash.build(target, work / "bash", work / "bash-build" / target),
	}
	tarball = pack(tools_version(), target, built, out_dir)
	print(f"{tarball.name}: {tarball.stat().st_size / 1e6:.1f} MB")
	return tarball


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
	parser.add_argument(
		"target",
		nargs="?",
		choices=TARGETS,
		help="the target to build: this machine's, which is the default",
	)
	parser.add_argument(
		"--print-version",
		action="store_true",
		help="print the toolsVersion product.json pins and exit (CI checks the tag against it)",
	)
	parser.add_argument("--out-dir", type=Path, default=REPO_ROOT / "dist")
	parser.add_argument(
		"--work-dir",
		type=Path,
		default=REPO_ROOT / "tools-build",
		help="where the sources are unpacked and built (gitignored; kept, so a "
		"second run reuses the downloads)",
	)
	args = parser.parse_args()
	if args.print_version:
		print(tools_version())
		return 0
	for tool, version in TOOLS.items():
		pinned = PRODUCT.get(f"{tool}Version")
		if pinned != version:
			raise SystemExit(
				f"product.json says {tool} {pinned}; scripts/build_{tool}.py builds {version}"
			)
	target = args.target or host_target()
	print(f"DevHub tools {tools_version()} for {target}, release {release_tag(tools_version())}")
	build(target, args.out_dir, args.work_dir)
	return 0


if __name__ == "__main__":
	sys.exit(main())
