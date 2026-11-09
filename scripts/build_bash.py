#!/usr/bin/env python3
"""Build the bash DevHub runs Claude Code in: on every host, and inside the app.

Claude Code runs its Bash tool in a bash or a zsh (`CLAUDE_CODE_SHELL`, else
`$SHELL`, else whichever it finds on `PATH`), and DevHub runs only the binaries
it carries or delivers, never whatever happens to be installed
(docs/bundled-binaries.md). So DevHub publishes a bash the same way it
publishes tmux (`build_tmux.py`, whose helpers this script uses and whose
conventions it keeps), and installs it the same way, into the user's own home
directory, on a Claude Agent's first start on that host:

    ~/.devhub-server/bash/<version>/bin/bash

DevHub sets `CLAUDE_CODE_SHELL` to it for that Agent's process only. The login shell, tmux's `default-shell` and every terminal stay the
person's. The app carries the same bash as `out/bash` (`build:bash`,
`apps/desktop/scripts/fetch-bash.mjs`): on Linux the published tarball, on
macOS this script's `darwin-arm64` build, which links only libSystem. See
`apps/desktop/src/main/runtime/agentShell.ts` and docs/remote-ssh.md, "bash
for Claude Code".

## Separate from tmux, by version

One tarball per tool rather than one "host tools" bundle: each release is
keyed on its own tool's version and never moves (`tmux-3.7c`, `bash-5.3.20`),
so a bash patch level can be published without republishing a tmux every
DevHub already installs, and a tmux bump does not move a bash. The layout, the
static musl link, the build-on-its-own-architecture rule and the pins are the
same, and are `build_tmux.py`'s code rather than a copy of it.

## Static, musl, and nothing of the build machine's

`musl-gcc` for the reasons `build_tmux.py` gives — bash calls `getpwuid` at
startup too. `--enable-static-link` links the C library in; `--without-bash-
malloc` because bash's own allocator is the part of it that does not build
against musl, and musl's is what Alpine's bash runs on; `--disable-nls` so no
libintl is looked for. Readline is bash's bundled copy (the default) and the
termcap library is bash's bundled one (`bash_cv_termcap_lib=gnutermcap`): a
runner with `libncurses-dev` installed must not produce a bash linked against a
library this script never checksummed. Claude Code runs bash non-interactively,
so nothing here needs a terminfo database.

## Pinned: the release, and every upstream patch

bash is released as `bash-5.3.tar.gz` and then fixed by numbered patches on
ftp.gnu.org (`bash53-001` …), each of which bumps the patch level `bash
--version` reports. All of them are applied, each pinned by sha256, so the
version DevHub publishes is `5.3.<number of patches>` and says so on the host.

    scripts/build_bash.py linux-x64 [--out-dir dist]
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from build_tmux import (
	REPO_ROOT,
	TARGETS,
	Source,
	build_env,
	check_static,
	check_tool_layout,
	fetch,
	host_target,
	pack,
	run,
	unpack,
)

# bash 5.3 is the newest release. Its digest and every patch's below are the
# ones Homebrew's formula pins for the same files from the same GNU mirrors;
# they were written here from that formula, not from a download of our own
# (ftp.gnu.org was out of reach where this was written), so the first build
# that fetches them is the check — and a mismatch stops it, by `fetch`.
BASH = Source(
	name="bash",
	version="5.3",
	url="https://ftp.gnu.org/gnu/bash/bash-5.3.tar.gz",
	sha256="0d5cd86965f869a26cf64f4b71be7b96f90a3ba8b3d74e27e8e9d9d5550f31ba",
	license_file="COPYING",
)

SOURCES = (BASH,)


@dataclass(frozen=True)
class Patch:
	"""One official upstream patch, `bash53-<level>`, applied with `patch -p0`."""

	level: int
	sha256: str

	@property
	def archive(self) -> str:
		return f"bash{BASH.version.replace('.', '')}-{self.level:03d}"

	@property
	def url(self) -> str:
		return f"https://ftp.gnu.org/gnu/bash/bash-{BASH.version}-patches/{self.archive}"


# In order: each patch assumes the ones before it. Adding one is appending its
# digest here, which moves the published version (and so the release tag) by one.
PATCHES = tuple(
	Patch(level, digest)
	for level, digest in enumerate(
		(
			"1f608434364af86b9b45c8b0ea3fb3b165fb830d27697e6cdfc7ac17dee3287f",
			"e385548a00130765ec7938a56fbdca52447ab41fabc95a25f19ade527e282001",
			"f245d9c7dc3f5a20d84b53d249334747940936f09dc97e1dcb89fc3ab37d60ed",
			"9591d245045529f32f0812f94180b9d9ce9023f5a765c039b852e5dfc99747d0",
			"cca1ef52dbbf433bc98e33269b64b2c814028efe2538be1e2c9a377da90bc99d",
			"29119addefed8eff91ae37fd51822c31780ee30d4a28376e96002706c995ff10",
			"c0976bbfffa1453c7cfdd62058f206a318568ff2d690f5d4fa048793fa3eb299",
			"097cd723cbfb8907674ac32214063a3fd85282657ec5b4e544d2c0f719653fb4",
			"eee30fe78a4b0cb2fe20e010e00308899cfc613e0774ebb3c8557a1552f24f8c",
			"cf76f1cce2ea300c18bff9f002d21f280cc931acd17c28518110b93fe6e72569",
			"0298df8f5ea2a31d3be43ed7d269c5b3c7c342dd5b570bea7f64d66dcbbe7531",
			"d71379b39bebaedaf123414414e77fb458a0a43b9ad3116594c6df7ca6754573",
			"042f9cda967e24bf4211944697441e93d06ff42b4b998629a98a1b249279f200",
			"bd4360b401d38507e358783dcad8536a99c6789f0d3a5bd0cfb8c4a34144696c",
			"55b79ceee2fc27f6767eed697e939a7eb2fe2a28c01556bd75f18d581014f46e",
			"9ea29b266b7d24cb34d0ff3f1c4631e4d527bfe2d1ef15d17cdb924bf31ef767",
			"443b927b45c1558ca72052410f8b8f6e5152b617ed707061a2781d4375b0d1c3",
			"ae715d76c50341d7d7095e9a8d2eeed1ca9546152c2ac7289206f90cf30ac697",
			"a25c581e4d0057dea3833918438a930e2e86ee4c6dc17fe15267b7f04cbc4e3d",
			"df217ed3a9122aa2286d9b67bbe348661b6a9db262b580c29150dae55d532896",
		),
		start=1,
	)
)

# What DevHub publishes and installs: the release plus its patch level, which
# is what `bash --version` prints once every patch is applied.
VERSION = f"{BASH.version}.{len(PATCHES)}"


def tarball_name(os_name: str, arch: str, version: str) -> str:
	"""What the app's download URL resolves to for this target.

	The same statement as `bashDownloadUrlTemplate` in
	`apps/desktop/product.json`; `build_bash_test.py` checks that
	the two agree.
	"""
	return f"devhub-bash-{os_name}-{arch}-{version}.tar.gz"


def release_tag(version: str) -> str:
	"""The release that holds every architecture's tarball for this bash."""
	return f"bash-{version}"


def top_level_dir(os_name: str, arch: str) -> str:
	"""The single directory inside the tarball, which the install moves into place."""
	return f"devhub-bash-{os_name}-{arch}"


def bash_env(os_name: str, prefix: Path) -> dict[str, str]:
	"""`build_tmux.build_env`, and bash's own termcap rather than the machine's.

	`bash_cv_termcap_lib` is the answer configure would otherwise find by
	searching for `tgetent` in whatever is installed; stated, it is bash's
	bundled `lib/termcap` on every runner.
	"""
	env = build_env(os_name, prefix)
	env["bash_cv_termcap_lib"] = "gnutermcap"
	return env


def configure_command(prefix: Path, static: bool) -> list[str]:
	"""bash's configure, for a binary that needs nothing on the host."""
	command = [
		"./configure",
		f"--prefix={prefix}",
		"--without-bash-malloc",
		"--disable-nls",
	]
	if static:
		command.append("--enable-static-link")
	return command


def patch_command(patch: Path) -> list[str]:
	"""How one upstream patch is applied: from the tree's root, `-p0`, as GNU says."""
	return ["patch", "-p0", "--forward", "--batch", "-i", str(patch)]


def build_bash(tree: Path, prefix: Path, env: dict[str, str], static: bool) -> Path:
	"""Configure and make bash in `tree`, and return the binary."""
	run(configure_command(prefix, static), tree, env)
	run(["make", f"-j{os.cpu_count() or 2}"], tree, env)
	binary = tree / "bash"
	if not binary.is_file():
		raise SystemExit(f"bash's make produced no {binary}")
	return binary


def stage(binary: Path, license_file: Path, into: Path) -> None:
	"""`bin/bash` at 0755 and the licence beside it; nothing else is needed."""
	if into.exists():
		shutil.rmtree(into)
	(into / "bin").mkdir(parents=True)
	shutil.copy2(binary, into / "bin" / "bash")
	(into / "bin" / "bash").chmod(0o755)
	(into / "licenses").mkdir()
	shutil.copy2(license_file, into / "licenses" / "bash.txt")


def reports_version(first_line: str, version: str) -> bool:
	"""Whether `bash --version`'s first line is the patch level that was pinned.

	`GNU bash, version 5.3.20(1)-release (x86_64-pc-linux-musl)`.
	"""
	return f"version {version}(" in first_line


def verify(staged: Path, os_name: str, version: str) -> None:
	"""Static, runs, and is the version that was pinned — before it goes anywhere."""
	binary = staged / "bin" / "bash"
	check_static(binary, os_name)
	reported = subprocess.run(
		[str(binary), "--version"], capture_output=True, text=True, check=True
	).stdout.splitlines()
	first = reported[0] if reported else ""
	if not reports_version(first, version):
		raise SystemExit(f"expected bash {version} from --version, got {first!r}")
	print(f"  {first}")
	# The one thing Claude Code asks of it: run a command string.
	said = subprocess.run(
		[str(binary), "-c", 'printf "%s" "$BASH_VERSION"'],
		capture_output=True,
		text=True,
		check=True,
	).stdout
	if not said.startswith(version):
		raise SystemExit(f"bash -c reported BASH_VERSION {said!r}, not {version}")


def check_layout(tarball: Path) -> str:
	"""Read the finished tarball back: one directory, `bin/bash`, the licence."""
	return check_tool_layout(tarball, "bash", (source.name for source in SOURCES))


def build(target: str, out_dir: Path, work: Path) -> Path:
	"""Build one target end to end and return the tarball."""
	os_name, _, arch = target.partition("-")
	if target != host_target():
		raise SystemExit(
			f"cannot build {target} on {host_target()}: there is no cross-build here, "
			"and a bash for another architecture is not something this machine can "
			"run `--version` against. Build it on a runner of that architecture."
		)

	prefix = work / "prefix"
	trees = work / "src"
	staged = work / top_level_dir(os_name, arch)
	env = bash_env(os_name, prefix)

	# A fresh tree every time: patches applied twice do not apply.
	if trees.exists():
		shutil.rmtree(trees)
	tree = unpack(fetch(BASH, work / "downloads"), trees)
	for patch in PATCHES:
		run(patch_command(fetch(patch, work / "downloads")), tree, env)

	print(f"bash {VERSION}")
	binary = build_bash(tree, prefix, env, static=os_name == "linux")
	stage(binary, tree / BASH.license_file, staged)
	verify(staged, os_name, VERSION)

	tarball = out_dir / tarball_name(os_name, arch, VERSION)
	pack(staged, tarball, top_level_dir(os_name, arch))
	check_layout(tarball)
	print(f"{tarball.name}: {tarball.stat().st_size / 1e6:.1f} MB")
	return tarball


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
	# The same targets as tmux, published (`PUBLISHED_TARGETS`) or self-test,
	# for the same reasons.
	parser.add_argument("targets", nargs="*", choices=TARGETS)
	parser.add_argument(
		"--print-version",
		action="store_true",
		help="print the pinned bash version (with its patch level) and exit — how "
		"CI names the release without keeping a second copy of the number",
	)
	parser.add_argument("--out-dir", type=Path, default=REPO_ROOT / "dist")
	parser.add_argument(
		"--work-dir",
		type=Path,
		default=REPO_ROOT / "bash-build",
		help="where the sources are unpacked and built (gitignored; kept, so a "
		"second run reuses the downloads)",
	)
	args = parser.parse_args()

	if args.print_version:
		print(VERSION)
		return 0
	if not args.targets:
		parser.error("name at least one target, or pass --print-version")

	print(f"bash {VERSION}, release {release_tag(VERSION)}")
	for target in args.targets:
		build(target, args.out_dir, args.work_dir / target)
	return 0


if __name__ == "__main__":
	sys.exit(main())
