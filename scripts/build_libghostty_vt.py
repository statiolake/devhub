#!/usr/bin/env python3
"""Build libghostty-vt for wasm32 from Ghostty's release tag, reproducibly.

The control-mode terminal's pane engine (`apps/desktop/vendor/libghostty-vt/`,
`docs/terminal-mode.md`) is this build: the `vt-1.0.0` tag at a pinned commit,
compiled by the Zig its `build.zig.zon` requires (from PyPI's `ziglang`), for
`wasm32-freestanding` with `ReleaseFast` (the build's default CPU for that
target enables `simd128`), debug info stripped.

What it does, so that nothing is taken on trust:

1. `git clone --depth 1 --branch vt-1.0.0` into a work directory, and refuses
   a checkout whose commit is not the pinned one.
2. Installs `ziglang==ZIG_PYPI` into the work directory and refuses a Zig
   whose `zig version` is not the one the checkout's `minimum_zig_version`
   names.
3. Downloads each package `deps/libghostty-vt.txt` lists, checks its sha256
   against `deps/packages.json`, and unpacks it into a directory named by its
   Zig package hash: the `--system` layout Ghostty documents for offline
   builds (PACKAGING-LIBGHOSTTY.md). Zig's own fetcher is not used, so a proxy
   it cannot speak through does not matter, and `--system` means the build
   cannot reach anything else.
4. Builds with a fresh, empty Zig cache and writes the module and
   `BUILD.json` (the tag, commit, Zig version, flags and the module's sha256)
   next to it.

Usage:
    scripts/build_libghostty_vt.py [--work-dir DIR] [--keep-work-dir]

The work directory (source, Zig, packages and caches, about 600 MB) is deleted
at the end unless `--keep-work-dir` is given.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "apps" / "desktop" / "vendor" / "libghostty-vt"

GHOSTTY_GIT = "https://github.com/ghostty-org/ghostty.git"
TAG = "vt-1.0.0"
# The commit the tag points at (`git ls-remote ... refs/tags/vt-1.0.0^{}`).
COMMIT = "0fa3d577a5614150ff8e2c152de5fb9d5c6d2dec"
# PyPI's `ziglang` for the Zig `minimum_zig_version` names. `0.17.0` itself
# was yanked on PyPI (a partial upload); `.post0` is the same Zig, repackaged.
ZIG_PYPI = "0.17.0.post0"
ZIG_VERSION = "0.17.0"
BUILD_FLAGS = [
	"-Demit-lib-vt",
	"-Dtarget=wasm32-freestanding",
	"-Doptimize=ReleaseFast",
	"-Dstrip=true",
]


def run(argv: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
	print("+", " ".join(argv), file=sys.stderr)
	done = subprocess.run(argv, cwd=cwd, env=env, check=True, capture_output=True, text=True)
	return done.stdout.strip()


def clone(work: Path) -> Path:
	source = work / "ghostty"
	run(["git", "clone", "--quiet", "--depth", "1", "--branch", TAG, GHOSTTY_GIT, str(source)])
	head = run(["git", "rev-parse", "HEAD"], cwd=source)
	if head != COMMIT:
		raise SystemExit(f"{TAG} is {head}, not the pinned {COMMIT}")
	return source


def install_zig(work: Path, source: Path) -> Path:
	target = work / "zig"
	run([sys.executable, "-m", "pip", "install", "--quiet", "--target", str(target), f"ziglang=={ZIG_PYPI}"])
	zig = target / "ziglang" / "zig"
	version = run([str(zig), "version"])
	wanted = minimum_zig_version(source)
	if version != ZIG_VERSION or wanted != ZIG_VERSION:
		raise SystemExit(f"zig is {version}; {TAG} wants {wanted}; this script pins {ZIG_VERSION}")
	return zig


def minimum_zig_version(source: Path) -> str:
	for line in (source / "build.zig.zon").read_text().splitlines():
		line = line.strip()
		if line.startswith(".minimum_zig_version"):
			return line.split('"')[1]
	raise SystemExit("build.zig.zon names no minimum_zig_version")


def fetch_packages(work: Path, source: Path, zig: Path) -> Path:
	"""Every package the library needs, checked and unpacked by its Zig hash.

	The check is Zig's own: `zig fetch <file>` hashes the package's contents
	the way a build does, and that hash must be the one the manifests name
	(`deps/packages.json`'s keys are those hashes).
	"""
	system = work / "packages"
	system.mkdir()
	downloads = work / "downloads"
	downloads.mkdir()
	index = json.loads((source / "deps" / "packages.json").read_text())
	by_url = {entry["url"]: zig_hash for zig_hash, entry in index.items()}
	urls = [u.strip() for u in (source / "deps" / "libghostty-vt.txt").read_text().splitlines() if u.strip()]
	env = {"PATH": "/usr/bin:/bin", "HOME": str(work), "ZIG_GLOBAL_CACHE_DIR": str(work / "zig-fetch-cache")}
	for url in urls:
		if url not in by_url:
			raise SystemExit(f"{url} is not in deps/packages.json")
		zig_hash = by_url[url]
		# Named, not Python's default agent, which the package host refuses.
		request = urllib.request.Request(url, headers={"User-Agent": "devhub-build-libghostty-vt"})
		with urllib.request.urlopen(request, timeout=120) as response:
			data = response.read()
		archive = downloads / url.rsplit("/", 1)[1]
		archive.write_bytes(data)
		got = run([str(zig), "fetch", str(archive)], env=env).splitlines()[-1]
		if got != zig_hash:
			raise SystemExit(f"{url}: Zig hashes it {got}, the manifest names {zig_hash}")
		unpack(data, system / zig_hash)
	return system


def unpack(data: bytes, into: Path) -> None:
	"""As Zig unpacks a package: the archive's one top-level directory is stripped."""
	with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
		members = archive.getmembers()
		tops = {m.name.split("/", 1)[0] for m in members if m.name not in ("", ".")}
		strip = len(tops) == 1 and any("/" in m.name for m in members)
		into.mkdir(parents=True)
		for member in members:
			name = member.name.split("/", 1)[1] if strip and "/" in member.name else ("" if strip else member.name)
			if name == "" or name.startswith("/") or ".." in Path(name).parts:
				continue
			member.name = name
			archive.extract(member, into, filter="data")


def build(work: Path, source: Path, zig: Path, system: Path) -> Path:
	prefix = work / "out"
	env = {
		"PATH": "/usr/bin:/bin",
		"HOME": str(work),
		"ZIG_GLOBAL_CACHE_DIR": str(work / "zig-global-cache"),
		"ZIG_LOCAL_CACHE_DIR": str(work / "zig-local-cache"),
	}
	run([str(zig), "build", *BUILD_FLAGS, "--system", str(system), "--prefix", str(prefix)], cwd=source, env=env)
	module = prefix / "bin" / "ghostty-vt.wasm"
	if not module.is_file():
		raise SystemExit(f"the build wrote no {module}")
	return module


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
	parser.add_argument("--work-dir", type=Path)
	parser.add_argument("--keep-work-dir", action="store_true")
	args = parser.parse_args()
	work = args.work_dir or Path(tempfile.mkdtemp(prefix="libghostty-vt-"))
	work.mkdir(parents=True, exist_ok=True)
	try:
		source = clone(work)
		zig = install_zig(work, source)
		system = fetch_packages(work, source, zig)
		module = build(work, source, zig, system)
		data = module.read_bytes()
		OUT_DIR.mkdir(parents=True, exist_ok=True)
		(OUT_DIR / "ghostty-vt.wasm").write_bytes(data)
		record = {
			"tag": TAG,
			"commit": COMMIT,
			"zig": ZIG_VERSION,
			"ziglang_pypi": ZIG_PYPI,
			"flags": BUILD_FLAGS,
			"bytes": len(data),
			"sha256": hashlib.sha256(data).hexdigest(),
		}
		(OUT_DIR / "BUILD.json").write_text(json.dumps(record, indent=2) + "\n")
		print(json.dumps(record, indent=2))
	finally:
		if not args.keep_work_dir:
			shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
	main()
