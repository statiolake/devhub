#!/usr/bin/env python3
"""Tell DevHub's own changes in vscode/ from a developer's, by content.

    scripts/vscode-submodule.sh calls this; it is not meant to be run by hand.

    vscode_state.py --root R [--exclude PATH]... classify
    vscode_state.py --root R [--exclude PATH]... record KIND
    vscode_state.py --root R [--exclude PATH]... backup REASON

The submodule's working tree is expected to differ from its commit: DevHub's
overlay and patches are applied onto it. Whether the build may reset it comes
down to one question — would a reset lose anything that exists nowhere else?
— and this answers it from the tree's contents, not from a single fingerprint
of the last run:

* the tree is snapshotted as a git tree object (a throwaway index seeded from
  the real one, so only changed files are hashed: a fraction of a second on
  VS Code's 20k files). Ignored files (node_modules, out*, .build) are not part
  of it, and nothing here ever touches them;
* the snapshot is compared with what the *current* patches/vscode and overlay
  make of the checked-out commit (applied to another throwaway index, `git
  apply --cached`). Equal means `current`: there is nothing to do, and the
  build leaves the tree, and its files' mtimes, alone;
* otherwise every file that differs from the commit must hold content that a
  DevHub tree held at that path: one this script recorded after an apply step
  (any earlier version of the patches, a run interrupted halfway, a tree some
  files of which were later reverted by hand), what the current patches make,
  or what the patches of a recent superproject commit make (a tree applied by
  hand, or by scripts that kept no record). Then the tree is `devhub`: every
  byte a reset throws away can be made again from DevHub's own history;
* anything else is `unknown`, and the files that make it so are listed: they
  are edits nobody has exported yet.

`backup` keeps the tree about to be reset as a commit on
refs/devhub/vscode-before-reset (with a reflog), so even a reset that was
allowed can be looked at again: `git -C vscode log -g refs/devhub/vscode-before-reset`.
"""

from __future__ import annotations

import argparse
import contextlib
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

LOG_NAME = "devhub-applied-trees"
LOG_KEEP = 300
BACKUP_REF = "refs/devhub/vscode-before-reset"
# How many superproject commits that changed the patches are tried when the
# record cannot vouch for a file.
HISTORY_DEPTH = 30
PATCH_PATH = re.compile(rb"^(?:\+\+\+ b/|--- a/)(.+?)\s*$", re.M)


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

	def history_sources(self):
		"""(commit, patches, overlay) for recent superproject commits that changed
		either half, newest first, each distinct state once."""
		try:
			commits = self.out("log", f"-n{HISTORY_DEPTH}", "--format=%H", "HEAD", "--",
				"patches/vscode", "patches/vscode-overlay", cwd=self.root).split()
		except GitError:
			return
		seen = set()
		for commit in commits:
			raw = self.git("ls-tree", "-r", "-z", commit, "--", "patches/vscode/",
				"patches/vscode-overlay/", cwd=self.root, check=False)
			patches, overlay = [], []
			for entry in raw.split(b"\0"):
				if not entry:
					continue
				meta, path = entry.split(b"\t", 1)
				mode, kind, oid = meta.decode().split()
				p = path.decode()
				if kind != "blob" or mode == "120000":
					continue
				if p.startswith("patches/vscode/") and p.endswith(".patch") \
						and "/" not in p[len("patches/vscode/"):]:
					patches.append((p, oid))
				elif p.startswith("patches/vscode-overlay/"):
					overlay.append((p[len("patches/vscode-overlay/"):], oid, mode == "100755"))
			key = (tuple(patches), tuple(overlay))
			if key in seen:
				continue
			seen.add(key)
			yield commit, patches, overlay

	def blobs(self, oids: list[str]) -> dict[str, bytes]:
		"""Superproject blobs by id, read in one `cat-file --batch`."""
		if not oids:
			return {}
		raw = self.git("cat-file", "--batch", cwd=self.root,
			data="".join(o + "\n" for o in oids).encode())
		result, pos = {}, 0
		while pos < len(raw):
			nl = raw.index(b"\n", pos)
			header = raw[pos:nl].decode().split()
			pos = nl + 1
			if len(header) < 3 or header[1] == "missing":
				continue
			size = int(header[2])
			result[header[0]] = raw[pos:pos + size]
			pos += size + 1
		return result

	# --- the record ------------------------------------------------------

	def log_path(self) -> Path:
		return self.git_path(LOG_NAME)

	def recorded(self) -> list[str]:
		try:
			lines = self.log_path().read_text().splitlines()
		except FileNotFoundError:
			return []
		trees, seen = [], set()
		for line in reversed(lines):
			tree = line.split(" ", 1)[0]
			if re.fullmatch(r"[0-9a-f]{40,64}", tree) and tree not in seen:
				seen.add(tree)
				trees.append(tree)
		return trees

	def record(self, kind: str) -> str:
		tree = self.snapshot()
		path = self.log_path()
		try:
			lines = path.read_text().splitlines()
		except FileNotFoundError:
			lines = []
		lines.append(f"{tree} {kind} {int(time.time())}")
		path.write_text("\n".join(lines[-LOG_KEEP:]) + "\n")
		return tree

	def backup(self, reason: str) -> str:
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

	def entries(self, tree: str, paths: list[str]) -> dict[str, tuple[str, str]] | None:
		"""path -> (mode, oid) in `tree` for those of `paths` it has; None if the
		tree object is gone (pruned)."""
		if not self._ok("cat-file", "-e", tree):
			return None
		found = {}
		for i in range(0, len(paths), 500):
			raw = self.git("ls-tree", "-r", "-z", "--full-tree", tree, "--", *paths[i:i + 500],
				check=False)
			for entry in raw.split(b"\0"):
				if entry:
					meta, path = entry.split(b"\t", 1)
					mode, _kind, oid = meta.decode().split()
					found[path.decode()] = (mode, oid)
		return found

	def classify(self) -> tuple[str, list[str]]:
		head = self.head()
		head_tree = self.out("rev-parse", "HEAD^{tree}")
		work = self.snapshot()
		patches, overlay = self.current_sources()
		current = self.expected(head, patches, overlay)
		if work == current:
			return "current", []
		if work == head_tree:
			return "clean", []
		changed = self.changed(head_tree, work)
		unvouched = dict(changed)

		def vouch(tree: str | None) -> bool:
			if tree is None or not unvouched:
				return not unvouched
			if tree == work:
				unvouched.clear()
				return True
			have = self.entries(tree, sorted(unvouched))
			if have is None:
				return False
			for path, (status, mode, oid) in list(unvouched.items()):
				if status == "D":
					if path not in have:
						del unvouched[path]
				elif have.get(path) == (mode, oid):
					del unvouched[path]
			return not unvouched

		for tree in [current, *self.recorded()]:
			if vouch(tree):
				return "devhub", []

		# Not on record: try what the patches of recent commits make of it,
		# but only states that touch every path still in question.
		for commit, hpatches, hoverlay in self.history_sources():
			# An overlay file is stored as it is, so the same bytes are the
			# same blob id in either repository: no tree needs building.
			for path, oid, executable in hoverlay:
				if unvouched.get(path) == ("A", "100755" if executable else "100644", oid):
					del unvouched[path]
			if not unvouched:
				return "devhub", []
			contents = self.blobs([o for _p, o in hpatches])
			texts = [contents.get(o, b"") for _p, o in hpatches]
			names = set()
			for t in texts:
				names.update(m.decode(errors="replace") for m in PATCH_PATH.findall(t))
			if not set(unvouched) & names:
				continue
			ocontents = self.blobs([o for _p, o, _x in hoverlay])
			tree = self.expected(head, texts,
				[(p, ocontents.get(o, b""), x) for p, o, x in hoverlay])
			if vouch(tree):
				return "devhub", []

		return "unknown", [f"{unvouched[p][0]} {p}" for p in sorted(unvouched)]


def main(argv: list[str]) -> int:
	ap = argparse.ArgumentParser()
	ap.add_argument("--root", required=True, type=Path)
	ap.add_argument("--exclude", action="append", default=[])
	ap.add_argument("command", choices=["classify", "record", "backup", "snapshot"])
	ap.add_argument("arg", nargs="?", default="")
	a = ap.parse_args(argv)
	state = State(a.root.resolve(), a.exclude)
	try:
		if a.command == "classify":
			verdict, files = state.classify()
			print(verdict)
			for f in files:
				print(f)
		elif a.command == "record":
			state.record(a.arg or "apply")
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
