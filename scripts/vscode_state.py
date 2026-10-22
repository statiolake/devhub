#!/usr/bin/env python3
"""What state is vscode/ in: the one DevHub's build would make, or something else?

    scripts/vscode-submodule.sh calls this; it is not meant to be run by hand.

    vscode_state.py --root R [--exclude PATH]... classify
    vscode_state.py --root R [--exclude PATH]... backup REASON

vscode/ is not edited by hand: every build resets it to the pinned commit plus
patches/vscode plus patches/vscode-overlay. All that is left to ask of its
working tree is whether that reset would change anything:

* the tree is snapshotted as a git tree object (a throwaway index seeded from
  the real one, so only changed files are hashed: a fraction of a second on
  VS Code's 20k files). Ignored files (node_modules, out*, .build) are not part
  of it, and nothing here ever touches them;
* the snapshot is compared with what the *current* patches and overlay make of
  the checked-out commit (applied to another throwaway index, `git apply
  --cached`). Equal means `current`: there is nothing to do, and the build
  leaves the tree, and its files' mtimes, alone. Equal to the commit itself
  means `clean`. Anything else is `dirty`, followed by the changed files.

`backup` keeps the tree about to be reset as a commit on
refs/devhub/vscode-before-reset (with a reflog), so a reset can always be looked
at again: `git -C vscode log -g refs/devhub/vscode-before-reset`.
"""

from __future__ import annotations

import argparse
import contextlib
import os
import subprocess
import sys
import tempfile
from pathlib import Path

BACKUP_REF = "refs/devhub/vscode-before-reset"


class GitError(RuntimeError):
	pass


class State:
	def __init__(self, root: Path, excluded: list[str]):
		self.root = root
		self.vscode = root / "vscode"
		self.patches = root / "patches/vscode"
		self.overlay = root / "patches/vscode-overlay"
		self.excluded = [p for p in excluded if p]
		self._n = 0

	# --- git -------------------------------------------------------------

	def git(self, *args: str, cwd: Path | None = None, index: Path | None = None,
			data: bytes | None = None, check: bool = True) -> bytes:
		env = dict(os.environ)
		env.pop("GIT_DIR", None)
		env.pop("GIT_WORK_TREE", None)
		if index is not None:
			env["GIT_INDEX_FILE"] = str(index)
		r = subprocess.run(
			["git", "-c", "core.safecrlf=false", "-c", "advice.addEmbeddedRepo=false",
				"-c", "user.name=DevHub", "-c", "user.email=devhub@localhost", *args],
			cwd=cwd or self.vscode, env=env, input=data, capture_output=True,
		)
		if check and r.returncode != 0:
			raise GitError(f"git {' '.join(args)}: {r.stderr.decode(errors='replace').strip()}")
		return r.stdout if r.returncode == 0 else b""

	def out(self, *args: str, **kw) -> str:
		return self.git(*args, **kw).decode().strip()

	def git_path(self, name: str) -> Path:
		p = Path(self.out("rev-parse", "--git-path", name))
		return p if p.is_absolute() else self.vscode / p

	@contextlib.contextmanager
	def temp_index(self):
		self._n += 1
		path = self.git_path(f"devhub-index-{os.getpid()}-{self._n}")
		try:
			yield path
		finally:
			for p in (path, path.with_name(path.name + ".lock")):
				with contextlib.suppress(FileNotFoundError):
					p.unlink()

	# --- the trees -------------------------------------------------------

	def head(self) -> str:
		return self.out("rev-parse", "HEAD")

	def snapshot(self) -> str:
		"""The working tree as a tree object: tracked and untracked, ignored left out.

		The paths in --exclude are taken as they are at HEAD (VS Code's build
		rewrites them; a reset reverts them)."""
		with self.temp_index() as idx:
			real = self.git_path("index")
			seeded = False
			if real.exists():
				idx.write_bytes(real.read_bytes())
				# One tree with -m keeps the stat data of every entry that
				# matches it, so `add` below hashes only what changed.
				seeded = self._ok("read-tree", "-m", "HEAD", index=idx)
			if not seeded:
				with contextlib.suppress(FileNotFoundError):
					idx.unlink()
				self.git("read-tree", "HEAD", index=idx)
			spec = ["."] + [f":(exclude){p}" for p in self.excluded]
			self.git("add", "-A", "--", *spec, index=idx)
			return self.out("write-tree", index=idx)

	def _ok(self, *args: str, index: Path | None = None, data: bytes | None = None) -> bool:
		env = dict(os.environ)
		env.pop("GIT_DIR", None)
		env.pop("GIT_WORK_TREE", None)
		if index is not None:
			env["GIT_INDEX_FILE"] = str(index)
		return subprocess.run(["git", *args], cwd=self.vscode, env=env, input=data,
			capture_output=True).returncode == 0

	def expected(self, base: str, patches: list[bytes],
			overlay: list[tuple[str, bytes, bool]]) -> str | None:
		"""What scripts/apply-vscode-patches.sh makes of `base`: the overlay, then
		every patch. None when a patch does not apply to it."""
		with self.temp_index() as idx:
			self.git("read-tree", base, index=idx)
			if overlay:
				blobs = self.hash_blobs([(path, content) for path, content, _x in overlay])
				lines = [
					f"{'100755' if executable else '100644'} {blob}\t{path}\n"
					for (path, _c, executable), blob in zip(overlay, blobs)
				]
				self.git("update-index", "--add", "--index-info", index=idx,
					data="".join(lines).encode())
			if patches:
				# One `git apply` for all of them: no two patches touch the same
				# file, and any one failing means "not this state" either way.
				joined = b"".join(p if p.endswith(b"\n") else p + b"\n" for p in patches)
				if not self._ok("apply", "--cached", index=idx, data=joined):
					return None
			return self.out("write-tree", index=idx)

	def hash_blobs(self, files: list[tuple[str, bytes]]) -> list[str]:
		"""Blob ids for (path, content), as `git add` at that path would store them.

		Without a CR in it, a file goes through VS Code's attributes (text=auto,
		eol=…) unchanged, so those are hashed in one call; the rest one by one,
		with the attributes of their path."""
		ids: list[str | None] = [None] * len(files)
		plain = [i for i, (_p, c) in enumerate(files) if b"\r" not in c]
		if plain:
			with tempfile.TemporaryDirectory(dir=self.git_path(".")) as tmp:
				paths = []
				for i in plain:
					f = Path(tmp, str(i))
					f.write_bytes(files[i][1])
					paths.append(str(f))
				out = self.out("hash-object", "-w", "--no-filters", "--stdin-paths",
					data="".join(p + "\n" for p in paths).encode()).split()
				for i, oid in zip(plain, out):
					ids[i] = oid
		for i, (path, content) in enumerate(files):
			if ids[i] is None:
				ids[i] = self.out("hash-object", "-w", "--stdin", "--path", path, data=content)
		return [i for i in ids if i is not None]

	# --- the sources -----------------------------------------------------

	def current_sources(self) -> tuple[list[bytes], list[tuple[str, bytes, bool]]]:
		patches = [p.read_bytes() for p in sorted(self.patches.glob("*.patch")) if p.is_file()]
		overlay = []
		if self.overlay.is_dir():
			for dirpath, _dirs, files in os.walk(self.overlay):
				for name in files:
					full = Path(dirpath, name)
					if full.is_symlink() or not full.is_file():
						continue
					rel = full.relative_to(self.overlay).as_posix()
					overlay.append((rel, full.read_bytes(), os.access(full, os.X_OK)))
		overlay.sort(key=lambda e: e[0].encode())
		return patches, overlay

	def backup(self, reason: str) -> str:
		"""Keep the working tree as a commit on BACKUP_REF; "" when it is the commit itself."""
		tree = self.snapshot()
		if tree == self.out("rev-parse", "HEAD^{tree}"):
			return ""
		commit = self.out("commit-tree", tree, "-p", "HEAD", "-m", f"vscode/ before reset: {reason}")
		self.git("update-ref", "--create-reflog", "-m", reason, BACKUP_REF, commit)
		return commit

	# --- the verdict -----------------------------------------------------

	def changed(self, a: str, b: str) -> dict[str, tuple[str, str, str]]:
		"""path -> (status, mode, oid) for every path that differs, b's side."""
		raw = self.git("diff-tree", "-r", "-z", "--no-renames", a, b)
		parts = raw.split(b"\0")
		result = {}
		i = 0
		while i + 1 < len(parts):
			meta = parts[i].decode()
			path = parts[i + 1].decode()
			i += 2
			if not meta.startswith(":"):
				continue
			_om, nm, _oo, no, status = meta[1:].split()
			result[path] = (status, nm, no)
		return result

	def classify(self) -> tuple[str, list[str]]:
		head = self.head()
		work = self.snapshot()
		patches, overlay = self.current_sources()
		if work == self.expected(head, patches, overlay):
			return "current", []
		head_tree = self.out("rev-parse", "HEAD^{tree}")
		if work == head_tree:
			return "clean", []
		changed = self.changed(head_tree, work)
		return "dirty", [f"{status} {path}" for path, (status, _m, _o) in sorted(changed.items())]


def main(argv: list[str]) -> int:
	ap = argparse.ArgumentParser()
	ap.add_argument("--root", required=True, type=Path)
	ap.add_argument("--exclude", action="append", default=[])
	ap.add_argument("command", choices=["classify", "backup", "snapshot"])
	ap.add_argument("arg", nargs="?", default="")
	a = ap.parse_args(argv)
	state = State(a.root.resolve(), a.exclude)
	try:
		if a.command == "classify":
			verdict, files = state.classify()
			print(verdict)
			for f in files:
				print(f)
		elif a.command == "backup":
			print(state.backup(a.arg or "reset"))
		elif a.command == "snapshot":
			print(state.snapshot())
	except GitError as e:
		print(f"vscode_state.py: {e}", file=sys.stderr)
		return 1
	return 0


if __name__ == "__main__":
	sys.exit(main(sys.argv[1:]))
