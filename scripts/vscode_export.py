#!/usr/bin/env python3
"""Write the DevHub changes in vscode/ back into patches/vscode/ and the overlay.

    scripts/vscode-submodule.sh export

scripts/apply-vscode-patches.sh joins two halves onto the submodule: the
overlay, patches/vscode-overlay/, whose files upstream does not have, and
patches/vscode/*.patch, which change files upstream has. An edit is made in
vscode/, where it compiles and its tests run, and this puts it back where it
is kept, by the same rule:

* a change to a file upstream has goes into the one patch that already changes
  that file, which is rewritten from `git diff` for its files (a patch is
  exactly that: `git diff` of the files it names, in path order);
* a file upstream does not have goes into the overlay, at the same path.

Whatever that rule cannot decide on its own is refused, all of it at once,
with each path and what to do about it, and nothing is written:

* a change to an upstream file no patch changes: which patch it belongs in (or
  whether it needs a new one, and why) is a decision for a person;
* a change to a file two patches change: the diff cannot be split between them;
* a new file in a directory upstream has, unless that directory already holds
  overlay files: it may be DevHub's, or a scratch file, or build output that
  is not ignored; copy it into patches/vscode-overlay/ by hand and export
  again, and it is the overlay's from then on;
* an overlay file upstream now has too, or one that is missing from vscode/;
* a patch every one of whose changes was reverted (delete it by hand).

A patch whose diff is unchanged is not rewritten, so stale `index` lines and
hunk offsets in patches nobody touched do not churn.
"""

from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

DIFF_HEADER = re.compile(r"^diff --git a/(\S+) b/(\S+)$", re.M)
FILE_HEADER = re.compile(r"^(?:---|\+\+\+) [ab]/(\S+)$", re.M)


def git(tree: Path, *args: str) -> str:
	return subprocess.run(
		["git", "-C", str(tree), *args], check=True, capture_output=True, text=True
	).stdout


def lines(text: str) -> list[str]:
	return [line for line in text.split("\n") if line]


def patch_paths(text: str) -> list[str]:
	"""The files a patch changes, in the order it names them."""
	seen: list[str] = []
	for old, new in DIFF_HEADER.findall(text):
		for path in (old, new):
			if path not in seen:
				seen.append(path)
	for path in FILE_HEADER.findall(text):
		if path not in seen:
			seen.append(path)
	return seen


def comparable(text: str) -> list[str]:
	"""A patch without what `git diff` restates on every run: the `diff --git`
	and `index` lines, and the line numbers of the hunk headers."""
	out = []
	for line in text.split("\n"):
		if line.startswith(("index ", "diff --git ")):
			continue
		if line.startswith("@@"):
			line = re.sub(r"^@@ -\d+(,\d+)? \+\d+(,\d+)? @@", "@@", line)
		out.append(line)
	return out


@dataclass
class Plan:
	patches: dict[Path, str] = field(default_factory=dict)
	overlay: dict[str, Path] = field(default_factory=dict)
	problems: list[str] = field(default_factory=list)


def plan_export(repo_root: Path, build_written: list[str]) -> Plan:
	vscode = repo_root / "vscode"
	patches_dir = repo_root / "patches" / "vscode"
	overlay_dir = repo_root / "patches" / "vscode-overlay"
	plan = Plan()

	excludes = [f":(exclude){p}" for p in build_written]
	changed = lines(git(vscode, "diff", "--name-only", "HEAD", "--", ".", *excludes))
	untracked = lines(git(vscode, "ls-files", "--others", "--exclude-standard"))
	untracked_set = set(untracked)
	upstream = set(lines(git(vscode, "ls-tree", "-r", "--name-only", "HEAD")))
	upstream_dirs = {str(PurePosixPath(p).parent) for p in upstream}
	upstream_dirs |= {str(d) for p in upstream for d in PurePosixPath(p).parents}

	overlay = (
		sorted(p.relative_to(overlay_dir).as_posix() for p in overlay_dir.rglob("*") if p.is_file())
		if overlay_dir.is_dir()
		else []
	)
	overlay_set = set(overlay)
	overlay_dirs = {str(PurePosixPath(p).parent) for p in overlay}

	patches = sorted(patches_dir.glob("*.patch"))
	owners: dict[str, list[Path]] = {}
	for patch in patches:
		for path in patch_paths(patch.read_text()):
			owners.setdefault(path, []).append(patch)

	for path in changed:
		owned = owners.get(path, [])
		if not owned:
			plan.problems.append(
				f"{path}: changed, but no patch in patches/vscode/ changes it. Add its diff"
				f" (git -C vscode diff HEAD -- {path}) to the patch it belongs in, or to a new"
				" one that says why, and export again."
			)
		elif len(owned) > 1:
			names = ", ".join(p.name for p in owned)
			plan.problems.append(f"{path}: changed by more than one patch ({names}); split it by hand.")

	for path in overlay:
		if path in upstream:
			plan.problems.append(
				f"{path}: in patches/vscode-overlay/, but upstream has this file too. A change"
				" to it belongs in a patch; a file of DevHub's own needs a name upstream does not use."
			)
		elif path not in untracked_set:
			plan.problems.append(
				f"{path}: in patches/vscode-overlay/ but not in vscode/. Delete it from the overlay"
				" by hand if it should go, or re-apply (scripts/apply-vscode-patches.sh)."
			)
		if path in owners:
			plan.problems.append(f"{path}: in patches/vscode-overlay/ and named by a patch too.")

	for path in untracked:
		if path in owners:
			plan.problems.append(
				f"{path}: a new file a patch adds. New files belong in patches/vscode-overlay/:"
				" move its section out of the patch into the overlay, and export again."
			)
			continue
		if path in overlay_set:
			plan.overlay[path] = vscode / path
			continue
		parent = str(PurePosixPath(path).parent)
		if parent in overlay_dirs or parent not in upstream_dirs:
			plan.overlay[path] = vscode / path
		else:
			plan.problems.append(
				f"{path}: a new file in {parent}/, which upstream has. If it is DevHub's, copy it"
				f" to patches/vscode-overlay/{path} and export again; otherwise remove it."
			)

	if plan.problems:
		return plan

	for patch in patches:
		paths = patch_paths(patch.read_text())
		diff = git(vscode, "diff", "--abbrev=8", "HEAD", "--", *paths)
		if not diff:
			plan.problems.append(
				f"{patch.name}: none of its changes are in vscode/ any more. Delete it by hand"
				" if that is meant, or re-apply (scripts/apply-vscode-patches.sh)."
			)
			continue
		if comparable(diff) != comparable(patch.read_text()):
			plan.patches[patch] = diff
	return plan


def export(repo_root: Path, build_written: list[str]) -> int:
	plan = plan_export(repo_root, build_written)
	if plan.problems:
		print("vscode-submodule.sh export: nothing was written, because:", file=sys.stderr)
		for problem in plan.problems:
			print(f"  {problem}", file=sys.stderr)
		return 1
	overlay_dir = repo_root / "patches" / "vscode-overlay"
	wrote = 0
	for patch, diff in plan.patches.items():
		patch.write_text(diff)
		print(f"patches/vscode/{patch.name}")
		wrote += 1
	for path, source in sorted(plan.overlay.items()):
		target = overlay_dir / path
		data = source.read_bytes()
		if target.is_file() and target.read_bytes() == data:
			continue
		target.parent.mkdir(parents=True, exist_ok=True)
		target.write_bytes(data)
		print(f"patches/vscode-overlay/{path}")
		wrote += 1
	if not wrote:
		print("patches/vscode/ and patches/vscode-overlay/ already say what vscode/ does")
	return 0


def main(argv: list[str]) -> int:
	if len(argv) < 2:
		print("usage: vscode_export.py <repo-root> [build-written-path...]", file=sys.stderr)
		return 2
	return export(Path(argv[1]), argv[2:])


if __name__ == "__main__":
	raise SystemExit(main(sys.argv))
