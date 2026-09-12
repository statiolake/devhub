#!/usr/bin/env python3
"""What DevHub changed in a vendored extension, and how to put it back.

`extensions/vendor/` holds third-party extensions unpacked from a published
VSIX and committed as they came — see `extensions/vendor/README.md`. "As they
came" stopped being the whole truth the day one of them turned out to send
`bash` to hosts that have none, so this module is the register of DevHub's own
changes to them: what each change is, why it is there, and how to reproduce it
on the next version.

The tree in git is the *patched* tree. It has to be: `stage-builtin-extensions.sh`
symlinks each vendored directory into the built-in set and `package-nightly.py`
copies it, and neither has anywhere to put a build-time transformation that the
other would also have to do — two callers doing the same edit is the shape that
ends with only one of them right. So the edits are applied once, at vendor
time, and this module's job is to say so out loud: `--check` (what the test
runs) fails the build if the tree in git is not the tree these edits describe.

Two kinds of edit, because there are two kinds of file:

    Patch    a unified diff, for a file a human wrote and a human reads.
             Regenerate with `git diff -- <path>` after editing the tree.
    Replace  an anchored literal substitution, for `lib/extension.js` — a
             600 KB bundle on a single line, where a line diff would be the
             whole file twice and tell a reviewer nothing.

The update procedure is in `extensions/vendor/README.md`, and it ends here:
unpack the new VSIX over the directory, run `--apply`, run `--check`.
"""

from __future__ import annotations

import argparse
import dataclasses
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VENDOR_DIR = REPO_ROOT / "extensions" / "vendor"
PATCHES_DIR = VENDOR_DIR / "patches"


class PatchError(Exception):
	"""A vendored tree is not the tree the edits below describe."""


@dataclasses.dataclass(frozen=True)
class Patch:
	"""A unified diff over one text file, applied with `git apply`."""

	name: str
	why: str

	def patch_file(self, extension: str) -> Path:
		return PATCHES_DIR / extension / self.name

	def _git_apply(self, extension: str, *flags: str) -> bool:
		return (
			subprocess.run(
				["git", "apply", *flags, str(self.patch_file(extension))],
				cwd=REPO_ROOT,
				stdout=subprocess.DEVNULL,
				stderr=subprocess.DEVNULL,
				check=False,
			).returncode
			== 0
		)

	def apply(self, extension: str) -> None:
		if self._git_apply(extension, "--reverse", "--check"):
			return  # already applied
		if not self._git_apply(extension):
			raise PatchError(f"{extension}: {self.name} does not apply")

	def check(self, extension: str) -> None:
		if not self._git_apply(extension, "--reverse", "--check"):
			raise PatchError(
				f"{extension}: {self.name} is not applied to the committed tree "
				f"(run scripts/patch_vendored_extensions.py --apply)"
			)


@dataclasses.dataclass(frozen=True)
class Replace:
	"""One literal substring swapped for another, exactly once."""

	path: str
	before: str
	after: str
	why: str

	def target(self, extension: str) -> Path:
		return VENDOR_DIR / extension / self.path

	def apply(self, extension: str) -> None:
		target = self.target(extension)
		text = target.read_text(encoding="utf8")
		if text.count(self.after) == 1 and self.before not in text:
			return  # already applied
		if text.count(self.before) != 1:
			raise PatchError(
				f"{extension}: {self.path} has {text.count(self.before)} occurrences "
				f"of {self.before!r}, expected exactly 1"
			)
		target.write_text(text.replace(self.before, self.after), encoding="utf8")

	def check(self, extension: str) -> None:
		text = self.target(extension).read_text(encoding="utf8")
		if text.count(self.after) != 1 or self.before in text:
			raise PatchError(
				f"{extension}: {self.path} does not carry the edit {self.why!r} "
				f"(run scripts/patch_vendored_extensions.py --apply)"
			)


# DevHub sends POSIX `sh` to every host it touches. The extension sent bash.
#
# `jeanp413.open-remote-ssh` pipes its server-install script into `bash -l` and
# writes the script in bash. A NAS whose /bin/sh is BusyBox — the machine this
# was found on — answered `sh: bash: not found`, so not one of the script's
# result markers was ever printed and the extension could only say "Failed
# parsing install script output". The script itself is the port
# (0001-posix-server-setup.patch); these are the two lines of the bundle that
# have to move with it, plus the reason a failed resolve now carries.
POSIX_SERVER_SETUP = Patch(
	name="0001-posix-server-setup.patch",
	why="server-setup.sh is POSIX sh, not bash",
)

SH_NOT_BASH = Replace(
	path="lib/extension.js",
	before="| base64 -d | bash -l`)",
	after="| base64 -d | sh -l`)",
	why="run the install script with sh, which every remote has",
)

# A failure has to say what failed where the person can see it. Upstream throws
# `Failed parsing install script output` and puts the remote's stderr in an
# output channel nobody has open; the modal then names the host and not the
# reason. These three carry the last line of stderr — `sh: bash: not found` —
# from the shell that produced it to the dialog the person is looking at.
STDERR_TAIL = Replace(
	path="lib/extension.js",
	before='h.trace("Server install command stdout:",w.stdout);const S=',
	after=(
		'h.trace("Server install command stdout:",w.stdout);'
		'const devhubStderrTail=(w.stderr||"").split(/\\r?\\n/).map(e=>e.trim()).filter(e=>e).pop(),'
		'devhubReason=devhubStderrTail?": "+devhubStderrTail:"";const S='
	),
	why="keep the last line of the remote's stderr beside the parse result",
)

PARSE_FAILURE_SAYS_WHY = Replace(
	path="lib/extension.js",
	before='throw new g("Failed parsing install script output")',
	after='throw new g("Failed parsing install script output"+devhubReason)',
	why="a parse failure names the shell error that caused it",
)

INSTALL_FAILURE_SAYS_WHY = Replace(
	path="lib/extension.js",
	before=(
		"throw new g(\"Couldn't install vscode server on remote server, "
		'install script returned non-zero exit status")'
	),
	after=(
		"throw new g(\"Couldn't install vscode server on remote server, "
		'install script returned non-zero exit status"+devhubReason)'
	),
	why="a non-zero install names the shell error that caused it",
)

RESOLVE_FAILURE_CARRIES_REASON = Replace(
	path="lib/extension.js",
	before='catch(e){if(this.logger.error("Error resolving authority",e),1===r.resolveAttempt){',
	after=(
		"catch(e){const devhubReason=e instanceof Error?e.message:String(e);"
		'if(this.logger.error("Error resolving authority",e),1===r.resolveAttempt){'
	),
	why="hold the resolve error before the dialog's own `e` shadows it",
)

MODAL_SHOWS_REASON = Replace(
	path="lib/extension.js",
	before='`Could not establish connection to "${s.hostname}"`,{modal:!0},e,t)',
	after='`Could not establish connection to "${s.hostname}"`,{modal:!0,detail:devhubReason},e,t)',
	why="the dialog says why, not only which host",
)

EDITS: dict[str, tuple[Patch | Replace, ...]] = {
	"open-remote-ssh": (
		POSIX_SERVER_SETUP,
		SH_NOT_BASH,
		STDERR_TAIL,
		PARSE_FAILURE_SAYS_WHY,
		INSTALL_FAILURE_SAYS_WHY,
		RESOLVE_FAILURE_CARRIES_REASON,
		MODAL_SHOWS_REASON,
	),
}


def apply_edits() -> None:
	"""Put every edit onto the vendored trees. Running it twice changes nothing."""
	for extension, edits in EDITS.items():
		for edit in edits:
			edit.apply(extension)


def check_edits() -> list[str]:
	"""Every edit that is not on the vendored tree, as a message each."""
	problems: list[str] = []
	for extension, edits in EDITS.items():
		for edit in edits:
			try:
				edit.check(extension)
			except PatchError as e:
				problems.append(str(e))
	return problems


def main(argv: list[str]) -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument(
		"--apply",
		action="store_true",
		help="put the edits onto extensions/vendor/ (use after unpacking a new VSIX)",
	)
	args = parser.parse_args(argv)

	if args.apply:
		apply_edits()

	problems = check_edits()
	for problem in problems:
		print(problem, file=sys.stderr)
	if problems:
		return 1
	print(f"vendored extension edits are applied ({sum(len(e) for e in EDITS.values())})")
	return 0


if __name__ == "__main__":
	raise SystemExit(main(sys.argv[1:]))
