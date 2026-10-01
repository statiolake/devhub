#!/usr/bin/env python3
"""Input keys and skip decisions for the packaging steps that run on every build.

Three steps of package-nightly.py cost tens of seconds each and produce the same
bytes when nothing they read has changed: the zip (made cheaper, not skipped),
`compile-extensions-build`, and `node_modules.asar`. This module holds the pure
part — how a key is computed, when a stamp or cache entry counts as a hit — so
tests can pin it without a VS Code checkout.

The rule throughout is conservative: anything unreadable, missing or different
is a miss, and a miss only costs the rebuild that always used to happen.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Iterable

# Bump when the *meaning* of a key changes without its inputs changing.
KEY_VERSION = "1"

# Directory names whose contents are build products or installs, not inputs.
EXCLUDED_DIRS = ("node_modules", "out")


def new_hash() -> "hashlib._Hash":
	h = hashlib.sha256()
	h.update(f"key-version:{KEY_VERSION}\0".encode())
	return h


def add(h, label: str, value: str) -> None:
	h.update(f"{label}={value}\0".encode())


def hash_file(path: Path) -> str:
	h = hashlib.sha256()
	with open(path, "rb") as f:
		for chunk in iter(lambda: f.read(1 << 20), b""):
			h.update(chunk)
	return h.hexdigest()


def tree_listing(root: Path, exclude_dirs: Iterable[str] = EXCLUDED_DIRS) -> list[str]:
	"""`path size mtime_ns` for every file under root, sorted, symlinks not followed."""
	excluded = set(exclude_dirs)
	lines: list[str] = []
	for dirpath, dirnames, filenames in os.walk(root):
		dirnames[:] = sorted(d for d in dirnames if d not in excluded)
		for name in sorted(filenames):
			p = Path(dirpath) / name
			rel = p.relative_to(root).as_posix()
			try:
				st = p.lstat()
			except OSError:
				lines.append(f"{rel} unreadable")
				continue
			lines.append(f"{rel} {st.st_size} {st.st_mtime_ns}")
	return lines


def builtin_extensions_entries(product_json: Path) -> str:
	"""The builtInExtensions entries of product.json, canonically serialised."""
	data = json.loads(product_json.read_text())
	return json.dumps(data.get("builtInExtensions", []), sort_keys=True)


def extensions_key(
	*,
	vscode_commit: str,
	patches_dir: Path,
	extensions_dir: Path,
	build_dir: Path | None,
	product_json: Path,
	node_version: str,
) -> str:
	"""Everything `gulp compile-extensions-build` reads that DevHub can change."""
	h = new_hash()
	add(h, "vscode-commit", vscode_commit)
	add(h, "node", node_version)
	for patch in sorted(patches_dir.glob("*.patch")):
		add(h, f"patch:{patch.name}", hash_file(patch))
	add(h, "builtin", builtin_extensions_entries(product_json))
	for line in tree_listing(extensions_dir):
		add(h, "ext", line)
	if build_dir is not None and build_dir.is_dir():
		# The gulp tasks themselves; patches can change them and so can a bump.
		for line in tree_listing(build_dir):
			add(h, "build", line)
	return h.hexdigest()


def stamp_decision(stamp: Path, output: Path, key: str) -> tuple[bool, str]:
	"""(reuse, reason). Reuse only if the output exists and the stamp equals key."""
	if not output.is_dir():
		return False, f"{output.name} is missing"
	try:
		recorded = stamp.read_text().strip()
	except OSError:
		return False, "no stamp from an earlier build"
	if recorded != key:
		return False, "inputs changed since the last build"
	return True, "inputs unchanged"


def write_stamp(stamp: Path, key: str) -> None:
	stamp.write_text(key + "\n")


def package_identity(module: Path, root: Path) -> list[str]:
	"""A package's path plus the identity of its files (not its nested installs)."""
	lines = [f"path {module.relative_to(root).as_posix()}"]
	pj = module / "package.json"
	if pj.is_file():
		lines.append(f"package.json {hash_file(pj)}")
	lines.extend(tree_listing(module, exclude_dirs=("node_modules",)))
	return lines


def asar_key(
	*,
	modules: Iterable[Path],
	root: Path,
	packer: Path,
	asar_library: Path | None,
	node_version: str,
	extra_rules: str,
) -> str:
	"""Everything that decides what node_modules.asar and its sidecar contain."""
	h = new_hash()
	add(h, "node", node_version)
	add(h, "packer", hash_file(packer))
	add(h, "asar-lib", hash_file(asar_library) if asar_library and asar_library.is_file() else "none")
	add(h, "rules", extra_rules)
	for module in sorted(modules):
		for line in package_identity(module, root):
			add(h, "mod", line)
	return h.hexdigest()


ASAR_PARTS = ("node_modules.asar", "node_modules.asar.unpacked", "node_modules")


def asar_cache_hit(cache_root: Path, key: str) -> Path | None:
	entry = cache_root / key
	if (entry / ".complete").is_file() and (entry / "node_modules.asar").is_file():
		return entry
	return None


def _remove(path: Path) -> None:
	if path.is_dir() and not path.is_symlink():
		shutil.rmtree(path, ignore_errors=True)
	elif path.exists() or path.is_symlink():
		path.unlink()


def asar_cache_restore(entry: Path, code_oss: Path) -> None:
	for name in ASAR_PARTS:
		src = entry / name
		dst = code_oss / name
		_remove(dst)
		if src.is_dir():
			shutil.copytree(src, dst, symlinks=True)
		elif src.is_file():
			shutil.copy2(src, dst)


def asar_cache_store(cache_root: Path, key: str, code_oss: Path) -> None:
	"""Keep this build's packed result under key, and nothing from older keys."""
	cache_root.mkdir(parents=True, exist_ok=True)
	for old in cache_root.iterdir():
		_remove(old)
	staging = cache_root / f".{key}.tmp"
	staging.mkdir()
	for name in ASAR_PARTS:
		src = code_oss / name
		if src.is_dir():
			shutil.copytree(src, staging / name, symlinks=True)
		elif src.is_file():
			shutil.copy2(src, staging / name)
	(staging / ".complete").write_text("")
	staging.rename(cache_root / key)


def zip_command(app: Path, archive: Path, level: str) -> tuple[list[str], Path]:
	"""(argv, cwd) for zipping an .app. Level 'ditto' keeps ditto's own default.

	Info-ZIP `zip -y` stores symlinks as symlinks and keeps Unix modes, which is
	what an .app's frameworks need; Finder, `ditto -x -k` and `unzip` read it.
	Level 0..9 is the deflate level (0 stores); 1 is ~2.5x faster than the
	default for ~10% more bytes.
	"""
	if level == "ditto":
		return ["ditto", "-c", "-k", "--keepParent", str(app), str(archive)], app.parent
	if level not in {str(i) for i in range(10)}:
		raise ValueError(f"zip level must be 0-9 or 'ditto', not {level!r}")
	return ["zip", "-r", "-y", "-q", f"-{level}", str(archive), app.name], app.parent
